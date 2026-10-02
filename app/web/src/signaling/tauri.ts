// Tauri signaling: the frontend does not open a WebSocket directly; everything goes through the Rust bridge
// (Rust hosts the embedded signaling service and mDNS).
// Dynamic import of @tauri-apps/api so pure-browser builds won't fail for the missing package.

import { InviteFile, PeerInfo, SelfInfo, SignalPayload, Signaling } from "./types";

export class TauriSignaling implements Signaling {
  private inviteCb?: (from: string, name: string, session: string, files?: InviteFile[], transferId?: string) => void;
  private acceptCb?: (from: string, transferId: string) => void;
  private rejectCb?: (from: string, transferId: string) => void;
  private signalCb?: (session: string, data: SignalPayload) => void;
  private byeCb?: (session: string) => void;
  private peerListCb?: (peers: PeerInfo[]) => void;

  async start(): Promise<void> {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<any>("peer-list", (e) => this.peerListCb?.(e.payload));
    await listen<any>("invite", (e) => this.inviteCb?.(e.payload.from, e.payload.name, e.payload.session, e.payload.files, e.payload.transferId));
    await listen<any>("accept", (e) => this.acceptCb?.(e.payload.from, e.payload.transferId));
    await listen<any>("reject", (e) => this.rejectCb?.(e.payload.from, e.payload.transferId));
    await listen<any>("signal", (e) => this.signalCb?.(e.payload.session, e.payload.data));
    await listen<any>("bye", (e) => this.byeCb?.(e.payload.session));
  }

  async getSelf(): Promise<SelfInfo> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("get_self");
  }
  async listPeers(): Promise<PeerInfo[]> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("list_peers");
  }
  async connectPeer(id: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("connect_peer", { id });
  }
  async acceptPeer(id: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("accept_peer", { id });
  }
  async rejectPeer(id: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("reject_peer", { id });
  }
  async sendSignal(id: string, data: SignalPayload): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke("send_signal", { id, data });
  }
  async sendInvite(to: string, files: InviteFile[], transferId: string): Promise<void> {
    await this.sendTask(to, { type: 'invite', files, transferId });
  }
  async acceptTransfer(to: string, transferId: string): Promise<void> {
    await this.sendTask(to, { type: 'accept', transferId });
  }
  async rejectTransfer(to: string, transferId: string): Promise<void> {
    await this.sendTask(to, { type: 'reject', transferId });
  }
  private async sendTask(id: string, data: unknown): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('send_task', { id, data });
  }

  onInvite(cb: (from: string, name: string, session: string, _files?: InviteFile[], _transferId?: string) => void): void { this.inviteCb = cb; }
  onAccept(cb: (from: string, transferId: string) => void): void { this.acceptCb = cb; }
  onReject(cb: (from: string, transferId: string) => void): void { this.rejectCb = cb; }
  onSignal(cb: (session: string, data: SignalPayload) => void): void { this.signalCb = cb; }
  onBye(cb: (session: string) => void): void { this.byeCb = cb; }
  // On Tauri the id is held and stable by Rust, so onSelfChange is unnecessary (the interface is optional, can be omitted).
  // Pull the current peer list once after registration to avoid the initial peer-list event arriving before registration and being dropped.
  onPeerList(cb: (peers: PeerInfo[]) => void): void {
    this.peerListCb = cb;
    void this.listPeers()
      .then((p) => {
        if (p?.length) cb(p);
      })
      .catch(() => {});
  }
}
