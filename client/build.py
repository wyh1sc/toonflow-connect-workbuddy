#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 client/src 下的界面代码打包进 tool/workbuddyConnect.tool.js。

产物形态（Toonflow 工具插件契约）：
  第 1 行  /*! toonflowTool:{...} */              元数据（含 components 列表）
  第 2 行  /*! toonflowToolClient:{"code","css"} */  客户端界面
  第 3 行起 // @bun + 服务端代码

它做四件事：
  1. 读 client/src/index.js 与 client/src/index.css
  2. 校验 JS 能被 Bun.Transpiler 扫描（宿主安装时也走这一步）
  3. 把 components 列表写进元数据（服务端导出的工具名 ∩ 界面导出名）
  4. 重写 .tool.js：第 2 行换成新的客户端界面

用法：
  python client/build.py                # 写回 tool/workbuddyConnect.tool.js
  python client/build.py --check        # 只校验，不写
  python client/build.py --out a.js     # 写到别处
"""

import argparse
import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC_JS = os.path.join(HERE, "src", "index.js")
SRC_CSS = os.path.join(HERE, "src", "index.css")
TOOL = os.path.join(ROOT, "tool", "workbuddyConnect.tool.js")
BUN_CANDIDATES = [
    os.environ.get("BUN_EXE", ""),
    # Toonflow 自带 bun.exe，但安装目录可能被改名/改盘，按顺序试几个已知位置
    r"E:\Toonflow\Toonflow\stable\app\bin\bun.exe",
    r"E:\local.toonflow.desktop\local.toonflow.desktop\stable\app\bin\bun.exe",
    os.path.join(os.environ.get("LOCALAPPDATA") or "", "Toonflow", "stable", "app", "bin", "bun.exe"),
    os.path.join(os.environ.get("LOCALAPPDATA") or "", "toonflow", "stable", "app", "bin", "bun.exe"),
    "bun",
]

CLIENT_PREFIX = "/*! toonflowToolClient:"
META_RE = re.compile(r"^/\*!\s*toonflowTool:(.*?)\s*\*/\s*$")


def log(msg):
    print(msg, flush=True)


def read_text(path):
    with io.open(path, encoding="utf-8") as f:
        return f.read()


def write_text(path, text):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def find_bun():
    for c in BUN_CANDIDATES:
        if not c:
            continue
        if c == "bun":
            return c
        if os.path.isfile(c):
            return c
    return ""


def scan_js(bun, code):
    """用 Bun.Transpiler 扫一遍，等同于宿主 /api/tools/install 的语法校验。"""
    if not bun:
        log("! 没找到 bun，跳过语法校验")
        return True
    tmp_js = os.path.join(HERE, ".scan.client.js")
    tmp_runner = os.path.join(HERE, ".scan.run.mjs")
    write_text(tmp_js, code)
    write_text(
        tmp_runner,
        'const src = await Bun.file(' + json.dumps(tmp_js) + ').text();\n'
        'const s = new Bun.Transpiler({ loader: "js" }).scan(src);\n'
        'if (s.imports.length || s.exports.length) console.log("imports=" + s.imports.length + " exports=" + s.exports.length);\n'
        'console.log("OK");\n',
    )
    try:
        p = subprocess.run([bun, tmp_runner], capture_output=True, timeout=180)
        out = (p.stdout or b"").decode("utf-8", "replace").strip()
        err = (p.stderr or b"").decode("utf-8", "replace").strip()
        if p.returncode != 0 or "OK" not in out:
            log("[x] 语法校验失败：\n" + (err or out))
            return False
        log("[ok] 语法校验通过（" + out.replace("\n", " / ") + "）")
        return True
    finally:
        for f in (".scan.client.js", ".scan.run.mjs"):
            p2 = os.path.join(HERE, f)
            if os.path.isfile(p2):
                os.remove(p2)


def tool_names_from_server(text):
    """从服务端代码里抓 ToolDefinition 的 name（name: "xxx",）。"""
    names = re.findall(r'\bname:\s*"([a-z][a-zA-Z0-9]*)"', text)
    seen = []
    for n in names:
        if n.startswith("workbuddy") and n not in seen:
            seen.append(n)
    return seen


def parse_tool_file(text):
    lines = text.split("\n")
    if len(lines) < 2:
        raise SystemExit("tool 文件格式不对：少于两行")
    m = META_RE.match(lines[0])
    if not m:
        raise SystemExit("tool 文件第 1 行不是 /*! toonflowTool:{...} */")
    meta = json.loads(m.group(1))
    body_start = 2
    if lines[1].startswith(CLIENT_PREFIX):
        body_start = 2
    return meta, lines, body_start


def strip_block_comments(code):
    """把 /* ... */ 注释整段删掉。

    客户端代码最终要塞进 `/*! toonflowToolClient:{...} */` 这一行注释里，
    源码里只要出现一个块注释结束符（星号 + 斜杠），整行 JSON 就会被提前截断，
    宿主解析时报「工具客户端界面格式或脚本语法无效」。所以这里先清干净。
    """
    out = []
    i = 0
    n = len(code)
    while i < n:
        j = code.find("/*", i)
        if j < 0:
            out.append(code[i:])
            break
        out.append(code[i:j])
        k = code.find("*/", j + 2)
        if k < 0:
            out.append(" ")
            break
        # 注释里若含换行，保留换行以维持行号
        block = code[j : k + 2]
        out.append("\n" * block.count("\n"))
        i = k + 2
    return "".join(out)


COMMENT_END = "*" + "/"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验不写回")
    ap.add_argument("--out", default="", help="输出到别的路径")
    args = ap.parse_args()

    raw_js = read_text(SRC_JS)
    css = strip_block_comments(read_text(SRC_CSS))
    code = strip_block_comments(raw_js)

    if COMMENT_END in code:
        log("[x] 客户端代码里还有块注释结束符，会被注释行截断")
        return 1

    bun = find_bun()
    if not scan_js(bun, code):
        return 1

    if "toonflowToolHost" not in code:
        log("[x] 客户端代码必须从 window.toonflowToolHost 取 vue")
        return 1

    tool_text = read_text(TOOL)
    meta, lines, body_start = parse_tool_file(tool_text)
    server_body = "\n".join(lines[body_start:])
    known = tool_names_from_server(server_body)

    exported = re.findall(r"^\s{4}(workbuddy[A-Za-z0-9]*):\s*\w+,?\s*$", code, re.M)
    if not exported:
        log("[x] 客户端没导出任何组件")
        return 1
    missing = [n for n in exported if n not in known]
    if missing:
        log("[x] 客户端导出了服务端没有的工具：" + ", ".join(missing))
        return 1
    components = [n for n in known if n in exported]
    log("组件：" + ", ".join(components) + "（服务端工具 " + str(len(known)) + " 个）")

    payload = json.dumps({"code": code, "css": css}, ensure_ascii=False, separators=(",", ":"))
    if "\n" in payload or "\r" in payload:
        log("[x] code/css 里不能有换行（JSON 转义后仍不该出现字面换行）")
        return 1

    meta["components"] = components
    meta_line = "/*! toonflowTool:" + json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + " */"
    client_line = CLIENT_PREFIX + payload + " */"

    out_text = meta_line + "\n" + client_line + "\n" + server_body
    if not out_text.endswith("\n"):
        out_text += "\n"

    if args.check:
        log("[ok] 校验通过（未写回）。meta 行 %d B，client 行 %d B，总 %d B"
            % (len(meta_line.encode("utf-8")), len(client_line.encode("utf-8")), len(out_text.encode("utf-8"))))
        return 0

    target = args.out or TOOL
    write_text(target, out_text)
    log("[ok] 已写入 %s（%d B，版本 %s，组件 %d 个）"
        % (target, len(out_text.encode("utf-8")), meta.get("version"), len(components)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
