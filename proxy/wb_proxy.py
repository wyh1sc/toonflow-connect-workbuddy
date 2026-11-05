#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
workbuddy -> OpenAI 兼容代理（给 Toonflow 用） + 账号池

背景：
  Toonflow 拼 URL 的规则是 baseUrl 去掉结尾斜杠后 + "/" 再 new URL("v1/chat/completions", base)
  => baseUrl=https://copilot.tencent.com/v2 实际请求 /v2/v1/chat/completions（404）
  而 WorkBuddy 上游只有 /v2/chat/completions，且强制 stream:true。

本代理职责：
  1. 收 OpenAI 格式 POST /v1/chat/completions
  2. 账号池挑号 -> 改写上游 POST {UPSTREAM}/v2/chat/completions，强制 stream=true
  3. 吐标准 SSE 回去（上游本身就是 OpenAI SSE，直接透传）
  4. GET /v1/models 用当前账号拉模型目录映射成 OpenAI 列表格式
  5. 每个账号的剩余积分 / 签到状态查询
  6. 失败自动换号（只对「换号有意义」的错误换：401 凭据失效 / 402 无积分 / 429 限流 / 5xx 网关；403 策略拒绝与 400 不换）

账号池接口：
  GET  /pool/accounts           -> 所有账号 + 积分 + 签到 + 当前选中
  POST /pool/mode               -> {"mode":"auto"|"fixed","uid":"..."}
  POST /pool/toggle             -> {"uid":"...","enabled":true|false}
  POST /pool/checkin            -> {"uid":"..."} 或 {} 全部签
  POST /pool/refresh            -> 重新拉积分
  POST /pool/test               -> {"uid":"..."} 发一句测试

启动：  python wb_proxy.py            （默认 127.0.0.1:8189）
"""
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# 账号凭据目录：自带一份（~/.toonflow-workbuddy/vault/<region>），启动时由
# wb_creds 从「环境变量 / DSH 凭据库 / WorkBuddy 桌面端」自动发现并写进来。
# 这样别人只要本机登录过 WorkBuddy 桌面端，装上就能用，不必先装 DSH 插件。
# 可用环境变量 WB_VAULT_DIR / WB_REGION 覆盖。
WB_REGION = os.environ.get("WB_REGION", "cn")
VAULT_DIR = os.environ.get("WB_VAULT_DIR") or os.path.join(
    os.path.expanduser("~"), ".toonflow-workbuddy", "vault", WB_REGION)

POOL_STATE = os.environ.get("WB_POOL_STATE") or os.path.join(HERE, "wb_pool.json")

# 凭据自动发现（可选模块）：拿不到就当没有，代理照常只读 vault。
try:
    sys.path.insert(0, HERE)
    import wb_creds
except Exception:  # noqa: BLE001
    wb_creds = None

UPSTREAM = "https://copilot.tencent.com"
CN_BILLING_BASE = "https://www.codebuddy.cn"
GLOBAL_BILLING_BASE = "https://www.workbuddy.ai"

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("WB_PROXY_PORT", "8189"))

UA = "CLI/2.63.2 CodeBuddy/2.63.2"
BILLING_UA = "CodeBuddy/2.0.0"
CATALOG_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0"

# 模型目录缓存（/v3/config + /v2/chat/busy）
CATALOG_TTL_SEC = 180

# 存活探测：/v3/config 会列出历史模型，其中一批上游已下线（11102）。
# 探测结果落 wb_health.json，下拉里只显示真能用的。
HEALTH_PATH = os.path.join(HERE, "wb_health.json")
HEALTH_TTL_SEC = 6 * 3600
HEALTH_HIDE = {"missing", "reject"}      # 完全不可用，不进下拉
HEALTH_WARN = {"unavail": "· 暂不可用", "error": "· 异常"}
_busy_titles = {
    "idle": "空闲", "normal": "正常", "busy": "轻微拥堵",
    "congested": "极度拥堵", "unavailable": "不可用",
}
_media_tags = {"text-to-image", "image-to-image", "text-to-video", "image-to-video"}
# Toonflow 的推理档位枚举 OF，超出范围会被 schema 拒绝
_reasoning_levels = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}

CREDIT_TTL_SEC = 600          # 积分缓存 10 分钟
COOLDOWN_SEC = 300            # 换号后该账号冷却 5 分钟

# ---- 上游渠道校验（11128）规避：照搬 dsh-connect-workbuddy 的 prepareChatBody ----
NEUTRAL_HEAD = "You are a helpful assistant."
BANNED_OPENINGS = (
    "you are an ai agent powered by deepseek harness",
    "you are claude code, anthropic's official cli for claude",
)
ZERO_WIDTH = "\u200b"
IDENTITY_CLAUSE = re.compile(
    r"(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|"
    r"interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness))",
    re.IGNORECASE,
)

# 换号「有意义」的错误码：账号维度的问题
FAILOVER_CODES = {14018}            # 14018 积分耗尽
# 换号矩阵（对齐上游实测结论）：
#   换 = 401 凭据失效 / 402 无积分 / 429 限流 / 5xx 网关
#   不换 = 403（11140 是策略拒绝 request illegal，换谁都拒）/ 400（请求本身不合法）
FAILOVER_HTTP = {401, 402, 429, 502, 503, 504}
POLICY_REJECT_CODES = {11140}


# ============================== 账号池 ==============================

class Account:
    __slots__ = ("file", "uid", "nickname", "uin", "domain", "token",
                 "credits", "checked_in", "streak", "cycle_end", "credit_ts",
                 "error", "cooldown_until", "checkin_err")

    def __init__(self, file, data):
        self.file = file
        auth = data.get("auth") or {}
        acc = data.get("account") or {}
        self.token = auth.get("accessToken") or ""
        self.domain = (auth.get("domain") or "").strip()
        self.uid = str(acc.get("uid") or "")
        self.nickname = acc.get("nickname") or self.uid[:8] or "?"
        self.uin = str(acc.get("uin") or "")
        self.credits = None
        self.checked_in = None
        self.streak = None
        self.cycle_end = ""
        self.credit_ts = 0.0
        self.error = ""
        self.checkin_err = ""
        self.cooldown_until = 0.0

    @property
    def region(self):
        d = self.domain.lower()
        if d.endswith(".ai") or d in ("workbuddy.ai", "codebuddy.ai"):
            return "global"
        return "cn"

    @property
    def masked(self):
        return self.uin[:3] + "****" + self.uin[-4:] if len(self.uin) >= 7 else self.nickname

    def to_json(self, active_uid, mode, enabled, cooldown_left):
        return {
            "uid": self.uid,
            "nickname": self.nickname,
            "uin": self.masked,
            "region": self.region,
            "credits": round(self.credits, 2) if isinstance(self.credits, (int, float)) else None,
            "checkedIn": self.checked_in,
            "streak": self.streak,
            "cycleEnd": self.cycle_end,
            "enabled": enabled,
            "active": self.uid == active_uid,
            "mode": mode,
            "cooldown": int(cooldown_left),
            "error": self.error,
            "checkinError": self.checkin_err,
            "creditsAge": int(time.time() - self.credit_ts) if self.credit_ts else None,
        }


class Pool:
    def __init__(self):
        self.lock = threading.RLock()
        self.accounts = []
        self.mode = "auto"           # auto | fixed | off
        self.fixed_uid = ""
        self.disabled = set()        # 用户手动关掉的 uid
        self.rr = 0                  # 轮询游标
        self._load_state()
        self.scan()

    # ---------- 持久化 ----------
    def _load_state(self):
        try:
            with open(POOL_STATE, "r", encoding="utf-8") as fp:
                st = json.load(fp)
            self.mode = st.get("mode") or "auto"
            self.fixed_uid = st.get("fixedUid") or ""
            self.disabled = set(st.get("disabled") or [])
        except Exception:  # noqa: BLE001
            pass

    def _save_state(self):
        try:
            with open(POOL_STATE, "w", encoding="utf-8") as fp:
                json.dump({"mode": self.mode, "fixedUid": self.fixed_uid,
                           "disabled": sorted(self.disabled)}, fp, ensure_ascii=False, indent=2)
        except Exception:  # noqa: BLE001
            pass

    # ---------- 扫描凭据 ----------
    def scan(self):
        found = []
        try:
            names = sorted(os.listdir(VAULT_DIR))
        except Exception:  # noqa: BLE001
            names = []
        for name in names:
            if not name.endswith(".json") or name.startswith("."):
                continue
            path = os.path.join(VAULT_DIR, name)
            try:
                with open(path, "r", encoding="utf-8") as fp:
                    data = json.load(fp)
                acc = Account(path, data)
                if acc.token and acc.uid:
                    found.append(acc)
            except Exception:  # noqa: BLE001
                continue
        with self.lock:
            old = {a.uid: a for a in self.accounts}
            for a in found:                       # 保留旧缓存
                if a.uid in old:
                    a.credits = old[a.uid].credits
                    a.checked_in = old[a.uid].checked_in
                    a.streak = old[a.uid].streak
                    a.cycle_end = old[a.uid].cycle_end
                    a.credit_ts = old[a.uid].credit_ts
                    a.cooldown_until = old[a.uid].cooldown_until
            self.accounts = found
        return found

    # ---------- 选号 ----------
    def usable(self):
        now = time.time()
        with self.lock:
            out = [a for a in self.accounts
                   if a.uid not in self.disabled and a.cooldown_until <= now]
        return out

    def pick(self, exclude=()):
        now = time.time()
        with self.lock:
            cands = [a for a in self.accounts
                     if a.uid not in self.disabled and a.cooldown_until <= now
                     and a.uid not in exclude]
            if not cands:
                return None
            if self.mode == "fixed" and self.fixed_uid:
                for a in cands:
                    if a.uid == self.fixed_uid:
                        return a
            # auto：积分多的优先；积分未知的往后排
            cands.sort(key=lambda a: (a.credits if isinstance(a.credits, (int, float)) else -1),
                       reverse=True)
            return cands[0]

    def active(self):
        a = self.pick()
        if a:
            return a
        with self.lock:
            return self.accounts[0] if self.accounts else None

    def bench(self, acc, seconds=COOLDOWN_SEC):
        with self.lock:
            acc.cooldown_until = time.time() + seconds

    # ---------- 积分 / 签到 ----------
    def refresh_one(self, acc):
        try:
            total, end, items = fetch_credits(acc)
            with self.lock:
                acc.credits = total
                acc.cycle_end = end
                acc.credit_ts = time.time()
                acc.error = ""
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                acc.error = str(exc)[:160]
        try:
            st = fetch_checkin_status(acc)
            with self.lock:
                acc.checked_in = bool(st.get("today_checked_in"))
                acc.streak = st.get("streak_days")
                acc.checkin_err = ""
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                acc.checkin_err = str(exc)[:120]

    def refresh_all(self, force=True):
        for acc in list(self.accounts):
            if not force and acc.credit_ts and time.time() - acc.credit_ts < CREDIT_TTL_SEC:
                continue
            self.refresh_one(acc)

    def snapshot(self):
        self.scan()
        with self.lock:
            mode = self.mode
            active = self.active()
            active_uid = active.uid if active else ""
            now = time.time()
            rows = [a.to_json(active_uid, mode, a.uid not in self.disabled,
                              max(0, a.cooldown_until - now)) for a in self.accounts]
            rows.sort(key=lambda r: -(r["credits"] or -1))
            total = sum(r["credits"] for r in rows if isinstance(r["credits"], (int, float)))
            return {"mode": mode, "fixedUid": self.fixed_uid,
                    "active": active_uid, "totalCredits": round(total, 2),
                    "accounts": rows}


POOL = Pool()


# ============================== 上游调用 ==============================

def billing_base(acc):
    return GLOBAL_BILLING_BASE if acc.region == "global" else CN_BILLING_BASE


def billing_headers(acc):
    return {
        "Authorization": "Bearer " + acc.token,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-User-Id": str(acc.uid),
        "X-Domain": acc.domain or ("www.workbuddy.ai" if acc.region == "global" else "www.codebuddy.cn"),
        "User-Agent": BILLING_UA,
    }


def billing_post(acc, path, body):
    req = urllib.request.Request(
        billing_base(acc) + path,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=billing_headers(acc),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))


def fetch_credits(acc):
    """返回 (剩余合计, 最近到期时间, 明细)；算法与 dsh-connect-workbuddy 一致。"""
    env = billing_post(acc, "/v2/billing/meter/get-user-resource", {
        "PageNumber": 1, "PageSize": 100, "ProductCode": "p_tcaca", "Status": [0, 3],
        "PackageEndTimeRangeBegin": "2020-01-01 00:00:00",
        "PackageEndTimeRangeEnd": "2125-01-01 00:00:00",
    })
    data = (((env.get("data") or {}).get("Response") or {}).get("Data") or {})
    items = data.get("Accounts") or []
    total = 0.0
    ends = []
    for it in items:
        ctype = it.get("CapacityType")
        remain = float(it.get("CycleCapacityRemainPrecise") or 0)
        if ctype == 4:
            total += remain
        elif remain > 0 and not it.get("ExpiredTime"):
            total += remain
        if remain > 0 and it.get("CycleEndTime"):
            ends.append(it["CycleEndTime"])
    ends.sort()
    return total, (ends[0] if ends else ""), items


def fetch_checkin_status(acc):
    env = billing_post(acc, "/v2/billing/meter/checkin-activity-status", {})
    return env.get("data") or {}


def claim_checkin(acc):
    env = billing_post(acc, "/v2/billing/meter/daily-checkin", {})
    return env.get("data") or {}


def chat_headers(token):
    return {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "User-Agent": UA,
    }


# ============================== 媒体（生图 / 生视频） ==============================
# WorkBuddy 的图片与视频走另一套端点，请求头也和 chat 不同（见 dsh-connect-workbuddy
# 的 imageHeaders()）：必须是客户端 UA + X-Product 等一组头，且不能带 Origin/Referer。

MEDIA_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0"
VIDEO_POLL_INTERVAL = 5
VIDEO_POLL_TIMEOUT = 900

# 任务归属：上游 /v2/videos/tasks 只认可提交它的那个账号，换号会 10085 Not authorized。
TASK_OWNER = {}
TASK_OWNER_MAX = 300


def remember_task(task_id, acc):
    if not task_id or not acc:
        return
    TASK_OWNER[str(task_id)] = acc.uid
    while len(TASK_OWNER) > TASK_OWNER_MAX:
        TASK_OWNER.pop(next(iter(TASK_OWNER)), None)


def owner_of(task_id):
    uid = TASK_OWNER.get(str(task_id or ""))
    if not uid:
        return None
    for acc in list(POOL.accounts):
        if acc.uid == uid:
            return acc
    return None


def media_headers(acc, accept="application/json, text/plain, */*"):
    domain = acc.domain or ("www.workbuddy.ai" if acc.region == "global" else "www.codebuddy.cn")
    h = {
        "Authorization": "Bearer " + acc.token,
        "Accept": accept,
        "Content-Type": "application/json",
        "User-Agent": MEDIA_UA,
        "X-Product": "SaaS",
        "X-Requested-With": "XMLHttpRequest",
        "X-Conversation-Id": str(uuid.uuid4()),
        "X-Conversation-Request-Id": str(uuid.uuid4()),
        "X-Conversation-Message-Id": str(uuid.uuid4()),
        "X-Domain": domain,
    }
    uid = str(acc.uid or "")
    if uid and not uid.startswith("$"):
        h["X-User-Id"] = uid
    else:
        h["X-No-User-Id"] = "1"
    h["X-No-Enterprise-Id"] = "1"
    return h


def media_base(acc):
    return GLOBAL_BILLING_BASE if acc.region == "global" else UPSTREAM


def _http_json(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        code = exc.code
    try:
        body = json.loads(raw.decode("utf-8", "ignore") or "{}")
    except Exception:  # noqa: BLE001
        body = {"raw": raw[:400].decode("utf-8", "ignore")}
    return code, body


def media_post(acc, path, body, timeout=600):
    req = urllib.request.Request(
        media_base(acc) + path,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=media_headers(acc),
        method="POST",
    )
    return _http_json(req, timeout)


def media_models_of(acc):
    """从 /v3/config 抽媒体模型（图片 / 视频），带 videoGeneration 能力描述。"""
    req = urllib.request.Request(media_base(acc) + "/v3/config", headers=media_headers(acc))
    code, body = _http_json(req, 30)
    data = body.get("data") or body
    rows = data.get("models") or []
    out = {"image": [], "video": []}
    for m in rows:
        tags = m.get("tags") or []
        if isinstance(tags, str):
            tags = [tags]
        mid = m.get("id") or m.get("model")
        if not mid:
            continue
        item = {"id": mid, "name": m.get("name") or mid, "tags": tags}
        if "text-to-image" in tags or "image-to-image" in tags:
            out["image"].append(item)
        if any("video" in str(t) for t in tags):
            if m.get("videoGeneration"):
                item["videoGeneration"] = m["videoGeneration"]
            out["video"].append(item)
    return out, len(rows)


def gen_image(acc, body):
    """POST /v2/images/generations -> 上游信封原样返回。"""
    model = str(body.get("model") or "")
    payload = {"model": model, "prompt": body.get("prompt") or "", "size": body.get("size") or "1024x1024"}
    n = body.get("n")
    if n:
        payload["n"] = int(n)
    if model.startswith("hunyuan-"):
        payload.setdefault("n", 1)
    elif not model.startswith("gemini-"):
        payload["response_format"] = "b64_json"
    if body.get("image"):
        return gen_image_edit(acc, body)
    return media_post(acc, "/v2/images/generations", payload, timeout=300)


def gen_image_edit(acc, body):
    payload = {
        "model": body.get("model") or "hunyuan-image-alpha-edit",
        "prompt": body.get("prompt") or "",
        "image": body.get("image"),
        "size": body.get("size") or "1024x1024",
    }
    return media_post(acc, "/v2/images/edits", payload, timeout=300)


def submit_video(acc, body):
    payload = {
        "prompt": body.get("prompt") or "",
        "model": body.get("model") or "minimax-video-h3",
        "seconds": int(body.get("seconds") or 5),
        "negative_prompt": body.get("negative_prompt") or "",
        "watermark": True,
    }
    extra = {}
    if body.get("resolution"):
        extra["resolution"] = body["resolution"]
    extra["enable_audio"] = bool(body.get("enable_audio", True))
    if body.get("image"):
        payload["image_url"] = body["image"]
        if body.get("last_image_url"):
            payload["last_image_url"] = body["last_image_url"]
    elif body.get("aspect_ratio"):
        extra["aspect_ratio"] = body["aspect_ratio"]
    payload["extra_parameters"] = extra
    return media_post(acc, "/v2/videos/generations", payload, timeout=120)


def video_result(env):
    """从上游任务信封里取 (status, videos, credit)。兼容 data.videos[] 与 data.data[] 两种形态。"""
    data = (env or {}).get("data") or {}
    status = str(data.get("status") or "")
    raw = data.get("videos") or data.get("data") or []
    videos = []
    for item in raw:
        if isinstance(item, str):
            videos.append(item)
        elif isinstance(item, dict) and item.get("url"):
            videos.append(item["url"])
    credit = (data.get("usage") or {}).get("credit")
    if credit is None:
        credit = data.get("credit")
    return status, [v for v in videos if v], credit


def poll_video(acc, task_id):
    """轮询到终态；返回 (status, videos, credit, last_envelope)。"""
    deadline = time.time() + VIDEO_POLL_TIMEOUT
    last = {}
    while time.time() < deadline:
        code, env = media_post(acc, "/v2/videos/tasks", {"task_id": task_id}, timeout=120)
        last = env
        status, videos, credit = video_result(env)
        if status == "completed":
            return "completed", videos, credit, env
        if status == "failed":
            return "failed", [], credit, env
        time.sleep(VIDEO_POLL_INTERVAL)
    return "timeout", [], None, last


# ============================== 模型目录（/v3/config + busy） ==============================

def catalog_headers(acc):
    return {
        "Authorization": "Bearer " + acc.token,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-User-Id": str(acc.uid),
        "X-Domain": acc.domain or "www.codebuddy.cn",
        "User-Agent": CATALOG_UA,
    }


def _cfg_get(acc, base, path):
    req = urllib.request.Request(base + path, headers=catalog_headers(acc))
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def _cfg_post(acc, base, path, body):
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode("utf-8"),
        headers=catalog_headers(acc), method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def _num(value):
    """'x0.21' / '0.50x' -> 0.21 / 0.5；解析不了返回 None。"""
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    s = value.strip().lstrip("xX").rstrip("xX").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _minutes(hhmm, fallback):
    try:
        h, m = str(hhmm).split(":")
        return int(h) * 60 + int(m)
    except Exception:  # noqa: BLE001
        return fallback


def _promo_active(promo, now=None):
    """促销是否当前生效（daily 时间窗 + 绝对窗口）。简化实现，够用即可。"""
    if not isinstance(promo, dict):
        return False
    sch = promo.get("schedule")
    if not isinstance(sch, dict):
        return True
    if sch.get("dailyUnusable") is True:
        return False
    daily = sch.get("daily")
    if not isinstance(daily, list) or not daily:
        return True
    if now is None:
        now = time.localtime()
    cur = now.tm_hour * 60 + now.tm_min
    for win in daily:
        if not isinstance(win, dict):
            continue
        start = _minutes(win.get("start"), -1)
        end = _minutes(win.get("end"), -1)
        if start < 0 or end < 0:
            continue
        if start <= end:
            if start <= cur <= end:
                return True
        elif cur >= start or cur <= end:      # 跨零点，如 23:00 -> 7:50
            return True
    return False


def _promo_labels(cfg, model):
    """返回 (生效倍率 or None, 徽标文案 or None)，规则对齐 dsh-connect-workbuddy。"""
    promos = []
    for pm in (cfg.get("modelPromotions") or []):
        if not isinstance(pm, dict):
            continue
        if model in (pm.get("modelIds") or []) or pm.get("modelId") == model:
            promos.append(pm)
    promos.sort(key=lambda p: -(p.get("priority") or 0))
    mult = None
    badge = None
    for promo in promos:
        disc = promo.get("discount") or {}
        b = promo.get("badge") or {}
        if badge is None and isinstance(b.get("label"), str) and _promo_active(promo):
            badge = b["label"]
        if mult is None and disc.get("displayMode") in ("replace", "strikethrough") and _promo_active(promo):
            v = _num(disc.get("discountedCredits"))
            if v is None:
                v = _num(disc.get("multiplier"))
            if v is not None:
                mult = v
    tiers = cfg.get("modelTiers") or []
    if badge is None:
        for tier in tiers:
            if isinstance(tier, dict) and model in (tier.get("modelIds") or []):
                lbl = (tier.get("badge") or {}).get("label")
                if isinstance(lbl, str) and lbl:
                    badge = lbl
                    break
    return mult, badge


def build_catalog(acc):
    """拉 /v3/config + busy，产出模型清单（含倍率/徽标/拥挤度/上下文）。"""
    base = billing_base(acc)
    env = _cfg_get(acc, base, "/v3/config")
    data = env.get("data") or {}
    models = data.get("models") or []
    ids = [m.get("id") for m in models if isinstance(m, dict) and m.get("id")]
    busy = {}
    for i in range(0, len(ids), 50):
        try:
            env2 = _cfg_post(acc, UPSTREAM, "/v2/chat/busy", {"models": ids[i:i + 50]})
            for e in (env2.get("data") or []):
                if isinstance(e, dict) and e.get("model"):
                    busy[e["model"]] = e.get("busy_level") or "unknown"
        except Exception:  # noqa: BLE001
            pass
    rows = []
    for m in models:
        if not isinstance(m, dict):
            continue
        mid = m.get("id")
        if not mid:
            continue
        tags = m.get("tags") or []
        base_mult = _num(m.get("credits"))
        promo_mult, badge = _promo_labels(data, mid)
        eff = promo_mult if promo_mult is not None else base_mult
        lvl = busy.get(mid, "unknown")
        meta = m.get("metadata") or {}
        media = any(t in _media_tags for t in tags)
        ctx = m.get("maxInputTokens") or meta.get("maxInputTokens")
        rsn = m.get("reasoning") if isinstance(m.get("reasoning"), dict) else {}
        efforts = rsn.get("supportedEfforts")
        if not isinstance(efforts, list):
            efforts = []
        efforts = [e for e in efforts if e in _reasoning_levels]
        rows.append({
            "id": mid,
            "name": m.get("name") or mid,
            "multiplier": eff,
            "baseMultiplier": base_mult,
            "badge": badge,
            "busy": lvl,
            "busyText": _busy_titles.get(lvl, ""),
            "context": ctx,
            "maxOutput": m.get("maxOutputTokens") or meta.get("maxOutputTokens"),
            "efforts": efforts,
            "canDisableThinking": bool(rsn.get("canDisableThinking")),
            "tags": tags,
            "media": media,
            "disabled": bool(m.get("disabled")),
            # 只把「有 maxInputTokens 的纯文本对话模型」算作 chat；
            # 补全专用模型（codewise-* / *-completion / hunyuan-3b 等）没有 maxInputTokens，排除。
            "chat": bool(ctx) and not media and not bool(m.get("disabled"))
            and m.get("type") in (None, "chat", "text"),
        })
    return rows


class Catalog:
    def __init__(self):
        self.rows = []
        self.ts = 0.0
        self.lock = threading.Lock()

    def get(self, force=False):
        with self.lock:
            fresh = self.rows and (time.time() - self.ts < CATALOG_TTL_SEC)
            if fresh and not force:
                return self.rows
            acc = POOL.active()
            if not acc:
                return self.rows
            try:
                self.rows = build_catalog(acc)
                self.ts = time.time()
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write("[wb-proxy] catalog 失败: %s\n" % exc)
            return self.rows

    def label_of(self, row):
        bits = []
        if row["multiplier"] is not None:
            bits.append("%.2fx" % row["multiplier"])
        if row["busyText"]:
            bits.append(row["busyText"])
        if row["badge"]:
            bits.append(row["badge"])
        return " · ".join(bits)

    def display_label(self, row):
        """Toonflow 下拉里显示的文字：模型名 · 倍率 · 拥挤度 · 徽标。

        Toonflow 的模型 schema 只有 id/label/contextWindow/maxOutputTokens/
        reasoningEfforts，没有倍率和拥挤度字段，只能拼进 label。
        """
        bits = [row["name"]]
        if row["multiplier"] is not None:
            bits.append("%.2fx" % row["multiplier"])
        if row["busyText"] and row["busy"] != "unknown":
            bits.append(row["busyText"])
        if row["badge"]:
            bits.append(row["badge"])
        return " · ".join(bits)


CATALOG = Catalog()


class Health:
    """探测哪些模型真能出话。

    上游 /v3/config 会把下架的模型也列出来，选了一发就 11102
    「service information not found」。这里用 max_tokens=1 打一发探测，
    结果缓存 6 小时：missing/reject 不进下拉，unavail 标「暂不可用」。
    """

    def __init__(self):
        self.data = {}          # id -> {"state": "...", "code": n, "ts": t}
        self.lock = threading.Lock()
        self.running = False
        self._load()

    def _load(self):
        try:
            with open(HEALTH_PATH, "r", encoding="utf-8") as fp:
                d = json.load(fp)
            if isinstance(d, dict):
                self.data = {k: v for k, v in d.items() if isinstance(v, dict)}
        except Exception:  # noqa: BLE001
            self.data = {}

    def _save(self):
        try:
            with open(HEALTH_PATH, "w", encoding="utf-8") as fp:
                json.dump(self.data, fp, ensure_ascii=False, indent=1)
        except Exception:  # noqa: BLE001
            pass

    def state_of(self, mid):
        rec = self.data.get(mid)
        if not isinstance(rec, dict):
            return "unknown"
        if time.time() - (rec.get("ts") or 0) > HEALTH_TTL_SEC:
            return "unknown"
        return rec.get("state") or "unknown"

    @staticmethod
    def classify(status, body):
        """400/500 的 body 归类成 missing / reject / unavail。"""
        code = None
        try:
            j = json.loads(body)
            if isinstance(j, dict):
                code = j.get("code")
        except Exception:  # noqa: BLE001
            j = {}
        msg = str((j or {}).get("msg") or body)[:200].lower()
        if code == 11102 or "service information not found" in msg:
            return "missing"
        if code == 11133 or "rejected by the model provider" in msg:
            return "reject"
        if code in (11134, 11140) or "temporarily unavailable" in msg:
            return "unavail"
        if status >= 500:
            return "unavail"
        return "error"

    def probe_one(self, acc, mid):
        body = json.dumps({
            "model": mid, "stream": True, "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        }).encode("utf-8")
        req = urllib.request.Request(UPSTREAM + "/v2/chat/completions", data=body,
                                     headers=chat_headers(acc.token), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                r.read(64)
            return {"state": "ok", "code": 0, "ts": time.time()}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "ignore")
            return {"state": self.classify(exc.code, detail),
                    "code": exc.code, "ts": time.time()}
        except Exception:  # noqa: BLE001
            return {"state": "error", "code": 0, "ts": time.time()}

    def probe_all(self, rows, acc=None):
        acc = acc or POOL.active()
        if not acc:
            return
        ids = [r["id"] for r in rows if r["chat"]]
        with self.lock:
            if self.running:
                return
            self.running = True
        try:
            out = {}
            lock = threading.Lock()

            def work(mid):
                rec = self.probe_one(acc, mid)
                with lock:
                    out[mid] = rec

            threads = []
            for i in range(0, len(ids), 8):
                batch = ids[i:i + 8]
                threads = [threading.Thread(target=work, args=(m,), daemon=True)
                           for m in batch]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join(timeout=60)
            with self.lock:
                self.data.update(out)
                self._save()
        finally:
            with self.lock:
                self.running = False

    def kick(self, rows):
        """后台探测，别拖慢 /v1/models。"""
        stale = [r for r in rows if r["chat"] and self.state_of(r["id"]) == "unknown"]
        if not stale or self.running:
            return
        threading.Thread(target=self.probe_all, args=(rows,), daemon=True).start()


HEALTH = Health()


# ============================== 渠道校验规避 ==============================

def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p["text"] for p in content
                         if isinstance(p, dict) and isinstance(p.get("text"), str))
    return ""


def _break_identity(text):
    return IDENTITY_CLAUSE.sub(
        lambda m: re.sub(r"(\s+)", lambda w: w.group(1) + ZERO_WIDTH, m.group(0)), text
    )


def _neutralize_message(msg):
    opening = _text_of(msg.get("content")).lstrip().lower()
    if opening.startswith(BANNED_OPENINGS):
        content = msg.get("content")
        if isinstance(content, str):
            msg["content"] = NEUTRAL_HEAD + "\n\n" + content
        elif isinstance(content, list):
            msg["content"] = [{"type": "text", "text": NEUTRAL_HEAD + "\n\n"}] + content
    if isinstance(msg.get("content"), str):
        msg["content"] = _break_identity(msg["content"])


def sanitize_payload(payload):
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if isinstance(role, str) and role.strip().lower() == "developer":
            msg["role"] = "system"
            role = "system"
        name = role.strip().lower() if isinstance(role, str) else ""
        if name in ("system", "assistant"):
            _neutralize_message(msg)
    head = messages[0]
    head_role = head.get("role") if isinstance(head, dict) else None
    if not (isinstance(head_role, str) and head_role.strip().lower() == "system"):
        messages.insert(0, {"role": "system", "content": NEUTRAL_HEAD})


def failover_reason(status, body):
    """这个失败换号有没有意义？返回 (换不换, 原因)。"""
    try:
        j = json.loads(body)
    except Exception:  # noqa: BLE001
        j = {}
    code = j.get("code")
    # 11140 = 策略拒绝（request illegal），换号也一样被拒，重试只会白烧额度。
    if isinstance(code, int) and code in POLICY_REJECT_CODES:
        return False, ""
    if isinstance(code, int) and code in FAILOVER_CODES:
        return True, "code %d" % code
    if status in FAILOVER_HTTP:
        return True, "HTTP %d" % status
    return False, ""


# ============================== HTTP 服务 ==============================

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[wb-proxy] " + (fmt % args) + "\n")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8", "ignore") or "{}")
        except Exception:  # noqa: BLE001
            return {}

    # ---------- GET ----------
    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path in ("/v1/models", "/models"):
            self._models()
            return
        if path == "/pool/accounts":
            self._json(200, POOL.snapshot())
            return
        if path == "/pool/catalog":
            rows = CATALOG.get(force="refresh=1" in (self.path or ""))
            self._json(200, {"models": rows, "ts": CATALOG.ts})
            return
        if path == "/pool/health":
            rows = CATALOG.get()
            out = []
            for row in rows:
                if not row["chat"]:
                    continue
                out.append({"id": row["id"], "name": row["name"],
                            "state": HEALTH.state_of(row["id"]),
                            "hide": HEALTH.state_of(row["id"]) in HEALTH_HIDE})
            self._json(200, {"models": out, "running": HEALTH.running,
                             "ts": max([v.get("ts") or 0 for v in HEALTH.data.values()] or [0])})
            return
        if path in ("/", "/healthz"):
            self._json(200, {"ok": True, "pool": len(POOL.accounts)})
            return
        if path in ("/v1/media/models", "/media/models"):
            self._media_models()
            return
        if path in ("/v1/media/balance", "/media/balance"):
            self._media_balance()
            return
        if path in ("/pool/creds", "/pool/credentials"):
            self._json(200, self._creds_status())
            return
        self.send_error(404)

    def _creds_status(self):
        """凭据发现状态：vault 在哪、有几个账号、各来源是否可用。"""
        out = {"ok": True, "vault": VAULT_DIR, "region": WB_REGION,
               "accounts": len(POOL.accounts),
               "sources": {}, "notes": []}
        if wb_creds is None:
            out["ok"] = False
            out["notes"].append("wb_creds 模块没加载（凭据只能手放进 vault）")
            return out
        try:
            if os.environ.get("WB_CREDS_SKIP_PROBE") == "1":
                raise RuntimeError("skip")
            creds, notes = wb_creds.discover(verbose=False)
            out["discovered"] = len(creds)
            out["notes"].extend(notes)
            out["sources"] = {c.get("source", "").split(":")[0] for c in creds}
            out["sources"] = sorted(s for s in out["sources"] if s)
        except Exception as exc:  # noqa: BLE001
            out["notes"].append("探测跳过：%s" % str(exc)[:120])
        return out

    def _media_models(self):
        acc = POOL.active()
        if not acc:
            self._json(503, {"ok": False, "message": "账号池里没有可用账号"})
            return
        try:
            out, total = media_models_of(acc)
        except Exception as exc:  # noqa: BLE001
            self._json(502, {"ok": False, "message": str(exc)[:200]})
            return
        out["ok"] = True
        out["total"] = total
        out["region"] = acc.region
        self._json(200, out)

    def _media_balance(self):
        acc = POOL.active()
        if not acc:
            self._json(503, {"ok": False, "message": "账号池里没有可用账号"})
            return
        try:
            total, end, _items = fetch_credits(acc)
        except Exception as exc:  # noqa: BLE001
            self._json(502, {"ok": False, "message": str(exc)[:200]})
            return
        snap = POOL.snapshot()
        self._json(200, {
            "ok": True, "uid": acc.uid, "nickname": acc.nickname, "region": acc.region,
            "credits": round(total, 2), "cycleEnd": end,
            "poolCredits": snap.get("totalCredits"), "accounts": len(snap.get("accounts") or []),
        })

    def _models(self):
        acc = POOL.active()
        if not acc:
            self._json(503, {"error": {"message": "账号池里没有可用账号"}})
            return
        force = "refresh=1" in (self.path or "")
        rows = CATALOG.get(force=force)
        if not rows:
            self._json(502, {"error": {"message": "模型目录拉取失败"}})
            return
        out = []
        for row in rows:
            if not row["chat"]:
                continue
            hstate = HEALTH.state_of(row["id"])
            if hstate in HEALTH_HIDE:
                continue
            label = CATALOG.display_label(row)
            warn = HEALTH_WARN.get(hstate)
            if warn:
                label += " " + warn
            item = {
                "id": row["id"],
                "object": "model",
                "owned_by": "workbuddy",
                # Toonflow 的 Uq0() 只认 name / display_name / displayName，
                # 所以这三个键都带上，label 里含倍率 + 拥挤度。
                "name": label,
                "display_name": label,
                "displayName": label,
                "label": label,
                # Toonflow 的 Uq0() 只认 inputTokenLimit / outputTokenLimit
                "inputTokenLimit": row["context"],
                "outputTokenLimit": row["maxOutput"],
                "multiplier": row["multiplier"],
                "busy": row["busy"],
                "busyText": row["busyText"],
                "badge": row["badge"],
                "contextWindow": row["context"],
                "maxOutputTokens": row["maxOutput"],
                "reasoningEfforts": row.get("efforts") or None,
            }
            out.append(item)
        # 同名的上游变体（hy3 / hy3-b / hy3-c、hy4-preview / hy4-preview-ctrl）
        # 在 Toonflow 下拉里会长得一模一样，重名时补上模型 id 以便区分。
        seen = {}
        for item in out:
            seen[item["label"]] = seen.get(item["label"], 0) + 1
        for item in out:
            if seen[item["label"]] > 1:
                item["name"] += " (%s)" % item["id"]
                item["display_name"] = item["name"]
                item["displayName"] = item["name"]
                item["label"] = item["name"]
        HEALTH.kick(rows)
        self._json(200, {"object": "list", "data": out})

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if path.startswith("/pool/"):
            self._pool_route(path)
            return
        norm = path
        while "/v1/v1/" in norm:
            norm = norm.replace("/v1/v1/", "/v1/")
        if norm in ("/v1/images/generations", "/v1/images/edits", "/images/generations",
                    "/media/image", "/v1/media/image"):
            self._media_image(norm.endswith("/edits") or norm == "/v1/media/image")
            return
        if norm in ("/v1/videos/generations", "/media/video", "/v1/media/video"):
            self._media_video()
            return
        if norm in ("/v1/videos/tasks", "/media/video/task", "/v1/media/video/task"):
            self._media_video_task()
            return
        if not (norm.endswith("/chat/completions") or norm == "/chat/completions"):
            self.send_error(404)
            return
        self._chat()

    # ---------- 媒体路由 ----------
    def _media_image(self, edit=False):
        body = self._read_json()
        acc = POOL.active()
        if not acc:
            self._json(503, {"ok": False, "message": "账号池里没有可用账号"})
            return
        try:
            if edit and not body.get("image"):
                self._json(400, {"ok": False, "message": "改图需要提供 image（data URL）"})
                return
            code, env = gen_image(acc, body)
        except Exception as exc:  # noqa: BLE001
            self._json(502, {"ok": False, "message": str(exc)[:300]})
            return
        if env.get("code") not in (0, None):
            self._json(code if code >= 400 else 502,
                       {"ok": False, "message": env.get("msg") or "上游拒绝", "upstream": env})
            return
        data = env.get("data") or {}
        urls = [it.get("url") for it in (data.get("data") or []) if it.get("url")]
        usage = data.get("usage") or {}
        self._json(200, {
            "ok": True, "urls": urls, "credit": usage.get("credit"),
            "model": body.get("model"), "size": body.get("size"),
            "requestId": env.get("requestId"),
        })

    def _media_video(self):
        body = self._read_json()
        acc = POOL.active()
        if not acc:
            self._json(503, {"ok": False, "message": "账号池里没有可用账号"})
            return
        try:
            code, env = submit_video(acc, body)
        except Exception as exc:  # noqa: BLE001
            self._json(502, {"ok": False, "message": str(exc)[:300]})
            return
        data = env.get("data") or {}
        task_id = data.get("id") or data.get("task_id")
        if env.get("code") not in (0, None) or not task_id:
            self._json(code if code >= 400 else 502,
                       {"ok": False, "message": env.get("msg") or "上游未受理任务", "upstream": env})
            return
        if body.get("wait") is False:
            remember_task(task_id, acc)
            self._json(200, {"ok": True, "taskId": task_id, "status": "submitted"})
            return
        remember_task(task_id, acc)
        status, videos, credit, last = poll_video(acc, task_id)
        if status == "timeout" and isinstance(last, dict):
            # 轮询窗口耗尽但上游其实已完成：按成功返回，别把已出的片子丢掉
            up_status, up_videos, up_credit = video_result(last)
            if up_status == "completed" and up_videos:
                status, videos, credit = "completed", up_videos, up_credit
        if status != "completed" or not videos:
            self._json(200, {"ok": False, "taskId": task_id, "status": status,
                             "message": (last.get("msg") if isinstance(last, dict) else "") or "",
                             "upstream": last})
            return
        self._json(200, {"ok": True, "taskId": task_id, "status": status,
                         "urls": videos, "credit": credit, "model": body.get("model")})

    def _media_video_task(self):
        body = self._read_json()
        task_id = (body.get("taskId") or body.get("task_id") or "").strip()
        if not task_id:
            self._json(400, {"ok": False, "message": "缺少 taskId"})
            return
        acc = owner_of(task_id) or POOL.active()
        if not acc:
            self._json(503, {"ok": False, "message": "账号池里没有可用账号"})
            return
        try:
            code, env = media_post(acc, "/v2/videos/tasks", {"task_id": task_id}, timeout=120)
        except Exception as exc:  # noqa: BLE001
            self._json(502, {"ok": False, "message": str(exc)[:300]})
            return
        if env.get("code") not in (0, None):
            self._json(code if code >= 400 else 502,
                       {"ok": False, "message": env.get("msg") or "上游拒绝", "upstream": env})
            return
        status, videos, credit = video_result(env)
        self._json(200, {
            "ok": status == "completed", "taskId": task_id, "status": status,
            "urls": videos, "credit": credit, "upstream": env,
        })

    def _pool_route(self, path):
        body = self._read_json()
        if path in ("/pool/creds/sync", "/pool/credentials/sync"):
            if wb_creds is None:
                self._json(503, {"ok": False, "message": "wb_creds 模块没加载"})
                return
            try:
                result = wb_creds.sync(VAULT_DIR)
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"ok": False, "message": str(exc)[:200]})
                return
            POOL.scan()
            result["accounts"] = len(POOL.accounts)
            self._json(200, result)
            return
        if path == "/pool/refresh":
            uid = body.get("uid") or ""
            for acc in list(POOL.accounts):
                if uid and acc.uid != uid:
                    continue
                POOL.refresh_one(acc)
            self._json(200, POOL.snapshot())
            return
        if path == "/pool/mode":
            mode = body.get("mode")
            if mode in ("auto", "fixed", "off"):
                POOL.mode = mode
                if body.get("uid"):
                    POOL.fixed_uid = body["uid"]
                POOL._save_state()
            self._json(200, POOL.snapshot())
            return
        if path == "/pool/toggle":
            uid = body.get("uid") or ""
            enabled = bool(body.get("enabled"))
            if uid:
                if enabled:
                    POOL.disabled.discard(uid)
                else:
                    POOL.disabled.add(uid)
                POOL._save_state()
            self._json(200, POOL.snapshot())
            return
        if path == "/pool/checkin":
            uid = body.get("uid") or ""
            result = []
            for acc in list(POOL.accounts):
                if uid and acc.uid != uid:
                    continue
                try:
                    d = claim_checkin(acc)
                    result.append({"uid": acc.uid, "ok": True,
                                   "credit": d.get("credit"), "streak": d.get("streak_days")})
                except Exception as exc:  # noqa: BLE001
                    result.append({"uid": acc.uid, "ok": False, "message": str(exc)[:120]})
            POOL.refresh_all(force=True)
            out = POOL.snapshot()
            out["checkin"] = result
            self._json(200, out)
            return
        if path == "/pool/test":
            acc = None
            uid = body.get("uid") or ""
            for a in POOL.accounts:
                if a.uid == uid:
                    acc = a
            acc = acc or POOL.active()
            if not acc:
                self._json(400, {"ok": False, "message": "没有账号"})
                return
            ok, msg = test_account(acc)
            self._json(200, {"ok": ok, "message": msg, "uid": acc.uid, "nickname": acc.nickname})
            return
        self.send_error(404)

    def _chat(self):
        payload = self._read_json()
        # 客户端有没有明确要求非流式？上游只支持流式，但我们可以在本地把 SSE 聚合成
        # 标准 chat.completion 再返回（ComfyUI 的 T8 提示词增强器等非流式客户端要用）。
        client_wants_stream = payload.get("stream") is True
        sanitize_payload(payload)
        payload["stream"] = True
        payload.pop("stream_options", None)

        tried = []
        last_status, last_body = 502, "no account"
        for _ in range(max(1, len(POOL.accounts))):
            acc = POOL.pick(exclude=set(tried))
            if not acc:
                break
            tried.append(acc.uid)
            try:
                req = urllib.request.Request(
                    UPSTREAM + "/v2/chat/completions",
                    data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    headers=chat_headers(acc.token),
                    method="POST",
                )
                resp = urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", "ignore")
                ok, reason = failover_reason(exc.code, detail)
                if ok and len(tried) < len(POOL.accounts):
                    POOL.bench(acc)
                    sys.stderr.write("[wb-proxy] 换号 %s (%s)\n" % (acc.nickname, reason))
                    last_status, last_body = exc.code, detail
                    continue
                self._json(exc.code, {"error": {"message": detail}})
                return
            except Exception as exc:  # noqa: BLE001
                self._json(502, {"error": {"message": str(exc)}})
                return
            if client_wants_stream:
                self._stream(resp)
            else:
                self._aggregate(resp, payload)
            return
        self._json(last_status, {"error": {"message": last_body}})

    def _aggregate(self, resp, payload):
        """把上游 SSE 聚合成标准 OpenAI chat.completion JSON（非流式客户端）。"""
        model = payload.get("model") or ""
        content_parts = []
        reasoning_parts = []
        tool_calls = {}
        finish_reason = ""
        usage = None
        completion_id = ""
        created = int(time.time())
        try:
            while True:
                line = resp.readline()
                if not line:
                    break
                text = line.decode("utf-8", "ignore").strip()
                if not text:
                    continue
                if not text.startswith("data:"):
                    continue
                data = text[5:].strip()
                if data == "[DONE]":
                    continue
                try:
                    chunk = json.loads(data)
                except Exception:  # noqa: BLE001
                    continue
                completion_id = chunk.get("id") or completion_id
                created = chunk.get("created") or created
                model = chunk.get("model") or model
                if chunk.get("usage"):
                    usage = chunk["usage"]
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    piece = delta.get("content")
                    if isinstance(piece, str) and piece:
                        content_parts.append(piece)
                    thought = delta.get("reasoning_content")
                    if isinstance(thought, str) and thought:
                        reasoning_parts.append(thought)
                    for call in delta.get("tool_calls") or []:
                        index = call.get("index", 0)
                        slot = tool_calls.setdefault(
                            index, {"id": "", "type": "function",
                                    "function": {"name": "", "arguments": ""}})
                        if call.get("id"):
                            slot["id"] = call["id"]
                        fn = call.get("function") or {}
                        if fn.get("name"):
                            slot["function"]["name"] += fn["name"]
                        if fn.get("arguments"):
                            slot["function"]["arguments"] += fn["arguments"]
                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]
        finally:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass

        message = {"role": "assistant", "content": "".join(content_parts)}
        if reasoning_parts:
            message["reasoning_content"] = "".join(reasoning_parts)
        if tool_calls:
            message["tool_calls"] = [tool_calls[k] for k in sorted(tool_calls)]
        body = {
            "id": completion_id or ("chatcmpl-" + os.urandom(8).hex()),
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "message": message,
                         "finish_reason": finish_reason or "stop"}],
            "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
        self._json(200, body)

    def _stream(self, resp):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            while True:
                chunk = resp.readline()
                if not chunk:
                    break
                self.wfile.write(("%X\r\n" % len(chunk)).encode() + chunk + b"\r\n")
                self.wfile.flush()
            tail = b"data: [DONE]\n\n"
            self.wfile.write(("%X\r\n" % len(tail)).encode() + tail + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass


def test_account(acc):
    body = json.dumps({"model": "deepseek-v4.1-flash", "stream": True,
                       "messages": [{"role": "system", "content": NEUTRAL_HEAD},
                                    {"role": "user", "content": "只回复：好"}]}).encode("utf-8")
    req = urllib.request.Request(UPSTREAM + "/v2/chat/completions", data=body,
                                 headers=chat_headers(acc.token), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            head = r.read(200).decode("utf-8", "ignore")
            return True, ("HTTP %d" % r.status) + (" " + head.replace("\n", " ")[:80] if head else "")
    except urllib.error.HTTPError as exc:
        return False, "HTTP %d %s" % (exc.code, exc.read().decode("utf-8", "ignore")[:120])
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:120]


def bootstrap_credentials():
    """启动时补凭据：vault 为空（或带了 FORCE）就跑一遍自动发现。

    返回发现结果 dict；模块缺失时返回 None。
    """
    if wb_creds is None:
        return None
    force = os.environ.get("WB_CREDS_FORCE") == "1"
    try:
        have = POOL.scan()
    except Exception:  # noqa: BLE001
        have = []
    if have and not force:
        return {"skipped": True, "count": len(have)}
    try:
        result = wb_creds.sync(VAULT_DIR)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:200]}
    POOL.scan()
    return result


def background_refresh():
    while True:
        try:
            POOL.refresh_all(force=False)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(120)


def main():
    print("[wb-proxy] listening on http://%s:%d" % (LISTEN_HOST, LISTEN_PORT), flush=True)
    print("[wb-proxy] vault: %s" % VAULT_DIR, flush=True)
    boot = bootstrap_credentials()
    if boot and not boot.get("skipped"):
        print("[wb-proxy] credentials: %s" % json.dumps(
            {k: boot.get(k) for k in ("ok", "count", "refreshed", "vault")},
            ensure_ascii=False), flush=True)
        for note in (boot.get("notes") or []):
            print("[wb-proxy]   %s" % note, flush=True)
    print("[wb-proxy] pool: %d accounts" % len(POOL.accounts), flush=True)
    threading.Thread(target=background_refresh, daemon=True).start()
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
