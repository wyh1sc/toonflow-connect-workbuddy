#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WorkBuddy 凭据发现 —— 让代理「装上就能用」，不必先装 DSH 插件。

凭据来源（按优先级）：

1. ``CODEBUDDY_AUTH_TOKEN`` / ``WB_ACCESS_TOKEN`` 环境变量
   （裸 token；uid / 昵称通过 ``/v2/plugin/login/account`` 现查）。
2. ``$DSH_HOME/workbuddy-vault/<region>/*.json``
   —— 装了 dsh-connect-workbuddy 的机器上现成的统一凭据库。
3. WorkBuddy / CodeBuddy 桌面端的认证文件
   —— 只要本机登录过桌面 App 就能直接拿来用：
   - Windows: ``%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth``
             ``%APPDATA%\\CodeBuddyExtension\\Data\\Public\\auth``
   - macOS:   ``~/Library/Application Support/CodeBuddyExtension/Data/Public/auth``
   - Linux:   ``$XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth``
   文件名 ``workbuddy-desktop.info`` / ``workbuddy-desktop-ai.info``（及 *.bak）。

桌面端的 accessToken / refreshToken 字段是 ``sym-v1`` 信封加密的，密钥不落盘：
由桌面 App 自己的原生绑定吐出（``ELECTRON_RUN_AS_NODE=1 <exe> -e
"process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()"``），
再 sha256 得出 32 字节字段密钥。解密在 :mod:`wb_crypto`（纯标准库 AES-GCM）。

发现到的凭据统一写回本地 vault（默认 ``~/.toonflow-workbuddy/vault/<region>``），
格式与 dsh-connect-workbuddy 的 vault 一致，账号池直接读。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request

import wb_crypto

# ---------------------------------------------------------------- 常量

AUTH_FILENAMES = ("workbuddy-desktop.info", "workbuddy-desktop-ai.info")
AUTH_FILENAME_GLOBS = AUTH_FILENAMES + tuple(n + ".bak" for n in AUTH_FILENAMES)

CN_BILLING_BASE = "https://www.codebuddy.cn"
GLOBAL_BILLING_BASE = "https://www.workbuddy.ai"
CN_CHAT_BASE = "https://copilot.tencent.com"
API_PREFIX = "/v2/plugin"

KEY_FETCH_TIMEOUT_SEC = 12
KEY_JS = (
    "try{process.stdout.write(process._linkedBinding("
    "'electron_browser_workbuddy_storage').loggerGet())}"
    "catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"
)

EXE_ENV = "WORKBUDDY_APP_EXECUTABLE"
WIN_SUBDIRS = (("Programs", "WorkBuddy"), ("WorkBuddy",),
               ("Programs", "WorkBuddyAI"), ("WorkBuddyAI",))
WIN_EXE_NAMES = ("WorkBuddy.exe", "WorkBuddyAI.exe")
MAC_BUNDLES = ("WorkBuddy.app", "WorkBuddy AI.app")


# ---------------------------------------------------------------- 工具

def _log(msg):
    if os.environ.get("WB_CREDS_QUIET") == "1":
        return
    sys.stderr.write("[wb-creds] %s\n" % msg)


def region_of(domain):
    d = (domain or "").strip().lower()
    if d.endswith(".ai") or d in ("workbuddy.ai", "codebuddy.ai"):
        return "global"
    return "cn"


def chat_base_of(domain):
    return GLOBAL_BILLING_BASE if region_of(domain) == "global" else CN_CHAT_BASE


def billing_base_of(domain):
    return GLOBAL_BILLING_BASE if region_of(domain) == "global" else CN_BILLING_BASE


# ---------------------------------------------------------------- 桌面端 exe 定位

def _win_registry_executables():
    """从卸载注册表里找 DisplayIcon（很多机器装在非默认目录）。"""
    out = []
    try:
        import winreg
    except Exception:  # noqa: BLE001
        return out
    roots = (
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    )
    for hive, path in roots:
        try:
            key = winreg.OpenKey(hive, path)
        except OSError:
            continue
        try:
            sub_count = winreg.QueryInfoKey(key)[0]
            for i in range(sub_count):
                try:
                    name = winreg.EnumKey(key, i)
                    sub = winreg.OpenKey(key, name)
                except OSError:
                    continue
                try:
                    display, _ = winreg.QueryValueEx(sub, "DisplayName")
                except OSError:
                    display = ""
                if not isinstance(display, str) or "workbuddy" not in display.lower():
                    continue
                try:
                    icon, _ = winreg.QueryValueEx(sub, "DisplayIcon")
                except OSError:
                    icon = ""
                if isinstance(icon, str) and icon.strip():
                    exe = icon.split(",")[0].strip().strip('"')
                    if exe.lower().endswith(".exe"):
                        out.append(exe)
        finally:
            try:
                winreg.CloseKey(key)
            except Exception:  # noqa: BLE001
                pass
    return out


def app_executable_candidates():
    """桌面端可执行文件的候选路径（按可信度排序）。"""
    from_env = (os.environ.get(EXE_ENV) or "").strip()
    cands = [from_env] if from_env else []
    system = platform.system()
    if system == "Windows":
        bases = [os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles"),
                 os.environ.get("ProgramFiles(x86)")]
        for base in bases:
            if not base:
                continue
            for sub in WIN_SUBDIRS:
                for name in WIN_EXE_NAMES:
                    cands.append(os.path.join(base, *(sub + (name,))))
        cands.extend(_win_registry_executables())
    elif system == "Darwin":
        for bundle in MAC_BUNDLES:
            for parent in ("/Applications", os.path.join(os.path.expanduser("~"), "Applications")):
                plist = os.path.join(parent, bundle, "Contents", "Info.plist")
                exe = _macos_bundle_executable(plist)
                if exe:
                    cands.append(exe)
                cands.append(os.path.join(parent, bundle, "Contents", "MacOS", "Electron"))
    return [c for c in cands if c]


def _macos_bundle_executable(plist_path):
    """从 Info.plist 里读 CFBundleExecutable（WorkBuddy 的壳叫 Electron）。"""
    try:
        with open(plist_path, "r", encoding="utf-8", errors="replace") as fp:
            text = fp.read()
    except OSError:
        return ""
    key = "<key>CFBundleExecutable</key>"
    i = text.find(key)
    if i < 0:
        return ""
    j = text.find("<string>", i)
    k = text.find("</string>", j)
    if j < 0 or k < 0:
        return ""
    name = text[j + len("<string>"):k].strip()
    if not name:
        return ""
    return os.path.join(os.path.dirname(plist_path), "MacOS", name)


def find_app_executable():
    for cand in app_executable_candidates():
        try:
            if os.path.isfile(cand):
                return cand
        except OSError:
            continue
    return ""


# ---------------------------------------------------------------- at-rest 密钥

_key_cache = {"exe": None, "key": None, "failed_at": 0.0}
KEY_FAILURE_TTL_SEC = 60


def read_at_rest_key():
    """跑桌面 App 的 Node 模式取 ``atRestSecretKey`` → sha256 → 32 字节密钥。

    返回 ``(key_bytes, note)``；拿不到时 ``key_bytes`` 为 None，``note`` 说明原因。
    """
    now = time.time()
    if _key_cache["key"] is not None:
        return _key_cache["key"], "cached"
    if _key_cache["failed_at"] and now - _key_cache["failed_at"] < KEY_FAILURE_TTL_SEC:
        return None, "上次取密钥失败，稍后再试（装/开一下 WorkBuddy 桌面端即可）"
    exe = _key_cache["exe"] or find_app_executable()
    if not exe:
        _key_cache["failed_at"] = now
        return None, ("没找到 WorkBuddy 桌面端（可用环境变量 %s 指定 exe 路径）"
                      % EXE_ENV)
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    try:
        proc = subprocess.run(
            [exe, "-e", KEY_JS],
            capture_output=True, text=True, timeout=KEY_FETCH_TIMEOUT_SEC,
            env=env, stdin=subprocess.DEVNULL,
            **({"creationflags": 0x08000000} if platform.system() == "Windows" else {})
        )
    except Exception as exc:  # noqa: BLE001
        _key_cache["failed_at"] = now
        return None, "启动桌面端取密钥失败：%s" % str(exc)[:160]
    payload = (proc.stdout or "").strip()
    if proc.returncode != 0 or not payload:
        _key_cache["failed_at"] = now
        err = (proc.stderr or "").strip()[:160] or "退出码 %s" % proc.returncode
        return None, "桌面端没给出密钥：%s" % err
    try:
        secret = json.loads(payload)["atRestSecretKey"]
    except Exception:  # noqa: BLE001
        _key_cache["failed_at"] = now
        return None, "桌面端返回的密钥载荷无法解析"
    if not isinstance(secret, str) or not secret:
        _key_cache["failed_at"] = now
        return None, "桌面端密钥载荷里没有 atRestSecretKey"
    key = wb_crypto.derive_key(secret)
    _key_cache.update({"exe": exe, "key": key, "failed_at": 0.0})
    return key, "ok"


# ---------------------------------------------------------------- 桌面端认证文件

def desktop_auth_dirs():
    system = platform.system()
    out = []
    if system == "Windows":
        for env in ("LOCALAPPDATA", "APPDATA"):
            base = os.environ.get(env)
            if base:
                out.append(os.path.join(base, "CodeBuddyExtension", "Data", "Public", "auth"))
    elif system == "Darwin":
        out.append(os.path.join(os.path.expanduser("~"), "Library", "Application Support",
                                "CodeBuddyExtension", "Data", "Public", "auth"))
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
        out.append(os.path.join(base, "CodeBuddyExtension", "Data", "Public", "auth"))
    return out


def _is_encrypted(value):
    return isinstance(value, dict) and value.get("$wbEncrypted") == 1 and "envelope" in value


def _read_field(value, key):
    """明文字段直接返回；加密字段按需解密。"""
    if isinstance(value, str):
        return value
    if _is_encrypted(value) and key is not None:
        try:
            return wb_crypto.open_field(value, key)
        except Exception:  # noqa: BLE001
            return ""
    return ""


def parse_auth_document(path, key):
    """解析一份桌面端认证文件，返回凭据列表（可能 0 个）。"""
    try:
        with open(path, "r", encoding="utf-8") as fp:
            doc = json.load(fp)
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(doc, dict):
        return []
    auth = doc.get("auth") if isinstance(doc.get("auth"), dict) else {}
    account = doc.get("account") if isinstance(doc.get("account"), dict) else {}

    token = _read_field(auth.get("accessToken"), key)
    if not token:
        return []
    refresh = _read_field(auth.get("refreshToken"), key)
    uid = str(account.get("uid") or account.get("userId") or "")
    if not uid:
        return []
    nickname = _read_field(account.get("nickname"), key) or uid[:8]
    uin = str(account.get("uin") or "")

    def _ms(name):
        v = auth.get(name)
        return int(v) if isinstance(v, (int, float)) else 0

    return [{
        "uid": uid,
        "nickname": nickname,
        "uin": uin,
        "domain": str(auth.get("domain") or "").strip(),
        "accessToken": token,
        "refreshToken": refresh,
        "expiresAt": _ms("expiresAt"),
        "refreshExpiresAt": _ms("refreshExpiresAt"),
        "source": "desktop:%s" % os.path.basename(path),
    }]


def scan_desktop(key):
    """扫所有桌面端认证目录；无密钥时也能读出明文（老版本 App）。"""
    found = []
    seen = set()
    key_note = ""
    for directory in desktop_auth_dirs():
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if name not in AUTH_FILENAME_GLOBS:
                continue
            path = os.path.join(directory, name)
            for cred in parse_auth_document(path, key):
                if cred["uid"] in seen:
                    continue
                seen.add(cred["uid"])
                found.append(cred)
    if not found:
        key_note = "桌面端认证目录里没有可用账号"
    return found, key_note


# ---------------------------------------------------------------- DSH vault

def dsh_vault_dir(region="cn"):
    home = os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "workbuddy-vault", region)


def scan_dsh_vault():
    found = []
    seen = set()
    for region in ("cn", "global"):
        directory = dsh_vault_dir(region)
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if not name.endswith(".json") or name.startswith("."):
                continue
            try:
                with open(os.path.join(directory, name), "r", encoding="utf-8") as fp:
                    doc = json.load(fp)
            except Exception:  # noqa: BLE001
                continue
            auth = doc.get("auth") if isinstance(doc.get("auth"), dict) else {}
            account = doc.get("account") if isinstance(doc.get("account"), dict) else {}
            token = auth.get("accessToken")
            uid = str(doc.get("accountId") or account.get("uid") or "")
            if not isinstance(token, str) or not token or not uid or uid in seen:
                continue
            seen.add(uid)
            found.append({
                "uid": uid,
                "nickname": str(account.get("nickname") or uid[:8]),
                "uin": str(account.get("uin") or ""),
                "domain": str(auth.get("domain") or "").strip(),
                "accessToken": token,
                "refreshToken": str(auth.get("refreshToken") or ""),
                "expiresAt": int(auth.get("expiresAt") or 0),
                "refreshExpiresAt": int(auth.get("refreshExpiresAt") or 0),
                "source": "dsh-vault:%s" % name,
            })
    return found


# ---------------------------------------------------------------- 环境变量

def _http_json(url, headers, method="GET", body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
    return json.loads(raw) if raw.strip() else {}


def fetch_profile(token, domain=""):
    """用 Bearer 拉账号资料；域名不限就国内国际都试一遍。"""
    bases = [billing_base_of(domain)] if domain else [CN_BILLING_BASE, GLOBAL_BILLING_BASE]
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    for base in bases:
        try:
            doc = _http_json(base + API_PREFIX + "/login/account", headers)
        except Exception:  # noqa: BLE001
            continue
        data = doc.get("data") if isinstance(doc.get("data"), dict) else doc
        if not isinstance(data, dict):
            continue
        uid = str(data.get("uid") or data.get("userId") or "")
        if not uid:
            continue
        return {
            "uid": uid,
            "nickname": str(data.get("nickname") or uid[:8]),
            "uin": str(data.get("uin") or ""),
            "domain": domain or ("www.codebuddy.cn" if base == CN_BILLING_BASE
                                 else "www.workbuddy.ai"),
        }
    return None


def scan_env():
    token = (os.environ.get("CODEBUDDY_AUTH_TOKEN")
             or os.environ.get("WB_ACCESS_TOKEN") or "").strip()
    if not token:
        return [], "未设置 CODEBUDDY_AUTH_TOKEN"
    domain = (os.environ.get("WB_DOMAIN") or "").strip()
    profile = fetch_profile(token, domain)
    if not profile:
        return [], "环境变量里的 token 校验失败（过期或不属于该区）"
    profile.update({"accessToken": token, "refreshToken": "", "expiresAt": 0,
                    "refreshExpiresAt": 0, "source": "env"})
    return [profile], "ok"


# ---------------------------------------------------------------- 刷新

def refresh_credential(cred):
    """用 refreshToken 换新 accessToken；失败返回 (None, 原因)。"""
    refresh = (cred.get("refreshToken") or "").strip()
    if not refresh:
        return None, "没有 refreshToken，无法续期"
    headers = {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0",
        "X-Refresh-Token": refresh,
        "X-Auth-Refresh-Source": "workbuddy",
    }
    base = billing_base_of(cred.get("domain"))
    try:
        doc = _http_json(base + API_PREFIX + "/auth/token/refresh", headers, method="POST")
    except Exception as exc:  # noqa: BLE001
        return None, "续期请求失败：%s" % str(exc)[:120]
    if doc.get("code") not in (0, 200):
        return None, "续期被拒：code=%s %s" % (doc.get("code"), str(doc.get("msg") or "")[:80])
    data = doc.get("data") if isinstance(doc.get("data"), dict) else {}
    token = data.get("accessToken") or ""
    if not token:
        return None, "续期没有返回 accessToken"
    cred = dict(cred)
    cred["accessToken"] = token
    if isinstance(data.get("refreshToken"), str) and data["refreshToken"]:
        cred["refreshToken"] = data["refreshToken"]
    for src, dst in (("expiresAt", "expiresAt"), ("refreshExpiresAt", "refreshExpiresAt")):
        v = data.get(src)
        if isinstance(v, (int, float)):
            cred[dst] = int(v)
    return cred, "ok"


# ---------------------------------------------------------------- 写 vault

def to_vault_document(cred):
    """落盘格式与 dsh-connect-workbuddy 一致，账号池直接可读。"""
    return {
        "version": 1,
        "accountId": cred["uid"],
        "refreshedAtMs": int(time.time() * 1000),
        "auth": {
            "accessToken": cred["accessToken"],
            "refreshToken": cred.get("refreshToken") or "",
            "expiresAt": int(cred.get("expiresAt") or 0),
            "refreshExpiresAt": int(cred.get("refreshExpiresAt") or 0),
            "domain": cred.get("domain") or "",
        },
        "account": {
            "uid": cred["uid"],
            "nickname": cred.get("nickname") or cred["uid"][:8],
            "uin": cred.get("uin") or "",
        },
        "source": cred.get("source") or "",
    }


def write_vault(creds, vault_dir):
    """把凭据写进 vault 目录，返回实际写入的文件名列表。"""
    os.makedirs(vault_dir, exist_ok=True)
    written = []
    for cred in creds:
        path = os.path.join(vault_dir, "%s.json" % cred["uid"])
        tmp = path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fp:
                json.dump(to_vault_document(cred), fp, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
            written.append(os.path.basename(path))
        except Exception as exc:  # noqa: BLE001
            _log("写 %s 失败：%s" % (path, exc))
    return written


# ---------------------------------------------------------------- 主流程

def discover(verbose=True):
    """跑一遍全部来源，返回 ``(creds, notes)``。"""
    notes = []
    creds = []
    seen = set()

    def add(items, note):
        if note and note != "ok":
            notes.append(note)
        for c in items:
            if c["uid"] in seen:
                continue
            seen.add(c["uid"])
            creds.append(c)

    env_creds, env_note = scan_env()
    add(env_creds, "环境变量：%s" % env_note)

    add(scan_dsh_vault(), "DSH 凭据库：%d 个账号" % len(scan_dsh_vault()))

    key, key_note = read_at_rest_key()
    desk_creds, desk_note = scan_desktop(key)
    add(desk_creds, "桌面端：%s（密钥 %s）" % (desk_note or "%d 个账号" % len(desk_creds), key_note))

    if verbose:
        for n in notes:
            _log(n)
        _log("共发现 %d 个账号" % len(creds))
    return creds, notes


def sync(vault_dir, refresh_expired=True):
    """发现 → 续期（可选）→ 写入 vault。返回 dict 供接口回包。"""
    creds, notes = discover(verbose=False)
    refreshed = 0
    if refresh_expired:
        now_ms = int(time.time() * 1000)
        fixed = []
        for cred in creds:
            exp = int(cred.get("expiresAt") or 0)
            if exp and exp > now_ms + 60_000:
                fixed.append(cred)
                continue
            new_cred, why = refresh_credential(cred)
            if new_cred:
                refreshed += 1
                new_cred["source"] = cred.get("source", "") + "+refresh"
                fixed.append(new_cred)
            else:
                notes.append("账号 %s 续期失败：%s" % (cred["uid"][:8], why))
                fixed.append(cred)
        creds = fixed
    written = write_vault(creds, vault_dir)
    return {
        "ok": bool(creds),
        "count": len(creds),
        "refreshed": refreshed,
        "written": written,
        "vault": vault_dir,
        "accounts": [{"uid": c["uid"], "nickname": c["nickname"],
                      "region": region_of(c.get("domain")),
                      "source": c.get("source", "")} for c in creds],
        "notes": notes,
    }


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.expanduser("~"), ".toonflow-workbuddy", "vault", "cn")
    result = sync(target)
    print(json.dumps(result, ensure_ascii=False, indent=2))
