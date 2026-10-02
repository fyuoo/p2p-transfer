import { unthrottledTick } from './throttle';
export const DEFAULT_LIMITS = {
  active: 4, perDirection: 2, queued: 100, memory: 128 * 1024 * 1024,
  taskMemory: 8 * 1024 * 1024, rate: 256 * 1024 * 1024,
  highWater: 8 * 1024 * 1024, lowWater: 4 * 1024 * 1024,
};
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason ?? new Error('CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
}
type Waiting = { peer: string; direction: string; memory: number; signal: AbortSignal; resolve: (release: () => void) => void; cancel: () => void };
type Frame = { peer: string; task: string; bytes: number; writable: () => boolean; send: () => void; signal: AbortSignal; resolve: () => void; reject: (e: unknown) => void; cancel: () => void };
/** Device-wide admission, bounded pending frames and fair peer/task rounds. */
export class TransferScheduler {
  readonly limits: typeof DEFAULT_LIMITS;
  private waiting: Waiting[] = [];
  private leases = new Map<string, number>();
  private active = 0; private memory = 0;
  private frames: Frame[] = [];
  private pending = false;
  private tokens = 0; private tickAt = performance.now();
  private lastPeer = ''; private lastTask = new Map<string, string>();
  private paused = new Set<string>();
  constructor(limits: Partial<typeof DEFAULT_LIMITS> = {}) { this.limits = { ...DEFAULT_LIMITS, ...limits }; }
  snapshot() { return { active: this.active, queued: this.waiting.length, memory: this.memory, frames: this.frames.length }; }
  pause(task: string) { this.paused.add(task); }
  resume(task: string) { this.paused.delete(task); this.schedule(); }
  isPaused(task: string) { return this.paused.has(task); }
  setRate(bytesPerSecond: number) {
    if (!Number.isFinite(bytesPerSecond) || (bytesPerSecond !== 0 && bytesPerSecond < 65536)) throw new Error('INVALID_RATE');
    this.limits.rate = bytesPerSecond;
  }
  acquire(peer: string, direction: 'send' | 'recv', signal: AbortSignal, memory = this.limits.taskMemory): Promise<() => void> {
    if (!Number.isSafeInteger(memory) || memory < this.limits.taskMemory || memory > this.limits.memory) return Promise.reject(new Error('INVALID_MEMORY_RESERVATION'));
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.waiting.length >= this.limits.queued) return Promise.reject(new Error('BUSY'));
    return new Promise((resolve, reject) => {
      const w: Waiting = { peer, direction, memory, signal, resolve, cancel: () => {
        this.waiting = this.waiting.filter(x => x !== w); signal.removeEventListener('abort', w.cancel); reject(signal.reason ?? new Error('CANCELLED'));
      } };
      this.waiting.push(w); signal.addEventListener('abort', w.cancel, { once: true }); this.drain();
    });
  }
  private drain() {
    for (const w of [...this.waiting]) {
      const key = `${w.peer}:${w.direction}`;
      const directionActive = [...this.leases.entries()].filter(([k]) => k.endsWith(':'+w.direction)).reduce((n, [, v]) => n + v, 0);
      if (this.active >= this.limits.active || directionActive >= this.limits.perDirection ||
          (this.leases.get(key) ?? 0) >= this.limits.perDirection || this.memory + w.memory > this.limits.memory) continue;
      this.waiting.splice(this.waiting.indexOf(w), 1); w.signal.removeEventListener('abort', w.cancel);
      this.active++; this.memory += w.memory; this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
      let released = false;
      w.resolve(() => {
        if (released) return; released = true;
        this.active--; this.memory -= w.memory;
        this.leases.set(key, this.leases.get(key)! - 1); this.drain();
      });
    }
  }
  send(peer: string, task: string, bytes: number, writable: () => boolean, send: () => void, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (bytes > 1024 * 1024 || this.frames.some(f => f.task === task)) return Promise.reject(new Error('INVALID_SCHEDULER_FRAME'));
    return new Promise((resolve, reject) => {
      const f: Frame = { peer, task, bytes, writable, send, signal, resolve, reject, cancel: () => {
        this.frames = this.frames.filter(x => x !== f); signal.removeEventListener('abort', f.cancel); reject(signal.reason);
      } };
      signal.addEventListener('abort', f.cancel, { once: true }); this.frames.push(f); this.schedule();
    });
  }
  private schedule() { if (!this.pending) { this.pending = true; unthrottledTick(() => this.pump()); } }
  private pump() {
    this.pending = false; const now = performance.now();
    this.tokens = Math.min(Math.max(1024 * 1024, this.limits.rate * .05), this.tokens + (now - this.tickAt) * this.limits.rate / 1000); this.tickAt = now;
    if (this.limits.rate === 0) this.tokens = 1024 * 1024;
    // Send a bounded burst per event-loop turn instead of a timer turn per frame.
    for (let i = 0; i < 256; i++) {
      const ready = this.frames.filter(f => !this.paused.has(f.task) && f.bytes <= this.tokens && f.writable()); if (!ready.length) break;
      const peers = [...new Set(ready.map(f => f.peer))];
      const peer = peers[(peers.indexOf(this.lastPeer) + 1) % peers.length];
      const tasks = ready.filter(f => f.peer === peer);
      const f = tasks[(tasks.findIndex(x => x.task === this.lastTask.get(peer)) + 1) % tasks.length];
      this.lastPeer = peer; this.lastTask.set(peer, f.task);
      this.frames.splice(this.frames.indexOf(f), 1); f.signal.removeEventListener('abort', f.cancel); this.tokens -= f.bytes;
      try { f.send(); f.resolve(); } catch (e) { f.reject(e); }
    }
    if (this.frames.length) this.schedule();
  }
}
