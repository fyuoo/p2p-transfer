export type TelemetryDirection = 'send' | 'recv';

/** Cross-runtime, privacy-preserving diagnostic event. No file names, paths, tokens or addresses. */
export interface TransferTelemetryEvent {
  eventId: string;
  timestamp: string;
  event: string;
  taskId?: string;
  direction?: TelemetryDirection;
  status?: string;
  errorCode?: string;
  bytes?: number;
  elapsedMs?: number;
  runtime: 'browser' | 'tauri';
  schema: 1;
}
