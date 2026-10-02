import "./mobile.css";
import { AppEngine, PendingItem } from "./app-engine";
import { env } from "./env";
import { wirePressFeedback } from "./ui/press-feedback";
import { tokenTtl } from "./token-ttl";
import { bannerRemainMs, pillState, PILL_TEXT, statusLevel } from "./ui/status-level";
import { installBackgroundWarning } from "./ui/background-warning";

const params = new URLSearchParams(location.search);
const appConfig = (window as typeof window & { P2P_APP_CONFIG?: { signalingUrl?: string; defaultRoom?: string; debug?: boolean } }).P2P_APP_CONFIG ?? {};
const sigUrl = params.get("sig") || appConfig.signalingUrl || "ws://localhost:8787";
const browserName = "手机-" + Math.random().toString(36).slice(2, 6);
const room = params.get("room") || appConfig.defaultRoom || "token";

const engine = new AppEngine({ sigUrl, browserName, room, debugEnabled: false });

// Warn when the tab is backgrounded mid-transfer (real mobile OS suspends the page, pausing it).
installBackgroundWarning(() => engine.activeTaskCount());

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function fmtSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function transferEta(seconds: number): string {
  return !Number.isFinite(seconds) ? "" : seconds < 1 ? "少于 1 秒" : seconds < 60 ? `约 ${Math.ceil(seconds)} 秒` : `约 ${Math.ceil(seconds / 60)} 分钟`;
}

// Rate window: same as desktop — estimate instantaneous rate over a 1s window to avoid jitter per chunk.
const RATE_WINDOW_MS = 1000;
const RATE_MIN_WINDOW_MS = 300;
const transferRates = new Map<string, { winStartAt: number; winStartSent: number; rate: number }>();
function computeRate(id: string, sent: number, now: number): number {
  const prev = transferRates.get(id) ?? { winStartAt: now, winStartSent: sent, rate: 0 };
  let rate = prev.rate;
  const winMs = now - prev.winStartAt;
  const winBytes = sent - prev.winStartSent;
  if (winMs >= RATE_WINDOW_MS || (winMs >= RATE_MIN_WINDOW_MS && winBytes > 0)) {
    rate = winBytes > 0 ? (winBytes * 1000) / winMs : 0;
    if (winMs >= RATE_WINDOW_MS) {
      prev.winStartAt = now;
      prev.winStartSent = sent;
    }
    prev.rate = rate;
  }
  transferRates.set(id, prev);
  return rate;
}

const VISIBLE_DEVICES = 2;
const VISIBLE_TASKS = 3;
const DEVICE_MAX_HEIGHT = 220;
const TASK_MAX_HEIGHT = 360;
const collapsed: Record<"device" | "task", boolean> = { device: true, task: true };
let connOpen = false;
// Whether the access token is shown in plaintext (same semantics as desktop's browserTokenVisible; toggled by the eye button)
let tokenVisible = false;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// Task display-state mapping (reuses desktop's "state → label/bar" semantics, but mobile is a single column without send/recv split).
type DispKey = "invite" | "active" | "paused" | "pending" | "error" | "done" | "cancelled" | "writing";
// Invites (awaiting confirmation) sort first: they wait for the user to tap "接收/拒绝" (accept/reject); hiding them behind collapse would deadlock the task.
const STATE_RANK: Record<DispKey, number> = { invite: -1, active: 0, paused: 1, pending: 2, error: 3, done: 4, cancelled: 5, writing: 0 };
function stateOf(t: { id: string; status: string; invite?: boolean; direction?: "send" | "recv" }): { key: DispKey; label: string; tag: string; bar: string; shimmer: boolean } {
  if (t.invite) return { key: "invite", label: "等待确认", tag: "tag-primary", bar: "", shimmer: false };
  const root = t.id.split(":")[0];
  const task = engine.manager.tasks.get(root);
  if (task?.phase === "cancelled") return { key: "cancelled", label: "已取消", tag: "tag-neutral", bar: "bar-cancelled", shimmer: false };
  // Paused: desktop uses the same #94a3b8 color + a slower shimmer; mobile previously used a shimmerless light gray (barely visible)
  if (engine.isPaused(root)) return { key: "paused", label: "已暂停", tag: "tag-neutral", bar: "bar-paused", shimmer: true };
  switch (t.status) {
    case "done":
      return { key: "done", label: "已完成", tag: "tag-neutral", bar: "bar-success", shimmer: false };
    case "rejected":
      return { key: "error", label: "已拒绝", tag: "tag-danger", bar: "bar-danger", shimmer: false };
    case "expired":
      return { key: "error", label: "已超时（未处理）", tag: "tag-danger", bar: "bar-danger", shimmer: false };
    case "error":
      return { key: "error", label: "传输失败", tag: "tag-danger", bar: "bar-danger", shimmer: false };
    // Receiver-only status: the sender marks its file done as soon as the last byte is sent, so it never lands here.
    case "writing":
      return { key: "writing", label: "写入中", tag: "tag-success", bar: "bar-success", shimmer: true };
    case "active":
      return { key: "active", label: "传输中", tag: "tag-primary", bar: "bar-primary", shimmer: true };
    default:
      return { key: "pending", label: "等待中", tag: "tag-neutral", bar: "", shimmer: false };
  }
}

interface MobileTask {
  id: string;
  direction: "send" | "recv";
  name: string;
  peer: string;
  peerId?: string;
  status: string;
  sent: number;
  size: number;
  note?: string;
  savedName?: string; // final on-disk filename after collision-avoidance (web/FSA); surfaced when it differs from `name`
  writingSince?: number; // Date.now() when the file entered the disk-commit phase; lets the UI show "committing… Ns"
  invite?: boolean;
  session?: string;
  transferId?: string;
  files?: { name: string; size: number }[];
}

function buildTemplate(): void {
  el("app").innerHTML = `
    <div class="m-header">
      <div class="m-brand"><div class="m-logo">P</div><span class="m-title">P2P传输</span></div>
      <div class="m-pills"><span class="m-pill">点对点传输</span><span class="m-pill ok">端到端加密</span></div>
      <div class="m-status" id="m-status" data-state="off" title="未连接"><span class="m-status-dot"></span><span class="m-status-text">未连接</span></div>
    </div>

    <div class="m-banner m-alert-card" id="m-status-banner" hidden>
      <div class="m-banner-text" id="m-status-banner-text"></div>
    </div>

    <div class="m-conn">
      <div class="m-conn-card">
        <button class="m-conn-btn" id="connToggle">
          <div class="m-conn-left">
            <span class="m-conn-dot off" id="connDot"></span>
            <span class="m-conn-label" id="connLabel" data-ttl="unknown">未连接</span>
          </div>
          <div class="m-conn-right">
            <span class="m-conn-text" id="connText">展开</span>
            <span class="arrow" id="connArrow">▾</span>
          </div>
        </button>
        <div class="m-conn-detail" id="connDetail">
          <div class="m-conn-detail-inner">
            <div><label class="m-field-label">设备名称</label><input class="m-input" id="m-name" value="${escapeHtml(browserName)}" /></div>
            <div><label class="m-field-label">访问口令</label><span class="m-secret"><input class="m-input" id="m-token" type="${tokenVisible ? "text" : "password"}" placeholder="输入 1–7 天有效口令" /><button type="button" class="m-secret-toggle${tokenVisible ? " revealed" : ""}" id="m-token-toggle" aria-label="显示或隐藏访问口令"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5S21.5 12 21.5 12 18.1 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/><path class="slash" d="M3 3l18 18"/></svg></button></span></div>
            <button class="m-conn-action" id="m-conn">连接</button>
          </div>
        </div>
      </div>
    </div>

    <section class="m-section m-sec-devices">
      <div class="m-section-title">
        <div style="display:flex;align-items:center;gap:8px;">
          <h2>在线设备</h2><span class="m-count" id="deviceCount">0 台</span>
        </div>
        <button class="header-toggle hidden" id="deviceToggle" data-toggle="device"><span id="deviceToggleText">展开</span><span class="arrow">▾</span></button>
      </div>
      <div class="m-device-list" id="deviceList"></div>
    </section>

    <section class="m-section m-sec-send">
      <button class="m-sendbtn disabled" id="sendBtn" disabled>请先选择接收设备</button>
      <p class="m-sendhint hidden" id="sendHint"></p>
    </section>

    <section class="m-section m-sec-tasks">
      <div class="m-section-title">
        <div style="display:flex;align-items:center;gap:8px;">
          <h2>传输任务</h2><span class="m-count" id="taskCount">0 项</span><button type="button" class="m-alert" id="taskAlert" hidden></button>
        </div>
        <button class="header-toggle hidden" id="taskToggle" data-toggle="task"><span id="taskToggleText">展开</span><span class="arrow">▾</span></button>
      </div>
      <div class="m-task-list" id="taskList"></div>
    </section>

    <div class="m-spacer"></div>`;
}

function renderDevices(): void {
  const list = el("deviceList");
  const peers = engine.store.get().peers;
  el("deviceCount").textContent = `${peers.length} 台`;
  if (!peers.length) {
    list.innerHTML = '<div class="empty-state">暂无在线设备</div>';
    el("deviceToggle").classList.add("hidden");
    return;
  }
  list.innerHTML = peers
    .map((p) => {
      const compatible = !p.engine || p.engine === "browser-v2" || p.capabilities?.wireProtocol === "transfer-v2";
      const sel = engine.sendTargetId === p.id;
      const cls = ["device-card", sel ? "selected" : "", compatible ? "" : "busy"].filter(Boolean).join(" ");
      const avatar = escapeHtml((p.name.slice(0, 1).toUpperCase()) || "?");
      return `<div class="${cls}" ${compatible ? `data-dev="${p.id}"` : ""} style="touch-action:manipulation;">
        <div class="m-avatar">${avatar}</div>
        <div class="m-device-body">
          <div class="m-device-name">${escapeHtml(p.name)}</div>
          <div class="m-device-status">${compatible ? (p.engine === "windows-native-v1" ? "Windows 原生 · 可接收" : "浏览器 · 可接收") : "协议不兼容"}</div>
        </div>
        ${sel ? '<span class="m-device-check">✓</span>' : ""}
      </div>`;
    })
    .join("");
  applyCollapse("device");
}

function sendBtnState(): void {
  const btn = el<HTMLButtonElement>("sendBtn");
  const hint = el("sendHint");
  if (engine.sendTargetId) {
    btn.disabled = false;
    btn.className = "m-sendbtn primary";
    btn.textContent = "选择文件并发送";
    hint.textContent = `将发送给「${engine.targetName(engine.sendTargetId)}」`;
    hint.classList.remove("hidden");
  } else {
    btn.disabled = true;
    btn.className = "m-sendbtn disabled";
    btn.textContent = "请先选择接收设备";
    hint.classList.add("hidden");
  }
}

function computeDetail(t: MobileTask): string {
  if (t.invite) {
    const total = t.files?.reduce((n, f) => n + f.size, 0) ?? 0;
    return total ? `${fmtSize(total)} · 等待接收` : "等待接收";
  }
  const isSend = t.direction === "send";
  const pct = t.size ? Math.round((t.sent / t.size) * 100) : 0;
  // Same convention as desktop main.ts: keep only "sent / total"; direction is expressed by ↑/↓ and "发往/来自" (to/from).
  const base = `${pct}% · ${fmtSize(t.sent)} / ${fmtSize(t.size)}`;
  const key = stateOf(t).key;
  if (key === "done") {
    if (!isSend && t.savedName && t.savedName !== t.name)
      return `${base} · 已保存为 ${t.savedName}（原名 ${t.name} 已存在）`;
    return `${base} · ${isSend ? "已发送完成" : "已保存到本地"}`;
  }
  // writingSince is a Date.now() stamp (set in onFileFinalizing), so it must be compared against Date.now() —
  // mixing in performance.now() yields a negative elapsed and the "已 Ns" counter never appears.
  if (key === "writing") { const el = t.writingSince ? Date.now() - t.writingSince : 0; return `${base} · 正在写入磁盘…${el > 2000 ? ` 已 ${Math.ceil(el / 1000)}s` : ""}`; }
  if (key === "pending") return `${base} · 等待中…`;
  if (key === "paused") return `${base} · 已暂停`;
  if (key === "cancelled") return `${base} · 任务已取消`;
  if (key === "error") {
    const root = t.id.split(":")[0];
    const err = engine.manager.tasks.get(root)?.error;
    return err ? `${base} · 错误：${escapeHtml(engine.reasonText(err))}` : `${base} · 传输失败`;
  }
  const now = performance.now();
  const rate = computeRate(t.id, t.sent, now);
  const eta = rate > 0 ? ` · ${(rate / 1048576).toFixed(1)} MiB/s · 预计剩余 ${transferEta((t.size - t.sent) / rate)}` : "";
  return `${base}${eta}`;
}

  // Incremental rendering that reuses each task card's DOM by id: during transfer only progress/detail text is updated,
  // action buttons are repainted only when the display state changes. Otherwise the render cycle (300ms) would replace the
  // button node the finger is on, causing touchstart/touchend to span nodes → click lost (tap does nothing).
interface TaskCardDom {
  root: HTMLElement;
  dir: HTMLElement;
  name: HTMLElement;
  peer: HTMLElement;
  tag: HTMLElement;
  pathTag: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  detail: HTMLElement;
  note: HTMLElement;
  actions: HTMLElement;
  lastState: string;
  lastDetail: string;
  lastNote: string;
}
const taskCardRegistry = new Map<string, TaskCardDom>();

function applyTaskPath(dom: TaskCardDom, t: MobileTask): void {
  const path = engine.peerPathType.get(t.peerId ?? "");
  if (!path || path === "unknown") { dom.pathTag.hidden = true; return; }
  dom.pathTag.hidden = false;
  dom.pathTag.textContent =
    path === "relay" ? "TURN 中转" : "P2P 直连";
  dom.pathTag.dataset.path = path;
}
function actionsHtml(t: MobileTask, key: DispKey): string {
  const root = t.id.split(":")[0];
  if (t.invite) {
    return `<button class="btn-ghost primary" data-acc="${t.session}" data-tid="${t.transferId}">接收</button><button class="btn-ghost danger" data-rej="${t.session}" data-tid="${t.transferId}">拒绝</button>`;
  }
  if (key === "active" || key === "writing") {
    return `<button class="btn-ghost" data-pause="${root}">暂停</button><button class="btn-ghost danger" data-cancel="${root}">取消</button>`;
  }
  if (key === "paused") {
    return `<button class="btn-ghost primary" data-pause="${root}">继续</button><button class="btn-ghost danger" data-cancel="${root}">取消</button>`;
  }
  if (key === "done" || key === "error" || key === "cancelled") return `<button class="btn-ghost" data-delete="${root}">删除</button>`;
  if (key === "pending") return `<button class="btn-ghost danger" data-cancel="${root}">取消</button>`;
  return "";
}

function buildTaskCard(t: MobileTask): TaskCardDom {
  const root = document.createElement("div");
  root.className = "task-card";
  root.dataset.transferId = t.id;
  root.innerHTML = `
    <div class="task-head">
      <div class="task-name-wrap">
        <span class="task-dir" data-dir></span>
        <span class="task-name" data-name></span>
        <span class="m-path-tag" data-path-tag hidden></span>
      </div>
      <span class="task-tag" data-tag></span>
    </div>
    <div class="task-peer" data-peer></div>
    <div class="task-bar" data-bar><div class="task-bar-fill progress-fill" data-fill></div></div>
    <div class="task-detail" data-detail></div>
    <div class="task-note" data-note></div>
    <div class="task-actions" data-actions></div>`;
  const dom: TaskCardDom = {
    root,
    dir: root.querySelector("[data-dir]")!,
    name: root.querySelector("[data-name]")!,
    peer: root.querySelector("[data-peer]")!,
    tag: root.querySelector("[data-tag]")!,
    pathTag: root.querySelector("[data-path-tag]")!,
    bar: root.querySelector("[data-bar]")!,
    fill: root.querySelector("[data-fill]")!,
    detail: root.querySelector("[data-detail]")!,
    note: root.querySelector("[data-note]")!,
    actions: root.querySelector("[data-actions]")!,
    lastState: "",
    lastDetail: "",
    lastNote: "",
  };
  applyTaskCard(dom, t);
  applyTaskPath(dom, t);
  return dom;
}

function applyTaskCard(dom: TaskCardDom, t: MobileTask): void {
  const s = stateOf(t);
  const isSend = t.direction === "send";
  const pct = t.size ? Math.round((t.sent / t.size) * 100) : 0;
  dom.root.dataset.state = s.key;
  dom.dir.textContent = isSend ? "↑" : "↓";
  dom.dir.className = `task-dir ${isSend ? "send" : "recv"}`;
  dom.name.textContent = t.name;
  dom.peer.textContent = `${isSend ? "发往" : "来自"} ${t.peer}`;
  dom.bar.style.display = s.bar !== "" ? "" : "none";
  dom.fill.className = `task-bar-fill progress-fill ${s.bar} ${s.shimmer ? "shimmer" : ""}`;
  dom.fill.style.width = `${pct}%`;
  const detail = computeDetail(t);
  if (dom.lastDetail !== detail) {
    dom.detail.textContent = detail;
    dom.lastDetail = detail;
  }
  const note = t.note ?? "";
  if (dom.lastNote !== note) {
    dom.note.textContent = note;
    dom.lastNote = note;
  }
  // Only update the label and action buttons when the display state changes, keeping the button node stable during transfer (reliable click).
  if (dom.lastState !== s.key) {
    dom.lastState = s.key;
    dom.root.className = `task-card ${s.key}`;
    dom.tag.className = `task-tag ${s.tag}`;
    dom.tag.textContent = s.label;
    dom.actions.innerHTML = actionsHtml(t, s.key);
  }
}

function renderTasks(): void {
  const list = el("taskList");
  const st = engine.store.get();
  const items: MobileTask[] = engine.invites
    .filter((i) => !engine.sendTargetId || i.session === engine.sendTargetId)
    .map((i) => ({
      id: i.transferId || i.session,
      direction: "recv",
      name: i.files?.[0]?.name ?? "文件",
      peer: i.name,
      peerId: i.session,
      status: "pending",
      sent: 0,
      size: i.files?.reduce((n, f) => n + f.size, 0) ?? 0,
      invite: true,
      session: i.session,
      transferId: i.transferId,
      files: i.files,
      // When auto-downloading, say up front where files land (always on mobile; empty string on folder-picking browsers)
      note: env().hint || undefined,
    }));
  for (const t of st.transfers) {
    items.push({
      id: t.id,
      direction: t.direction,
      name: t.name,
      peer: engine.targetName(t.peerId ?? ""),
      peerId: t.peerId,
      status: t.status,
      sent: t.sent,
      size: t.size,
      note: t.note,
    });
  }
  el("taskCount").textContent = `${items.length} 项`;
  // Blinking alert to the right of the "传输任务 N 项" (N transfer tasks) row: surface invites up front, let the user open and handle them.
  const taskAlert = el<HTMLButtonElement>("taskAlert");
  const waiting = engine.invites.length;
  taskAlert.hidden = waiting === 0;
  if (waiting) taskAlert.textContent = waiting > 1 ? `${waiting} 个待接收` : "有新任务待接收";
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">暂无传输任务</div>';
    taskCardRegistry.clear();
    el("taskToggle").classList.add("hidden");
    return;
  }
  // Clear the empty-state placeholder once there are tasks
  list.querySelector(".empty-state")?.remove();
  items.sort((a, b) => STATE_RANK[stateOf(a).key] - STATE_RANK[stateOf(b).key]);
  // Remove task cards that no longer exist (reuse nodes, avoid rebuilding the whole list)
  const idSet = new Set(items.map((i) => i.id));
  for (const [id, dom] of [...taskCardRegistry]) {
    if (!idSet.has(id)) {
      dom.root.remove();
      taskCardRegistry.delete(id);
    }
  }
  items.forEach((t, idx) => {
    let dom = taskCardRegistry.get(t.id);
    if (!dom) {
      dom = buildTaskCard(t);
      taskCardRegistry.set(t.id, dom);
    } else {
      applyTaskCard(dom, t);
      applyTaskPath(dom, t);
    }
    if (list.children[idx] !== dom.root) list.insertBefore(dom.root, list.children[idx] || null);
  });
  applyCollapse("task");
}

function applyCollapse(section: "device" | "task"): void {
  const listId = section === "device" ? "deviceList" : "taskList";
  const toggleId = section === "device" ? "deviceToggle" : "taskToggle";
  const textId = section === "device" ? "deviceToggleText" : "taskToggleText";
  const list = el(listId);
  const toggle = el(toggleId);
  const text = el(textId);
  const visible = section === "device" ? VISIBLE_DEVICES : VISIBLE_TASKS;
  const maxH = section === "device" ? DEVICE_MAX_HEIGHT : TASK_MAX_HEIGHT;
  const unit = section === "device" ? "台" : "项";
  // Count only real cards, so the empty-state placeholder isn't included
  const total = list.querySelectorAll(section === "device" ? ".device-card" : ".task-card").length;
  const terminal = new Set(["done", "error", "cancelled"]);
  // Hide the collapse toggle only when the list is empty; otherwise always keep it (short lists can still expand into a scroll area)
  if (total === 0) {
    toggle.classList.add("hidden");
    list.classList.remove("scroll-box");
    list.style.maxHeight = "";
    Array.from(list.children).forEach((c) => ((c as HTMLElement).style.display = ""));
    return;
  }
  toggle.classList.remove("hidden");
  if (collapsed[section]) {
    list.classList.remove("scroll-box");
    list.style.maxHeight = "";
    let shown = 0;
    let hiddenActive = 0;
    Array.from(list.children).forEach((c) => {
      const elc = c as HTMLElement;
      const isTerminal = terminal.has(elc.dataset.state || "");
      if (isTerminal || shown < visible) {
        elc.style.display = "";
        if (!isTerminal) shown++;
      } else {
        elc.style.display = "none";
        hiddenActive++;
      }
    });
    text.textContent = hiddenActive > 0 ? `展开剩余 ${hiddenActive} ${unit}` : "展开";
    toggle.classList.remove("expanded");
  } else {
    list.classList.add("scroll-box");
    list.style.maxHeight = maxH + "px";
    Array.from(list.children).forEach((c) => ((c as HTMLElement).style.display = ""));
    text.textContent = "收起";
    toggle.classList.add("expanded");
  }
}

function renderConn(): void {
  const connected = engine.isConnected();
  const dot = el("connDot");
  dot.className = `m-conn-dot ${connected ? "" : "off"}`;
  renderConnLabel();
  el("m-conn").textContent = engine.connecting ? "连接中…" : connected ? "断开" : "连接";
  el("connText").textContent = connOpen ? "收起" : "展开";
  el("connArrow").style.transform = connOpen ? "rotate(180deg)" : "rotate(0deg)";
  el("connDetail").classList.toggle("open", connOpen);
  // Top-bar status pill: same set as desktop main.ts — color is driven only by engine facts (see ui/status-level.ts),
  // a short word goes in the pill, the full text into the title and the banner below (the old impl stuffed long sentences into the top bar, truncated by ellipsis on narrow screens).
  const st = engine.store.get();
  const stText = st.statusText;
  const statusEl = el("m-status");
  if (statusEl) {
    const state = pillState(connected, engine.connecting);
    if (statusEl.dataset.state !== state) statusEl.dataset.state = state;
    const label = PILL_TEXT[state];
    const textEl = statusEl.querySelector<HTMLElement>(".m-status-text");
    if (textEl && textEl.textContent !== label) textEl.textContent = label;
    if (statusEl.title !== stText) statusEl.title = stText;
  }
  renderStatusBanner(stText, st.statusAt);
}

// Connection-row text: once connected, append the token-validity countdown (to the second); when disconnected, only the state is shown.
function renderConnLabel(): void {
  const label = el("connLabel");
  const connected = engine.isConnected();
  const view = tokenTtl(engine.store.get().tokenExpiresAt, Date.now());
  const text = engine.connecting
    ? "连接中…"
    : !connected
      ? "未连接"
      : view.text === "—"
        ? "已连接"
        : `已连接 · 口令${view.text}`;
  if (label.textContent !== text) label.textContent = text;
  label.dataset.ttl = view.level;
  if (label.title !== view.title) label.title = view.title;
}

// Environment banner: inserted once at the moment the signaling connection succeeds.
// Placed here rather than on page load because receiving can only happen after connecting — prompting on success is equally timely,
// and it won't interrupt the user while they're still entering the token; it also avoids an extra layout shift outside the connect moment.
let bannerShown = false;
function renderBanner(): void {
  if (bannerShown) return;
  const info = env();
  if (!info.showBanner || !engine.isConnected()) return;
  bannerShown = true;
  const banner = document.createElement("div");
  banner.className = `m-banner ${info.blockedReceive ? "warn" : "info"}`;
  const title = document.createElement("div");
  title.className = "m-banner-title";
  title.textContent = info.bannerTitle;
  const text = document.createElement("div");
  text.className = "m-banner-text";
  text.textContent = info.bannerText;
  banner.append(title, text);
  // Hang it below the top bar: same width system as .m-section, edges strictly aligned.
  // Prefer anchoring after the "connection-error" banner — error alerts are more urgent than environment hints and must come first
  // (even while hidden it still occupies flow order, so inserting after it places this one below it).
  const anchor = document.getElementById("m-status-banner") ?? document.querySelector(".m-header");
  anchor?.insertAdjacentElement("afterend", banner);
}

// Connection-error banner: same judgement as desktop's renderStatusBanner (ui/status-level.ts),
// reusing the .m-banner "white card + left color bar" skeleton; error uses the warn class for red (see mobile.css).
// Same auto-dismiss as desktop (non-auth 15s / auth stays) — but no close button on mobile:
// normal hints dismiss themselves, and auth ones should be acted on by the user anyway; the connection row sits right below the banner, close enough.
let mBannerTimer = 0;
function renderStatusBanner(text: string, at: number): void {
  const banner = el("m-status-banner");
  if (!banner) return;
  if (mBannerTimer) {
    clearTimeout(mBannerTimer);
    mBannerTimer = 0;
  }
  const remain = bannerRemainMs(text, at, Date.now());
  banner.hidden = remain === 0;
  if (remain === 0) return;
  banner.classList.toggle("warn", statusLevel(text) === "error");
  const textEl = el("m-status-banner-text");
  if (textEl && textEl.textContent !== text) textEl.textContent = text;
  if (remain !== null) mBannerTimer = window.setTimeout(() => { banner.hidden = true; }, remain);
}

function render(): void {
  renderConn();
  renderBanner();
  renderDevices();
  sendBtnState();
  renderTasks();
}

const lastDetailAt = new Map<string, number>();
const DETAIL_THROTTLE_MS = 500;
function updateProgress(id: string, _sent: number, _size: number): void {
  const dom = taskCardRegistry.get(id);
  if (!dom) return;
  const t = engine.store.get().transfers.find((x) => x.id === id);
  if (!t) return;
  const pct = t.size ? Math.round((t.sent / t.size) * 100) : 0;
  dom.fill.style.width = `${pct}%`;
  const now = performance.now();
  if (now - (lastDetailAt.get(id) ?? 0) > DETAIL_THROTTLE_MS) {
    const mt: MobileTask = { id: t.id, direction: t.direction, name: t.name, peer: engine.targetName(t.peerId ?? ""), peerId: t.peerId, status: t.status, sent: t.sent, size: t.size, note: t.note, savedName: t.savedName, writingSince: t.writingSince };
    const detail = computeDetail(mt);
    if (dom.lastDetail !== detail) {
      dom.detail.textContent = detail;
      dom.lastDetail = detail;
    }
    const note = t.note ?? "";
    if (dom.lastNote !== note) {
      dom.note.textContent = note;
      dom.lastNote = note;
    }
    lastDetailAt.set(id, now);
  }
}

function wireEvents(): void {
  el("connToggle").addEventListener("click", () => {
    connOpen = !connOpen;
    renderConn();
  });
  // Show/hide token plaintext: only switch input.type + the eye's slash, don't rebuild the input (to avoid losing focus and entered content)
  el("m-token-toggle").addEventListener("click", () => {
    tokenVisible = !tokenVisible;
    el<HTMLInputElement>("m-token").type = tokenVisible ? "text" : "password";
    el("m-token-toggle").classList.toggle("revealed", tokenVisible);
  });
  el("m-conn").addEventListener("click", () => {
    if (engine.connecting) return;
    if (engine.isConnected()) {
      // Pre-disconnect confirmation: only block for "in-progress" tasks (done/failed/cancelled disconnect directly).
      const busy = engine.activeTaskCount();
      if (busy > 0 && !confirm(`当前有 ${busy} 个任务正在进行，断开连接会中断这些任务。确定要断开吗？`)) return;
      engine.disconnect();
      return;
    }
    const name = el<HTMLInputElement>("m-name").value;
    const token = el<HTMLInputElement>("m-token").value;
    sessionStorage.setItem("p2p-window-name", name);
    sessionStorage.setItem("p2p-window-token", token);
    engine.connect(sigUrl, engine.room, token, name);
  });
  el("deviceList").addEventListener("click", (e) => {
    const node = (e.target as Element).closest<HTMLElement>("[data-dev]");
    if (!node) return;
    engine.selectTarget(node.dataset.dev!);
  });
  el("sendBtn").addEventListener("click", () => {
    if (!engine.sendTargetId) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => {
      if (input.files) {
        const items: PendingItem[] = Array.from(input.files).map((f) => ({ name: f.name, size: f.size, file: f }));
        engine.chooseFiles(items);
      }
    };
    input.click();
  });
  el("deviceToggle").addEventListener("click", () => {
    collapsed.device = !collapsed.device;
    applyCollapse("device");
  });
  el("taskToggle").addEventListener("click", () => {
    collapsed.task = !collapsed.task;
    applyCollapse("task");
  });
  el("taskAlert").addEventListener("click", () => {
    // Expand the task section and scroll to the top of the list (invite cards sort first by STATE_RANK).
    collapsed.task = false;
    applyCollapse("task");
    el("taskList").scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  el("taskList").addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLElement>("button");
    if (!btn) return;
    if (btn.dataset.pause) engine.pause(btn.dataset.pause);
    else if (btn.dataset.cancel) engine.cancel(btn.dataset.cancel);
    else if (btn.dataset.delete) engine.deleteTask(btn.dataset.delete);
    else if (btn.dataset.acc) void engine.acceptInvite(btn.dataset.acc, btn.dataset.tid || "");
    else if (btn.dataset.rej) engine.rejectInvite(btn.dataset.rej, btn.dataset.tid || "");
    else return;
    // Immediate feedback, don't wait for the engine's 300ms render throttle (buttons only repaint on state change, so this click isn't disturbed)
    render();
  });
}

function boot(): void {
  buildTemplate();
  // Prefer the previously saved device name / token
  try {
    const savedName = sessionStorage.getItem("p2p-window-name");
    const savedToken = sessionStorage.getItem("p2p-window-token");
    if (savedName !== null) el<HTMLInputElement>("m-name").value = savedName;
    if (savedToken !== null) el<HTMLInputElement>("m-token").value = savedToken;
  } catch {}
  engine.setHooks({ render, progress: updateProgress });
  engine.init();
  wireEvents();
  // Press feedback (iOS :active is unreliable, see ui/press-feedback.ts)
  wirePressFeedback(el("app"));
  render();
  // Token countdown ticks once per second: only updates the connection-row text node, no full-page re-render.
  setInterval(renderConnLabel, 1000);
}

void boot();
