import {
  CHANNEL_IDS,
  type ChannelName,
  type LinkFactory,
  type LinkOptions,
  type PeerLink,
  type SignalPayload,
} from "./transport.js";

const CHANNEL_INIT: Record<ChannelName, RTCDataChannelInit> = {
  reliable: { negotiated: true, id: CHANNEL_IDS.reliable, ordered: true },
  fast: { negotiated: true, id: CHANNEL_IDS.fast, ordered: false, maxRetransmits: 0 },
  voice: { negotiated: true, id: CHANNEL_IDS.voice, ordered: false, maxRetransmits: 0 },
};

/** Browser (or any WebRTC-capable runtime) PeerLink over RTCPeerConnection with three negotiated channels. */
export class WebRtcLink implements PeerLink {
  readonly remoteId: number;
  isOpen = false;
  onSignal: PeerLink["onSignal"] = null;
  onOpen: PeerLink["onOpen"] = null;
  onClose: PeerLink["onClose"] = null;
  onMessage: PeerLink["onMessage"] = null;
  onPath: PeerLink["onPath"] = null;

  private pc: RTCPeerConnection;
  private channels = {} as Record<ChannelName, RTCDataChannel>;
  private pendingIce: RTCIceCandidateInit[] = [];
  private closed = false;
  private opened = 0;

  constructor(opts: LinkOptions) {
    this.remoteId = opts.remoteId;
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers as RTCIceServer[],
      iceTransportPolicy: opts.relayOnly ? "relay" : "all",
    });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.onSignal?.({ ice: e.candidate.toJSON() as { candidate: string } });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") {
        // "disconnected" can recover; give ICE a moment before declaring the link dead.
        if (s === "disconnected") setTimeout(() => this.pc.connectionState === "disconnected" && this.fail("disconnected"), 4000);
        else this.fail(s);
      }
    };
    for (const name of ["reliable", "fast", "voice"] as ChannelName[]) {
      const ch = this.pc.createDataChannel(name, CHANNEL_INIT[name]);
      ch.binaryType = "arraybuffer";
      ch.onopen = () => {
        if (++this.opened === 3 && !this.closed) {
          this.isOpen = true;
          this.onOpen?.();
          void this.reportPath();
        }
      };
      ch.onclose = () => this.fail(`channel ${name} closed`);
      ch.onmessage = (e) => {
        const data = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new Uint8Array((e.data as Blob) as never);
        this.onMessage?.(name, data);
      };
      this.channels[name] = ch;
    }
  }

  startOffer(): void {
    void (async () => {
      try {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.onSignal?.({ sdp: { type: "offer", sdp: offer.sdp ?? "" } });
      } catch (e) {
        this.fail(`offer failed: ${String(e)}`);
      }
    })();
  }

  async handleSignal(s: SignalPayload): Promise<void> {
    try {
      if (s.sdp) {
        await this.pc.setRemoteDescription({ type: s.sdp.type, sdp: s.sdp.sdp });
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
        if (s.sdp.type === "offer") {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.onSignal?.({ sdp: { type: "answer", sdp: answer.sdp ?? "" } });
        }
      }
      if (s.ice) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(s.ice as RTCIceCandidateInit);
        else this.pendingIce.push(s.ice as RTCIceCandidateInit);
      }
    } catch (e) {
      this.fail(`signal failed: ${String(e)}`);
    }
  }

  /** Selected candidate pair has a relay candidate -> "relayed", else "direct". Retries while stats settle. */
  private async reportPath(attempt = 0): Promise<void> {
    if (this.closed || attempt > 10) return;
    try {
      const stats = await this.pc.getStats();
      const byId = new Map<string, any>();
      stats.forEach((v) => byId.set(v.id, v));
      let pair: any;
      stats.forEach((v) => {
        if (v.type === "transport" && v.selectedCandidatePairId) pair = byId.get(v.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((v) => { if (v.type === "candidate-pair" && (v.selected || (v.nominated && v.state === "succeeded"))) pair = v; });
      const l = pair && byId.get(pair.localCandidateId);
      const r = pair && byId.get(pair.remoteCandidateId);
      if (l && r) {
        this.onPath?.(l.candidateType === "relay" || r.candidateType === "relay" ? "relayed" : "direct");
        return;
      }
    } catch {
      /* stats unavailable: retry */
    }
    setTimeout(() => void this.reportPath(attempt + 1), 300);
  }

  send(channel: ChannelName, bytes: Uint8Array): void {
    const ch = this.channels[channel];
    if (ch && ch.readyState === "open") ch.send(bytes as unknown as ArrayBuffer);
  }

  close(): void {
    this.fail("closed locally");
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const wasOpen = this.isOpen;
    this.isOpen = false;
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    void wasOpen;
    this.onClose?.(reason);
  }
}

export const webRtcLinkFactory: LinkFactory = { create: (opts) => new WebRtcLink(opts) };
