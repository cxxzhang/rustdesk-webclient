// WebRTC data-channel transport, matching rustdesk's `libs/hbb_common/src/webrtc.rs`.
//
// This is the browser half of a transport the Rust client speaks natively. Three
// things about it are wire contracts, not choices, and are reproduced exactly:
//
//   1. The signaling envelope is `webrtc://` + base64(JSON {type, sdp, ice_policy}).
//      `ice_policy: "all"` tells the peer its answer may gather every candidate
//      type even though the request carries force_relay (webrtc.rs encode_endpoint).
//   2. The session key is the SDP's `a=fingerprint` value, verbatim. It routes
//      trickled ICE candidates and nothing else — both peers must derive it the
//      same way or candidates land on a session nobody is listening for.
//   3. Frames on the data channel are `1 byte header + payload`, header 0 = final
//      fragment, 1 = more to follow, payload at most MAX_FRAGMENT_PAYLOAD. There
//      is no length prefix: reassembly depends on every channel being ordered and
//      fully reliable, which is why we reject any other kind (webrtc.rs 744-754).
//      The 60000 cap keeps a fragment inside SCTP's 65536-byte message limit.
//
// No secretbox here: DTLS secures the channel, so the stream cipher the relay
// path installs would be double encryption. rustdesk makes the same call —
// WebRTC key exchange is pinned to version 0 and `set_raw` clears nothing
// (webrtc.rs `set_raw` is a no-op).

const FRAG_MORE = 1;
const FRAG_END = 0;
const MAX_FRAGMENT_PAYLOAD = 60000;
/** Uncompressed frames at high quality can exceed one fragment; bound the reassembly buffer. */
const MAX_REASSEMBLED = 64 * 1024 * 1024;

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

export type WebRTCSignaling = {
  /** Called with each local candidate as JSON (RTCIceCandidateInit), for the peer. */
  onLocalCandidate: (candidateJson: string) => void;
  /** Fired once the data channel is open and the stream can carry messages. */
  onOpen: () => void;
  /** Fired on connection failure/closure with a human-readable reason. */
  onClose: (reason: string) => void;
};

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Encode an SDP into the `webrtc://` envelope.
 *
 * `relayOnly` omits `ice_policy` entirely — that is how the Rust side reads it
 * back: absent key means "not declared", i.e. the old Relay-only reading
 * (webrtc.rs endpoint_declares_all_ice). Under a pure WebSocket deployment we
 * always want full ICE, so we pass false and the answer may form a direct pair.
 */
export function encodeEndpoint(
  type: 'offer' | 'answer',
  sdp: string,
  relayOnly: boolean,
): string {
  const envelope: Record<string, string> = { type, sdp };
  if (!relayOnly) envelope.ice_policy = 'all';
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  return 'webrtc://' + b64encode(json);
}

export function decodeEndpoint(endpoint: string): { type: 'offer' | 'answer'; sdp: string } {
  if (!endpoint.startsWith('webrtc://')) throw new Error('not a webrtc:// endpoint');
  const b64 = endpoint.slice('webrtc://'.length);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const obj = JSON.parse(new TextDecoder().decode(bytes)) as { type: string; sdp: string };
  if (obj.type !== 'offer' && obj.type !== 'answer') throw new Error(`unexpected sdp type ${obj.type}`);
  return { type: obj.type, sdp: obj.sdp };
}

/** The DTLS fingerprint of a session description, used as the ICE session key. */
function fingerprintOf(sdp: string): string {
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=fingerprint:')) return line.slice('a=fingerprint:'.length).trim();
  }
  throw new Error('SDP has no a=fingerprint attribute');
}

/**
 * One RTCPeerConnection plus the framing that makes it look like a Stream.
 *
 * Browsers only expose WebRTC on the main thread (`RTCPeerConnection` is not
 * available in a Worker), so this class lives there and the session worker talks
 * to it over postMessage.
 */
export class WebRTCPeer {
  private readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel | null = null;
  private readonly signaling: WebRTCSignaling;
  /** Set once the remote description is applied, so the session key is available. */
  private sessionKeyValue = '';
  private opened = false;
  private closed = false;
  private readonly recvAcc: Uint8Array[] = [];
  private recvLen = 0;
  private msgCb: ((b: Uint8Array) => void) | null = null;
  private readonly pendingRemote: RTCIceCandidateInit[] = [];

  constructor(iceServers: IceServer[], signaling: WebRTCSignaling) {
    this.signaling = signaling;
    this.pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });

    this.pc.onicecandidate = (ev) => {
      // A null candidate means gathering finished; rustdesk's forwarder treats
      // that as the agent's last word and stops, so we simply do not send one.
      if (!ev.candidate) return;
      this.signaling.onLocalCandidate(JSON.stringify(ev.candidate.toJSON()));
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'failed' || st === 'closed') this.finish(`webrtc ${st}`);
      else if (st === 'disconnected') {
        // Transient per spec; only a later `failed` is terminal. rustdesk reports
        // it beside the gating states for the same reason (webrtc.rs Disconnected).
      }
    };
  }

  get sessionKey(): string {
    return this.sessionKeyValue;
  }

  /** Offerer side: build the channel, then the offer, and return the envelope. */
  async createOffer(): Promise<string> {
    this.bindChannel(this.pc.createDataChannel('bootstrap', { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sessionKeyValue = fingerprintOf(offer.sdp ?? '');
    return encodeEndpoint('offer', offer.sdp ?? '', false);
  }

  /** Answerer side: apply the peer's offer, answer, and return the envelope. */
  async acceptOffer(offerEndpoint: string): Promise<string> {
    // rustdesk's answerer binds the first channel the remote opens; in the
    // browser that arrives through ondatachannel.
    this.pc.ondatachannel = (ev) => {
      const dc = ev.channel;
      if (!dc.ordered || dc.maxRetransmits !== null || dc.maxPacketLifeTime !== null) {
        dc.close();
        return;
      }
      this.bindChannel(dc);
    };
    const { sdp } = decodeEndpoint(offerEndpoint);
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.sessionKeyValue = fingerprintOf(sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return encodeEndpoint('answer', answer.sdp ?? '', false);
  }

  /** Apply the peer's answer (offerer side). */
  async acceptAnswer(answerEndpoint: string): Promise<void> {
    const { sdp } = decodeEndpoint(answerEndpoint);
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  /** Add a trickled remote candidate, tolerating ones that arrive before the remote description. */
  async addRemoteCandidate(candidateJson: string): Promise<void> {
    if (!candidateJson) return;
    let init: RTCIceCandidateInit;
    try {
      init = JSON.parse(candidateJson) as RTCIceCandidateInit;
    } catch {
      return;
    }
    if (!this.pc.remoteDescription) {
      this.pendingRemote.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch {
      // A candidate for a generation that has already moved on; the ICE agent
      // will have others. Not worth tearing the session down over.
    }
  }

  /** Fragment and send one message, matching webrtc.rs send_bytes_inner. */
  send(bytes: Uint8Array): void {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') throw new Error('webrtc channel not open');
    if (bytes.length === 0) {
      // A lone FRAG_END header, so a zero-length message is never emitted as an
      // empty channel message (the peer cannot tell that from EOF).
      dc.send(new Uint8Array([FRAG_END]));
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += MAX_FRAGMENT_PAYLOAD) {
      const end = Math.min(offset + MAX_FRAGMENT_PAYLOAD, bytes.length);
      const last = end >= bytes.length;
      const framed = new Uint8Array(1 + (end - offset));
      framed[0] = last ? FRAG_END : FRAG_MORE;
      framed.set(bytes.subarray(offset, end), 1);
      dc.send(framed);
    }
  }

  buffered(): number {
    return this.dc?.bufferedAmount ?? 0;
  }

  onMessage(cb: (b: Uint8Array) => void): void {
    this.msgCb = cb;
    this.drain();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.dc?.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
  }

  private bindChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => this.onFrame(new Uint8Array(ev.data as ArrayBuffer));
    dc.onopen = () => {
      this.opened = true;
      for (const c of this.pendingRemote.splice(0)) void this.addRemoteCandidate(JSON.stringify(c));
      this.signaling.onOpen();
    };
    dc.onclose = () => this.finish('webrtc data channel closed');
  }

  private onFrame(frame: Uint8Array): void {
    if (frame.length === 0) return;
    const header = frame[0]!;
    const payload = frame.subarray(1);
    if (header !== FRAG_MORE && header !== FRAG_END) {
      this.finish(`webrtc framing violation: unknown fragment header ${header}`);
      return;
    }
    if (payload.length > 0) {
      this.recvAcc.push(payload);
      this.recvLen += payload.length;
      if (this.recvLen > MAX_REASSEMBLED) {
        this.finish('webrtc reassembly buffer overflow');
        return;
      }
    }
    if (header !== FRAG_END) return;
    const whole = new Uint8Array(this.recvLen);
    let at = 0;
    for (const part of this.recvAcc) { whole.set(part, at); at += part.length; }
    this.recvAcc.length = 0;
    this.recvLen = 0;
    if (whole.length > 0) this.msgCb?.(whole);
  }

  private drain(): void {
    // Nothing is buffered before onMessage — frames only start after `open`, by
    // which point the consumer is attached. Kept for symmetry with WsStream.
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    if (!this.opened) this.signaling.onClose(reason);
    else this.signaling.onClose(reason);
  }
}

/**
 * Parse the `ice-servers` option into RTCPeerConnection form.
 *
 * rustdesk splits on commas and accepts `stun:`/`turns:`/`turn://user:pass@host:port`
 * (webrtc.rs get_ice_server_from_url). The bare `stun:host:port` spelling has no
 * place for credentials; the `turn://` form is the only one that carries them.
 * A TURN entry with no credentials is dropped rather than passed through, because
 * an unusable server makes the whole configuration invalid.
 */
export function parseIceServers(cfg: string, fallback: string[]): IceServer[] {
  const out: IceServer[] = [];
  let sawStun = false;
  for (const raw of cfg.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('stun:') || raw.startsWith('stuns:')) {
      out.push({ urls: raw });
      sawStun = true;
      continue;
    }
    if (!raw.startsWith('turn://') && !raw.startsWith('turns://')) continue;
    try {
      const secure = raw.startsWith('turns://');
      const u = new URL(raw);
      if (!u.hostname) continue;
      const username = decodeURIComponent(u.username);
      const credential = decodeURIComponent(u.password);
      if (!username || !credential) continue;
      const port = u.port || '3478';
      out.push({
        urls: `${secure ? 'turns' : 'turn'}:${u.hostname}:${port}`,
        username,
        credential,
      });
    } catch {
      continue;
    }
  }
  // No STUN configured means the defaults are prepended, same as rustdesk: a
  // TURN-only list would otherwise never learn this host's public address.
  if (!sawStun) out.unshift({ urls: fallback });
  return out;
}
