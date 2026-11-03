# 安装与排障

## 前置

- Windows / macOS / Linux 均可，Python 3.8+（只用标准库）
- 一个可用的 WorkBuddy 账号
- Toonflow 2.0.8 及以上

---

## 一、准备凭据

代理从 **dsh-connect-workbuddy 的 vault** 读账号，一个账号一个 JSON 文件：

```
$DSH_HOME/workbuddy-vault/<region>/<accountId>.json
```

`$DSH_HOME` 默认是 `~/.dsh`，`<region>` 是 `cn` 或 `global`。

文件结构：

```json
{
  "version": 1,
  "accountId": "…",
  "refreshedAtMs": 1793690000000,
  "auth": {
    "accessToken": "eyJhbGciOi…",
    "refreshToken": "…",
    "expiresAt": 1796000000000,
    "refreshExpiresAt": 1800000000000,
    "domain": "www.codebuddy.cn"
  },
  "account": { "uid": "…", "nickname": "…" }
}
```

只要 `auth.accessToken` 有效即可用。`accessToken` 是 RS256 JWT，`exp` 约 28 天。

> 最省事的拿到这堆文件的方式：先装并登录 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)，它会把 vault 写好。本仓库不包含任何获取凭据的代码。

多账号就多放几个文件，代理会自动轮换。

---

## 二、起代理

```bash
cd proxy
python wb_proxy.py
```

正常输出：

```
[wb-proxy] listening on http://127.0.0.1:8189
[wb-proxy] pool: 6 accounts
```

自检：

```bash
curl http://127.0.0.1:8189/v1/media/balance
# {"ok":true,"uid":"…","nickname":"…","region":"cn","credits":2436.63,"poolCredits":14240.44,"accounts":6}

curl http://127.0.0.1:8189/v1/media/models
# {"ok":true,"total":58,"region":"cn","image":[…],"video":[…]}
```

**端口被占**：`netstat -ano | findstr :8189`，把占用的进程杀掉再起。Windows 上常见多个 `python.exe` / `pythonw.exe` 抢同一个端口，实际只有一个在 LISTEN，其余是残留——全部杀掉再起最稳。

**改了代码不生效**：Python 不会热重载，必须杀掉所有 `wb_proxy.py` 进程重新起。

---

## 二点五、接文本模型（最常用）

Toonflow 的**文本对话模型不是插件**，走的是 `settings.customProviders`。本仓库给了一键脚本。

```bash
# 代理已经起在 8189 之后执行
python scripts/setup_text_provider.py --dry-run   # 先看看会写什么
python scripts/setup_text_provider.py             # 写入
```

输出：

```
更新供应商 workbuddy：32 个模型
保存 -> {"code": 200, ...}
校验：Toonflow 里现有 32 个模型（应为 32）
```

脚本做的事：

1. 找 Toonflow 后端端口（`--port` → `TF_PORT` → `desktopRuntime.json`）
2. `GET {proxy}/v1/models` 拉本代理暴露的全部对话模型
3. 映射成 Toonflow 的模型结构：`label←display_name`、`contextWindow←inputTokenLimit`、`maxOutputTokens←outputTokenLimit`、`reasoningEfforts←reasoningEfforts`
4. 按 `id` 小写等于 `workbuddy` 匹配 upsert 进 `customProviders`
5. `PUT /api/settings/save` 后回读校验

`apiUrl` 固定写 `http://127.0.0.1:8189`、`protocol` 固定 `openai-completions`、`apiKey` 填 `no-key`（代理不校验，但字段必须非空）。

写完后在 Toonflow 里模型下拉就能看到它们，标签形如：

```
DeepSeek-V4.1-Flash · 0.11x · 正常 · 夜间折扣
        ↑模型名         ↑倍率  ↑拥挤度  ↑徽标
```

倍率和拥挤度是代理拼进 `label` 的（Toonflow 的模型 schema 只有 `id/label/contextWindow/maxOutputTokens/reasoningEfforts` 五个字段，没有专门的倍率位）。

### 挑模型：`scripts/model_rates.py`

```bash
python scripts/model_rates.py                    # 倍率升序，只看对话模型
python scripts/model_rates.py --sort busy        # 先看谁不挤
python scripts/model_rates.py --filter v4 --all  # 关键词过滤
python scripts/model_rates.py --html rates.html  # 导出彩色 HTML 面板
```

```
模型                    倍率   拥挤度    上下文  徽标      id
----------------------  -----  --------  ------  --------  ----------------------
Hy3                     0.00x  正常      192K    限时免费  hy3
GLM-5.3-Flash           0.08x  空闲      1000K   订阅优先  glm-5.3-flash
DeepSeek-V4.1-Flash     0.11x  正常      1000K   夜间折扣  deepseek-v4.1-flash
GLM-5.3                 0.69x  拥挤      1000K   订阅优先  glm-5.3

免费：Hy3
最便宜（付费）：Hy3（0.05x）
共 48 个对话模型
```

`--html` 导出的是自包含单文件（深浅色自适应，倍率与拥挤度带色阶），可以直接扔给同事看。

---

## 三、装 Toonflow 插件

`tool/workbuddyConnect.tool.js` 单文件，两种装法。

### 图形界面

Toonflow →「插件市场」→ 上传 `workbuddyConnect.tool.js`。

### HTTP

先取后端端口：

```python
import json
p = r"<Toonflow 安装目录>\app\Resources\desktopRuntime.json"
print(json.load(open(p, encoding="utf-8"))["port"])
```

然后：

```python
import json, urllib.request

port = 49394  # 换成上一步读到的
src = open("tool/workbuddyConnect.tool.js", encoding="utf-8").read()

body = json.dumps({"fileName": "workbuddyConnect.tool.js", "source": src, "force": True}).encode("utf-8")
req = urllib.request.Request(
    f"http://127.0.0.1:{port}/api/tools/install",
    data=body,
    headers={
        "content-type": "application/json",
        "x-toonflow-desktop": "1",
        "x-toonflow-workspace": "1",
        "origin": f"http://127.0.0.1:{port}",
    },
    method="POST",
)
print(urllib.request.urlopen(req, timeout=30).read().decode())
# {"code":200,"data":{"name":"workbuddyConnect"},"message":"工具已安装"}
```

三个请求头缺一不可：

- `x-toonflow-desktop: 1`
- `x-toonflow-workspace: 1`
- `origin` 与 host 一致

缺 `x-toonflow-workspace` 会回 `403 只允许 Toonflow 页面访问控制连接`。

验证：

```bash
curl -s http://127.0.0.1:<port>/api/tools/get \
  -H "x-toonflow-desktop: 1" -H "x-toonflow-workspace: 1" \
  -H "origin: http://127.0.0.1:<port>" | python -c "import sys,json;d=json.load(sys.stdin)['data']['tools'];print([ (t['name'],t['version'],t['enabled'],t.get('loadError')) for t in d])"
```

注意返回形状是 `data.tools`，不是 `data`。

---

## 四、验证

在 Toonflow 对话框里发：

> 调用 workbuddyMediaModels 工具，列出可用的图片模型和视频模型，每行一个。

约 10 秒应该回：

```
hunyuan-image-alpha（text-to-image）
hunyuan-image-alpha-edit（image-to-image）
kling-video-v3（text-to-video、image-to-video）3-15 秒 720P/1080P/4K
minimax-video-h3（text-to-video、image-to-video）4-15 秒 768P/2K
```

再试画图：

> 画一张暖色调产品海报，存到 assets/posters

约 15 秒出图，消耗 5.71 积分左右。

---

## 排障

### 工具不出现

`GET /api/tools/get` 里没看到 `workbuddyConnect` → 安装没成功，看返回的 `message`。

### 工具在但 Agent 不调用

- 在「设置 → 插件市场 → 已安装」确认开关是开着的
- `loadError` 不为空 → 通常是元数据 JSON 格式问题，JSON 必须单行、不含未转义引号
- 模型太弱不会用工具时，直接点名：「调用 workbuddyCredits」

### 报「代理不可用」

输入框旁「启动管家」红/灰 = `127.0.0.1:8189` 没起来。起 `python proxy/wb_proxy.py`。

### 生视频超时

- 上游一次 4 秒视频约 97 秒，5 秒档经常 500 秒+
- 代理轮询上限 900 秒；插件侧 960 秒
- 若仍超时，先用 `wait:false` 拿 `taskId`，再轮询 `/v1/videos/tasks`

### `403 Not authorized to access this task`

上游任务只认提交它的账号。代理内部按 uid 回查 `TASK_OWNER`，如果你直接绕过代理调上游，就会踩这个。

### `429 Model busy`

上游限流，与网络无关。换模型或等 30 秒。

### `11128 Illegal API invocation from an unapproved channel`

代理里已经做了规避（`sanitize_payload`：中性化 system 提示 + 零宽字符打断身份串）。如果自己改坏了这段就会出现。

---

## 卸载

```bash
curl -X POST http://127.0.0.1:<port>/api/tools/uninstall \
  -H "content-type: application/json" \
  -H "x-toonflow-desktop: 1" -H "x-toonflow-workspace: 1" \
  -H "origin: http://127.0.0.1:<port>" \
  -d "{\"name\":\"workbuddyConnect\"}"
```
