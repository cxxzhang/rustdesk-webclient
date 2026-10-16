// Main-thread owner of the RTCPeerConnection.
//
// Lives here and not in the worker because `RTCPeerConnection` is not exposed
// to workers. It speaks the `WrtcRequest`/`WrtcReply` protocol
// (core/webrtc-bridge.ts) to the session worker and does nothing else —
// transport selection and the session itself stay in the worker.

import { WebRTCPeer, parseIceServers, type IceServer } from '../transport/webrtc';
import type { WrtcRequest, WrtcReply } from '../core/webrtc-bridge';

/** Public STUN servers, matching rustdesk's DEFAULT_ICE_SERVERS. */
const DEFAULT_STUN = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
  'stun:stun.antisip.com:3478',
  'stun:stun.nextcloud.com:443',
];

export type WebrtcHostOptions = {
  /**
   * The `ice-servers` option value (comma-separated), read when a peer is built
   * rather than at construction. The value can arrive after page load —
   * `/ice-servers.json` hands out short-lived TURN credentials — and reading it
   * late is what lets a session use them. Empty uses the STUN defaults.
   */
  iceServers?: string | (() => string | undefined);
  /** Where replies go — the session worker. */
  post: (msg: WrtcReply, transfer?: Transferable[]) => void;
  /** DI for tests. */
  createPeer?: (ice: IceServer[], hooks: ConstructorParameters<typeof WebRTCPeer>[1]) => WebRTCPeer;
};

export class WebrtcHost {
  private peer: WebRTCPeer | null = null;
  private readonly opts: WebrtcHostOptions;

  constructor(opts: WebrtcHostOptions) {
    this.opts = opts;
  }

  /**
   * True when this browser can do WebRTC at all. Checked before the worker is
   * told to offer, so an unsupported browser silently keeps the relay path
   * instead of failing a negotiation it could never finish.
   */
  static supported(): boolean {
    return typeof RTCPeerConnection !== 'undefined';
  }

  handle(req: WrtcRequest): void {
    switch (req.t) {
      case 'wrtcOffer':
        void this.makeOffer();
        return;
      case 'wrtcApplyAnswer':
        void this.applyAnswer(req.answer);
        return;
      case 'wrtcAddCandidate':
        void this.peer?.addRemoteCandidate(req.candidate);
        return;
      case 'wrtcSend':
        try {
          this.peer?.send(req.bytes);
        } catch (e) {
          this.opts.post({ t: 'wrtcClosed', reason: e instanceof Error ? e.message : String(e) });
        }
        return;
      case 'wrtcClose':
        this.peer?.close();
        this.peer = null;
        return;
    }
  }

  private ensurePeer(): WebRTCPeer {
    if (this.peer) return this.peer;
    const cfg = typeof this.opts.iceServers === 'function'
      ? this.opts.iceServers()
      : this.opts.iceServers;
    const ice = parseIceServers(cfg ?? '', DEFAULT_STUN);
    const create = this.opts.createPeer ?? ((i, hooks) => new WebRTCPeer(i, hooks));
    this.peer = create(ice, {
      onLocalCandidate: (c) => this.opts.post({ t: 'wrtcLocalCandidate', candidate: c }),
      onOpen: () => { /* readiness is implicit in the first successfully sent byte */ },
      onClose: (reason) => {
        this.opts.post({ t: 'wrtcClosed', reason });
        this.peer = null;
      },
    });
    return this.peer;
  }

  private async makeOffer(): Promise<void> {
    try {
      const peer = this.ensurePeer();
      const offer = await peer.createOffer();
      this.opts.post({ t: 'wrtcOffer', ok: true, offer, sessionKey: peer.sessionKey });
    } catch (e) {
      this.peer?.close();
      this.peer = null;
      this.opts.post({ t: 'wrtcOffer', ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  private async applyAnswer(answer: string): Promise<void> {
    try {
      if (!this.peer) throw new Error('no peer connection');
      await this.peer.acceptAnswer(answer);
      // Inbound frames are forwarded as they arrive; the data channel is what
      // receives them, not a polled queue.
      this.peer.onMessage((b) => {
        const owned = b.slice();
        this.opts.post({ t: 'wrtcMessage', bytes: owned }, [owned.buffer]);
      });
      this.opts.post({ t: 'wrtcAnswer', ok: true });
    } catch (e) {
      this.opts.post({ t: 'wrtcAnswer', ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
}
