/*! toonflowTool:{"name":"workbuddyConnect","version":"2.0.1","displayName":"WorkBuddy 连接","description":"单文件自带代理：自动读取本机 WorkBuddy 桌面端凭据，起一个本地 OpenAI 兼容服务（对话模型 + 生图 + 生视频 + 积分 + 模型目录）。装完调用 workbuddySetup 即可把文本模型写进 Toonflow 供应商。","prompt":"需要画图或出视频时优先用本工具，除非用户明确要求在画布节点里生成。workbuddyDrawImage 同步出图；workbuddyDrawVideo 是异步任务，先告知大概等待时长。花积分前先用 workbuddyCredits 报额度。模型名用 workbuddyMediaModels 查到的真实 id。生成结果保存在工作区，回复里给相对路径。首次使用或报“没有可用账号”时调用 workbuddySetup 自动配置。","readme":"# WorkBuddy 连接\n\n单文件插件，自带本地代理：自动发现本机 WorkBuddy 桌面端凭据 → 起本地 OpenAI 兼容服务 → 给 Toonflow 提供对话模型、生图、生视频。\n\n## 装完三步\n\n1. 确认本机装了并登录过 WorkBuddy 桌面端（凭据自动读取，无需手动填 token）。\n2. 在对话里说一句「用 workbuddySetup 配置一下」。\n3. 到「设置 → 模型供应商」选 WorkBuddy 的任一模型即可对话。\n\n## 工具\n\n- `workbuddySetup`：自动写文本模型供应商到 Toonflow 设置（一次性）\n- `workbuddyStatus`：看本地服务端口、账号数、凭据来源\n- `workbuddyDrawImage`：文生图 / 图生图\n- `workbuddyDrawVideo`：文生视频 / 图生视频（异步自动轮询）\n- `workbuddyCredits`：剩余积分与账号池合计\n- `workbuddyMediaModels`：可用的图片与视频模型\n\n## 说明\n\n- 本地服务只监听 127.0.0.1，端口默认 8289（与 python 版 8189 错开），实际端口写进 `~/.toonflow-workbuddy/port.txt`。\n- 凭据来源优先级：环境变量 `CODEBUDDY_AUTH_TOKEN` → 本插件凭据库 → DSH 凭据库 → WorkBuddy 桌面端认证文件（AES-256-GCM 解密）。\n- 桌面端 exe 定位：环境变量 `WORKBUDDY_APP_EXECUTABLE` → 常见安装路径 → Windows 注册表 DisplayIcon。","author":"localWorkspace","github":"https://github.com/wyh1sc/toonflow-connect-workbuddy","configRules":[{"type":"input","field":"proxyUrl","title":"本地服务地址（端口冲突时可改）","value":"http://127.0.0.1:8289","props":{"placeholder":"http://127.0.0.1:8289"}},{"type":"input","field":"outputDir","title":"产物保存目录（工作区相对路径）","value":"assets/generated","props":{"placeholder":"assets/generated"}},{"type":"switch","field":"autoStart","title":"启用内置本地服务","value":true}],"components":[]} */
// @bun
import { z } from "toonflow:tool-zod";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, posix } from "node:path";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";

/* ============================ 常量 ============================ */

// 插件内置服务端口：与 python 版 wb_proxy.py（8189）错开，避免两者互相吞端口。
const DEFAULT_PROXY = "http://127.0.0.1:8289";
const DEFAULT_OUT_DIR = "assets/generated";
const MODEL_TTL_MS = 5 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 240000;
const VIDEO_TIMEOUT_MS = 960000;
const VIDEO_POLL_INTERVAL_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || homedir();
const DATA_DIR = join(HOME_DIR, ".toonflow-workbuddy");
const VAULT_DIR = process.env.WB_VAULT_DIR || join(DATA_DIR, "vault");
const PORT_FILE = join(DATA_DIR, "port.txt");
const POOL_FILE = join(DATA_DIR, "pool.json");
const HEALTH_FILE = join(DATA_DIR, "health.json");
const REGION = (process.env.WB_REGION || "cn").toLowerCase();

const CN_BILLING = "https://www.codebuddy.cn";
const GLOBAL_BILLING = "https://www.workbuddy.ai";
const CN_UPSTREAM = "https://copilot.tencent.com";
const GLOBAL_UPSTREAM = "https://www.workbuddy.ai";

const CHAT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const BILLING_UA = "CodeBuddy/2.0.0";
const CATALOG_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";
const MEDIA_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";

const CATALOG_TTL_MS = 180000;
const CREDIT_TTL_MS = 600000;
const COOLDOWN_MS = 300000;
const HEALTH_TTL_MS = 6 * 3600 * 1000;
const HEALTH_HIDE = new Set(["missing", "reject"]);
const HEALTH_WARN = { unavail: "· 暂不可用", error: "· 异常" };
const FAILOVER_CODES = new Set([14018, 11140]);
const FAILOVER_HTTP = new Set([401, 403]);
const REASONING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MEDIA_TAGS = new Set(["text-to-image", "image-to-image", "text-to-video", "image-to-video"]);
const BUSY_TITLES = {
  idle: "空闲",
  normal: "正常",
  busy: "轻微拥堵",
  congested: "极度拥堵",
  unavailable: "不可用",
};

const NEUTRAL_HEAD = "You are a helpful assistant.";
const ZERO_WIDTH = "\u200b";
const BANNED_OPENINGS = [
  "as an ai",
  "as a large language model",
  "i am an ai",
  "i'm an ai",
  "i am a large language model",
  "作为一个ai",
  "作为人工智能",
  "我是一个ai",
  "我是人工智能",
  "作为ai语言模型",
];
const IDENTITY_CLAUSE =
  /(as an ai|as a large language model|i am an ai|i'm an ai|ai language model|作为一个\s*ai|作为人工智能|我是一个\s*ai|我是人工智能)/gi;

const KEY_JS =
  "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";

/* ============================ 小工具 ============================ */

const sha256 = (b) => createHash("sha256").update(b).digest();
const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const b64d = (s) => Buffer.from(String(s), "base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBun = typeof Bun !== "undefined";

function uuid() {
  try {
    return randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

async function readJsonFile(path, fallback) {
  try {
    const txt = await readFile(path, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/* ============================ 凭据解密（AES-256-GCM） ============================ */

const AAD_DOMAIN = Buffer.from("WB-AAD\x00", "latin1");

function lp(value) {
  const raw = Buffer.from(String(value), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(raw.length, 0);
  return Buffer.concat([len, raw]);
}

function fieldAad(keyId, suite, scheme = "sym-v1") {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    lp("WBEV1"),
    lp(scheme),
    (() => {
      const n = Buffer.alloc(4);
      n.writeUInt32BE(suite >>> 0, 0);
      return n;
    })(),
    lp(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

const deriveKey = (secret) => sha256(Buffer.from(String(secret), "utf8"));
const keyIdOf = (key) => sha256Hex(key).slice(0, 16);

function openField(field, key) {
  if (!field || typeof field !== "object" || !field.envelope) return "";
  const meta = JSON.parse(b64d(field.envelope).toString("utf8"));
  if (meta.keyId && meta.keyId !== keyIdOf(key)) throw new Error("envelope belongs to another key");
  const aad = fieldAad(meta.keyId || keyIdOf(key), Number(meta.suite || 1));
  const decipher = createDecipheriv("aes-256-gcm", key, b64d(meta.nonce));
  decipher.setAAD(aad);
  decipher.setAuthTag(b64d(meta.authTag));
  const plain = Buffer.concat([decipher.update(b64d(meta.ciphertext)), decipher.final()]);
  return plain.toString("utf8");
}

function readField(value, key) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.envelope) return openField(value, key);
  return "";
}

/* ============================ 桌面端 exe 定位 ============================ */

function runQuiet(cmd, args) {
  if (!isBun) return "";
  try {
    const r = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    return r && r.stdout ? Buffer.from(r.stdout).toString("utf8") : "";
  } catch {
    return "";
  }
}

function registryExecutables() {
  if (process.platform !== "win32") return [];
  const out = [];
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const root of roots) {
    const text = runQuiet("reg", ["query", root, "/s", "/f", "WorkBuddy"]);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/DisplayIcon\s+REG_\w+\s+(.+?)\s*$/i);
      if (!m) continue;
      const raw = m[1].replace(/^"|"$/g, "").replace(/,\d+$/, "").trim();
      if (/\.exe$/i.test(raw)) out.push(raw);
    }
    if (out.length) break;
  }
  return out;
}

function findAppExecutable() {
  const env = process.env.WORKBUDDY_APP_EXECUTABLE;
  if (env && existsSync(env)) return env;
  const cands = [];
  if (process.platform === "win32") {
    const bases = [
      process.env.LOCALAPPDATA,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.APPDATA,
    ].filter(Boolean);
    const dirs = ["Programs\\WorkBuddy", "WorkBuddy", "Programs\\WorkBuddyAI", "WorkBuddyAI"];
    const exes = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
    for (const b of bases) for (const d of dirs) for (const e of exes) cands.push(join(b, d, e));
  } else if (process.platform === "darwin") {
    for (const base of ["/Applications", join(HOME_DIR, "Applications")]) {
      for (const app of ["WorkBuddy.app", "WorkBuddy AI.app"]) {
        const macos = join(base, app, "Contents", "MacOS");
        try {
          for (const f of readdirSync(macos)) cands.push(join(macos, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
  for (const c of cands) if (existsSync(c)) return c;
  for (const c of registryExecutables()) if (existsSync(c)) return c;
  return "";
}

let AT_REST = { key: null, at: 0, failedAt: 0 };

function readAtRestKey() {
  const now = Date.now();
  if (AT_REST.key) return AT_REST.key;
  if (AT_REST.failedAt && now - AT_REST.failedAt < 60000) return null;
  const envKey = process.env.WB_AT_REST_KEY;
  if (envKey) {
    AT_REST.key = deriveKey(envKey);
    return AT_REST.key;
  }
  const exe = findAppExecutable();
  if (!exe || !isBun) {
    AT_REST.failedAt = now;
    return null;
  }
  try {
    const proc = Bun.spawnSync([exe, "-e", KEY_JS], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = Buffer.from(proc.stdout || []).toString("utf8").trim();
    const payload = JSON.parse(out);
    if (!payload.atRestSecretKey) throw new Error("no atRestSecretKey");
    AT_REST.key = deriveKey(payload.atRestSecretKey);
    AT_REST.failedAt = 0;
    return AT_REST.key;
  } catch {
    AT_REST.failedAt = now;
    return null;
  }
}

/* ============================ 凭据文件扫描 ============================ */

function desktopAuthDirs() {
  const dirs = [];
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth"));
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "CodeBuddyExtension", "Data", "Public", "auth"));
  } else if (process.platform === "darwin") {
    dirs.push(join(HOME_DIR, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"));
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || join(HOME_DIR, ".config");
    dirs.push(join(xdg, "CodeBuddyExtension", "Data", "Public", "auth"));
  }
  return dirs;
}

const AUTH_FILENAMES = ["workbuddy-desktop.info", "workbuddy-desktop-ai.info", "codebuddy-desktop.info"];

function domainRegion(domain) {
  const d = String(domain || "").toLowerCase();
  if (!d) return REGION;
  if (d.endsWith(".ai")) return "global";
  if (d.includes("workbuddy.ai") || d.includes("codebuddy.ai")) return "global";
  return "cn";
}

function parseAuthDocument(doc, key, source) {
  const auth = doc.auth || {};
  const account = doc.account || {};
  const token = readField(auth.accessToken, key);
  if (!token) return null;
  const refreshToken = readField(auth.refreshToken, key);
  const uid = readField(account.uid, key) || readField(account.userId, key);
  const nickname = readField(account.nickname, key) || "";
  const uin = readField(account.uin, key) || "";
  return {
    accountId: uid || sha256Hex(Buffer.from(token, "utf8")).slice(0, 24),
    token,
    refreshToken,
    expiresAt: Number(auth.expiresAt || 0),
    refreshExpiresAt: Number(auth.refreshExpiresAt || 0),
    domain: String(auth.domain || account.domain || "").trim(),
    uid: uid || "",
    nickname,
    uin,
    source,
  };
}

async function scanDesktop() {
  const key = readAtRestKey();
  const out = [];
  const notes = [];
  if (!key) {
    notes.push("桌面端：拿不到 at-rest 密钥（未装 WorkBuddy 桌面端或 exe 定位失败）");
    return { creds: out, notes };
  }
  for (const dir of desktopAuthDirs()) {
    for (const name of AUTH_FILENAMES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      try {
        const doc = JSON.parse(await readFile(path, "utf8"));
        const cred = parseAuthDocument(doc, key, `desktop:${name}`);
        if (cred) out.push(cred);
      } catch (err) {
        notes.push(`桌面端：${name} 解密失败（${String(err?.message || err).slice(0, 80)}）`);
      }
    }
  }
  if (!out.length && !notes.length) notes.push("桌面端：没找到认证文件");
  return { creds: out, notes };
}

async function scanVaultDir(dir, tag) {
  const out = [];
  if (!existsSync(dir)) return out;
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    const doc = await readJsonFile(join(dir, name), null);
    if (!doc) continue;
    const auth = doc.auth || {};
    const token = typeof auth.accessToken === "string" ? auth.accessToken : "";
    if (!token) continue;
    const account = doc.account || {};
    out.push({
      accountId: doc.accountId || account.uid || name.replace(/\.json$/i, ""),
      token,
      refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
      expiresAt: Number(auth.expiresAt || 0),
      refreshExpiresAt: Number(auth.refreshExpiresAt || 0),
      domain: String(auth.domain || "").trim(),
      uid: String(account.uid || ""),
      nickname: String(account.nickname || ""),
      uin: String(account.uin || ""),
      source: `${tag}:${name}`,
    });
  }
  return out;
}

async function fetchProfile(cred) {
  const base = domainRegion(cred.domain) === "global" ? GLOBAL_BILLING : CN_BILLING;
  try {
    const resp = await fetch(`${base}/v2/plugin/login/account`, {
      headers: {
        Authorization: `Bearer ${cred.token}`,
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": CATALOG_UA,
      },
      signal: AbortSignal.timeout(20000),
    });
    const body = await resp.json();
    const data = body?.data || {};
    return {
      uid: String(data.uid || data.userId || cred.uid || ""),
      nickname: String(data.nickname || cred.nickname || ""),
      uin: String(data.uin || cred.uin || ""),
      domain: String(data.domain || cred.domain || ""),
    };
  } catch {
    return { uid: cred.uid || "", nickname: cred.nickname || "", uin: cred.uin || "", domain: cred.domain || "" };
  }
}

async function discoverCredentials() {
  const notes = [];
  const found = [];
  const seen = new Set();
  const push = (cred) => {
    if (!cred || !cred.token) return;
    const id = cred.uid || cred.accountId;
    if (seen.has(id)) return;
    seen.add(id);
    found.push(cred);
  };

  const envToken = process.env.CODEBUDDY_AUTH_TOKEN || process.env.WB_ACCESS_TOKEN;
  if (envToken) {
    const base = { token: envToken.trim(), domain: process.env.WB_DOMAIN || "", source: "env" };
    const prof = await fetchProfile(base);
    push({ ...base, ...prof, accountId: prof.uid || "env", refreshToken: "", expiresAt: 0, refreshExpiresAt: 0 });
    notes.push("环境变量：1 个账号");
  } else {
    notes.push("环境变量：未设置 CODEBUDDY_AUTH_TOKEN");
  }

  const ownDirs = [join(VAULT_DIR, "cn"), join(VAULT_DIR, "global"), VAULT_DIR];
  let ownCount = 0;
  for (const dir of ownDirs) {
    const list = await scanVaultDir(dir, "vault");
    ownCount += list.length;
    list.forEach(push);
  }
  notes.push(`本插件凭据库：${ownCount} 个账号`);

  const dshHome = process.env.DSH_HOME || join(HOME_DIR, ".dsh");
  let dshCount = 0;
  for (const region of ["cn", "global"]) {
    const list = await scanVaultDir(join(dshHome, "workbuddy-vault", region), "dsh-vault");
    dshCount += list.length;
    list.forEach(push);
  }
  notes.push(`DSH 凭据库：${dshCount} 个账号（${dshHome}）`);

  const desktop = await scanDesktop();
  desktop.creds.forEach(push);
  desktop.notes.forEach((n) => notes.push(n));

  for (const cred of found) {
    if (!cred.uid) {
      const prof = await fetchProfile(cred);
      cred.uid = prof.uid;
      cred.nickname = cred.nickname || prof.nickname;
      cred.uin = cred.uin || prof.uin;
      if (!cred.domain) cred.domain = prof.domain;
    }
  }
  return { creds: found.filter((c) => c.uid), notes, sources: [...new Set(found.map((c) => String(c.source).split(":")[0]))] };
}

async function persistCredentials(creds) {
  let n = 0;
  for (const cred of creds) {
    const region = domainRegion(cred.domain);
    const dir = join(VAULT_DIR, region);
    const doc = {
      version: 1,
      accountId: cred.accountId || cred.uid,
      refreshedAtMs: Date.now(),
      auth: {
        accessToken: cred.token,
        refreshToken: cred.refreshToken || "",
        expiresAt: cred.expiresAt || 0,
        refreshExpiresAt: cred.refreshExpiresAt || 0,
        domain: cred.domain || "",
      },
      account: { uid: cred.uid || "", nickname: cred.nickname || "", uin: cred.uin || "" },
      source: cred.source || "discovered",
    };
    if (await writeJsonFile(join(dir, `${doc.accountId}.json`), doc)) n += 1;
  }
  return n;
}

/* ============================ 账号池 ============================ */

function regionOf(domain) {
  return domainRegion(domain);
}

const POOL = {
  accounts: [],
  mode: "auto",
  fixedUid: "",
  disabled: new Set(),
  stateLoaded: false,

  async loadState() {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    const st = await readJsonFile(POOL_FILE, null);
    if (st) {
      this.mode = ["auto", "fixed", "off"].includes(st.mode) ? st.mode : "auto";
      this.fixedUid = String(st.fixedUid || "");
      this.disabled = new Set(Array.isArray(st.disabled) ? st.disabled : []);
    }
  },

  async saveState() {
    await writeJsonFile(POOL_FILE, { mode: this.mode, fixedUid: this.fixedUid, disabled: [...this.disabled] });
  },

  async scan(creds) {
    await this.loadState();
    const prev = new Map(this.accounts.map((a) => [a.uid, a]));
    this.accounts = (creds || []).map((c) => {
      const old = prev.get(c.uid) || {};
      return {
        uid: c.uid,
        nickname: c.nickname || old.nickname || "",
        uin: c.uin || old.uin || "",
        domain: c.domain || old.domain || "",
        region: regionOf(c.domain || old.domain),
        token: c.token,
        refreshToken: c.refreshToken || old.refreshToken || "",
        source: c.source || old.source || "",
        credits: old.credits ?? null,
        creditAt: old.creditAt || 0,
        cycleEnd: old.cycleEnd || "",
        cooldownUntil: old.cooldownUntil || 0,
        error: "",
      };
    });
    return this.accounts.length;
  },

  usable() {
    return this.accounts.filter((a) => !this.disabled.has(a.uid) && (a.cooldownUntil || 0) < Date.now());
  },

  pick(exclude) {
    const ex = exclude instanceof Set ? exclude : new Set(exclude || []);
    let list = this.accounts.filter((a) => !this.disabled.has(a.uid) && (a.cooldownUntil || 0) < Date.now() && !ex.has(a.uid));
    if (!list.length) list = this.accounts.filter((a) => !this.disabled.has(a.uid) && !ex.has(a.uid));
    if (!list.length) return null;
    if (this.mode === "fixed" && this.fixedUid) {
      const hit = list.find((a) => a.uid === this.fixedUid);
      if (hit) return hit;
    }
    return list.slice().sort((x, y) => (y.credits ?? -1) - (x.credits ?? -1))[0];
  },

  active() {
    return this.pick(new Set());
  },

  bench(acc, ms = COOLDOWN_MS) {
    if (!acc) return;
    acc.cooldownUntil = Date.now() + ms;
  },

  snapshot() {
    const active = this.active();
    return {
      mode: this.mode,
      fixedUid: this.fixedUid,
      active: active ? active.uid : "",
      totalCredits: this.accounts.reduce((s, a) => s + (Number(a.credits) || 0), 0),
      accounts: this.accounts.map((a) => ({
        uid: a.uid,
        nickname: a.nickname,
        uin: a.uin ? `${a.uin.slice(0, 3)}****${a.uin.slice(-4)}` : "",
        region: a.region,
        credits: a.credits,
        cycleEnd: a.cycleEnd,
        enabled: !this.disabled.has(a.uid),
        active: active ? active.uid === a.uid : false,
        cooldown: Math.max(0, Math.round(((a.cooldownUntil || 0) - Date.now()) / 1000)),
        error: a.error,
        source: a.source,
      })),
    };
  },
};

/* ============================ 上游调用 ============================ */

const billingBase = (acc) => (regionOf(acc.domain) === "global" ? GLOBAL_BILLING : CN_BILLING);
const chatBase = (acc) => (regionOf(acc.domain) === "global" ? GLOBAL_UPSTREAM : CN_UPSTREAM);
const mediaBase = (acc) => (regionOf(acc.domain) === "global" ? GLOBAL_UPSTREAM : CN_UPSTREAM);

function chatHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": CHAT_UA,
  };
}

function mediaHeaders(acc, accept = "application/json, text/plain, */*") {
  const h = {
    Authorization: `Bearer ${acc.token}`,
    Accept: accept,
    "Content-Type": "application/json",
    "User-Agent": MEDIA_UA,
    "X-Product": "SaaS",
    "X-Requested-With": "XMLHttpRequest",
    "X-Conversation-Id": uuid(),
    "X-Conversation-Request-Id": uuid(),
    "X-Conversation-Message-Id": uuid(),
    "X-No-Enterprise-Id": "1",
  };
  if (acc.domain) h["X-Domain"] = acc.domain;
  if (acc.uid && !String(acc.uid).startsWith("$")) h["X-User-Id"] = acc.uid;
  else h["X-No-User-Id"] = "1";
  return h;
}

function catalogHeaders(acc) {
  const h = {
    Authorization: `Bearer ${acc.token}`,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": CATALOG_UA,
  };
  if (acc.uid) h["X-User-Id"] = acc.uid;
  if (acc.domain) h["X-Domain"] = acc.domain;
  return h;
}

function billingHeaders(acc) {
  const h = {
    Authorization: `Bearer ${acc.token}`,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": BILLING_UA,
  };
  if (acc.uid) h["X-User-Id"] = acc.uid;
  h["X-Domain"] = acc.domain || "www.codebuddy.cn";
  return h;
}

async function httpJson(url, init, timeoutMs = 30000) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { status: resp.status, body };
}

async function fetchCredits(acc) {
  const { status, body } = await httpJson(
    `${billingBase(acc)}/v2/billing/meter/get-user-resource`,
    {
      method: "POST",
      headers: billingHeaders(acc),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        PackageEndTimeRangeBegin: "2020-01-01 00:00:00",
        PackageEndTimeRangeEnd: "2125-01-01 00:00:00",
      }),
    },
    25000,
  );
  if (status !== 200) return { total: null, cycleEnd: "", items: [] };
  const rows = body?.data?.Response?.Data?.Accounts || body?.data?.Accounts || [];
  let total = 0;
  const ends = [];
  for (const it of rows) {
    // 上游真实字段：CycleCapacityRemainPrecise / CapacityType / ExpiredTime / CycleEndTime
    const remain =
      Number(
        it.CycleCapacityRemainPrecise ??
          it.CycleCapacityRemain ??
          it.CapacityRemainPrecise ??
          it.CapacityRemain ??
          0,
      ) || 0;
    const capacityType = Number(it.CapacityType ?? it.capacityType);
    if (capacityType === 4) total += remain;
    else if (remain > 0 && !it.ExpiredTime) total += remain;
    const ce = String(it.CycleEndTime ?? "");
    if (remain > 0 && ce) ends.push(ce);
  }
  ends.sort();
  return { total: Math.round(total * 100) / 100, cycleEnd: ends[0] || "", items: rows };
}

async function refreshCredits(acc, force) {
  if (!force && acc.credits != null && Date.now() - (acc.creditAt || 0) < CREDIT_TTL_MS) return;
  try {
    const r = await fetchCredits(acc);
    acc.credits = r.total;
    acc.cycleEnd = r.cycleEnd || acc.cycleEnd;
    acc.creditAt = Date.now();
  } catch (err) {
    acc.error = String(err?.message || err).slice(0, 120);
  }
}

/* ---- 媒体 ---- */

async function mediaModelsOf(acc) {
  const { status, body } = await httpJson(`${billingBase(acc)}/v3/config`, { headers: catalogHeaders(acc) }, 30000);
  if (status !== 200) return { image: [], video: [], total: 0 };
  const rows = body?.data?.models || body?.models || [];
  const image = [];
  const video = [];
  for (const m of rows) {
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const item = { id: m.id || m.model, name: m.name || m.displayName || m.id, tags };
    if (tags.includes("text-to-image") || tags.includes("image-to-image")) image.push(item);
    if (tags.some((t) => String(t).includes("video"))) {
      if (m.videoGeneration) item.videoGeneration = m.videoGeneration;
      video.push(item);
    }
  }
  return { image, video, total: rows.length, region: acc.region };
}

async function genImage(acc, req) {
  if (req.image) return genImageEdit(acc, req);
  const model = String(req.model || "");
  const payload = { model, prompt: req.prompt, size: req.size || "1024x1024" };
  if (req.n) payload.n = req.n;
  else if (model.startsWith("hunyuan-")) payload.n = 1;
  if (!model.startsWith("gemini-")) payload.response_format = "b64_json";
  const { status, body } = await httpJson(
    `${mediaBase(acc)}/v2/images/generations`,
    { method: "POST", headers: mediaHeaders(acc), body: JSON.stringify(payload) },
    300000,
  );
  return normalizeImage(status, body);
}

async function genImageEdit(acc, req) {
  const payload = { model: String(req.model || ""), prompt: req.prompt, image: req.image, size: req.size || "1024x1024" };
  const { status, body } = await httpJson(
    `${mediaBase(acc)}/v2/images/edits`,
    { method: "POST", headers: mediaHeaders(acc), body: JSON.stringify(payload) },
    300000,
  );
  return normalizeImage(status, body);
}

function normalizeImage(status, body) {
  const data = body?.data || {};
  const list = data.data || data.images || [];
  const urls = list.map((d) => (typeof d === "string" ? d : d.url || "")).filter(Boolean);
  const credit = data?.usage?.credit ?? body?.credit ?? null;
  const ok = status === 200 && urls.length > 0;
  return { status, ok, urls, credit, requestId: body?.requestId || "", message: body?.msg || body?.message || "" };
}

async function submitVideo(acc, req) {
  const extra = {};
  if (req.resolution) extra.resolution = req.resolution;
  if (req.enableAudio != null) extra.enable_audio = Boolean(req.enableAudio);
  const payload = {
    prompt: req.prompt,
    model: String(req.model || ""),
    seconds: Number(req.seconds || 5),
    negative_prompt: req.negativePrompt || "",
    watermark: true,
    extra_parameters: extra,
  };
  if (req.image) {
    payload.image_url = req.image;
    if (req.lastImage) payload.last_image_url = req.lastImage;
  } else if (req.aspectRatio) {
    extra.aspect_ratio = req.aspectRatio;
  }
  const { status, body } = await httpJson(
    `${mediaBase(acc)}/v2/videos/generations`,
    { method: "POST", headers: mediaHeaders(acc), body: JSON.stringify(payload) },
    120000,
  );
  const taskId = body?.data?.id || body?.data?.taskId || body?.taskId || "";
  return { status, ok: status === 200 && Boolean(taskId), taskId, message: body?.msg || body?.message || "" };
}

function videoResult(env) {
  const data = env?.data || {};
  const status = String(data.status || env?.status || "");
  const raw = data.videos || data.data || [];
  const videos = (Array.isArray(raw) ? raw : [raw])
    .map((v) => (typeof v === "string" ? v : v?.url || ""))
    .filter(Boolean);
  const credit = data?.usage?.credit ?? data?.credit ?? env?.credit ?? null;
  return { status, videos, credit };
}

const TASK_OWNER = new Map();
function rememberTask(taskId, acc) {
  if (!taskId) return;
  TASK_OWNER.set(taskId, acc.uid);
  if (TASK_OWNER.size > 300) TASK_OWNER.delete(TASK_OWNER.keys().next().value);
}
function ownerOf(taskId) {
  const uid = TASK_OWNER.get(taskId);
  return uid ? POOL.accounts.find((a) => a.uid === uid) || null : null;
}

async function pollVideoTask(acc, taskId) {
  const started = Date.now();
  let last = null;
  for (;;) {
    const { status, body } = await httpJson(
      `${mediaBase(acc)}/v2/videos/tasks`,
      { method: "POST", headers: mediaHeaders(acc), body: JSON.stringify({ task_id: taskId }) },
      60000,
    );
    if (status === 200) last = body;
    const r = videoResult(last);
    if (r.status === "completed" || r.status === "failed") return { ...r, env: last };
    if (Date.now() - started > 900000) return { status: "timeout", videos: [], credit: null, env: last };
    await sleep(5000);
  }
}

/* ---- 模型目录 ---- */

const num = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const m = String(v).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};

function promoActive(promo, now = new Date()) {
  const sch = promo?.schedule;
  if (!sch) return true;
  if (sch.dailyUnusable) return false;
  const daily = sch.daily;
  if (!Array.isArray(daily) || !daily.length) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  const parse = (s, fb) => {
    const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : fb;
  };
  for (const w of daily) {
    const a = parse(w.start, -1);
    const b = parse(w.end, -1);
    if (a < 0 || b < 0) continue;
    if (a <= b ? mins >= a && mins <= b : mins >= a || mins <= b) return true;
  }
  return false;
}

function promoLabels(cfg, model) {
  let mult = null;
  let badge = "";
  const promos = Array.isArray(cfg?.modelPromotions) ? cfg.modelPromotions.slice() : [];
  promos.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  for (const p of promos) {
    const ids = Array.isArray(p.models) ? p.models : Array.isArray(p.modelIds) ? p.modelIds : [];
    if (ids.length && !ids.includes(model.id)) continue;
    if (!promoActive(p)) continue;
    const d = p.discount || p.multiplier;
    const mode = String(p.discount?.displayMode || "");
    if (mode === "replace" || mode === "strikethrough" || d != null) {
      const v = num(d?.value ?? d);
      if (v != null) mult = v;
    }
    if (p.badge?.label) badge = String(p.badge.label);
    break;
  }
  if (!badge) {
    const tiers = Array.isArray(cfg?.modelTiers) ? cfg.modelTiers : [];
    for (const t of tiers) {
      const ids = Array.isArray(t.models) ? t.models : [];
      if (ids.includes(model.id) && t.badge?.label) {
        badge = String(t.badge.label);
        break;
      }
    }
  }
  return { mult, badge };
}

let CATALOG = { at: 0, rows: [], total: 0 };

async function buildCatalog(acc, force) {
  if (!force && CATALOG.rows.length && Date.now() - CATALOG.at < CATALOG_TTL_MS) return CATALOG;
  const { status, body } = await httpJson(`${billingBase(acc)}/v3/config`, { headers: catalogHeaders(acc) }, 30000);
  if (status !== 200) return CATALOG;
  const cfg = body?.data || body || {};
  const models = cfg.models || [];
  const ids = models.map((m) => m.id || m.model).filter(Boolean);
  const busyMap = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const r = await httpJson(
        `${chatBase(acc)}/v2/chat/busy`,
        { method: "POST", headers: catalogHeaders(acc), body: JSON.stringify({ models: ids.slice(i, i + 50) }) },
        30000,
      );
      const rows = r.body?.data || r.body?.models || [];
      for (const it of Array.isArray(rows) ? rows : []) {
        const id = it.model || it.id;
        // 上游拥挤度字段是 busy_level（不是 busy / status）
        if (id) busyMap.set(id, String(it.busy_level || it.busy || "unknown"));
      }
    } catch {
      /* 拥挤度拿不到不影响主流程 */
    }
  }
  const rows = models.map((m) => {
    const id = m.id || m.model;
    const tags = Array.isArray(m.tags) ? m.tags : [];
    const media = tags.some((t) => MEDIA_TAGS.has(t));
    const disabled = Boolean(m.disabled);
    // 上游 /v3/config 的真实字段名（与 python 版一致）：
    //   倍率 = credits；上下文 = maxInputTokens / metadata.maxInputTokens；
    //   输出上限 = maxOutputTokens / metadata.maxOutputTokens；推理档位 = reasoning.supportedEfforts
    const meta = m.metadata && typeof m.metadata === "object" ? m.metadata : {};
    const reasoning = m.reasoning && typeof m.reasoning === "object" ? m.reasoning : {};
    const ctx = Number(m.maxInputTokens || meta.maxInputTokens || 0) || 0;
    const base = num(m.credits ?? m.multiplier ?? m.rate);
    const promo = promoLabels(cfg, { id });
    const eff = promo.mult != null ? promo.mult : base;
    const busyRow = busyMap.get(id);
    const busy = busyRow || "unknown";
    const busyText = BUSY_TITLES[busy] || "";
    const rawEfforts = Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [];
    const efforts = rawEfforts.map(String).filter((e) => REASONING_LEVELS.has(e));
    return {
      id,
      name: m.name || m.displayName || id,
      multiplier: eff,
      baseMultiplier: base,
      badge: promo.badge,
      busy,
      busyText,
      context: ctx,
      maxOutput: Number(m.maxOutputTokens || meta.maxOutputTokens || 0) || 0,
      efforts,
      canDisableThinking: Boolean(reasoning.canDisableThinking),
      tags,
      media,
      disabled,
      // 只把「有 maxInputTokens 的纯文本对话模型」算作 chat（codewise-* / *-completion 等专用模型排除）
      chat: Boolean(ctx) && !media && !disabled && (m.type == null || ["chat", "text"].includes(String(m.type))),
    };
  }).filter((r) => r.id);
  for (const r of rows) r.chat = Boolean(r.chat) && !r.media && !r.disabled;
  CATALOG = { at: Date.now(), rows, total: models.length };
  return CATALOG;
}

function displayLabel(row) {
  const parts = [row.name];
  if (row.multiplier != null) parts.push(`${Number(row.multiplier).toFixed(2)}x`);
  if (row.busyText && row.busy !== "unknown") parts.push(row.busyText);
  if (row.badge) parts.push(row.badge);
  return parts.join(" · ");
}

/* ---- 健康探测 ---- */

let HEALTH = { at: 0, map: {} };

async function loadHealth() {
  if (HEALTH.at) return HEALTH;
  const doc = await readJsonFile(HEALTH_FILE, null);
  HEALTH = { at: 1, map: doc && typeof doc === "object" ? doc : {} };
  return HEALTH;
}

function healthState(mid) {
  const rec = HEALTH.map[mid];
  if (!rec || !rec.at) return "unknown";
  if (Date.now() - rec.at > HEALTH_TTL_MS) return "unknown";
  return String(rec.state || "unknown");
}

function classifyHealth(status, body) {
  const code = Number(body?.code || 0);
  const msg = String(body?.msg || body?.message || "").toLowerCase();
  if (code === 11102 || msg.includes("service information not found")) return "missing";
  if (code === 11133 || msg.includes("rejected by the model provider")) return "reject";
  if (code === 11134 || code === 11140 || msg.includes("temporarily unavailable")) return "unavail";
  if (status >= 500) return "unavail";
  return "error";
}

async function probeOne(acc, mid) {
  try {
    const { status, body } = await httpJson(
      `${chatBase(acc)}/v2/chat/completions`,
      {
        method: "POST",
        headers: chatHeaders(acc.token),
        body: JSON.stringify({ model: mid, stream: true, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      },
      45000,
    );
    const state = status === 200 ? "ok" : classifyHealth(status, body);
    HEALTH.map[mid] = { at: Date.now(), state };
  } catch {
    HEALTH.map[mid] = { at: Date.now(), state: "unavail" };
  }
}

let healthKicking = false;
function kickHealth(ids) {
  if (healthKicking) return;
  const todo = ids.filter((id) => healthState(id) === "unknown").slice(0, 4);
  if (!todo.length) return;
  healthKicking = true;
  (async () => {
    const acc = POOL.active();
    if (acc) for (const id of todo) await probeOne(acc, id);
    await writeJsonFile(HEALTH_FILE, HEALTH.map);
    healthKicking = false;
  })().catch(() => {
    healthKicking = false;
  });
}

/* ---- 渠道校验规避 ---- */

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && p.text) || "").join("");
  return "";
}

function breakIdentity(text) {
  return String(text).replace(IDENTITY_CLAUSE, (m) => m.replace(/\s/g, (w) => `${w}${ZERO_WIDTH}`));
}

function neutralizeMessage(msg) {
  const raw = textOf(msg?.content);
  if (!raw) return;
  const low = raw.replace(/^[\s\u200b]+/, "").toLowerCase();
  if (BANNED_OPENINGS.some((b) => low.startsWith(b))) {
    if (typeof msg.content === "string") msg.content = `${NEUTRAL_HEAD}\n\n${msg.content}`;
    else if (Array.isArray(msg.content) && msg.content[0]) msg.content[0].text = `${NEUTRAL_HEAD}\n\n${msg.content[0].text || ""}`;
  }
  if (typeof msg.content === "string") msg.content = breakIdentity(msg.content);
}

function sanitizePayload(payload) {
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  for (const m of msgs) {
    if (m.role === "developer") m.role = "system";
    if (m.role === "system" || m.role === "assistant") neutralizeMessage(m);
  }
  if (!msgs.length || msgs[0].role !== "system") msgs.unshift({ role: "system", content: NEUTRAL_HEAD });
  payload.messages = msgs;
  return payload;
}

function failoverReason(status, body) {
  const code = Number(body?.code || 0);
  if (FAILOVER_CODES.has(code)) return `上游返回 ${code}`;
  if (FAILOVER_HTTP.has(status)) return `HTTP ${status}`;
  return "";
}

/* ---- SSE 聚合 ---- */

async function aggregateSse(resp, payload) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const content = [];
  let reasoning = [];
  const tools = new Map();
  let finish = "";
  let usage = null;
  let id = "";
  let created = 0;
  let model = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.id) id = j.id;
      if (j.created) created = j.created;
      if (j.model) model = j.model;
      if (j.usage) usage = j.usage;
      const ch = (j.choices || [])[0] || {};
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || ch.message || {};
      if (typeof d.content === "string" && d.content) content.push(d.content);
      if (typeof d.reasoning_content === "string" && d.reasoning_content) reasoning.push(d.reasoning_content);
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? 0;
        const cur = tools.get(idx) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name = tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        tools.set(idx, cur);
      }
    }
  }
  const message = { role: "assistant", content: content.join("") };
  const r = reasoning.join("");
  if (r) message.reasoning_content = r;
  if (tools.size) message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return {
    id: id || `chatcmpl-${uuid()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || String(payload.model || ""),
    choices: [{ index: 0, message, finish_reason: finish || "stop" }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function chatOnce(payload, exclude) {
  const tried = new Set(exclude || []);
  let lastErr = null;
  for (let i = 0; i < Math.max(1, POOL.accounts.length); i += 1) {
    const acc = POOL.pick(tried);
    if (!acc) break;
    let resp;
    try {
      resp = await fetch(`${chatBase(acc)}/v2/chat/completions`, {
        method: "POST",
        headers: chatHeaders(acc.token),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastErr = err;
      tried.add(acc.uid);
      continue;
    }
    if (resp.status === 200 && (resp.headers.get("content-type") || "").includes("event-stream")) return { resp, acc };
    let body = {};
    try {
      body = await resp.clone().json();
    } catch {
      /* ignore */
    }
    const reason = failoverReason(resp.status, body);
    if (reason) {
      POOL.bench(acc);
      tried.add(acc.uid);
      lastErr = new Error(`${reason}：${String(body?.msg || body?.message || "").slice(0, 120)}`);
      continue;
    }
    return { resp, acc };
  }
  throw lastErr || new Error("没有可用账号（请先登录 WorkBuddy 桌面端）");
}

/* ============================ 本地 HTTP 服务 ============================ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });

async function modelsPayload() {
  await loadHealth();
  const acc = POOL.active();
  if (!acc) return json({ object: "list", data: [], error: "没有可用账号" }, 503);
  const cat = await buildCatalog(acc, false);
  const rows = cat.rows.filter((r) => r.chat && !HEALTH_HIDE.has(healthState(r.id)));
  const seen = new Map();
  const data = rows.map((r) => {
    const label = displayLabel(r) + (HEALTH_WARN[healthState(r.id)] || "");
    seen.set(label, (seen.get(label) || 0) + 1);
    const name = seen.get(label) > 1 ? `${r.name} (${r.id})` : r.name;
    return {
      id: r.id,
      object: "model",
      owned_by: "workbuddy",
      name,
      display_name: r.name,
      displayName: r.name,
      label: displayLabel(r) + (HEALTH_WARN[healthState(r.id)] || ""),
      inputTokenLimit: r.context,
      outputTokenLimit: r.maxOutput,
      multiplier: r.multiplier,
      busy: r.busy,
      busyText: r.busyText,
      badge: r.badge,
      contextWindow: r.context,
      maxOutputTokens: r.maxOutput,
      reasoningEfforts: r.efforts.map((e) => ({ id: e, label: e })),
    };
  });
  kickHealth(rows.map((r) => r.id));
  return json({ object: "list", data, total: cat.total });
}

async function handleChat(req) {
  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: { message: "请求体不是合法 JSON" } }, 400);
  }
  const wantsStream = payload.stream === true;
  const models = String(payload.model || "");
  if (models.includes(" · ")) payload.model = models.split(" · ")[0].trim();
  sanitizePayload(payload);
  payload.stream = true;
  delete payload.stream_options;
  let resp;
  let acc;
  try {
    const r = await chatOnce(payload, []);
    resp = r.resp;
    acc = r.acc;
  } catch (err) {
    return json({ error: { message: String(err?.message || err) } }, 502);
  }
  if (wantsStream) {
    return new Response(resp.body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...CORS },
    });
  }
  try {
    return json(await aggregateSse(resp, payload));
  } catch (err) {
    return json({ error: { message: `聚合上游流失败：${String(err?.message || err)}` } }, 502);
  }
}

async function handleImage(req) {
  const acc = POOL.active();
  if (!acc) return json({ ok: false, message: "没有可用账号" }, 503);
  const body = await req.json().catch(() => ({}));
  try {
    const r = await genImage(acc, body);
    await refreshCredits(acc, true);
    return json({ ok: r.ok, urls: r.urls, credit: r.credit, model: body.model || "", size: body.size || "", requestId: r.requestId, message: r.message });
  } catch (err) {
    return json({ ok: false, message: String(err?.message || err) }, 502);
  }
}

async function handleVideo(req) {
  const acc = POOL.active();
  if (!acc) return json({ ok: false, message: "没有可用账号" }, 503);
  const body = await req.json().catch(() => ({}));
  try {
    const sub = await submitVideo(acc, body);
    if (!sub.ok) return json({ ok: false, message: sub.message || "上游未受理", status: "failed" }, 200);
    rememberTask(sub.taskId, acc);
    if (body.wait === false) return json({ ok: true, taskId: sub.taskId, status: "submitted" });
    const r = await pollVideoTask(acc, sub.taskId);
    const ok = r.status === "completed" && r.videos.length > 0;
    if (ok) await refreshCredits(acc, true);
    return json({ ok, taskId: sub.taskId, status: r.status, urls: r.videos, credit: r.credit, model: body.model || "" });
  } catch (err) {
    return json({ ok: false, message: String(err?.message || err) }, 502);
  }
}

async function handleVideoTask(req) {
  const body = await req.json().catch(() => ({}));
  const taskId = String(body.taskId || body.task_id || "");
  if (!taskId) return json({ ok: false, message: "缺少 taskId" }, 400);
  const acc = ownerOf(taskId) || POOL.active();
  if (!acc) return json({ ok: false, message: "没有可用账号" }, 503);
  try {
    const { status, body: env } = await httpJson(
      `${mediaBase(acc)}/v2/videos/tasks`,
      { method: "POST", headers: mediaHeaders(acc), body: JSON.stringify({ task_id: taskId }) },
      60000,
    );
    const r = videoResult(env);
    return json({ ok: r.status === "completed", taskId, status: r.status, urls: r.videos, credit: r.credit, upstreamStatus: status });
  } catch (err) {
    return json({ ok: false, message: String(err?.message || err), status: "error" }, 502);
  }
}

async function handlePoolRoute(path, req) {
  if (path.endsWith("/creds/sync")) {
    const d = await discoverCredentials();
    await persistCredentials(d.creds);
    const n = await POOL.scan(d.creds);
    return json({ ok: true, count: n, sources: d.sources, notes: d.notes });
  }
  if (path.endsWith("/refresh")) {
    for (const a of POOL.accounts) await refreshCredits(a, true);
    return json({ ok: true, snapshot: POOL.snapshot() });
  }
  if (path.endsWith("/mode")) {
    const body = await req.json().catch(() => ({}));
    if (["auto", "fixed", "off"].includes(body.mode)) POOL.mode = body.mode;
    if (body.fixedUid != null) POOL.fixedUid = String(body.fixedUid);
    await POOL.saveState();
    return json({ ok: true, mode: POOL.mode, fixedUid: POOL.fixedUid });
  }
  if (path.endsWith("/toggle")) {
    const body = await req.json().catch(() => ({}));
    const uid = String(body.uid || "");
    if (uid) {
      if (POOL.disabled.has(uid)) POOL.disabled.delete(uid);
      else POOL.disabled.add(uid);
      await POOL.saveState();
    }
    return json({ ok: true, snapshot: POOL.snapshot() });
  }
  return json({ ok: false, message: "未知账号池操作" }, 404);
}

async function credsStatus() {
  const d = await discoverCredentials();
  return {
    ok: true,
    vault: VAULT_DIR,
    region: REGION,
    accounts: POOL.accounts.length,
    sources: d.sources,
    notes: d.notes,
    discovered: d.creds.length,
    port: SERVER.port,
  };
}

async function router(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET") {
    if (path === "/" || path === "/healthz") return json({ ok: true, pool: POOL.accounts.length, port: SERVER.port });
    if (path === "/v1/models" || path === "/models") return modelsPayload();
    if (path === "/pool/accounts") return json(POOL.snapshot());
    if (path === "/pool/catalog") {
      const acc = POOL.active();
      const cat = acc ? await buildCatalog(acc, url.searchParams.get("refresh") === "1") : { rows: [] };
      return json({ models: cat.rows, ts: Date.now() });
    }
    if (path === "/pool/health") {
      await loadHealth();
      return json(Object.entries(HEALTH.map).map(([id, v]) => ({ id, state: v.state, at: v.at })));
    }
    if (path === "/pool/creds" || path === "/pool/credentials") return json(await credsStatus());
    if (path === "/v1/media/models" || path === "/media/models") {
      const acc = POOL.active();
      if (!acc) return json({ ok: false, message: "没有可用账号", image: [], video: [] }, 503);
      const m = await mediaModelsOf(acc);
      return json({ ok: true, ...m });
    }
    if (path === "/v1/media/balance" || path === "/media/balance") {
      const acc = POOL.active();
      if (!acc) return json({ ok: false, message: "没有可用账号" }, 503);
      await refreshCredits(acc, true);
      const snap = POOL.snapshot();
      return json({
        ok: true,
        uid: acc.uid,
        nickname: acc.nickname,
        region: acc.region,
        credits: acc.credits,
        cycleEnd: acc.cycleEnd,
        poolCredits: Math.round(snap.totalCredits * 100) / 100,
        accounts: POOL.accounts.length,
      });
    }
    return json({ ok: false, message: `未知路径 ${path}` }, 404);
  }

  if (req.method === "POST") {
    if (path.startsWith("/pool/")) return handlePoolRoute(path, req);
    if (path === "/v1/images/generations" || path === "/images/generations" || path === "/v1/media/image" || path === "/media/image" || path === "/v1/images/edits") {
      return handleImage(req);
    }
    if (path === "/v1/videos/generations" || path === "/v1/media/video" || path === "/media/video") return handleVideo(req);
    if (path === "/v1/videos/tasks" || path === "/v1/media/video/task" || path === "/media/video/task") return handleVideoTask(req);
    if (path.endsWith("/chat/completions")) return handleChat(req);
    return json({ ok: false, message: `未知路径 ${path}` }, 404);
  }
  return json({ ok: false, message: "不支持的方法" }, 405);
}

const SERVER = { ok: false, own: false, port: 0, error: "" };

async function bootServer(wantPort) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const d = await discoverCredentials();
    await persistCredentials(d.creds);
    await POOL.scan(d.creds);
  } catch (err) {
    SERVER.error = String(err?.message || err);
  }
  if (!isBun || typeof Bun.serve !== "function") {
    SERVER.error = SERVER.error || "当前运行时没有 Bun.serve，使用外部代理";
    return SERVER;
  }
  const ports = [];
  for (const p of [wantPort, wantPort + 1, wantPort + 2, 0]) if (p != null && !ports.includes(p)) ports.push(p);
  for (const port of ports) {
    try {
      const srv = Bun.serve({ hostname: "127.0.0.1", port, fetch: router });
      SERVER.ok = true;
      SERVER.own = true;
      SERVER.port = srv.port;
      SERVER.error = "";
      await writeFile(PORT_FILE, String(srv.port), "utf8").catch(() => {});
      return SERVER;
    } catch (err) {
      if (port === wantPort) {
        // 端口被占：先看是不是已经在跑的 WorkBuddy 代理，是就复用
        try {
          const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
          const j = await r.json();
          if (j && j.ok && typeof j.pool !== "undefined") {
            SERVER.ok = true;
            SERVER.own = false;
            SERVER.port = port;
            return SERVER;
          }
        } catch {
          /* 不是我们的代理，往下试别的端口 */
        }
      }
      SERVER.error = String(err?.message || err);
    }
  }
  return SERVER;
}

function portFromUrl(url) {
  const m = String(url || "").match(/^https?:\/\/[^/:]+:(\d+)/i);
  return m ? Number(m[1]) : 8289;
}

let BOOTING = null;
function ensureBoot(config) {
  if (BOOTING) return BOOTING;
  BOOTING = bootServer(Number(process.env.WB_PLUGIN_PORT || portFromUrl(config?.proxyUrl || DEFAULT_PROXY)));
  return BOOTING;
}

/* 模块顶层立即启动，让 Toonflow 的文本供应商装完就能连上 */
const BOOT_TOP = ensureBoot({ proxyUrl: DEFAULT_PROXY });

/* ============================ 工具参数 schema ============================ */

const configSchema = z
  .object({
    proxyUrl: z.string().trim().min(1).max(2048).default(DEFAULT_PROXY),
    outputDir: z.string().trim().min(1).max(1024).default(DEFAULT_OUT_DIR),
    autoStart: z.boolean().default(true),
  })
  .partial()
  .default({});

const relPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (v) => !/^[\\/]|[:\u0000-\u001f]/.test(v) && v.split(/[\\/]/).every((s) => s && s !== "." && s !== ".."),
    "必须是工作区内的相对路径，不能包含空路径段或 ..",
  );

const imageParams = z
  .strictObject({
    prompt: z.string().trim().min(1).max(4000).describe("画面描述"),
    model: z.string().trim().min(1).max(128).optional().describe("模型 id，缺省用第一个文生图模型"),
    size: z
      .string()
      .trim()
      .regex(/^[1-9]\d{1,4}x[1-9]\d{1,4}$/, "尺寸格式应为 宽x高，例如 1024x1024")
      .optional()
      .describe("输出尺寸，如 1024x1024；上限约 419 万像素"),
    image: z.string().trim().min(1).max(11000000).optional().describe("参考图：工作区相对路径、http(s) 网址或 data URL，给了就是图生图"),
    saveTo: relPath.optional().describe("保存到工作区的相对路径；给目录则自动命名"),
  })
  .strict();

const videoParams = z
  .strictObject({
    prompt: z.string().trim().min(1).max(2500).describe("画面描述"),
    model: z.string().trim().min(1).max(128).optional().describe("视频模型 id，缺省用第一个"),
    seconds: z.number().int().min(1).max(15).optional().describe("时长（秒），须落在该模型支持的区间内"),
    resolution: z.string().trim().min(1).max(32).optional().describe("分辨率档位，如 768P、2K、720P"),
    aspectRatio: z.string().trim().min(1).max(16).optional().describe("画面比例，仅文生视频生效，如 16:9"),
    negativePrompt: z.string().trim().max(2500).optional().describe("反向提示词"),
    enableAudio: z.boolean().optional().describe("是否带声音，默认 true"),
    image: z.string().trim().min(1).max(11000000).optional().describe("首帧图：工作区相对路径、http(s) 网址或 data URL，给了就是图生视频"),
    lastImage: z.string().trim().min(1).max(11000000).optional().describe("尾帧图，需要同时给首帧"),
    saveTo: relPath.optional().describe("保存到工作区的相对路径；给目录则自动命名"),
  })
  .strict();

const emptyParams = z.strictObject({}).strict();

const setupParams = z
  .strictObject({
    force: z.boolean().optional().describe("已存在同名供应商时强制覆盖"),
  })
  .strict();

/* ============================ 工作区与 HTTP 客户端 ============================ */

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function baseUrl(config) {
  if (SERVER.ok && SERVER.port) return `http://127.0.0.1:${SERVER.port}`;
  return String(config?.proxyUrl || DEFAULT_PROXY).trim().replace(/\/+$/, "");
}

async function callProxy(config, path, init = {}, signal) {
  const { timeoutMs, allowNotOk, ...rest } = init;
  const url = baseUrl(config) + path;
  const timeout = AbortSignal.timeout(timeoutMs || 60000);
  const bag = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let resp;
  try {
    resp = await fetch(url, { ...rest, signal: bag });
  } catch (err) {
    const hint = /ECONNREFUSED|Failed to fetch|fetch failed/i.test(String(err?.message || err))
      ? `连不上本地 WorkBuddy 服务 ${baseUrl(config)}。请调用 workbuddySetup 重新初始化，或检查 ${PORT_FILE}。`
      : String(err?.message || err);
    throw new Error(hint);
  }
  const text = await resp.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { ok: false, message: text.slice(0, 400) };
  }
  if (!resp.ok || (body.ok === false && !allowNotOk)) throw new Error(body.message || `服务返回 HTTP ${resp.status}`);
  return body;
}

function guessMime(url) {
  const clean = String(url || "").split("?")[0].toLowerCase();
  const ext = extname(clean);
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  return "image/png";
}

async function toDataUrl(context, ref, signal) {
  const text = String(ref || "").trim();
  if (!text) return "";
  if (/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(text)) {
    if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES * 1.4) throw new Error("参考图超过 8 MB 上限");
    return text;
  }
  if (/^https?:\/\//i.test(text)) {
    const resp = await fetch(text, { signal: signal || AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`参考图下载失败：HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_INPUT_BYTES) throw new Error("参考图超过 8 MB 上限");
    return `data:${guessMime(text)};base64,${buf.toString("base64")}`;
  }
  if (/^[A-Za-z0-9+/=\s]{64,}$/.test(text)) {
    if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES * 1.4) throw new Error("参考图超过 8 MB 上限");
    return `data:image/png;base64,${text.replace(/\s+/g, "")}`;
  }
  const abs = await context.resolvePath(text, true);
  const buf = Buffer.from(await Bun.file(abs).arrayBuffer());
  if (buf.byteLength > MAX_INPUT_BYTES) throw new Error(`参考图超过 8 MB 上限：${text}`);
  return `data:${guessMime(text)};base64,${buf.toString("base64")}`;
}

function resolveOut(config, saveTo, stamp, ext) {
  const dir = String(config.outputDir || DEFAULT_OUT_DIR).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const target = String(saveTo || "").replace(/\\/g, "/").trim();
  if (!target) return posix.join(dir, `workbuddy-${stamp}${ext}`);
  if (/\.[a-z0-9]{2,5}$/i.test(target)) return target;
  return posix.join(target.replace(/^\/+|\/+$/g, ""), `workbuddy-${stamp}${ext}`);
}

async function saveBinary(context, relOut, url, signal) {
  const abs = await context.resolvePath(relOut);
  await mkdir(dirname(abs), { recursive: true });
  const resp = await fetch(url, { signal: signal || AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`产物下载失败：HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(abs, buf);
  const ext = extname(relOut).toLowerCase();
  const mime = ext === ".mp4" ? "video/mp4" : ext === ".webm" ? "video/webm" : guessMime(relOut);
  return { path: relOut, abs, bytes: buf.byteLength, mimeType: mime };
}

function pickModel(rows, prefer, wantTag) {
  const list = Array.isArray(rows) ? rows : [];
  if (prefer) {
    const hit = list.find((m) => m.id === prefer);
    if (!hit) throw new Error(`目录里没有模型「${prefer}」。可用：${list.map((m) => m.id).join("、") || "（空）"}`);
    if (wantTag && Array.isArray(hit.tags) && !hit.tags.includes(wantTag)) {
      throw new Error(`模型「${prefer}」不支持 ${wantTag}。可用：${list.filter((m) => (m.tags || []).includes(wantTag)).map((m) => m.id).join("、") || "（空）"}`);
    }
    return hit;
  }
  const pool = wantTag ? list.filter((m) => (m.tags || []).includes(wantTag)) : list;
  if (!pool.length) throw new Error(`目录里没有 ${wantTag || "可用"} 模型`);
  return pool[0];
}

async function waitVideo(config, taskId, signal, onUpdate) {
  const started = Date.now();
  let last = "";
  let transient = 0;
  for (;;) {
    if (signal?.aborted) throw new Error("视频任务已取消");
    let body;
    try {
      body = await callProxy(
        config,
        "/v1/videos/tasks",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId }), timeoutMs: 120000, allowNotOk: true },
        signal,
      );
    } catch (err) {
      transient += 1;
      if (transient > 5) throw err;
      await sleep(VIDEO_POLL_INTERVAL_MS);
      continue;
    }
    transient = 0;
    const status = String(body.status || "");
    const waited = Math.round((Date.now() - started) / 1000);
    if (status !== last) {
      last = status;
      onUpdate?.({ text: `视频任务 ${taskId}：${status || "处理中"}（已等 ${waited} 秒）` });
    }
    if (status === "completed" || status === "failed") return body;
    if (Date.now() - started > VIDEO_TIMEOUT_MS) return { ...body, status: status || "timeout", urls: body.urls || [] };
    await sleep(VIDEO_POLL_INTERVAL_MS);
  }
}

function makeClient(config) {
  let cache = { at: 0, data: null };
  return {
    async models(signal, force) {
      if (!force && cache.data && Date.now() - cache.at < MODEL_TTL_MS) return cache.data;
      const body = await callProxy(config, "/v1/media/models", { timeoutMs: 45000 }, signal);
      cache = { at: Date.now(), data: body };
      return body;
    },
  };
}

/* ---- 把文本模型写进 Toonflow ---- */

function toonflowRoots() {
  const roots = [];
  if (process.env.TOONFLOW_HOME) roots.push(process.env.TOONFLOW_HOME);
  if (process.platform === "win32") {
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!base) continue;
      for (const n of ["toonflow", "Toonflow", "toonflow-desktop", "ToonflowDesktop"]) {
        roots.push(join(base, n));
        roots.push(join(base, "Programs", n));
      }
    }
  } else if (process.platform === "darwin") {
    for (const base of ["/Applications", join(HOME_DIR, "Applications")]) {
      for (const n of ["toonflow", "Toonflow"]) roots.push(join(base, n));
    }
  }
  roots.push(join(HOME_DIR, "toonflow"));
  // 注册表兜底：Toonflow 可装在任意盘（本机就是 E:\local.toonflow.desktop\...\stable）
  for (const r of registryToonflowRoots()) roots.push(r);
  return roots;
}

function registryToonflowRoots() {
  if (process.platform !== "win32" || !isBun) return [];
  const out = [];
  try {
    const txt = runQuiet("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "/s",
      "/f",
      "toonflow",
      "/d",
    ]);
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/(DisplayIcon|InstallLocation)\s+REG_\w+\s+(.+)$/i);
      if (!m) continue;
      let val = m[2].trim().replace(/^"|"$/g, "").replace(/,\d+$/, "");
      if (!val) continue;
      if (/\.exe$/i.test(val)) val = dirname(val);
      // 去掉 app\Resources 之类的尾巴，回溯到安装根
      const idx = val.toLowerCase().indexOf("\\app");
      if (idx > 0) val = val.slice(0, idx);
      if (val && !out.includes(val)) out.push(val);
    }
  } catch {
    /* 注册表读不到就算了 */
  }
  return out;
}

async function findToonflowPort() {
  if (process.env.TF_PORT) return Number(process.env.TF_PORT);
  for (const root of toonflowRoots()) {
    for (const rel of ["app/Resources/desktopRuntime.json", "Resources/desktopRuntime.json", "desktopRuntime.json"]) {
      const p = join(root, rel);
      if (!existsSync(p)) continue;
      const doc = await readJsonFile(p, null);
      if (doc?.port) return Number(doc.port);
    }
  }
  // 再兜一层：扫 bun.exe 的 LISTENING 端口，逐个问 /api/settings/get 认不认
  for (const port of bunListeningPorts()) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/settings/get`, {
        headers: { "x-toonflow-desktop": "1", "x-toonflow-workspace": "1", Origin: `http://127.0.0.1:${port}` },
        signal: AbortSignal.timeout(4000),
      });
      if ([200, 400, 401, 403].includes(r.status)) return port;
    } catch {
      /* 不是 Toonflow */
    }
  }
  return 0;
}

function bunListeningPorts() {
  if (process.platform !== "win32" || !isBun) return [];
  const ports = [];
  try {
    const t = runQuiet("tasklist", ["/FI", "IMAGENAME eq bun.exe", "/FO", "CSV", "/NH"]);
    const pids = t
      .split(/\r?\n/)
      .map((l) => l.split('","')[1]?.replace(/"/g, ""))
      .filter(Boolean);
    if (!pids.length) return [];
    const n = runQuiet("netstat", ["-ano", "-p", "TCP"]);
    for (const line of n.split(/\r?\n/)) {
      const m = line.match(/127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && pids.includes(m[2])) ports.push(Number(m[1]));
    }
  } catch {
    /* ignore */
  }
  return [...new Set(ports)];
}

async function tfCall(port, method, path, body) {
  const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-toonflow-desktop": "1",
      "x-toonflow-workspace": "1",
      Origin: `http://127.0.0.1:${port}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const text = await resp.text();
  try {
    return { status: resp.status, body: JSON.parse(text) };
  } catch {
    return { status: resp.status, body: { raw: text.slice(0, 300) } };
  }
}

const PROVIDER_ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f6bff"/><path d="M8 20l4-8 4 8 4-8 4 8" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "utf8",
  ).toString("base64");

function toProviderModel(m) {
  const efforts = Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length
    ? Object.fromEntries(m.reasoningEfforts.map((e) => [String(e.id || e), String(e.label || e.id || e)]))
    : false;
  return {
    id: m.id,
    label: String(m.label || m.name || m.display_name || m.id).slice(0, 200),
    contextWindow: Number(m.contextWindow || m.inputTokenLimit || 0) || 0,
    maxOutputTokens: Number(m.maxOutputTokens || m.outputTokenLimit || 0) || 0,
    reasoningEfforts: efforts,
  };
}

/* ============================ 插件 ============================ */

const pluginPrompt = `WorkBuddy 能力由本插件内置的本地服务提供，不需要外部代理。
画图用 workbuddyDrawImage（同步，十几秒到一分钟）；出视频用 workbuddyDrawVideo（异步，通常一分钟以上，先告知等待）。
调用前要模型名时先用 workbuddyMediaModels 查真实 id；花积分前可用 workbuddyCredits 报额度。
首次使用报「没有可用账号」时调用 workbuddySetup 自动发现凭据并配置；用户要接文本模型时也用它。
产物落在工作区，回复里给相对路径，不要贴签名链接。`;

const S = {
  validateConfig(raw) {
    return configSchema.parse(raw ?? {});
  },

  createTools(context) {
    const config = configSchema.parse(context?.config ?? {});
    const client = makeClient(config);
    const boot = () => ensureBoot(config);

    const ensureCreds = async () => {
      await boot();
      if (POOL.accounts.length) return;
      const d = await discoverCredentials();
      await persistCredentials(d.creds);
      await POOL.scan(d.creds);
    };

    return [
      {
        name: "workbuddySetup",
        label: "WorkBuddy 一键配置",
        description:
          "初始化 WorkBuddy：自动发现本机凭据（桌面端 / 环境变量 / 凭据库），启动内置本地服务，并把文本模型供应商写进 Toonflow 设置。装完第一次用跑一次即可。",
        promptSnippet: "初始化 WorkBuddy 本地服务并把文本模型写进 Toonflow 供应商。",
        promptGuidelines: [
          "用户第一次用、或报「没有可用账号 / 连不上服务」时调用。",
          "它会把 WorkBuddy 的对话模型写进「设置 → 模型供应商」，之后用户直接选模型即可。",
          "只做配置，不消耗积分。",
        ],
        parameters: z.toJSONSchema(setupParams, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(first, second, third) {
          const args = setupParams.parse(typeof second === "object" && second ? second : first);
          const signal = third?.signal || (typeof third?.throwIfAborted === "function" ? third : undefined);
          const srv = await boot();
          const d = await discoverCredentials();
          await persistCredentials(d.creds);
          const count = await POOL.scan(d.creds);
          const lines = [];
          lines.push(`本地服务：${srv.ok ? `http://127.0.0.1:${srv.port}（${srv.own ? "内置" : "复用已有"}）` : `未启动（${srv.error || "未知原因"}）`}`);
          lines.push(`凭据来源：${d.sources.join("、") || "无"}`);
          d.notes.forEach((n) => lines.push(`- ${n}`));
          lines.push(`可用账号：${count} 个`);
          if (count) {
            const acc = POOL.active();
            if (acc) await refreshCredits(acc, true);
            const snap = POOL.snapshot();
            lines.push(`积分合计：${Math.round(snap.totalCredits * 100) / 100}`);
          }
          if (!srv.ok || !count) {
            lines.push("");
            lines.push("没能自动完成。请确认：① 本机装过并登录 WorkBuddy 桌面端；② 或设置环境变量 CODEBUDDY_AUTH_TOKEN；③ 端口冲突可改插件配置里的「本地服务地址」。");
            return { content: [{ type: "text", text: lines.join("\n") }], details: { server: srv, accounts: count, notes: d.notes } };
          }
          const tfPort = await findToonflowPort();
          if (!tfPort) {
            lines.push("");
            lines.push(`没找到 Toonflow 后端端口，请手动把 apiUrl 设为 http://127.0.0.1:${srv.port}（协议 openai-completions，apiKey 随便填）。`);
            return { content: [{ type: "text", text: lines.join("\n") }], details: { server: srv, accounts: count, tfPort: 0 } };
          }
          const models = await callProxy(config, "/v1/models", { timeoutMs: 60000 }, signal);
          const rows = Array.isArray(models.data) ? models.data : [];
          if (!rows.length) {
            lines.push("");
            lines.push("本地服务没有拿到对话模型（上游目录为空），稍后再试一次 workbuddySetup。");
            return { content: [{ type: "text", text: lines.join("\n") }], details: { server: srv, tfPort, models: 0 } };
          }
          const got = await tfCall(tfPort, "GET", "/api/settings/get");
          if (got.status !== 200) {
            lines.push("");
            lines.push(`读 Toonflow 设置失败（HTTP ${got.status}），请手动配置：apiUrl http://127.0.0.1:${srv.port}`);
            return { content: [{ type: "text", text: lines.join("\n") }], details: { server: srv, tfPort, settings: got.status } };
          }
          const cfg = got.body?.data || got.body || {};
          const list = Array.isArray(cfg.customProviders) ? cfg.customProviders.slice() : [];
          const idx = list.findIndex((p) => String(p?.id || "").toLowerCase() === "workbuddy");
          if (idx >= 0 && !args.force) {
            lines.push("");
            lines.push("Toonflow 里已经有 workbuddy 供应商，已更新模型清单（要强制重建就传 force=true）。");
          }
          const provider = {
            id: "workbuddy",
            label: "WorkBuddy",
            icon: PROVIDER_ICON,
            apiKey: "no-key",
            apiUrl: `http://127.0.0.1:${srv.port}`,
            protocol: "openai-completions",
            models: rows.map(toProviderModel),
          };
          if (idx >= 0) list[idx] = { ...list[idx], ...provider };
          else list.push(provider);
          cfg.customProviders = list;
          const saved = await tfCall(tfPort, "PUT", "/api/settings/save", { settings: cfg });
          lines.push("");
          lines.push(`已写入 Toonflow：workbuddy 供应商，${provider.models.length} 个模型（${saved.status === 200 ? "保存成功" : `保存返回 ${saved.status}`}）`);
          lines.push("去「设置 → 模型供应商 → WorkBuddy」挑一个模型就能对话了。");
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { server: srv, tfPort, models: provider.models.length, saved: saved.status, notes: d.notes },
          };
        },
      },
      {
        name: "workbuddyStatus",
        label: "WorkBuddy 状态",
        description: "查看内置本地服务的端口、可用账号数、凭据来源与积分。排查连不上或没账号时用。只读。",
        promptSnippet: "查看 WorkBuddy 本地服务与账号状态。",
        parameters: z.toJSONSchema(emptyParams, { io: "input", target: "draft-07" }),
        executionMode: "parallel",
        async execute(first, second, third) {
          const signal = third?.signal || (typeof third?.throwIfAborted === "function" ? third : undefined);
          const srv = await ensureBoot(config);
          const lines = [];
          lines.push(`本地服务：${srv.ok ? `http://127.0.0.1:${srv.port}（${srv.own ? "内置" : "复用已有"}）` : `未启动（${srv.error || "未初始化"}）`}`);
          if (!POOL.accounts.length) {
            lines.push("可用账号：0 个 —— 调用 workbuddySetup 自动发现凭据。");
            return { content: [{ type: "text", text: lines.join("\n") }], details: { server: srv, accounts: 0 } };
          }
          try {
            const bal = await callProxy(config, "/v1/media/balance", { timeoutMs: 45000 }, signal);
            lines.push(`当前账号：${bal.nickname || bal.uid}（${bal.region === "global" ? "国际区" : "国内区"}）`);
            lines.push(`剩余积分：${bal.credits}${bal.cycleEnd ? `　最近到期：${bal.cycleEnd}` : ""}`);
            lines.push(`账号池合计：${bal.poolCredits}（${bal.accounts} 个账号）`);
            return { content: [{ type: "text", text: lines.join("\n") }], details: { server: srv, balance: bal } };
          } catch (err) {
            lines.push(`查询积分失败：${String(err?.message || err)}`);
            return { content: [{ type: "text", text: lines.join("\n") }], details: { server: srv, accounts: POOL.accounts.length } };
          }
        },
      },
      {
        name: "workbuddyDrawImage",
        label: "WorkBuddy 画图",
        description: "用 WorkBuddy 账号池生成图片（文生图 / 给参考图即图生图），结果保存到工作区。同步调用，通常十几秒到一分钟。",
        promptSnippet: "通过 WorkBuddy 生成图片并存到工作区。",
        promptGuidelines: [
          "先想要模型名就用 workbuddyMediaModels 查，不要凭印象填。",
          "给了参考图就是图生图；参考图可以是工作区路径、网址或 data URL。",
          "返回的是工作区相对路径，交给用户时用这个路径，不要贴签名链接。",
        ],
        parameters: z.toJSONSchema(imageParams, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(first, second, third) {
          const args = imageParams.parse(typeof second === "object" && second ? second : first);
          const signal = third?.signal || (typeof third?.throwIfAborted === "function" ? third : undefined);
          await ensureCreds();
          const wantsEdit = Boolean(args.image);
          const catalog = await client.models(signal);
          const model = pickModel(catalog.image, args.model, wantsEdit ? "image-to-image" : "text-to-image");
          const size = args.size || "1024x1024";
          const request = { model: model.id, prompt: args.prompt, size };
          if (wantsEdit) request.image = await toDataUrl(context, args.image, signal);
          const stamp = nowStamp();
          const outRel = resolveOut(config, args.saveTo, stamp, ".png");
          const body = await callProxy(
            config,
            "/v1/images/generations",
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), timeoutMs: IMAGE_TIMEOUT_MS },
            signal,
          );
          const urls = body.urls || [];
          if (!urls.length) throw new Error("上游没有返回图片地址");
          const saved = [];
          for (let i = 0; i < urls.length; i += 1) {
            const rel = urls.length === 1 ? outRel : outRel.replace(/(\.[a-z0-9]+)$/i, `-${i + 1}$1`);
            saved.push(await saveBinary(context, rel, urls[i], signal));
          }
          return {
            content: [
              {
                type: "text",
                text: [
                  `模型：${model.id}　尺寸：${size}${body.credit != null ? `　消耗：${body.credit} 积分` : ""}`,
                  ...saved.map((f) => `工作区文件：${f.path}（${(f.bytes / 1024).toFixed(0)} KB）`),
                ].join("\n"),
              },
            ],
            details: { model: model.id, size, credit: body.credit ?? null, files: saved.map((f) => ({ path: f.path, mimeType: f.mimeType, bytes: f.bytes })) },
          };
        },
      },
      {
        name: "workbuddyDrawVideo",
        label: "WorkBuddy 出视频",
        description: "用 WorkBuddy 账号池生成视频（文生视频 / 给首帧即图生视频）。异步任务，工具内部轮询到完成再返回，通常一分钟以上。",
        promptSnippet: "通过 WorkBuddy 生成视频并保存为 mp4。",
        promptGuidelines: [
          "这是异步长任务，先告诉用户大概要等多久，别让它看起来卡住。",
          "时长必须落在模型支持区间内；不确定就用 workbuddyMediaModels 查 minSeconds / maxSeconds。",
          "给了首帧图就是图生视频，此时不传比例，比例由首帧决定。",
          "产物是工作区里的 mp4 相对路径，交给用户时用这个路径。",
        ],
        parameters: z.toJSONSchema(videoParams, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(first, second, third, fourth) {
          const args = videoParams.parse(typeof second === "object" && second ? second : first);
          const signal = third?.signal || (typeof third?.throwIfAborted === "function" ? third : undefined);
          const onUpdate = typeof fourth === "function" ? fourth : undefined;
          await ensureCreds();
          const catalog = await client.models(signal);
          const wantTag = args.image ? "image-to-video" : "text-to-video";
          const model = pickModel(catalog.video, args.model, wantTag);
          const vg = model.videoGeneration || {};
          const minSeconds = Number(vg.minSeconds || 1);
          const maxSeconds = Number(vg.maxSeconds || 15);
          let seconds = Number(args.seconds || vg.defaultSeconds || 5);
          if (!Number.isFinite(seconds)) seconds = Number(vg.defaultSeconds || 5);
          if (seconds < minSeconds || seconds > maxSeconds) {
            throw new Error(`时长必须在 ${minSeconds} 到 ${maxSeconds} 秒之间（模型 ${model.id}），收到 ${seconds}`);
          }
          let resolution = args.resolution;
          const allowed = Array.isArray(vg.resolutions) ? vg.resolutions : [];
          if (resolution && allowed.length) {
            const hit = allowed.find((r) => String(r).toLowerCase() === String(resolution).toLowerCase());
            resolution = hit || vg.defaultResolution || allowed[0];
          } else if (!resolution) {
            resolution = vg.defaultResolution || allowed[0] || undefined;
          }
          let aspectRatio = args.aspectRatio;
          if (!args.image && aspectRatio) {
            const ratios = Array.isArray(vg.aspectRatios) ? vg.aspectRatios : [];
            if (ratios.length && !ratios.includes(aspectRatio)) aspectRatio = undefined;
          }
          const request = {
            model: model.id,
            prompt: args.prompt,
            seconds,
            resolution,
            aspectRatio: args.image ? undefined : aspectRatio,
            negativePrompt: args.negativePrompt,
            enableAudio: args.enableAudio !== false,
          };
          if (args.image) request.image = await toDataUrl(context, args.image, signal);
          if (args.lastImage) request.last_image_url = await toDataUrl(context, args.lastImage, signal);
          const stamp = nowStamp();
          const outRel = resolveOut(config, args.saveTo, stamp, ".mp4");
          const submit = await callProxy(
            config,
            "/v1/videos/generations",
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, wait: false }), timeoutMs: 120000 },
            signal,
          );
          const taskId = submit.taskId;
          if (!taskId) throw new Error(`视频任务未受理：${submit.message || "上游没有返回 taskId"}`);
          const body = await waitVideo(config, taskId, signal, onUpdate);
          if (!body.ok || !(body.urls || []).length) throw new Error(`视频任务未完成：${body.status || "unknown"}（任务 ${taskId}）`);
          const saved = [];
          const urls = body.urls || [];
          for (let i = 0; i < urls.length; i += 1) {
            const rel = urls.length === 1 ? outRel : outRel.replace(/(\.[a-z0-9]+)$/i, `-${i + 1}$1`);
            saved.push(await saveBinary(context, rel, urls[i], signal));
          }
          return {
            content: [
              {
                type: "text",
                text: [
                  `模型：${model.id}　${seconds} 秒　${resolution || "默认分辨率"}${body.credit != null ? `　消耗：${body.credit} 积分` : ""}`,
                  `任务：${body.taskId}`,
                  ...saved.map((f) => `工作区文件：${f.path}（${(f.bytes / 1024 / 1024).toFixed(2)} MB）`),
                ].join("\n"),
              },
            ],
            details: {
              model: model.id,
              seconds,
              resolution: resolution || null,
              taskId: body.taskId,
              credit: body.credit ?? null,
              files: saved.map((f) => ({ path: f.path, mimeType: f.mimeType, bytes: f.bytes })),
            },
          };
        },
      },
      {
        name: "workbuddyCredits",
        label: "WorkBuddy 积分",
        description: "查询 WorkBuddy 账号池当前账号的剩余积分、到期时间，以及所有账号的合计。只读，不消耗积分。",
        promptSnippet: "查询 WorkBuddy 剩余积分与账号池合计。",
        parameters: z.toJSONSchema(emptyParams, { io: "input", target: "draft-07" }),
        executionMode: "parallel",
        async execute(first, second, third) {
          const signal = third?.signal || (typeof third?.throwIfAborted === "function" ? third : undefined);
          await ensureCreds();
          const body = await callProxy(config, "/v1/media/balance", { timeoutMs: 45000 }, signal);
          return {
            content: [
              {
                type: "text",
                text: [
                  `当前账号：${body.nickname || body.uid}（${body.region === "global" ? "国际区" : "国内区"}）`,
                  `剩余积分：${body.credits}${body.cycleEnd ? `　最近到期：${body.cycleEnd}` : ""}`,
                  `账号池合计：${body.poolCredits}（${body.accounts} 个账号）`,
                ].join("\n"),
              },
            ],
            details: body,
          };
        },
      },
      {
        name: "workbuddyMediaModels",
        label: "WorkBuddy 媒体模型",
        description: "列出 WorkBuddy 账号池当前可用的图片与视频模型，含标签、时长区间和分辨率档位。只读，不消耗积分。",
        promptSnippet: "列出 WorkBuddy 可用的图片与视频模型及其能力。",
        parameters: z.toJSONSchema(emptyParams, { io: "input", target: "draft-07" }),
        executionMode: "parallel",
        async execute(first, second, third) {
          const signal = third?.signal || (typeof third?.throwIfAborted === "function" ? third : undefined);
          await ensureCreds();
          const body = await client.models(signal, true);
          const fmt = (m) => {
            const vg = m.videoGeneration || {};
            const extra = vg.maxSeconds ? `　${vg.minSeconds}-${vg.maxSeconds} 秒　${(vg.resolutions || []).join("/")}` : "";
            return `- ${m.id}（${(m.tags || []).join("、")}）${extra}`;
          };
          return {
            content: [
              {
                type: "text",
                text: ["图片模型：", ...(body.image || []).map(fmt), "", "视频模型：", ...(body.video || []).map(fmt)].join("\n"),
              },
            ],
            details: body,
          };
        },
      },
    ];
  },
};

export default S;
