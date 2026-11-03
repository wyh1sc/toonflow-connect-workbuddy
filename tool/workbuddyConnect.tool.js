/*! toonflowTool:{"name":"workbuddyConnect","version":"1.1.0","displayName":"WorkBuddy 连接","description":"让 Agent 通过本机 WorkBuddy 账号池生成图片、生成视频，并查询剩余积分与可用媒体模型。装完配合 proxy/wb_proxy.py 即可用。","prompt":"需要画图或出视频时优先用本工具，除非用户明确要求在画布节点里生成。workbuddyDrawImage 是同步调用，几十秒出图；workbuddyDrawVideo 是异步任务，要等几十秒到几分钟，长任务先告诉用户大概要等多久。花积分前先用 workbuddyCredits 报一下剩余额度。模型名用 workbuddyMediaModels 查到的 id，不要凭印象猜。生成结果会存到工作区，把返回的相对路径交给用户，不要用 base64 或签名链接代替产物。","readme":"# WorkBuddy 连接\n\n把本机 WorkBuddy 账号池的图像、视频能力接进 Toonflow 的 Agent，同时提供积分与媒体模型查询。文本对话不需要这个插件，那部分已经在「设置 → 模型供应商」里配好了。\n\n## 使用方式\n\n确认代理 127.0.0.1:8189 在线（python install.py --check 会告诉你），然后在对话里直接说：\n\n- 「画一张暖色调产品海报，存到 assets/posters」\n- 「把这张图做成 5 秒视频」\n- 「我还剩多少积分」\n\n## 支持的功能\n\n- `workbuddyDrawImage`：文生图 / 图生图，支持本机路径、网址和 data URL 作为参考图，结果保存到工作区。\n- `workbuddyDrawVideo`：文生视频 / 图生视频，异步任务自动轮询到完成，结果保存为 mp4。\n- `workbuddyCredits`：当前账号剩余积分、到期时间与账号池合计。\n- `workbuddyMediaModels`：当前可用的图片与视频模型，含时长区间和分辨率档位。\n\n## 配置\n\n在「设置 → 插件市场 → 已安装」找到「WorkBuddy 连接」，点击「配置」。\n\n- 「代理地址」默认 `http://127.0.0.1:8189`，就是 wb_proxy 的地址；换了端口才需要改。\n- 「默认输出目录」默认 `assets/generated`，必须是工作区内的相对路径。\n\n## 计费提醒\n\n国内区实测单价：`hunyuan-image-alpha` 约 5.71 积分一张；视频按秒计，`minimax-video-h3` 约 14.29 积分一秒，`kling-video-v3` 图生视频约 17.14、文生视频约 25.71 积分每秒。真实扣费以返回的 credit 为准。\n","components":[],"author":"localWorkspace","github":"https://github.com/wyh1sc/toonflow-connect-workbuddy","configRules":[{"type":"input","field":"proxyUrl","title":"代理地址","value":"http://127.0.0.1:8189","props":{"placeholder":"http://127.0.0.1:8189"}},{"type":"input","field":"outputDir","title":"默认输出目录","value":"assets/generated","props":{"placeholder":"assets/generated"}}]} */
// @bun
import { z } from "toonflow:tool-zod";
import { mkdir, writeFile } from "fs/promises";
import { dirname, extname, join, posix } from "path";

const DEFAULT_PROXY = "http://127.0.0.1:8189";
const DEFAULT_OUT_DIR = "assets/generated";
const MODEL_TTL_MS = 5 * 60 * 1000;
const IMAGE_TIMEOUT_MS = 240000;
const VIDEO_TIMEOUT_MS = 960000;
const VIDEO_POLL_INTERVAL_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

const configSchema = z
  .object({
    proxyUrl: z.string().trim().min(1).max(2048).default(DEFAULT_PROXY),
    outputDir: z.string().trim().min(1).max(1024).default(DEFAULT_OUT_DIR),
  })
  .strict();

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
    model: z.string().trim().min(1).max(128).optional().describe("模型 id，缺省用目录里第一个文生图模型"),
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
    model: z.string().trim().min(1).max(128).optional().describe("视频模型 id，缺省用目录里第一个"),
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

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function proxyOf(config) {
  const raw = String(config?.proxyUrl || DEFAULT_PROXY).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(raw)) throw new Error(`代理地址必须是 http(s) 网址：${raw}`);
  return raw;
}

async function callProxy(config, path, init = {}, signal) {
  const { timeoutMs, allowNotOk, ...rest } = init;
  const url = proxyOf(config) + path;
  const timeout = AbortSignal.timeout(timeoutMs || 60000);
  const bag = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let resp;
  try {
    resp = await fetch(url, { ...rest, signal: bag });
  } catch (err) {
    const hint = /ECONNREFUSED|Failed to fetch|fetch failed/i.test(String(err?.message || err))
      ? `连不上 WorkBuddy 代理 ${proxyOf(config)}。请点输入框旁的「启动管家」把代理拉起来（或确认 wb_proxy 在跑）。`
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
  if (!resp.ok || (body.ok === false && !init.allowNotOk)) {
    throw new Error(body.message || `代理返回 HTTP ${resp.status}`);
  }
  return body;
}

function extOfMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("jpeg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("webm")) return ".webm";
  return ".png";
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

function resolveOut(config, context, saveTo, stamp, ext) {
  const dir = String(config.outputDir || DEFAULT_OUT_DIR).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const target = String(saveTo || "").replace(/\\/g, "/").trim();
  if (!target) return posix.join(dir, `workbuddy-${stamp}${ext}`);
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(target);
  if (hasExt) return target;
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
    if (!hit) {
      throw new Error(`目录里没有模型「${prefer}」。可用：${list.map((m) => m.id).join("、") || "（空）"}`);
    }
    if (wantTag && Array.isArray(hit.tags) && !hit.tags.includes(wantTag)) {
      throw new Error(`模型「${prefer}」不支持 ${wantTag}。可用：${list.filter((m) => (m.tags || []).includes(wantTag)).map((m) => m.id).join("、") || "（空）"}`);
    }
    return hit;
  }
  const pool = wantTag ? list.filter((m) => (m.tags || []).includes(wantTag)) : list;
  if (!pool.length) throw new Error(`目录里没有 ${wantTag || "可用"} 模型`);
  return pool[0];
}

/**
 * 提交后自己轮询 `/v1/videos/tasks`，直到 completed / failed。
 * 阻塞式长请求会被宿主或中间层掐断，所以拆成「提交 + 轮询」两段。
 */
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
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId }),
          timeoutMs: 120000,
          allowNotOk: true,
        },
        signal,
      );
    } catch (err) {
      // 轮询偶发失败不致命，连续 5 次才放弃
      transient += 1;
      if (transient > 5) throw err;
      await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
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
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
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

const pluginPrompt = `WorkBuddy 生成能力都走本机代理，不是公网接口。
画图用 workbuddyDrawImage（同步，通常十几秒到一分钟）；出视频用 workbuddyDrawVideo（异步任务，通常一分钟以上，长任务先告知等待）。
调用前需要模型名时先用 workbuddyMediaModels 查真实 id，不要猜；花积分前可用 workbuddyCredits 报额度。
生成产物落在工作区，回复里给相对路径。代理没起来时报错会提示去点「启动管家」，不要反复重试。`;

const S = {
  validateConfig(raw) {
    return configSchema.parse(raw ?? {});
  },
  createTools(context) {
    const config = configSchema.parse(context?.config ?? {});
    const client = makeClient(config);
    return [
      {
        name: "workbuddyDrawImage",
        label: "WorkBuddy 画图",
        description:
          "用 WorkBuddy 账号池生成图片（文生图 / 给参考图即图生图），结果保存到工作区。同步调用，通常十几秒到一分钟。",
        promptSnippet: "通过本机 WorkBuddy 生成图片并存到工作区。",
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
          const wantsEdit = Boolean(args.image);
          const catalog = await client.models(signal);
          const model = pickModel(
            catalog.image,
            args.model,
            wantsEdit ? "image-to-image" : "text-to-image",
          );
          const size = args.size || (wantsEdit ? "1024x1024" : "1024x1024");
          const request = { model: model.id, prompt: args.prompt, size };
          if (wantsEdit) {
            request.image = await toDataUrl(context, args.image, signal);
            request.model = args.model || model.id;
          }
          const stamp = nowStamp();
          const outRel = resolveOut(config, context, args.saveTo, stamp, ".png");
          const body = await callProxy(
            config,
            "/v1/images/generations",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
              timeoutMs: IMAGE_TIMEOUT_MS,
            },
            signal,
          );
          const urls = body.urls || [];
          if (!urls.length) throw new Error("上游没有返回图片地址");
          const saved = [];
          for (let i = 0; i < urls.length; i += 1) {
            const rel = urls.length === 1 ? outRel : outRel.replace(/(\.[a-z0-9]+)$/i, `-${i + 1}$1`);
            saved.push(await saveBinary(context, rel, urls[i], signal));
          }
          const lines = saved.map((f) => `工作区文件：${f.path}（${(f.bytes / 1024).toFixed(0)} KB）`);
          return {
            content: [
              {
                type: "text",
                text: [
                  `模型：${model.id}　尺寸：${size}${body.credit != null ? `　消耗：${body.credit} 积分` : ""}`,
                  ...lines,
                ].join("\n"),
              },
            ],
            details: {
              model: model.id,
              size,
              credit: body.credit ?? null,
              files: saved.map((f) => ({ path: f.path, mimeType: f.mimeType, bytes: f.bytes })),
            },
          };
        },
      },
      {
        name: "workbuddyDrawVideo",
        label: "WorkBuddy 出视频",
        description:
          "用 WorkBuddy 账号池生成视频（文生视频 / 给首帧即图生视频）。异步任务，工具内部轮询到完成再返回，通常一分钟以上。",
        promptSnippet: "通过本机 WorkBuddy 生成视频并保存为 mp4。",
        promptGuidelines: [
          "这是异步长任务，先告诉用户大概要等多久，别让它看起来卡住。",
          "时长必须落在模型支持区间内；不确定就用 workbuddyMediaModels 查 minSeconds / maxSeconds。",
          "给了首帧图就是图生视频，此时不传比例，比例由首帧决定。",
          "产物是工作区里的 mp4 相对路径，交给用户时用这个路径。",
        ],
        parameters: z.toJSONSchema(videoParams, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(first, second, third, fourth, ctx) {
          const args = videoParams.parse(typeof second === "object" && second ? second : first);
          const signal = third?.signal || (typeof third?.throwIfAborted === "function" ? third : undefined);
          const onUpdate = typeof fourth === "function" ? fourth : undefined;
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
            if (!hit) {
              const fallback = vg.defaultResolution || allowed[0];
              resolution = fallback;
            } else {
              resolution = hit;
            }
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
          const outRel = resolveOut(config, context, args.saveTo, stamp, ".mp4");
          // 先只提交（wait:false），再自己轮询：几百秒的阻塞请求容易被宿主或中间层掐断。
          const submit = await callProxy(
            config,
            "/v1/videos/generations",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...request, wait: false }),
              timeoutMs: 120000,
            },
            signal,
          );
          const taskId = submit.taskId;
          if (!taskId) throw new Error(`视频任务未受理：${submit.message || "上游没有返回 taskId"}`);
          const body = await waitVideo(config, taskId, signal, onUpdate);
          if (!body.ok || !(body.urls || []).length) {
            throw new Error(`视频任务未完成：${body.status || "unknown"}（任务 ${taskId}）`);
          }
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
          const body = await client.models(signal, true);
          const fmt = (m) => {
            const vg = m.videoGeneration || {};
            const extra = vg.maxSeconds
              ? `　${vg.minSeconds}-${vg.maxSeconds} 秒　${(vg.resolutions || []).join("/")}`
              : "";
            return `- ${m.id}（${(m.tags || []).join("、")}）${extra}`;
          };
          return {
            content: [
              {
                type: "text",
                text: [
                  "图片模型：",
                  ...(body.image || []).map(fmt),
                  "",
                  "视频模型：",
                  ...(body.video || []).map(fmt),
                ].join("\n"),
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
