import { CHUNK_SIZE, ControlMsg, FileMeta, InviteFile, MAX_CONTROL, RECEIVE_WINDOW, DEFAULT_RECEIVE_WINDOW, PROTOCOL_VERSION, decodeChunk, encodeChunk, genId, hex, parseControl, rootSeed, rootStep, validateFiles } from './protocol';
import { TransferScheduler } from '../transfer/scheduler';
import { unthrottledTick } from '../transfer/throttle';
import { validWindow } from './protocol';
import { DiagnosticResult, TestMode, TransportSample, usesDisk, usesHash } from '../transfer/diagnostics';

// credit 流水线：step 必须显著小于 window。
// 旧实现取 min(8MiB, windowBytes)，而窗口档位最大就是 8MiB，导致 step 恒等于 window ——
// 接收端要收满整个窗口才发第一个 credit，而那一刻发送端额度刚好耗尽，
// 于是每个窗口都要干等一个完整往返。局域网实测（3.98GB）creditWaitMs 占传输时长约 50%，吞吐被砍半。
// 改为窗口的 1/4：credit 在窗口耗尽之前陆续到达，发送端额度持续补充，稳态不停顿。
// 文件末块强制发送，保证最终 grant 一定到达对端。
const CREDIT_WINDOW_DIVISOR = 4; // credit 步长 = windowBytes / 4（下限 CHUNK_SIZE）

// Receiver-side decoupling: a finished block is sealed (and credited) immediately, then handed to a
// bounded disk pipeline (hash + writeAt) instead of being awaited inline. Without this every disk stall
// drains the receive window. The pipeline is capped: past the high mark we stop advertising credit until
// the backlog drains to the low mark, so the network can never run away from the disk without bound.
const PENDING_WRITE_HIGH = 16 * 1024 * 1024; // disk backlog limit, independent of network window
const PENDING_WRITE_LOW = 8 * 1024 * 1024;
const BLOCK_POOL_MAX = 8;                      // cached 256 KiB block buffers
const PROGRESS_THROTTLE_MS = 100;             // UI progress callback rate cap (~10 Hz)

// Stage-level liveness budgets. The global timeout (constructor) only trips when *nothing at all* moves, and it
// is refreshed by our own sends too — so a peer that stops answering while we sit in a wait still looks alive and
// we would hang for the whole global budget (10 min). Every explicit wait therefore arms its own inbound-silence
// budget, sized to the slowest legitimate thing the peer can be doing at that point.
const MANIFEST_STALL_MS = 120_000;  // peer already accepted; `ready` is only blocked behind its writer setup
const CREDIT_STALL_MS = 60_000;     // receiver grants on every sealed block; silence means its pipeline is stuck
const COMMIT_STALL_MS = 600_000;    // last file: the receiver finalizes (close/swap, ~2 min for GB files) first
const RESULT_STALL_MS = 900_000;    // sender is already done here; the ack only trails the peer's last flush, so
                                    // this is a crash backstop (a real peer failure arrives as error/close)
const DISK_STALL_MS = 30_000;       // receiver-local: the write backlog is not draining at all
const DEFAULT_TIMEOUT_MS = 120_000; // absolute backstop; active stages refresh activity, while a dead path fails within 2 minutes

// A finished 256 KiB block handed to the decoupled disk pipeline; it owns its buffer until processed.
type SealedBlock = { offset: number; length: number; buf: Uint8Array };

// Best-effort free-space probe for the P5 overlap guard. Returns undefined when unavailable (node / insecure
// context) so callers keep the overlap behavior unchanged rather than stalling on a missing measurement.
async function estimateAvailableStorageBytes(): Promise<number | undefined> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
      const e = await navigator.storage.estimate();
      if (typeof e.quota === 'number' && typeof e.usage === 'number' && e.quota > 0) return e.quota - e.usage;
    }
  } catch {}
  return undefined;
}

export class IntervalSet {
  private intervals: [number, number][] = [];
  add(start: number, end: number) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error('INVALID_RANGE');
    if (start === end) return;
    const sorted = [...this.intervals, [start, end] as [number, number]].sort((a,b) => a[0]-b[0]);
    const merged: [number, number][] = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
    }
    this.intervals = merged;
  }
  has(s: number, e: number) { return s === e || this.intervals.some(([a,b]) => a <= s && b >= e); }
  covers(s: number, e: number) { return this.has(s,e); }
  contiguousTo() { return this.intervals[0]?.[0] === 0 ? this.intervals[0][1] : 0; }
  gaps(total: number) { const out: [number,number][] = []; let pos = 0; for (const [s,e] of this.intervals) { if (s>pos) out.push([pos,s]); pos=e; } if (pos<total) out.push([pos,total]); return out; }
}
export interface FileReader { name: string; size: number; mime: string; diagnosticMode?: TestMode; frameBytes?: number; sourceKind?: 'file'|'memory'; readAt(offset: number, length: number): Promise<Uint8Array>; close?(): Promise<void>; }
export interface FileWriter { prepare(meta: FileMeta): Promise<void>; writeAt(offset: number, data: Uint8Array): Promise<void>; finalize(meta: FileMeta): Promise<void>; abort(): Promise<void>; }
export interface ChannelCallbacks {
  receiveWindowBytes?: number;
  getTransportStats?: () => Promise<Partial<TransportSample>>;
  writerFactory: (meta: FileMeta) => Promise<FileWriter>;
  onManifest?: (files: FileMeta[]) => void;
  onProgress?: (fileIndex: number, received: number, total: number) => void;
  onFileFinalizing?: (fileIndex: number, total: number) => void;
  onFileComplete?: (fileIndex: number, ok: boolean, hash: string) => void;
  // Sender-only: every byte has been handed to the data channel. Fired before the peer's commit ack, so the
  // sender's own state never waits on the receiver's disk.
  onSentAll?: () => void;
  onTransferComplete?: () => void; onError?: (reason: string) => void; onRemoteError?: (reason: string) => void;
  onQueued?: () => void;
  onDiagnostics?: (result: DiagnosticResult) => void;
}
export interface ChannelOptions {
  peerId: string; sender: boolean; scheduler: TransferScheduler; expectedFiles: InviteFile[];
  maxMessageSize: number; writable: () => boolean; signal?: AbortSignal; timeoutMs?: number;
  admitted?: boolean;
  getTransportStats?: () => Promise<Partial<TransportSample>>;
  receiveWindowBytes?: number;
}

/** V2: one sequential file pipeline per task. Credits are payload bytes, not durable ACKs. */
export class Channel {
  readonly done: Promise<void>;
  private resolveDone!: () => void; private rejectDone!: (e: Error) => void;
  private aborter = new AbortController(); private attempt = '';
  private queue = Promise.resolve(); private queuedBytes = 0; private queuedControls = 0;
  private release?: () => void; private finished = false; private terminal = false;
  private files: FileMeta[] = []; private index = 0; private offset = 0;
  private writer?: FileWriter; private block: Uint8Array = new Uint8Array(); private blockLength = 0;
  // Decoupled disk pipeline: sealed blocks wait here (bounded by pendingHigh()) instead of blocking reception.
  private diskQueue: Promise<void> = Promise.resolve(); private pendingWriteBytes = 0;
  private pendingFinalizes: Promise<void>[] = []; private finalizeErrors: string[] = [];
  private pool: Uint8Array[] = [];
  private root: Uint8Array = new Uint8Array();
  private granted = 0; private received = 0; private sent = 0; private ready = false;
  private lastCreditSent = 0; // C2: 上次实际发出的 grant，用于累计阈值判断
  private committed = new Map<number, string>(); private expectedHashes = new Map<number, string>();
  private lastProgressAt = 0; private lastProgressIndex = -1;
  private timer: ReturnType<typeof setInterval>; private lastActivity = Date.now();
  // Inbound-only liveness: refreshed exclusively by receive(), so it goes stale while we are the one sending.
  private lastInbound = Date.now();
  private stallBudgetMs = 0; private stallReason = 'PEER_STALL';
  // Receiver-local disk watchdog: last moment the write backlog actually shrank.
  private diskProgressAt = Date.now();
  private externalAbort = () => this.fail(String(this.options.signal?.reason ?? 'USER_CANCEL'));
  private mode: TestMode = 'full';
  private windowBytes = DEFAULT_RECEIVE_WINDOW;
  private creditWaiter?: { needed: number; wake: (at: number) => void };
  private windowProbe?: ReturnType<typeof setInterval>;
  private pendingRead?: Promise<Uint8Array>;
  private waitForCredit(bytes: number): Promise<number> {
    const signal = this.aborter.signal;
    if (signal.aborted) return Promise.reject(signal.reason);
    const needed = this.sent + bytes;
    if (needed <= this.granted) return Promise.resolve(0);
    this.metrics.creditStalls++;
    this.armStall(CREDIT_STALL_MS, 'CREDIT_STALL');
    return new Promise((resolve, reject) => {
      const cancel = () => { this.disarmStall(); this.creditWaiter=undefined; signal.removeEventListener('abort',cancel); reject(signal.reason); };
      this.creditWaiter = { needed, wake: at => { this.disarmStall(); this.creditWaiter=undefined; signal.removeEventListener('abort',cancel); resolve(at); } };
      signal.addEventListener('abort',cancel,{once:true});
    });
  }
  private started = 0;
  private lastReceive = 0;
  // A full SCTP send buffer surfaces from Chromium as OperationError("... unknown transient reason (e.g. out of
  // memory)"). Bound local queuing and retry only the bytes that were not accepted, instead of killing the task.
  static readonly SEND_BUFFER_HIGH = 1024 * 1024;
  static readonly SEND_RETRY_MAX = 3;
  private sendFailure?: { phase: string; bytes: number; buffered: number; readyState: string; name: string; message: string; frameBytes: number; maxMessageSize: number; stack: string };
  private sampling = false;
  private async sampleTransport() {
    if(this.sampling || !this.started || this.terminal) return;
    this.sampling=true;
    const sample: TransportSample={elapsedMs:performance.now()-this.started,bufferedBytes:this.dc.bufferedAmount,payloadBytes:this.options.sender?this.sent:this.received};
    try { Object.assign(sample,await this.options.getTransportStats?.()); } catch { this.metrics.statsErrors++; }
    finally { this.sampling=false; }
    // Bounded last 600 seconds; connection counters include other tasks on this PC.
    this.metrics.transportSamples.push(sample);
    if(this.metrics.transportSamples.length>600) this.metrics.transportSamples.shift();
  }
  private metrics: DiagnosticResult;
  private reportTimer: ReturnType<typeof setInterval>;
  private report(status = 'running') {
    this.metrics.mode = this.mode;
    this.metrics.status = status;
    this.metrics.elapsedMs = this.started ? performance.now() - this.started : 0;
    this.metrics.payloadBytes = this.options.sender ? this.sent : this.received;
    this.metrics.averageMiBs = this.metrics.elapsedMs ? this.metrics.payloadBytes / 1048576 / (this.metrics.elapsedMs / 1000) : 0;
    this.metrics.bufferedPeakBytes = Math.max(this.metrics.bufferedPeakBytes, this.dc.bufferedAmount);
    this.cb.onDiagnostics?.({ ...this.metrics });
  }
  private startMetrics() { this.started = performance.now(); this.metrics.startedAt = new Date().toISOString(); }
  private async measure<T>(key: 'readMs'|'hashMs'|'writeMs'|'finalizeMs'|'creditWaitMs'|'schedulerWaitMs', work: () => Promise<T>): Promise<T> {
    const start = performance.now(); try { return await work(); } finally { this.metrics[key] += performance.now() - start; }
  }

  constructor(private dc: RTCDataChannel, private cb: ChannelCallbacks, private tid: string, private options: ChannelOptions) {
    this.metrics = { transferId: tid, direction: options.sender ? 'send' : 'recv', mode: 'full', status: 'queued', startedAt: '', elapsedMs: 0, payloadBytes: 0, totalBytes: 0, averageMiBs: 0, readMs: 0, hashMs: 0, writeMs: 0, finalizeMs: 0, creditWaitMs: 0, schedulerWaitMs: 0, queuePeakBytes: 0, bufferedPeakBytes: 0, rateLimitBytesPerSecond: options.scheduler.limits.rate, hiddenSamples: 0, receiveWindowBytes: RECEIVE_WINDOW, creditStalls: 0, creditWakeups: 0, creditResumeMs: 0, creditResumeMaxMs: 0, creditToSendMs: 0, creditToSendMaxMs: 0, prefetchBlocks: 1, frameBytes:65536, sourceKind:'file',receivedFrames:0,receiveGapMs:0,receiveGapMaxMs:0,receiveProcessingMs:0,receiveProcessingMaxMs:0,creditSendMs:0,creditSendCount:0,pendingWritePeakBytes:0,transportSamples:[],statsErrors:0 };
    Object.assign(this.metrics, { frameBytes:65536, sourceKind:'file',receivedFrames:0,receiveGapMs:0,receiveGapMaxMs:0,receiveProcessingMs:0,receiveProcessingMaxMs:0,creditSendMs:0,creditSendCount:0,transportSamples:[],statsErrors:0 });
    this.reportTimer = setInterval(() => { if (typeof document !== 'undefined' && document.hidden) this.metrics.hiddenSamples++; void this.sampleTransport(); this.report(); }, 1000);
    this.done = new Promise((resolve, reject) => { this.resolveDone=resolve; this.rejectDone=reject; });
    void this.done.catch(() => {});
    dc.binaryType = 'arraybuffer';
    dc.onmessage = e => this.receive(e.data);
    dc.onclose = () => { if (!this.terminal) this.fail('CONN_DROPPED'); };
    dc.onerror = () => this.fail('CHANNEL_ERROR');
    options.signal?.addEventListener('abort', this.externalAbort, { once:true });
    this.timer = setInterval(() => {
      if (this.terminal) return;
      // A hidden page (phone backgrounded / tab suspended) gets no scheduling at all, so its pipeline is frozen
      // while its clocks are not. Running the watchdogs against that frozen view would kill a healthy transfer
      // the moment the user comes back — and mobile receivers are routinely backgrounded mid-transfer.
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      // Receiver: the disk pipeline stalled outright (not merely slow — a slow disk still shrinks the backlog).
      // Without this the task hangs silently: credit is withheld, the sender parks in waitForCredit, and neither
      // end reports anything until the global timeout.
      if (this.pendingWriteBytes > 0 && now - this.diskProgressAt > DISK_STALL_MS) { this.fail('DISK_STALL'); return; }
      // A pause is user-initiated idleness, not a stall: never let a budget kill a paused transfer.
      if (this.options.scheduler.isPaused(this.tid)) return;
      if (this.stallBudgetMs && now - this.lastInbound > this.stallBudgetMs) { this.fail(this.stallReason); return; }
      // While a stage budget is armed it is the sole authority for that wait. Applying the absolute backstop in
      // parallel would preempt COMMIT/RESULT (600 s/900 s) at 120 s, making those budgets unreachable and
      // mislabelling a slow peer finalize as TRANSFER_TIMEOUT instead of COMMIT_STALL.
      if (!this.stallBudgetMs && now - this.lastActivity > (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)) this.fail('TRANSFER_TIMEOUT');
    }, 1000);
    // The receiver has no sender-side manifest wait to arm this budget. Start
    // it as soon as the DataChannel exists so a relay path that opens but never
    // delivers the first control frame fails as MANIFEST_STALL instead of
    // falling through to the longer global timeout.
    if (!options.sender) this.armStall(MANIFEST_STALL_MS, 'MANIFEST_STALL');
    if (options.signal?.aborted) this.externalAbort();
  }
  private touch() { this.lastActivity=Date.now(); }
  /** Keep the transport watchdog alive while local disk work is still making progress.
   * This is not a network acknowledgement: DISK_STALL continues to detect a
   * write queue that stops draining, while long OPFS close/finalize operations
   * no longer look like a dead peer to the global transfer timeout.
   */
  private async keepAlive<T>(work: Promise<T>): Promise<T> {
    const timer = setInterval(() => this.touch(), 10_000);
    try { return await work; }
    finally { clearInterval(timer); this.touch(); }
  }
  /** Arm an inbound-silence budget for the wait we are about to enter; 0 disarms it. */
  private armStall(budgetMs: number, reason = 'PEER_STALL'): void { this.lastInbound = Date.now(); this.stallBudgetMs = budgetMs; this.stallReason = reason; }
  private disarmStall(): void { this.stallBudgetMs = 0; }
  private async wait(test: () => boolean) {
    while (!test()) { await new Promise<void>(resolve => unthrottledTick(resolve)); this.aborter.signal.throwIfAborted(); }
  }
  private async waitForSendBuffer(): Promise<void> {
    await this.wait(() => this.dc.readyState !== 'open' || this.dc.bufferedAmount <= Channel.SEND_BUFFER_HIGH);
  }
  private async waitForSendDrain(): Promise<void> {
    const deadline = performance.now() + 1000;
    await this.wait(() => this.dc.readyState !== 'open' || this.dc.bufferedAmount <= Channel.SEND_BUFFER_HIGH / 4 || performance.now() >= deadline);
  }
  private recordSendError(phase: string, bytes: number, e: unknown): void {
    const err = e as { name?: string; message?: string } | null;
    const detail = { phase, bytes, buffered: this.dc.bufferedAmount, readyState: this.dc.readyState, name: err?.name ?? 'Error', message: err?.message ?? String(e), frameBytes: this.metrics.frameBytes, maxMessageSize: this.options.maxMessageSize, stack: String((e as { stack?: string } | null)?.stack ?? '').split('\n').slice(0, 3).join(' | ') };
    this.sendFailure = detail; this.metrics.lastSendError = detail;
    console.error('[p2p] send failed', detail);
  }
  private async sendRaw(data: string | ArrayBuffer, phase: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { this.dc.send(data as string); return; }
      catch (e) {
        this.recordSendError(phase, typeof data === 'string' ? data.length : data.byteLength, e);
        if (this.dc.readyState !== 'open' || attempt >= Channel.SEND_RETRY_MAX) throw e;
        this.sendFailure = undefined; await this.waitForSendDrain();
      }
    }
  }
  private async control(msg: Record<string, unknown>) {
    await this.wait(() => this.dc.readyState === 'open' && this.dc.bufferedAmount < this.options.scheduler.limits.highWater);
    const raw = JSON.stringify({ ...msg, version:PROTOCOL_VERSION, transferId:this.tid, attemptId:this.attempt });
    if (raw.length > MAX_CONTROL) throw new Error('CONTROL_TOO_LARGE');
    await this.sendRaw(raw, 'control:' + String(msg.type)); this.touch();
  }
  private receive(data: unknown) {
    if (this.terminal) return;
    try {
      if (typeof data === 'string') {
        if (++this.queuedControls > 64) throw new Error('CONTROL_FLOOD');
        const msg = parseControl(data);
        if (msg.transferId !== this.tid) throw new Error('TRANSFER_MISMATCH');
        if (!this.attempt && !this.options.sender && msg.type === 'manifest') this.attempt=msg.attemptId;
        if (!this.attempt || msg.attemptId !== this.attempt) throw new Error('ATTEMPT_MISMATCH');
        if (msg.type === 'cancel' || msg.type === 'error') { this.cb.onRemoteError?.(msg.reason); this.fail(msg.reason, false); return; }
        const arrival = performance.now();
        this.queue = this.queue.then(async () => { this.aborter.signal.throwIfAborted(); await this.onControl(msg, arrival); }).finally(() => { this.queuedControls--; });
      } else {
        if (this.options.sender || !(data instanceof ArrayBuffer)) throw new Error('UNEXPECTED_DATA');
        const frame=decodeChunk(data);
        const now=performance.now();
        if(this.lastReceive) { const gap=now-this.lastReceive;this.metrics.receiveGapMs+=gap;this.metrics.receiveGapMaxMs=Math.max(this.metrics.receiveGapMaxMs,gap); }
        this.lastReceive=now;this.metrics.receivedFrames++;
        if (!this.ready || this.received + frame.payload.length > this.granted) throw new Error('CREDIT_EXCEEDED');
        this.received += frame.payload.length; this.queuedBytes += data.byteLength;
        this.metrics.queuePeakBytes = Math.max(this.metrics.queuePeakBytes, this.queuedBytes);
        if (this.queuedBytes > this.windowBytes + 65536) throw new Error('RECEIVE_QUEUE_FULL');
        this.queue=this.queue.then(async () => {
          this.aborter.signal.throwIfAborted();const start=performance.now();
          try { await this.onData(frame); } finally { const elapsed=performance.now()-start;this.metrics.receiveProcessingMs+=elapsed;this.metrics.receiveProcessingMaxMs=Math.max(this.metrics.receiveProcessingMaxMs,elapsed); }
        }).finally(() => { this.queuedBytes-=data.byteLength; });
      }
      this.touch();
      this.lastInbound = Date.now();
      this.queue=this.queue.catch(e => this.fail(String(e)));
    } catch(e) { this.fail(String(e)); }
  }
  async sendFiles(readers: FileReader[]) {
    try {
      this.mode = readers[0]?.diagnosticMode ?? 'full';
      this.metrics.frameBytes=readers[0]?.frameBytes??65536;
      this.metrics.sourceKind=readers[0]?.sourceKind??'file';
      if(![16384,32768,65536].includes(this.metrics.frameBytes)) throw new Error('INVALID_FRAME_SIZE');
      if(this.metrics.sourceKind==='memory' && usesDisk(this.mode)) throw new Error('MEMORY_SOURCE_REQUIRES_DISCARD_MODE');
      validateFiles(readers.map(r => ({name:r.name,size:r.size})));
      this.cb.onQueued?.();
      if (!this.options.admitted) this.release=await this.options.scheduler.acquire(this.options.peerId,'send',this.aborter.signal);
      await this.wait(() => this.dc.readyState === 'open');
      this.attempt=genId();
      this.files=readers.map((r,i) => ({fileIndex:i,fileId:`${this.tid}:${i}`,name:r.name,size:r.size,mime:r.mime,blocks:Math.ceil(r.size/CHUNK_SIZE),diagnosticMode:this.mode}));
      this.metrics.totalBytes = readers.reduce((n,r) => n+r.size,0);
      await this.control({type:'manifest',files:this.files,blockSize:CHUNK_SIZE,frameBytes:this.metrics.frameBytes,sourceKind:this.metrics.sourceKind});
      this.armStall(MANIFEST_STALL_MS, 'MANIFEST_STALL');
      await this.wait(() => this.ready);
      this.disarmStall();
      this.startMetrics();
      const max=Math.min(this.metrics.frameBytes, this.options.maxMessageSize || 65536)-12;
      if (max < 1) throw new Error('MESSAGE_LIMIT_TOO_SMALL');
      for (let i=0;i<readers.length;i++) {
        const r=readers[i]; let root=usesHash(this.mode) ? await this.measure('hashMs', () => rootSeed(r.size)) : new Uint8Array(32);
        const prefetch = (offset: number) => {
          this.aborter.signal.throwIfAborted();
          this.pendingRead=this.measure('readMs', () => r.readAt(offset,Math.min(CHUNK_SIZE,r.size-offset)));
          void this.pendingRead.catch(()=>{}); // Observed even when cancellation ends the current block.
        };
        if(r.size) prefetch(0);
        for (let offset=0;offset<r.size;) {
          this.aborter.signal.throwIfAborted();
          const block=await this.pendingRead!;
          this.pendingRead=undefined;
          this.aborter.signal.throwIfAborted();
          if (block.length!==Math.min(CHUNK_SIZE,r.size-offset)) throw new Error('SOURCE_CHANGED_OR_SHORT_READ');
          if(offset+block.length<r.size) prefetch(offset+block.length);
          if (usesHash(this.mode)) root=await this.measure('hashMs', () => rootStep(root,block));
          const arrived=await this.measure('creditWaitMs', () => this.waitForCredit(block.length));
          if(arrived) {
            const latency=performance.now()-arrived;
            this.metrics.creditWakeups++; this.metrics.creditResumeMs+=latency;
            this.metrics.creditResumeMaxMs=Math.max(this.metrics.creditResumeMaxMs,latency);
          }
          const wireBytes=block.length+Math.ceil(block.length/max)*12;
          await this.waitForSendBuffer();
          {
            let at = 0; let retries = 0;
            const flush = () => {
              if(arrived) {
                const latency=performance.now()-arrived;
                this.metrics.creditToSendMs+=latency;
                this.metrics.creditToSendMaxMs=Math.max(this.metrics.creditToSendMaxMs,latency);
              }
              for (; at < block.length; at += max) {
                const part=block.subarray(at,Math.min(block.length,at+max));
                try { this.dc.send(encodeChunk(i,offset+at,part)); }
                catch (e) { this.recordSendError(`data:${i}:${offset+at}`, part.length, e); throw e; }
                this.sent+=part.length;
                this.cb.onProgress?.(i, offset+at+part.length, r.size);
              }
              this.touch();
            };
            for (;;) {
              try {
                await this.measure('schedulerWaitMs', () => this.options.scheduler.send(this.options.peerId,this.tid,wireBytes,this.options.writable,flush,this.aborter.signal));
                break;
              } catch (e) {
                if (!this.sendFailure || this.dc.readyState !== 'open' || retries >= Channel.SEND_RETRY_MAX) throw e;
                retries++; this.sendFailure = undefined; await this.waitForSendDrain();
              }
            }
          }
          offset+=block.length;
        }
        const hash=hex(root); this.expectedHashes.set(i,hash);
        await this.control({type:'file-finish',fileIndex:i,hash,size:r.size,blocks:this.files[i].blocks});
        // Sender: every byte of this file has been handed to the data channel, so it is complete *from this end*.
        // The receiver owns its own write/commit state and must not gate the sender's status.
        this.cb.onFileComplete?.(i,true,hash);
        // Only wait for the commit ack when another file follows: the receiver prepares writers in order, so it
        // must have settled file i before file i+1 arrives. The last file has no follower — blocking on its ack
        // would only tie the sender's status to the peer's disk flush.
        if (i + 1 < this.files.length) {
          this.armStall(COMMIT_STALL_MS, 'COMMIT_STALL');
          await this.wait(() => this.committed.has(i));
          this.disarmStall();
        }
        await r.close?.();
      }
      await this.control({type:'transfer-result'});
      this.cb.onSentAll?.();
      this.armStall(RESULT_STALL_MS, 'RESULT_STALL');
      await this.done;
    } catch(e) { this.fail(String(e)); throw e; }
    finally { try { await this.pendingRead; } catch {} this.pendingRead=undefined; for(const r of readers) { try { await r.close?.(); } catch {} } this.release?.(); this.release=undefined; }
  }
  private async prepareFile() {
    const meta=this.files[this.index]; if (!meta) return;
    // Take a fresh assembling buffer from the pool: a sealed block owns its buffer until the disk pipeline
    // is done with it, so the previous one must not be reused.
    this.block=this.takeBuffer();
    this.offset=0; this.blockLength=0; this.root=usesHash(this.mode) ? await this.measure('hashMs', () => rootSeed(meta.size)) : new Uint8Array(32);
    this.writer=usesDisk(this.mode) ? await this.cb.writerFactory(meta) : { prepare:async()=>{}, writeAt:async()=>{}, finalize:async()=>{}, abort:async()=>{} };
    await this.writer.prepare(meta);
  }
  private async onData({fileIndex,offset,payload}:{fileIndex:number;offset:number;payload:Uint8Array}) {
    const meta=this.files[this.index];
    if (!meta || fileIndex!==this.index || offset!==this.offset || offset+payload.length>meta.size || this.blockLength+payload.length>CHUNK_SIZE) throw new Error('INVALID_DATA_RANGE');
    this.block.set(payload,this.blockLength); this.blockLength+=payload.length; this.offset+=payload.length;
    // Throttle UI progress to ~10 Hz: a 3 GiB transfer emits ~46k 64 KiB blocks and fanning every one out to
    // the store/UI wastes main-thread time for no visible gain. The last block (offset===size) and a file-index
    // change always flush, so the bar still hits 100% and switches files promptly.
    const isLastProgress = this.offset===meta.size;
    if (isLastProgress || this.index!==this.lastProgressIndex || performance.now()-this.lastProgressAt >= PROGRESS_THROTTLE_MS) {
      this.lastProgressAt=performance.now(); this.lastProgressIndex=this.index;
      this.cb.onProgress?.(this.index,this.offset,meta.size);
    }
    if (this.blockLength===CHUNK_SIZE || this.offset===meta.size) {
      // Seal the finished block and hand it to the decoupled disk pipeline. Credit is released here —
      // not after writeAt — so a disk stall can no longer drain the receive window mid-transfer.
      const sealed: SealedBlock={offset:this.offset-this.blockLength,length:this.blockLength,buf:this.block};
      const isLastBlock = this.offset===meta.size;
      // Don't allocate a fresh buffer after the last block: prepareFile() takes one for the next file.
      // Allocating here would orphan a 256 KiB block (overwritten before use, never returned to the pool).
      if (!isLastBlock) this.block=this.takeBuffer();
      this.blockLength=0;
      this.granted+=sealed.length;
      this.enqueueSealed(sealed);
      // The last block of a file always advertises, even under backpressure: the sender has no further
      // blocks of this file to trigger a flush, so withholding here could leave it waiting forever.
      await this.maybeSendCredit(isLastBlock);
    }
  }
  private takeBuffer(): Uint8Array { return this.pool.pop() ?? new Uint8Array(CHUNK_SIZE); }
  private giveBuffer(buf: Uint8Array): void { if (this.pool.length < BLOCK_POOL_MAX) this.pool.push(buf); }
  private pendingHigh(): number { return PENDING_WRITE_HIGH; }
  private pendingLow(): number { return PENDING_WRITE_LOW; }
  private enqueueSealed(sealed: SealedBlock): void {
    // Start the watchdog clock whenever the backlog goes from empty to non-empty; a slow-but-working disk keeps
    // refreshing it on every processed block, so only a genuinely stalled write can age past DISK_STALL_MS.
    if (this.pendingWriteBytes === 0) this.diskProgressAt = Date.now();
    this.pendingWriteBytes += sealed.length;
    this.metrics.pendingWritePeakBytes = Math.max(this.metrics.pendingWritePeakBytes, this.pendingWriteBytes);
    // The chain never rejects: a failing block reports through fail() so the rest still drains in order.
    this.diskQueue = this.diskQueue.then(async () => {
      if (this.aborter.signal.aborted) { this.pendingWriteBytes-=sealed.length; this.giveBuffer(sealed.buf); return; }
      try { await this.processSealed(sealed); } catch(e) { this.fail(String(e)); }
    });
  }
  private async processSealed(sealed: SealedBlock): Promise<void> {
    try {
      if (!this.aborter.signal.aborted) {
        const bytes=sealed.buf.subarray(0,sealed.length);
        if (usesHash(this.mode)) this.root=await this.measure('hashMs', () => rootStep(this.root,bytes));
        if (usesDisk(this.mode)) await this.measure('writeMs', () => this.writer!.writeAt(sealed.offset,bytes));
        this.aborter.signal.throwIfAborted();
      }
    } finally {
      // writeAt() copies into its own buffer, so the block buffer is free the moment the write resolves.
      this.pendingWriteBytes-=sealed.length; this.giveBuffer(sealed.buf); this.diskProgressAt=Date.now();
    }
    // Backlog drained past the low mark: release whatever credit we withheld while it was over the high mark.
    if (!this.aborter.signal.aborted && this.pendingWriteBytes <= this.pendingLow()) await this.maybeSendCredit(false);
  }
  private async maybeSendCredit(force: boolean): Promise<void> {
    // Optimistic claim: record the grant we are about to advertise BEFORE awaiting the control send.
    // maybeSendCredit is reached from two independent chains (onData + the disk pipeline); without the
    // claim both read the same stale lastCreditSent and send the same grant twice, inflating
    // creditSendCount and letting lastCreditSent regress. Because this.granted only increases, the second
    // caller's guard (granted===lastCreditSent) then fires and returns, so exactly one send happens.
    if (this.granted===this.lastCreditSent) return;
    const step = Math.max(CHUNK_SIZE, Math.floor(this.windowBytes / CREDIT_WINDOW_DIVISOR));
    const due = this.granted-this.lastCreditSent >= step;
    // Backpressure: granted = window + sealed (the initial window credit plus per-seal increments), so
    // in-flight = granted - written ≤ window + pendingWriteBytes. Holding the advertisement back once the
    // backlog exceeds (high - window) keeps in-flight under the high mark WITHOUT stalling the link on a
    // slow disk: the disk drains in the background while the sender keeps flowing up to HIGH bytes ahead.
    if (!force && (!due || this.pendingWriteBytes > this.pendingHigh() - this.windowBytes)) return;
    const toSend = this.granted;
    this.lastCreditSent = toSend;
    const creditStart=performance.now();
    await this.control({type:'credit',grant:toSend});
    this.metrics.creditSendMs+=performance.now()-creditStart;this.metrics.creditSendCount++;
  }
  private async onControl(msg: ControlMsg, arrival = performance.now()) {
    if (this.options.sender) {
      if (msg.type==='ready' || msg.type==='credit') {
        if(msg.type==='ready') {
          const window=msg.windowBytes??DEFAULT_RECEIVE_WINDOW;
          if(!validWindow(window) || (this.ready && window!==this.windowBytes)) throw new Error('INVALID_WINDOW');
          this.windowBytes=window; this.metrics.receiveWindowBytes=window;
        }
        if ((msg.type==='credit' && !this.ready) || msg.grant>this.sent+this.windowBytes) throw new Error('INVALID_CREDIT');
        this.granted=Math.max(this.granted,msg.grant); this.ready=true;
        if(this.creditWaiter && this.creditWaiter.needed<=this.granted) this.creditWaiter.wake(arrival);
      } else if(msg.type==='window') {
        if (!validWindow(msg.windowBytes)) throw new Error('INVALID_WINDOW');
        this.windowBytes = msg.windowBytes; this.metrics.receiveWindowBytes = msg.windowBytes;
        if (this.creditWaiter && this.creditWaiter.needed <= this.granted) this.creditWaiter.wake(arrival);
      } else if(msg.type==='file-committed') {
        if (this.expectedHashes.get(msg.fileIndex)!==msg.hash) throw new Error('INVALID_COMMIT');
        this.committed.set(msg.fileIndex,msg.hash);
      } else if(msg.type==='result-ack') {
        if(this.committed.size!==this.files.length) throw new Error('EARLY_RESULT');
        this.succeed(); this.dc.close();
      } else throw new Error('UNEXPECTED_CONTROL');
      return;
    }
    if(msg.type==='manifest') {
      if(this.files.length) throw new Error('DUPLICATE_MANIFEST');
      const summary = (files: InviteFile[]) => JSON.stringify(files.map(f=>({name:f.name,size:f.size,diagnosticMode:f.diagnosticMode??'full'})));
      if(summary(msg.files)!==summary(this.options.expectedFiles)) throw new Error('UNAUTHORIZED_MANIFEST');
      this.mode = msg.files[0].diagnosticMode ?? 'full';
      this.metrics.frameBytes=msg.frameBytes??65536;this.metrics.sourceKind=msg.sourceKind??'file';
      if(this.metrics.sourceKind==='memory' && usesDisk(this.mode)) throw new Error('MEMORY_SOURCE_REQUIRES_DISCARD_MODE');
      this.metrics.totalBytes = msg.files.reduce((n,f)=>n+f.size,0);
      this.files=msg.files; this.cb.onManifest?.(msg.files); this.cb.onQueued?.();
      const window=await this.adaptiveWindow();
      if(!validWindow(window)) throw new Error('INVALID_WINDOW');
      this.windowBytes=window; this.metrics.receiveWindowBytes=window;
      // Reserve the maximum tier (8 MiB) up front: the window can grow mid-transfer via adaptiveWindow(),
      // and scheduler accounting must always cover it. Cost is only concurrency headroom, not real allocation.
      this.release=await this.options.scheduler.acquire(this.options.peerId,'recv',this.aborter.signal,this.options.scheduler.limits.taskMemory+7*RECEIVE_WINDOW);
      await this.prepareFile();
      this.granted=this.windowBytes; this.ready=true;
      this.startMetrics();
      await this.control({type:'ready',grant:this.granted,windowBytes:this.windowBytes});
      this.disarmStall();
      this.startWindowProbe();
    } else if(msg.type==='file-finish') {
      if(this.committed.has(msg.fileIndex)) {
        if(this.committed.get(msg.fileIndex)!==msg.hash) throw new Error('CONFLICTING_FINISH');
        await this.control({type:'file-committed',fileIndex:msg.fileIndex,hash:msg.hash}); return;
      }
      // The hash chain and disk writes now run in a decoupled pipeline: drain it before verifying integrity,
      // otherwise the trailing blocks are still unhashed/unwritten here.
      await this.keepAlive(this.diskQueue);
      const meta=this.files[this.index];
      if(!meta || msg.fileIndex!==this.index || msg.size!==meta.size || msg.blocks!==meta.blocks || this.offset!==meta.size || this.blockLength!==0 || hex(this.root)!==msg.hash) throw new Error('INTEGRITY_FAILURE');
      this.cb.onFileFinalizing?.(this.index,meta.size);
      const doneIndex = this.index;
      if (usesDisk(this.mode)) {
        // Hand the writer to a background finalize so the next file's transfer overlaps the close (#52).
        // The writer reference is moved into the promise chain, freeing this.writer for prepareFile()'s next file.
        // onFileComplete (UI → done) fires from the finalize's .then so the file row only turns green after
        // the bytes are actually on disk — otherwise a single-file transfer shows "done" while close() is still
        // running, and a failed finalize would strand "done" beside a "transfer failed".
        const fw = this.writer!;
        const p = this.measure('finalizeMs', () => fw.finalize(meta))
          .then(() => { this.cb.onFileComplete?.(doneIndex,true,msg.hash); })
          .catch((e: unknown) => { this.finalizeErrors.push('FINALIZE_FAILED:' + meta.name + ':' + String(e)); });
        this.pendingFinalizes.push(p);
      } else {
        // No disk writer (e.g. discard / 'memory' mode): nothing to finalize, mark done immediately.
        this.cb.onFileComplete?.(doneIndex,true,msg.hash);
      }
      this.writer = undefined;
      this.aborter.signal.throwIfAborted();
      this.committed.set(doneIndex,msg.hash);
      // P5: #52 lets the previous file's close() run in the background while prepareFile() opens the next
      // writable, so two swap files can briefly coexist (peak disk usage up to 2x the largest file). On a
      // nearly-full volume that can flip a success into DISK_FULL, so when free space is tight we drain the
      // pending finalizes first — losing the overlap only in the rare low-space case, never on a healthy disk.
      if (this.pendingFinalizes.length) {
        const nextIndex=this.index+1;
        if (nextIndex<this.files.length) {
          const free=await estimateAvailableStorageBytes();
          if (free!==undefined && free < this.files[nextIndex].size*2) await Promise.allSettled(this.pendingFinalizes);
        }
      }
      this.index++; await this.prepareFile();
      await this.control({type:'file-committed',fileIndex:msg.fileIndex,hash:msg.hash});
    } else if(msg.type==='transfer-result') {
      if(!this.files.length || this.index!==this.files.length) throw new Error('EARLY_RESULT');
      await this.keepAlive(Promise.allSettled(this.pendingFinalizes));
      if (this.finalizeErrors.length) { this.fail(this.finalizeErrors[0]); return; }
      await this.control({type:'result-ack'}); this.succeed();
      this.release?.(); this.release=undefined;
    } else if(msg.type==='window') {
      // Sender-only control; a stray one arriving at the receiver must not abort the transfer.
    } else throw new Error('UNEXPECTED_CONTROL');
  }
  // Pick the receive window from the live transport: relay/TURN or high RTT needs a large window to fill
  // the bandwidth-delay product; LAN (low RTT) keeps the 1 MiB default for memory friendliness.
  // An explicit user override (options/cb.receiveWindowBytes) always wins and disables auto-adapt.
  private async adaptiveWindow(): Promise<number> {
    const explicit = this.options.receiveWindowBytes ?? this.cb.receiveWindowBytes;
    if (explicit !== undefined) return explicit;
    let want = DEFAULT_RECEIVE_WINDOW;
    if (this.options.getTransportStats) {
      try {
        const s = await this.options.getTransportStats();
        const relay = s.local?.candidateType === 'relay' || s.remote?.candidateType === 'relay';
        if (relay) want = 8 * RECEIVE_WINDOW;
        else if (typeof s.rttMs === 'number') {
          if (s.rttMs >= 150) want = 8 * RECEIVE_WINDOW;
          else if (s.rttMs >= 50) want = 4 * RECEIVE_WINDOW;
        }
      } catch { /* transport stats unavailable — fall back to default */ }
    }
    // Hysteresis: step at most one tier per probe so boundary jitter can't flap the window.
    const tiers = [1, 4, 8].map(m => m * RECEIVE_WINDOW);
    const curIdx = tiers.indexOf(this.windowBytes), wantIdx = tiers.indexOf(want);
    if (curIdx < 0 || wantIdx < 0 || curIdx === wantIdx) return want;
    return curIdx < wantIdx ? tiers[Math.min(tiers.length - 1, curIdx + 1)] : tiers[Math.max(0, curIdx - 1)];
  }
  private startWindowProbe() {
    const probe = async () => {
      const w = await this.adaptiveWindow();
      if (w !== this.windowBytes) {
        this.windowBytes = w; this.metrics.receiveWindowBytes = w;
        try { await this.control({ type: 'window', windowBytes: w }); } catch { /* channel closing */ }
      }
    };
    this.windowProbe = setInterval(() => { void probe(); }, 3000);
    // Don't let the probe keep a headless/node process alive: unref so it never blocks exit while still firing.
    // No-op in the browser (timer handles have no unref there). setInterval is typed as number under DOM lib, hence the cast.
    (this.windowProbe as { unref?: () => void }).unref?.();
    this.aborter.signal.addEventListener('abort', () => { if (this.windowProbe) clearInterval(this.windowProbe); }, { once: true });
  }
  private clean() { clearInterval(this.timer); clearInterval(this.reportTimer); if (this.windowProbe) clearInterval(this.windowProbe); this.options.signal?.removeEventListener('abort',this.externalAbort); }
  private succeed() {
    if(this.terminal) return; this.terminal=true; this.finished=true; this.clean(); this.report('completed'); this.cb.onTransferComplete?.(); this.resolveDone();
  }
  private fail(reason: string, notify=true) {
    if(this.terminal) return; this.terminal=true; this.clean();
    this.report(reason);
    if(notify && this.dc.readyState==='open') {
      try { this.dc.send(JSON.stringify({version:2,transferId:this.tid,attemptId:this.attempt,type:'error',reason:reason.slice(0,512)})); } catch {}
    }
    this.aborter.abort(new Error(reason)); this.cb.onError?.(reason); this.rejectDone(new Error(reason));
    // On the failure path we must NOT await the background finalizes: a slow close() (tens of seconds for
    // GB files) would otherwise pin the device-wide recv lease for its whole tail. We only drain the write
    // pipeline so no queued writeAt lands on an already-aborted writable, then abort and release at once.
    // The pending finalizes keep their own writer reference and settle independently (terminal, so harmless).
    void this.queue.finally(async () => {
      try { await this.diskQueue; } catch {}
      try { await this.writer?.abort(); } catch {} this.writer=undefined; if (!this.options.sender) { this.release?.(); this.release=undefined; }
    });
    this.dc.close();
  }
  abort(reason='USER_CANCEL') { this.fail(reason); }
  isOpen() { return !this.terminal && this.dc.readyState==='open'; }
  get completed() { return this.finished; }
}
