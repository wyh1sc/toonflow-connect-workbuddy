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
├── tool/workbuddyConnect.tool.js   # Toonflow tools 插件本体
├── proxy/wb_proxy.py               # 本机中转（OpenAI 兼容 + 媒体 + 账号池）
└── docs/INSTALL.md                 # 安装与排障
```

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

**账号池**

```
GET  /pool/accounts            # 所有账号 + 积分 + 签到 + 当前选中
GET  /pool/catalog             # 上游 /v3/config 的模型目录（含倍率、拥挤度）
GET  /pool/health              # 模型存活探测结果
POST /pool/mode /pool/toggle /pool/checkin /pool/refresh /pool/test
```

---

## 快速开始

```bash
# 1. 起代理（需要先有 WorkBuddy 账号凭据，见 docs/INSTALL.md）
python proxy/wb_proxy.py
# [wb-proxy] listening on http://127.0.0.1:8189
# [wb-proxy] pool: 6 accounts

# 2. 自检
curl http://127.0.0.1:8189/v1/media/balance
curl http://127.0.0.1:8189/v1/media/models
```

```bash
# 3. 装 Toonflow 插件
curl -X POST http://127.0.0.1:<toonflow-port>/api/tools/install \
  -H "content-type: application/json" \
  -H "x-toonflow-desktop: 1" \
  -H "x-toonflow-workspace: 1" \
  -H "origin: http://127.0.0.1:<toonflow-port>" \
  -d "{\"fileName\":\"workbuddyConnect.tool.js\",\"source\":<文件内容>,\"force\":true}"
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
| `WB_VAULT_DIR` | `$DSH_HOME/workbuddy-vault/<region>` | 账号凭据目录 |
| `WB_REGION` | `cn` | `cn` 或 `global` |
| `WB_POOL_STATE` | `proxy/wb_pool.json` | 账号池状态文件 |

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
