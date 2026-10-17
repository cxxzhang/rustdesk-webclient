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
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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

// ---------------------------------------------------------------------------
// Share links.
//
// A share link is `/s/<payload>.<sig>`: the payload names a peer and carries an
// expiry, and the signature is HMAC-SHA256 over the payload. Verification is
// server-side because that is the only place a secret can live — anything the
// page can compute, the visitor can compute too.
//
// The two things this is for:
//   * the visitor gets in without being told the device id (it is in the link);
//   * the link stops working on its own, so a link pasted into a chat does not
//     stay a permanent key to that machine.
//
// The RustDesk password is deliberately NOT in the link. It is a credential for
// the controlled machine and would still work after the link expired, so
// putting it in a URL that ends up in browser history and chat logs would
// outlive the expiry it was meant to be bounded by.
// Default lifetime; a caller may ask for less with ?ttl=.
const SHARE_TTL_S = Number(arg('share-ttl', process.env.SHARE_TTL ?? '600'));
const SHARE_TTL_MAX_S = Number(arg('share-ttl-max', process.env.SHARE_TTL_MAX ?? '86400'));

// A secret is required: without one the signature would be forgeable, and a
// forgeable share link is just an unlocked door. Generated per process for
// local use, so links made here die with the server — the honest behaviour for
// a dev bridge. The log prints it so they can still be minted within a run.
const SHARE_SECRET = (() => {
  const configured = arg('share-secret', process.env.SHARE_SECRET ?? '');
  if (configured) return configured;
  const ephemeral = randomBytes(32).toString('base64url');
  console.log('[share] no SHARE_SECRET set; using an ephemeral one for this run:');
  console.log(`[share]   ${ephemeral}`);
  console.log('[share] set SHARE_SECRET to keep links valid across restarts.');
  return ephemeral;
})();

function signShare(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SHARE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify a `/s/` token. Returns `{ payload }` or `{ error }`. */
function verifyShare(token) {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { error: 'malformed link' };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const want = createHmac('sha256', SHARE_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length is not secret.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: 'bad signature' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { error: 'malformed payload' };
  }
  if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) {
    return { error: 'link expired' };
  }
  return { payload };
}

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

  // Mint a share link. Not behind auth here because the dev bridge has no user
  // concept; a real deployment puts this behind the console's session, which is
  // where "may this user share this device" belongs.
  //
  //   /share?peer=521450463[&ttl=300]
  //   -> { url: "http://host/s/<token>", expires: <unix seconds> }
  if (pathname === '/share') {
    const peer = (url.searchParams.get('peer') ?? '').replace(/\s+/g, '');
    if (!peer) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"peer is required"}');
      return;
    }
    let ttl = Number(url.searchParams.get('ttl') ?? SHARE_TTL_S);
    if (!Number.isFinite(ttl) || ttl <= 0) ttl = SHARE_TTL_S;
    ttl = Math.min(ttl, SHARE_TTL_MAX_S);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    // `pw` (opt-in) puts the controlled peer's password inside the signed
    // payload, so the visitor connects without being told it. Off by default:
    // it makes the link a full credential, so it is only as safe as the channel
    // it travels over and the short TTL. `key` pins the server key, which lets
    // the link work even if the client's config.js is stale.
    const payload = { peer, exp };
    const pw = url.searchParams.get('pw');
    if (pw) payload.pw = pw;
    const key = url.searchParams.get('key');
    if (key) payload.key = key;
    const token = signShare(payload);
    // The Host header, so the link works from wherever the caller reached us.
    const host = req.headers.host || `localhost:${PORT}`;
    // Behind TLS the link must be https:// or the browser blocks the ws:// it
    // opens. The edge sets X-Forwarded-Proto; fall back to the request's own
    // socket encryption (plain http for the dev bridge).
    const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    // Opened directly in a browser (the controlled peer's "copy share link"
    // button hands out exactly this URL), redirect to the signed link instead
    // of showing JSON. A programmatic caller sends Accept: application/json and
    // still gets the structured response.
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (wantsHtml && req.method === 'GET') {
      res.writeHead(302, {
        Location: `${proto}://${host}/s/${token}`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      url: `${proto}://${host}/s/${token}`,
      peer, expires: exp, ttl,
      // Never echo the password back; say only that one is embedded.
      includesPassword: Boolean(pw),
    }));
    return;
  }

  // A share link: verify, then serve the client with the peer and key injected
  // so the visitor is not asked for a device id. An invalid or expired token
  // gets an explanatory page, not the client.
  if (pathname.startsWith('/s/')) {
    const { payload, error } = verifyShare(pathname.slice(3));
    if (error) {
      res.writeHead(error === 'link expired' ? 410 : 403, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        '<!doctype html><meta charset="utf-8">' +
        '<title>AnDesk</title>' +
        '<body style="font:16px system-ui;padding:2rem;color:#333">' +
        `<h1 style="font-size:1.1rem">This link is no longer usable</h1>` +
        `<p>${error}.</p>` +
        '<p>Ask whoever sent it for a fresh one.</p>',
      );
      return;
    }
    // Serve the normal client shell, with one script injected ahead of config.js
    // that pins the peer. Doing it here rather than in boot.js keeps the shared
    // secret out of the static tree entirely.
    const shell = resolve(root, 'index.html');
    let html;
    try {
      html = (await readFile(shell)).toString('utf8');
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html missing from dist/');
      return;
    }
    // The token is scrubbed from the address bar before the client shell runs:
    // a credential-bearing URL would otherwise sit in history, in a screenshot
    // of the URL bar, and in whatever the visitor pasted it into. The page is
    // already loaded, so the path change costs nothing.
    const scrub = `<script>try{history.replaceState(null,'','/')}catch(e){}</script>`;
    const injected = scrub + `<script>window.__RD_SHARE=${JSON.stringify({
      peerId: payload.peer,
      serverKeyB64: payload.key || undefined,
      password: payload.pw || undefined,
    })};</script>`;
    // Every asset URL in the shell is relative (./app.js, ./app.css), and this
    // page is served from /s/<token>, so without a <base> they would all resolve
    // under /s/ and 404. It has to precede the stylesheet link in <head>.
    html = html.replace('<head>', '<head>\n<base href="/">');
    html = html.replace('<script src="./config.js"></script>',
      injected + '\n<script src="./config.js"></script>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
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
