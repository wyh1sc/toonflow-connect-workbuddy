#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 tool/workbuddyConnect.tool.js 装进 Toonflow（走 /api/tools/install）。

用法：
    python scripts/install_tool_plugin.py            # 安装 / 覆盖安装
    python scripts/install_tool_plugin.py --list     # 看到底装没装、有没有加载错误
    python scripts/install_tool_plugin.py --enable   # 打开
    python scripts/install_tool_plugin.py --disable  # 关掉
    python scripts/install_tool_plugin.py --uninstall

Toonflow 端口：--port，或 TF_PORT 环境变量，或读安装目录下的
`app/Resources/desktopRuntime.json`（每次重启会变）。

退出码：0 成功 / 1 失败
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = os.path.join(HERE, "tool", "workbuddyConnect.tool.js")
TOOL_NAME = "workbuddyConnect"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tf_common import call, find_toonflow_port, log  # noqa: E402


def installed_rows(port):
    status, resp = call(port, "GET", "/api/tools/get", timeout=180)
    if status != 200 or not isinstance(resp, dict):
        return None
    data = resp.get("data") or {}
    rows = data.get("tools") if isinstance(data, dict) else None
    return rows if isinstance(rows, list) else None


def show_list(port):
    rows = installed_rows(port)
    if rows is None:
        log("读不到工具列表（Toonflow 没开，或端口不对）")
        return 1
    log("已装工具 %d 个：" % len(rows))
    for t in rows:
        mark = "  <==" if t.get("name") == TOOL_NAME else ""
        log("  %-22s v%-8s enabled=%-5s builtin=%-5s loadError=%r%s"
            % (t.get("name"), t.get("version"), t.get("enabled"),
               t.get("builtin"), (t.get("loadError") or "")[:120], mark))
    hit = [t for t in rows if t.get("name") == TOOL_NAME]
    if not hit:
        log("\n%s 还没装。" % TOOL_NAME)
        return 0
    t = hit[0]
    if t.get("loadError"):
        log("\n注意：%s 报加载错误，插件不会生效。" % TOOL_NAME)
        return 1
    log("\n%s 已安装，可以用了。" % TOOL_NAME)
    return 0


def set_enabled(port, enabled):
    """Toonflow 的开关路由是 PUT /api/tools/setEnabled，而且只有它会
    真正 import() 插件模块 —— 也就是只有它能让插件模块顶层的 Bun.serve 起来。
    所以安装完必须再调一次（见 force_load 说明）。"""
    status, resp = call(port, "PUT", "/api/tools/setEnabled",
                        {"name": TOOL_NAME, "enabled": bool(enabled)}, timeout=180)
    body = json.dumps(resp, ensure_ascii=False) if isinstance(resp, dict) else str(resp)
    log("setEnabled(%s) -> HTTP %s %s" % (bool(enabled), status, body[:300]))
    return status == 200


def wait_listening(port, seconds=20):
    """等插件内置服务真的起来（模块顶层 Bun.serve）。"""
    deadline = time.time() + seconds
    url = "http://127.0.0.1:%d/healthz" % port
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return resp.read().decode("utf-8", "ignore")[:200]
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    return ""


def main():
    ap = argparse.ArgumentParser(description="安装 WorkBuddy 连接工具插件")
    ap.add_argument("--port", type=int, default=None, help="Toonflow 后端端口")
    ap.add_argument("--list", action="store_true", help="只看状态")
    ap.add_argument("--enable", action="store_true")
    ap.add_argument("--disable", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    args = ap.parse_args()

    port = find_toonflow_port(args.port)
    if not port:
        log("没找到 Toonflow 后端端口。先打开 Toonflow，或用 --port 指定。")
        return 1

    if args.list:
        return show_list(port)

    if args.enable or args.disable:
        return 0 if set_enabled(port, args.enable) else 1

    if args.uninstall:
        status, resp = call(port, "DELETE", "/api/tools/uninstall", {"name": TOOL_NAME},
                            timeout=120)
        log("uninstall -> HTTP %s %s" % (status, json.dumps(resp, ensure_ascii=False)[:300]
                                         if isinstance(resp, dict) else str(resp)[:300]))
        return 0 if status == 200 else 1

    if not os.path.isfile(TOOL):
        log("找不到插件文件：%s" % TOOL)
        return 1
    with open(TOOL, "r", encoding="utf-8") as fp:
        source = fp.read()

    version = "1.0.0"
    head = source.splitlines()[0] if source else ""
    if "toonflowTool:" in head:
        try:
            meta = json.loads(head.split("toonflowTool:", 1)[1].rsplit("*/", 1)[0].strip())
            version = meta.get("version") or version
        except Exception:  # noqa: BLE001
            pass

    status, resp = call(port, "POST", "/api/tools/install", {
        "fileName": os.path.basename(TOOL),
        "source": source,
        "force": True,
        "version": version,
    }, timeout=180)
    body = json.dumps(resp, ensure_ascii=False) if isinstance(resp, dict) else str(resp)
    log("install -> HTTP %s %s" % (status, body[:400]))
    if status != 200:
        return 1

    # 关键：install 只落文件、不执行模块。必须再 setEnabled 一次，
    # 插件的模块顶层才会跑起来（内置 Bun.serve 才会监听）。
    set_enabled(port, True)
    plugin_port = 0
    try:
        with open(os.path.join(os.path.expanduser("~"), ".toonflow-workbuddy", "port.txt"),
                  "r", encoding="utf-8") as fp:
            plugin_port = int((fp.read() or "0").strip() or 0)
    except Exception:  # noqa: BLE001
        plugin_port = 0
    info = wait_listening(plugin_port) if plugin_port else ""
    if info:
        log("内置服务已就绪：http://127.0.0.1:%d  %s" % (plugin_port, info))
    elif plugin_port:
        log("内置服务还没起来（端口 %d 未监听）。在 Toonflow 里随便发一句话，"
            "或再执行一次 --enable。" % plugin_port)

    log("")
    show_list(port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
