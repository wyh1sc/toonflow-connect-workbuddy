#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Toonflow 后端定位与调用的公共代码（纯标准库）。

Toonflow 桌面端每次启动都会换一个后端 HTTP 端口，所以不能写死。定位顺序：

  1. 命令行 --port / 环境变量 TF_PORT
  2. 安装目录下的 app/Resources/desktopRuntime.json（里面直接写着 port）
     —— 安装目录本身按 TOONFLOW_HOME、Windows 卸载表、常见路径去找
  3. 正在运行的 bun.exe 进程监听的端口（前面都失败时的兜底）

找到之后都会真的发一次请求确认是 Toonflow，避免拿错端口。
"""

import glob
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

APP_DIR_NAMES = ("toonflow", "Toonflow", "toonflow-desktop", "ToonflowDesktop")
REG_UNINSTALL = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"


def log(msg):
    print(msg, flush=True)


# ------------------------------------------------------------ 安装目录

def _candidate_roots():
    roots = []
    env = os.environ.get("TOONFLOW_HOME")
    if env:
        roots.append(env)
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or ""
        prog = os.environ.get("ProgramFiles") or ""
        prog86 = os.environ.get("ProgramFiles(x86)") or ""
        for base in (local, prog, prog86):
            if not base:
                continue
            for name in APP_DIR_NAMES:
                roots.append(os.path.join(base, name))
                roots.append(os.path.join(base, "Programs", name))
    else:
        roots.extend(("/Applications/Toonflow.app", "/usr/local/toonflow", "/opt/toonflow"))
    roots.append(os.path.expanduser("~/toonflow"))
    roots.extend(_registry_roots())
    return [r for r in roots if r]


def _registry_roots():
    """Windows 卸载表里 DisplayName 含 toonflow 的 DisplayIcon / InstallLocation。"""
    if sys.platform != "win32":
        return []
    try:
        import winreg
    except Exception:  # noqa: BLE001
        return []
    out = []
    try:
        root = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_UNINSTALL)
    except OSError:
        return []
    try:
        for index in range(0, 1024):
            try:
                sub = winreg.EnumKey(root, index)
            except OSError:
                break
            try:
                key = winreg.OpenKey(root, sub)
            except OSError:
                continue
            try:
                try:
                    name = str(winreg.QueryValueEx(key, "DisplayName")[0])
                except OSError:
                    continue
                if "toonflow" not in name.lower():
                    continue
                for field in ("InstallLocation", "DisplayIcon"):
                    try:
                        raw = str(winreg.QueryValueEx(key, field)[0])
                    except OSError:
                        continue
                    if not raw:
                        continue
                    raw = raw.strip('"').rstrip(",")
                    if raw.lower().endswith(".exe"):
                        raw = os.path.dirname(raw)
                    if raw and os.path.isdir(raw):
                        out.append(raw)
            finally:
                winreg.CloseKey(key)
    finally:
        winreg.CloseKey(root)
    return out


def _runtime_json_in(root):
    """在一个安装目录里找 desktopRuntime.json 的常见位置。"""
    for rel in (
        ("app", "Resources", "desktopRuntime.json"),
        ("Resources", "desktopRuntime.json"),
        ("resources", "desktopRuntime.json"),
        ("desktopRuntime.json",),
    ):
        path = os.path.join(root, *rel)
        if os.path.isfile(path):
            return path
    return None


def _port_from_runtime(roots):
    for root in roots:
        path = _runtime_json_in(root)
        if not path:
            continue
        try:
            with open(path, "r", encoding="utf-8") as fp:
                port = int(json.load(fp).get("port") or 0)
        except Exception:  # noqa: BLE001
            continue
        if port:
            return port, path
    return 0, None


# ------------------------------------------------------------ 进程兜底

def _bun_pids():
    pids = set()
    try:
        if sys.platform == "win32":
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq bun.exe", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=20).stdout
            for line in out.splitlines():
                parts = [p.strip('"') for p in line.split('","')]
                if len(parts) >= 2 and parts[0].lower().endswith("bun.exe"):
                    try:
                        pids.add(int(parts[1]))
                    except ValueError:
                        pass
        else:
            out = subprocess.run(["pgrep", "-x", "bun"], capture_output=True, text=True, timeout=20).stdout
            for line in out.split():
                try:
                    pids.add(int(line))
                except ValueError:
                    pass
    except Exception:  # noqa: BLE001
        return []
    return sorted(pids)


def _listening_ports(pids):
    ports = set()
    if not pids:
        return []
    try:
        if sys.platform == "win32":
            out = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                                 capture_output=True, text=True, timeout=30).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) < 5 or parts[3].upper() != "LISTENING":
                    continue
                try:
                    pid = int(parts[4])
                except ValueError:
                    continue
                if pid in pids:
                    try:
                        ports.add(int(parts[1].rsplit(":", 1)[1]))
                    except (ValueError, IndexError):
                        pass
        else:
            out = subprocess.run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"],
                                 capture_output=True, text=True, timeout=30).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) < 2 or not parts[1].isdigit() or int(parts[1]) not in pids:
                    continue
                for chunk in parts:
                    if ":" in chunk and chunk.rsplit(":", 1)[-1].isdigit():
                        ports.add(int(chunk.rsplit(":", 1)[1]))
    except Exception:  # noqa: BLE001
        return []
    return sorted(ports, reverse=True)


# ------------------------------------------------------------ 校验 + 定位

def headers(port):
    return {
        "x-toonflow-desktop": "1",
        "x-toonflow-workspace": "1",
        "Origin": "http://127.0.0.1:%d" % port,
        "Content-Type": "application/json",
    }


def call(port, method, path, body=None, timeout=120):
    """返回 (status, 解析后的 dict 或错误文本)。status 0 表示连不上。"""
    url = "http://127.0.0.1:%d%s" % (port, path)
    data = None
    hdrs = headers(port)
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "ignore")
            return resp.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "ignore")[:800]
    except Exception as exc:  # noqa: BLE001
        return 0, str(exc)[:200]


def is_toonflow(port, timeout=10):
    status, _ = call(port, "GET", "/api/settings/get", timeout=timeout)
    return status in (200, 400, 401, 403)


def find_toonflow_port(explicit=None, quiet=False):
    """返回可用端口；找不到返回 0。"""
    def say(msg):
        if not quiet:
            log(msg)

    if explicit:
        if is_toonflow(int(explicit)):
            return int(explicit)
        say("指定的端口 %s 不是 Toonflow 后端。" % explicit)
        return 0

    env = os.environ.get("TF_PORT")
    if env:
        try:
            if is_toonflow(int(env)):
                return int(env)
        except ValueError:
            pass

    port, path = _port_from_runtime(_candidate_roots())
    if port and is_toonflow(port):
        say("Toonflow 端口 %s（来自 %s）" % (port, path))
        return port
    if port:
        say("desktopRuntime.json 写着 %s，但连不上，继续找。" % port)

    for candidate in _listening_ports(_bun_pids()):
        if is_toonflow(candidate):
            say("Toonflow 端口 %s（来自运行中的 bun 进程）" % candidate)
            return candidate

    say("没找到 Toonflow 后端端口。先打开 Toonflow，或用 --port 指定。")
    return 0
