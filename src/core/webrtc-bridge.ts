// The worker <-> main-thread contract for WebRTC.
//
// `RTCPeerConnection` exists only on the main thread (`WorkerGlobalScope` has no
// constructor for it), while the Session — the thing that needs the transport —
// lives in the session worker. So the peer connection is built on the main
// thread and the worker drives it over postMessage.
//
// The split follows what can be synchronous and what cannot:
//   - `sessionKey()` must be synchronous, because Session reads it right after
//     createOffer() resolves. So the offer reply carries the key, and the worker
//     stub holds it.
//   - Everything else is naturally asynchronous.
//
// Bytes are the bulk of the traffic, so they are sent as transferables rather
// than copies.

/** Worker -> main: build the offer; main replies with it plus the session key. */
export type WrtcRequest =
  | { t: 'wrtcOffer' }
  | { t: 'wrtcApplyAnswer'; answer: string }
  | { t: 'wrtcAddCandidate'; candidate: string }
  | { t: 'wrtcSend'; bytes: Uint8Array }
  | { t: 'wrtcClose' };

/** Main -> worker: results and inbound traffic. */
export type WrtcReply =
  | { t: 'wrtcOffer'; ok: true; offer: string; sessionKey: string }
  | { t: 'wrtcOffer'; ok: false; reason: string }
  | { t: 'wrtcAnswer'; ok: boolean; reason?: string }
  | { t: 'wrtcLocalCandidate'; candidate: string }
  | { t: 'wrtcMessage'; bytes: Uint8Array }
  | { t: 'wrtcClosed'; reason: string };

/** True when a message came from the WebRTC bridge rather than the SessionEvent channel. */
export function isWrtcReply(m: unknown): m is WrtcReply {
  return !!m && typeof m === 'object' && typeof (m as { t?: unknown }).t === 'string'
    && ((m as { t: string }).t).startsWith('wrtc');
}

/**
 * True for a message the *worker* sent, i.e. a request the main thread must act
 * on. Both directions share one channel, and their case sets are disjoint
 * (requests name an action, replies report one), so one prefix check per side
 * is enough. Main thread: isWrtcRequest. Worker: isWrtcReply.
 */
export function isWrtcRequest(m: unknown): m is WrtcRequest {
  return !!m && typeof m === 'object' && typeof (m as { t?: unknown }).t === 'string'
    && ((m as { t: string }).t).startsWith('wrtc');
}
