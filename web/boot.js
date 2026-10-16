// Shared bootstrap for both pages (client + launcher).
//
// Builds window.__RD__ from web/config.js plus query-string overrides, and
// applies the white-label palette as CSS variables. Kept in one place so the
// two entry points cannot drift.
(function () {
  var base = window.__RD_CONFIG || {};
  var q = new URLSearchParams(location.search);
  var wsOrigin = location.origin.replace(/^http/, 'ws');
  var pick = function (name, fallback) {
    var v = q.get(name);
    return v === null || v === '' ? fallback : v;
  };
  var brand = base.brand || {};
  window.__RD__ = {
    serverKeyB64: pick('key', base.serverKeyB64 || ''),
    wsIdUrl: pick('wsid', base.wsIdUrl || wsOrigin + '/ws/id'),
    wsRelayUrl: pick('wsrelay', base.wsRelayUrl || wsOrigin + '/ws/relay'),
    apiBase: base.apiBase || '/api',
    // ICE servers for the WebRTC path. Empty is fine — the browser then uses
    // the public STUN defaults. A relay-policy session needs a TURN entry here
    // (`turn://user:pass@host:port`) or its ICE agent gathers nothing usable.
    //
    // Server-provided credentials win: `/ice-servers.json` hands out a
    // short-lived TURN credential so a shared secret never has to sit in this
    // static file. `config.js` stays as the fallback for a static deployment,
    // and the fetch is fire-and-forget — a page that never gets an answer keeps
    // the configured value and still gathers STUN.
    iceServers: base.iceServers || '',
    myId: pick('myid', base.myId || ''),
    myName: pick('myname', base.myName || 'webclient'),
    version: base.version,
    workerUrl: base.workerUrl || './session.worker.js',
    peerId: pick('peer', base.peerId),
    brand: brand,
  };

  // White-label palette, as CSS variables, so no upstream stylesheet is edited.
  // Keep in sync with src/brand.ts.
  var root = document.documentElement.style;
  root.setProperty('--rd-accent', brand.accent || '#4c8dff');
  root.setProperty('--rd-accent-2', brand.accent2 || '#3a6fd8');
  root.setProperty('--rd-accent-fg', brand.accentFg || '#ffffff');

  if (brand.name) {
    document.title = brand.name;
    document.documentElement.dataset.brandName = brand.name;
  }
  if (!window.__RD__.serverKeyB64) {
    console.warn('[andesk] serverKeyB64 is empty — pass ?key=<hbbs id_ed25519.pub> or set it in config.js');
  }

  // Pull TURN credentials from the server, if it offers them. The value is
  // written back into __RD__.iceServers and the promise is exposed so a session
  // started before the answer arrives can wait for it instead of racing.
  // A 404 or a network error is normal for a static deployment: keep config.js.
  window.__RD__.iceReady = fetch('ice-servers.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (j && j.iceServers) window.__RD__.iceServers = j.iceServers;
    })
    .catch(function () { /* static deployment: config.js value stands */ });
})();
