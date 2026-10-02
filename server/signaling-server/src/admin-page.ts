/**
 * Token management web page. **Served directly by the server, with no dependency on any static site**:
 * under a reverse-proxy deployment /admin/* already points at the signaling service, so opening
 * https://<address>/admin/ on a phone just works.
 *
 * Why an inline string instead of a standalone .html file: tsc only compiles .ts, so a separate
 * asset would need an extra "copy to dist" build step — not worth a build-time asset pipeline for one page.
 *
 * Visuals: segmented control / underlined filter tabs / thin-border shadowless cards / light+dark dual theme /
 * respects prefers-reduced-motion. List: one row split into four horizontal segments
 * (expiry+remaining / id / last used / use count / actions) — the doc's two-line cards left big blank gaps on wide screens;
 * status is conveyed only by a 3px left bar + same-color status text, with no detail modal (revoke is inline).
 * The list is **not loaded by default**; only "Load list" or the ⟳ at top-right fetches /admin/tokens with the admin token.
 * Entry points: a one-line "system entries" quick-reference in the footer (click to copy); the issue modal's "Copy invite"
 * gives address + token + validity. ⚠️ The invite is the copy **sent to the user**, so it carries the desktop/mobile address,
 * not the admin-page address. ⚠️ Web URLs only take ?sig= / ?room= / ?debug=1, **no token parameter** → the invite can only be
 * two text segments, not a "click-to-connect" deep link; addresses are always derived from location.origin (same-origin as the front end).
 * Entry points: a one-line "system entries" quick-reference in the footer (click to copy); the issue modal's "Copy invite"
 * gives address + token + validity. ⚠️ The invite is the copy **sent to the user**, so it carries the desktop/mobile address,
 * not the admin-page address. ⚠️ Web URLs only take ?sig= / ?room= / ?debug=1, **no token parameter** → the invite can only be
 * two text segments, not a "click-to-connect" deep link; addresses are always derived from location.origin (same-origin as the front end).
 * Entry points: a one-line "system entries" quick-reference in the footer (click to copy); the issue modal's "Copy invite"
 * gives address + token + validity. ⚠️ The invite is the copy **sent to the user**, so it carries the desktop/mobile address,
 * not the admin-page address. ⚠️ Web URLs only take ?sig= / ?room= / ?debug=1, **no token parameter** → the invite can only be
 * two text segments, not a "click-to-connect" deep link; addresses are always derived from location.origin (same-origin as the front end).
 * Entry points: a one-line "system entries" quick-reference in the footer (click to copy); the issue modal's "Copy invite"
 * gives address + token + validity. ⚠️ The invite is the copy **sent to the user**, so it carries the desktop/mobile address,
 * not the admin-page address. ⚠️ Web URLs only take ?sig= / ?room= / ?debug=1, **no token parameter** → the invite can only be
 * two text segments, not a "click-to-connect" deep link; addresses are always derived from location.origin (same-origin as the front end).
 * The page JS deliberately **avoids template literals** (plain + concatenation), so embedding the whole page into this file's
 * template literal won't collide with backticks or ${; the write path has an extra auto-escape backstop.
 *
 * 🔴 The admin secret **must not** appear in the page: it is only a shell; the operator types the secret in the browser and
 * it is stored in localStorage. (Regression in test/server.test.mjs: page text must not contain adminToken.)
 */
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#F7F5F2" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#1B1815" media="(prefers-color-scheme:dark)">
<title>访问口令管理</title>
<style>
/* Implemented per docs/访问口令管理 · 设计与实现提示词.md.
   ⚠️ The doc specifies Tailwind CDN, but this page is served by the signaling server under CSP default-src 'none',
   so external CSS/JS is blocked by the browser —— hence an equivalent hand-written CSS restore (utility → semantic classes, md: → @media 768px).
   Breakpoints, colors, sizes, and interactions follow the doc; the list row layout is spread horizontally per actual need (the doc's two-line cards left big blank gaps on wide screens). */
:root{
  --bg:#F7F5F2; --card:#FFFFFF; --line:#E8E4DF;
  --fg:#2D2A26; --fg2:#8C8580; --fg3:#B5AEA8;
  --accent:#C96F4A; --accent-soft:#FDF0EA; --accent-line:#F0D5C8; --accent-ink:#A9563A;
  --ok:#5B9A6F; --ok-soft:#EDF5EF;
  --danger:#C75B4A; --danger-soft:#FBEDEA;
  --neutral:#F5F2EF;
  --r-card:12px; --r-ctl:8px;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#1B1815; --card:#221E1A; --line:#332E28;
    --fg:#EDE8E2; --fg2:#A39B93; --fg3:#7A736C;
    --accent:#D9835C; --accent-soft:#33241C; --accent-line:#4A3428; --accent-ink:#E0996F;
    --ok:#6FAE83; --ok-soft:#1E2A22;
    --danger:#D9705F; --danger-soft:#2E1E1B;
    --neutral:#282320;
  }
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none !important}
html,body{margin:0}
body{
  background:var(--bg);color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;
}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
button{font:inherit;cursor:pointer}

/* Outer: max-w-md → md:max-w-5xl, px-4 py-5, flex flex-col gap-4 */
.shell{max-width:448px;margin:0 auto;padding:20px 16px calc(20px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:16px}

/* ── Top bar (~40px tall, no bottom border) ── */
.topbar{display:flex;align-items:center;gap:9px;min-height:40px}
.brand-mark{width:28px;height:28px;border-radius:7px;flex:none;display:grid;place-items:center;background:var(--accent)}
.brand-mark svg{display:block}
.brand-name{font-size:15px;font-weight:600;letter-spacing:-.01em}
.chip{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;background:var(--ok-soft);color:var(--ok);font-size:11px;font-weight:500;white-space:nowrap}
.chip.bad{background:var(--danger-soft);color:var(--danger)}
.chip .dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}

/* ── Card (thin border, no shadow, 12px radius, 16px padding) ── */
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-card);padding:16px;min-width:0}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.card-title{font-size:14px;font-weight:600;margin:0;display:flex;align-items:baseline;gap:7px}
.card-hint{font-size:11px;color:var(--fg3);font-weight:400;white-space:nowrap}
.card-note{margin:-6px 0 10px;font-size:11px;line-height:1.55;color:var(--fg3)}

/* Top 2: mobile stacked → desktop 50/50 left-right */
.top-2{display:flex;flex-direction:column;gap:16px}

/* ── Admin token ── */
.tk-state{font-size:11px;color:var(--fg3)}
.tk-state.ok{color:var(--ok)}
.tk-field{display:flex;align-items:center;gap:4px;height:40px;padding:0 4px 0 10px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-ctl);transition:border-color .15s,box-shadow .15s}
.tk-field:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.tk-field input{flex:1;min-width:0;border:0;background:transparent;color:var(--fg);font:inherit;font-size:13px;outline:none}
.tk-field input::placeholder{color:var(--fg3)}
.tk-note{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;font-size:11px;color:var(--fg3)}
.link-btn{border:0;background:transparent;color:var(--fg3);font-size:11px;padding:2px 4px;border-radius:5px;flex:none}
.link-btn:hover{color:var(--accent)}

/* ── Buttons ── */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid transparent;border-radius:var(--r-ctl);font-size:14px;font-weight:500;transition:background .15s,border-color .15s,color .15s}
.btn:active{transform:scale(.99)}
.btn:disabled{opacity:.5;cursor:default}
.btn-primary{height:44px;width:100%;background:var(--accent);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--accent-ink)}
.btn-secondary{height:44px;background:var(--card);border-color:var(--line);color:var(--fg)}
.btn-secondary:hover:not(:disabled){background:var(--neutral)}
.u-btn{flex:none;border:0;background:transparent;color:var(--fg2);font-size:11px;padding:0 8px;height:30px;border-radius:6px}
.u-btn:hover{background:var(--neutral);color:var(--accent)}

/* ── Day pills (40px, equal-width split, 8px radius) ── */
.seg{display:grid;gap:4px;margin-bottom:12px}
.seg button{height:40px;border:1px solid transparent;border-radius:var(--r-ctl);background:var(--neutral);color:var(--fg2);font-size:13px;font-weight:400}
.seg button[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent);font-weight:500}
#days{grid-template-columns:repeat(7,minmax(0,1fr))}

/* ── Token list ── */
.icon-btn{width:28px;height:28px;flex:none;border:0;background:transparent;color:var(--fg2);border-radius:50%;display:grid;place-items:center}
.icon-btn:hover{background:var(--neutral);color:var(--accent)}
/* Filter tabs: 32px, underlined when selected, horizontally scrollable */
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--line);margin:0 -2px}
.tabs::-webkit-scrollbar{display:none}
.tabs button{flex:none;height:32px;padding:0 12px;border:0;background:transparent;color:var(--fg2);font-size:13px;font-weight:400;box-shadow:inset 0 -2px 0 transparent;transition:color .15s,box-shadow .15s}
.tabs button[aria-pressed="true"]{color:var(--fg);font-weight:500;box-shadow:inset 0 -2px 0 var(--accent)}
/* List area: inner scroll + 4px thin scrollbar */
.list{display:flex;flex-direction:column;gap:8px;max-height:400px;overflow:auto;margin-top:12px;padding-right:2px;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.list::-webkit-scrollbar{width:4px;height:4px}
.list::-webkit-scrollbar-thumb{background:var(--line);border-radius:2px}
.list::-webkit-scrollbar-track{background:transparent}
/* List item: 3px left status bar + four horizontal segments ([expiry/remaining + id] [last used] [uses] [actions]) */
.li{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:"main meta ops";align-items:center;gap:10px 20px;padding:11px 12px 11px 15px;background:var(--card);border:1px solid var(--line);border-radius:10px;transition:background .15s}
.li:hover{background:var(--bg)}
.li::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:10px 0 0 10px;background:var(--fg3)}
.li[data-status="active"]::before{background:var(--ok)}
.li[data-status="revoked"]::before{background:var(--danger)}
.li-main{grid-area:main;min-width:0}
.li-line{display:flex;align-items:baseline;gap:8px;min-width:0}
.li-exp{font-size:13px;color:var(--fg);white-space:nowrap}
.li-st{font-size:11px;font-weight:500;color:var(--fg3);white-space:nowrap}
.li-st[data-status="active"]{color:var(--ok)}
.li-st[data-status="revoked"]{color:var(--danger)}
.li-id{margin-top:5px;font-size:11px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.li-meta{grid-area:meta;display:flex;gap:20px}
.kv{display:flex;flex-direction:column;gap:2px;min-width:0}
.kv-k{font-style:normal;font-size:10.5px;color:var(--fg3);white-space:nowrap}
.kv-v{font-style:normal;font-size:12px;font-weight:500;color:var(--fg2);white-space:nowrap}
.li-ops{grid-area:ops;display:flex;gap:2px}
.li-act{height:28px;padding:0 9px;border:0;background:transparent;color:var(--fg2);font-size:11px;border-radius:6px}
.li-act:hover{background:var(--neutral);color:var(--accent)}
.li-act.danger:hover{background:var(--danger-soft);color:var(--danger)}
.empty{padding:28px 4px;text-align:center;font-size:12px;color:var(--fg3)}
/* Unloaded state (this is the default on open) */
.lazy{padding:24px 4px 20px;text-align:center}
.lazy p{margin:0 0 14px;font-size:12px;color:var(--fg3)}
.lazy .btn{height:38px;width:auto;padding:0 20px;font-size:13px}

/* ── Modal ── */
.mask{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(45,42,38,.4);animation:fade .2s ease both}
@keyframes fade{from{opacity:0}to{opacity:1}}
.modal{width:100%;max-width:384px;background:var(--card);border-radius:16px;padding:20px 18px 16px;text-align:center;animation:slide-up .25s cubic-bezier(.2,.8,.3,1) both}
@keyframes slide-up{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
.modal-icon{width:40px;height:40px;margin:0 auto 10px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.modal-title{font-size:15px;font-weight:600}
.modal-sub{font-size:12px;color:var(--accent);margin-top:3px}
.modal-token{margin-top:14px;padding:12px;background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:12px;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:13.5px;font-weight:500;line-height:1.5;letter-spacing:.04em;word-break:break-all;color:var(--accent-ink);-webkit-user-select:all;user-select:all}
.modal-meta{display:flex;align-items:center;justify-content:center;gap:5px;margin-top:10px;font-size:12px;color:var(--fg2)}
.modal-ft{display:flex;gap:10px;margin-top:16px}
.modal-ft .btn{flex:1;width:auto}
/* Invite addresses in modal: separated by a divider below validity, title + two rows (desktop / mobile) */
.addr{margin-top:11px;padding-top:10px;border-top:1px solid var(--line);text-align:left}
.addr-title{font-size:11px;color:var(--fg3);margin-bottom:3px}
.addr-row{display:flex;align-items:center;gap:8px;padding:2px 0}
.addr-k{flex:none;white-space:nowrap;min-width:36px;font-size:11px;color:var(--fg3)}
.addr-v{flex:1;min-width:0;border:0;background:transparent;color:var(--fg2);font-size:11px;text-align:left;padding:2px 4px;border-radius:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.addr-v:hover{background:var(--neutral);color:var(--accent)}
/* Footer: system-entry quick reference, one line, click to copy */
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:0 2px 4px;font-size:11px;color:var(--fg3)}
.foot .foot-host{color:var(--fg2);font-size:11px}
.foot button{border:0;background:var(--neutral);color:var(--fg2);font-size:11px;padding:3px 9px;border-radius:999px;white-space:nowrap}
.foot button:hover{background:var(--accent-soft);color:var(--accent)}

.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100vw - 32px);padding:9px 15px;border-radius:9px;z-index:40;background:var(--fg);color:var(--card);font-size:12.5px;font-weight:500;animation:fade .18s ease both}
.toast.bad{background:var(--danger);color:#fff}

/* ── Responsive: md = 768px ── */
@media (min-width:768px){
  .shell{max-width:1024px;padding:20px 24px}
  .top-2{flex-direction:row;align-items:stretch}
  .top-2>.card{flex:1 1 0;min-width:0}
  .list{max-height:480px}
}
/* Narrow screen: actions stay top-right, meta wraps to a full-width second row */
@media (max-width:639px){
  .li{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"main ops" "meta meta";gap:9px 10px}
  .li-meta{gap:18px}
}
@media (max-width:479px){
  .seg button{height:36px;font-size:12px}
  .seg{gap:3px}
  .tabs button{padding:0 9px}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}
}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <span class="brand-mark">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="10" rx="2.5"></rect>
        <path d="M7.5 11V7a4.5 4.5 0 0 1 9 0v4"></path>
      </svg>
    </span>
    <span class="brand-name">访问口令管理</span>
    <span class="chip" id="chip"><i class="dot"></i><span id="chip-text">检测中</span></span>
  </header>

  <div class="top-2">
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">管理员令牌</h2>
        <span class="tk-state" id="tk-state"></span>
      </div>
      <div class="tk-field">
        <input id="admin" type="password" class="mono" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="SIG_ADMIN_TOKEN">
        <button id="reveal" type="button" class="u-btn">显示</button>
      </div>
      <div class="tk-note">
        <span>输入后自动保存，无需手动确认</span>
        <button id="clear" type="button" class="link-btn">清除</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2 class="card-title">签发新口令</h2>
        <span class="card-hint">有效期 · 天</span>
      </div>
      <div class="seg" id="days"></div>
      <button id="issue" type="button" class="btn btn-primary">签 发</button>
    </section>
  </div>

  <section class="card">
    <div class="card-head">
      <h2 class="card-title">口令列表 <span class="card-hint" id="list-count"></span></h2>
      <button id="refresh" type="button" class="icon-btn" title="刷新" aria-label="刷新">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"></path><path d="M20.5 4.2V9h-4.8"></path></svg>
      </button>
    </div>
    <p class="card-note">列表按需加载：打开本页不会请求口令，点右侧 ⟳ 或下面的「加载列表」才会用管理员令牌读取。</p>
    <div class="tabs" id="tabs"></div>
    <div class="list" id="list"></div>
  </section>

  <footer class="foot" id="foot"></footer>
</div>

<div class="mask" id="issued-mask" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="issued-title">
    <div class="modal-icon">
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.6 4.5L19 7.5"></path></svg>
    </div>
    <div class="modal-title" id="issued-title">签发成功</div>
    <div class="modal-sub">只显示这一次 · 复制邀请后直接发给对方</div>
    <div class="modal-token" id="issued-token"></div>
    <div class="modal-meta">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.6V12l3 1.8"></path></svg>
      <span id="issued-meta"></span>
    </div>
    <div class="addr">
      <div class="addr-title">邀请地址</div>
      <div id="issued-addr"></div>
    </div>
    <div class="modal-ft">
      <button id="issued-close" type="button" class="btn btn-secondary">关闭</button>
      <button id="issued-copy" type="button" class="btn btn-primary">复制邀请</button>
    </div>
  </div>
</div>

<div id="toast" class="toast" hidden></div>
<script>
(function(){
  var KEY='p2p-admin-token';
  var LABEL={active:'有效',expired:'已过期',revoked:'已撤销'};
  var FILTERS=[['','全部'],['active','有效'],['expired','已过期'],['revoked','已撤销']];
  var RANK={active:0,expired:1,revoked:2};
  var days=3, status='', toastTimer=0, ALL=[], loaded=false, loading=false, lastIssue=null;
  /* This page is deployed same-origin with Caddy and the front end, so entry addresses are derived from the current origin.
     ⚠️ Web URLs only take ?sig= / ?room= / ?debug=1, **no token parameter** —— the invite can only be
     two text segments "address + token", not a click-to-connect deep link. */
  var ORIGIN=location.origin, SIGURL=location.origin.replace(/^http/,'ws');
  var ENTRIES=[['桌面端',ORIGIN+'/'],['手机端',ORIGIN+'/mobile.html'],['信令',SIGURL],['本页',ORIGIN+'/admin/']];
  var el=function(id){return document.getElementById(id)};
  function h(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}
  function token(){return el('admin').value.trim()}

  function setBusy(on){
    ['issue','refresh','clear'].forEach(function(id){el(id).disabled=on});
    var lb=el('load-btn');if(lb)lb.disabled=on;
    el('list').style.opacity=on?'.5':'1';
  }
  function toast(m,bad){
    var t=el('toast');
    t.textContent=m;t.hidden=false;t.className='toast'+(bad?' bad':'');
    clearTimeout(toastTimer);toastTimer=setTimeout(function(){t.hidden=true},bad?4200:2000);
  }
  function fail(e){toast(e&&e.message?e.message:'操作失败',true)}

  /* The token goes in the Authorization header, not the query string: it stays out of access logs, history, and the Referer. */
  function api(path,init){
    var opts=init||{}, tolerate=opts.tolerate||[];
    var headers={'content-type':'application/json'};
    if(token())headers.authorization='Bearer '+token();
    var req={method:opts.method||'GET',headers:headers,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'};
    if(opts.body!=null)req.body=JSON.stringify(opts.body);
    return fetch(path,req).then(function(res){
      return res.text().then(function(text){
        var data=null;
        try{data=JSON.parse(text)}catch(e){data=null}
        if(data===null)throw new Error('服务返回的不是 JSON（HTTP '+res.status+'）—— /admin 可能没被反向代理到信令服务');
        if(tolerate.indexOf(res.status)>=0)return data;
        if(res.status===401)throw new Error('管理员令牌不正确');
        if(res.status===429)throw new Error('连续鉴权失败过多，已被短暂冷却，请稍后再试');
        if(!res.ok)throw new Error(data.error||('HTTP '+res.status));
        return data;
      });
    },function(e){throw new Error('请求失败：'+(e&&e.message?e.message:e))});
  }

  function when(ms){return new Date(ms).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
  function remaining(ms){
    var t=Math.max(0,Math.round(ms/1000));
    var d=Math.floor(t/86400),hr=Math.floor((t%86400)/3600),mi=Math.floor((t%3600)/60);
    if(d)return '剩余 '+d+' 天 '+hr+' 小时';
    if(hr)return '剩余 '+hr+' 小时 '+mi+' 分';
    return '剩余 '+mi+' 分';
  }
  function health(){
    fetch('/healthz',{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'}).then(function(r){return r.json()}).then(function(d){
      el('chip').className='chip';el('chip-text').textContent='已连接 · '+(d.peers||0)+' 人在线';
    },function(){el('chip').className='chip bad';el('chip-text').textContent='服务不可达'});
  }

  /* Admin token: saved on blur, with the title-side status kept in sync */
  function syncState(){
    var t=token(), saved=localStorage.getItem(KEY)||'';
    var n=el('tk-state');
    if(!t){n.textContent='';n.className='tk-state'}
    else if(t===saved){n.textContent='已保存';n.className='tk-state ok'}
    else{n.textContent='未保存';n.className='tk-state'}
  }
  function persist(){
    var t=token();
    if(t)localStorage.setItem(KEY,t);else localStorage.removeItem(KEY);
    syncState();
  }

  function segmented(box,items,current,onPick){
    box.textContent='';
    items.forEach(function(it){
      var b=h('button',null,it[1]);b.type='button';
      b.setAttribute('aria-pressed',it[0]===current?'true':'false');
      b.onclick=function(){onPick(it[0])};
      box.appendChild(b);
    });
  }
  var DAYS=[[1,'1'],[2,'2'],[3,'3'],[4,'4'],[5,'5'],[6,'6'],[7,'7']];
  function buildDays(){segmented(el('days'),DAYS,days,function(v){days=v;buildDays()})}
  function buildTabs(){segmented(el('tabs'),FILTERS,status,function(v){status=v;buildTabs();renderList()})}

  function sortItems(list){
    return list.slice().sort(function(a,b){
      var r=(RANK[a.status]==null?9:RANK[a.status])-(RANK[b.status]==null?9:RANK[b.status]);
      if(r)return r;
      return (b.expiresAt||0)-(a.expiresAt||0);
    });
  }
  function copy(text,okMsg){
    var done=function(){toast(okMsg||'已复制到剪贴板')};
    function fallback(){
      var ta=document.createElement('textarea');
      ta.value=text;ta.style.position='fixed';ta.style.top='-1000px';document.body.appendChild(ta);
      ta.select();
      try{document.execCommand('copy');done()}catch(e){toast('复制失败，请长按手动选择',true)}
      document.body.removeChild(ta);
    }
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(done,fallback);
    else fallback();
  }

  function kv(k,v){
    var s=h('span','kv');
    s.appendChild(h('i','kv-k',k));
    s.appendChild(h('b','kv-v mono',v));
    return s;
  }

  /* ── System entries: the footer line is for the operator; the modal carries the copy "to be sent out" ── */
  function buildFoot(){
    var f=el('foot');f.textContent='';
    f.appendChild(h('span','foot-host mono','入口 '+ORIGIN.replace(/^https?:\\/\\//,'')));
    ENTRIES.forEach(function(e){
      var b=h('button',null,e[0]);b.type='button';b.title='点击复制 '+e[1];
      b.onclick=function(){copy(e[1],'已复制'+e[0]+'：'+e[1])};
      f.appendChild(b);
    });
  }
  function buildIssuedAddr(){
    var box=el('issued-addr');box.textContent='';
    ENTRIES.slice(0,2).forEach(function(e){
      var r=h('div','addr-row');
      r.appendChild(h('span','addr-k',e[0]));
      var b=h('button','addr-v mono',e[1]);b.type='button';b.title='点击复制';
      b.onclick=function(){copy(e[1],'已复制'+e[0]+'地址')};
      r.appendChild(b);
      box.appendChild(r);
    });
  }
  /* "Copy invite" hands over the copy **sent to the other party**: three segments —— desktop address, mobile address, token.
     Not the bare token (they'd still need to ask for the address), nor the token id (useless to them). */
  function inviteText(){
    if(!lastIssue)return '';
    return '桌面端访问地址：'+ORIGIN+'/\\n'
      +'手机端访问地址：'+ORIGIN+'/mobile.html\\n'
      +'口令：'+lastIssue.token;
  }
  /* List item: status is conveyed only by the left bar + same-line status text (same color);
     last-used / use-count are laid out inline, with no separate detail modal. */
  function rowFor(item){
    var li=h('div','li');li.dataset.status=item.status;

    var main=h('div','li-main');
    var line=h('div','li-line');
    line.appendChild(h('span','li-exp mono',when(item.expiresAt)+' 到期'));
    var st=h('span','li-st',item.status==='active'?remaining(item.expiresAt-Date.now()):LABEL[item.status]);
    st.dataset.status=item.status;
    line.appendChild(st);
    main.appendChild(line);
    var id=h('div','li-id mono',String(item.id||'').slice(0,12)+'...');
    id.title=String(item.id||'');
    main.appendChild(id);
    li.appendChild(main);

    var meta=h('div','li-meta');
    meta.appendChild(kv('最后使用',item.lastUsedAt?when(item.lastUsedAt):'未使用'));
    meta.appendChild(kv('已用',String(item.useCount||0)+' 次'));
    li.appendChild(meta);

    var ops=h('div','li-ops');
    var cp=h('button','li-act','复制ID');cp.type='button';
    cp.onclick=function(){copy(String(item.id||''),'已复制口令 ID（非登录口令）')};
    ops.appendChild(cp);
    if(item.status==='active'){
      var rv=h('button','li-act danger','撤销');rv.type='button';
      rv.onclick=function(){revoke(item)};
      ops.appendChild(rv);
    }
    li.appendChild(ops);
    return li;
  }

  function renderList(){
    if(!loaded){renderLazy();return}
    var box=el('list');box.textContent='';
    var items=sortItems(ALL.filter(function(it){return !status||it.status===status}));
    var noun=status===''?'口令':' '+LABEL[status]+'口令';
    el('list-count').textContent=items.length+' 个'+noun;
    if(!items.length){box.appendChild(h('div','empty','暂无'+noun));return}
    items.forEach(function(item){box.appendChild(rowFor(item))});
  }
  function msg(text){var box=el('list');box.textContent='';box.appendChild(h('div','empty',text))}
  /* Default state: request no API; present an explicit load entry point */
  function renderLazy(note,withBtn){
    var box=el('list');box.textContent='';
    var wrap=h('div','lazy');
    wrap.appendChild(h('p',null,note||'尚未加载'));
    if(withBtn!==false){
      var b=h('button','btn btn-secondary','加载列表');b.type='button';b.id='load-btn';
      b.onclick=function(){load()};
      wrap.appendChild(b);
    }
    box.appendChild(wrap);
  }

  function load(){
    if(loading)return;
    if(!token()){el('list-count').textContent='';renderLazy('请先填写管理员令牌',false);return}
    loading=true;setBusy(true);msg('加载中…');
    api('/admin/tokens').then(function(d){
      ALL=Array.isArray(d.tokens)?d.tokens:[];
      loaded=true;renderList();
    },function(e){
      loaded=false;el('list-count').textContent='';
      renderLazy('加载失败：'+(e&&e.message?e.message:e),true);
      fail(e);
    }).then(function(){loading=false;setBusy(false)});
  }

  function revoke(item){
    if(!window.confirm('撤销后该口令立即失效，对方需重新领取。确认撤销？'))return;
    setBusy(true);
    api('/admin/tokens/revoke',{method:'POST',body:{id:item.id},tolerate:[404]}).then(function(r){
      toast(r.revoked?'已撤销，该口令立即失效':'该口令已失效，无需撤销',!r.revoked);
      load();
    },function(e){fail(e);setBusy(false)});
  }

  el('admin').value=localStorage.getItem(KEY)||'';
  syncState();
  el('reveal').onclick=function(){
    var show=el('admin').type==='password';
    el('admin').type=show?'text':'password';
    el('reveal').textContent=show?'隐藏':'显示';
  };
  /* Blur only saves; it does not auto-load the list —— opening the page should make no request */
  el('admin').addEventListener('blur',function(){
    persist();
    if(!loaded)renderLazy(token()?'尚未加载':'请先填写管理员令牌',!!token());
  });
  el('admin').addEventListener('keydown',function(e){if(e.key==='Enter')el('admin').blur()});
  el('admin').addEventListener('input',syncState);
  el('clear').onclick=function(){
    localStorage.removeItem(KEY);el('admin').value='';syncState();
    ALL=[];loaded=false;buildTabs();el('list-count').textContent='';
    renderLazy('请先填写管理员令牌',false);
    toast('已清除本机保存的令牌');
  };
  el('refresh').onclick=function(){load()};
  el('issue').onclick=function(){
    if(!token()){toast('请先填写管理员令牌',true);return}
    setBusy(true);
    api('/admin/tokens',{method:'POST',body:{days:days}}).then(function(d){
      lastIssue={token:d.token,days:days,expiresAt:d.expiresAt};
      el('issued-token').textContent=d.token;
      el('issued-meta').textContent='有效期 '+days+' 天 · 到期 '+when(d.expiresAt);
      el('issued-copy').textContent='复制邀请';
      buildIssuedAddr();
      el('issued-mask').hidden=false;
      if(status&&status!=='active'){status='active';buildTabs()}
      if(loaded)load();
    },function(e){fail(e)}).then(function(){setBusy(false)});
  };
  /* "Copy invite" hands over the copy **sent to the other party**: address + token + validity, enough for them to enter.
     (Not the bare token —— they'd still need to ask for the address; nor the token id —— useless to them.) */
  el('issued-copy').onclick=function(){
    var b=el('issued-copy'),text=inviteText();
    if(!text)return;
    copy(text,'已复制邀请，直接发给对方即可');
    b.textContent='已复制';
    setTimeout(function(){b.textContent='复制邀请'},1500);
  };
  el('issued-close').onclick=function(){el('issued-mask').hidden=true};
  el('issued-mask').addEventListener('click',function(e){if(e.target===el('issued-mask'))el('issued-mask').hidden=true});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')el('issued-mask').hidden=true});

  buildDays();buildTabs();buildFoot();health();
  renderLazy(token()?'尚未加载':'请先填写管理员令牌',!!token());
})();
</script>
</body>
</html>
`;
