// Static server + WebSocket bridge for the RustDesk web client.
//
//   node scripts/server.mjs [--port 8080] [--id 127.0.0.1:21118] [--relay 127.0.0.1:21119]
//
// rustdesk's WS convention (libs/hbb_common/src/websocket.rs:421) is path based:
//   /ws/id     -> hbbs websocket port (default 21118 = rendezvous 21116 + 2)
//   /ws/relay  -> hbbr websocket port (default 21119 = relay 21117 + 2)
// so we route on path and talk plain HTTP/WS to the upstreams. In production put
// this behind TLS instead: browsers refuse ws:// from an https page, and only
// secure contexts get WebCodecs.
//
// `http://localhost` is itself a secure context, so for local testing plain
// http/ws is enough and no certificate is needed.
//
// Zero dependencies: the upgrade is proxied at the socket level, so the `ws`
// package isn't required just to bridge.

import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const PORT = Number(arg('port', '8080'));
const ID_TARGET = arg('id', '127.0.0.1:21118');
const RELAY_TARGET = arg('relay', '127.0.0.1:21119');
const API_TARGET = arg('api', '127.0.0.1:12345');

// `dist/` is the deployable tree (build output + the shell copied in by
// esbuild.mjs), so it is also what this dev server exposes.
const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));

// Where the TURN process serves its short-lived ICE config (`-ice-http`). The
// credential is minted there, not here: that process is the one holding the
// shared secret, and production (Caddy file_server) has no place to run a
// signer of its own — so both this dev bridge and the Caddyfile proxy to it.
// Unset means "no TURN", and the page falls back to config.js / public STUN.
const ICE_TARGET = arg('ice', process.env.TURN_ICE ?? '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

async function serveFile(res, path) {
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  // Same-origin /api so the launcher can talk to the console: the API server
  // sends no CORS headers, so a cross-origin fetch from :8080 to :12345 is
  // blocked by the browser. Production puts a reverse proxy here too.
  if (pathname.startsWith('/api/')) {
    const [host, port] = API_TARGET.split(':');
    const up = httpRequest({
      host, port: Number(port), path: req.url, method: req.method,
      headers: { ...req.headers, host: API_TARGET },
    }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('api proxy: ' + e.message);
    });
    req.pipe(up);
    return;
  }

  // ICE configuration for the browser, proxied to the TURN process so the
  // short-lived credential is minted where the secret lives. A deployment with
  // no TURN configured 404s, and the page keeps whatever config.js gave it.
  if (pathname === '/ice-servers.json') {
    if (!ICE_TARGET) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"iceServers":""}');
      return;
    }
    const [host, port] = ICE_TARGET.split(':');
    const up = httpRequest(
      { host, port: Number(port), path: '/ice-servers.json', method: 'GET' },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('ice config proxy: ' + e.message);
    });
    up.end();
    return;
  }

  // The product entry is the launcher (sign in -> pick a device); the client
  // itself is /index.html and also takes ?peer= directly.
  if (pathname === '/') pathname = '/launcher.html';

  // Keep the served tree inside the repo.
  const target = normalize(join(root, pathname));
  if (!target.startsWith(root)) {
    res.writeHead(403).end('403');
    return;
  }
  await serveFile(res, target);
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const target = pathname.startsWith('/ws/relay') ? RELAY_TARGET : ID_TARGET;
  const [host, port] = target.split(':');

  const upstream = connect(Number(port), host, () => {
    // Replay the handshake verbatim; hbbs/hbbr serve a dedicated WS port and
    // ignore the path, so no rewriting is needed.
    console.log(`[bridge] ${pathname} -> ${target} (local port ${upstream.localPort})`);
    const lines = [`GET ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  const fail = (why) => {
    console.error(`[bridge] ${pathname} -> ${target}: ${why}`);
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', (e) => fail(e.message));
  socket.on('error', (e) => fail(e.message));
});

server.listen(PORT, () => {
  console.log(`web client   http://localhost:${PORT}/`);
  console.log(`  /ws/id    -> ${ID_TARGET}`);
  console.log(`  /ws/relay -> ${RELAY_TARGET}`);
});
