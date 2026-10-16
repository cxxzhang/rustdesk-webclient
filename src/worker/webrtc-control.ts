// Worker-side `WebRtcControl`: an RTCPeerConnection that lives on the main
// thread, driven over postMessage.
//
// The one awkward part is `sessionKey()`. Session reads it synchronously right
// after `createOffer()` resolves, but the key comes from the peer connection on
// the other thread. So the offer reply carries the key and we keep it here; the
// method is synchronous from the caller's point of view and never lies, because
// nothing reads it before createOffer() has completed.

import type { WebRtcControl } from '../core/contracts';
import type { WrtcReply } from '../core/webrtc-bridge';

export interface WrtcBridge {
  /** Send to the main thread. */
  post(msg: unknown, transfer?: Transferable[]): void;
}

export class BridgedWebRtcControl implements WebRtcControl {
  private key = '';
  private localCb: ((c: string) => void) | null = null;
  private msgCb: ((b: Uint8Array) => void) | null = null;
  private closeCb: ((reason: string) => void) | null = null;
  private offerResolve: ((o: string) => void) | null = null;
  private offerReject: ((e: Error) => void) | null = null;
  private answerResolve: ((ok: boolean) => void) | null = null;
  private closed = false;

  constructor(private readonly bridge: WrtcBridge) {}

  sessionKey(): string {
    return this.key;
  }

  onLocalCandidate(cb: (candidateJson: string) => void): void {
    this.localCb = cb;
  }

  createOffer(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.offerResolve = resolve;
      this.offerReject = reject;
      this.bridge.post({ t: 'wrtcOffer' });
    });
  }

  acceptAnswer(endpoint: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.answerResolve = (ok) => (ok ? resolve() : reject(new Error('peer answer not applied')));
      this.bridge.post({ t: 'wrtcApplyAnswer', answer: endpoint });
    });
  }

  addRemoteCandidate(candidateJson: string): void {
    if (!candidateJson || this.closed) return;
    this.bridge.post({ t: 'wrtcAddCandidate', candidate: candidateJson });
  }

  send(bytes: Uint8Array): void {
    if (this.closed) throw new Error('webrtc channel closed');
    // Copy into a transferable buffer: the caller may reuse or mutate `bytes`
    // after this returns, and a transferred ArrayBuffer is detached here.
    const owned = bytes.slice();
    this.bridge.post({ t: 'wrtcSend', bytes: owned }, [owned.buffer]);
  }

  buffered(): number {
    // The send queue lives on the main thread; Session only uses this for file
    // upload pacing, and WebRTC's own backpressure handles that, so report 0
    // rather than round-trip for a number.
    return 0;
  }

  onMessage(cb: (b: Uint8Array) => void): void {
    this.msgCb = cb;
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCb = cb;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bridge.post({ t: 'wrtcClose' });
  }

  /** Called by the worker's message pump for every `wrtc*` reply. */
  handle(reply: WrtcReply): void {
    switch (reply.t) {
      case 'wrtcOffer':
        if (reply.ok) {
          this.key = reply.sessionKey;
          this.offerResolve?.(reply.offer);
        } else {
          this.offerReject?.(new Error(reply.reason));
        }
        this.offerResolve = null;
        this.offerReject = null;
        return;
      case 'wrtcAnswer':
        this.answerResolve?.(reply.ok);
        this.answerResolve = null;
        return;
      case 'wrtcLocalCandidate':
        this.localCb?.(reply.candidate);
        return;
      case 'wrtcMessage':
        this.msgCb?.(reply.bytes);
        return;
      case 'wrtcClosed':
        if (!this.closed) {
          this.closed = true;
          this.closeCb?.(reply.reason);
        }
        return;
    }
  }
}
