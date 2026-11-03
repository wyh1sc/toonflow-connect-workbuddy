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

- **文本模型**（截图里那些 `Deepseek-V4.1-Flash · 0.11x`）→ 在「设置 → 模型供应商」里配 OpenAI 兼容端点，本仓库的 `proxy/wb_proxy.py` 就提供这个端点。
- **画图 / 生视频**（本插件）→ 做成 `tools` 插件，让 Agent 在对话里按需调用。

---

## 组成

```
.
├── install.py                      # 一键装完（凭据 → 代理 → 文本模型 → 插件 → 自启）
├── tool/workbuddyConnect.tool.js   # Toonflow tools 插件本体
├── proxy/wb_proxy.py               # 本机中转（OpenAI 兼容 + 媒体 + 账号池）
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
4. **装工具插件** — 调 `scripts/install_tool_plugin.py`，走 `/api/tools/install`。
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

四个工具：

| 工具 | 说明 |
|---|---|
| `workbuddyDrawImage` | 文生图 / 图生图，同步返回，几十秒 |
| `workbuddyDrawVideo` | 文生视频 / 图生视频，异步任务自动轮询到完成 |
| `workbuddyCredits` | 当前账号剩余积分、到期时间、账号池合计 |
| `workbuddyMediaModels` | 可用图片 / 视频模型及能力（时长区间、分辨率、比例） |

配置项（安装后在插件市场里点「配置」）：

- `proxyUrl`，默认 `http://127.0.0.1:8189`
- `outputDir`，默认 `assets/generated`，必须是工作区内的相对路径

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
