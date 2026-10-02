import "./styles.css";
import { AppEngine, PendingItem } from "./app-engine";
import { isTauri } from "./file/source";
import { env } from "./env";
import { wirePressFeedback } from "./ui/press-feedback";
import { MODE_LABELS, TestMode } from "./transfer/diagnostics";
import { tokenTtl } from "./token-ttl";
import { bannerRemainMs, pillState, PILL_TEXT, statusLevel } from "./ui/status-level";
import { uuid } from "./crypto-compat";

const params = new URLSearchParams(location.search);
const appConfig = (window as typeof window & { P2P_APP_CONFIG?: { signalingUrl?: string; defaultRoom?: string; debug?: boolean } }).P2P_APP_CONFIG ?? {};
// Production builds keep the diagnostic controls out of the normal UI. Add
// ?debug=1 or set P2P_APP_CONFIG.debug=true for local troubleshooting.
const debugEnabled = params.get("debug") === "1" || appConfig.debug === true;
const sigUrl = params.get("sig") || appConfig.signalingUrl || "ws://localhost:8787";
const browserName = "浏览器-" + Math.random().toString(36).slice(2, 6);
const room = params.get("room") || appConfig.defaultRoom || "token";

const engine = new AppEngine({ sigUrl, browserName, room, debugEnabled });

function el<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}
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
// Pre-disconnect confirmation: only block for "in-progress" tasks (done/failed/cancelled disconnect directly).
function confirmDisconnect(): boolean {
  const n = engine.activeTaskCount();
  return n === 0 || confirm(`当前有 ${n} 个任务正在进行，断开连接会中断这些任务。确定要断开吗？`);
}
// Confirm before closing/reloading: block when there are in-progress tasks (the browser force-closes if the user insists).
window.addEventListener("beforeunload", (e) => {
  if (engine.activeTaskCount() > 0) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// Render coalescing: high-frequency progress updates (every 256 KB chunk) trigger at most one repaint per frame.
const cardRegistry = new Map<string, CardDom>();
const peerRegistry = new Map<string, HTMLButtonElement>();
let lastPeersHash = "";
let lastPendingHash = "";
const RATE_WINDOW_MS = 1000; // Window length: reset the baseline every full 1s
const RATE_MIN_WINDOW_MS = 300; // Skip recompute for too-short windows to avoid divide-by-zero and jitter
const transferRates = new Map<string, { winStartAt: number; winStartSent: number; rate: number }>();

// ---- Task sections (send / recv) rendering: incremental updates, never rebuild the whole card ----
// Section expand/collapse: true = fill its own height share (list scrolls internally); false = shrink to a title row, yielding height to the other side
// Section focus: null = split evenly; "send"/"recv" = that side dominant (~80%), the other collapsed to a thin strip (~20%) showing a summary.
let focusedSection: "send" | "recv" | null = null;
interface CardDom {
  root: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  size: HTMLElement;
  rate: HTMLElement;
  statusTag: HTMLElement;
  actions: HTMLElement;
  noteEl: HTMLElement;
  pathTag: HTMLElement;
  lastState: string;
  lastNote?: string;
  lastDetailAt?: number;
}
type DispState = "active" | "paused" | "done" | "error" | "pending" | "cancelled";
// Derive the "display state" from transfer-layer state + the paused set, without touching transfer logic.
function displayState(t: import("./ui/store").TransferItem): { key: DispState; label: string } {
  const root = t.id.split(":")[0];
  const task = engine.manager.tasks.get(root);
  if (task?.phase === "cancelled") return { key: "cancelled", label: "已取消" };
  if (engine.pausedTransfers.has(root)) return { key: "paused", label: "已暂停" };
  if (t.status === "done") return { key: "done", label: "已完成" };
  if (t.status === "rejected") return { key: "error", label: "已拒绝" };
  if (t.status === "expired") return { key: "error", label: "已超时（未处理）" };
  if (t.status === "error") return { key: "error", label: "传输失败" };
  if (t.status === "writing" || t.status === "active") return { key: "active", label: "传输中" };
  return { key: "pending", label: "等待中" };
}
// List sort priority: active > paused > pending > error > done > cancelled (ties keep original order).
const STATE_RANK: Record<DispState, number> = { active: 0, paused: 1, pending: 2, error: 3, done: 4, cancelled: 5 };
const sortByState = (list: import("./ui/store").TransferItem[]): import("./ui/store").TransferItem[] =>
  [...list].sort((a, b) => STATE_RANK[displayState(a).key] - STATE_RANK[displayState(b).key]);

function actionButtonsHTML(t: import("./ui/store").TransferItem): string {
  const root = t.id.split(":")[0];
  const st = displayState(t).key;
  if (st === "active") return `<button data-pause="${root}">暂停</button><button data-cancel="${root}">取消</button>`;
  if (st === "paused") return `<button data-pause="${root}">继续</button><button data-cancel="${root}">取消</button>`;
  if (st === "done") return `<button data-delete="${root}">删除</button>`;
  if (st === "error") return `<button data-delete="${root}">删除</button>`;
  if (st === "pending") return `<button data-cancel="${root}">取消</button>`;
  if (st === "cancelled") return `<button data-delete="${root}">删除</button>`;
  return "";
}
function buildCard(t: import("./ui/store").TransferItem): CardDom {
  const root = document.createElement("div");
  root.className = `task-card transfer ${displayState(t).key}`;
  root.dataset.transferId = t.id;
  root.innerHTML = `
    <div class="task-head">
      <span class="t-name">📄 ${escapeHtml(t.name)} <small>${t.direction === "send" ? "→" : "←"} ${escapeHtml(engine.targetName(t.peerId ?? ""))}</small></span>
      <span class="path-tag" data-path-tag hidden></span>
      <span class="status-tag" data-status-tag></span>
    </div>
    <div class="task-progress"><div class="bar"><div class="fill" data-progress-fill></div></div></div>
    <div class="task-foot">
      <div class="task-body">
        <div class="task-detail"><span class="detail-pct" data-progress-pct></span><span class="detail-size" data-progress-size></span><span class="detail-rate" data-progress-rate></span></div>
        <div class="task-note" data-task-note hidden></div>
      </div>
      <div class="task-actions"><span class="transfer-actions" data-actions></span></div>
    </div>`;
  const dom: CardDom = {
    root,
    fill: root.querySelector("[data-progress-fill]")!,
    pct: root.querySelector("[data-progress-pct]")!,
    size: root.querySelector("[data-progress-size]")!,
    rate: root.querySelector("[data-progress-rate]")!,
    statusTag: root.querySelector("[data-status-tag]")!,
    actions: root.querySelector("[data-actions]")!,
    noteEl: root.querySelector("[data-task-note]")!,
    pathTag: root.querySelector("[data-path-tag]")!,
    lastState: "",
  };
  applyCardState(dom, t);
  applyCardProgress(dom, t);
  applyCardNote(dom, t);
  applyCardPath(dom, t);
  return dom;
}
function applyCardNote(dom: CardDom, t: import("./ui/store").TransferItem): void {
  const note = t.note ?? "";
  if (dom.lastNote === note) return;
  dom.lastNote = note;
  dom.noteEl.textContent = note;
  dom.noteEl.title = note;
  dom.noteEl.hidden = !note;
}
function applyCardPath(dom: CardDom, t: import("./ui/store").TransferItem): void {
  const path = engine.peerPathType.get(t.peerId ?? "");
  if (!path || path === "unknown") { dom.pathTag.hidden = true; return; }
  dom.pathTag.hidden = false;
  dom.pathTag.textContent =
    path === "relay" ? "TURN 中转" : "P2P 直连";
  dom.pathTag.dataset.path = path;
}
function applyCardState(dom: CardDom, t: import("./ui/store").TransferItem): void {
  const ds = displayState(t);
  if (dom.lastState === ds.key) return;
  dom.lastState = ds.key;
  dom.root.className = `task-card transfer ${ds.key}`;
  dom.statusTag.textContent = ds.label;
  dom.actions.innerHTML = actionButtonsHTML(t);
}
const DETAIL_THROTTLE_MS = 500;
function applyCardProgress(dom: CardDom, t: import("./ui/store").TransferItem): void {
  const pct = t.size ? Math.round((t.sent / t.size) * 100) : 0;
  dom.fill.style.width = `${pct}%`;
  const ds = displayState(t).key;
  dom.pct.textContent = `${pct}%`;
  // Keep only "sent / total": direction is already shown by the title-row arrow and the
  // send/recv task sections; repeating "sent" is redundant and easily confused with the terminal label "已发送完成" (done-sending).
  dom.size.textContent = `${fmtSize(t.sent)} / ${fmtSize(t.size)}`;
  const root = t.id.split(":")[0];
  const now = performance.now();
  if (ds === "done") {
    if (t.direction === "recv" && t.savedName && t.savedName !== t.name)
      dom.rate.textContent = `已保存为 ${t.savedName}（原名 ${t.name} 已存在）`;
    else
      dom.rate.textContent = t.direction === "recv" ? "已保存到本地" : "已发送完成";
    dom.lastDetailAt = now;
    return;
  }
  if (ds === "pending") {
    dom.rate.textContent = "等待中…";
    dom.lastDetailAt = now;
    return;
  }
  if (ds === "cancelled") {
    dom.rate.textContent = "任务已取消";
    dom.lastDetailAt = now;
    return;
  }
  if (ds === "error") {
    const err = engine.manager.tasks.get(root)?.error;
    dom.rate.textContent = err ? `错误：${escapeHtml(engine.reasonText(err))}` : "传输失败";
    dom.lastDetailAt = now;
    return;
  }
  if (ds === "paused") transferRates.delete(t.id);
  if (t.status === "writing") {
    // Receiver-only status: the sender never enters it (it marks its file done the moment the last byte is sent).
    const el = t.writingSince ? now - t.writingSince : 0;
    dom.rate.textContent = el > 2000 ? `正在写入磁盘… 已 ${Math.ceil(el / 1000)}s` : "正在写入磁盘…";
    dom.lastDetailAt = now;
    return;
  }
  const prev = transferRates.get(t.id) ?? { winStartAt: now, winStartSent: t.sent, rate: 0 };
  let rate = prev.rate;
  const winMs = now - prev.winStartAt;
  const winBytes = t.sent - prev.winStartSent;
  if (winMs >= RATE_WINDOW_MS || (winMs >= RATE_MIN_WINDOW_MS && winBytes > 0)) {
    rate = winBytes > 0 ? (winBytes * 1000) / winMs : 0;
    if (winMs >= RATE_WINDOW_MS) {
      prev.winStartAt = now;
      prev.winStartSent = t.sent;
    }
    prev.rate = rate;
  }
  transferRates.set(t.id, prev);
  const eta = ds === "active" && rate > 0 ? ` · ${(rate / 1048576).toFixed(1)} MiB/s · 预计剩余 ${transferEta((t.size - t.sent) / rate)}` : "";
  const force = ds !== dom.lastState;
  if (force || !dom.lastDetailAt || now - dom.lastDetailAt > DETAIL_THROTTLE_MS) {
    dom.rate.textContent = eta;
    dom.lastDetailAt = now;
  }
}
function reconcileList(items: import("./ui/store").TransferItem[], container: HTMLElement): void {
  const idSet = new Set(items.map((i) => i.id));
  for (const [id, dom] of [...cardRegistry]) {
    if (dom.root.parentElement === container && !idSet.has(id)) {
      dom.root.remove();
      cardRegistry.delete(id);
    }
  }
  items.forEach((t, idx) => {
    let dom = cardRegistry.get(t.id);
    if (!dom) {
      dom = buildCard(t);
      cardRegistry.set(t.id, dom);
    } else {
      applyCardState(dom, t);
      applyCardProgress(dom, t);
      applyCardNote(dom, t);
      applyCardPath(dom, t);
    }
    if (container.children[idx] !== dom.root) container.insertBefore(dom.root, container.children[idx] || null);
  });
  applySectionFocus();
}
function setFocus(sec: "send" | "recv" | null): void {
  focusedSection = sec;
  applySectionFocus();
}
// Dominant/strip: focusedSection decides which side fills the height and which collapses to a thin strip summary; null splits evenly.
// Lists always scroll internally; the page height is locked by .native-main and never overflows.
function applySectionFocus(): void {
  for (const sec of ["send", "recv"] as const) {
    const sectionEl = el(`#${sec}-transfers`)?.closest(".task-section") as HTMLElement | null;
    const toggle = el(`#${sec}-toggle`);
    const summary = el(`#${sec}-summary`);
    if (!sectionEl || !toggle) continue;
    const invites = sec === "recv" ? (el("#invites")?.children.length ?? 0) : 0;
    const total = (el(`#${sec}-transfers`)?.children.length ?? 0) + invites;
    sectionEl.classList.remove("dominant", "strip", "collapsed-section");
    if (summary) summary.hidden = true;
    if (total === 0) { toggle.hidden = true; continue; }
    toggle.hidden = false;
    const isFocused = focusedSection === sec;
    const isStrip = focusedSection !== null && focusedSection !== sec;
    sectionEl.classList.toggle("dominant", isFocused);
    sectionEl.classList.toggle("strip", isStrip);
    toggle.classList.toggle("open", isFocused);
    (toggle.querySelector(".task-toggle-label") as HTMLElement | null)!.textContent = isFocused ? "收起" : "展开";
    if (summary) summary.hidden = !isStrip;
  }
}
function renderTaskLists(): void {
  const st = engine.store.get();
  const sending = sortByState(st.transfers.filter((t) => t.direction === "send" && (!engine.sendTargetId || t.peerId === engine.sendTargetId)));
  const receiving = sortByState(st.transfers.filter((t) => t.direction === "recv" && (!engine.sendTargetId || t.peerId === engine.sendTargetId)));
  reconcileList(sending, el("#send-transfers"));
  reconcileList(receiving, el("#recv-transfers"));
  el("#send-count").textContent = `${sending.length} 项`;
  el("#recv-count").textContent = `${receiving.length} 项`;
  // Strip summary (shown only when this side is the strip; the hidden state for dominant/even split is handled by applySectionFocus)
  const sendTop = sending[0];
  el("#send-summary").textContent = sendTop ? `最新：${sendTop.name} · ${displayState(sendTop).label}` : "暂无发送任务";
  const pending = engine.invites;
  const recvSummary = el("#recv-summary");
  if (pending.length > 0) {
    const names = pending.flatMap((i) => (i.files ?? []).map((f) => f.name)).slice(0, 2).join(" / ");
    recvSummary.innerHTML = `<span class="recv-pill">${pending.length} 待接收 · ${names} <button type="button" class="recv-btn" id="recv-strip-receive">接收</button></span>`;
  } else {
    const rTop = receiving[0];
    recvSummary.textContent = rTop ? `最新：${rTop.name} · ${displayState(rTop).label}` : "暂无接收任务";
  }
}
function renderPeers(peers: import("./signaling/types").PeerInfo[]): void {
  const pendingPeers = new Set(engine.invites.map((i) => i.session).filter(Boolean) as string[]);
  const hash = peers
    .map((p) => [p.id, p.name, p.engine || "", p.capabilities?.wireProtocol || "", p.id === engine.sendTargetId ? "1" : "0", pendingPeers.has(p.id) ? "1" : "0"].join("|"))
    .join("\n") + `\n#${peers.length}`;
  if (hash === lastPeersHash) return;
  lastPeersHash = hash;
  const container = el("#peers");
  if (peers.length === 0) {
    container.innerHTML = '<div class="hint">未发现其他设备</div>';
    peerRegistry.clear();
    return;
  }
  const idSet = new Set(peers.map((p) => p.id));
  for (const [id, node] of [...peerRegistry]) {
    if (!idSet.has(id)) {
      node.remove();
      peerRegistry.delete(id);
    }
  }
  peers.forEach((p, idx) => {
    const compatible = !p.engine || p.engine === "browser-v2" || p.capabilities?.wireProtocol === "transfer-v2";
    const kind = p.engine === "windows-native-v1" ? "Windows 原生" : "浏览器";
    const active = p.id === engine.sendTargetId;
    let node = peerRegistry.get(p.id);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      peerRegistry.set(p.id, node);
    }
    const inviteCount = engine.invites.filter((i) => i.session === p.id).length;
    const hasInvite = inviteCount > 0;
    node.className = `peer${active ? " active" : ""}${hasInvite ? " has-invite" : ""}`;
    node.disabled = !compatible;
    node.dataset.id = compatible ? p.id : "";
    const sourceLabel = p.source === "lan" ? "局域网" : "信令";
    const transportLabel = p.transport === "tcp" ? "TCP" : p.transport === "dc" ? "DC" : "";
    const metaParts = [sourceLabel, kind, transportLabel].filter(Boolean);
    node.innerHTML = `<span class="device-avatar">${escapeHtml(p.name.slice(0, 1).toUpperCase())}</span><span class="peer-copy"><b>${escapeHtml(p.name)}</b><small>${metaParts.join(" · ")} · ${compatible ? "可接收" : "协议不兼容"}</small></span>${hasInvite ? `<span class="peer-badge">${inviteCount}</span>` : ""}`;
    if (container.children[idx] !== node) container.insertBefore(node, container.children[idx] || null);
  });
  const empty = container.querySelector(".hint");
  if (empty) empty.remove();
}
function renderPending(items: PendingItem[], targetNameLabel: string | null): void {
  const hash = items.map((i) => `${i.name}|${i.size}`).join("\n") + `\n#${items.length}|${targetNameLabel || ""}`;
  if (hash === lastPendingHash) return;
  lastPendingHash = hash;
  const container = el("#pending");
  if (items.length === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `<div class="files">${items
    .map(
      (f, i) =>
        `<div class="file"><span>${escapeHtml(f.name)}</span><small>${fmtSize(f.size)}</small><button data-rm="${i}" class="btn x" title="移除">×</button></div>`,
    )
    .join("")}</div><button id="send-selected" class="btn primary"${targetNameLabel ? "" : " disabled"}>${
    targetNameLabel ? `发送给 ${escapeHtml(targetNameLabel)}` : "请先选择右侧设备"
  }</button>`;
}
function updateProgressDom(id: string, _sent: number, _size: number): void {
  const dom = cardRegistry.get(id);
  const t = engine.store.get().transfers.find((x) => x.id === id);
  if (!dom || !t) return;
  applyCardProgress(dom, t);
}
function renderDiagnostics(): void {
  const node = document.querySelector("#diagnostic-results");
  if (node) node.textContent = engine.diagnosticText();
}

// Token-validity countdown: each second only updates this one text node, bypassing scheduleRender (which would repaint the whole page).
function renderTokenTtl(): void {
  const node = document.querySelector<HTMLElement>("#token-summary");
  const value = node?.querySelector<HTMLElement>("b");
  if (!node || !value) return;
  const view = tokenTtl(engine.store.get().tokenExpiresAt, Date.now());
  if (value.textContent !== view.text) value.textContent = view.text;
  value.dataset.ttl = view.level;
  if (node.title !== view.title) node.title = view.title;
}

// Connection-error banner: shown only when statusText is judged error/warn (judgement in ui/status-level.ts).
//
// Auto-dismiss: non-auth banners leave after 15s (stale hints shouldn't linger on the page — otherwise, after a task
// ends the top bar still showing "信令请求失败" makes the user think the failure is ongoing); auth banners stay, those require user action.
// Why use hidden instead of adding/removing nodes: render() runs on every progress callback,
// repeatedly creating/destroying DOM would drop the click-delegation target and may cause layout jitter.
let bannerTimer = 0;
let bannerDismissedAt = -1; // statusAt recorded on manual close: the same message won't re-pop; only a text change re-alerts
function renderStatusBanner(text: string, at: number): void {
  const banner = document.querySelector<HTMLElement>("#status-banner");
  if (!banner) return;
  if (bannerTimer) {
    clearTimeout(bannerTimer);
    bannerTimer = 0;
  }
  const remain = bannerDismissedAt === at ? 0 : bannerRemainMs(text, at, Date.now());
  banner.hidden = remain === 0;
  if (remain === 0) return;
  const level = statusLevel(text);
  if (banner.dataset.level !== level) banner.dataset.level = level;
  const textEl = banner.querySelector<HTMLElement>("#status-banner-text");
  if (textEl && textEl.textContent !== text) textEl.textContent = text;
  if (remain !== null) bannerTimer = window.setTimeout(() => { banner.hidden = true; }, remain);
}

function render(): void {
  const st = engine.store.get();
  const summary = document.querySelector("#self-summary");
  if (summary) summary.textContent = st.self?.name ?? "—";
  const peerCount = document.querySelector("#peer-count");
  if (peerCount) peerCount.textContent = `${st.peers.length} 台`;
  renderTokenTtl();

  renderPeers(st.peers);

  const targetNameLabel = engine.sendTargetId ? engine.targetName(engine.sendTargetId) : null;
  const dropzone = document.querySelector<HTMLElement>("#dropzone");
  const dzText = document.querySelector<HTMLElement>("#dz-text");
  const dzSub = document.querySelector<HTMLElement>("#dz-sub");
  if (dropzone) {
    dropzone.classList.toggle("disabled", !engine.sendTargetId);
    dropzone.classList.toggle("ready", !!engine.sendTargetId);
  }
  if (dzText && dzSub) {
    if (engine.sendTargetId) {
      dzText.textContent = "点击选择文件";
      dzSub.textContent = "或拖拽文件到此处";
      dzSub.hidden = false;
    } else {
      dzText.textContent = "请先选择设备";
      dzSub.hidden = true;
    }
  }
  renderPending(engine.pendingItems, targetNameLabel);

  const visibleInvites = engine.invites.filter((i) => engine.sendTargetId && i.session === engine.sendTargetId);
  el("#invites").innerHTML = visibleInvites.length
    ? visibleInvites
        .map((i) => {
          const files = i.files?.length
            ? `<div class="inv-files">${i.files
                .map((f) => `<div class="inv-file"><span>${escapeHtml(f.name)}</span><small>${fmtSize(f.size)}</small></div>`)
                .join("")}</div>`
            : `<div class="hint">（文件信息获取中…）</div>`;
          // When the receive target can only fall back to "浏览器下载" (browser download), say up front where files land (PC Chromium can pick a folder; here it's empty)
          const envHint = env().hint;
          const saveHint = envHint ? `<div class="hint">${escapeHtml(envHint)}</div>` : "";
          return `<div class="invite"><strong>${MODE_LABELS[i.files?.[0]?.diagnosticMode ?? "full"]}</strong><div class="inv-head"><b>${escapeHtml(i.name)}</b> 想发送 ${
            i.files?.length ? i.files.length + " 个文件" : "文件"
          }</div>${files}${saveHint}<div class="inv-actions"><button data-acc="${i.session}" data-tid="${i.transferId}" class="btn ok">接收</button><button data-rej="${i.session}" data-tid="${i.transferId}" class="btn x">拒绝</button></div></div>`;
        })
        .join("")
    : "";

  renderTaskLists();
  // Blinking alert to the right of the "recv tasks N items" row: invite cards aren't put into the task list (they'd be swallowed by collapse),
  // instead we surface the count here and let the user open and handle them.
  const recvAlert = document.querySelector<HTMLButtonElement>("#recv-alert");
  if (recvAlert) {
    const pending = engine.invites.length;
    recvAlert.hidden = pending === 0;
    if (pending) recvAlert.textContent = pending > 1 ? `有 ${pending} 个新任务待接收` : "有新任务待接收";
  }

  // Top-bar status pill: color is driven only by engine facts; the full text goes into the title and the banner below;
  // the #status element id stays the same so historical selectors remain valid.
  const connected = engine.isConnected();
  const statusEl = document.querySelector<HTMLElement>("#status");
  if (statusEl) {
    const state = pillState(connected, engine.connecting);
    if (statusEl.dataset.state !== state) statusEl.dataset.state = state;
    const label = PILL_TEXT[state];
    const textEl = statusEl.querySelector<HTMLElement>("#status-text");
    if (textEl && textEl.textContent !== label) textEl.textContent = label;
    if (statusEl.title !== st.statusText) statusEl.title = st.statusText;
  }
  renderStatusBanner(st.statusText, st.statusAt);
  const connectionStatus = document.querySelector("#status-connection");
  if (connectionStatus) {
    connectionStatus.textContent = connected ? "● 已连接" : "○ 未连接";
    connectionStatus.classList.toggle("connected", connected);
  }
  const connBtn = document.querySelector<HTMLButtonElement>("#signal-connect");
  if (connBtn) {
    connBtn.textContent = engine.connecting ? "连接中…" : connected ? "断开" : "连接";
    connBtn.disabled = false;
  }
}

const BROWSER_SETTINGS_KEY = "p2p-drop-browser-connection-v1";
let browserSettingsOpen = true;
let browserTokenVisible = false;

async function boot(): Promise<void> {
  el("#app").innerHTML = `
    <header>
      <div class="brand">P2P传输</div>
      <div class="pills"><span class="pill">点对点传输</span><span class="pill ok">端到端加密</span></div>
      <div id="status" class="status" data-state="off" title="未连接"><span class="status-dot"></span><span id="status-text">未连接</span></div>
    </header>
    <div id="status-banner" class="status-banner" data-level="warn" hidden>
      <span class="sb-dot"></span><span class="sb-text" id="status-banner-text"></span>
      <button type="button" class="sb-act" id="status-banner-act">展开设置</button>
      <button type="button" class="sb-x" id="status-banner-close" aria-label="关闭提示" title="关闭提示">×</button>
    </div>
    <section class="connection-panel ${browserSettingsOpen ? "expanded" : ""} browser-connection">
      <div class="connection-summary"><span id="status-connection" class="connection">未连接</span><span>本机 <b id="self-summary">—</b></span><span id="token-summary" title="尚未从信令服务获得口令有效期">口令 <b data-ttl="unknown">—</b></span><button type="button" class="collapse" id="signal-toggle">${browserSettingsOpen ? "收起 ⌃" : "展开 ⌄"}</button></div>
      <div class="connection-form">
      <input id="signal-url-input" class="conn-url" type="text" placeholder="信令地址（如 ws://192.168.x.x:8787，留空则使用默认）" hidden />
      <label>设备名称<input id="signal-name" value="${escapeHtml(browserName)}" placeholder="例如：客厅电脑" /></label><label>访问口令<span class="secret-input"><input id="signal-token" type="${browserTokenVisible ? "text" : "password"}" autocomplete="off" placeholder="输入 1–7 天有效口令" /><button type="button" class="secret-toggle" id="browser-token-toggle" aria-label="显示或隐藏访问口令"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5S21.5 12 21.5 12 18.1 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>${browserTokenVisible ? '<path d="M3 3l18 18"/>' : ""}</svg></button></span></label><input type="hidden" id="signal-url" value="${escapeHtml(sigUrl)}" /><input type="hidden" id="signal-room" value="${escapeHtml(room)}" /><button type="button" class="btn" id="signal-connect">连接</button></div>
    </section>
    <div class="layout native-layout browser-layout">
      <aside class="sidebar native-sidebar">
        <div class="side-title"><span>设备</span><small id="peer-count"></small></div>
        <div id="peers" class="peers"></div>
        <div class="send-dock">
          <div class="dropzone" id="dropzone">
            <span class="dz-icon">⬆</span>
            <span class="dz-text" id="dz-text">请先选择设备</span>
            <span class="dz-sub" id="dz-sub" hidden></span>
          </div>
          <div id="pending" class="pending"></div>
        </div>
        <div class="sidebar-footer">
          <label class="rate-row"><span class="rate-label">发送限速</span><input id="rate-limit-side" type="number" min="0" max="2048" value="256" /><span class="rate-unit">（MiB/s）</span></label>
        </div>
      </aside>
      <main class="main native-main">
        <details class="card"${debugEnabled ? "" : " hidden"}><summary>高级传输与诊断（调试）</summary>
          <div class="advanced-grid">
            <label>诊断模式<select id="diagnostic-mode"><option value="full" selected>完整校验</option><option value="hash">仅哈希</option><option value="stream">仅流式</option><option value="discard">不保存</option></select></label>
            <label>发送限速（MiB/s，0 不限速）<input id="rate-limit" type="number" min="0" max="2048" value="256" /></label>
            <label>网络帧<select id="frame-size"><option value="16384">16 KiB</option><option value="32768">32 KiB</option><option value="65536" selected>64 KiB</option></select></label>
            <label>发送源<select id="source-kind"><option value="file">实际文件</option><option value="memory">内存合成数据（仅诊断）</option></select></label>
            <label>接收窗口<select id="receive-window"><option value="1">1 MiB</option><option value="4" selected>4 MiB</option><option value="8">8 MiB</option></select></label>
          </div>
          <p class="hint">日常传输使用“实际文件 + 完整校验”。诊断结果只在需要测速时查看。</p>
          <button id="export-diagnostics" class="btn">导出诊断结果</button>
          <pre id="diagnostic-results" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto"></pre>
        </details>
        <div class="task-section send-section">
          <div class="task-heading"><span>发送任务</span><small id="send-count">0 项</small><button type="button" class="task-toggle" id="send-toggle" data-toggle="send" hidden><span class="task-toggle-label"></span><span class="task-toggle-arrow">▾</span></button></div>
          <div class="section-summary" id="send-summary" hidden></div>
          <div id="send-transfers" class="task-list"></div>
        </div>
        <div class="task-section recv-section">
          <div class="task-heading"><span>接收任务</span><small id="recv-count">0 项</small><button type="button" class="task-alert" id="recv-alert" hidden></button><button type="button" class="task-toggle" id="recv-toggle" data-toggle="recv" hidden><span class="task-toggle-label"></span><span class="task-toggle-arrow">▾</span></button></div>
          <div class="section-summary" id="recv-summary" hidden></div>
          <div id="invites" class="invites"></div>
          <div id="recv-transfers" class="task-list"></div>
        </div>
      </main>
    </div>
    <footer>文件不经服务器 · 端到端 DTLS 加密直传</footer>`;

  engine.setHooks({ render, progress: updateProgressDom, diagnostics: renderDiagnostics });
  engine.init();
  render();
  // Countdown ticks once per second (to the second); only touches one text node inside #token-summary.
  setInterval(renderTokenTtl, 1000);
  if (engine.sig instanceof (await import("./signaling/browser")).BrowserSignaling) {
    try {
      const windowName = sessionStorage.getItem("p2p-window-name") || `浏览器-${uuid().slice(0, 4)}`;
      sessionStorage.setItem("p2p-window-name", windowName);
      el<HTMLInputElement>("#signal-name").value = windowName;
      // The signaling URL is **not restored from localStorage**: the URL is "deployment config" (app-config.js / ?sig=),
      // persisting the last-connected old URL would let this hidden field silently override app-config.js → "changes don't take effect".
      el<HTMLInputElement>("#signal-room").value = room;
      const windowToken = sessionStorage.getItem("p2p-window-token");
      if (windowToken !== null) el<HTMLInputElement>("#signal-token").value = windowToken;
    } catch {}
  }

  el<HTMLInputElement>("#rate-limit").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const rate = Number(input.value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 2048) {
      input.value = String(engine.scheduler.limits.rate / 1048576);
      return;
    }
    engine.setRate(rate);
  });
  el<HTMLInputElement>("#rate-limit-side").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    const rate = Number(input.value);
    if (Number.isFinite(rate) && rate >= 0 && rate <= 2048) engine.setRate(rate);
  });
  el<HTMLSelectElement>("#diagnostic-mode").addEventListener("change", (e) => {
    engine.setTestMode((e.target as HTMLSelectElement).value as TestMode);
  });
  el<HTMLSelectElement>("#receive-window").addEventListener("change", (e) => {
    engine.setReceiveWindow(Number((e.target as HTMLSelectElement).value));
  });
  el<HTMLSelectElement>("#frame-size").addEventListener("change", (e => {
    engine.setFrameBytes(Number((e.target as HTMLSelectElement).value));
  }));
  el<HTMLSelectElement>("#source-kind").addEventListener("change", (e => {
    engine.setSourceKind((e.target as HTMLSelectElement).value as "file" | "memory");
  }));
  el("#export-diagnostics").addEventListener("click", () => engine.exportDiagnostics());
  el("#app").addEventListener("click", async (e) => {
    const t = (e.target as Element).closest<HTMLButtonElement>("button");
    if (!t) return;
    if (t.id === "status-banner-close") {
      // Manual close: record the current statusAt, so the same message won't pop again (only a text change re-alerts).
      bannerDismissedAt = engine.store.get().statusAt;
      const b = document.querySelector<HTMLElement>("#status-banner");
      if (b) b.hidden = true;
    } else if (t.id === "status-banner-act") {
      // The "展开设置" (expand settings) on the banner: expand the connection panel and focus the token field — failures are usually about token/URL.
      if (!browserSettingsOpen) {
        browserSettingsOpen = true;
        document.querySelector(".browser-connection")?.classList.add("expanded");
        const toggle = document.querySelector<HTMLButtonElement>("#signal-toggle");
        if (toggle) toggle.textContent = "收起 ⌃";
      }
      document.querySelector(".browser-connection")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      el<HTMLInputElement>("#signal-token").focus();
    } else if (t.id === "signal-toggle") {
      browserSettingsOpen = !browserSettingsOpen;
      document.querySelector(".browser-connection")!.classList.toggle("expanded", browserSettingsOpen);
      t.textContent = browserSettingsOpen ? "收起 ⌃" : "展开 ⌄";
    } else if (t.id === "browser-token-toggle") {
      const input = el<HTMLInputElement>("#signal-token");
      const value = input.value;
      browserTokenVisible = !browserTokenVisible;
      input.type = browserTokenVisible ? "text" : "password";
      t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-5.5 9.5-5.5S21.5 12 21.5 12 18.1 17.5 12 17.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.6"/>${browserTokenVisible ? '<path d="M3 3l18 18"/>' : ""}</svg>`;
      input.value = value;
    } else if (t.id === "signal-connect") {
      try {
        const url = (el<HTMLInputElement>("#signal-url-input").value || "").trim() || sigUrl;
        const settings = {
          url,
          room: el<HTMLInputElement>("#signal-room").value,
          token: el<HTMLInputElement>("#signal-token").value,
          name: el<HTMLInputElement>("#signal-name").value,
        };
        // Only remember the transfer room; the signaling URL isn't persisted (see boot() note) to avoid an old URL overriding deployment config.
        localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify({ room: settings.room }));
        sessionStorage.setItem("p2p-window-name", settings.name);
        sessionStorage.setItem("p2p-window-token", settings.token);
        // The same button toggles connect/disconnect: when already connected, confirm before disconnecting.
        if (engine.isConnected() && !confirmDisconnect()) return;
        engine.connect(settings.url, settings.room, settings.token, settings.name);
      } catch (e) {
        engine.store.set({ statusText: engine.reasonText(e) });
      }
    } else if (t.dataset.cancel) {
      engine.cancel(t.dataset.cancel);
    } else if (t.dataset.delete) {
      engine.deleteTask(t.dataset.delete);
    } else if (t.dataset.pause) {
      engine.pause(t.dataset.pause);
    } else if (t.id === "send-selected") {
      engine.sendPending();
    } else if (t.dataset.rm) {
      engine.removePending(Number(t.dataset.rm));
    } else if (t.dataset.id) {
      engine.selectTarget(t.dataset.id);
    } else if (t.dataset.acc) {
      void engine.acceptInvite(t.dataset.acc, t.dataset.tid || "").catch((e) => {
        engine.store.set({ statusText: `接收失败：${engine.reasonText(e)}` });
        render();
      });
    } else if (t.id === "recv-strip-receive") {
      setFocus("recv");
      el("#invites").scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (t.id === "recv-alert") {
      // Expand the recv task section and scroll to the invite card; the user clicks "接收/拒绝" (accept/reject) themselves.
      setFocus("recv");
      el("#invites").scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else if (t.dataset.toggle) {
      const sec = t.dataset.toggle as "send" | "recv";
      setFocus(focusedSection === sec ? null : sec);
    } else if (t.dataset.rej) {
      engine.rejectInvite(t.dataset.rej, t.dataset.tid || "");
    }
  });
  // Drag-and-drop to add files: files only (folders are skipped, not recursed).
  const dropzone = el<HTMLElement>("#dropzone");
  if (dropzone) {
    dropzone.addEventListener("click", () => {
      if (!engine.sendTargetId) return;
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        if (input.files) engine.chooseFiles(Array.from(input.files).map((f) => ({ name: f.name, size: f.size, file: f })));
      };
      input.click();
    });
    for (const ev of ["dragenter", "dragover"] as const) {
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
    }
    dropzone.addEventListener("dragleave", (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      if (!engine.sendTargetId) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      const files: File[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind !== "file") continue;
        const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => { isDirectory: boolean } | null }).webkitGetAsEntry?.();
        if (entry && entry.isDirectory) continue;
        const f = item.getAsFile();
        if (f) files.push(f);
      }
      if (files.length) engine.chooseFiles(files.map((f) => ({ name: f.name, size: f.size, file: f })));
    });
  }
  // Press feedback (same set as mobile, see ui/press-feedback.ts)
  wirePressFeedback(el("#app"));
}

if (isTauri()) {
  const __tauriNative = "./tauri/native";
  // @ts-ignore Tauri desktop adapter excluded from open-source pure-web build
  void import(/* @vite-ignore */ __tauriNative).then(({ bootNative }) => bootNative()).catch((e) => {
    document.querySelector("#app")!.textContent = String(e);
  });
} else {
  void boot();
}
