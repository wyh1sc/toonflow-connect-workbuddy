#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WorkBuddy 模型倍率 / 拥挤度面板（命令行版）。

从本地代理 wb_proxy.py 的 /pool/catalog 拉取全部模型的倍率、拥挤度、
上下文长度、可用状态，排成表格。Toonflow 的模型下拉只有一个 label 字段，
没法排序也没法筛选，这个脚本补的就是这块。

用法：
    python scripts/model_rates.py                    # 默认只看对话模型，按倍率升序
    python scripts/model_rates.py --all              # 含媒体模型（生图/生视频）
    python scripts/model_rates.py --sort busy        # 按拥挤度排序
    python scripts/model_rates.py --sort name        # 按名称排序
    python scripts/model_rates.py --filter v4        # 只看 id/名称里含 v4 的
    python scripts/model_rates.py --json             # 输出原始 JSON
    python scripts/model_rates.py --watch 30         # 每 30 秒刷新一次
    python scripts/model_rates.py --proxy http://127.0.0.1:8189

退出码：0 正常；1 代理不通 / 返回异常。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_PROXY = os.environ.get("WB_PROXY_URL", "http://127.0.0.1:8189")

BUSY_ORDER = {
    "idle": 0,
    "空闲": 0,
    "normal": 1,
    "正常": 1,
    "busy": 2,
    "拥挤": 2,
    "crowded": 3,
    "very_busy": 4,
    "unknown": 5,
}

BUSY_MARK = {
    "idle": "空闲",
    "normal": "正常",
    "busy": "拥挤",
    "crowded": "很挤",
    "unknown": "—",
}


def fetch(proxy: str, timeout: float = 15.0) -> dict:
    url = proxy.rstrip("/") + "/pool/catalog"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def rows_of(payload) -> list:
    if isinstance(payload, dict):
        rows = payload.get("models")
        if isinstance(rows, list):
            return rows
    if isinstance(payload, list):
        return payload
    return []


def fmt_mult(v) -> str:
    if v is None:
        return "—"
    try:
        return "%.2fx" % float(v)
    except (TypeError, ValueError):
        return str(v)


def fmt_ctx(v) -> str:
    if not v:
        return "—"
    try:
        n = int(v)
    except (TypeError, ValueError):
        return str(v)
    if n >= 1000:
        return "%dK" % round(n / 1000.0)
    return str(n)


def busy_key(row) -> int:
    lvl = str(row.get("busy") or "unknown").lower()
    return BUSY_ORDER.get(lvl, 5)


def busy_label(row) -> str:
    lvl = str(row.get("busy") or "unknown").lower()
    return BUSY_MARK.get(lvl, row.get("busyText") or lvl)


def sort_rows(rows, mode: str):
    if mode == "multiplier":
        return sorted(rows, key=lambda r: (r.get("multiplier") is None,
                                           r.get("multiplier") or 0.0,
                                           (r.get("name") or "").lower()))
    if mode == "busy":
        return sorted(rows, key=lambda r: (busy_key(r),
                                           r.get("multiplier") or 0.0,
                                           (r.get("name") or "").lower()))
    if mode == "context":
        return sorted(rows, key=lambda r: -(int(r.get("context") or 0)))
    return sorted(rows, key=lambda r: (r.get("name") or r.get("id") or "").lower())


def select(rows, show_all: bool, keyword: str) -> list:
    out = []
    kw = (keyword or "").strip().lower()
    for r in rows:
        if not show_all and not r.get("chat"):
            continue
        if kw:
            hay = " ".join(str(r.get(k) or "") for k in ("id", "name", "badge")).lower()
            if kw not in hay:
                continue
        out.append(r)
    return out


def width_of(text: str) -> int:
    """中文按 2 列算。"""
    n = 0
    for ch in text:
        n += 2 if ord(ch) > 0x2E80 else 1
    return n


def pad(text: str, width: int) -> str:
    return text + " " * max(0, width - width_of(text))


def render(rows, sort_mode: str, show_all: bool, keyword: str) -> str:
    picked = sort_rows(select(rows, show_all, keyword), sort_mode)
    head = ["模型", "倍率", "拥挤度", "上下文", "徽标", "id"]
    body = []
    for r in picked:
        body.append([
            str(r.get("name") or r.get("id") or ""),
            fmt_mult(r.get("multiplier")),
            busy_label(r),
            fmt_ctx(r.get("context")),
            str(r.get("badge") or ""),
            str(r.get("id") or ""),
        ])
    widths = []
    for i, h in enumerate(head):
        w = width_of(h)
        for line in body:
            w = max(w, width_of(line[i]))
        widths.append(w)

    lines = []
    lines.append("  ".join(pad(h, widths[i]) for i, h in enumerate(head)).rstrip())
    lines.append("  ".join("-" * widths[i] for i in range(len(head))))
    for line in body:
        lines.append("  ".join(pad(c, widths[i]) for i, c in enumerate(line)).rstrip())
    lines.append("")
    free = [r for r in picked if r.get("multiplier") is not None and float(r.get("multiplier") or 0) <= 0]
    if free:
        names = "、".join(sorted({str(r.get("name") or r.get("id")) for r in free}))
        lines.append("免费：%s" % names)
    paid = [r for r in picked if r.get("multiplier") is not None and float(r.get("multiplier") or 0) > 0]
    if paid:
        best = min(paid, key=lambda r: float(r.get("multiplier") or 0.0))
        lines.append("最便宜（付费）：%s（%s）" % (best.get("name") or best.get("id"), fmt_mult(best.get("multiplier"))))
    lines.append("共 %d 个%s模型%s" % (
        len(picked),
        "" if show_all else "对话",
        "（筛选：%s）" % keyword if keyword else "",
    ))
    return "\n".join(lines)


HTML_HEAD = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>WorkBuddy 模型倍率 / 拥挤度</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:28px 32px;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;
     background:#f6f7f9;color:#1f2329}
@media (prefers-color-scheme:dark){body{background:#1a1d21;color:#e8eaed}
  table{background:#22262c;border-color:#333}th{background:#2a2f36}tr:hover td{background:#2d333b}}
h1{font-size:19px;margin:0 0 4px}
.sub{font-size:12.5px;opacity:.62;margin-bottom:18px}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden}
th,td{padding:9px 12px;text-align:left;border-bottom:1px solid rgba(128,128,128,.16);white-space:nowrap}
th{background:#f0f2f5;font-weight:600;font-size:12.5px;letter-spacing:.02em}
tr:last-child td{border-bottom:0}
tr:hover td{background:#fafbfc}
td.num{font-variant-numeric:tabular-nums;font-weight:600}
.mono{font-family:Consolas,ui-monospace,monospace;font-size:12.5px;opacity:.75}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
.free{background:#e7f8ee;color:#1f7a4d}.cheap{background:#e8f2ff;color:#1d5fbf}
.mid{background:#fff4e2;color:#9a6212}.high{background:#ffe9e9;color:#b33}
.b-idle{background:#e7f8ee;color:#1f7a4d}.b-normal{background:#e8f2ff;color:#1d5fbf}
.b-busy{background:#fff4e2;color:#9a6212}.b-crowded{background:#ffe9e9;color:#b33}
.b-unknown{background:rgba(128,128,128,.14);color:inherit;opacity:.7}
</style></head><body>
<h1>WorkBuddy 模型倍率 / 拥挤度</h1>
<div class="sub">生成时间 __WHEN__ · 数据源 __SRC__ · 倍率越低越省积分，拥挤度「空闲 / 正常」时出话最快</div>
<table><thead><tr><th>模型</th><th>倍率</th><th>拥挤度</th><th>上下文</th><th>徽标</th><th>id</th></tr></thead><tbody>
"""


def mult_class(v) -> str:
    if v is None:
        return ""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return "free"
    if n <= 0.2:
        return "cheap"
    if n <= 0.6:
        return "mid"
    return "high"


def render_html(rows, sort_mode: str, show_all: bool, keyword: str, proxy: str) -> str:
    picked = sort_rows(select(rows, show_all, keyword), sort_mode)
    out = [HTML_HEAD.replace("__WHEN__", time.strftime("%Y-%m-%d %H:%M:%S"))
                     .replace("__SRC__", html_escape(proxy))]
    for r in picked:
        lvl = str(r.get("busy") or "unknown").lower()
        cls = lvl if lvl in ("idle", "normal", "busy", "crowded") else "unknown"
        out.append(
            "<tr><td>%s</td>"
            "<td class=\"num\"><span class=\"pill %s\">%s</span></td>"
            "<td><span class=\"pill b-%s\">%s</span></td>"
            "<td class=\"num\">%s</td><td>%s</td><td class=\"mono\">%s</td></tr>"
            % (html_escape(str(r.get("name") or "")),
               mult_class(r.get("multiplier")), fmt_mult(r.get("multiplier")),
               cls, busy_label(r),
               fmt_ctx(r.get("context")),
               html_escape(str(r.get("badge") or "")),
               html_escape(str(r.get("id") or "")))
        )
    out.append("</tbody></table></body></html>\n")
    return "".join(out)


def html_escape(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(add_help=True, description="WorkBuddy 模型倍率 / 拥挤度面板")
    ap.add_argument("--proxy", default=DEFAULT_PROXY, help="本地代理地址，默认 %s" % DEFAULT_PROXY)
    ap.add_argument("--all", action="store_true", help="含媒体模型（生图 / 生视频）")
    ap.add_argument("--sort", default="multiplier", choices=["multiplier", "busy", "name", "context"],
                    help="排序方式，默认 multiplier（倍率升序）")
    ap.add_argument("--filter", default="", help="按 id / 名称 / 徽标过滤关键字")
    ap.add_argument("--json", action="store_true", help="输出原始 JSON，不排版")
    ap.add_argument("--html", metavar="PATH", default="",
                    help="导出 HTML 面板到 PATH（双击即可用浏览器看）")
    ap.add_argument("--watch", type=int, default=0, metavar="SEC", help="每 SEC 秒刷新一次")
    args = ap.parse_args(argv)

    def once() -> int:
        try:
            payload = fetch(args.proxy)
        except urllib.error.URLError as exc:
            sys.stderr.write("连不上代理 %s：%s\n" % (args.proxy, getattr(exc, "reason", exc)))
            sys.stderr.write("先把 wb_proxy.py 跑起来（或点 Toonflow 输入框旁的「启动管家」）。\n")
            return 1
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write("请求失败：%s\n" % exc)
            return 1

        rows = rows_of(payload)
        if not rows:
            sys.stderr.write("代理返回里没有模型列表（/pool/catalog 为空）。\n")
            return 1

        if args.html:
            path = os.path.abspath(args.html)
            parent = os.path.dirname(path)
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(render_html(rows, args.sort, args.all, args.filter, args.proxy))
            print("已导出 HTML：%s（%d 个模型）" % (path, len(select(rows, args.all, args.filter))))
            return 0

        if args.json:
            print(json.dumps(select(rows, args.all, args.filter), ensure_ascii=False, indent=2))
        else:
            print(render(rows, args.sort, args.all, args.filter))
        return 0

    if args.watch <= 0:
        return once()

    try:
        while True:
            os.system("cls" if os.name == "nt" else "clear")
            print("WorkBuddy 模型面板 · %s · 每 %d 秒刷新 · Ctrl+C 退出\n"
                  % (time.strftime("%H:%M:%S"), args.watch))
            once()
            time.sleep(max(5, args.watch))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
