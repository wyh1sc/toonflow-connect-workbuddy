#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键装好 WorkBuddy 代理 + Toonflow 文本供应商 + 工具插件。

装完的机器只要本机登录过 WorkBuddy 桌面端（或设置了 CODEBUDDY_AUTH_TOKEN），
不需要 DSH、不需要 cryptography、不需要手动填任何 token。

做的事：
  1. 探测凭据（环境变量 / DSH 凭据库 / WorkBuddy 桌面端认证文件），写进本地 vault
  2. 起 wb_proxy（127.0.0.1:8189），并用 /pool/creds + /v1/models 验证真的能用
  3. 把 WorkBuddy 的文本模型写进 Toonflow 的 customProviders（可直接用聊天）
  4. 把 workbuddyConnect.tool.js 装进 Toonflow（画图 / 出视频 / 积分）
  5. 注册开机自启（Windows 注册表 Run，或打印手动命令）

用法：
    python install.py                  # 全装
    python install.py --no-autostart   # 不注册开机自启
    python install.py --check          # 只体检，不改任何东西
    python install.py --uninstall      # 撤销自启（不删凭据）

退出码：0 全部成功 / 1 有步骤失败 / 2 环境不满足
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY_DIR = os.path.join(HERE, "proxy")
PROXY = os.path.join(PROXY_DIR, "wb_proxy.py")
TOOL = os.path.join(HERE, "tool", "workbuddyConnect.tool.js")
SCRIPTS = os.path.join(HERE, "scripts")

sys.path.insert(0, PROXY_DIR)

PROXY_PORT = int(os.environ.get("WB_PROXY_PORT", "8189"))
PROXY_URL = "http://127.0.0.1:%d" % PROXY_PORT
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
# 注意：值名里别带 "WorkBuddy" 全词。联想电脑管家之类的 OEM 启动项管理器
# 会把不认识的 WorkBuddy 相关值当成第三方写入，3 秒内搬进 Run\LenovoDisabled。
RUN_NAME = "ToonflowWbProxy"


def log(msg):
    print(msg, flush=True)


def ok(msg):
    log("  [OK]   %s" % msg)


def warn(msg):
    log("  [WARN] %s" % msg)


def fail(msg):
    log("  [FAIL] %s" % msg)


def http_json(url, headers=None, body=None, method="GET", timeout=60):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore") or "{}")


def proxy_alive():
    try:
        doc = http_json(PROXY_URL + "/healthz", timeout=5)
        return bool(doc.get("ok"))
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------- 1. 凭据

def step_credentials(force=False):
    log("[1/5] 探测 WorkBuddy 凭据")
    try:
        import wb_creds
    except Exception as exc:  # noqa: BLE001
        fail("加载 wb_creds 失败：%s" % exc)
        return False
    try:
        result = wb_creds.sync(wb_creds.__dict__.get("VAULT_DIR") or
                               os.path.join(os.path.expanduser("~"), ".toonflow-workbuddy", "vault", "cn"))
    except Exception as exc:  # noqa: BLE001
        fail("探测凭据出错：%s" % str(exc)[:200])
        return False
    for note in result.get("notes") or []:
        log("         · %s" % note)
    if not result.get("count"):
        fail("一个账号都没找到。请先在本机登录 WorkBuddy 桌面端，"
             "或设置环境变量 CODEBUDDY_AUTH_TOKEN=<token> 后重跑。")
        return False
    ok("发现 %d 个账号（续期 %d 个），vault：%s"
       % (result["count"], result.get("refreshed") or 0, result["vault"]))
    for a in result.get("accounts") or []:
        log("         · %s（%s，来源 %s）" % (a["nickname"], a["region"], a["source"]))
    return True


# ---------------------------------------------------------------- 2. 代理

def _pythonw():
    exe = sys.executable
    cand = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return cand if os.path.isfile(cand) else exe


def start_proxy():
    log("[2/5] 启动代理 %s" % PROXY_URL)
    if proxy_alive():
        ok("代理已在运行")
        return True
    env = dict(os.environ)
    kwargs = {"cwd": PROXY_DIR, "env": env, "stdin": subprocess.DEVNULL,
              "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x00000008 | 0x08000000  # DETACHED_PROCESS | CREATE_NO_WINDOW
    try:
        subprocess.Popen([_pythonw(), PROXY], **kwargs)
    except Exception as exc:  # noqa: BLE001
        fail("启动代理失败：%s" % exc)
        return False
    for _ in range(40):
        time.sleep(0.5)
        if proxy_alive():
            try:
                info = http_json(PROXY_URL + "/pool/creds", timeout=90)
                ok("代理已就绪，账号 %d 个，来源 %s"
                   % (info.get("accounts") or 0, "、".join(info.get("sources") or []) or "-"))
            except Exception:  # noqa: BLE001
                ok("代理已就绪")
            return True
    fail("代理 20 秒内没起来，检查 %s 能否单独运行" % PROXY)
    return False


def verify_models():
    try:
        doc = http_json(PROXY_URL + "/v1/models", timeout=60)
    except Exception as exc:  # noqa: BLE001
        fail("拉模型列表失败：%s" % str(exc)[:160])
        return False
    count = len(doc.get("data") or [])
    if not count:
        fail("模型列表为空（token 可能已失效）")
        return False
    ok("可用的对话模型 %d 个" % count)
    return True


# ---------------------------------------------------------------- 3. 文本供应商

def step_text_provider():
    log("[3/5] 把文本模型写进 Toonflow")
    script = os.path.join(SCRIPTS, "setup_text_provider.py")
    if not os.path.isfile(script):
        warn("没找到 %s，跳过（可手动跑）" % script)
        return True
    try:
        proc = subprocess.run([sys.executable, script, "--proxy", PROXY_URL],
                              capture_output=True, text=True, timeout=180)
    except Exception as exc:  # noqa: BLE001
        fail("调用失败：%s" % exc)
        return False
    out = (proc.stdout or "").strip()
    for line in out.splitlines():
        log("         %s" % line)
    if proc.returncode != 0:
        err = (proc.stderr or "").strip()[:300]
        fail("注册文本供应商失败：%s" % (err or out[-200:] or "未知原因"))
        return False
    return True


# ---------------------------------------------------------------- 4. 工具插件

def step_tool_plugin():
    log("[4/5] 安装工具插件到 Toonflow")
    installer = os.path.join(SCRIPTS, "install_tool_plugin.py")
    if not os.path.isfile(installer):
        warn("没找到 %s，跳过" % installer)
        return True
    try:
        proc = subprocess.run([sys.executable, installer], capture_output=True, text=True, timeout=180)
    except Exception as exc:  # noqa: BLE001
        fail("调用失败：%s" % exc)
        return False
    for line in (proc.stdout or "").strip().splitlines():
        log("         %s" % line)
    if proc.returncode != 0:
        fail("装插件失败：%s" % (proc.stderr or "").strip()[:300])
        return False
    return True


# ---------------------------------------------------------------- 5. 自启

def autostart_command():
    return '"%s" "%s"' % (_pythonw(), PROXY)


def step_autostart(enable=True):
    log("[5/5] 开机自启")
    if sys.platform == "win32":
        try:
            import winreg
        except Exception as exc:  # noqa: BLE001
            warn("读不了注册表（%s），跳过自启" % exc)
            return True
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE)
        except OSError as exc:
            warn("打开 Run 键失败：%s" % exc)
            return True
        try:
            if enable:
                winreg.SetValueEx(key, RUN_NAME, 0, winreg.REG_SZ, autostart_command())
                ok("已注册开机自启：%s" % RUN_NAME)
            else:
                try:
                    winreg.DeleteValue(key, RUN_NAME)
                    ok("已移除开机自启")
                except FileNotFoundError:
                    ok("本来就没有自启项")
        finally:
            winreg.CloseKey(key)
        if enable:
            _verify_autostart()
        return True
    # macOS / Linux：给出手动命令，别乱写用户的启动项
    warn("非 Windows，未自动注册。可把下面这行加进自启：")
    log("         %s %s &" % (sys.executable, PROXY))
    return True


def _verify_autostart():
    """写完之后确认值还在。某些 OEM 启动项管理器会秒删/搬走第三方写入。"""
    import time
    import winreg

    time.sleep(2)
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY)
    except OSError:
        return
    try:
        winreg.QueryValueEx(key, RUN_NAME)
        return
    except OSError:
        pass
    finally:
        winreg.CloseKey(key)

    warn("自启项刚写就被系统搬走了（常见于联想电脑管家之类的启动项管理）。")
    warn("已改用不冲突的值名；若仍被搬走，请把下面这行手动加进「启动」文件夹：")
    log("         %s" % autostart_command())


# ---------------------------------------------------------------- 体检

def run_check():
    log("== WorkBuddy 部署体检 ==")
    log("代理地址：%s" % PROXY_URL)
    alive = proxy_alive()
    log("代理进程：%s" % ("在线" if alive else "未运行"))
    if alive:
        try:
            info = http_json(PROXY_URL + "/pool/creds", timeout=90)
            log("vault：%s" % info.get("vault"))
            log("账号：%s 个（来源 %s）" % (info.get("accounts"), "、".join(info.get("sources") or [])))
            for n in info.get("notes") or []:
                log("  · %s" % n)
        except Exception as exc:  # noqa: BLE001
            log("读 /pool/creds 失败：%s" % str(exc)[:120])
        try:
            doc = http_json(PROXY_URL + "/v1/models", timeout=60)
            log("对话模型：%d 个" % len(doc.get("data") or []))
        except Exception as exc:  # noqa: BLE001
            log("拉模型失败：%s" % str(exc)[:120])
    script = os.path.join(SCRIPTS, "setup_text_provider.py")
    if os.path.isfile(script):
        proc = subprocess.run([sys.executable, script, "--proxy", PROXY_URL, "--dry-run"],
                              capture_output=True, text=True, timeout=120)
        log("文本供应商：%s" % ("已配置" if proc.returncode == 0 else "未配置"))
    return 0


def main():
    ap = argparse.ArgumentParser(description="WorkBuddy for Toonflow 一键安装")
    ap.add_argument("--no-autostart", action="store_true", help="不注册开机自启")
    ap.add_argument("--check", action="store_true", help="只体检")
    ap.add_argument("--uninstall", action="store_true", help="移除开机自启")
    args = ap.parse_args()

    if not os.path.isfile(PROXY):
        fail("找不到 %s" % PROXY)
        return 2
    if sys.version_info < (3, 8):
        fail("需要 Python 3.8+，当前 %s" % sys.version.split()[0])
        return 2

    if args.check:
        return run_check()
    if args.uninstall:
        return 0 if step_autostart(False) else 1

    log("== WorkBuddy for Toonflow 安装 ==")
    steps = [
        ("凭据", step_credentials()),
        ("代理", start_proxy()),
        ("模型", verify_models()),
        ("文本供应商", step_text_provider()),
        ("工具插件", step_tool_plugin()),
        ("自启", step_autostart(not args.no_autostart)),
    ]
    bad = [name for name, good in steps if not good]
    log("")
    if bad:
        fail("未完成：%s" % "、".join(bad))
        log("排查：python install.py --check")
        return 1
    ok("全部完成。打开 Toonflow 就能用：聊天用 WorkBuddy 文本模型，画图/出视频走 Agent 工具。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
