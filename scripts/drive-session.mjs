// Headless end-to-end driver: runs the protocol core in Node against a real
// rustdesk peer, with no browser involved.
//
//   node --import tsx scripts/drive-session.mjs <peerId> <password> [wsIdUrl] [wsRelayUrl] [serverKeyB64]
//
// The core (src/core/session.ts) is sans-IO by design: it hands us raw bytes to
// put on two WebSockets and we hand back whatever arrives. That makes the whole
// rendezvous -> relay -> NaCl handshake -> login -> video path testable without
// a browser, which is also how you debug it when the UI shows nothing.
//
// Deliberately NOT the browser's WS: Node's global WebSocket connects to the
// same bridge the page would, so relay/signaling routing is exercised too.

import sodium from 'libsodium-wrappers';
import { Session } from '../src/core/session.ts';
import { RendezvousMessage } from '../src/gen/rendezvous.ts';

// libsodium is WASM-backed; every call before `ready` resolves throws
// "Cannot read properties of undefined (reading '_malloc')". The browser worker
// awaits this before touching the core, so do the same here.
await sodium.ready;

const argv = process.argv.slice(2);
const [peerId, password, wsIdUrl, wsRelayUrl, serverKeyB64] = argv;
if (!peerId || !password || !serverKeyB64) {
  console.error('usage: drive-session.mjs <peerId> <password> <wsIdUrl> <wsRelayUrl> <serverKeyB64>');
  process.exit(2);
}

const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = (...a) => console.log(`[${since()}]`, ...a);

let idWs;
let relayWs;
let videoFrames = 0;
let keyFrames = 0;
let audioFrames = 0;
let finished = false;
let transport = 'websocket';

const seenStates = new Set();

const sinks = {
  sendSignaling(b) {
    idWs?.send(b);
  },
  sendRelay(b) {
    if (relayWs?.readyState === 1) relayWs.send(b);
  },
  relayBuffered() {
    return relayWs?.bufferedAmount ?? 0;
  },
  emit(ev) {
    if (ev.t === 'state') {
      if (!seenStates.has(ev.state)) {
        seenStates.add(ev.state);
        log('state ->', ev.state, ev.detail ? `(${ev.detail})` : '');
      }
      if (ev.state === 'streaming') log('*** STREAMING ***');
      if (ev.state === 'error' || ev.state === 'closed') {
        log('terminal state:', ev.state, ev.detail || '');
        finish(ev.state === 'streaming' ? 0 : 1);
      }
      return;
    }
    if (ev.t === 'transport') { log('*** TRANSPORT:', ev.kind, '***'); transport = ev.kind; return; }
    if (ev.t === 'peerInfo') {
      log('peerInfo:', {
        hostname: ev.hostname, username: ev.username, platform: ev.platform,
        version: ev.version, displays: ev.displays?.length, current: ev.current,
      });
      return;
    }
    if (ev.t === 'loginError') { log('loginError:', ev.message); return; }
    if (ev.t === 'credentials') { log('credentials h1:', ev.hashHex.slice(0, 16) + '…'); return; }
    if (ev.t === 'codecSupport') { log('codecSupport:', ev.codecs); return; }
    if (ev.t === 'stats') { log('stats:', ev.stats); return; }
    if (ev.t === 'clipboard' || ev.t === 'cursor' || ev.t === 'cursorPos') return; // noisy
    log('event:', ev.t, JSON.stringify(ev).slice(0, 200));
  },
  onVideo(frame) {
    videoFrames++;
    if (videoFrames <= 3 || videoFrames % 60 === 0) {
      log(`video frame #${videoFrames} ${frame?.displayWidth ?? '?'}x${frame?.displayHeight ?? '?'}`);
    }
    try { frame?.close?.(); } catch { /* ignore */ }
  },
  onAudioFormat(rate, ch) { log('audio format', rate, ch); },
  onAudioFrame() { audioFrames++; },
  openRelay(_relayServerFromHbbS) {
    // A browser cannot dial hbbr's raw TCP port; the page always goes through
    // the same-site ws bridge, so ignore the address hbbs handed us.
    relayWs = new WebSocket(wsRelayUrl);
    relayWs.binaryType = 'arraybuffer';
    relayWs.onopen = () => { log('relay ws open'); session.relayOpened(); };
    relayWs.onmessage = async (e) => {
      session.onRelayBytes(new Uint8Array(e.data)).catch((err) => log('relay err', err));
    };
    relayWs.onerror = () => log('relay ws error');
    relayWs.onclose = () => log('relay ws closed');
  },
  closeAll() {
    try { idWs?.close(); } catch { /* ignore */ }
    try { relayWs?.close(); } catch { /* ignore */ }
  },
};

function finish(code) {
  if (finished) return;
  finished = true;
  log('---------------------------------------------');
  log(`RESULT: states=${[...seenStates].join(' -> ')} transport=${transport}`);
  log(`RESULT: videoFrames=${videoFrames} audioFrames=${audioFrames}`);
  sinks.closeAll();
  setTimeout(() => process.exit(code), 300);
}

const session = new Session({
  peerId,
  password,
  serverKeyB64,
  wsIdUrl,
  wsRelayUrl,
  myId: '',
  myName: 'andesk-headless',
}, sinks);

idWs = new WebSocket(wsIdUrl);
idWs.binaryType = 'arraybuffer';
idWs.onopen = () => { log('id ws open'); session.start(); };
idWs.onmessage = (e) => {
  const bytes = new Uint8Array(e.data);
  try {
    const msg = RendezvousMessage.decode(bytes);
    const c = msg.union?.$case ?? 'NONE';
    const u = msg.union;
    let extra = '';
    if (c === 'relay_response') extra = `uuid=${u.relay_response.uuid} relay=${u.relay_response.relay_server} pk=${u.relay_response.union?.$case ?? '-'}`;
    if (c === 'punch_hole_response') extra = `sock=${u.punch_hole_response.socket_addr.length}B relay=${u.punch_hole_response.relay_server} fail=${u.punch_hole_response.failure} other=${u.punch_hole_response.other_failure}`;
    if (c === 'punch_hole') extra = `relay=${u.punch_hole.relay_server}`;
    if (c === 'fetch_local_addr') extra = `relay=${u.fetch_local_addr.relay_server}`;
    log('id <- rendezvous', c, extra);
  } catch (err) {
    log('id <- undecodable', err.message);
  }
  session.onSignalingBytes(bytes);
};
idWs.onerror = () => log('id ws error');
idWs.onclose = () => log('id ws closed');

// Success is "we saw the remote screen"; stop early once a few frames landed.
const doneTimer = setInterval(() => {
  if (videoFrames >= 5) { log('got 5 video frames — success'); finish(0); }
}, 1000);

setTimeout(() => { log('timeout after 30s'); finish(videoFrames > 0 ? 0 : 1); }, 30000);
process.on('exit', () => clearInterval(doneTimer));
