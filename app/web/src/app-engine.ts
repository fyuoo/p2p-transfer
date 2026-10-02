// Transport engine: extracts "transfer logic" (signaling/session/task/scheduling) away from the UI, shared by
// the desktop (main.ts) and mobile (mobile.ts) frontends, which each implement only their rendering layer.
// The engine touches no DOM (only exportDiagnostics uses the download API, common to both frontends).
import { Store } from "./ui/store";
import { Session } from "./session";
import { TauriSignaling } from "./signaling/tauri";
import { BrowserSignaling } from "./signaling/browser";
import {
  BrowserFileReader,
  TauriFileReader,
  isTauri,
  selectSaveDirectory,
  setSaveDir,
  getSaveDir,
  hasSaveDir,
  isDownloadSink,
  makeReceiverWriter,
} from "./file/source";
import { TransferManager } from "./transfer/manager";
import { MemoryFileReader } from "./file/memory";
import { DiagnosticResult, MODE_LABELS, TestMode, usesDisk } from "./transfer/diagnostics";
import { TransferScheduler, delay } from "./transfer/scheduler";
import { FileReader, ChannelCallbacks } from "./webrtc/channel";
import { env } from "./env";
import { genId, DEFAULT_RECEIVE_WINDOW } from "./webrtc/protocol";
import { iceServersOf, iceTransportPolicyOf, iceTrickleOf } from "./webrtc/ice-config";
import { SignalPayload, InviteFile, Signaling } from "./signaling/types";
import { TransferTelemetryEvent } from "../../../public/telemetry";
import { AUTH_TEXT_PREFIX, DIAG_STATUS_LABELS, PC_STATE_LABELS, reasonLabel } from "./reason-labels";

export interface PendingItem {
  name: string;
  size: number;
  file?: File;
  tauriPath?: string;
}

export interface EngineHooks {
  /** Called when the engine state changes (store change or internal state change); the renderer redraws fully or incrementally. */
  render(): void;
  /** High-frequency progress events (every 256KB block): the renderer updates the matching card's progress bar directly, no full redraw. */
  progress?(id: string, sent: number, size: number): void;
  /** Diagnostic result update (desktop debug panel only). */
  diagnostics?(): void;
}

export interface EngineOptions {
  sigUrl: string;
  browserName: string;
  room: string;
  token?: string;
  debugEnabled: boolean;
}

// Cancel/disconnect are expected terminal states: the task card already carries its own terminal state and note, so we must not overwrite the global status bar.
const QUIET_REASONS = new Set(["USER_CANCEL", "CANCELLED_OR_DISCONNECTED", "CONN_DROPPED"]);
const isQuietReason = (e: unknown): boolean => QUIET_REASONS.has(e instanceof Error ? e.message : String(e));

// Actual transport path: one entry per connection (peerId).
//  lan   = LAN direct (both ends are host candidates, or not crossing the public internet / NAT)
//  wan   = public-internet direct (P2P but at least one end traversed NAT: srflx / prflx)
//  relay = relayed through TURN
type PathType = "lan" | "wan" | "relay" | "unknown";
// Private address detection: RFC1918 + loopback + IPv6 link-local / unique-local.
// Used to re-verify connections whose candidateType was judged "wan": browsers hide host candidates as .local
// via mDNS by default, and when cross-device resolution fails it falls back to srflx on the same NAT egress —
// physically still the same private network, so it should be judged as LAN direct.
function isPrivateAddr(addr?: string): boolean {
  if (!addr) return false;
  if (addr === "localhost" || addr.startsWith("127.") || addr.startsWith("::1")) return true;
  if (addr.startsWith("10.")) return true;
  if (addr.startsWith("192.168.")) return true;
  if (addr.startsWith("172.")) {
    const seg = parseInt(addr.split(".")[1] ?? "0", 10);
    if (seg >= 16 && seg <= 31) return true;
  }
  if (addr.startsWith("fe80:")) return true; // IPv6 link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // IPv6 ULA
  return false;
}
function pathTypeOf(local?: string, remote?: string, localAddr?: string, remoteAddr?: string): PathType {
  if (local === "relay" || remote === "relay") return "relay";
  // When either end's candidate type is missing we can't decide yet; stay unknown and keep polling
  if (!local || !remote) return "unknown";
  // Both ends are host candidates → direct connection within the same LAN
  if (local === "host" && remote === "host") return "lan";
  // When candidateType is judged "wan" (incl. srflx / prflx / mixed), re-verify with the real addresses:
  // both ends in private ranges → physically still the same NAT / LAN, judged LAN direct even via STUN reflection.
  if (isPrivateAddr(localAddr) && isPrivateAddr(remoteAddr)) return "lan";
  // the rest (srflx / prflx / mixed with public addresses) → cross-public-internet P2P direct (NAT traversal succeeded, no relay)
  return "wan";
}

export class AppEngine {
  readonly store = new Store();
  readonly manager: TransferManager;
  readonly scheduler = new TransferScheduler({ active: 4, perDirection: 2, memory: 64 * 1024 * 1024 });
  sig: Signaling;
  readonly sigUrl: string;
  readonly browserName: string;
  room: string;

  // ICE: pure LAN defaults to host candidates only; overridden when the signaling server sends STUN/TURN.
  RTC_CONFIG: RTCConfiguration = { iceServers: [] };
  // trickle ICE toggle: on by default (non-trickle can hang connection setup when TURN allocation doesn't settle).
  iceTrickle = true;

  // ---- Shared UI state (renderer reads only; mutations go through engine methods) ----
  sendTargetId: string | null = null;
  pendingItems: PendingItem[] = [];
  invites: { session: string; from: string; name: string; files?: InviteFile[]; transferId: string }[] = [];
  pausedTransfers = new Set<string>();
  deviceNames = new Map<string, string>();
  /** Actual transport path per connection (P2P direct / TURN relay), probed after connection is established, for task-card highlighting. */
  peerPathType = new Map<string, PathType>();
  selfId = "";
  connecting = false;

  // ---- Transfer config ----
  testMode: TestMode = "full";
  receiveWindowBytes = DEFAULT_RECEIVE_WINDOW;
  frameBytes = 65536;
  sourceKind: "file" | "memory" = "file";
  debugEnabled: boolean;

  // ---- Diagnostics / telemetry ----
  diagnosticResults = new Map<string, DiagnosticResult>();
  telemetryEvents: TransferTelemetryEvent[] = [];

  // ---- Internal session state ----
  private sessions = new Map<string, Session>();
  private nativeSendSessions = new Map<string, Session>();
  private sessionStarts = new Map<string, Promise<Session>>();
  private earlySignals: { session: string; data: SignalPayload }[] = [];
  private hooks?: EngineHooks;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private connTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: EngineOptions) {
    this.sigUrl = opts.sigUrl;
    this.browserName = opts.browserName;
    this.room = opts.room;
    this.debugEnabled = opts.debugEnabled;
    this.sig = isTauri()
      ? new TauriSignaling()
      : new BrowserSignaling(opts.sigUrl, opts.browserName, opts.room, opts.token ?? "");
    this.manager = new TransferManager((task) => {
      const status =
        task.phase === "completed"
          ? "done"
          : task.phase === "failed" || task.phase === "cancelled"
            ? "error"
            : task.phase === "committing"
              ? "writing"
              : task.phase === "active"
                ? "active"
                : "pending";
      for (const file of this.store.get().transfers.filter((f) => f.id.startsWith(task.id + ":") && f.status !== "done"))
        this.store.updateTransfer(file.id, { status });
    });
  }

  setHooks(h: EngineHooks): void {
    this.hooks = h;
  }

  /** Register all signaling callbacks (must be called once before connect). */
  init(): void {
    this.sig.onPeerList((peers) => {
      peers.forEach((p) => this.deviceNames.set(p.id, p.name));
      if (this.sendTargetId && !peers.some((p) => p.id === this.sendTargetId)) this.sendTargetId = null;
      this.store.set({ peers });
    });
    // Incoming invite (file manifest): dedupe by session; the manifest fills in names/sizes before accept so they're visible early.
    this.sig.onInvite((from, name, session, files, transferId) => {
      if (!transferId || !files) return;
      try {
        this.manager.create(transferId, session, "recv", files);
      } catch {
        void this.sig.rejectTransfer(session, transferId).catch(() => {});
        return;
      }
      if (this.manager.tasks.get(transferId)?.phase !== "invited") return;
      this.sendTargetId = session;
      const existing = this.invites.find((i) => i.session === session && i.transferId === transferId);
      if (existing) {
        if (files?.length) existing.files = files;
        if (transferId) existing.transferId = transferId;
      } else {
        this.invites.push({ session, from, name, files: files ?? [], transferId: transferId ?? "" });
      }
      this.scheduleRender();
    });
    // Buffer signaling callbacks: cache until selfId is ready, since role determination depends on it.
    this.sig.onSignal((session, data) => {
      if (!this.selfId) this.earlySignals.push({ session, data });
      else this.handleSignal(session, data);
    });
    this.sig.onAccept((from, transferId) => this.manager.accept(from, transferId));
    this.sig.onReject((from, transferId) => this.manager.reject(from, transferId));
    this.sig.onBye((session) => {
      this.sessions.get(session)?.close();
      this.sessions.delete(session);
      // The peer is gone: an unaccepted invite can never be confirmed, so drop it (otherwise a permanent "awaiting confirm" zombie card remains).
      // Established transfers are unaffected — the data channel is direct and independent of signaling being online.
      for (const [tid, task] of this.manager.tasks) {
        if (task.peerId === session && task.direction === "recv" && task.phase === "invited")
          this.manager.phase(tid, "cancelled", "对端已断开");
      }
      this.dropInvites(session);
      this.store.set({ statusText: "对端已断开" });
    });
    this.sig.onSelfChange?.((s) => {
      const reconnecting = !!this.selfId && this.selfId !== s.id;
      this.selfId = s.id;
      this.connecting = false;
      if (this.connTimer) clearTimeout(this.connTimer);
      for (const [, ses] of this.sessions) ses.close();
      this.sessions.clear();
      this.store.set({
        self: s,
        statusText: reconnecting ? "信令已重连，会话已重建" : "信令已连接 · 浏览器传输",
      });
      while (this.earlySignals.length) {
        const event = this.earlySignals.shift()!;
        this.handleSignal(event.session, event.data);
      }
    });
    if (this.sig instanceof BrowserSignaling) {
      this.sig.onIceConfig((ice: unknown) => {
        const servers = iceServersOf(ice);
        if (!servers) return;
        this.RTC_CONFIG = {
          ...this.RTC_CONFIG,
          iceServers: servers,
          iceTransportPolicy: iceTransportPolicyOf((ice as { iceTransportPolicy?: unknown }).iceTransportPolicy),
        };
        this.iceTrickle = iceTrickleOf((ice as { iceTrickle?: unknown }).iceTrickle);
      });
      this.sig.onStatus((statusText) => {
        if (statusText.includes("已连接") || statusText.includes("重连")) this.connecting = false;
        // Token rejected (text always starts with AUTH_TEXT_PREFIX, see reason-labels.ts):
        // there will be no more reconnects, so don't let the 15s timeout overwrite this more accurate hint.
        if (statusText.startsWith(AUTH_TEXT_PREFIX)) {
          if (this.connTimer) clearTimeout(this.connTimer);
          this.connecting = false;
        }
        this.store.set({ statusText });
        this.scheduleRender();
      });
      // Token expiry: welcome sends the expiry timestamp (clock-skew corrected); disconnect calls back with undefined.
      this.sig.onTokenExpiry?.((tokenExpiresAt) => this.store.set({ tokenExpiresAt }));
    }
    this.store.subscribe(() => this.scheduleRender());
  }

  subscribe(cb: (s: ReturnType<Store["get"]>) => void): () => void {
    return this.store.subscribe(cb as (s: import("./ui/store").AppState) => void);
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.hooks?.render();
    }, 300);
  }

  isConnected(): boolean {
    return this.sig instanceof BrowserSignaling ? this.sig.isConnected() : false;
  }
  /** Count of tasks not yet at a terminal state (active/queued/awaiting-accept). Completed/failed/cancelled don't count as "in progress". */
  activeTaskCount(): number {
    return [...this.manager.tasks.values()].filter((t) => !["completed", "failed", "cancelled"].includes(t.phase)).length;
  }
  isPaused(id: string): boolean {
    return this.pausedTransfers.has(id);
  }
  targetName(id: string): string {
    return this.store.get().peers.find((p) => p.id === id)?.name ?? this.deviceNames.get(id) ?? id.slice(0, 6);
  }

  // ---------------- Connect ----------------
  connect(url: string, room: string, token: string, name: string): void {
    const connected = this.sig instanceof BrowserSignaling && this.sig.isConnected();
    // Only "reconfigure-reconnect" is blocked here while tasks are running; disconnect is confirmed by the UI first (see main.ts / mobile.ts), not blocked here.
    if (!connected && this.activeTaskCount()) {
      this.store.set({ statusText: "请先完成或取消当前任务，再修改信令配置" });
      return;
    }
    try {
      if (connected && this.sig instanceof BrowserSignaling) {
        this.sig.stop();
        this.abandonActiveTasks();
        for (const s of this.sessions.values()) s.close();
        this.sessions.clear();
        return;
      }
      this.room = room;
      this.connecting = true;
      this.store.set({ statusText: "正在连接信令服务…" });
      if (this.sig instanceof BrowserSignaling) this.sig.configure(url, room, token, name);
      this.connTimer = setTimeout(() => {
        if (this.sig instanceof BrowserSignaling && !this.sig.isConnected()) {
          this.sig.stop();
          this.connecting = false;
          this.store.set({ statusText: "信令连接超时，请检查地址或口令后重试" });
        }
      }, 15000);
      for (const s of this.sessions.values()) s.close();
      this.sessions.clear();
      this.scheduleRender();
    } catch (e) {
      this.connecting = false;
      this.store.set({ statusText: this.reasonText(e) });
    }
  }
  disconnect(): void {
    if (this.sig instanceof BrowserSignaling && this.sig.isConnected()) {
      this.sig.stop();
      this.abandonActiveTasks();
      for (const s of this.sessions.values()) s.close();
      this.sessions.clear();
    }
  }
  /** Cleanup on disconnect: tasks not yet terminal are marked cancelled, and unaccepted invites are voided.
   *  Otherwise tasks would be stuck "in progress", and the next connect() guard would block it, creating "can't disconnect and can't connect". */
  private abandonActiveTasks(): void {
    let affected = 0;
    for (const t of [...this.manager.tasks.values()]) {
      if (["completed", "failed", "cancelled"].includes(t.phase)) continue;
      affected++;
      this.pausedTransfers.delete(t.id);
      this.scheduler.resume(t.id);
      this.manager.cancel(t.id);
      this.sessions.get(t.peerId)?.cancel(t.id);
      this.nativeSendSessions.get(t.id)?.close();
      this.setTaskNote(t.id, "连接已断开，任务已中断");
    }
    this.invites = [];
    if (affected) this.scheduleRender();
  }

  // ---------------- Select / stage / send ----------------
  selectTarget(id: string): void {
    this.sendTargetId = this.sendTargetId === id ? null : id;
    this.scheduleRender();
  }
  chooseFiles(items: PendingItem[]): void {
    if (!items.length) return;
    if (this.sendTargetId) {
      const target = this.sendTargetId;
      this.clearPending();
      this.scheduleRender();
      void this.startSend(target, items).catch((e) => { if (!isQuietReason(e)) this.store.set({ statusText: this.reasonText(e) }); });
    } else {
      this.pendingItems.push(...items);
      this.scheduleRender();
    }
  }
  sendPending(): void {
    if (!this.sendTargetId || !this.pendingItems.length) return;
    const items = this.pendingItems;
    const target = this.sendTargetId;
    this.clearPending();
    this.scheduleRender();
    void this.startSend(target, items).catch((e) => { if (!isQuietReason(e)) this.store.set({ statusText: this.reasonText(e) }); });
  }
  removePending(i: number): void {
    this.pendingItems.splice(i, 1);
    this.scheduleRender();
  }
  clearPending(): void {
    this.pendingItems = [];
  }

  // ---------------- Pause / resume / cancel / delete ----------------
  pause(id: string): void {
    if (this.pausedTransfers.has(id)) {
      this.pausedTransfers.delete(id);
      this.scheduler.resume(id);
      void this.sig.sendSignal(this.manager.tasks.get(id)?.peerId ?? "", { kind: "resume", transferId: id }).catch(() => {});
    } else {
      this.pausedTransfers.add(id);
      this.scheduler.pause(id);
      void this.sig.sendSignal(this.manager.tasks.get(id)?.peerId ?? "", { kind: "pause", transferId: id }).catch(() => {});
    }
    this.scheduleRender();
  }
  cancel(id: string): void {
    const task = this.manager.tasks.get(id);
    if (task) {
      this.pausedTransfers.delete(id);
      this.scheduler.resume(id);
      const notified = this.sig.sendSignal(task.peerId, { kind: "cancel", transferId: id, reason: "用户取消" });
      this.manager.cancel(id);
      this.setTaskNote(id, "");
      this.sessions.get(task.peerId)?.cancel(id);
      this.nativeSendSessions.get(id)?.close();
      void notified.catch((e) => this.store.set({ statusText: `本地已取消，但通知对端失败：${this.reasonText(e)}` }));
    }
  }
  deleteTask(root: string): void {
    this.store.removeTransfers(
      new Set([...this.store.get().transfers].filter((x) => x.id.startsWith(root + ":")).map((x) => x.id)),
    );
    this.manager.tasks.delete(root);
    this.scheduleRender();
  }
  acceptInvite(session: string, tid: string): Promise<void> {
    const idx = this.invites.findIndex((i) => i.session === session && (!tid || i.transferId === tid));
    if (idx < 0) return Promise.resolve();
    const inv = this.invites[idx];
    const mode = inv.files?.[0]?.diagnosticMode ?? "full";
    if (usesDisk(mode)) {
      const h = getSaveDir();
      if (!h) {
        // Browser selects the save directory within a user gesture; Tauri uses its directory picker.
        void selectSaveDirectory()
          .then((handle) => {
            if (!handle) {
              this.store.set({ statusText: "未选择保存位置，尚未接受任务" });
              this.scheduleRender();
              return;
            }
            setSaveDir(handle);
            return this.doAccept(inv.session, inv.transferId);
          })
          .catch((e) => {
            this.store.set({ statusText: `接收失败：${this.reasonText(e)}` });
            this.scheduleRender();
          });
        return Promise.resolve();
      }
    }
    return this.doAccept(session, tid);
  }
  private async doAccept(session: string, tid: string): Promise<void> {
    const idx = this.invites.findIndex((i) => i.session === session && (!tid || i.transferId === tid));
    if (idx < 0) return;
    const inv = this.invites[idx];
    // The invite may already be stale (peer gave up, direct connect failed, peer disconnected): manager.authorize then throws
    // INVALID_AUTHORIZATION and the user just sees "nothing happens". Give a clear hint here and remove the card.
    if (this.manager.tasks.get(inv.transferId)?.phase !== "invited") {
      this.invites.splice(idx, 1);
      this.store.set({ statusText: "该接收请求已失效（对端已取消或已断开）" });
      this.scheduleRender();
      return;
    }
    const mode = inv.files?.[0]?.diagnosticMode ?? "full";
    if (usesDisk(mode) && !hasSaveDir()) {
      this.store.set({ statusText: "未选择保存位置，尚未接受任务" });
      return;
    }
    this.manager.authorize(inv.transferId, usesDisk(mode) ? getSaveDir() : { diagnosticDiscard: true });
    this.recordTelemetry({ event: "invite_accepted", taskId: inv.transferId, direction: "recv", status: "authorized" });
    const task = this.manager.tasks.get(inv.transferId);
    if (task) task.receiveWindowBytes = this.receiveWindowBytes;
    for (const [index, file] of (inv.files ?? []).entries()) {
      const fileId = `${inv.transferId}:${index}`;
      if (!this.store.get().transfers.some((t) => t.id === fileId)) {
        this.store.set({
          transfers: [
            ...this.store.get().transfers,
            { id: fileId, peerId: session, name: file.name, size: file.size, sent: 0, status: "pending", direction: "recv" },
          ],
        });
      }
    }
    this.invites.splice(idx, 1);
    // Mobile has no filesystem API: the receive target degrades to "browser download"; tell the user where the file will land
    // first (or to switch to the system browser for in-app browsers). Text comes from env.ts, shared with the invite card/banner.
    const downloadHint = env().hint;
    if (usesDisk(mode) && isDownloadSink(getSaveDir()) && downloadHint)
      this.setTaskNote(inv.transferId, downloadHint);
    const crossEngine = this.store.get().peers.find((p) => p.id === session)?.engine === "windows-native-v1";
    await this.ensureSessionInit(session, crossEngine ? "follower" : undefined);
    try {
      await this.sig.acceptTransfer(session, inv.transferId);
    } catch (error) {
      this.manager.reject(session, inv.transferId, "接收确认发送失败");
      const message = error instanceof Error ? error.message : String(error);
      this.setTaskNote(inv.transferId, `接收确认失败：${this.reasonText(message)}`);
      this.scheduleRender();
      throw error;
    }
    // Already accepted: watch whether the direct connection actually comes up; if not, fail the task (otherwise the card stays "awaiting").
    const live = this.sessions.get(session);
    if (live) void this.watchPeerConnection(live, inv.transferId);
    this.scheduleRender();
  }
  // Unreceived invites (rejected / peer timeout-cancelled) become terminal task records, for later tracing of "who sent me what".
  private recordInviteEnd(session: string, inv: { transferId: string; files?: { name: string; size: number }[] }, status: "rejected" | "expired", note: string): void {
    const transfers = this.store.get().transfers;
    const added: import("./ui/store").TransferItem[] = [];
    (inv.files ?? []).forEach((file, index) => {
      const fileId = `${inv.transferId}:${index}`;
      if (transfers.some((t) => t.id === fileId)) return;
      added.push({ id: fileId, peerId: session, name: file.name, size: file.size, sent: 0, status, direction: "recv", note });
    });
    if (added.length) this.store.set({ transfers: [...transfers, ...added] });
  }
  rejectInvite(session: string, tid: string): void {
    if (tid) void this.sig.rejectTransfer(session, tid).catch(() => {});
    this.manager.reject(session, tid);
    const i = this.invites.findIndex((x) => x.session === session && x.transferId === tid);
    if (i >= 0) {
      this.recordInviteEnd(session, this.invites[i], "rejected", "你拒绝了该接收请求");
      this.invites.splice(i, 1);
    }
    this.scheduleRender();
  }

  // ---------------- Config ----------------
  setRate(mib: number): void {
    this.scheduler.setRate(mib * 1048576);
  }
  setTestMode(m: TestMode): void {
    this.testMode = m;
  }
  setFrameBytes(n: number): void {
    this.frameBytes = n;
  }
  setSourceKind(k: "file" | "memory"): void {
    this.sourceKind = k;
  }
  setReceiveWindow(mib: number): void {
    this.receiveWindowBytes = mib * 1048576;
  }

  // ---------------- Error code → Chinese label ----------------
  reasonText(raw: unknown): string {
    return reasonLabel(raw);
  }

  // ---------------- Diagnostics / telemetry ----------------
  private telemetryError(raw: unknown): string {
    const text = String(raw ?? "").replace(/^Error:\s*/, "");
    return text.length > 96 ? text.slice(0, 96) : text;
  }
  private recordTelemetry(event: Omit<TransferTelemetryEvent, "eventId" | "timestamp" | "runtime" | "schema">): void {
    this.telemetryEvents.push({ ...event, eventId: genId(), timestamp: new Date().toISOString(), runtime: "browser", schema: 1 });
    if (this.telemetryEvents.length > 2000) this.telemetryEvents.splice(0, this.telemetryEvents.length - 2000);
  }
  diagnosticText(): string {
    const node = [...this.diagnosticResults.values()].slice(-8).map((r) =>
      `${r.transferId.slice(0, 8)} ${r.direction === "send" ? "发送" : "接收"} ${MODE_LABELS[r.mode]}\n${DIAG_STATUS_LABELS[r.status] ?? this.reasonText(r.status)} · ${(r.payloadBytes / 1048576).toFixed(1)} MiB · ${(r.elapsedMs / 1000).toFixed(1)} s · ${r.averageMiBs.toFixed(2)} MiB/s\n读 ${(r.readMs / 1000).toFixed(2)}s / 哈希 ${(r.hashMs / 1000).toFixed(2)}s / 写 ${(r.writeMs / 1000).toFixed(2)}s / 提交 ${(r.finalizeMs / 1000).toFixed(2)}s / 等额度 ${(r.creditWaitMs / 1000).toFixed(2)}s / 等调度 ${(r.schedulerWaitMs / 1000).toFixed(2)}s\n接收队列峰值 ${(r.queuePeakBytes / 1048576).toFixed(2)} MiB · 后台采样 ${r.hiddenSamples}`,
    ).join("\n\n");
    const entries = [...this.diagnosticResults.values()];
    const latest = entries[entries.length - 1];
    if (!latest) return node;
    return (
      node +
      `\n\n当前接收窗口 ${latest.receiveWindowBytes / 1048576} MiB · 额度耗尽 ${latest.creditStalls} 次 · 唤醒 ${latest.creditWakeups} 次\n平均唤醒 ${latest.creditWakeups ? (latest.creditResumeMs / latest.creditWakeups).toFixed(3) : "0"} ms · 平均到发送 ${latest.creditWakeups ? (latest.creditToSendMs / latest.creditWakeups).toFixed(3) : "0"} ms · 预读 1 块`
    );
  }
  exportDiagnostics(): void {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            schema: 3,
            exportedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            note: "诊断数据不包含文件内容、完整路径、口令或网络地址",
            telemetry: this.telemetryEvents,
            results: [...this.diagnosticResults.values()],
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `p2p-diagnostics-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ================= Below: internal transfer-logic implementation =================

  private setTaskNote(tid: string, note: string): void {
    for (const f of this.store.get().transfers.filter((x) => x.id.startsWith(tid + ":") && x.note !== note)) {
      this.store.updateTransfer(f.id, { note });
    }
  }
  private lastSendError?: { phase: string; bytes: number; buffered: number; readyState: string; name: string; message: string; frameBytes?: number; maxMessageSize?: number; stack?: string };
  private markTransferError(tid: string, reason: string): void {
    if (this.manager.tasks.get(tid)?.phase === "cancelled") {
      // Cancelled: keep the file rows as they are (a file the sender already handed over really is complete from
      // this end) and only label the task, instead of repainting finished files as errors.
      this.setTaskNote(tid, this.reasonText(reason));
      return;
    }
    for (const t of this.store.get().transfers) {
      if (t.id.startsWith(tid + ":") && t.status !== "done") this.store.updateTransfer(t.id, { status: "error" });
    }
    const fp = this.lastSendError;
    if (fp) console.error('[p2p] transfer failed after a send error', fp);
    this.setTaskNote(tid, this.reasonText(reason) + (fp ? `（${fp.phase} · buffered=${fp.buffered} · ${fp.readyState} · ${fp.bytes}B）` : ''));
  }
  private onState(id: string, s: RTCPeerConnectionState): void {
    this.store.set({ statusText: `连接(${this.targetName(id)})：${PC_STATE_LABELS[s] ?? s}` });
    // After connection is established, probe the actual transport path (P2P direct / TURN relay) for task-card highlighting.
    if (s === "connected") void this.probePathType(id);
    if (s === "failed" || s === "closed") this.sessions.delete(id);
    // Direct-connect failure must also terminate that peer's tasks: the status bar says "connection failed" while the card still says "awaiting",
    // making the user think it's still queued waiting (on the receive side, no data channel means no transfer callback ever fires).
    if (s === "failed") this.failPeerTasks(id, "ICE_FAILED");
  }
  // Probe the actual transport path after connection is established: read the selected candidate pair's local/remote candidateType.
  // Under trickle ICE the selectedCandidatePair may be chosen slightly later than 'connected', so poll for at most ~3.6s.
  // The path is shared per connection (not per task); one result is stored per peerId for task-card highlighting.
  private async probePathType(id: string): Promise<void> {
    const s = this.sessions.get(id) ?? [...this.nativeSendSessions.values()].find((v) => v.session === id);
    if (!s) return;
    for (let i = 0; i < 12; i++) {
      await delay(300, new AbortController().signal);
      try {
        const stats = await s.getTransportStats();
        const path = pathTypeOf(stats.local?.candidateType, stats.remote?.candidateType, stats.local?.address, stats.remote?.address);
        if (path !== "unknown") {
          this.peerPathType.set(id, path);
          this.scheduleRender();
          return;
        }
      } catch {
        /* getStats occasionally fails: keep polling */
      }
    }
  }
  // Mark all of a peer's not-yet-terminal tasks as failed at once, with the reason.
  private failPeerTasks(peerId: string, reason: string): void {
    let changed = false;
    const failed: string[] = [];
    for (const [tid, task] of this.manager.tasks) {
      if (task.peerId !== peerId || ["completed", "failed", "cancelled"].includes(task.phase)) continue;
      if (task.localResult !== "sent") this.manager.local(tid, "failed", reason);
      if (reason !== "CONN_DROPPED" && reason !== "ICE_FAILED" && reason !== "CONN_TIMEOUT") this.manager.remote(tid, "failed", reason);
      this.manager.phase(tid, "failed", reason);
      task.aborter.abort(new Error(reason));
      this.markTransferError(tid, reason);
      failed.push(tid);
      changed = true;
    }
    // Invite cards don't go through manager.tasks's render path: marking the task failed leaves the card stuck at "awaiting accept",
    // and clicking "receive" would throw INVALID_AUTHORIZATION because the task is no longer invited — so drop them too.
    if (failed.length && this.dropInvites(peerId, new Set(failed))) changed = true;
    if (changed) this.scheduleRender();
  }
  // Remove a peer's invite cards (with `only`, only those transferIds). When the peer gave up or disconnected,
  // these invites can never be confirmed again; keeping them is just an unclickable zombie card.
  private dropInvites(session: string, only?: Set<string>): boolean {
    const before = this.invites.length;
    this.invites = this.invites.filter((i) => i.session !== session || Boolean(only && !only.has(i.transferId)));
    return this.invites.length !== before;
  }
  // The receive side lacks the sender's whenConnected timeout path: when direct connect never comes up, the data channel is never created,
  // no transfer callback ever fires → the card stays "awaiting" forever. Add an equivalent watchdog here.
  private async watchPeerConnection(s: Session, tid: string): Promise<void> {
    try {
      await s.whenConnected();
    } catch (e) {
      const phase = this.manager.tasks.get(tid)?.phase;
      if (!phase || ["completed", "failed", "cancelled"].includes(phase)) return;
      const reason = e instanceof Error ? e.message : "CONN_TIMEOUT";
      this.manager.phase(tid, "failed", reason);
      this.markTransferError(tid, reason);
      this.scheduleRender();
    }
  }
  private async withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }
  private async buildReaders(items: PendingItem[]): Promise<FileReader[]> {
    if (isTauri()) return items.map((it) => new TauriFileReader(it.tauriPath!, it.name, it.size));
    return items.map((it) => new BrowserFileReader(it.file!));
  }

  // Per-transfer callbacks: the receiver builds entries / writes to disk from these; the sender never triggers onManifest.
  private makeCallbacks(tid: string, peerId: string): ChannelCallbacks {
    return {
      receiveWindowBytes: this.manager.tasks.get(tid)?.receiveWindowBytes,
      onDiagnostics: (result) => {
        if (this.diagnosticResults.size >= 100 && !this.diagnosticResults.has(tid)) this.diagnosticResults.delete(this.diagnosticResults.keys().next().value!);
        this.diagnosticResults.set(tid, result);
        if (result.lastSendError) this.lastSendError = result.lastSendError;
        this.hooks?.diagnostics?.();
      },
      writerFactory: (meta) =>
        makeReceiverWriter(meta, this.manager.tasks.get(tid)?.destination).then((w) => {
          const sn = (w as { savedName?: string }).savedName;
          if (sn) this.store.updateTransfer(`${tid}:${meta.fileIndex}`, { savedName: sn });
          const notice = (w as { notice?: string }).notice;
          if (notice) this.setTaskNote(tid, notice);
          return w;
        }),
      onQueued: () => { this.manager.phase(tid, "queued"); const direction = this.manager.tasks.get(tid)?.direction ?? "recv"; if (direction === "send") this.manager.local(tid, "sending"); else this.manager.remote(tid, "receiving"); },
      onManifest: (files) => {
        for (const f of files) {
          const id = `${tid}:${f.fileIndex}`;
          if (!this.store.get().transfers.find((t) => t.id === id))
            this.store.set({
              transfers: [
                ...this.store.get().transfers,
                { id, peerId, name: f.name, size: f.size, sent: 0, status: "pending", direction: "recv" },
              ],
            });
        }
      },
      onProgress: (fileIndex, received, total) => {
        this.manager.file(tid, fileIndex, "receiving");
        this.manager.phase(tid, "active");
        const id = `${tid}:${fileIndex}`;
        const t = this.store.get().transfers.find((x) => x.id === id);
        if (t) {
          this.store.updateTransfer(id, { sent: received, status: "active", ...(this.manager.tasks.get(tid)?.direction === "send" ? { localResult: "sending" } : { remoteResult: "receiving" }) }, false);
          this.hooks?.progress?.(id, received, total);
        } else
          this.store.set({
            transfers: [
              ...this.store.get().transfers,
              {
                id,
                peerId,
                name: `file#${fileIndex}`,
                size: total,
                sent: received,
                status: "active",
                direction: this.manager.tasks.get(tid)?.direction ?? "recv",
              },
            ],
          });
      },
      onFileFinalizing: (fileIndex, total) => {
        this.manager.file(tid, fileIndex, "finalizing");
        // Receiver-only (channel.ts fires it where the disk pipeline actually starts): bytes are in, disk write pending.
        this.manager.phase(tid, "committing");
        const id = `${tid}:${fileIndex}`;
        this.store.updateTransfer(id, { sent: total, status: "writing", writingSince: Date.now() });
        this.setTaskNote(tid, "字节已收齐 · 正在写入磁盘…");
      },
      onFileComplete: (fileIndex, ok) => {
        this.manager.file(tid, fileIndex, ok ? "saved" : "failed");
        const id = `${tid}:${fileIndex}`;
        const patch: Partial<import("./ui/store").TransferItem> = {
          status: ok ? "done" : "error",
          ...(ok ? (this.manager.tasks.get(tid)?.direction === "send" ? { localResult: "sent" } : { localResult: "saved" }) : { remoteResult: "failed" }),
          writingSince: undefined,
          sent: this.store.get().transfers.find((t) => t.id === id)?.size ?? 0,
        };
        // Clear the phase note on both ends once the file is settled: the receiver has the bytes on disk and the
        // sender has the peer's commit ack (which the receiver now sends only after its finalize), so
        // "等待对方写入磁盘…" is no longer true. onTransferComplete sets the final note.
        if (ok) patch.note = "";
        this.store.updateTransfer(id, patch);
      },
      onSentAll: () => {
        // Sender-side completion: everything has been handed to the channel. The receiver reports its own state
        // on its own timeline, so the sender does not wait for the peer's disk here.
        this.manager.phase(tid, "completed");
        this.manager.local(tid, "sent");
        const mode = this.manager.tasks.get(tid)?.files[0]?.diagnosticMode ?? "full";
        this.setTaskNote(tid, `${MODE_LABELS[mode]} · 已发送完成`);
      },
      onTransferComplete: () => {
        this.manager.phase(tid, "completed");
        const direction = this.manager.tasks.get(tid)?.direction ?? "recv";
        if (direction === "recv") this.manager.local(tid, "saved");
        else this.manager.remote(tid, "saved");
        this.recordTelemetry({ event: "task_completed", taskId: tid, direction, status: "completed" });
        const mode = this.manager.tasks.get(tid)?.files[0]?.diagnosticMode ?? "full";
        // "Receiver saved" is from the sender's perspective; the receiver views itself as local, so it says "saved locally".
        const saved = direction === "recv" ? "已保存到本地" : "接收端已保存";
        this.setTaskNote(tid, `${MODE_LABELS[mode]} · ${usesDisk(mode) ? saved : "测试完成，未保存文件"}`);
      },
      onRemoteError: (r) => {
        const direction = this.manager.tasks.get(tid)?.direction ?? "recv";
        if (direction === "send") {
          const remoteState = (r === "USER_CANCEL" || r === "CANCELLED_OR_DISCONNECTED") ? "cancelled" : "failed";
          this.manager.remote(tid, remoteState, r);
          for (const f of this.store.get().transfers.filter(x => x.id.startsWith(`${tid}:`))) this.store.updateTransfer(f.id, { remoteResult: remoteState, remoteError: r, note: remoteState === "cancelled" ? "接收端已取消" : `接收端失败：${this.reasonText(r)}` }, false);
          this.setTaskNote(tid, remoteState === "cancelled" ? "已发送完成 · 接收端已取消" : `已发送完成 · 接收端失败：${this.reasonText(r)}`);
        }
      },
      onError: (r) => {
        const task = this.manager.tasks.get(tid);
        const cancelled = r === "USER_CANCEL" || r === "CANCELLED_OR_DISCONNECTED";
        // Transport teardown after local completion cannot undo the sender's result.
        // Only an explicit peer message establishes remote failure; silence is unknown.
        if (task?.direction === "send" && task.localResult === "sent") {
          const detail = task.remoteError
            ? `接收端${task.remoteResult === "cancelled" ? "已取消" : "失败"}：${this.reasonText(task.remoteError)}`
            : `接收端结果未确认：${this.reasonText(r)}`;
          this.setTaskNote(tid, `已发送完成 · ${detail}`);
          return;
        }
        this.manager.local(tid, cancelled ? "cancelled" : "failed", r);
        this.manager.phase(tid, cancelled ? "cancelled" : "failed", r);
        this.recordTelemetry({ event: cancelled ? "task_cancelled" : "task_failed", taskId: tid, direction: task?.direction, status: cancelled ? "cancelled" : "failed", errorCode: this.telemetryError(r) });
        this.markTransferError(tid, r);
      },
    };
  }

  private async ensureSessionInit(id: string, roleOverride?: "leader" | "follower"): Promise<Session> {
    const starting = this.sessionStarts.get(id);
    if (starting) return starting;
    const promise = this.createSession(id, roleOverride);
    this.sessionStarts.set(id, promise);
    try {
      return await promise;
    } finally {
      this.sessionStarts.delete(id);
    }
  }
  private async createSession(id: string, roleOverride?: "leader" | "follower"): Promise<Session> {
    const ex = this.sessions.get(id);
    if (ex && !ex.dead && ex.connectionState !== "failed" && ex.connectionState !== "closed") return ex;
    if (ex) {
      ex.close();
      this.sessions.delete(id);
    }
    if (this.sessions.size >= 8) throw new Error("连接数已达上限");
    const deadline = Date.now() + 30000;
    while ([...this.sessions.values()].filter((s) => !s.dead && s.connectionState !== "connected").length >= 2) {
      if (Date.now() > deadline) throw new Error("等待建连资源超时");
      await delay(50, new AbortController().signal);
    }
    await this.sig.connectPeer(id);
    const again = this.sessions.get(id);
    if (again && !again.dead) return again;
    const role = roleOverride ?? (this.selfId > id ? "leader" : "follower");
    const s = new Session(id, this.sig, this.RTC_CONFIG, role, this.makeCallbacks.bind(this), (st) => {
      if (this.sessions.get(id) === s) this.onState(id, st);
    }, this.scheduler, this.iceTrickle);
    s.authorization = (tid) => this.manager.authorization(id, tid);
    this.sessions.set(id, s);
    return s;
  }

  private async startSend(id: string, items: PendingItem[]): Promise<void> {
    if (this.sourceKind === "memory" && usesDisk(this.testMode)) throw new Error("内存数据源只用于 A/B 不保存模式，请切换模式");
    const readers: FileReader[] =
      this.sourceKind === "memory"
        ? items.map((i) => new MemoryFileReader(`测试数据-${i.size}字节.bin`, i.size))
        : await this.buildReaders(items);
    if (!readers.length) return;
    const tid = genId();
    const mode = this.testMode;
    const peer = this.store.get().peers.find((p) => p.id === id);
    const peerMax = peer?.capabilities?.wireProtocol === "transfer-v2" ? peer.capabilities.maxFrameSize : 65536;
    const negotiatedFrame = [65536, 32768, 16384].find((size) => size <= Math.min(this.frameBytes, peerMax)) ?? 16384;
    readers.forEach((r) => {
      r.diagnosticMode = mode;
      r.frameBytes = negotiatedFrame;
    });
    const files = readers.map((i) => ({ name: i.name, size: i.size, diagnosticMode: mode }));
    const task = this.manager.create(tid, id, "send", files);
    this.recordTelemetry({ event: "task_created", taskId: tid, direction: "send", status: "queued", bytes: files.reduce((n, f) => n + f.size, 0) });
    const accepted = this.manager.waitAccept(tid);
    void accepted.catch(() => {});
    let acceptedOk = false;
    readers.forEach((it, i) => {
      const tId = `${tid}:${i}`;
      if (!this.store.get().transfers.find((t) => t.id === tId))
        this.store.set({
          transfers: [
            ...this.store.get().transfers,
            { id: tId, peerId: id, name: it.name, size: it.size, sent: 0, status: "pending", direction: "send" },
          ],
        });
    });
    try {
      await this.sig.sendInvite(id, files, tid);
      this.recordTelemetry({ event: "invite_sent", taskId: tid, direction: "send", status: "waiting_accept" });
      this.setTaskNote(tid, `已发送接收请求，等待 ${this.targetName(id)} 确认…`);
      await accepted;
      acceptedOk = true;
      this.setTaskNote(tid, "");
      const crossEngine = this.store.get().peers.find((p) => p.id === id)?.engine === "windows-native-v1";
      let s: Session;
      if (crossEngine) {
        const scoped = new Proxy(this.sig, {
          get(target, property) {
            if (property === "sendSignal") return (peer: string, data: SignalPayload) => target.sendSignal(peer, { ...data, transferId: tid });
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        s = new Session(id, scoped, this.RTC_CONFIG, "leader", this.makeCallbacks.bind(this), () => {}, this.scheduler, this.iceTrickle);
        this.nativeSendSessions.set(tid, s);
      } else s = await this.ensureSessionInit(id);
      await this.withTimeout(s.whenConnected(), 30000, "连接建立超时");
      this.recordTelemetry({ event: "transfer_started", taskId: tid, direction: "send", status: "active" });
      await s.startTransfer(readers, tid, task.aborter.signal);

    } catch (e) {
      if (task.localResult === "sent") return; // Channel already recorded an unconfirmed or failed remote result.
      this.manager.reject(id, tid, String(e));
      // Gave up before the peer accepted (await-accept timeout / invite send failed): the peer's invite card won't disappear on its own,
      // so we must notify explicitly (reusing the same cancel signal as a user-initiated cancel), otherwise it stays "awaiting accept" and "receive" does nothing.
      // After acceptance, don't re-send on failure: the peer then has its own transfer callbacks and watchdog, and a duplicate cancel would only interrupt recovery.
      if (!acceptedOk)
        void this.sig.sendSignal(id, { kind: "cancel", transferId: tid, reason: this.reasonText(e) }).catch(() => {});
      this.recordTelemetry({ event: "task_failed", taskId: tid, direction: "send", status: "failed", errorCode: this.telemetryError(e) });
      this.markTransferError(tid, `发送失败：${this.reasonText(e)}`);
    } finally {
      this.nativeSendSessions.get(tid)?.close();
      this.nativeSendSessions.delete(tid);
    }
  }

  private handleSignal(session: string, data: SignalPayload): void {
    if (data.transferId && this.manager.tasks.get(data.transferId)?.peerId !== session) return;
    if (data.transferId && (data.sdp || data.candidate)) {
      const nativeSession = this.nativeSendSessions.get(data.transferId);
      if (nativeSession) {
        void nativeSession.handleSignal(data).catch((e) => {
          nativeSession.close();
          this.store.set({ statusText: this.reasonText(e) });
        });
        return;
      }
    }
    if ((data.kind === "pause" || data.kind === "resume") && data.transferId) {
      if (data.kind === "pause") {
        this.pausedTransfers.add(data.transferId);
        this.scheduler.pause(data.transferId);
      } else {
        this.pausedTransfers.delete(data.transferId);
        this.scheduler.resume(data.transferId);
      }
      this.scheduleRender();
      return;
    }
    if (data.kind === "cancel" && data.transferId) {
      const cancelReason = data.reason ?? "对端已取消";
      const cancelledTask = this.manager.tasks.get(data.transferId);
      if (cancelledTask) {
        this.manager.remote(data.transferId, "cancelled", cancelReason);
        if (cancelledTask.direction === "recv" && cancelledTask.localResult !== "saved") this.manager.local(data.transferId, "cancelled", cancelReason);
        this.manager.phase(data.transferId, "cancelled", cancelReason);
      }
      this.manager.reject(session, data.transferId, cancelReason);
      this.setTaskNote(data.transferId, "");
      this.pausedTransfers.delete(data.transferId);
      this.scheduler.resume(data.transferId);
      const i = this.invites.findIndex((x) => x.session === session && x.transferId === data.transferId);
      if (i >= 0) {
        this.recordInviteEnd(session, this.invites[i], "expired", "对端已取消（等待接收超时）");
        this.invites.splice(i, 1);
      }
      this.sessions.get(session)?.cancel(data.transferId);
      this.nativeSendSessions.get(data.transferId)?.close();
      this.scheduleRender();
      return;
    }
    let s = this.sessions.get(session);
    if (!s) {
      const role = this.selfId > session ? "leader" : "follower";
      if (this.sessions.size >= 8 || [...this.sessions.values()].filter((s) => !s.dead && s.connectionState !== "connected").length >= 2) return;
      s = new Session(session, this.sig, this.RTC_CONFIG, role, this.makeCallbacks.bind(this), (st) => {
        if (this.sessions.get(session) === s) this.onState(session, st);
      }, this.scheduler, this.iceTrickle);
      s.authorization = (tid) => this.manager.authorization(session, tid);
      this.sessions.set(session, s);
    }
    void s.handleSignal(data).catch((e) => {
      s?.close();
      this.store.set({ statusText: this.reasonText(e) });
    });
  }
}

