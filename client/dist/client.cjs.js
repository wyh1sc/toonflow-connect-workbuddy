// src/index.js
(function(global, factory) {
  if (typeof exports === "object" && typeof module !== "undefined") {
    module.exports = factory(require("vue"));
  } else if (typeof define === "function" && define.amd) {
    define(["vue"], factory);
  } else {
    global = typeof globalThis !== "undefined" ? globalThis : global || self;
    global.toonflowToolViews = global.toonflowToolViews || {};
    global.toonflowToolViews.workbuddyConnect = factory(global.toonflowToolHost.vue);
  }
})(exports, function(Vue) {
  var h = Vue.h;
  var defineComponent = Vue.defineComponent;
  var computed = Vue.computed;
  var ref = Vue.ref;
  var STATUS_TEXT = {
    running: "调用中…",
    success: "已完成",
    error: "调用失败",
    interrupted: "已中断"
  };
  var STATUS_CLASS = {
    running: "wait",
    success: "ok",
    error: "err",
    interrupted: "muted"
  };
  function unwrap(raw) {
    if (raw === undefined || raw === null || raw === "")
      return null;
    if (typeof raw === "object") {
      return raw.details && typeof raw.details === "object" ? raw.details : raw;
    }
    try {
      var o = JSON.parse(String(raw));
      if (o && typeof o === "object" && o.details && typeof o.details === "object")
        return o.details;
      return o;
    } catch (e) {
      return null;
    }
  }
  function resultOf(tool) {
    return unwrap(tool && tool.result) || {};
  }
  function argsOf(tool) {
    return unwrap(tool && tool.args) || {};
  }
  function fmtNum(v) {
    var n = Number(v);
    if (!isFinite(n))
      return "—";
    var parts = n.toFixed(2).split(".");
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + parts[1];
  }
  function fmtBytes(n) {
    var b = Number(n);
    if (!isFinite(b) || b <= 0)
      return "";
    if (b < 1024)
      return b + " B";
    if (b < 1024 * 1024)
      return (b / 1024).toFixed(0) + " KB";
    return (b / 1024 / 1024).toFixed(2) + " MB";
  }
  function baseName(p) {
    var s = String(p || "");
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function fileUrl(directory, path) {
    if (!directory || !path)
      return "";
    var dir = typeof directory === "string" ? directory : directory.path || "";
    if (!dir)
      return "";
    return "/api/workspaces/files/read?directory=" + encodeURIComponent(dir) + "&path=" + encodeURIComponent(path);
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch (e2) {
      return false;
    }
  }
  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify(body || {})
    }).then(function(r) {
      return r.ok;
    });
  }
  function header(ctx) {
    return h("div", { class: "wbx-header" }, [
      h("div", { class: "wbx-logo" }, ctx.icon || "W"),
      h("div", { class: "wbx-headBody" }, [
        h("div", { class: "wbx-title" }, ctx.title || ""),
        ctx.sub ? h("div", { class: "wbx-sub" }, ctx.sub) : null
      ]),
      h("div", { class: "wbx-tags" }, [
        ctx.badge ? h("span", { class: "wbx-tag wbx-tag--info" }, ctx.badge) : null,
        h("span", { class: "wbx-tag wbx-tag--" + (STATUS_CLASS[ctx.status] || "muted") }, STATUS_TEXT[ctx.status] || ctx.status || "")
      ])
    ]);
  }
  function note(text) {
    return text ? h("p", { class: "wbx-note" }, text) : null;
  }
  function kv(rows) {
    return h("div", { class: "wbx-kv" }, rows.map(function(r) {
      return h("div", { class: "wbx-kvRow" }, [
        h("span", null, r[0]),
        h("span", null, r[1] === undefined || r[1] === null || r[1] === "" ? "—" : String(r[1]))
      ]);
    }));
  }
  function skeleton(label) {
    return h("div", { class: "wbx-skeleton" }, [h("i", { class: "wbx-dot" }), h("span", null, label || "正在准备…")]);
  }
  function btn(text, opts) {
    opts = opts || {};
    return h("button", {
      class: "wbx-btn" + (opts.primary ? " wbx-btn--primary" : ""),
      type: "button",
      title: opts.title || text,
      disabled: !!opts.disabled,
      onClick: opts.onClick
    }, text);
  }
  function cardClass(status) {
    return "wbx-card wbx-card--" + (STATUS_CLASS[status] || "muted");
  }
  var CreditsCard = defineComponent({
    name: "WorkbuddyCredits",
    props: { tool: Object, directory: [String, Object], toolSessionId: String },
    setup: function(props) {
      var res = computed(function() {
        return resultOf(props.tool);
      });
      var status = computed(function() {
        return props.tool && props.tool.status || "";
      });
      var region = computed(function() {
        return res.value.region === "global" ? "国际区" : "国内区";
      });
      return function() {
        var d = res.value;
        var ready = status.value === "success" && d && d.credits !== undefined;
        return h("div", { class: cardClass(status.value) }, [
          header({
            icon: "W",
            title: "WorkBuddy 积分",
            sub: ready ? [d.nickname || d.uid || "未知账号", region.value].join(" · ") : "正在查询额度",
            badge: d && d.accounts ? d.accounts + " 个账号" : "",
            status: status.value
          }),
          ready ? h("div", { class: "wbx-bigNum" }, [
            fmtNum(d.credits),
            h("small", null, "积分")
          ]) : skeleton("正在向账号池查询额度…"),
          ready ? kv([
            ["最近到期", d.cycleEnd],
            ["账号池合计", d.poolCredits !== undefined ? fmtNum(d.poolCredits) : ""],
            ["账号数", d.accounts]
          ]) : null,
          note(ready ? "数据来自本机内置服务 127.0.0.1:" + (d.port || 8289) : "")
        ]);
      };
    }
  });
  function modelRow(m, kind) {
    var vg = m.videoGeneration || {};
    var tags = Array.isArray(m.tags) ? m.tags : [];
    var chips = tags.map(function(t) {
      return h("span", { class: "wbx-chip" }, t === "text-to-image" ? "文生图" : t === "image-to-image" ? "图生图" : t === "text-to-video" ? "文生视频" : t === "image-to-video" ? "图生视频" : t);
    });
    var meta = "";
    if (kind === "video") {
      meta = [vg.minSeconds && vg.maxSeconds ? vg.minSeconds + "-" + vg.maxSeconds + " 秒" : "", (vg.resolutions || []).join("/")].filter(Boolean).join(" · ");
    } else if (m.credit != null || m.credits != null) {
      meta = (m.credit != null ? m.credit : m.credits) + " 积分";
    }
    return h("div", {
      class: "wbx-item",
      title: "点击复制模型 id：" + m.id,
      onClick: function() {
        copyText(m.id);
      }
    }, [h("span", { class: "wbx-itemName" }, m.id)].concat(chips).concat([h("span", { class: "wbx-itemMeta" }, meta)]));
  }
  var ModelsCard = defineComponent({
    name: "WorkbuddyMediaModels",
    props: { tool: Object, directory: [String, Object], toolSessionId: String },
    setup: function(props) {
      var res = computed(function() {
        return resultOf(props.tool);
      });
      var status = computed(function() {
        return props.tool && props.tool.status || "";
      });
      var copied = ref(false);
      return function() {
        var d = res.value || {};
        var img = Array.isArray(d.image) ? d.image : [];
        var vid = Array.isArray(d.video) ? d.video : [];
        var ready = status.value === "success" && (img.length || vid.length);
        return h("div", { class: cardClass(status.value) }, [
          header({
            icon: "⛁",
            title: "可用媒体模型",
            sub: ready ? "图片 " + img.length + " 个 · 视频 " + vid.length + " 个" : "正在拉取模型目录",
            status: status.value
          }),
          ready ? h("div", { class: "wbx-toolbar" }, [
            h("span", null, "共 " + (img.length + vid.length) + " 项"),
            copied.value ? h("span", { class: "wbx-copied" }, "已复制") : null
          ]) : null,
          ready ? h("div", { class: "wbx-list" }, [].concat(img.length ? [h("div", { class: "wbx-group" }, "图片")] : [], img.map(function(m) {
            return modelRow(m, "image");
          }), vid.length ? [h("div", { class: "wbx-group" }, "视频")] : [], vid.map(function(m) {
            return modelRow(m, "video");
          }))) : skeleton("正在读取 WorkBuddy 模型目录…"),
          note(ready ? "点任意一行复制模型 id" : "")
        ]);
      };
    }
  });
  var ImageCard = defineComponent({
    name: "WorkbuddyDrawImage",
    props: { tool: Object, directory: [String, Object], toolSessionId: String },
    setup: function(props) {
      var res = computed(function() {
        return resultOf(props.tool);
      });
      var status = computed(function() {
        return props.tool && props.tool.status || "";
      });
      var hint = ref("");
      var files = computed(function() {
        var f = res.value && res.value.files;
        return Array.isArray(f) ? f : [];
      });
      function reveal(path) {
        postJson("/api/workspaces/files/reveal", {
          directory: typeof props.directory === "string" ? props.directory : "",
          path
        }).then(function(ok) {
          hint.value = ok ? "" : "打开失败：可能不在工作区内";
        });
      }
      return function() {
        var d = res.value || {};
        var fs = files.value;
        var ready = status.value === "success" && fs.length > 0;
        var sub = [d.model, d.size, d.credit != null ? d.credit + " 积分" : ""].filter(Boolean).join(" · ");
        return h("div", { class: cardClass(status.value) }, [
          header({
            icon: "▣",
            title: ready ? "出图完成" : "生成图片",
            sub: sub || "正在生成",
            status: status.value
          }),
          ready ? h("div", { class: "wbx-media" }, fs.map(function(f) {
            var url = fileUrl(props.directory, f.path);
            return url ? h("img", { class: "wbx-img", src: url, alt: baseName(f.path), loading: "lazy" }) : h("div", { class: "wbx-mediaFallback" }, baseName(f.path));
          })) : skeleton("正在出图，通常十几秒…"),
          ready ? h("div", { class: "wbx-dest" }, fs.map(function(f) {
            return h("code", { title: f.path }, f.path);
          })) : null,
          ready ? h("div", { class: "wbx-actions" }, [
            btn("复制路径", {
              primary: true,
              onClick: function() {
                hint.value = copyText(fs.map(function(f) {
                  return f.path;
                }).join(`
`)) ? "已复制" : "复制失败";
              }
            }),
            btn("在文件夹中显示", {
              onClick: function() {
                reveal(fs[0].path);
              }
            }),
            fs[0] && fs[0].bytes ? h("span", { class: "wbx-foot" }, fmtBytes(fs[0].bytes)) : null
          ]) : null,
          hint.value ? note(hint.value) : note(ready ? "" : "")
        ]);
      };
    }
  });
  var VideoCard = defineComponent({
    name: "WorkbuddyDrawVideo",
    props: { tool: Object, directory: [String, Object], toolSessionId: String },
    setup: function(props) {
      var args = computed(function() {
        return argsOf(props.tool);
      });
      var res = computed(function() {
        return resultOf(props.tool);
      });
      var status = computed(function() {
        return props.tool && props.tool.status || "";
      });
      var hint = ref("");
      var files = computed(function() {
        var f = res.value && res.value.files;
        return Array.isArray(f) ? f : [];
      });
      return function() {
        var d = res.value || {};
        var a = args.value || {};
        var fs = files.value;
        var running = status.value === "running";
        var ready = status.value === "success" && fs.length > 0;
        var sub = [d.model || a.model, d.seconds || a.seconds ? (d.seconds || a.seconds) + " 秒" : "", d.resolution || a.resolution].filter(Boolean).join(" · ");
        return h("div", { class: cardClass(status.value) }, [
          header({
            icon: "▶",
            title: ready ? "视频生成完成" : running ? "正在生成视频" : "生成视频",
            sub: sub || "异步任务",
            status: status.value
          }),
          running ? h("div", { class: "wbx-bar" }, [h("i", null)]) : null,
          running ? h("p", { class: "wbx-note" }, "异步任务，通常 1-6 分钟，完成后这里会变成播放器。") : null,
          ready ? h("div", { class: "wbx-media" }, fs.map(function(f) {
            var url = fileUrl(props.directory, f.path);
            return url ? h("video", { class: "wbx-video", src: url, controls: true, preload: "metadata" }) : h("div", { class: "wbx-mediaFallback" }, baseName(f.path));
          })) : null,
          ready ? h("div", { class: "wbx-dest" }, fs.map(function(f) {
            return h("code", { title: f.path }, f.path);
          })) : null,
          ready ? h("div", { class: "wbx-actions" }, [
            btn("复制路径", {
              primary: true,
              onClick: function() {
                hint.value = copyText(fs.map(function(f) {
                  return f.path;
                }).join(`
`)) ? "已复制" : "复制失败";
              }
            }),
            fs[0] && fs[0].bytes ? h("span", { class: "wbx-foot" }, fmtBytes(fs[0].bytes)) : null
          ]) : null,
          d && d.taskId ? note("任务 " + d.taskId) : hint.value ? note(hint.value) : null
        ]);
      };
    }
  });
  var StatusCard = defineComponent({
    name: "WorkbuddyStatus",
    props: { tool: Object, directory: [String, Object], toolSessionId: String },
    setup: function(props) {
      var res = computed(function() {
        return resultOf(props.tool);
      });
      var status = computed(function() {
        return props.tool && props.tool.status || "";
      });
      return function() {
        var d = res.value || {};
        var srv = d.server || {};
        var bal = d.balance || {};
        var ready = status.value === "success";
        return h("div", { class: cardClass(status.value) }, [
          header({
            icon: "◎",
            title: "WorkBuddy 状态",
            sub: srv.ok ? "本地服务 127.0.0.1:" + srv.port + (srv.own ? "（内置）" : "（复用）") : "服务未启动",
            status: status.value
          }),
          ready ? kv([
            ["本地服务", srv.ok ? "127.0.0.1:" + srv.port : srv.error || "未启动"],
            ["当前账号", bal.nickname || bal.uid],
            ["剩余积分", bal.credits !== undefined ? fmtNum(bal.credits) : ""],
            ["账号池合计", bal.poolCredits !== undefined ? fmtNum(bal.poolCredits) : ""],
            ["账号数", bal.accounts]
          ]) : skeleton("正在检查服务与账号…"),
          note(ready ? "" : "")
        ]);
      };
    }
  });
  var SetupCard = defineComponent({
    name: "WorkbuddySetup",
    props: { tool: Object, directory: [String, Object], toolSessionId: String },
    setup: function(props) {
      var res = computed(function() {
        return resultOf(props.tool);
      });
      var status = computed(function() {
        return props.tool && props.tool.status || "";
      });
      return function() {
        var d = res.value || {};
        var srv = d.server || {};
        var ready = status.value === "success";
        var ok = ready && srv.ok && (d.models || d.accounts);
        return h("div", { class: cardClass(ok ? status.value : ready ? "error" : status.value) }, [
          header({
            icon: "⚙",
            title: "WorkBuddy 配置",
            sub: srv.ok ? "服务已就绪 · 模型 " + (d.models || 0) + " 个" : "正在初始化",
            status: ok || !ready ? status.value : "error"
          }),
          ready ? kv([
            ["本地服务", srv.ok ? "127.0.0.1:" + srv.port : srv.error || "未启动"],
            ["可用账号", d.accounts != null ? d.accounts + " 个" : ""],
            ["写入模型", d.models != null ? d.models + " 个" : "未写入"],
            ["Toonflow", d.tfPort ? "端口 " + d.tfPort : "未发现"]
          ]) : skeleton("正在发现凭据并启动服务…"),
          ready && ok ? note("已写入 model provider，去「设置 → 模型供应商 → WorkBuddy」挑模型即可。") : null,
          ready && !ok ? note("没自动完成：确认本机装了并登录 WorkBuddy 桌面端，或设置环境变量 CODEBUDDY_AUTH_TOKEN。") : null
        ]);
      };
    }
  });
  return {
    workbuddyCredits: CreditsCard,
    workbuddyMediaModels: ModelsCard,
    workbuddyDrawImage: ImageCard,
    workbuddyDrawVideo: VideoCard,
    workbuddyStatus: StatusCard,
    workbuddySetup: SetupCard
  };
});
