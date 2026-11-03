# 安装与排障

## 前置

- Windows / macOS / Linux 均可，Python 3.8+（只用标准库）
- 一个可用的 WorkBuddy 账号
- Toonflow 2.0.8 及以上

---

## 前言：一条命令装完

```bash
git clone https://github.com/wyh1sc/toonflow-connect-workbuddy
cd toonflow-connect-workbuddy
python install.py
```

`install.py` 会依次做完：**探测凭据 → 起代理 → 写文本模型 → 装工具插件 → 注册开机自启**，每步都打印实际结果，失败直接指出原因。

前提只有两个：

- 本机装过并**登录过 WorkBuddy 桌面端**（凭据就是从它那儿来的）
- Toonflow 已经打开

不想自动装就往下看手动步骤。

---

## 一、凭据从哪来

**不需要手动填 token。** `proxy/wb_creds.py` 会自动找，顺序如下：

| 顺序 | 来源 | 条件 |
|---|---|---|
| 1 | 环境变量 `CODEBUDDY_AUTH_TOKEN` | 手动给了就用，最省事 |
| 2 | DSH 凭据库 `$DSH_HOME/workbuddy-vault/<region>/*.json` | 装了 dsh-connect-workbuddy |
| 3 | **WorkBuddy 桌面端认证文件** | 本机登录过 WorkBuddy（最常见） |

第三条的实现在 `wb_creds.py` + `wb_crypto.py`：

1. 找 WorkBuddy 的 exe —— `WORKBUDDY_APP_EXECUTABLE` → `%LOCALAPPDATA%`/`%ProgramFiles%`/`%ProgramFiles(x86)%` 常见目录 → **Windows 卸载表的 `DisplayIcon`**（装在 `E:\WorkBuddy\WorkBuddy\WorkBuddy.exe` 这种怪路径也能找到）
2. `ELECTRON_RUN_AS_NODE=1 <exe> -e "process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())"` 取 `atRestSecretKey`
3. `key = sha256(<base64 字符串本身>)`，`keyId = sha256(key).hex[:16]`
4. 读 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，把 `{"$wbEncrypted":1,"envelope":"…"}` 字段用 AES-256-GCM 解开

第 4 步的 AES-GCM 是标准库手写的（`wb_crypto.py`，GHASH/CTR 全实现），**不需要装 `cryptography`**，已和官方库逐字节对拍。

解出来的凭据写进 `~/.toonflow-workbuddy/vault/<region>/<accountId>.json`，格式：

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
  "account": { "uid": "…", "nickname": "…" },
  "source": "desktop:workbuddy-desktop.info"
}
```

多账号就多几个文件，代理自动轮换。快过期的 token 会自动拿 `refreshToken` 续期。

手动触发一次探测：

```bash
python proxy/wb_creds.py
# {"ok": true, "count": 7, "refreshed": 6, "vault": "…", "accounts": [...]}
```

代理跑起来之后也可以 HTTP 触发：

```bash
curl http://127.0.0.1:8189/pool/creds          # 看凭据状态
curl -X POST http://127.0.0.1:8189/pool/creds/sync   # 重新发现
```

---

## 二、起代理

```bash
cd proxy
python wb_proxy.py
```

正常输出：

```
[wb-proxy] listening on http://127.0.0.1:8189
[wb-proxy] vault: C:\Users\<你>\.toonflow-workbuddy\vault\cn
[wb-proxy] credentials: {"ok": true, "count": 7, "refreshed": 6, "vault": "…"}
[wb-proxy]   环境变量：未设置 CODEBUDDY_AUTH_TOKEN
[wb-proxy]   DSH 凭据库：6 个账号
[wb-proxy]   桌面端：1 个账号（密钥 ok）
[wb-proxy] pool: 7 accounts
```

第一次启动会自动跑一遍凭据发现；vault 已有账号时就跳过（`WB_CREDS_FORCE=1` 可强制重跑）。

自检：

```bash
curl http://127.0.0.1:8189/pool/creds
# {"ok":true,"vault":"…","accounts":7,"sources":["desktop","dsh-vault"],"notes":[…]}

curl http://127.0.0.1:8189/v1/media/balance
# {"ok":true,"uid":"…","nickname":"…","region":"cn","credits":2436.63,"poolCredits":14240.44,"accounts":7}

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

`tool/workbuddyConnect.tool.js` 是**单文件自包含**的：插件模块在被 import 的那一刻（模块顶层）就自起一个 `Bun.serve`，内置凭据发现、AES 解密、账号池、模型目录、文本对话、生图、生视频。**不需要先跑 `proxy/wb_proxy.py`**，也不依赖本仓库任何 Python 文件——从插件市场下载的人只拿到这一个 `.js` 也能用。

内置服务默认端口 **8289**（与 Python 版 8189 错开）；被占时自动顺延 8290/8291，实际端口写进 `~/.toonflow-workbuddy/port.txt`。

插件还自带六张卡片界面（积分 / 模型 / 出图 / 视频进度 / 状态 / 配置），Agent 一调用就在对话里渲染，不需要额外装东西。

### 图形界面

Toonflow →「插件市场」→ 上传 `workbuddyConnect.tool.js`。

装完在对话里说一句「用 workbuddySetup 配置一下」——它会发现凭据、起服务、把那 48 个对话模型写进「设置 → 模型供应商」。

### HTTP

**用脚本（推荐）**：

```bash
python scripts/install_tool_plugin.py           # 装 / 覆盖装，自动找端口
python scripts/install_tool_plugin.py --list    # 看装没装、有没有 loadError
python scripts/install_tool_plugin.py --disable # 关掉
```

端口自动发现顺序：`--port` → `TF_PORT` → 安装目录 `app/Resources/desktopRuntime.json`（目录本身按 `TOONFLOW_HOME`、Windows 卸载表、常见路径找）→ **正在运行的 bun.exe 监听的端口**。每一步都会真的发一次请求确认是 Toonflow，不会拿错端口。

> ⚠️ **平台行为，必须知道**：`POST /api/tools/install` 只把文件落盘，**不会执行模块**。插件的 `Bun.serve` 要等 Toonflow 真的 `import()` 才会起，而触发 import 的只有 `PUT /api/tools/setEnabled`（或第一次被 Agent 使用）。
>
> 所以脚本在 install 之后自动补了一步 `PUT /api/tools/setEnabled`，并等 `~/toonflow-workbuddy/port.txt` 里那个端口 `/healthz` 返回 200 才收工：
>
> ```
> Toonflow 端口 54149（来自 …\app\Resources\desktopRuntime.json）
> install -> HTTP 200 {"code": 200, "data": {"name": "workbuddyConnect"}, "message": "工具已安装"}
> setEnabled(True) -> HTTP 200 {"code": 200, "data": {"name": "workbuddyConnect", "enabled": true}, "message": "成功"}
> 内置服务已就绪：http://127.0.0.1:8289  {"ok":true,"pool":12,"port":8289}
> ```
>
> 手动装的话，install 之后必须再发一次：
>
> ```python
> req = urllib.request.Request(
>     f"http://127.0.0.1:{port}/api/tools/setEnabled",
>     data=json.dumps({"name": "workbuddyConnect", "enabled": True}).encode(),
>     headers={...同上三个头...}, method="PUT")
> ```
>
> 注意是 **PUT**，POST 会 404。

**手写请求**：

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

约 10 秒，回一段文字，**同时冒出一张「可用媒体模型」卡片**：

```
hunyuan-image-alpha（text-to-image）
hunyuan-image-alpha-edit（image-to-image）
kling-video-v3（text-to-video、image-to-video）3-15 秒 720P/1080P/4K
minimax-video-h3（text-to-video、image-to-video）4-15 秒 768P/2K
```

再试画图：

> 画一张暖色调产品海报，存到 assets/posters

约 15 秒出图，消耗 5.71 积分左右，卡片里直接显示生成的图片，底下是保存路径。

六张卡分别长这样：

| 工具 | 卡片 |
|---|---|
| `workbuddyCredits` | 大号积分数字 + 到期时间 + 账号池合计 |
| `workbuddyMediaModels` | 四条模型，带能力标签，点一行复制模型 id |
| `workbuddyDrawImage` | 图片预览 + 模型/尺寸/积分 + 保存路径 |
| `workbuddyDrawVideo` | 进度条（已等 N 秒）+ 出片后视频可播 |
| `workbuddyStatus` | 本地服务端口、当前账号、积分、账号数 |
| `workbuddySetup` | 写入了几个模型、写到哪个供应商 |

卡片只在**工具消息所在位置**渲染——问一句冒一张，不会固定在输入框旁边。

如果只看到文字、没有卡片：`GET /api/tools/renderers` 里应该有 `workbuddyConnect`，没有就跑 `python scripts/install_tool_plugin.py`；有但是页面显示「该工具未提供可用的交互组件」，多半是浏览器缓存了旧的 `/api/tools/client` 响应，Ctrl+R。

---

## 五、改界面（可选）

要改卡片样式或加字段，改 `client/src/` 再重新打包：

```bash
python client/build.py            # 校验 + 嵌回 tool/workbuddyConnect.tool.js
python client/build.py --check    # 只校验
python scripts/install_tool_plugin.py   # 重装（会自动 setEnabled）
```

`build.py` 干三件事：剥掉 js/css 里的块注释、用 `Bun.Transpiler.scan()` 验语法、把客户端代码压成 `.tool.js` 第 2 行的 `/*! toonflowToolClient:{…} */`。

两个坑它是替你挡掉的：

- **源码里不能有 `*/`**。第 2 行是整行匹配 `^\/\*! toonflowToolClient:([^\r\n]*) \*\/$`，任何块注释结束符都会把它提前截断，安装直接 400「工具客户端界面格式或脚本无效」。
- **`components` 名字必须与服务端工具名一一对应**，漏一个报「工具声明了组件但缺少客户端界面」。`build.py` 自动求交，不用手写。

还有一个宿主的取舍要知道：**`details` 会被丢掉**。Toonflow 转发工具结果时只保留 `content[].text` 拼出来的字符串（bun bundle 里那个 `JT(A)` 函数就干这一件事），结构化数据完全不过去。所以卡片数据是以 `<!--wbx:{…}-->` 标记追加在正文末尾的，客户端 `parseCardText()` 再抠出来——正文照旧给人看，纯文本场景不受影响。自己加工具时记得照这个套路走。

---

## 排障

### 代理起来但 `pool: 0 accounts`

凭据一个都没找到。跑这个看卡在哪一步：

```bash
python proxy/wb_creds.py
```

三条来源逐条看：

- **环境变量**：`echo %CODEBUDDY_AUTH_TOKEN%` 是不是空的
- **DSH 凭据库**：`%USERPROFILE%\.dsh\workbuddy-vault\cn\` 下有没有 `*.json`
- **桌面端**：日志里那句「桌面端：N 个账号（密钥 ok / 密钥取不到）」

「密钥取不到」通常是 exe 找不到：

```bash
python -c "import sys;sys.path.insert(0,r'proxy');import wb_creds as c;print(c.find_app_executable())"
```

返回 `None` 就手动指定：

```powershell
$env:WORKBUDDY_APP_EXECUTABLE = "E:\WorkBuddy\WorkBuddy\WorkBuddy.exe"
```

或者直接给 token，绕开本地扫描：

```powershell
$env:CODEBUDDY_AUTH_TOKEN = "<浏览器里 F12 抄的 accessToken>"
```

桌面端**只是打开没登录**也会没有凭据文件 —— 先在 WorkBuddy 里登录一次。

### `/pool/creds` 返回 404

跑的是旧版 `wb_proxy.py`。杀掉所有 `wb_proxy.py` 进程再起（Python 不热重载）。Windows 上常常有多个残留进程抢 8189，实际只有一个在 LISTEN：

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe' or Name='pythonw.exe'" |
  Where-Object CommandLine -match 'wb_proxy' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 工具不出现

`python scripts/install_tool_plugin.py --list` 里没看到 `workbuddyConnect` → 安装没成功，看返回的 `message`。

### 工具已装但内置服务没起来（8289 连不上）

这是最容易踩的一个坑：**`install` 只落文件不执行模块**。判定与修复：

```powershell
# 端口没监听
netstat -ano | Select-String 'LISTENING' | Select-String ':8289'

# port.txt 时间戳是不是刚才
Get-Item "$env:USERPROFILE\.toonflow-workbuddy\port.txt" | Select-Object LastWriteTime
```

修复：`python scripts/install_tool_plugin.py --enable`（内部就是 `PUT /api/tools/setEnabled`），然后看 `~/toonflow-workbuddy/port.txt` 是否被刷新、`curl http://127.0.0.1:8289/healthz` 是否返回 `{"ok":true,...}`。

理论上第一次被 Agent 调用时也会 import，但那时服务还没起 → 工具里连自己的服务会 ECONNREFUSED，所以装完就 setEnabled 一次最稳。

### 开机自启没生效

`install.py` 写的是 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `ToonflowWbProxy`。有些 OEM 启动项管理器（联想电脑管家等）会把第三方写入的值搬进子键 `Run\LenovoDisabled`，值变成 `rem|<原命令>`，看起来像被删了。

判定：

```powershell
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ToonflowWbProxy
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LenovoDisabled" /v ToonflowWbProxy
```

第二条有、第一条没有 → 被搬走了。两个办法：

- 在启动项管理器里把 `ToonflowWbProxy` 设为启用/允许
- 直接把快捷方式扔进 `shell:startup`（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`），OEM 管理器不碰这个目录

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
