// Probe whether hbbs forwards the WebRTC signaling at all.
//
// Uses two plain WebSocket connections to /ws/id so no client or peer is needed:
//   A registers as a fake peer, then dials itself via PunchHoleRequest carrying a
//   webrtc offer. B (same id, one connection) plays the controlled side and watches
//   the incoming PunchHole for the offer, then answers.
//
//   node scripts/probe-webrtc-signaling.mjs
//
// What each result means:
//   offer forwarded      hbbs copies webrtc_sdp_offer into PunchHole  (needed)
//   IceCandidate relayed hbbs routes ICE candidates both ways          (needed)

import {
  IceCandidate,
  NatType,
  PunchHoleRequest,
  PunchHoleSent,
  RegisterPk,
  RendezvousMessage,
} from '../src/gen/rendezvous.ts';

const WS_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8080/ws/id';
const KEY = process.env.KEY ?? 'Ey8d3eOFd4eevMhaa4Syq48RlnoI0mJIgnKwXsZ7kZ0=';
const ID = process.env.PEER_ID ?? 'probe-webRTC-1';
const SESSION_KEY = 'sha-256 AA:BB:CC';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function open(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return new Promise((res, rej) => {
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws error ' + url));
    ws.onclose = () => rej(new Error('ws closed before open ' + url));
  });
}

const send = (ws, msg) => ws.send(RendezvousMessage.encode(msg).finish());

function decode(ev) {
  return RendezvousMessage.decode(new Uint8Array(ev.data));
}

// ---- controller ----
async function controller(target = ID) {
  const ws = await open(WS_URL);
  const seen = { punchHoleSent: null, punchHoleResponse: null, ice: [] };
  ws.onmessage = (ev) => {
    const m = decode(ev);
    const c = m.union?.$case;
    log('  [controller] <-', c, c === 'punch_hole_response'
      ? JSON.stringify({ failure: m.union.punch_hole_response.failure, other: m.union.punch_hole_response.other_failure, sock: m.union.punch_hole_response.socket_addr.length })
      : c === 'relay_response'
        ? JSON.stringify({ answerBytes: (m.union.relay_response.webrtc_sdp_answer ?? '').length, relay: m.union.relay_response.relay_server })
        : '');
    if (c === 'punch_hole_response') seen.punchHoleResponse = m.union.punch_hole_response;
    if (c === 'relay_response') seen.relayResponse = m.union.relay_response;
    if (c === 'ice_candidate') seen.ice.push(m.union.ice_candidate);
  };

  // A plain offer is enough to test forwarding; the Rust side would base64 a real SDP.
  const offer = 'webrtc://' + Buffer.from(JSON.stringify({ type: 'offer', sdp: 'v=0\r\na=fingerprint:' + SESSION_KEY + '\r\n', ice_policy: 'all' })).toString('base64');
  send(ws, {
    union: {
      $case: 'punch_hole_request',
      punch_hole_request: PunchHoleRequest.fromPartial({
        id: target, licence_key: KEY, force_relay: true, nat_type: NatType.SYMMETRIC,
        version: '1.5.1', conn_type: 0, udp_port: 0,
        webrtc_sdp_offer: offer,
      }),
    },
  });
  return { ws, seen, offer };
}

// ---- controlled peer ----
async function controlled() {
  const ws = await open(WS_URL);
  const seen = { punchHole: null, ice: [] };
  ws.onmessage = (ev) => {
    const m = decode(ev);
    const c = m.union?.$case;
    log('  [controlled] <-', c);
    if (c === 'punch_hole') seen.punchHole = m.union.punch_hole;
    if (c === 'ice_candidate') seen.ice.push(m.union.ice_candidate);
  };
  // Register so hbbs treats this id as online. The pk blob is opaque here; the
  // point is only to exist in the peer map.
  send(ws, {
    union: {
      $case: 'register_pk',
      register_pk: RegisterPk.fromPartial({
        id: ID, uuid: new Uint8Array(16), pk: new Uint8Array(32).fill(7), no_register_device: true,
      }),
    },
  });
  await sleep(300);
  return { ws, seen };
}

// NOTE: over WebSocket, RegisterPk answers NOT_SUPPORT (hbbs renders it only on
// the UDP mediator path), so a fake peer never enters the peer map and every
// punch to it comes back ID_NOT_EXIST. To exercise forwarding we therefore dial
// the *real* registered client and read the offer out of its own log.
const REAL_PEER = process.env.REAL_PEER ?? '';
if (!REAL_PEER) {
  console.log('set REAL_PEER=<id of the running client> to probe against it');
  process.exit(0);
}
const controllerSide = await controller(REAL_PEER);
await sleep(3000);
const rr = controllerSide.seen.relayResponse;
console.log('--- VERDICT ---');
console.log('  offer reached peer : ', !!rr);
console.log('  peer built an ANSWER:', !!rr && (rr.webrtc_sdp_answer ?? '').length > 0,
            rr ? `(${(rr.webrtc_sdp_answer ?? '').length} bytes)` : '');
if (rr && (rr.webrtc_sdp_answer ?? '').length) {
  console.log('  answer envelope     :', rr.webrtc_sdp_answer.slice(0, 48) + '…');
}
controllerSide.ws.close();
process.exit(0);

const ph = controlledSide.seen.punchHole;
log('--- PunchHole received by the controlled side ---');
log('  present      :', !!ph);
log('  webrtc offer :', ph ? JSON.stringify(ph.webrtc_sdp_offer ?? '') .slice(0, 60) : 'n/a');
log('  offer matches:', !!ph && ph.webrtc_sdp_offer === controllerSide.offer);

// Answer, exactly as the controlled side does: ride it on PunchHoleSent.
if (ph) {
  send(controlledSide.ws, {
    union: {
      $case: 'punch_hole_sent',
      punch_hole_sent: PunchHoleSent.fromPartial({
        socket_addr: ph.socket_addr,
        id: ID,
        relay_server: '',
        nat_type: NatType.SYMMETRIC,
        version: '1.5.1',
        webrtc_sdp_answer: 'webrtc://' + Buffer.from(JSON.stringify({ type: 'answer', sdp: 'v=0\r\n', ice_policy: 'all' })).toString('base64'),
      }),
    },
  });
  await sleep(800);
  log('--- PunchHoleResponse at the controller ---');
  const pr = controllerSide.seen.punchHoleResponse;
  log('  present        :', !!pr);
  log('  webrtc answer  :', pr ? JSON.stringify(pr.webrtc_sdp_answer ?? '').slice(0, 60) : 'n/a');
}

// ICE both directions: controller -> peer (routed by id), peer -> controller
// (routed by the punch address hbbs handed out).
log('--- ICE candidate relay ---');
send(controllerSide.ws, {
  union: { $case: 'ice_candidate', ice_candidate: IceCandidate.fromPartial({ id: ID, socket_addr: new Uint8Array(0), session_key: SESSION_KEY, candidate: '{"candidate":"c1"}' }) },
});
await sleep(800);
log('  peer received :', controlledSide.seen.ice.length);

const peerAddr = ph?.socket_addr;
if (peerAddr && peerAddr.length) {
  send(controlledSide.ws, {
    union: { $case: 'ice_candidate', ice_candidate: IceCandidate.fromPartial({ id: '', socket_addr: peerAddr, session_key: SESSION_KEY, candidate: '{"candidate":"c2"}' }) },
  });
  await sleep(800);
}
log('  controller recv:', controllerSide.seen.ice.length);

controlledSide.ws.close();
controllerSide.ws.close();
process.exit(0);
