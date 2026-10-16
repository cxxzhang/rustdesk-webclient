# Attribution

This repository is **not** written from scratch. Its protocol core is derived
from another open-source project, and the schemas come from a third. Both are
AGPL-3.0, and this repository is therefore AGPL-3.0 too (see `LICENSE`).

## Vendored: CortenDesk web client

- Upstream: <https://github.com/marcpope/cortendesk> → `webclient/`
- License: AGPL-3.0-only
- Retrieved: 2026-10-15, branch `main`

What came from it — essentially the whole of `src/`:

| Path | Origin |
|---|---|
| `src/core/` | vendored (one import path changed, see below) |
| `src/input/`, `src/media/`, `src/transport/`, `src/worker/`, `src/shim/` | vendored |
| `src/ui/` | vendored |
| `src/gen/` | **regenerated here** from our own protos (see below) |
| `buf.gen.yaml`, `buf.yaml`, `tsconfig.json`, `esbuild.mjs` | vendored, locally patched |
| `package.json` | vendored, locally patched (name/description/scripts) |
| `protos/` | **replaced** — see below |

Local deviations are applied by `scripts/apply-local-patches.py` and are:

1. **`protos/` are rustdesk 1.5.1's schemas**, not upstream's vendored copies:
   - `protos/message.proto` ← `rustdesk/libs/base/protos/message.proto`
   - `protos/rendezvous.proto` ← `rustdesk/libs/hbb_common/protos/rendezvous.proto`

   In our tree `IdPk` lives in `rendezvous.proto` (upstream keeps it in
   `message.proto`) and carries two extra fields, `dtls_fingerprint` and
   `kx_version`. `src/core/handshake.ts` imports `IdPk` from the matching
   module. We send `kx_version = 0` and use the original single-key scheme; the
   peer accepts that (`src/server.rs:315` rejects only `kx_version > advertised`),
   at the cost of key-exchange v1's per-direction subkeys.

2. **`buf.gen.yaml` invokes ts-proto via `node`**, not through the extension-less
   `node_modules/.bin/protoc-gen-ts_proto` shim, which buf cannot spawn on Windows.

3. **`esbuild.mjs` emits into `./dist`** instead of Laravel's `../public/rdclient`,
   and copies `web/{index.html,config.js}` in so `dist/` is a deployable tree.

4. `package.json` name/description/scripts.

## Schemas: RustDesk

- <https://github.com/rustdesk/rustdesk> (AGPL-3.0)
- `libs/base/protos/message.proto`, `libs/hbb_common/protos/rendezvous.proto`

The wire protocol implemented here is RustDesk's. Nothing in `src/` is copied
from the Rust client; the protobuf schemas are, and they define the interface.

## Runtime dependencies

`libsodium-wrappers` (NaCl primitives), `jmuxer` (MSE muxing for the non-secure-context
H.264 fallback), `tweetnacl`, `zstddec` — all permissive licenses, see their packages.

## If you redistribute or run this as a service

AGPL-3.0 §13 requires offering the Corresponding Source to users who interact
with the modified program over a network. That covers this client **and** your
modified rustdesk server/client. "RustDesk" and its logo are not covered by the
license grant — for anything commercial, rebrand, and get legal advice before
shipping.
