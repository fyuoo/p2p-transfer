// Minimal observable state: the UI only subscribes, never touches WebRTC directly.

import { PeerInfo, SelfInfo } from "../signaling/types";

export type TransferStatus = "pending" | "active" | "writing" | "done" | "error" | "rejected" | "expired";

export interface TransferItem {
  id: string;
  name: string;
  size: number;
  sent: number;
  status: TransferStatus;
  direction: "send" | "recv";
  peerId?: string; // owning device id (for two-column device isolation); sender=target id, receiver=source session
  note?: string; // task-level hint (writing / done / send failed …): shown on the card, no longer occupying the global status bar
  savedName?: string; // final on-disk filename after collision-avoidance; surfaced in the UI when it differs from `name`
  writingSince?: number; // Date.now() when the file entered the disk-commit (writing) phase; lets the UI show "committing… Ns" instead of a frozen 100%
  localResult?: "pending" | "sending" | "sent" | "saved" | "failed" | "cancelled";
  remoteResult?: "unknown" | "receiving" | "saving" | "saved" | "failed" | "cancelled";
  remoteError?: string;
}

export interface AppState {
  self?: SelfInfo;
  peers: PeerInfo[];
  transfers: TransferItem[];
  statusText: string;
  /** The moment statusText last **changed** (Date.now()). The banner computes its auto-dismiss time from this.
   *  Repeating the same sentence via set does not refresh it —— otherwise the fixed text in a reconnect loop would keep the banner alive forever (the cause of "stickiness"). */
  statusAt: number;
  /** Access-token expiry moment (already corrected to server time): number=expires; null=permanent; undefined=unknown. */
  tokenExpiresAt?: number | null;
}

type Listener = (s: AppState) => void;

export class Store {
  private state: AppState = { peers: [], transfers: [], statusText: "未连接", statusAt: 0 };
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }
  set(patch: Partial<AppState>): void {
    const next = { ...patch };
    // Only refresh statusAt when the text changes: repeating set of the same sentence shouldn't "re-energize" the banner.
    if (next.statusText !== undefined && next.statusText !== this.state.statusText) next.statusAt = Date.now();
    this.state = { ...this.state, ...next };
    this.emit();
  }
  updateTransfer(id: string, patch: Partial<TransferItem>, notify = true): void {
    this.state = {
      ...this.state,
      transfers: this.state.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    };
    if (notify) this.emit();
  }
  removeTransfers(ids: Set<string>): void { this.state={...this.state,transfers:this.state.transfers.filter(t=>!ids.has(t.id))};this.emit(); }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void {
    this.listeners.forEach((l) => l(this.state));
  }
}
