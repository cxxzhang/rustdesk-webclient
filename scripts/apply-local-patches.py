#!/usr/bin/env python3
r"""Apply this repo's local changes on top of the vendored webclient sources.

The sources under src/ come from cortendesk's webclient/ (AGPL-3.0, see
ATTRIBUTION.md). Everything here is the delta we own, applied idempotently so a
re-sync of upstream files does not silently revert it:

  1. protos/            <- rustdesk 1.5.1 schemas, not the vendored copies
  2. buf.gen.yaml       <- invoke ts-proto via `node`, not the extension-less
                           node_modules/.bin shim (buf spawns it directly and
                           Windows cannot execute an extension-less file)
  3. esbuild.mjs        <- emit into ./dist instead of Laravel's ../public/rdclient
  4. package.json       <- our name/description/scripts

Run:  python scripts/apply-local-patches.py
"""
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUSTDESK = r"E:\NetJobs\rustdesk"

# 1. schemas -----------------------------------------------------------------
PROTOS = {
    'message.proto': os.path.join(RUSTDESK, 'libs', 'base', 'protos', 'message.proto'),
    'rendezvous.proto': os.path.join(RUSTDESK, 'libs', 'hbb_common', 'protos', 'rendezvous.proto'),
}


def patch_protos():
    for name, src in PROTOS.items():
        dst = os.path.join(ROOT, 'protos', name)
        if not os.path.exists(src):
            print('  !! missing source proto', src)
            continue
        shutil.copyfile(src, dst)
        print('  protos/%-18s %d bytes' % (name, os.path.getsize(dst)))


# 2. buf.gen.yaml ------------------------------------------------------------
PLUGIN_OLD = '  - local: ./node_modules/.bin/protoc-gen-ts_proto'
PLUGIN_NEW = '  - local: ["node", "./node_modules/ts-proto/protoc-gen-ts_proto"]'
PLUGIN_NOTE = """# The ts-proto plugin is invoked as `node <bin>` rather than through
# node_modules/.bin/protoc-gen-ts_proto: on Windows that shim has no extension
# and buf spawns it directly, which fails with "'.' is not recognized".
"""


def patch_buf_gen():
    p = os.path.join(ROOT, 'buf.gen.yaml')
    s = open(p, encoding='utf-8').read()
    if PLUGIN_NEW in s:
        print('  buf.gen.yaml already patched')
        return
    if PLUGIN_OLD not in s:
        print('  !! buf.gen.yaml: plugin line not found')
        return
    s = s.replace(PLUGIN_OLD, PLUGIN_NEW)
    # drop upstream's now-wrong comment about the .bin shim
    s = s.replace(
        '# The ts-proto plugin binary comes from node_modules/.bin/protoc-gen-ts_proto.\n',
        PLUGIN_NOTE)
    open(p, 'w', encoding='utf-8', newline='').write(s)
    print('  buf.gen.yaml patched')


# 3. esbuild.mjs -------------------------------------------------------------
OUT_OLD = "const outdir = resolve(__dirname, '../public/rdclient');"
OUT_NEW = "const outdir = resolve(__dirname, 'dist');"


def patch_esbuild():
    p = os.path.join(ROOT, 'esbuild.mjs')
    s = open(p, encoding='utf-8').read()
    if OUT_NEW in s:
        print('  esbuild.mjs already patched')
        return
    if OUT_OLD not in s:
        print('  !! esbuild.mjs: outdir line not found')
        return
    s = s.replace(OUT_OLD, OUT_NEW)
    s = s.replace('// Build the CortenDesk web client into ../public/rdclient/ (committed output,\n'
                  '// honoring the CortenDesk no-build-step rule for the app itself: built once on\n'
                  '// the dev machine, the bundle is served statically by Laravel).',
                  '// Build the web client into ./dist/ (self-contained static asset tree).')
    s = s.replace('//   src/ui/app.ts             -> ../public/rdclient/app.js       (main thread)\n'
                  '//   src/worker/session.worker -> ../public/rdclient/session.worker.js (worker)',
                  '//   src/ui/app.ts             -> dist/app.js               (main thread)\n'
                  '//   src/worker/session.worker -> dist/session.worker.js    (worker)')
    s = s.replace('//   npm run build -- --watch rebuild on change (dev only)',
                  '//   npm run build:dev        unminified, with sourcemaps\n'
                  '//   npm run watch            rebuild on change (dev only)')
    open(p, 'w', encoding='utf-8', newline='').write(s)
    print('  esbuild.mjs patched')


# 4. package.json ------------------------------------------------------------
SCRIPTS = {
    'gen': 'buf generate',
    'build': 'node esbuild.mjs',
    'build:dev': 'node esbuild.mjs --dev',
    'watch': 'node esbuild.mjs --watch',
    'typecheck': 'tsc --noEmit',
    'serve': 'node scripts/server.mjs',
}


def patch_package():
    p = os.path.join(ROOT, 'package.json')
    d = json.load(open(p, encoding='utf-8'))
    if d.get('name') == 'andesk-webclient' and d.get('scripts') == SCRIPTS:
        print('  package.json already patched')
        return
    d['name'] = 'andesk-webclient'
    d['description'] = ('Browser RustDesk client (wire protocol in TypeScript; relay over '
                        'WebSocket, WebCodecs video). AGPL-3.0.')
    d['scripts'] = SCRIPTS
    json.dump(d, open(p, 'w', encoding='utf-8', newline='\n'), indent=2, ensure_ascii=False)
    open(p, 'a', encoding='utf-8', newline='\n').write('\n')
    print('  package.json patched')


# 5. white-label ------------------------------------------------------------
# Every user-visible hard-coded name upstream ships. The palette needs no patch:
# web/index.html sets the CSS variables at runtime.
BRAND_SITES = [
    ('src/ui/app.ts',
     'import { brandLogo, brandName, brandWordmark } from \'../brand\';',
     [
         ('<img src="/rdclient/logo.png" alt="" width="30" height="30">',
          '<img src="${brandLogo()}" alt="" width="30" height="30">'),
         ('<img class="rd-logo" src="/rdclient/logo.png" alt="CortenDesk" width="60" height="60">',
          '<img class="rd-logo" src="${brandLogo()}" alt="${brandName()}" width="60" height="60">'),
         ('<span class="rd-wordmark">Corten<span>Desk</span></span>',
          '<span class="rd-wordmark">${brandWordmark()[0]}<span>${brandWordmark()[1]}</span></span>'),
         ('<span class="rd-tb-name">Corten<span>Desk</span></span>',
          '<span class="rd-tb-name">${brandWordmark()[0]}<span>${brandWordmark()[1]}</span></span>'),
         ('document.title = `${this.peerId} — CortenDesk`;',
          'document.title = `${this.peerId} — ${brandName()}`;'),
     ]),
    ('src/media/session-recorder.ts',
     'import { brandSlug } from \'../brand\';',
     [('link.download = `cortendesk-session-${stamp}.${extension}`;',
       'link.download = `${brandSlug()}-session-${stamp}.${extension}`;')]),
    ('src/ui/session-prefs.ts',
     'import { brandSlug } from \'../brand\';',
     [("export const PREFS_KEY = 'cortendesk.rdprefs.v1';",
       'export const PREFS_KEY = `${brandSlug()}.rdprefs.v1`;')]),
]


def _add_import(src, line):
    if line in src:
        return src
    lines = src.split('\n')
    for i, l in enumerate(lines):
        if l.startswith('import '):
            lines.insert(i, line)
            return '\n'.join(lines)
    # no imports at all: keep any leading comment block, then the import
    i = 0
    while i < len(lines) and (lines[i].startswith('//') or lines[i].strip() == ''):
        i += 1
    lines.insert(i, line)
    return '\n'.join(lines)


def patch_branding():
    for rel, import_line, swaps in BRAND_SITES:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            print('  !! missing', rel)
            continue
        s = open(p, encoding='utf-8', newline='').read()
        done = 0
        for old, new in swaps:
            if new in s:
                done += 1
                continue
            if old in s:
                s = s.replace(old, new)
                done += 1
        s = _add_import(s, import_line)
        open(p, 'w', encoding='utf-8', newline='').write(s)
        print('  %-32s %d/%d branding sites' % (rel, done, len(swaps)))


if __name__ == '__main__':
    for fn in (patch_protos, patch_buf_gen, patch_esbuild, patch_package, patch_branding):
        print(fn.__name__)
        fn()
