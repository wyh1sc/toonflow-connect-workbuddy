/* Toonflow 账号池面板 —— 注入脚本
 * 数据来自 WorkBuddy 代理的 /pool/* 接口：
 * 优先 workbuddyConnect 插件的内置服务（127.0.0.1:8289），退回 Python 版 wb_proxy.py（8189）。
 * 按钮挂在输入框工具栏，点开后是仿 DSH 插件样式的账号池面板。
 */
(function () {
  "use strict";

  // 代理可能有两个落点：8289 = workbuddyConnect 插件内置服务（优先），8189 = 老的 Python 版。
  // 启动时两个都探一次，谁通用谁；之后固定用探到的那个。
  var API_CANDIDATES = ["http://127.0.0.1:8289", "http://127.0.0.1:8189"];
  var API = API_CANDIDATES[0];
  var API_FIXED = false;

  var BTN_CLS = "tf-pool-btn";
  var PANEL_ID = "tf-pool-panel";
  var booted = false;
  var panelEl = null;
  var data = null;
  var online = false;
  var timer = null;
  var busyUid = "";

  var WALLET_SVG =
    '<svg class="tf-p-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7"/>' +
    '<path d="M16 12h.01"/></svg>';

  function fmt(n) {
    if (typeof n !== "number") return "—";
    return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 后端有两种返回形态：/pool/accounts 直接给快照，其余写操作给 {ok, snapshot}。
  // 统一在这里剥一层，别让面板把 {"ok":true,...} 当快照渲染（合计会变 0）。
  function snapOf(j) {
    if (j && j.snapshot) {
      var s = j.snapshot;
      if (j.checkin) s.checkin = j.checkin;
      return s;
    }
    return j;
  }

  // 轻提示：不打断操作，也不像 alert 那样卡住面板。
  function toast(text) {
    try {
      var el = document.getElementById(PANEL_ID + "-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = PANEL_ID + "-toast";
        el.style.cssText =
          "position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:2147483600;" +
          "max-width:min(560px,86vw);padding:10px 16px;border-radius:10px;font-size:13px;line-height:1.5;" +
          "background:rgba(28,32,38,.94);color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35);" +
          "opacity:0;transition:opacity .18s;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere;";
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.opacity = "1";
      clearTimeout(el.__t);
      el.__t = setTimeout(function () {
        el.style.opacity = "0";
      }, 3200);
    } catch (e) {
      /* ignore */
    }
  }

  // 签到结果：只报失败的那几个，全成功就一句汇总。
  function reportCheckin(j) {
    var res = (j && j.checkin) || [];
    if (!res.length) return;
    var bad = res.filter(function (r) { return !r.ok; });
    if (!bad.length) {
      var done = res.filter(function (r) { return !r.already; }).length;
      toast(done ? "签到完成：新签到 " + done + " 个账号" : "所有账号今天都已签到");
      return;
    }
    toast("签到失败 " + bad.length + " 个：" +
      bad.map(function (r) {
        var acc = (j.accounts || []).filter(function (a) { return a.uid === r.uid; })[0] || {};
        return (acc.nickname || r.uid) + "（" + (r.message || "未知原因") + "）";
      }).join("；"));
  }

  var CSS = [
    "." + BTN_CLS + "{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;",
    "padding:0 9px;box-sizing:border-box;border:1px solid rgba(128,128,128,.35);border-radius:14px;",
    "background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;user-select:none;",
    "white-space:nowrap;opacity:.85;transition:opacity .15s,border-color .15s,background .15s;margin:0 4px;font-family:inherit;}",
    "." + BTN_CLS + ".compact{width:30px;height:30px;padding:0;margin:0 2px;border-radius:50%;}",
    "." + BTN_CLS + ":hover{opacity:1;background:rgba(128,128,128,.14);border-color:rgba(128,128,128,.6);}",
    "." + BTN_CLS + ".off{opacity:.5;}",
    "." + BTN_CLS + " .tf-p-num{font-variant-numeric:tabular-nums;}"
  ].join("");

  var PANEL_CSS = [
    "#" + PANEL_ID + "{position:fixed;inset:0;z-index:2147483000;display:none;",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;}",
    "#" + PANEL_ID + ".open{display:block;}",
    "#" + PANEL_ID + " .tf-pmask{position:absolute;inset:0;background:rgba(0,0,0,.32);}",
    "#" + PANEL_ID + " .tf-pbox{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);",
    "width:min(860px,calc(100vw - 40px));max-height:min(78vh,760px);display:flex;flex-direction:column;",
    "background:var(--tf-p-bg,#fff);color:var(--tf-p-fg,#1f2329);border-radius:12px;",
    "box-shadow:0 18px 60px rgba(0,0,0,.28);overflow:hidden;}",
    "#" + PANEL_ID + " .tf-phead{display:flex;align-items:center;gap:10px;padding:16px 20px 12px;}",
    "#" + PANEL_ID + " .tf-ptitle{font-size:17px;font-weight:600;}",
    "#" + PANEL_ID + " .tf-pclose{margin-left:auto;border:0;background:transparent;font-size:20px;line-height:1;",
    "cursor:pointer;color:inherit;opacity:.55;padding:4px 6px;border-radius:6px;}",
    "#" + PANEL_ID + " .tf-pclose:hover{opacity:1;background:rgba(128,128,128,.14);}",
    "#" + PANEL_ID + " .tf-pbody{padding:0 20px 18px;overflow:auto;}",
    "#" + PANEL_ID + " .tf-pcur{display:inline-flex;align-items:center;gap:6px;font-size:13px;padding:4px 12px;",
    "border-radius:999px;background:#e8f6ed;color:#257a45;font-weight:600;}",
    "#" + PANEL_ID + " .tf-pmodes{display:flex;align-items:center;gap:12px;padding:12px 16px;margin:6px 0 14px;",
    "border-radius:10px;background:rgba(64,120,255,.06);border:1px solid rgba(64,120,255,.14);}",
    "#" + PANEL_ID + " .tf-pmodeMsg{font-size:12.5px;line-height:1.65;color:var(--tf-p-dim,#5c6470);}",
    "#" + PANEL_ID + " .tf-psw{position:relative;width:42px;height:23px;flex:0 0 auto;border-radius:999px;",
    "background:#c8ccd4;cursor:pointer;transition:background .18s;border:0;padding:0;}",
    "#" + PANEL_ID + " .tf-psw::after{content:'';position:absolute;top:2px;left:2px;width:19px;height:19px;",
    "border-radius:50%;background:#fff;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.25);}",
    "#" + PANEL_ID + " .tf-psw.on{background:#3b82f6;}",
    "#" + PANEL_ID + " .tf-psw.on::after{transform:translateX(19px);}",
    "#" + PANEL_ID + " .tf-pswlab{font-size:13.5px;font-weight:600;white-space:nowrap;}",
    "#" + PANEL_ID + " .tf-ptag{font-size:11.5px;padding:2px 8px;border-radius:999px;background:rgba(59,130,246,.12);",
    "color:#2563eb;font-weight:600;}",
    "#" + PANEL_ID + " .tf-pbar{display:flex;align-items:center;gap:10px;margin:16px 0 8px;}",
    "#" + PANEL_ID + " .tf-pbar .tf-pname{font-size:14px;font-weight:600;}",
    "#" + PANEL_ID + " .tf-pbar .tf-psel{font-size:12.5px;color:var(--tf-p-dim,#5c6470);margin-left:auto;}",
    "#" + PANEL_ID + " .tf-pacts{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap;}",
    "#" + PANEL_ID + " .tf-pb{height:30px;padding:0 13px;border-radius:8px;border:1px solid rgba(128,128,128,.32);",
    "background:transparent;color:inherit;font-size:12.5px;cursor:pointer;font-family:inherit;}",
    "#" + PANEL_ID + " .tf-pb:hover{background:rgba(128,128,128,.1);}",
    "#" + PANEL_ID + " .tf-pb.dark{background:#1f2329;color:#fff;border-color:#1f2329;font-weight:600;}",
    "#" + PANEL_ID + " .tf-pb.sm{height:26px;padding:0 10px;font-size:12px;}",
    "#" + PANEL_ID + " .tf-pb:disabled{opacity:.45;cursor:not-allowed;}",
    "#" + PANEL_ID + " .tf-prow{display:grid;grid-template-columns:24px minmax(150px,1fr) 122px 96px 84px 142px;",
    "align-items:center;gap:10px;padding:14px 8px;border-top:1px solid rgba(128,128,128,.14);}",
    "#" + PANEL_ID + " .tf-prow.hd{border-top:0;font-size:12px;color:var(--tf-p-dim,#5c6470);padding:8px 10px;}",
    "#" + PANEL_ID + " .tf-prow.on{background:rgba(59,130,246,.045);}",
    "#" + PANEL_ID + " .tf-pchk{width:16px;height:16px;cursor:pointer;accent-color:#1f2329;}",
    "#" + PANEL_ID + " .tf-pnm{font-size:14px;font-weight:600;display:flex;align-items:center;gap:7px;",
    "flex-wrap:nowrap;min-width:0;}",
    "#" + PANEL_ID + " .tf-pnm>span.tf-pnmtxt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    "#" + PANEL_ID + " .tf-pdot{width:7px;height:7px;border-radius:50%;background:#9aa0a6;flex:0 0 auto;}",
    "#" + PANEL_ID + " .tf-pdot.ok{background:#22c55e;}",
    "#" + PANEL_ID + " .tf-pdot.warn{background:#f59e0b;}",
    "#" + PANEL_ID + " .tf-pdot.bad{background:#ef4444;}",
    "#" + PANEL_ID + " .tf-psub{font-size:11.5px;color:var(--tf-p-dim,#5c6470);margin-top:3px;}",
    "#" + PANEL_ID + " .tf-pcr{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;}",
    "#" + PANEL_ID + " .tf-pcrs{font-size:11.5px;color:var(--tf-p-dim,#5c6470);margin-top:3px;white-space:nowrap;}",
    "#" + PANEL_ID + " .tf-pst{font-size:12.5px;line-height:1.55;}",
    "#" + PANEL_ID + " .tf-pst .g{color:#22a55b;}",
    "#" + PANEL_ID + " .tf-pst .r{color:#e5484d;}",
    "#" + PANEL_ID + " .tf-pci{font-size:12.5px;font-weight:600;}",
    "#" + PANEL_ID + " .tf-pci.y{color:#22a55b;}",
    "#" + PANEL_ID + " .tf-pci.n{color:#e5484d;}",
    "#" + PANEL_ID + " .tf-pbtns{display:flex;gap:6px;justify-content:flex-end;}",
    "#" + PANEL_ID + " .tf-pcurTag{font-size:10.5px;padding:1px 6px;border-radius:999px;background:#22c55e;",
    "color:#fff;white-space:nowrap;flex:0 0 auto;line-height:1.5;}",
    "#" + PANEL_ID + " .tf-pfoot{padding:10px 20px 14px;font-size:11.5px;color:var(--tf-p-dim,#5c6470);",
    "border-top:1px solid rgba(128,128,128,.14);}",
    "#" + PANEL_ID + " .tf-pempty{padding:30px;text-align:center;font-size:13px;color:var(--tf-p-dim,#5c6470);}"
  ].join("");

  function ensureCSS() {
    if (document.getElementById("tf-pool-css")) return;
    var s = document.createElement("style");
    s.id = "tf-pool-css";
    s.textContent = CSS + PANEL_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function isDark() {
    var h = document.documentElement;
    var b = document.body;
    if (h.classList && h.classList.contains("dark")) return true;
    if (b && b.classList && b.classList.contains("dark")) return true;
    var t = h.getAttribute("data-theme") || (b && b.getAttribute("data-theme")) || "";
    if (t === "dark") return true;
    try {
      if (getComputedStyle(h).colorScheme === "dark") return true;
    } catch (e) { /* ignore */ }
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function api(path, opts) {
    return fetch(API + path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // 探一遍所有候选端口，把 API 定到能用的那个。全部失败返回 false。
  // 定了之后也不是永久锁定：哪个端口缺 /pool/checkin 这类路由，就自动往下一个候选退。
  function probeApi() {
    if (API_FIXED) return Promise.resolve(online);
    var i = 0;
    function next() {
      if (i >= API_CANDIDATES.length) return Promise.resolve(false);
      var base = API_CANDIDATES[i++];
      return fetch(base + "/pool/accounts", { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (j) {
          API = base;
          API_FIXED = true;
          online = true;
          data = snapOf(j);
          return true;
        })
        .catch(function () { return next(); });
    }
    return next();
  }

  // 某个接口在 8289 上不存在（旧版插件只有账号池，没有签到/测试），
  // 退到候选里的下一个端口再试一次，别让按钮卡住。
  function fallbackApi() {
    var idx = API_CANDIDATES.indexOf(API);
    for (var k = idx + 1; k < API_CANDIDATES.length; k++) {
      if (API_CANDIDATES[k] !== API) { API = API_CANDIDATES[k]; return true; }
    }
    return false;
  }

  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).catch(function (e) {
      // HTTP 404 表示这个端口的代理不认这个接口，换一个端口重试一次
      if (/HTTP 404/.test(e.message) && fallbackApi()) {
        return api(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {})
        });
      }
      throw e;
    });
  }

  // ---------------- 扫码登录 ----------------

  // 扫码加号：state 由上游签发，二维码内容就是 authUrl；
  // 扫完这边轮询换 token，再交给 /pool/login/commit 落库并刷新账号池。
  function openLogin() {
    var old = document.getElementById(PANEL_ID + "-login");
    if (old) old.remove();
    var box = document.createElement("div");
    box.id = PANEL_ID + "-login";
    box.style.cssText =
      "position:fixed;inset:0;z-index:2147483601;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.42);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;";
    box.innerHTML =
      '<div class="tf-lg" style="width:min(420px,92vw);background:var(--tf-p-bg,#fff);color:var(--tf-p-fg,#1f2329);' +
        'border-radius:14px;padding:22px 24px 18px;box-shadow:0 18px 60px rgba(0,0,0,.32);text-align:center;">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
          '<b style="font-size:16px;">扫码添加账号</b>' +
          '<button class="tf-pclose" data-lg="close" style="margin-left:auto;border:0;background:transparent;' +
            'font-size:20px;line-height:1;cursor:pointer;opacity:.55;color:inherit;">×</button></div>' +
        '<div style="font-size:12.5px;opacity:.7;margin-bottom:14px;">用要加入的手机扫码，登录后自动进池</div>' +
        '<div style="display:flex;gap:6px;justify-content:center;margin-bottom:14px;">' +
          '<button class="tf-pb sm" data-lg="region" data-v="cn">国内版</button>' +
          '<button class="tf-pb sm" data-lg="region" data-v="global">国际版</button></div>' +
        '<div data-lg="qr" style="display:flex;justify-content:center;align-items:center;min-height:180px;">' +
          '<span style="font-size:13px;opacity:.6;">正在申请…</span></div>' +
        '<div data-lg="msg" style="margin-top:12px;font-size:12.5px;min-height:20px;opacity:.8;"></div>' +
        '<div style="margin-top:8px;font-size:11.5px;opacity:.55;overflow-wrap:anywhere;" data-lg="url"></div>' +
      '</div>';
    document.body.appendChild(box);

    var region = "cn";
    var loginId = "";
    var timer = null;
    var doneFlag = false;

    function $(sel) { return box.querySelector('[data-lg="' + sel + '"]'); }
    function msg(t) { $("msg").textContent = t; }

    function stop() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function close() {
      doneFlag = true;
      stop();
      box.remove();
    }

    function drawQr(url) {
      var host = $("qr");
      host.innerHTML = "";
      try {
        if (!window.qrcode) throw new Error("qrlib 未加载");
        var q = window.qrcode(0, "M");
        q.addData(url);
        q.make();
        var wrap = document.createElement("div");
        wrap.style.cssText =
          "width:190px;height:190px;padding:8px;background:#fff;border-radius:10px;box-shadow:0 0 0 1px rgba(128,128,128,.28);";
        wrap.innerHTML = q.createSvgTag({ cellSize: 5, margin: 2 });
        var svg = wrap.querySelector("svg");
        if (svg) { svg.style.width = "100%"; svg.style.height = "100%"; svg.style.display = "block"; }
        host.appendChild(wrap);
      } catch (e) {
        host.innerHTML = '<span style="font-size:12.5px;opacity:.75;">二维码画不出来，请直接打开下面的链接</span>';
      }
    }

    function poll() {
      if (doneFlag) return;
      post("/pool/login/poll", { loginId: loginId, region: region }).then(function (r) {
        if (doneFlag) return;
        if (r && r.done && r.ok && r.account) {
          doneFlag = true;
          msg("登录成功，正在写入账号池…");
          post("/pool/login/commit", { account: r.account }).then(function (res) {
            if (res && res.ok) {
              data = res.snapshot || data;
              renderPanel(); renderButtons();
              msg("已添加：" + (res.nickname || res.uid) + "（" + (res.region === "global" ? "国际版" : "国内版") + "）");
              toast("已添加账号 " + (res.nickname || res.uid));
              setTimeout(close, 1400);
            } else {
              msg("写入失败：" + ((res && res.message) || "未知原因"));
            }
          }).catch(function (e) { msg("写入失败：" + e.message); });
          return;
        }
        if (r && r.done && !r.ok) { doneFlag = true; stop(); msg(r.message || "登录结束"); return; }
        msg((r && r.message) || "等待扫码…");
        timer = setTimeout(poll, 1500);
      }).catch(function (e) {
        if (doneFlag) return;
        msg("轮询失败：" + e.message);
        timer = setTimeout(poll, 3000);
      });
    }

    function start() {
      stop();
      doneFlag = false;
      $("qr").innerHTML = '<span style="font-size:13px;opacity:.6;">正在申请…</span>';
      msg("");
      $("url").textContent = "";
      var btns = box.querySelectorAll('[data-lg="region"]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].style.opacity = btns[i].getAttribute("data-v") === region ? "1" : ".45";
        btns[i].style.fontWeight = btns[i].getAttribute("data-v") === region ? "700" : "400";
      }
      post("/pool/login/start", { region: region }).then(function (r) {
        if (!r || !r.ok) { msg((r && r.message) || "申请失败"); return; }
        loginId = r.loginId;
        drawQr(r.authUrl);
        $("url").textContent = r.authUrl;
        msg("请用手机扫码，或在浏览器打开下面的链接");
        poll();
      }).catch(function (e) { msg("申请失败：" + e.message); });
    }

    box.addEventListener("click", function (ev) {
      var t = ev.target.closest("[data-lg]");
      if (!t) {
        if (ev.target === box) close();
        return;
      }
      var act = t.getAttribute("data-lg");
      if (act === "close") { close(); return; }
      if (act === "region") {
        region = t.getAttribute("data-v");
        start();
        return;
      }
    });

    start();
  }

  // ---------------- 按钮 ----------------

  function label() {
    if (!online) return "账号池";
    if (!data) return "账号池";
    return "账号池 · " + fmt(data.totalCredits);
  }

  function renderButtons() {
    var list = document.querySelectorAll("." + BTN_CLS);
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var num = b.querySelector(".tf-p-num");
      if (num) num.textContent = label().replace("账号池 · ", "");
      b.title = online ? ("账号池 共 " + fmt(data ? data.totalCredits : 0) + " 积分，点击管理")
                       : "代理（8289/8189）都未运行，点旁边的「启动服务」会自动拉起";
      if (!online) b.classList.add("off"); else b.classList.remove("off");
    }
  }

  function buildButton(compact) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = BTN_CLS + (compact ? " compact" : " off");
    b.innerHTML = compact
      ? WALLET_SVG
      : WALLET_SVG + '<span class="tf-p-num">账号池</span>';
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openPanel();
    });
    b.addEventListener("mousedown", function (ev) { ev.stopPropagation(); });
    return b;
  }

  function ensureIn(host, compact, prepend) {
    if (host.querySelector(":scope > ." + BTN_CLS)) return false;
    // 插在「启动服务」按钮后面
    var launch = host.querySelector(".tf-launch-btn");
    var btn = buildButton(compact);
    if (launch && launch.parentNode === host) {
      host.insertBefore(btn, launch.nextSibling);
    } else if (prepend) {
      host.insertBefore(btn, host.firstChild);
    } else {
      host.appendChild(btn);
    }
    return true;
  }

  function ensureButtons() {
    ensureCSS();
    var changed = false, i;
    var tools = document.querySelectorAll(".composerTools");
    for (i = 0; i < tools.length; i++) if (ensureIn(tools[i], false, false)) changed = true;
    var actions = document.querySelectorAll(".senderActions");
    for (i = 0; i < actions.length; i++) if (ensureIn(actions[i], true, true)) changed = true;
    var footers = document.querySelectorAll(".composerFooter");
    for (i = 0; i < footers.length; i++) {
      if (footers[i].querySelector("." + BTN_CLS)) continue;
      if (footers[i].querySelector(".composerTools, .senderActions")) continue;
      if (ensureIn(footers[i], false, true)) changed = true;
    }
    if (changed) renderButtons();
  }

  // ---------------- 面板 ----------------

  function panel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement("div");
    panelEl.id = PANEL_ID;
    panelEl.innerHTML =
      '<div class="tf-pmask"></div>' +
      '<div class="tf-pbox" role="dialog" aria-modal="true">' +
      '  <div class="tf-phead"><div class="tf-ptitle">账号池</div>' +
      '    <span class="tf-pcur" data-cur></span>' +
      '    <button class="tf-pclose" title="关闭">×</button></div>' +
      '  <div class="tf-pbody" data-body></div>' +
      '  <div class="tf-pfoot" data-foot></div>' +
      '</div>';
    document.body.appendChild(panelEl);
    panelEl.querySelector(".tf-pmask").addEventListener("click", closePanel);
    panelEl.querySelector(".tf-pclose").addEventListener("click", closePanel);
    panelEl.addEventListener("click", onPanelClick);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && panelEl.classList.contains("open")) closePanel();
    });
    return panelEl;
  }

  function applyTheme() {
    if (!panelEl) return;
    var dark = isDark();
    panelEl.style.setProperty("--tf-p-bg", dark ? "#22262c" : "#fff");
    panelEl.style.setProperty("--tf-p-fg", dark ? "#e6e8eb" : "#1f2329");
    panelEl.style.setProperty("--tf-p-dim", dark ? "#9aa0a6" : "#5c6470");
  }

  function openPanel() {
    panel();
    applyTheme();
    panelEl.classList.add("open");
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (panelEl && panelEl.classList.contains("open")) refresh(true);
    }, 20000);
  }

  function closePanel() {
    if (!panelEl) return;
    panelEl.classList.remove("open");
    if (timer) { clearInterval(timer); timer = null; }
  }

  function refresh(silent) {
    var ready = API_FIXED ? Promise.resolve(online) : probeApi();
    return ready.then(function (ok) {
      if (!ok) {
        online = false;
        renderButtons();
        if (!silent) renderPanel();
        return;
      }
      return api("/pool/accounts").then(function (j) {
        online = true;
        data = snapOf(j);
        renderButtons();
        renderPanel();
      }).catch(function () {
        online = false;
        API_FIXED = false;
        renderButtons();
        if (!silent) renderPanel();
      });
    });
  }

  function renderPanel() {
    if (!panelEl) return;
    applyTheme();
    var body = panelEl.querySelector("[data-body]");
    var foot = panelEl.querySelector("[data-foot]");
    var cur = panelEl.querySelector("[data-cur]");

    if (!online || !data) {
      cur.textContent = "";
      body.innerHTML = '<div class="tf-pempty">代理（8289/8189）都未运行。<br>点界面上的「启动服务」按钮会自动拉起。</div>';
      foot.textContent = "";
      return;
    }

    var act = null;
    for (var i = 0; i < data.accounts.length; i++) {
      if (data.accounts[i].active) act = data.accounts[i];
    }
    cur.textContent = "当前使用：" + (act ? act.nickname : "无");

    var on = data.mode === "auto";
    var enabledCount = 0;
    for (var k = 0; k < data.accounts.length; k++) if (data.accounts[k].enabled) enabledCount++;

    var html = "";
    html += '<div class="tf-pmodes">' +
      '<button class="tf-psw' + (on ? " on" : "") + '" data-act="mode" data-mode="' +
        (on ? "off" : "auto") + '" title="' + (on ? "点此关闭自动挑号" : "点此开启自动挑号") + '"></button>' +
      '<span class="tf-pswlab">启用账号池</span>' +
      '<span class="tf-ptag">' + (on ? "自动挑号" : "固定账号") + '</span>' +
      '<span class="tf-pmodeMsg">' +
        (on ? "开启：每次请求按剩余积分挑一个可用账号；只有换号有意义的失败才切下一个。"
            : "关闭：只用当前选中的账号，失败如实报错。") +
      '</span></div>';

    html += '<div class="tf-pbar"><span class="tf-pname">本池包含的账号</span>' +
      '<span class="tf-psel">已选 ' + enabledCount + ' / ' + data.accounts.length + '</span>' +
      '<button class="tf-pb sm" data-act="all" data-on="1">全选</button>' +
      '<button class="tf-pb sm" data-act="all" data-on="0">全不选</button></div>';

    var checkedIn = 0;
    for (var c = 0; c < data.accounts.length; c++) if (data.accounts[c].checkedIn) checkedIn++;

    html += '<div class="tf-pacts">' +
      '<button class="tf-pb dark" data-act="checkinAll"' + (checkedIn === data.accounts.length ? " disabled" : "") +
        '>签到全部账号</button>' +
      '<button class="tf-pb" data-act="refresh">刷新积分</button>' +
      '<button class="tf-pb" data-act="login">扫码添加账号</button>' +
      '<span style="margin-left:auto;font-size:12.5px;align-self:center;opacity:.7">合计 ' +
        fmt(data.totalCredits) + ' 积分</span></div>';

    html += '<div class="tf-prow hd"><span></span><span>账号</span><span>积分</span>' +
      '<span>状态</span><span>签到</span><span></span></div>';

    if (!data.accounts.length) {
      html += '<div class="tf-pempty">vault 里没找到凭据</div>';
    }

    for (var j = 0; j < data.accounts.length; j++) {
      var a = data.accounts[j];
      var cooling = a.cooldown > 0;
      var dotCls = !a.enabled ? "" : (a.error ? "bad" : (cooling ? "warn" : "ok"));
      var statusTxt;
      if (a.error) statusTxt = '<span class="r">' + esc(a.error) + '</span>';
      else if (cooling) statusTxt = '<span class="r">冷却 ' + a.cooldown + 's</span>';
      else statusTxt = '<span class="g">可用</span>';
      var busy = busyUid === a.uid;
      html += '<div class="tf-prow' + (a.active ? " on" : "") + '">' +
        '<input type="checkbox" class="tf-pchk" data-act="toggle" data-uid="' + esc(a.uid) + '"' +
          (a.enabled ? " checked" : "") + '>' +
        '<div><div class="tf-pnm"><span class="tf-pdot ' + dotCls + '"></span><span class="tf-pnmtxt">' +
          esc(a.nickname) + '</span>' +
          (a.active ? '<span class="tf-pcurTag">当前</span>' : '') + '</div>' +
          '<div class="tf-psub">' + esc(a.uin) + ' · ' + esc(a.region === "global" ? "国际" : "国内") +
          (a.creditsAge != null ? ' · ' + Math.round(a.creditsAge / 60) + ' 分钟前检测' : '') + '</div></div>' +
        '<div><div class="tf-pcr">' + fmt(a.credits) + '</div>' +
          '<div class="tf-pcrs">' + (a.cycleEnd ? esc(a.cycleEnd.slice(0, 10)) + ' 到期' : '') + '</div></div>' +
        '<div class="tf-pst">' + statusTxt + '</div>' +
        '<div><span class="tf-pci ' + (a.checkedIn ? "y" : (a.checkinError ? "n" : "")) + '">' +
          (a.checkedIn ? "已签到" : (a.checkinError ? "签到失败" : "未签到")) + '</span>' +
          (a.streak ? '<div class="tf-psub">连签 ' + a.streak + ' 天</div>' : '') +
          (a.checkinError ? '<div class="tf-psub r" title="' + esc(a.checkinError) + '">' +
            esc(String(a.checkinError).slice(0, 18)) + '</div>' : '') + '</div>' +
        '<div class="tf-pbtns">' +
          (a.checkedIn ? '' : '<button class="tf-pb sm" data-act="checkin" data-uid="' + esc(a.uid) + '"' +
            (busyUid === a.uid ? " disabled" : "") + '>' + (busyUid === a.uid ? "签到中" : "签到") + '</button>') +
          '<button class="tf-pb sm" data-act="test" data-uid="' + esc(a.uid) + '"' + (busy ? " disabled" : "") + '>' +
            (busy ? "测试中" : "测试") + '</button>' +
          (a.active ? '' : '<button class="tf-pb sm" data-act="use" data-uid="' + esc(a.uid) + '">用此号</button>') +
        '</div></div>';
    }

    body.innerHTML = html;
    foot.textContent = "数据源 WorkBuddy 代理（插件内置 8289 / Python 版 8189）· 积分每 10 分钟自动刷新 · 换号只看账号维度错误（积分耗尽 / 账号受限）";
  }

  function onPanelClick(ev) {
    var t = ev.target.closest("[data-act]");
    if (!t) return;
    var act = t.getAttribute("data-act");
    // 统一兜底：任何操作失败都要把按钮恢复，不能卡在「签到中…」。
    function fail(e) {
      busyUid = "";
      renderPanel();
      renderButtons();
      toast((act === "checkin" || act === "checkinAll" ? "签到失败：" : "操作失败：") + (e && e.message ? e.message : e));
    }
    if (act === "mode") {
      post("/pool/mode", { mode: t.getAttribute("data-mode") }).then(function (j) {
        data = snapOf(j); renderPanel(); renderButtons();
      }).catch(fail);
      return;
    }
    if (act === "toggle") {
      post("/pool/toggle", { uid: t.getAttribute("data-uid"), enabled: t.checked })
        .then(function (j) { data = snapOf(j); renderPanel(); })
        .catch(fail);
      return;
    }
    if (act === "all") {
      var on = t.getAttribute("data-on") === "1";
      var seq = Promise.resolve();
      data.accounts.forEach(function (a) {
        seq = seq.then(function () {
          return post("/pool/toggle", { uid: a.uid, enabled: on });
        }).then(function (j) { data = snapOf(j); });
      });
      seq.then(function () { renderPanel(); }).catch(fail);
      return;
    }
    if (act === "refresh") {
      t.disabled = true;
      t.textContent = "刷新中…";
      post("/pool/refresh", {}).then(function (j) { data = snapOf(j); renderPanel(); }).catch(fail);
      return;
    }
    if (act === "login") {
      openLogin();
      return;
    }
    if (act === "checkin") {
      busyUid = t.getAttribute("data-uid");
      renderPanel();
      post("/pool/checkin", { uid: busyUid }).then(function (j) {
        busyUid = "";
        data = snapOf(j);
        renderPanel();
        reportCheckin(j);
      }).catch(fail);
      return;
    }
    if (act === "checkinAll") {
      t.disabled = true;
      t.textContent = "签到中…";
      post("/pool/checkin", {}).then(function (j) {
        data = snapOf(j);
        renderPanel();
        reportCheckin(j);
      }).catch(fail);
      return;
    }
    if (act === "use") {
      // 固定账号必须写 fixedUid：后端读的是 fixedUid，不是 uid。
      var uid = t.getAttribute("data-uid");
      post("/pool/mode", { mode: "fixed", fixedUid: uid }).then(function (j) {
        data = snapOf(j); renderPanel(); renderButtons();
      }).catch(fail);
      return;
    }
    if (act === "test") {
      var u = t.getAttribute("data-uid");
      busyUid = u;
      renderPanel();
      post("/pool/test", { uid: u }).then(function (r) {
        busyUid = "";
        renderPanel();
        var head = r.ok ? "✓ 账号可用" : "✗ 账号不可用";
        var kindTxt = {
          policy_reject: "（策略拒绝，不是登录问题，换号也没用）",
          soft_rate: "（限流）",
          hard_credit: "（积分耗尽）",
          session_dead: "（凭据失效）",
          model_busy: "（模型繁忙）",
          server: "（上游异常）",
          client: "（请求不合法）"
        }[r.kind] || "";
        toast(head + kindTxt + "\n" + (r.nickname || "") + "\n" + (r.message || ""));
      }).catch(function (e) {
        busyUid = "";
        renderPanel();
        toast("测试失败：" + e.message);
      });
      return;
    }
  }

  // ---------------- 启动 ----------------

  function boot() {
    if (booted) return;
    booted = true;
    ensureCSS();
    ensureButtons();
    refresh(true);
    try {
      var mo = new MutationObserver(function () { ensureButtons(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
    setInterval(ensureButtons, 2500);
    setInterval(function () {
      if (!panelEl || !panelEl.classList.contains("open")) {
        api("/pool/accounts").then(function (j) {
          online = true; data = j; renderButtons();
        }).catch(function () { online = false; renderButtons(); });
      }
    }, 30000);
    window.__toonflowPool = { open: openPanel, close: closePanel, refresh: refresh,
                              data: function () { return data; } };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
