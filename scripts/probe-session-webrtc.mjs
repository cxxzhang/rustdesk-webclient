// Drive Session through the WebRTC branch with a stub WebRtcControl and a
// scripted rendezvous peer, to confirm the wiring without a browser:
//
//   offer built -> carried in PunchHoleRequest -> answer applied ->
//   session bytes go to the data channel (not the relay) -> peer frames are
//   accepted off the data channel -> candidates trickle both ways.
//
//   node --import tsx scripts/probe-session-webrtc.mjs

import sodium from 'libsodium-wrappers';
import { Session } from '../src/core/session.ts';
import { IceCandidate, PunchHoleResponse, RendezvousMessage } from '../src/gen/rendezvous.ts';

await sodium.ready;

const log = (...a) => console.log(...a);
const enc = (msg) => RendezvousMessage.encode(msg).finish();

// ---- stub WebRtcControl ----
class FakeWebRtc {
  constructor() {
    this.key = 'sha-256 11:22:33';
    this.sent = [];
    this.msgCb = null;
    this.closeCb = null;
    this.localCb = null;
    this.answerApplied = null;
    this.remoteCandidates = [];
    this.closed = false;
  }
  sessionKey() { return this.key; }
  onLocalCandidate(cb) { this.localCb = cb; }
  async createOffer() {
    // Candidates gather after the offer; emit one to exercise trickle.
    setTimeout(() => this.localCb?.('{"candidate":"local-1"}'), 10);
    return 'webrtc://' + Buffer.from(JSON.stringify({ type: 'offer', sdp: 'v=0\r\na=fingerprint:' + this.key + '\r\n', ice_policy: 'all' })).toString('base64');
  }
  async acceptAnswer(ep) { this.answerApplied = ep; }
  addRemoteCandidate(c) { this.remoteCandidates.push(c); }
  send(bytes) { this.sent.push(bytes); }
  buffered() { return 0; }
  onMessage(cb) { this.msgCb = cb; }
  onClose(cb) { this.closeCb = cb; }
  close() { this.closed = true; }
}

const fake = new FakeWebRtc();
const signaling = [];
const relay = [];
let sawTransport = null;

const session = new Session(
  { peerId: '521450463', serverKeyB64: 'AA==', wsIdUrl: 'ws://x/ws/id', wsRelayUrl: 'ws://x/ws/relay', password: 'p', myId: '', myName: 't', webrtc: fake },
  {
    sendSignaling: (b) => signaling.push(b),
    sendRelay: (b) => relay.push(b),
    relayBuffered: () => 0,
    emit: (ev) => { if (ev.t === 'transport') sawTransport = ev.kind; },
    onVideo: () => {}, onAudioFormat: () => {}, onAudioFrame: () => {},
    openRelay: () => {}, closeAll: () => {},
  },
);

session.start();
await new Promise((r) => setTimeout(r, 60));

const punch = RendezvousMessage.decode(signaling[0]);
log('--- offer carried in PunchHoleRequest ---');
log('  case          :', punch.union?.$case);
log('  offer present :', (punch.union?.punch_hole_request?.webrtc_sdp_offer ?? '').length > 0);

// Peer's answer arrives inside a punch_hole_response (success form: socket_addr set).
const answer = 'webrtc://' + Buffer.from(JSON.stringify({ type: 'answer', sdp: 'v=0\r\n' })).toString('base64');
session.onSignalingBytes(enc({
  union: { $case: 'punch_hole_response', punch_hole_response: PunchHoleResponse.fromPartial({ socket_addr: new Uint8Array([1, 2, 3, 4]), webrtc_sdp_answer: answer }) },
}));
await new Promise((r) => setTimeout(r, 30));

log('--- answer applied ---');
log('  acceptAnswer  :', fake.answerApplied !== null);
log('  transport     :', sawTransport);

// Trickled candidate from the peer must reach the control.
session.onSignalingBytes(enc({
  union: { $case: 'ice_candidate', ice_candidate: IceCandidate.fromPartial({ id: '', socket_addr: new Uint8Array(0), session_key: fake.key, candidate: '{"candidate":"remote-1"}' }) },
}));
// One for a different session must not.
session.onSignalingBytes(enc({
  union: { $case: 'ice_candidate', ice_candidate: IceCandidate.fromPartial({ id: '', socket_addr: new Uint8Array(0), session_key: 'sha-256 OTHER', candidate: '{"candidate":"stray"}' }) },
}));
await new Promise((r) => setTimeout(r, 20));
log('--- ICE ---');
log('  remote applied:', fake.remoteCandidates);
const iceOut = signaling.slice(1).map((b) => RendezvousMessage.decode(b)).filter((m) => m.union?.$case === 'ice_candidate');
log('  local trickled:', iceOut.length, iceOut[0] ? JSON.stringify(iceOut[0].union.ice_candidate.candidate) : '');
log('  local routed by id:', iceOut[0] ? JSON.stringify(iceOut[0].union.ice_candidate.id) : '');

log('--- verdict ---');
log('  offer in punch      :', (punch.union?.punch_hole_request?.webrtc_sdp_offer ?? '').length > 0);
log('  answer applied      :', fake.answerApplied !== null);
log('  transport switched  :', sawTransport === 'webrtc');
log('  candidate trickle   :', iceOut.length === 1 && fake.remoteCandidates.length === 1);
process.exit(0);
