// Drive a real browser against the built client over CDP, with zero downloads:
// Edge/Chrome is already on the machine and Node 22 has a global WebSocket.
//
//   node scripts/browser-check.mjs [--url http://localhost:8080/] [--seconds 8]
//
// Reports console errors, whether the app mounted, what controls it rendered,
// and (with --connect <peerId> <password>) whether a session reaches streaming.
//
// Uses a throwaway --user-data-dir so the user's own browser profile is never
// touched.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const URL_ = arg('url', 'http://localhost:8080/');
const SECONDS = Number(arg('seconds', '8'));
const CONNECT_AT = argv.indexOf('--connect');
const CONNECT = CONNECT_AT >= 0 ? [argv[CONNECT_AT + 1], argv[CONNECT_AT + 2]] : null;
const PORT = Number(arg('cdp-port', '9222'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) { console.error('no Edge/Chrome found'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'andesk-cdp-'));
const proc = spawn(exe, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Cdp(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        (c.handlers.get(m.method) || []).forEach((h) => h(m.params));
      }
    };
    return c;
  }
  on(method, fn) { const a = this.handlers.get(method) || []; a.push(fn); this.handlers.set(method, a); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
    return r.result.value;
  }
}

const logs = [];
let cdp;
try {
  await waitForDevtools();
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);

  cdp.on('Runtime.consoleAPICalled', (p) => {
    logs.push(`[console.${p.type}] ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    logs.push(`[EXCEPTION] ${p.exceptionDetails?.text} ${p.exceptionDetails?.exception?.description ?? ''}`);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await sleep(SECONDS * 1000);

  const summary = await cdp.eval(`(() => {
    const root = document.getElementById('rd-root');
    const ctl = [...document.querySelectorAll('#rd-root input, #rd-root button, #rd-root [contenteditable]')]
      .map(e => e.tagName.toLowerCase() + (e.id ? '#'+e.id : '')
                 + (e.className ? '.'+String(e.className).split(' ')[0] : '')
                 + (e.type ? ' type='+e.type : '')
                 + (e.title ? ' title='+JSON.stringify(e.title) : '')
                 + (e.placeholder ? ' ph='+JSON.stringify(e.placeholder) : '')
                 + (e.tagName === 'BUTTON' && e.textContent.trim() ? ' text='+JSON.stringify(e.textContent.trim().slice(0,30)) : ''));
    return {
      title: document.title,
      cfg: !!window.__RD__,
      rootChildren: root ? root.children.length : -1,
      rootHtmlLen: root ? root.innerHTML.length : -1,
      controls: ctl,
      state: (document.body.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 200),
    };
  })()`);
  console.log('--- page ---');
  console.log(JSON.stringify(summary, null, 2));

  if (CONNECT) {
    const [peer, password] = CONNECT;
    console.log(`--- connecting to ${peer} ---`);
    // `--no-webrtc` hides RTCPeerConnection before the connect click, so the
    // worker cannot build one and the session can only come up over the relay.
    // Exercises the fallback path (and proves the page still works without it).
    if (argv.includes('--no-webrtc')) {
      const off = await cdp.eval(`(() => { delete window.RTCPeerConnection; return typeof RTCPeerConnection; })()`);
      console.log('webrtc disabled ->', off);
    }
    const driven = await cdp.eval(`(async () => {
      const set = (el, v) => { el.focus(); el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true })); };
      const id = document.querySelector('#rd-peer-id');
      const pw = document.querySelector('#rd-password');
      const btn = document.querySelector('#rd-connect');
      if (!id || !pw || !btn) return 'missing controls: ' + [!id && 'peer', !pw && 'pw', !btn && 'connect'].filter(Boolean).join(',');
      set(id, ${JSON.stringify(peer)});
      set(pw, ${JSON.stringify(password)});
      btn.click();
      return 'clicked #rd-connect';
    })()`);
    console.log('drive:', driven);
    // `--watch <sec>` keeps sampling past the first "Online" so regressions that
    // only surface later (a transport leg dying, an idle socket being closed)
    // are visible; the default stops at the first good state.
    const watchSec = Number(arg('watch', '0'));
    const deadline = Date.now() + watchSec * 1000;
    let live = false;
    for (let i = 0; ; i++) {
      await sleep(2500);
      const s = await cdp.eval(`(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,220)`);
      console.log(`  t+${(i + 1) * 2.5}s:`, s);
      if (/streaming|fps|帧|码率|Online|Disconnect/i.test(s)) live = true;
      if (live && !watchSec) break;
      if (!watchSec && i >= 5) break;
      if (watchSec && Date.now() >= deadline) break;
    }
    const canvas = await cdp.eval(`(() => {
      const c = document.querySelector('#rd-root canvas');
      return c ? { w: c.width, h: c.height } : null;
    })()`);
    console.log('canvas:', JSON.stringify(canvas));
    // Capture while the session is still up: the shared screenshot below runs at
    // the very end, by which point a failed session has fallen back to the
    // connect screen and proves nothing about the remote view.
    const liveShot = arg('shot-live', null);
    if (liveShot) {
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(liveShot, Buffer.from(img.data, 'base64'));
      console.log('live screenshot ->', liveShot, live ? '(session up)' : '(NOT up)');
    }
  }

  // Launcher flow: sign in to the console, list devices, click one, land in the
  // client with ?peer= and let it connect — i.e. the whole product path.
  if (argv.includes('--launcher')) {
    const user = arg('user', 'admin');
    const pass = arg('pass', 'admin123');
    console.log('--- launcher ---');
    await cdp.send('Page.navigate', { url: new URL('/?noredirect=1', URL_).toString() });
    await sleep(2500);
    const filled = await cdp.eval(`(() => {
      const u = document.querySelector('input[name=username]');
      const p = document.querySelector('input[name=password]');
      const b = document.querySelector('#ad-root button[type=submit]');
      if (!u || !p || !b) return 'missing login controls';
      u.value = ${JSON.stringify(user)}; p.value = ${JSON.stringify(pass)};
      b.click();
      return 'submitted';
    })()`);
    console.log('login:', filled);
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const st = await cdp.eval(`(() => {
        const cards = [...document.querySelectorAll('.ad-dev')];
        const err = document.querySelector('.ad-err');
        return {
          err: err ? err.textContent : null,
          devices: cards.map(c => c.querySelector('strong')?.textContent + ' / ' + c.querySelector('.ad-id')?.textContent),
          online: cards.map(c => c.querySelector('.ad-dot')?.classList.contains('on')),
        };
      })()`);
      console.log(`  t+${(i + 1) * 1.5}s:`, JSON.stringify(st));
      if (st.devices.length) break;
    }
    // Hand off: clicking a device should land in the client with ?peer=.
    const clicked = await cdp.eval(`(() => {
      const c = document.querySelector('.ad-dev');
      if (!c) return 'no device card';
      c.click();
      return 'clicked';
    })()`);
    console.log('handoff:', clicked);
    for (let i = 0; i < 8; i++) {
      await sleep(2000);
      const st = await cdp.eval(`({
        url: location.pathname + location.search,
        title: document.title,
        hasClient: !!document.getElementById('rd-connect'),
        text: (document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 120),
      })`);
      console.log(`  t+${(i + 1) * 2}s:`, JSON.stringify(st));
      if (/Online|Disconnect/.test(st.text)) break;
    }
  }

  // File transfer opens its own FILE_TRANSFER relay connection and silently
  // re-authenticates with the h1 the desktop session already proved, so a
  // populated remote pane is evidence that a *second* session came up.
  if (argv.includes('--files')) {
    console.log('--- file transfer ---');
    const opened = await cdp.eval(`(() => {
      const b = document.querySelector('#rd-btn-files');
      if (!b) return 'no #rd-btn-files';
      b.click();
      return 'clicked';
    })()`);
    console.log('open panel:', opened);
    for (let i = 0; i < 5; i++) {
      await sleep(2500);
      const st = await cdp.eval(`(() => {
        const ov = document.getElementById('rd-ft-overlay');
        const pane = document.getElementById('rd-ft-remote');
        const path = document.getElementById('rd-ft-remote-path');
        const list = pane ? pane.querySelector('.rd-ft-list, [id$="-list"], tbody') : null;
        const rows = list ? list.children.length : -1;
        return {
          closed: ov ? ov.classList.contains('rd-ft-closed') : null,
          remotePath: path ? path.value : null,
          rows,
          text: pane ? (pane.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 160) : null,
        };
      })()`);
      console.log(`  t+${(i + 1) * 2.5}s:`, JSON.stringify(st));
      if (st.rows > 0) break;
    }
  }

  const shot = arg('shot', null);
  if (shot) {
    const img = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot, Buffer.from(img.data, 'base64'));
    console.log('screenshot ->', shot);
  }

  console.log('--- console output ---');
  if (!logs.length) console.log('(none)');
  for (const l of logs.slice(0, 40)) console.log(l);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
  await sleep(500);
  proc.kill();
}
