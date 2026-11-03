# toonflow-connect-workbuddy

把 [WorkBuddy](https://www.codebuddy.cn) 账号池的画图 / 生视频能力接进 [Toonflow](https://toonflow.com) 的 Agent。

灵感与上游参考：[dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)。

---

## 为什么是 tools 插件，不是供应商

Toonflow 的插件体系只有三类（`teams` 未开放）：

| 类型 | 运行位置 | 分发文件 |
|---|---|---|
| `tools` | Bun 服务端 | `<name>.tool.js` |
| `nodes` | WebView 前端 | `<name>.umd.js` |
| `skill` | 无（纯 Markdown） | `SKILL.md` |

底层还有个 `provider` 安装类型，但契约（`@toonflow/providers` 的 `ProviderDefinition`）只声明了三个方法：

```ts
generateImage? / generateVideo? / generateAudio?
```

**没有 `generateChat`。** 文本对话模型走的是另一条完全独立的路——`settings.json` 的 `data.customProviders`（后端 zod 里写死了「toonflow 为账号供应商保留 ID」「账号文本配置只能包含文本模型」）。

所以：

- **文本模型**（截图里那些 `Deepseek-V4.1-Flash · 0.11x`）→ 在「设置 → 模型供应商」里配 OpenAI 兼容端点。
- **画图 / 生视频**（本插件）→ 做成 `tools` 插件，让 Agent 在对话里按需调用。

---

## 两种用法，选一个

| 方式 | 需要什么 | 适合 |
|---|---|---|
| **单文件插件**（推荐给插件市场用户） | 只装 `tool/workbuddyConnect.tool.js` 一个文件 | 从 Toonflow 插件市场下载的人，无需 Python |
| 完整仓库（`install.py`） | Python + 本仓库 | 想自己掌控代理、要开机自启、要账号池运维 |

**单文件版是自包含的**：插件模块在被 import 的那一刻（模块顶层）就自己起一个 `Bun.serve`，内置了完整的代理逻辑——凭据发现、AES 解密、账号池、`/v3/config` 目录、`/v1/chat/completions`、生图、生视频异步轮询，全在一个 `.js` 里，不依赖本仓库的任何 Python 文件。

装完之后：

1. 在对话里说「用 workbuddySetup 配置一下」——它会发现凭据、起本地服务、把 48 个文本模型写进「设置 → 模型供应商」。
2. 到模型下拉里选 WorkBuddy 的模型，开始对话。
3. 要画图/出视频时，Agent 会自动调 `workbuddyDrawImage` / `workbuddyDrawVideo`。

单文件版默认端口 **8289**（与完整仓库的 Python 代理 8189 错开，两者可以并存）。

> ⚠️ 一个必须知道的平台行为：`POST /api/tools/install` **只会把文件落盘，不会执行模块**。插件的 `Bun.serve` 要等到 Toonflow 真的 `import()` 这个模块才会起——也就是第一次被使用、或调一次 `PUT /api/tools/setEnabled`。本仓库的 `scripts/install_tool_plugin.py` 已经自动补了这一步。

---

## 组成

```
.
├── install.py                      # 一键装完（凭据 → 代理 → 文本模型 → 插件 → 自启）
├── tool/workbuddyConnect.tool.js   # Toonflow tools 插件本体（v2 单文件自包含，含内置代理）
├── client/                         # 工具卡片界面（Vue，build.py 嵌进 .tool.js 第 2 行）
├── proxy/wb_proxy.py               # 本机中转（OpenAI 兼容 + 媒体 + 账号池），Python 版
├── proxy/wb_creds.py               # 凭据自动发现（环境变量 / DSH / WorkBuddy 桌面端）
├── proxy/wb_crypto.py              # 纯标准库 AES-256-GCM，解桌面端的加密凭据
├── scripts/setup_text_provider.py  # 一键把代理里的文本模型写进 Toonflow 供应商
├── scripts/install_tool_plugin.py  # 把 tools 插件装进 Toonflow
├── scripts/tf_common.py            # Toonflow 端口定位与 HTTP 调用（公共）
├── scripts/model_rates.py          # 模型倍率 / 拥挤度对照表（终端 + HTML）
└── docs/INSTALL.md                 # 安装与排障
```

### `install.py`

**装上就能用的关键。** 别人机器上不需要先装 DSH、不需要手动填 token、不需要 `cryptography`：

```bash
python install.py                  # 全装
python install.py --check          # 只体检，不改任何东西
python install.py --no-autostart   # 不写开机自启
python install.py --uninstall      # 撤销自启（不删凭据）
```

五步，任何一步失败都会指出具体原因：

1. **探测凭据** — 依次尝试环境变量 `CODEBUDDY_AUTH_TOKEN` → DSH 凭据库 → **WorkBuddy 桌面端认证文件**（后者只要本机登录过 WorkBuddy 就行）。
2. **起代理** — `127.0.0.1:8189`，用 `/healthz` + `/pool/creds` 确认真的能取到账号。
3. **写文本模型** — 调 `scripts/setup_text_provider.py`，把 `/v1/models` 灌进 `settings.customProviders`。
4. **装工具插件** — 调 `scripts/install_tool_plugin.py`，走 `/api/tools/install`，再自动 `PUT /api/tools/setEnabled` 把插件模块跑起来。
5. **开机自启** — Windows 写 `HKCU\...\Run` 的 `ToonflowWorkBuddyProxy`；mac/Linux 只打印手动命令。

### 凭据从哪来（别人装完为什么能直接用）

`proxy/wb_creds.py` 按顺序找，找到就用：

| 来源 | 条件 | 说明 |
|---|---|---|
| 环境变量 | 设了 `CODEBUDDY_AUTH_TOKEN` | 最省事，CI / 容器里用 |
| DSH 凭据库 | `$DSH_HOME/workbuddy-vault/<region>/*.json` | 装了 dsh-connect-workbuddy 才有 |
| **WorkBuddy 桌面端** | 本机登录过 WorkBuddy | **最常见**，字段是 AES-256-GCM 加密的 |

第三条是重点：桌面端把 token 写在

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
%APPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

字段形如 `{"$wbEncrypted":1,"envelope":"<base64>"}`。解封需要 at-rest 密钥，做法是拿 WorkBuddy 的 exe 跑一次：

```
ELECTRON_RUN_AS_NODE=1 WorkBuddy.exe -e "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"
```

拿到 `atRestSecretKey` 后 `key = sha256(<这个 base64 字符串本身>)`，密钥 ID 是 `sha256(key).hex[:16]`，AAD 是 `WB-AAD\0` + 版本标签 + suite + keyId + 字段帧号。这条链子全在 `wb_crypto.py` 里用标准库实现了（AES-GCM 的 GHASH / CTR 手写），已和 `cryptography` 库逐字节对拍。

**exe 怎么找**：`WORKBUDDY_APP_EXECUTABLE` 环境变量 → `%LOCALAPPDATA%` / `%ProgramFiles%` / `%ProgramFiles(x86)%` 下的常见目录 → **Windows 卸载表的 `DisplayIcon`**（装在 `E:\WorkBuddy\WorkBuddy\WorkBuddy.exe` 这种非标准路径也能找到）；macOS 走 `WorkBuddy.app/Contents/MacOS/<CFBundleExecutable>`。

凭据会写进 `~/.toonflow-workbuddy/vault/<region>/<accountId>.json`，格式和 DSH 那份一致，后续代理直接读，不用每次重解。

### `tool/workbuddyConnect.tool.js`

**v2 起是单文件自包含的**（11.0 万字符 / 2186 行）：模块顶层自动起 `Bun.serve`，内置凭据发现、AES-256-GCM 解密、账号池轮换、模型目录、文本对话聚合、生图、生视频异步任务。装进 Toonflow 后不需要任何外部进程。

六个工具，每个都带一张卡片界面（见下节）：

| 工具 | 说明 |
|---|---|
| `workbuddySetup` | 一次性配置：发现凭据 → 起服务 → 把文本模型写进 Toonflow 供应商 |
| `workbuddyStatus` | 本地服务端口、账号数、凭据来源 |
| `workbuddyDrawImage` | 文生图 / 图生图，同步返回，几十秒 |
| `workbuddyDrawVideo` | 文生视频 / 图生视频，异步任务自动轮询到完成 |
| `workbuddyCredits` | 当前账号剩余积分、到期时间、账号池合计 |
| `workbuddyMediaModels` | 可用图片 / 视频模型及能力（时长区间、分辨率、比例） |

配置项（安装后在插件市场里点「配置」）：

- `proxyUrl`，默认 `http://127.0.0.1:8289`（内置服务地址；端口被占时会自动顺延，实际值写进 `~/.toonflow-workbuddy/port.txt`）
- `outputDir`，默认 `assets/generated`，必须是工作区内的相对路径
- `autoStart`，默认开

### 工具卡片界面（`client/`）

六个工具每个都带一张 Vue 卡片，Agent 一调用就在对话里渲染出来——积分卡、模型清单、出图预览、视频进度全都在消息里直接看。

```
client/
├── src/index.js    # 六个 Vue 组件（UMD，复用宿主的 vue / element-plus）
├── src/index.css   # .wbx-* 类名，只用 --el-* 变量，跟随明暗主题
├── build.py        # 打包：校验语法 → 算出 components 列表 → 写入 .tool.js 第 2 行
├── build/          # bun 依赖（zod / vue 编译器），不进仓库
└── dist/           # 参考用的 cjs bundle，实际发的是 src 原文
```

改界面：

```bash
# 改 client/src/index.js 或 index.css，然后
python client/build.py            # 校验 + 重新嵌入 tool/workbuddyConnect.tool.js
python client/build.py --check    # 只校验，不写文件
python scripts/install_tool_plugin.py   # 装进 Toonflow（会自动 setEnabled）
```

Toonflow 的 components 有两条硬规矩，`build.py` 已经帮你守住了：

- 客户端代码塞在 `.tool.js` **第 2 行**的 `/*! toonflowToolClient:{"code":"…","css":"…"} */` 里，用正则 `^\/\*! toonflowToolClient:([^\r\n]*) \*\/$` 整行匹配。**源码里出现任何 `*/`（块注释结束符）都会把这一行提前截断**，安装直接 400「工具客户端界面格式或脚本无效」——`build.py` 会把 js/css 里的块注释全部剥掉再嵌入。
- 元数据 `components` 数组里的名字必须与服务端工具名一一对应，漏一个就报「工具声明了组件但缺少客户端界面」。`build.py` 从服务端源码里正则抠出 `name:` 列表与客户端导出名求交，不用手写。

> ⚠️ **宿主会丢掉 `details`**。Toonflow 转发工具结果时只保留 `content[].text` 拼出来的字符串（`JT(A)` 这个函数就干了这一件事），`details` 完全不过去。所以卡片需要的数据以 `<!--wbx:{…}-->` 标记的形式追加在正文末尾，客户端 `parseCardText()` 再抠出来——正文照旧给人看，纯文本场景不受影响。

### `scripts/setup_text_provider.py`

把代理 `/v1/models` 里的对话模型一键写进 Toonflow 的文本供应商（`settings.customProviders`），不用手点界面。

```bash
python scripts/setup_text_provider.py              # 自动找 Toonflow 端口并写入
python scripts/setup_text_provider.py --dry-run    # 只看会写什么，不动手
python scripts/setup_text_provider.py --port 54149 --label WorkBuddy
```

- 端口查找顺序：`--port` → `TF_PORT` → `TOONFLOW_HOME` / `%LOCALAPPDATA%\toonflow` / 安装根下的 `app/Resources/desktopRuntime.json`。
- 幂等：按 `id` 小写等于 `workbuddy` 匹配，有就更新、没有就新建；写完会回读校验条数。
- 模型字段映射：`label←display_name`、`contextWindow←inputTokenLimit`、`maxOutputTokens←outputTokenLimit`、`reasoningEfforts←reasoningEfforts`。

### `scripts/model_rates.py`

模型倍率 / 拥挤度对照表。倍率和拥挤度已被代理拼进 Toonflow 下拉的标签里，这个脚本解决的是「哪个最省积分、哪个现在不挤」。

```bash
python scripts/model_rates.py                    # 默认按倍率升序，只看对话模型
python scripts/model_rates.py --sort busy        # 先看谁空闲
python scripts/model_rates.py --filter v4 --all  # 关键词过滤，含媒体模型
python scripts/model_rates.py --html rates.html  # 导出彩色 HTML 面板
python scripts/model_rates.py --watch 30         # 每 30 秒刷新
```

```
模型                    倍率   拥挤度    上下文  徽标      id
----------------------  -----  --------  ------  --------  ----------------------
Hy3                     0.00x  正常      192K    限时免费  hy3
GLM-5.3-Flash           0.08x  空闲      1000K   订阅优先  glm-5.3-flash
DeepSeek-V4.1-Flash     0.11x  正常      1000K   夜间折扣  deepseek-v4.1-flash
...
免费：Hy3
最便宜（付费）：Hy3（0.05x）
共 48 个对话模型
```

### `proxy/wb_proxy.py`

单个 Python 文件，标准库实现，无第三方依赖。

**OpenAI 兼容**（给 Toonflow 的文本供应商用）

```
GET  /v1/models
POST /v1/chat/completions      # 上游强制 stream，非流式请求会自动聚合成标准 JSON
```

**媒体**

```
GET  /v1/media/models          # 图片 / 视频模型 + videoGeneration 能力表
GET  /v1/media/balance         # 积分
POST /v1/images/generations    # 文生图
POST /v1/images/edits          # 图生图
POST /v1/videos/generations    # 生视频（默认阻塞到完成；带 wait:false 只回 taskId）
POST /v1/videos/tasks          # 按 taskId 查进度
```

**账号池 / 凭据**

```
GET  /pool/accounts            # 所有账号 + 积分 + 签到 + 当前选中
GET  /pool/catalog             # 上游 /v3/config 的模型目录（含倍率、拥挤度）
GET  /pool/health              # 模型存活探测结果
GET  /pool/creds               # 凭据从哪来的、发现几个、各来源是否可用
POST /pool/creds/sync          # 重新发现凭据并写进 vault
POST /pool/mode /pool/toggle /pool/checkin /pool/refresh /pool/test
```

---

## 快速开始

```bash
git clone https://github.com/wyh1sc/toonflow-connect-workbuddy
cd toonflow-connect-workbuddy
python install.py
```

前提只有两个：**本机装过并登录过 WorkBuddy 桌面端**、**Toonflow 已经打开**。其余全自动。

如果不想跑 `install.py`，手动版：

```bash
# 1. 起代理（凭据会自动发现）
python proxy/wb_proxy.py
# [wb-proxy] listening on http://127.0.0.1:8189
# [wb-proxy] vault: ~/.toonflow-workbuddy/vault/cn
# [wb-proxy] credentials: {"ok": true, "count": 7, "refreshed": 6, ...}
# [wb-proxy] pool: 7 accounts

# 2. 自检
curl http://127.0.0.1:8189/pool/creds
curl http://127.0.0.1:8189/v1/media/balance

# 3. 文本模型 + 工具插件
python scripts/setup_text_provider.py
python scripts/install_tool_plugin.py
```

然后在 Toonflow 对话里直接说：

> 画一张暖色调产品海报，存到 assets/posters

> 把这张图做成 5 秒视频

> 我还剩多少积分

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WB_PROXY_PORT` | `8189` | 监听端口 |
| `WB_VAULT_DIR` | `~/.toonflow-workbuddy/vault/<region>` | 账号凭据目录 |
| `WB_REGION` | `cn` | `cn` 或 `global` |
| `WB_POOL_STATE` | `proxy/wb_pool.json` | 账号池状态文件 |
| `CODEBUDDY_AUTH_TOKEN` | 空 | 直接给 token，跳过所有本地扫描 |
| `WORKBUDDY_APP_EXECUTABLE` | 空 | 手动指定 WorkBuddy.exe（装在怪路径时用） |
| `WB_CREDS_FORCE` | 空 | `1` = 每次启动都重新发现凭据 |
| `WB_CREDS_SKIP_PROBE` | 空 | `1` = `/pool/creds` 只报缓存，不现场探测 |
| `TF_PORT` | 空 | Toonflow 后端端口（自动发现失败时指定） |

---

## 已知限制

- **上游生视频很慢**：实测一次 4 秒视频约 97 秒，`minimax-video-h3` 走完常常 500 秒以上。代理的轮询上限已放到 900 秒，并做了「客户端超时但上游已完成」的改判兜底。
- **任务归属**：上游只认可提交任务的账号，换号查 taskId 会 `403 {"code":10085}`。代理里有 `TASK_OWNER` 表按 uid 回查，不要绕过。
- **产物 URL 有效期 24 小时**：是 COS 签名链接，本插件会落盘到工作区，别把链接当长期地址。
- **尺寸上限约 419 万像素**：`2048x2048` 通过，`2560x2560` 拒。
- **模型繁忙**：上游偶发 `429 Model busy`，与网络无关，换模型或等 30 秒重试。

---

## 许可

MIT。参见 [LICENSE](LICENSE)。

本项目不含任何 WorkBuddy 官方代码或凭据，仅调用公开接口。使用前请确保你拥有相应账号的使用权。
