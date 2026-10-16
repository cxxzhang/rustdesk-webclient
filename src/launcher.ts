// Product entry page: sign in to the console, list your devices, hand off to the
// client with ?peer=<id>.
//
// Deliberately separate from src/ui/* (the vendored client): this page is ours,
// so branding and the account flow can change without touching upstream code.
// It talks to the RustDesk client API your console exposes, through the
// same-origin /api reverse proxy (the console sends no CORS headers).

import { applyBrandTheme, brandLogo, brandName, brandWordmark } from './brand';

type Device = {
  id: string;
  guid?: string;
  hostname?: string;
  os?: string;
  username?: string;
  version?: string;
  is_online?: boolean;
  disabled?: boolean;
};

const TOKEN_KEY = 'andesk.launcher.token';
const UUID_KEY = 'andesk.launcher.uuid';

function config() {
  const c = (globalThis as { __RD__?: Record<string, unknown> }).__RD__ ?? {};
  return {
    apiBase: (c.apiBase as string) || '/api',
  };
}

function deviceUuid(): string {
  try {
    let v = localStorage.getItem(UUID_KEY);
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem(UUID_KEY, v);
    }
    return v;
  } catch {
    return crypto.randomUUID();
  }
}

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const { apiBase } = config();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = token;
  const r = await fetch(apiBase + path, { ...init, headers });
  const text = await r.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!r.ok) {
    const msg = (body as { message?: string; error?: string }).message
      ?? (body as { error?: string }).error ?? `HTTP ${r.status}`;
    throw new Error(msg);
  }
  // The console reports failures as 200 + {error} for client-API compatibility.
  const err = (body as { error?: string }).error;
  if (err) throw new Error(err);
  return body as T;
}

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function header(): HTMLElement {
  const h = el('header', 'ad-head');
  const brand = el('div', 'ad-brand');
  const img = el('img', 'ad-logo') as HTMLImageElement;
  img.src = brandLogo();
  img.alt = brandName();
  const [a, b] = brandWordmark();
  const name = el('span', 'ad-wordmark');
  name.append(document.createTextNode(a), el('span', undefined, b));
  brand.append(img, name);
  h.append(brand);
  return h;
}

function loginView(onDone: (token: string) => void): HTMLElement {
  const wrap = el('div', 'ad-card');
  wrap.append(el('h1', 'ad-h1', document.documentElement.dataset.brandName ?? brandName()));
  wrap.append(el('p', 'ad-sub', 'Sign in to see your devices'));

  const form = el('form', 'ad-form') as HTMLFormElement;
  const user = el('input', 'ad-input') as HTMLInputElement;
  user.name = 'username'; user.placeholder = 'Username'; user.autocomplete = 'username'; user.required = true;
  const pass = el('input', 'ad-input') as HTMLInputElement;
  pass.name = 'password'; pass.type = 'password'; pass.placeholder = 'Password';
  pass.autocomplete = 'current-password'; pass.required = true;
  const btn = el('button', 'ad-btn', 'Sign in') as HTMLButtonElement;
  btn.type = 'submit';
  const err = el('div', 'ad-err');

  form.append(user, pass, btn, err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = await api<{ access_token: string }>('/login', {
        method: 'POST',
        body: JSON.stringify({
          username: user.value.trim(),
          password: pass.value,
          id: '',
          uuid: deviceUuid(),
          type: 'account',
          deviceInfo: { os: 'web', type: 'main', name: 'web-launcher' },
        }),
      });
      try { localStorage.setItem(TOKEN_KEY, res.access_token); } catch { /* private mode */ }
      onDone(res.access_token);
    } catch (e2) {
      err.textContent = (e2 as Error).message;
    } finally {
      btn.disabled = false;
    }
  });
  wrap.append(form);
  return wrap;
}

async function devicesView(token: string, onLogout: () => void): Promise<HTMLElement> {
  const wrap = el('div', 'ad-card ad-wide');
  const head = el('div', 'ad-row');
  head.append(el('h1', 'ad-h1', 'Devices'));
  const out = el('button', 'ad-link', 'Sign out');
  out.addEventListener('click', () => { void api('/logout', { method: 'POST' }, token).catch(() => undefined); onLogout(); });
  head.append(out);
  wrap.append(head);

  const list = el('div', 'ad-list');
  wrap.append(list);

  let devices: Device[] = [];
  try {
    const res = await api<{ data: Device[] }>('/devices', {}, token);
    devices = res.data ?? [];
  } catch (e) {
    list.append(el('div', 'ad-err', (e as Error).message));
    return wrap;
  }
  if (!devices.length) {
    list.append(el('div', 'ad-empty', 'No devices yet. Install the client on a machine and sign it in to the same console.'));
    return wrap;
  }
  for (const d of devices) {
    const card = el('button', 'ad-dev') as HTMLButtonElement;
    card.type = 'button';
    const dot = el('span', 'ad-dot' + (d.is_online ? ' on' : ''));
    const main = el('span', 'ad-dev-main');
    main.append(el('strong', undefined, d.hostname || d.id));
    main.append(el('small', undefined, [d.username, d.os, d.version].filter(Boolean).join(' · ')));
    card.append(dot, main, el('span', 'ad-id', d.id));
    card.addEventListener('click', () => {
      // Hand off to the client page; it reads ?peer= (see web/index.html).
      const u = new URL('./', location.href);
      u.searchParams.set('peer', d.id);
      location.href = u.toString();
    });
    list.append(card);
  }
  return wrap;
}

async function main(): Promise<void> {
  applyBrandTheme();

  // A ?peer= link is a direct "connect to this device" URL (shared links,
  // bookmarks). Keep it working now that / is the launcher, by handing straight
  // over to the client page with the same query string.
  const directPeer = (globalThis as { __RD__?: { peerId?: string } }).__RD__?.peerId;
  if (directPeer) {
    location.replace('./index.html' + location.search);
    return;
  }

  const app = document.getElementById('ad-root');
  if (!app) return;
  app.append(header());

  const body = el('main', 'ad-main');
  app.append(body);

  const showLogin = (msg?: string) => {
    body.replaceChildren(loginView((token) => { void showDevices(token); }));
    if (msg) body.querySelector('.ad-err')!.textContent = msg;
  };
  const showDevices = async (token: string) => {
    body.replaceChildren(el('div', 'ad-loading', 'Loading devices…'));
    body.replaceChildren(await devicesView(token, () => {
      try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      showLogin();
    }));
  };

  let saved: string | null = null;
  try { saved = localStorage.getItem(TOKEN_KEY); } catch { /* ignore */ }
  if (saved) await showDevices(saved);
  else showLogin();
}

void main();
