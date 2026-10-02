export type TestMode = 'full' | 'network' | 'hash' | 'disk';
export const MODE_LABELS: Record<TestMode, string> = {
  network: 'A · 仅传输（不校验、不保存）',
  hash: 'B · 传输 + 校验（不保存）',
  disk: 'C · 传输 + 写盘（不校验）',
  full: 'D · 完整流程（校验并保存）',
};
export const usesHash = (mode: TestMode) => mode === 'full' || mode === 'hash';
export const usesDisk = (mode: TestMode) => mode === 'full' || mode === 'disk';
export interface TransportSample {
  elapsedMs: number; bufferedBytes: number; payloadBytes: number;
  rttMs?: number; bytesSent?: number; bytesReceived?: number;
  local?: { address?: string; port?: number; protocol?: string; candidateType?: string };
  remote?: { address?: string; port?: number; protocol?: string; candidateType?: string };
}
export interface DiagnosticResult {
  transferId: string; direction: 'send' | 'recv'; mode: TestMode; status: string;
  startedAt: string; elapsedMs: number; payloadBytes: number; totalBytes: number;
  averageMiBs: number; readMs: number; hashMs: number; writeMs: number;
  finalizeMs: number; creditWaitMs: number; schedulerWaitMs: number;
  queuePeakBytes: number; bufferedPeakBytes: number; rateLimitBytesPerSecond: number;
  hiddenSamples: number;
  receiveWindowBytes: number; creditStalls: number; creditWakeups: number;
  creditResumeMs: number; creditResumeMaxMs: number; creditToSendMs: number;
  creditToSendMaxMs: number; prefetchBlocks: number;
  frameBytes: number; sourceKind: 'file'|'memory'; receivedFrames: number;
  receiveGapMs: number; receiveGapMaxMs: number; receiveProcessingMs: number;
  receiveProcessingMaxMs: number; creditSendMs: number; creditSendCount: number;
  transportSamples: TransportSample[]; statsErrors: number; pendingWritePeakBytes: number;
  lastSendError?: { phase: string; bytes: number; buffered: number; readyState: string; name: string; message: string; frameBytes?: number; maxMessageSize?: number; stack?: string };
}
