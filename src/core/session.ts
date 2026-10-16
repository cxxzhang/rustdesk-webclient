import type { DisplayInfo, Encryptor, SessionConfig, SessionEvent, SessionState, SessionTransport, WebRtcControl } from './contracts';
import {
  ChatMessage,
  Clipboard,
  ClipboardFormat,
  ControlKey,
  CursorData,
  FileAction,
  FileResponse,
  FileTransferSendConfirmRequest,
  ImageQuality,
  KeyEvent,
  KeyboardMode,
  Message,
  Misc,
  MouseEvent,
  OptionMessage,
  OptionMessage_BoolOption,
  PeerInfo,
  PermissionInfo_Permission,
  SupportedDecoding,
  SupportedDecoding_PreferCodec,
  CaptureDisplays,
  DisplayResolution,
  Resolution,
  SwitchDisplay,
  ToggleVirtualDisplay,
  VideoFrame,
} from '../gen/message';
import { ConnType } from '../gen/rendezvous';
import { StreamCipher, decodeB64 } from './crypto';
import { buildPublicKeyMessage, verifyPeerSignedId, verifyServerRelayPk } from './handshake';
import { buildLoginRequest, computeLoginH1, loginHashFromH1 } from './auth';
import { buildIceCandidate, buildPunchHoleRequest, parseRendezvous } from './signaling';
import { buildRequestRelay } from './relay';
import {
  buildBlockInputOption,
  buildDirectElevation,
  buildLockAfterSessionEndOption,
  buildPrivacyToggle,
  buildRestartRemoteDevice,
  parsePrivacyModeImpls,
} from './session-controls';
import { parseAdvancedPeerCapabilities } from './advanced-capabilities';

export const CLIENT_VERSION = '1.4.0';

// Per-frame flow control. With ack ON, the host sends one frame and waits for
// our video_received before capturing the next — this can never flood the
// browser's decode queue (stable), at the cost of ~1 frame per relay RTT.
// Free-run (ack OFF) is smoother but needs decode-queue backpressure to avoid
// wedging the renderer on a high-bitrate stream; until that's in, keep this ON.
export const VIDEO_ACK_REQUIRED = true;
// Drop real-time voice frames before the relay queue can grow without bound.
export const VOICE_RELAY_BUFFER_LIMIT = 128 * 1024;

export interface SessionSinks {
  sendSignaling(bytes: Uint8Array): void;
  sendRelay(bytes: Uint8Array): void;
  relayBuffered(): number;
  emit(ev: SessionEvent): void;
  onVideo(frame: VideoFrame): void;
  onAudioFormat(sampleRate: number, channels: number): void;
  onAudioFrame(data: Uint8Array): void;
  openRelay(relayServer: string): void;
  closeAll(): void;
  onCursor?(cursor: CursorData): void;
  onCursorId?(id: bigint): void;
  onClipboard?(clipboard: Clipboard): void; // compressed or non-text payloads the worker must decode
  onFileResponse?(fr: FileResponse): void; // file-transfer connections: dir/block/digest/done/error
  onFileSendConfirm?(c: FileTransferSendConfirmRequest): void; // upload go-ahead from the peer
}

const utf8Enc = new TextEncoder();
const utf8Dec = new TextDecoder();

/**
 * How long a relay handshake is held back while the direct channel finishes connecting.
 *
 * Only ever waited out when the peer already answered with SDP, so a peer without WebRTC is not
 * delayed at all. Covers the peer's ICE gathering and DTLS handshake, which run alongside the
 * relay's, and which lose that race routinely on a local network.
 */
const WEBRTC_HANDSHAKE_GRACE_MS = 4000;

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function randomSessionId(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  b[0]! &= 0x7f; // keep below 2^63: safe for both int64 and uint64 writers
  return new DataView(b.buffer).getBigUint64(0);
}

// Core baseline: VP9/VP8 only. Codec probing (h264/h265/av1, i444) is layered
// on by the worker via its own SupportedDecoding once WebCodecs support is known.
function baselineDecoding(): SupportedDecoding {
  return SupportedDecoding.fromPartial({
    ability_vp9: 1,
    ability_vp8: 1,
    prefer: SupportedDecoding_PreferCodec.Auto,
  });
}

// Replies that mean "a person on the remote side has to click Accept", not
// "your credentials were refused". "No Password Access" is what a peer in
// click-to-approve mode sends to clients 1.2.0+ right after it has opened its
// accept prompt (issue #98); treating it as a failure tore the socket down and
// took the prompt with it.
const NO_PASSWORD_ACCESS = 'No Password Access';

function isManualAccept(error: string): boolean {
  if (error === NO_PASSWORD_ACCESS) return true;
  const e = error.toLowerCase();
  return e.includes('wait') && e.includes('accept');
}

export class Session {
  /** Display index we asked for and have not had confirmed yet; null when settled. */
  private pendingDisplay: number | null = null;

  private readonly config: SessionConfig;
  private readonly sinks: SessionSinks;
  private readonly serverEdPk: Uint8Array;
  private readonly sessionId: bigint;
  private state: SessionState = 'connecting';
  private cipher: Encryptor | undefined;
  private peerEdPk: Uint8Array | undefined;
  private uuid = '';
  private decoding: SupportedDecoding = baselineDecoding();
  private loginSent = false;
  /** Only an exact response to this controller-generated timestamp can start capture. */
  private pendingVoiceCallTimestamp: bigint | null = null;
  private voiceCallAccepted = false;

  constructor(config: SessionConfig, sinks: SessionSinks) {
    this.config = config;
    this.sinks = sinks;
    this.serverEdPk = decodeB64(config.serverKeyB64);
    this.sessionId = randomSessionId();
  }

  get currentState(): SessionState {
    return this.state;
  }

  private get connType(): ConnType {
    switch (this.config.connType) {
      case 'fileTransfer': return ConnType.FILE_TRANSFER;
      case 'viewCamera': return ConnType.VIEW_CAMERA;
      case 'terminal': return ConnType.TERMINAL;
      default: return ConnType.DEFAULT_CONN;
    }
  }

  start(): void {
    // The WebRTC offer has to be inside the punch request, so it is built first
    // and the request goes out from the callback. If the offer cannot be built
    // at all we still punch — the relay path never depended on WebRTC.
    const webrtc = this.config.webrtc;
    if (webrtc) {
      // Held until the answer arrives: until then nothing may be sent on the
      // data channel, because the peer has not applied our offer yet.
      this.pendingWebrtc = webrtc;
      webrtc.onLocalCandidate((c) => this.sendLocalCandidate(c));
      webrtc.createOffer()
        .then((offer) => {
          this.webrtcSessionKey = webrtc.sessionKey();
          this.punch(offer);
        })
        .catch(() => {
          this.pendingWebrtc = undefined;
          this.punch();
        });
      return;
    }
    this.punch();
  }

  /**
   * Forward one locally-gathered ICE candidate to the peer.
   *
   * Only once we know the session key: candidates gathered before the offer's
   * fingerprint exists cannot be tagged for routing and would be dropped by the
   * peer anyway. `id` (not socket_addr) is the routing field for a controller —
   * the server relays to that peer's registered connection (see
   * buildIceCandidate).
   */
  private sendLocalCandidate(candidateJson: string): void {
    if (!this.webrtcSessionKey) return;
    this.sinks.sendSignaling(
      buildIceCandidate({
        sessionKey: this.webrtcSessionKey,
        candidate: candidateJson,
        toPeerId: this.config.peerId,
      }),
    );
  }

  /** The adopted data channel, once the peer's answer has been applied. */
  private webrtc: WebRtcControl | undefined;
  private webrtcSessionKey = '';
  /**
   * Where the peer's identity handshake landed — the one channel the session runs on. Unset
   * until it completes; see `onFirstFrame`. The two transports to the same peer are separate
   * connections with separate keys, so this is not a preference, it is the only viable choice.
   */
  private transport: 'relay' | 'webrtc' | undefined;

  private punch(webrtcSdpOffer?: string): void {
    this.sinks.sendSignaling(
      buildPunchHoleRequest({
        peerId: this.config.peerId,
        licenceKey: this.config.serverKeyB64,
        version: CLIENT_VERSION,
        connType: this.connType,
        token: this.config.signalToken,
        webrtcSdpOffer,
      }),
    );
    this.setState('rendezvous');
  }

  /** Inbound frames from the data channel — same plaintext path as relay bytes. */
  private async onWebrtcBytes(b: Uint8Array): Promise<void> {
    if (this.state === 'error' || this.state === 'closed') return;
    if (!this.cipher) {
      this.onFirstFrame(b, 'webrtc');
      return;
    }
    // The handshake completed on the other transport: this channel was the loser of the race
    // and the session does not run on it.
    if (this.transport !== 'webrtc') return;
    // No secretbox layer here. A WebRTC stream is DTLS-encrypted and rustdesk drops the stream
    // key on it (`WebRTCStream::set_key`: "the secretbox key is unused"), so what crosses the
    // data channel is plain protobuf. See `sealSend`.
    let msg: Message;
    try {
      msg = Message.decode(b);
    } catch {
      this.fail('malformed message');
      return;
    }
    await this.dispatch(msg);
  }

  /**
   * Apply an SDP answer delivered with a rendezvous response.
   *
   * Absent or unusable, the session simply stays on the relay — the controlled
   * peer declining WebRTC is routine, not an error.
   */
  private async tryAdoptAnswer(answer: string | undefined): Promise<void> {
    const pending = this.pendingWebrtc;
    if (!pending || !answer) return;
    this.pendingWebrtc = undefined;
    try {
      await pending.acceptAnswer(answer);
    } catch {
      // Malformed answer, or one we cannot apply: the relay still carries the
      // session, which is the same outcome as the peer declining.
      pending.close();
      return;
    }
    this.webrtc = pending;
    this.webrtcSessionKey = pending.sessionKey();
    pending.onMessage((b) => void this.onWebrtcBytes(b));
    // Losing the data channel only ends the session if it is the one carrying it. Before the
    // handshake it is not yet known to; after, the relay is the one that does not matter.
    pending.onClose((reason) => {
      if (this.transport === 'webrtc') this.fail(`webrtc transport lost: ${reason}`);
    });
    // The transport event is not emitted here: the answer only means ICE may connect. Which
    // channel the session ends up on is decided by `onFirstFrame`.
  }

  /** The offer built but not yet answered; adopted only once the answer lands. */
  private pendingWebrtc: WebRtcControl | undefined;

  onSignalingBytes(b: Uint8Array): void {
    if (this.state === 'error' || this.state === 'closed') return;
    let parsed;
    try {
      parsed = parseRendezvous(b);
    } catch {
      this.fail('malformed rendezvous message');
      return;
    }
    switch (parsed.kind) {
      case 'relayResponse': {
        if (!parsed.pk || parsed.pk.length === 0) {
          this.fail('relay response missing server-signed pk');
          return;
        }
        try {
          this.peerEdPk = verifyServerRelayPk(parsed.pk, this.serverEdPk, this.config.peerId);
        } catch (e) {
          this.fail(`server trust link failed: ${(e as Error).message}`);
          return;
        }
        this.uuid = parsed.uuid;
        // The relay is opened regardless: it carries the handshake and the
        // session whenever WebRTC is declined, fails, or simply loses the race.
        this.sinks.openRelay(parsed.relayServer);
        void this.tryAdoptAnswer(parsed.webrtcSdpAnswer);
        this.setState('relay');
        return;
      }
      case 'punchHoleResponse':
        // The server's own text when it sends one: it says why (e.g. not approved).
        if (parsed.failure) {
          this.fail(parsed.message || `punch hole failed: ${parsed.failure}`);
          return;
        }
        void this.tryAdoptAnswer(parsed.webrtcSdpAnswer);
        return;
      case 'iceCandidate':
        // Trickled candidate for our own session. A candidate for another
        // session's fingerprint is not ours to apply.
        if (this.pendingWebrtc && parsed.sessionKey === this.webrtcSessionKey) {
          this.pendingWebrtc.addRemoteCandidate(parsed.candidate);
        } else if (this.webrtc && parsed.sessionKey === this.webrtcSessionKey) {
          this.webrtc.addRemoteCandidate(parsed.candidate);
        }
        return;
      default:
        return;
    }
  }

  relayOpened(): void {
    this.sinks.sendRelay(
      buildRequestRelay({
        licenceKey: this.config.serverKeyB64,
        peerId: this.config.peerId,
        uuid: this.uuid,
        connType: this.connType,
      }),
    );
    this.setState('handshake');
  }

  async onRelayBytes(b: Uint8Array): Promise<void> {
    if (this.state === 'error' || this.state === 'closed') return;
    if (!this.cipher) {
      this.onFirstFrame(b, 'relay');
      return;
    }
    // The handshake completed on the other transport: this channel was the loser of the race
    // and the session does not run on it.
    if (this.transport !== 'relay') return;
    let pt: Uint8Array;
    try {
      pt = this.cipher.open(b);
    } catch {
      this.fail('decrypt failed');
      return;
    }
    let msg: Message;
    try {
      msg = Message.decode(pt);
    } catch {
      this.fail('malformed message');
      return;
    }
    await this.dispatch(msg);
  }

  /**
   * Whichever transport the peer's identity handshake arrives on becomes the one the session
   * runs on, and every frame after it must travel that same way.
   *
   * The peer builds a fresh box keypair per connection and seals the stream key to it, so a
   * `PublicKey` sent back over the other transport cannot be opened (the failure reads as
   * `Handshake failed: box decryption failure` on the peer). A forced-relay controller has both
   * open at once — hbbr holds the relay session that carries the handshake while the answer puts
   * ICE in flight — so this is the normal case, not a corner one.
   */
  private onFirstFrame(b: Uint8Array, on: SessionTransport): void {
    let msg: Message;
    try {
      msg = Message.decode(b);
    } catch {
      this.fail('malformed handshake message');
      return;
    }
    if (msg.union?.$case !== 'signed_id') {
      this.fail(`expected signed_id, got ${msg.union?.$case ?? 'empty message'}`);
      return;
    }
    if (!this.peerEdPk) {
      this.fail('signed_id before relay response');
      return;
    }
    let id: string;
    let boxPk: Uint8Array;
    try {
      ({ id, boxPk } = verifyPeerSignedId(msg.union.signed_id.id, this.peerEdPk));
    } catch {
      this.fail('peer trust link failed: bad SignedId signature');
      return;
    }
    if (id.split('\0')[0] !== this.config.peerId) {
      this.fail(`peer id mismatch in SignedId: got "${id}"`);
      return;
    }
    const { bytes, key } = buildPublicKeyMessage(boxPk);
    if (on === 'relay' && (this.webrtc || this.pendingWebrtc)) {
      // An offer is out, so a direct channel is worth waiting for: the relay is ready long before
      // ICE finishes, so answering here would make essentially every session relayed even when a
      // direct pair is available. The test is on the offer rather than on the answer, because the
      // two handshakes race — the relay's often arrives while the answer is still in flight.
      // If the data channel opens it handshakes instead and the relay reply is never sent; the
      // peer is still waiting on it, so nothing is lost. A peer that never answers falls back
      // below once `WEBRTC_HANDSHAKE_GRACE_MS` expires.
      this.pendingRelayKey = {
        bytes,
        key,
        timer: setTimeout(() => this.adoptRelayHandshake(), WEBRTC_HANDSHAKE_GRACE_MS),
      };
      return;
    }
    this.transport = on;
    this.sendTransport(bytes);
    this.cipher = new StreamCipher(key);
    if (on === 'webrtc') {
      // The direct channel won the race; a relay reply held for it is now moot.
      this.dropPendingRelayKey();
      this.sinks.emit({ t: 'transport', kind: 'webrtc' });
    }
  }

  /**
   * The relay handshake reply, held while the direct channel is given its chance. Once adopted,
   * this session runs on the relay for good — the peer's relay keypair is spent on it.
   */
  private pendingRelayKey: { bytes: Uint8Array; key: Uint8Array; timer: ReturnType<typeof setTimeout> } | undefined;

  private adoptRelayHandshake(): void {
    const p = this.pendingRelayKey;
    if (!p) return;
    this.pendingRelayKey = undefined;
    if (this.state === 'error' || this.state === 'closed') return;
    this.transport = 'relay';
    this.sinks.sendRelay(p.bytes);
    this.cipher = new StreamCipher(p.key);
  }

  private dropPendingRelayKey(): void {
    const p = this.pendingRelayKey;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingRelayKey = undefined;
  }

  private async dispatch(msg: Message): Promise<void> {
    const u = msg.union;
    switch (u?.$case) {
      case 'test_delay':
        // Echo verbatim, immediately — the peer measures RTT from this.
        if (!u.test_delay.from_client) {
          this.sealSend(
            Message.encode({ union: { $case: 'test_delay', test_delay: u.test_delay } }).finish(),
          );
        }
        return;
      case 'hash': {
        this.setState('login');
        let passwordHash: Uint8Array;
        const plaintextPassword = this.config.password;
        this.config.password = '';
        if (this.config.savedHashHex) {
          // Reuse a remembered h1 (SHA256(pw||salt)) — no plaintext needed.
          passwordHash = await loginHashFromH1(hexToBytes(this.config.savedHashHex), u.hash.challenge);
        } else if (plaintextPassword.length > 0) {
          const h1 = await computeLoginH1(plaintextPassword, u.hash.salt);
          this.sinks.emit({ t: 'credentials', hashHex: bytesToHex(h1) });
          passwordHash = await loginHashFromH1(h1, u.hash.challenge);
        } else {
          passwordHash = new Uint8Array(0); // empty password -> interactive accept
        }
        // A remembered codec preference rides in the login's decoding block,
        // the same place a live choice goes before login (issue #92).
        const remembered = this.config.initialOptions?.preferCodec;
        if (remembered !== undefined) {
          const preferred = this.decodingWithPreference(remembered);
          if (preferred) this.decoding = preferred;
        }
        this.loginSent = true;
        // An empty password is a request to be let in by hand: the remote
        // opens its accept prompt and, in password-or-click mode, says
        // nothing until the person answers. Enter needAccept now so the UI
        // says so and the connect watchdog stands down (issue #98).
        const manualAccept = passwordHash.length === 0;
        this.sealSend(
          buildLoginRequest({
            peerId: this.config.peerId,
            passwordHash,
            myId: this.config.myId,
            myName: this.config.myName,
            sessionId: this.sessionId,
            version: CLIENT_VERSION,
            supportedDecoding: this.decoding,
            videoAckRequired: VIDEO_ACK_REQUIRED,
            fileTransfer:
              this.config.connType === 'fileTransfer' ? { dir: '', showHidden: false } : undefined,
            viewCamera: this.config.connType === 'viewCamera',
            terminal: this.config.connType === 'terminal'
              ? {
                  serviceId: this.config.terminalServiceId ?? '',
                  persistent: this.config.terminalPersistent ?? false,
                }
              : undefined,
            initialOptions: this.config.initialOptions,
          }),
        );
        if (manualAccept) this.setState('needAccept', 'Waiting for the remote user to accept');
        return;
      }
      case 'login_response': {
        const lr = u.login_response.union;
        if (lr?.$case === 'error') {
          if (isManualAccept(lr.error)) this.setState('needAccept', lr.error);
          else this.sinks.emit({ t: 'loginError', message: lr.error });
          return;
        }
        if (lr?.$case === 'peer_info') {
          this.emitPeerInfo(lr.peer_info);
          this.setState('streaming');
        }
        return;
      }
      case 'peer_info': // mid-session display-list change
        this.emitPeerInfo(u.peer_info);
        return;
      case 'video_frame':
        this.sinks.onVideo(u.video_frame);
        if (VIDEO_ACK_REQUIRED) {
          this.sendMisc({ $case: 'video_received', video_received: true });
        }
        return;
      case 'audio_frame':
        this.sinks.onAudioFrame(u.audio_frame.data);
        return;
      case 'cursor_data':
        this.sinks.onCursor?.(u.cursor_data);
        return;
      case 'cursor_id':
        this.sinks.onCursorId?.(u.cursor_id);
        return;
      case 'cursor_position':
        this.sinks.emit({ t: 'cursorPos', x: u.cursor_position.x, y: u.cursor_position.y });
        return;
      case 'clipboard':
        this.handleClipboard(u.clipboard);
        return;
      case 'multi_clipboards':
        for (const cb of u.multi_clipboards.clipboards) this.handleClipboard(cb);
        return;
      case 'file_response':
        this.sinks.onFileResponse?.(u.file_response);
        return;
      case 'file_action':
        // The one FileAction that flows peer -> controller: send_confirm for a
        // file we are uploading whose target did not need an overwrite prompt.
        if (u.file_action.union?.$case === 'send_confirm') {
          this.sinks.onFileSendConfirm?.(u.file_action.union.send_confirm);
        }
        return;
      case 'terminal_response': {
        const response = u.terminal_response.union;
        switch (response?.$case) {
          case 'opened':
            this.sinks.emit({
              t: 'terminalOpened',
              terminalId: response.opened.terminal_id,
              success: response.opened.success,
              message: response.opened.message,
              pid: response.opened.pid,
              serviceId: response.opened.service_id,
              persistentSessions: response.opened.persistent_sessions,
              replayTerminalOutput: response.opened.replay_terminal_output,
            });
            break;
          case 'data':
            this.sinks.emit({
              t: 'terminalData',
              terminalId: response.data.terminal_id,
              data: response.data.data,
              compressed: response.data.compressed,
            });
            break;
          case 'closed':
            this.sinks.emit({
              t: 'terminalClosed',
              terminalId: response.closed.terminal_id,
              exitCode: response.closed.exit_code,
            });
            break;
          case 'error':
            this.sinks.emit({
              t: 'terminalError',
              terminalId: response.error.terminal_id,
              message: response.error.message,
            });
            break;
        }
        return;
      }
      case 'misc':
        this.dispatchMisc(u.misc.union);
        return;
      case 'message_box':
        this.sinks.emit({
          t: 'msgbox',
          msgtype: u.message_box.msgtype,
          title: u.message_box.title,
          text: u.message_box.text,
          link: u.message_box.link,
        });
        return;
      case 'voice_call_request': {
        // RustDesk's controlling side does not accept incoming connect calls.
        // A remote hang-up is the sole inbound voice request we act upon.
        const hadCall = this.pendingVoiceCallTimestamp !== null || this.voiceCallAccepted;
        if (!u.voice_call_request.is_connect && hadCall) {
          this.pendingVoiceCallTimestamp = null;
          this.voiceCallAccepted = false;
          this.sinks.emit({ t: 'voiceCall', state: 'closed', detail: 'Remote user ended the call' });
        }
        return;
      }
      case 'voice_call_response': {
        // Match RustDesk's replay/attack boundary: consume the outstanding
        // request on the first response, even when its timestamp is wrong.
        const pending = this.pendingVoiceCallTimestamp;
        this.pendingVoiceCallTimestamp = null;
        if (pending === null) return;
        if (u.voice_call_response.req_timestamp !== pending) {
          this.sinks.emit({
            t: 'voiceCall',
            state: 'closed',
            detail: 'Voice call response could not be verified',
          });
          return;
        }
        this.voiceCallAccepted = u.voice_call_response.accepted;
        this.sinks.emit({ t: 'voiceCall', state: u.voice_call_response.accepted ? 'accepted' : 'rejected' });
        return;
      }
      default:
        return; // TODO: file_*, switch_sides — out of scope for core
    }
  }

  private dispatchMisc(u: Misc['union']): void {
    switch (u?.$case) {
      case 'chat_message':
        // Chat is a Misc member, not a top-level Message — same channel as
        // switch_display and refresh_video. Empty texts are keepalive noise.
        if (u.chat_message.text) this.sinks.emit({ t: 'chat', text: u.chat_message.text });
        return;
      case 'permission_info':
        this.sinks.emit({
          t: 'permission',
          kind: PermissionInfo_Permission[u.permission_info.permission] ?? String(u.permission_info.permission),
          enabled: u.permission_info.enabled,
        });
        return;
      case 'audio_format':
        this.sinks.onAudioFormat(u.audio_format.sample_rate, u.audio_format.channels);
        return;
      case 'back_notification': {
        const n = u.back_notification;
        if (n.union?.$case === 'privacy_mode_state') {
          this.sinks.emit({
            t: 'privacyMode',
            state: n.union.privacy_mode_state,
            details: n.details,
            implKey: n.impl_key,
          });
        } else if (n.union?.$case === 'block_input_state') {
          this.sinks.emit({
            t: 'blockInput',
            state: n.union.block_input_state,
            details: n.details,
          });
        }
        return;
      }
      case 'elevation_response':
        this.sinks.emit({
          t: 'elevation',
          state: u.elevation_response ? 'failed' : 'pending',
          detail: u.elevation_response,
        });
        return;
      case 'portable_service_running':
        if (u.portable_service_running) {
          this.sinks.emit({ t: 'elevation', state: 'succeeded', detail: '' });
        }
        return;
      case 'close_reason':
        this.setState('closed', u.close_reason, true);
        this.sinks.closeAll();
        return;
      case 'uac':
        // Remote UAC prompt opened/closed. The host's capture pipeline restarts
        // around the secure-desktop switch; the worker kicks the video stream.
        this.sinks.emit({ t: 'uac', on: u.uac });
        return;
      case 'switch_display': {
        // The host's confirmation of which display it is now capturing, and
        // where that display sits in the virtual desktop. Dropping this was a
        // real bug: input coordinates are absolute virtual-desktop positions,
        // so the origin here is what decides which monitor a click lands on.
        const s = u.switch_display;
        // Pruning the capture set (see switchDisplay) stops the old display's
        // service broadcasting, but not instantly: its snapshot can already be
        // in flight when our CaptureDisplays arrives. Until the host confirms
        // the display we actually asked for, a message about a different one is
        // that stale broadcast, and following it is what put input back on the
        // monitor we had just left.
        if (this.pendingDisplay !== null && s.display !== this.pendingDisplay) return;
        this.pendingDisplay = null;
        this.sinks.emit({
          t: 'switchDisplay',
          index: s.display,
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
          cursorEmbedded: s.cursor_embedded,
          originalResolution: s.original_resolution
            ? { width: s.original_resolution.width, height: s.original_resolution.height }
            : undefined,
          resolutions: (s.resolutions?.resolutions ?? []).map((r) => ({ width: r.width, height: r.height })),
        });
        return;
      }
      case 'follow_current_display':
        if (Number.isSafeInteger(u.follow_current_display) && u.follow_current_display >= 0) {
          this.sinks.emit({ t: 'followDisplay', index: u.follow_current_display });
        }
        return;
      default:
        return; // TODO: back_notification, supported_encoding, ...
    }
  }

  private handleClipboard(cb: Clipboard): void {
    if (!cb.compress && cb.format === ClipboardFormat.Text) {
      this.sinks.emit({ t: 'clipboard', text: utf8Dec.decode(cb.content) });
      return;
    }
    this.sinks.onClipboard?.(cb); // zstd / non-text: worker's job
  }

  private emitPeerInfo(pi: PeerInfo): void {
    const advanced = parseAdvancedPeerCapabilities(pi.platform_additions);
    const resolutions = (pi.resolutions?.resolutions ?? []).map((r) => ({ width: r.width, height: r.height }));
    const displays: DisplayInfo[] = pi.displays.map((d, index) => ({
      index,
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
      name: d.name,
      scale: d.scale || 1,
      online: d.online,
      cursorEmbedded: d.cursor_embedded,
      originalResolution: d.original_resolution
        ? { width: d.original_resolution.width, height: d.original_resolution.height }
        : undefined,
      resolutions: index === pi.current_display ? resolutions : [],
    }));
    this.sinks.emit({
      t: 'peerInfo',
      displays,
      username: pi.username,
      hostname: pi.hostname,
      platform: pi.platform,
      platformAdditions: pi.platform_additions,
      version: pi.version,
      ...(this.state === 'streaming' ? {} : { current: pi.current_display }),
      privacyModeSupported: pi.features?.privacy_mode ?? false,
      privacyModeImpls: parsePrivacyModeImpls(pi.platform_additions),
      terminalSupported: pi.features?.terminal ?? false,
      viewCameraSupported: advanced.viewCamera,
    });
  }

  // Replaces the VP9/VP8 baseline with the worker's real WebCodecs probe.
  // Before the Hash arrives the override rides inside the LoginRequest; after
  // login it is re-advertised via Misc{option.supported_decoding} (e.g. when
  // the video pipeline disables a codec that fails to decode).
  setSupportedDecoding(sd: SupportedDecoding): void {
    this.decoding = sd;
    if (this.loginSent) {
      this.sendMisc({
        $case: 'option',
        option: OptionMessage.fromPartial({ supported_decoding: sd }),
      });
    }
  }

  // ---- outbound controls (post-handshake; silently dropped before cipher) ----

  sendMouse(mask: number, x: number, y: number, modifiers: number[]): void {
    this.sendMessage({
      $case: 'mouse_event',
      mouse_event: MouseEvent.fromPartial({ mask, x, y, modifiers: modifiers as ControlKey[] }),
    });
  }

  sendKey(
    down: boolean,
    press: boolean,
    keyKind: 'chr' | 'control' | 'unicode',
    value: number,
    modifiers: number[],
  ): void {
    const union: KeyEvent['union'] =
      keyKind === 'chr'
        ? { $case: 'chr', chr: value }
        : keyKind === 'unicode'
          ? { $case: 'unicode', unicode: value }
          : { $case: 'control_key', control_key: value as ControlKey };
    this.sendMessage({
      $case: 'key_event',
      key_event: KeyEvent.fromPartial({
        down,
        press,
        union,
        modifiers: modifiers as ControlKey[],
        mode: KeyboardMode.Legacy,
      }),
    });
  }

  switchDisplay(index: number): void {
    // While this is outstanding, a switch_display naming a DIFFERENT display is
    // a stale broadcast rather than news — see dispatchMisc.
    this.pendingDisplay = index;
    this.sendMisc({ $case: 'switch_display', switch_display: SwitchDisplay.fromPartial({ display: index }) });
    // Prune the capture set, or the host keeps us subscribed to the old
    // display's video service. connection.rs switch_display_to only
    // unsubscribes the old service for clients BELOW 1.2.4:
    //
    //   // For versions greater than 1.2.4, a `CaptureDisplays` message will
    //   // be sent immediately. Unnecessary capturers will be removed then.
    //
    // We advertise 1.4.0, so the host waits for this message and we never sent
    // one. The old service kept broadcasting at us and replayed its stored
    // snapshot — a switch_display for the display we had just left, which put
    // our display index back and sent every subsequent click to the wrong
    // monitor. It was also still encoding a display nobody was watching.
    this.sendMisc({
      $case: 'capture_displays',
      capture_displays: CaptureDisplays.fromPartial({ set: [index] }),
    });
  }

  changeDisplayResolution(display: number, width: number, height: number): boolean {
    if (
      !Number.isSafeInteger(display) || display < 0 ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 16384 || height > 16384
    ) {
      return false;
    }
    this.sendMisc({
      $case: 'change_display_resolution',
      change_display_resolution: DisplayResolution.fromPartial({
        display,
        resolution: Resolution.fromPartial({ width, height }),
      }),
    });
    return true;
  }

  toggleVirtualDisplay(display: number, on: boolean): boolean {
    if (!Number.isSafeInteger(display) || display < -1) return false;
    this.sendMisc({
      $case: 'toggle_virtual_display',
      toggle_virtual_display: ToggleVirtualDisplay.fromPartial({ display, on }),
    });
    return true;
  }

  ctrlAltDel(): void {
    this.sendMessage({
      $case: 'key_event',
      key_event: KeyEvent.fromPartial({
        down: false,
        press: true,
        union: { $case: 'control_key', control_key: ControlKey.CtrlAltDel },
        mode: KeyboardMode.Legacy,
      }),
    });
  }

  refresh(): void {
    this.sendMisc({ $case: 'refresh_video', refresh_video: true });
  }

  setQuality(imageQuality: number): void {
    this.sendMisc({
      $case: 'option',
      option: OptionMessage.fromPartial({ image_quality: imageQuality as ImageQuality }),
    });
  }

  restartRemoteDevice(): void {
    this.sendMisc(buildRestartRemoteDevice());
  }

  requestElevation(): void {
    this.sendMisc(buildDirectElevation());
  }

  setPrivacyMode(implKey: string, on: boolean): void {
    this.sendMisc(buildPrivacyToggle(implKey, on));
  }

  setBlockInput(on: boolean): void {
    this.sendMisc({ $case: 'option', option: buildBlockInputOption(on) });
  }

  setLockAfterSessionEnd(on: boolean): void {
    this.sendMisc({ $case: 'option', option: buildLockAfterSessionEndOption(on) });
  }

  setCustomQuality(quality: number): boolean {
    if (!Number.isSafeInteger(quality) || quality < 10 || quality > 100) return false;
    this.sendMisc({
      $case: 'option',
      option: OptionMessage.fromPartial({ custom_image_quality: quality << 8 }),
    });
    return true;
  }

  setCustomFps(fps: number): boolean {
    if (!Number.isSafeInteger(fps) || fps < 5 || fps > 120) return false;
    this.sendMisc({
      $case: 'option',
      option: OptionMessage.fromPartial({ custom_fps: fps }),
    });
    return true;
  }

  setDisplayOption(
    option: 'showRemoteCursor' | 'followRemoteCursor' | 'followRemoteWindow',
    enabled: boolean,
  ): void {
    const value = enabled ? OptionMessage_BoolOption.Yes : OptionMessage_BoolOption.No;
    const partial = option === 'showRemoteCursor'
      ? { show_remote_cursor: value }
      : option === 'followRemoteCursor'
        ? { follow_remote_cursor: value }
        : { follow_remote_window: value };
    this.sendMisc({ $case: 'option', option: OptionMessage.fromPartial(partial) });
  }

  setPreferredCodec(prefer: SupportedDecoding_PreferCodec): boolean {
    const sd = this.decodingWithPreference(prefer);
    if (!sd) return false;
    this.setSupportedDecoding(sd);
    return true;
  }

  /** The current decoding block with `prefer` set, or null when we cannot decode it. */
  private decodingWithPreference(prefer: SupportedDecoding_PreferCodec): SupportedDecoding | null {
    const supported = prefer === SupportedDecoding_PreferCodec.Auto ||
      (prefer === SupportedDecoding_PreferCodec.VP9 && this.decoding.ability_vp9 > 0) ||
      (prefer === SupportedDecoding_PreferCodec.H264 && this.decoding.ability_h264 > 0) ||
      (prefer === SupportedDecoding_PreferCodec.H265 && this.decoding.ability_h265 > 0) ||
      (prefer === SupportedDecoding_PreferCodec.VP8 && this.decoding.ability_vp8 > 0) ||
      (prefer === SupportedDecoding_PreferCodec.AV1 && this.decoding.ability_av1 > 0);
    return supported ? SupportedDecoding.fromPartial({ ...this.decoding, prefer }) : null;
  }

  setRemoteAudioEnabled(enabled: boolean): void {
    this.sendMisc({
      $case: 'option',
      option: OptionMessage.fromPartial({
        disable_audio: enabled ? OptionMessage_BoolOption.No : OptionMessage_BoolOption.Yes,
      }),
    });
  }

  setClipboardEnabled(enabled: boolean): void {
    this.sendMisc({
      $case: 'option',
      option: OptionMessage.fromPartial({
        disable_clipboard: enabled ? OptionMessage_BoolOption.No : OptionMessage_BoolOption.Yes,
      }),
    });
  }

  setClientRecording(recording: boolean): void {
    this.sendMisc({ $case: 'client_record_status', client_record_status: recording });
  }

  sendClipboardText(text: string): void {
    this.sendMessage({
      $case: 'clipboard',
      clipboard: Clipboard.fromPartial({
        compress: false,
        content: utf8Enc.encode(text),
        format: ClipboardFormat.Text,
      }),
    });
  }

  sendChat(text: string): void {
    // ChatMessage.text is plain UTF-8; protobuf handles the encoding. There is
    // no per-message id or ack in the protocol, so the UI echoes what it sent
    // rather than waiting for confirmation.
    this.sendMisc({ $case: 'chat_message', chat_message: ChatMessage.fromPartial({ text }) });
  }

  startVoiceCall(): void {
    if (this.pendingVoiceCallTimestamp !== null) return;
    // Milliseconds since epoch is a positive signed 64-bit value through 2262.
    const reqTimestamp = BigInt(Math.max(1, Date.now()));
    this.pendingVoiceCallTimestamp = reqTimestamp;
    this.sendMessage({
      $case: 'voice_call_request',
      voice_call_request: { is_connect: true, req_timestamp: reqTimestamp },
    });
    this.sinks.emit({ t: 'voiceCall', state: 'waiting' });
  }

  closeVoiceCall(): void {
    this.pendingVoiceCallTimestamp = null;
    this.voiceCallAccepted = false;
    const reqTimestamp = BigInt(Math.max(1, Date.now()));
    this.sendMessage({
      $case: 'voice_call_request',
      voice_call_request: { is_connect: false, req_timestamp: reqTimestamp },
    });
    this.sinks.emit({ t: 'voiceCall', state: 'closed' });
  }

  sendVoiceAudioFormat(sampleRate: number, channels: number): void {
    if (!this.voiceCallAccepted) return;
    this.sendMisc({ $case: 'audio_format', audio_format: { sample_rate: sampleRate, channels } });
  }

  sendVoiceAudioFrame(data: Uint8Array): void {
    if (!this.voiceCallAccepted) return;
    if (this.sinks.relayBuffered() >= VOICE_RELAY_BUFFER_LIMIT) return;
    this.sendMessage({ $case: 'audio_frame', audio_frame: { data } });
  }

  openTerminal(terminalId: number, rows: number, cols: number): void {
    this.sendMessage({
      $case: 'terminal_action',
      terminal_action: { union: { $case: 'open', open: { terminal_id: terminalId, rows, cols } } },
    });
  }

  sendTerminalData(terminalId: number, data: Uint8Array): void {
    this.sendMessage({
      $case: 'terminal_action',
      terminal_action: {
        union: { $case: 'data', data: { terminal_id: terminalId, data, compressed: false } },
      },
    });
  }

  resizeTerminal(terminalId: number, rows: number, cols: number): void {
    this.sendMessage({
      $case: 'terminal_action',
      terminal_action: { union: { $case: 'resize', resize: { terminal_id: terminalId, rows, cols } } },
    });
  }

  closeTerminal(terminalId: number): void {
    this.sendMessage({
      $case: 'terminal_action',
      terminal_action: { union: { $case: 'close', close: { terminal_id: terminalId } } },
    });
  }

  // File-transfer connections: outbound FileAction (requests and upload control),
  // and FileResponse for the payload we send when uploading (blocks/done/error
  // always travel as file_response regardless of direction).
  sendFileAction(union: NonNullable<FileAction['union']>): void {
    this.sendMessage({ $case: 'file_action', file_action: { union } });
  }

  sendFileResponse(union: NonNullable<FileResponse['union']>): void {
    this.sendMessage({ $case: 'file_response', file_response: { union } });
  }

  disconnect(): void {
    if (this.state !== 'closed') this.setState('closed');
    this.sinks.closeAll();
  }

  // ---- internals ----

  private sendMessage(union: NonNullable<Message['union']>): void {
    if (!this.cipher) return;
    this.sealSend(Message.encode({ union }).finish());
  }

  private sendMisc(union: NonNullable<Misc['union']>): void {
    this.sendMessage({ $case: 'misc', misc: { union } });
  }

  private sealSend(bytes: Uint8Array): void {
    if (!this.cipher || !this.transport) return;
    // The data channel carries plaintext: DTLS is the transport encryption, and the peer does not
    // run a secretbox layer on WebRTC (see `onWebrtcBytes`). The relay, a plain TCP/WebSocket
    // stream, is the one that needs the cipher.
    if (this.transport === 'webrtc') {
      this.sendTransport(bytes);
      return;
    }
    this.sendTransport(this.cipher.seal(bytes));
  }

  /**
   * Outbound session bytes on the transport the handshake completed on.
   *
   * Which one that is was fixed in `onFirstFrame`, and it must not be re-decided here: the two
   * connections to the peer hold different box keypairs, so bytes encrypted for one cannot be
   * read on the other. Before the handshake this routes to the relay, which is where it starts —
   * the data channel does not exist until the answer arrives.
   */
  private sendTransport(bytes: Uint8Array): void {
    if (this.transport === 'webrtc') {
      this.webrtc?.send(bytes);
      return;
    }
    this.sinks.sendRelay(bytes);
  }

  private setState(state: SessionState, detail?: string, peerInitiated = false): void {
    this.state = state;
    if (state === 'closed' || state === 'error') {
      this.pendingVoiceCallTimestamp = null;
      this.voiceCallAccepted = false;
    }
    const event: SessionEvent = detail === undefined ? { t: 'state', state } : { t: 'state', state, detail };
    if (peerInitiated && event.t === 'state') event.peerInitiated = true;
    this.sinks.emit(event);
  }

  private fail(detail: string): void {
    this.dropPendingRelayKey();
    this.setState('error', detail);
    this.sinks.closeAll();
  }
}
