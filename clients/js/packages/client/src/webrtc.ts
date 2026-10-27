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
  onRemoteAddress: PeerLink["onRemoteAddress"] = null;

  private pc: RTCPeerConnection;
  private channels = {} as Record<ChannelName, RTCDataChannel>;
  private pendingIce: RTCIceCandidateInit[] = [];
  /**
   * Set once setRemoteDescription resolves. Not `pc.remoteDescription`: node-datachannel's polyfill returns an object
   * there before any is set, and its addIceCandidate throws until one is.
   */
  private haveRemote = false;
  private closed = false;
  private opened = 0;
  private early: [ChannelName, Uint8Array][] = [];
  private extra: string[];

  /** `rtc`: the RTCPeerConnection class to use (default the global one; in Node, node-datachannel's polyfill). */
  constructor(opts: LinkOptions, rtc: typeof RTCPeerConnection = globalThis.RTCPeerConnection) {
    this.remoteId = opts.remoteId;
    this.extra = opts.extraRemoteCandidates ?? [];
    const config: RTCConfiguration & Record<string, unknown> = {
      iceServers: opts.iceServers as RTCIceServer[],
      iceTransportPolicy: opts.relayOnly ? "relay" : "all",
    };
    if (opts.portRange) {
      // libdatachannel names (node-datachannel passes its config through); one pinned port = every peer on it
      config.portRangeBegin = opts.portRange.begin;
      config.portRangeEnd = opts.portRange.end;
      if (opts.portRange.begin === opts.portRange.end) config.enableIceUdpMux = true;
    }
    this.pc = new rtc(config);
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
  }

  /**
   * The offerer creates the channels just before its offer, the answerer once the remote offer is set. Creating them
   * any earlier makes libdatachannel (node-datachannel) start an offer of its own on the answering side, which then
   * collides with the real one (both ICE agents controlling, the link never opens).
   */
  private openChannels(): void {
    if (this.channels.reliable) return;
    for (const name of ["reliable", "fast", "voice"] as ChannelName[]) {
      const ch = this.pc.createDataChannel(name, CHANNEL_INIT[name]);
      ch.binaryType = "arraybuffer";
      ch.onopen = () => {
        if (++this.opened === 3 && !this.closed) {
          this.isOpen = true;
          this.onOpen?.();
          for (const [n, data] of this.early.splice(0)) if (!this.closed) this.onMessage?.(n, data);
          void this.reportPath();
        }
      };
      ch.onclose = () => this.fail(`channel ${name} closed`);
      ch.onmessage = (e) => {
        const d = e.data as unknown;
        const data = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d as never);
        // The far side can open first and speak at once; hold its data until this side is open too, so whoever
        // reads it can already answer (otherwise the host queues or drops its replies to a link it thinks is down).
        if (!this.isOpen) {
          if (this.early.length < 1000) this.early.push([name, data]);
          return;
        }
        this.onMessage?.(name, data);
      };
      this.channels[name] = ch;
    }
  }

  startOffer(): void {
    void (async () => {
      try {
        this.openChannels();
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
        this.haveRemote = true;
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
        if (this.extra.length) {
          // docs/design/direct-ip.md s.2: the address the joiner typed is the host's reachable candidate
          const mid = /^a=mid:(\S+)/m.exec(s.sdp.sdp)?.[1] ?? "0";
          for (const candidate of this.extra.splice(0)) await this.pc.addIceCandidate({ candidate, sdpMid: mid, sdpMLineIndex: 0 });
        }
        if (s.sdp.type === "offer") {
          this.openChannels();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.onSignal?.({ sdp: { type: "answer", sdp: answer.sdp ?? "" } });
        }
      }
      if (s.ice) {
        // a candidate can come before the description it belongs to (the far side's native callbacks are unordered)
        if (this.haveRemote) await this.pc.addIceCandidate(s.ice as RTCIceCandidateInit);
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
        // the remote address (not a relay's, not an mDNS name) lets a Nostr host ban the IP behind a kicked key
        const addr = String(r.address ?? r.ip ?? "");
        if (r.candidateType !== "relay" && l.candidateType !== "relay" && addr && !addr.endsWith(".local")) this.onRemoteAddress?.(addr.replace(/^::ffff:/i, ""));
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

/** A link factory over a given RTCPeerConnection class, e.g. `import { RTCPeerConnection } from "node-datachannel/polyfill"`. */
export function webRtcLinkFactoryFor(rtc: typeof RTCPeerConnection): LinkFactory {
  return { create: (opts) => new WebRtcLink(opts, rtc) };
}
