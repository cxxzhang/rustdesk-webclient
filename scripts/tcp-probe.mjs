// TCP probe/tee in front of hbbr, to see whether the controlled peer actually
// dials the relay and what it sends first.
//
//   node scripts/tcp-probe.mjs [--listen 21130] [--target 127.0.0.1:21117]
//
// Point the peer at it with `relay-server = '127.0.0.1:21130'` in RustDesk2.toml.

import { createServer, connect } from 'node:net';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PORT = Number(arg('listen', '21130'));
const [THOST, TPORT] = arg('target', '127.0.0.1:21117').split(':');

let n = 0;
createServer((sock) => {
  const id = ++n;
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[${id}] connect from ${peer}`);
  const up = connect(Number(TPORT), THOST);
  up.on('connect', () => console.log(`[${id}] upstream to hbbr ok (local port ${up.localPort})`));
  let first = true;
  sock.on('data', (b) => {
    if (first) {
      first = false;
      // rustdesk frames are length-prefixed: 1-4 byte header, length = value >> 2
      const head = ((b[0] & 0x3) + 1);
      let len = b[0];
      if (head > 1) len |= b[1] << 8;
      if (head > 2) len |= b[2] << 16;
      if (head > 3) len |= b[3] << 24;
      len >>= 2;
      console.log(`[${id}] first chunk ${b.length}B, declared frame len=${len}, hex head=${b.subarray(0, 12).toString('hex')}`);
    } else {
      console.log(`[${id}] ${b.length}B`);
    }
    up.write(b);
  });
  up.on('data', (b) => {
    const head = ((b[0] & 0x3) + 1);
    let len = b[0];
    if (head > 1) len |= b[1] << 8;
    if (head > 2) len |= b[2] << 16;
    if (head > 3) len |= b[3] << 24;
    len >>= 2;
    console.log(`[${id}] <- hbbr ${b.length}B declared=${len}`);
    sock.write(b);
  });
  const bye = (who) => () => { console.log(`[${id}] ${who} closed`); sock.destroy(); up.destroy(); };
  sock.on('close', bye('peer'));
  up.on('close', bye('hbbr'));
  sock.on('error', (e) => console.log(`[${id}] peer err ${e.message}`));
  up.on('error', (e) => console.log(`[${id}] hbbr err ${e.message}`));
}).listen(PORT, () => console.log(`tcp probe :${PORT} -> ${THOST}:${TPORT}`));
