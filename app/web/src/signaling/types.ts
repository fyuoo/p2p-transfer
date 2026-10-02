// Signaling client interface: implemented separately for desktop (Tauri) and browser (mobile); the UI is agnostic to the difference.

export interface PeerInfo {
  id: string;
  name: string;
  ip?: string;
  port?: number;
  engine?: 'browser-v2' | 'windows-native-v1';
  source?: 'signaling' | 'lan';
  transport?: 'dc' | 'tcp';
  capabilities?: { wireProtocol: 'transfer-v2'; send: boolean; receive: boolean; resume: boolean; pauseResume?: boolean; folder: boolean; maxFrameSize: number };
}

export interface SelfInfo {
  id: string;
  name: string;
  port: number;
  ip: string;
}

export interface SignalPayload {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  kind?: 'cancel' | 'pause' | 'resume' | 'error';
  transferId?: string;
  reason?: string;
}

// File summary carried in an invite, so the receiver can see name/size before accepting (security review).
export interface InviteFile {
  name: string;
  size: number;
  diagnosticMode?: import('../transfer/diagnostics').TestMode;
}

export interface Signaling {
  start(): Promise<void>;
  getSelf(): Promise<SelfInfo>;
  listPeers(): Promise<PeerInfo[]>;
  connectPeer(id: string): Promise<void>;
  acceptPeer(id: string): Promise<void>;
  rejectPeer(id: string): Promise<void>;
  sendSignal(id: string, data: SignalPayload): Promise<void>;
  sendInvite(to: string, files: InviteFile[], transferId: string): Promise<void>;
  acceptTransfer(to: string, transferId: string): Promise<void>;
  rejectTransfer(to: string, transferId: string): Promise<void>;
  onInvite(cb: (from: string, name: string, session: string, files?: InviteFile[], transferId?: string) => void): void;
  onAccept(cb: (from: string, transferId: string) => void): void;
  onReject(cb: (from: string, transferId: string) => void): void;
  onSignal(cb: (session: string, data: SignalPayload) => void): void;
  onBye(cb: (session: string) => void): void;
  onPeerList(cb: (peers: PeerInfo[]) => void): void;
  /** Callback when the signaling reconnect reassigns the id (role basis changed, session must be rebuilt). Optional. */
  onSelfChange?(cb: (self: SelfInfo) => void): void;
  /**
   * Access-token expiry timestamp (pushed by server welcome): number=expiry moment; null=long-lived;
   * undefined=unknown (not connected, or server is an older build that did not push this field). Optional.
   */
  onTokenExpiry?(cb: (expiresAt: number | null | undefined) => void): void;
}
