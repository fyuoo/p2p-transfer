// PeerConnection wrapper: only handles SDP / ICE creation and setup; no file-transfer logic.

export type SignalData =
  | { sdp: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit };

export class Peer {
  private pendingIce: RTCIceCandidateInit[] = [];
  readonly pc: RTCPeerConnection;
  dataChannel?: RTCDataChannel;

  constructor(
    config: RTCConfiguration,
   /** true=trickle ICE: send offer/answer right after setLocalDescription, candidates stream as they arrive;
    * false=non-trickle: send SDP only after ICE gathering completes (candidates inlined). Enabled by default. */
    private trickle = true,
    private onDataChannel?: (dc: RTCDataChannel) => void,
    private onIceCandidate?: (c: RTCIceCandidate) => void,
    private onConnectionState?: (s: RTCPeerConnectionState) => void,
  ) {
    this.pc = new RTCPeerConnection(config);
    // Only emit candidate messages in trickle mode; in non-trickle they are already inlined in the SDP, so re-sending is redundant.
    this.pc.onicecandidate = (e) => {
      if (this.trickle && e.candidate) this.onIceCandidate?.(e.candidate);
    };
    this.pc.onconnectionstatechange = () => this.onConnectionState?.(this.pc.connectionState);
    this.pc.ondatachannel = (e) => this.onDataChannel?.(e.channel);
  }

  createDataChannel(label = "p2p-files"): RTCDataChannel {
    this.dataChannel = this.pc.createDataChannel(label, { ordered: true });
    return this.dataChannel;
  }

  async createOffer(iceRestart = false): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await this.pc.setLocalDescription(offer);
    if (this.trickle) return this.pc.localDescription?.toJSON() ?? offer;
    await this.waitForIceGathering();
    return this.pc.localDescription?.toJSON() ?? offer;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (this.trickle) return this.pc.localDescription?.toJSON() ?? answer;
    await this.waitForIceGathering();
    return this.pc.localDescription?.toJSON() ?? answer;
  }

  private async waitForIceGathering(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('ICE_GATHER_TIMEOUT')); }, 20_000);
      const changed = () => { if (this.pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      const cleanup = () => { clearTimeout(timer); this.pc.removeEventListener('icegatheringstatechange', changed); };
      this.pc.addEventListener('icegatheringstatechange', changed);
      changed();
    });
  }

  async setRemote(desc: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(desc);
    for (const candidate of this.pendingIce.splice(0)) await this.pc.addIceCandidate(candidate);
  }

  async addIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc.remoteDescription) {
      if (this.pendingIce.length >= 256) throw new Error('ICE_QUEUE_FULL');
      this.pendingIce.push(candidate);
    } else await this.pc.addIceCandidate(candidate);
  }
}
