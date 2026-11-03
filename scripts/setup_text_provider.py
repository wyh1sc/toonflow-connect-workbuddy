# -*- coding: utf-8 -*-
"""
把 WorkBuddy 的文本模型注册成 Toonflow 的「文本供应商」。

Toonflow 的文本模型不走插件（ProviderDefinition 只有 generateImage/Video/Audio，
没有 generateChat），只能写进 settings.customProviders。
本脚本就是干这个的：读代理的 /v1/models，合并进 customProviders，PUT 保存。

用法：
    python scripts/setup_text_provider.py                # 自动找端口，写入
    python scripts/setup_text_provider.py --dry-run      # 只看会写什么
    python scripts/setup_text_provider.py --port 54149   # 指定 Toonflow 端口
    python scripts/setup_text_provider.py --proxy http://127.0.0.1:8189
    python scripts/setup_text_provider.py --label "WorkBuddy"

退出码：0 成功 / 1 失败（代理或 Toonflow 不可达、保存被拒）
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

PROVIDER_ID = "workbuddy"
DEFAULT_PROXY = "http://127.0.0.1:8189"

# 图标：Toonflow 下拉里显示的小方块，必须 data:image/svg+xml;base64
ICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    '<rect width="64" height="64" rx="14" fill="#1f6feb"/>'
    '<path d="M16 40l7-21 9 15 9-15 7 21" stroke="#fff" stroke-width="5" '
    'stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
)


def log(msg):
    print(msg, flush=True)


def http_json(url, headers=None, body=None, method="GET", timeout=60):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tf_common import find_toonflow_port as _find_port  # noqa: E402


def find_toonflow_port(explicit=None):
    """定位 Toonflow 后端端口（desktopRuntime.json / 卸载表 / bun 进程兜底）。"""
    port = _find_port(explicit)
    if not port:
        raise SystemExit(
            "找不到 Toonflow 端口。请用 --port 指定，或设环境变量 TF_PORT。\n"
            "端口在 <Toonflow 安装目录>/app/Resources/desktopRuntime.json 的 port 字段。"
        )
    return port


def tf_headers(port):
    return {
        "x-toonflow-desktop": "1",
        "x-toonflow-workspace": "1",
        "Origin": "http://127.0.0.1:%d" % port,
        "Content-Type": "application/json",
    }


def fetch_proxy_models(proxy):
    try:
        payload = http_json(proxy.rstrip("/") + "/v1/models", timeout=120)
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            "读不到代理模型列表：%s\n先起代理：python proxy/wb_proxy.py" % exc
        )
    rows = payload.get("data") or []
    if not rows:
        raise SystemExit("代理返回 0 个模型，账号或目录可能有问题。")
    return rows


def to_toonflow_model(row):
    """把代理的 OpenAI 模型条目映射成 Toonflow customProviders[].models[] 的形状。"""
    eff = row.get("reasoningEfforts")
    if isinstance(eff, list) and eff:
        efforts = {str(e): str(e) for e in eff}
    else:
        efforts = False

    model = {
        "id": row["id"],
        "label": row.get("display_name") or row.get("name") or row["id"],
        "contextWindow": row.get("inputTokenLimit") or row.get("contextWindow"),
        "maxOutputTokens": row.get("outputTokenLimit") or row.get("maxOutputTokens"),
        "reasoningEfforts": efforts,
    }
    return {k: v for k, v in model.items() if v is not None}


def upsert_provider(settings, proxy, label):
    providers = settings.get("customProviders")
    if not isinstance(providers, list):
        providers = []
        settings["customProviders"] = providers

    models = [to_toonflow_model(r) for r in fetch_proxy_models(proxy)]

    existing = None
    for item in providers:
        if str(item.get("id", "")).lower() == PROVIDER_ID:
            existing = item
            break

    if existing is None:
        existing = {
            "id": PROVIDER_ID,
            "label": label,
            "apiKey": "no-key",
            "apiUrl": proxy.rstrip("/"),
            "protocol": "openai-completions",
            "icon": "data:image/svg+xml;base64,"
            + base64.b64encode(ICON_SVG.encode("utf-8")).decode("ascii"),
            "models": models,
        }
        providers.append(existing)
        action = "新增"
    else:
        existing["apiUrl"] = proxy.rstrip("/")
        existing["protocol"] = "openai-completions"
        existing["label"] = label or existing.get("label") or label
        if not existing.get("apiKey"):
            # 代理不校验 key，但 Toonflow 要求非空
            existing["apiKey"] = "no-key"
        if not existing.get("icon"):
            existing["icon"] = (
                "data:image/svg+xml;base64,"
                + base64.b64encode(ICON_SVG.encode("utf-8")).decode("ascii")
            )
        existing["models"] = models
        action = "更新"

    return existing, models, action


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, help="Toonflow 后端端口")
    ap.add_argument("--proxy", default=os.environ.get("WB_PROXY") or DEFAULT_PROXY,
                    help="wb_proxy 地址，默认 %s" % DEFAULT_PROXY)
    ap.add_argument("--label", default="WorkBuddy", help="供应商显示名")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不保存")
    args = ap.parse_args()

    port = find_toonflow_port(args.port)
    base = "http://127.0.0.1:%d" % port
    headers = tf_headers(port)

    try:
        settings = http_json(base + "/api/settings/get", headers=headers, timeout=30)["data"]
    except Exception as exc:  # noqa: BLE001
        raise SystemExit("读 Toonflow 设置失败：%s\n端口 %d 对吗？" % (exc, port))

    provider, models, action = upsert_provider(settings, args.proxy, args.label)

    log("%s供应商 %s：%d 个模型" % (action, provider["id"], len(models)))
    for m in models[:5]:
        log("  %-24s %s" % (m["id"], m.get("label")))
    if len(models) > 5:
        log("  … 其余 %d 个" % (len(models) - 5))

    if args.dry_run:
        log("--dry-run，未保存。")
        return 0

    try:
        resp = http_json(
            base + "/api/settings/save",
            headers=headers,
            body={"settings": settings},
            method="PUT",
            timeout=90,
        )
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise SystemExit("保存被拒：HTTP %s %s" % (exc.code, detail))

    log("保存 -> %s" % json.dumps(resp, ensure_ascii=False)[:200])

    # 回读校验
    after = http_json(base + "/api/settings/get", headers=headers, timeout=30)["data"]
    for item in after.get("customProviders") or []:
        if str(item.get("id", "")).lower() == PROVIDER_ID:
            got = len(item.get("models") or [])
            log("校验：Toonflow 里现有 %d 个模型（应为 %d）" % (got, len(models)))
            return 0 if got == len(models) else 1

    log("校验：保存后找不到 %s" % PROVIDER_ID)
    return 1


if __name__ == "__main__":
    sys.exit(main())
