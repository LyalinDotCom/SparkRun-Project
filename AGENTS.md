# Agent notes for SparkRun

This is a browser-native coding workbench. A React app boots a CheerpX Linux
micro-VM in WebAssembly, connects it to a user-supplied Tailscale tailnet for a
private preview URL, and lets Gemini drive a root-capable coding environment
through typed tools and an interactive terminal.

This file is the institutional memory for working with that stack. Most of it
was learned the hard way during a long debugging session and hard-won fixes
are encoded in the code — read this before touching `src/lib/webvm.ts` or
the build/server flow in `src/App.tsx`.

## Historical CheerpX footguns, current runtime 1.3.9

The failures in this section were first isolated on CheerpX 1.3.1. The app is
now pinned to CheerpX 1.3.9, but the mitigations remain load-bearing unless a
focused reproducer proves they are no longer needed. Keep historical version
numbers attached to the observation; do not mistake them for the active pin.

### IDB workspace corruption — the "read-only file system" trap

Symptom: `cp /data/X /workspace/site/index.html` fails with
`Read-only file system`, but `mount` says `none on /workspace type cheerpos (rw)`,
`ls -ld /workspace/site` shows `drwxr-xr-x`, and `ls -la /workspace` may show
**phantom inodes** — entries with names like `?????????? ? ? ? ? ? .file` where
`stat()` returns ENOENT for the inode.

Cause: prior interrupted sessions leave per-directory corruption in the
`sparkrun-workspace` IndexedDB. The directory entry persists across reloads
but its inode content is half-committed, so subsequent writes into that
directory return EROFS while reads still work.

Recovery mitigation: `WebVmBackend.prepareWorkspace('clean-site')` runs
`rm -rf /workspace/site && mkdir -p /workspace/site`. This removes corrupt
entries and recreates a clean inode. Top-level `/workspace` writes are not
affected, so the removal itself works.

Normal app boot now uses an isolated per-project workspace database in
`preserve` mode. That database is a validated working cache, not the recovery
authority. SparkRun compares `/workspace/site/.sparkrun-vault-head` with the
committed Browser Vault checkpoint and restores the vault's `tar.gz` whenever
the cache is empty, stale, or unidentified. Reset workspace deletes the exact
project database and preserves the Browser Vault checkpoint for recovery.
The marker proves lineage, not byte-for-byte equality: a matching cache may
contain newer uncheckpointed edits and must be kept. Boot rewrites the same
marker through the normal staged file path as a non-destructive writability
probe. If that probe fails, SparkRun leaves the cache untouched and asks the
user to run Reset workspace; it must not silently clean a cache whose lineage
still matches or which has no independent checkpoint yet.

Vault archives must **not** be extracted directly into the CheerpX directory
mount. Real Chrome testing showed GNU tar ownership updates fail there and,
even with `--no-same-owner`, archive extraction can hit CheerpX's null
`fileData` path and wedge the command runner. `restoreWorkspaceArchive` first
extracts under `/tmp/sparkrun` on the root overlay, validates the staged
`site/`, clears the contents of the already-healthy `/workspace/site` inode,
then copies the staged tree into it with `cp -dR`. Keep that staging boundary.

**Do not remove the `clean-site` recovery path from `prepareWorkspace`.** It is
still used for explicit repair and isolated diagnostics. Also do not let a
preserved workspace become authoritative over Browser Vault; that would
reintroduce silent stale/corrupt project state.

### "Cannot read properties of undefined (reading 'a1')" Worker errors

Symptom: console floods with
`TypeError: Cannot read properties of undefined (reading 'a1') at y8 (cx_esm.js:1:190555)`
firing on every CheerpX network event.

Cause: known noise first observed in CheerpX 1.3.1's userspace network worker. **It is
benign.** Do not chase it.

We capture it via a `window.addEventListener('error', ...)` in
`WebVmBackend.create` and surface it as `phase: 'window-error'` debug entries
so we can see how often it fires, but it's not a real bug and is not worth
fixing — fixing it requires CheerpX upstream changes.

### Tailnet activation and the in-browser Tailscale stack

CheerpX exposes a userspace Tailscale via `networkInterface` on
`Linux.create`. With an authKey on the interface object, Tailscale activates
when `cx.networkLogin()` is called (NOT automatically at boot — it requires
`networkLogin()` to fire). State machine:

| State | Meaning |
|---|---|
| 0 | NoState (initialized but not started) |
| 2 | NeedsLogin |
| 3 | NeedsMachineAuth (waiting for admin approval) |
| 5 | Starting |
| 6 | Running (ready, IP assigned via `netmapUpdateCb`) |

Stuck at NoState after `connectTailnet` timeout normally means the auth key was
rejected, **unless** diagnostics first captured `memory access out of bounds`
from `tcp_input`/`tcp_bind` in `ipstack.js` or `tailscale_tun.js`. That second
case means CheerpX's page-global network runtime is poisoned; another same-page
VM cannot repair it. SparkRun classifies it separately, preserves the Browser
Vault checkpoint, and makes Restart VM reload the page instead of blaming the
key. Do not collapse these two cases back into the same message.
Stuck at NeedsMachineAuth: the tailnet has manual device approval enabled.
We surface both as friendly errors in the events panel.

The browser tab needs Tailscale-on-host to actually *reach* the VM's
`100.x.x.x` preview URL. Without a host Tailscale client, the build still
succeeds but the preview URL won't load — that's a separate environmental
issue from any code bug.

### Build flow ordering — Tailnet activates LATE

`startServer()` is intentionally three-phase:

1. **Stage writes** (cp python script, run cleanup) — workspace IDB still clean
2. **Activate Tailnet** via `prepareTailnetForServer()`
3. **Launch python** with redirect to `/tmp/sparkrun/server.log`

Server state files live at `/tmp/sparkrun/server.{pid,port,host,url,ready,log}`,
NOT in `/workspace/site/`. `/tmp` is on the rootCache overlay (a different
IDB device than the workspace), and on machines where Tailscale activation
flips the workspace IDB read-only, `/tmp` stays writable. Python's
`serve_forever` doesn't write to `/workspace` during normal operation —
just reads files for HTTP responses.

CheerpX 1.3.9 may report success for the detached launch shell well before the
Python child is scheduled. A real Chrome run observed roughly 27 seconds of
startup latency, so `startServer()` waits up to 45 seconds for `server.port`.
Do not shorten this to native-process timing. The command capture must also
accept non-default virtual terminals because concurrent VM work can move later
commands away from VT 1.

`server.ready` means the synchronous socket bind completed; pair it with the
recorded PID being alive. Do **not** add a VM-internal HTTP loopback probe after
Tailnet activation. We reproduced two failure modes in Chrome: a second cold
CPython interpreter exceeded the command-proof watchdog, and an in-process
loopback GET wedged CheerpX's Tailscale stream with `Cannot cancel a locked
ReadableStream`. Both destroyed a healthy preview. The release-level request
proof is outer Chrome loading the `http://100.x.x.x:<port>/` URL and the Python
request log recording the GET. Managed non-Python previews use bounded `curl`
because their process does not issue SparkRun's bind certificate.

App.tsx does NOT pre-connect Tailnet at the start of a build. Don't move
`connectTailnet` earlier in the flow — that's a regression we already paid
for once.

### Command completion must be proven, not inferred

CheerpX process return values can report the launcher rather than prove the
guest command completed. `WebVmBackend.run()` therefore wraps each command in a
new process group using `setsid -f -w` and appends a nonce-bearing completion
marker with the actual shell status. The runner accepts success only when it
captures the exact marker.

If the host watchdog fires or the marker is missing, return status 124, report
the timeout, and dispose the entire VM. A timed-out process group may still be
alive or may emit output later; reusing that VM would let stale work corrupt a
new command. Do not weaken this to trusting CheerpX's numeric return value, and
do not reuse a disposed backend.

### Mount layout

```
{ type: 'ext2',  dev: overlayDevice,    path: '/' }              // base disk + rootCache IDB
{ type: 'dir',   dev: workspaceDevice,  path: '/workspace' }     // per-project workspace IDB
{ type: 'dir',   dev: dataDevice,       path: '/data' }          // in-memory staging
{ type: 'devs',                         path: '/dev' }
{ type: 'devpts',                       path: '/dev/pts' }
{ type: 'proc',                         path: '/proc' }
{ type: 'sys',                          path: '/sys' }
```

We removed a `WebDevice` mount at `/web` because nothing in the codebase used
it and it was a frequent suspect during debugging. Don't add it back unless
you actually need it.

The active default disk is still the official Debian 10 Buster compatibility
image at
`wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2`,
loaded through `CheerpX.CloudDevice`. Buster is end-of-life; it remains the
default only because it is the verified baseline.

The Alpine Linux 3.24.1 `linux/386` coding image is candidate
`2026.08.27-rc3`. It lives in a 1600 MiB ext2 revision-0 image and includes
Node.js 24.18.1, npm/pnpm/Yarn, Python 3.14, Go 1.26, C/C++ tools, shells,
Git/SSH, and network/process diagnostics. Its publication design uses a
versioned GitHub Release as the immutable provenance source;
`npm run stage:vm-image` links the Release checksum and manifest to the expected
profile, filename, size, SHA-256, source commit, and conformance result before
placing it under `dist/vm-images/` for Firebase Hosting. The browser candidate
URL is loaded through
`CheerpX.HttpBytesDevice`, not `GitHubDevice`, because the artifact is too large
for GitHub Pages and direct Release responses lack the required browser CORS
contract. rc3's immutable Release and Firebase byte-range mirror are verified.
Do not make it the default until the real-Chrome CheerpX tool matrix and full
application flow pass.

### The rc3 Node teardown compatibility layer is load-bearing

Alpine/musl did not fix a CheerpX 1.3.9 hang during Node's native platform
teardown. rc3 preloads
`/usr/local/lib/sparkrun/node-exit-preload.cjs`, which records Node's final
resolved status and flushes the Node 24 compile cache. A root-owned N-API addon
then calls `_exit(status)` from an environment cleanup hook before the broken
teardown path. Workers skip the hook; child Node processes inherit it.

Docker image `ENV` metadata is absent after `docker export`, so
`/etc/profile.d/sparkrun-node.sh` persists the preload and compile-cache
defaults for login shells. `WebVmBackend.runOptions()` supplies the same
variables to non-login CheerpX commands. Do not remove either path.

This is a narrow mitigation, not a claim that Node teardown is normal. `_exit`
bypasses later native cleanup. User programs must close durable native
resources before returning. Any image change must rerun exact status, exit
handler, worker, fork, 200 KiB stdout, subsequent-command, and package-manager
checks in both the container and CheerpX in real Chrome. The base image records
the compatibility files as root-owned mode 0444, but the agent also runs as
root and can change an overlay copy. Those modes protect build provenance, not
runtime integrity against the coding agent; Reset VM caches restores the pinned
base state.

CheerpX runtime modules load from
`https://cxrtnc.leaningtech.com/<version>/cx.esm.js` (the dot-named file — the
underscore-named `cx_esm.js` is the Worker bundle, not the main API).

### Pin CheerpX, never use "latest"

`@leaningtech/cheerpx@latest` will silently bump on any `npm install` and
break the app. Pin a specific version and verify in two places:

```ts
// src/lib/webvm.ts: detected at runtime
detectCheerpxRuntimeVersion()  // parses cxrtnc.leaningtech.com/X.Y.Z/ from performance entries

// vite.config.ts: injected at build time
__CHEERPX_PINNED_VERSION__ = readFileSync('node_modules/@leaningtech/cheerpx/package.json').version
```

Both are surfaced in the Setup → Diagnostics card. If they ever disagree,
something is very wrong (cached bundle, mismatched lockfile, etc.).

### Retry ownership is singular

`GeminiInteractionsCodingHarness.callApiWithRetries()` owns Gemini retry
behavior. It passes `maxRetries: 0` to `@google/genai`, then gives every
classified transient `create`, `get`, or `cancel` failure one initial request
plus exactly eight retries (nine attempts maximum) while the run remains active.
User abort and the absolute turn deadline are control-plane terminations and can
end an operation before its retry allowance; permanent client failures are also
not retried. Tool calls are not replayed. Do not add an SDK-level or outer retry
loop.

High-thinking Gemini turns use Interactions background execution. `create`
sets `background: true`, persists `providerState.pendingInteractionId` before
polling, and polls `get` while status is `queued` or `in_progress`. Stop calls
the provider's `cancel` endpoint. If a terminal response was already observed,
late tool calls remain blocked locally and no redundant cancellation is sent.
If cancellation cannot be confirmed after nine short attempts, its ID remains
durable and a later run must reconcile it before starting new provider work.
Do not discard that handle or regress to a long synchronous HTTP call: it
previously hit SparkRun's 90-second cutoff nine times while the same valid server
work continued ambiguously.

Provider-chain recovery is intentionally compact. The latest request is kept
verbatim in a separate `ACTIVE OBJECTIVE` block; only earlier history is
compacted inside an explicit untrusted-data boundary. `read_file` and
`list_directory` bodies are omitted, individual history entries are bounded,
and the whole reconstructed request is capped at 32,000 characters. Oversized
active objectives fail explicitly instead of losing their middle. The durable
VM workspace is authoritative. The harness also rejects a second identical
successful read/list until a mutating operation invalidates that evidence, and
stops repeated future-intent responses instead of accepting “I’ll fix it” as a
completed coding result.

`scripts/stage-vm-image.mjs` independently applies the same initial-plus-eight
ceiling to checksum, Release-manifest, and image downloads, deleting partial
files between disk attempts. This rule applies where SparkRun owns a retryable
API operation; state machines such as Tailscale login must reconcile observed
state rather than blindly replaying a request.

## Build and deploy

```bash
npm run release:deploy
```

`release:deploy` requires a committed, clean worktree, runs the guarded
source/test/build/stage/verify sequence, then invokes Firebase. For a two-step release
handoff, run `npm run release:prepare` and then
`firebase deploy --only hosting`. Firebase's predeploy hook reruns
`npm run release:verify` and fails closed if `dist` does not match its full app
commit, package-lock hash, asset inventory, disk profiles, Release manifest,
image source commit, exact 1600 MiB image size, or SHA-256.

`stage:vm-image` downloads `disk.sha256`, `manifest.json`, and the image (unless
the verified cache already contains it). Each network download receives one
initial attempt plus exactly eight retries. It cross-links profile, version,
filename, size, disk hash, source commit, and toolchain/Node conformance before
atomically staging the image and finalizing `dist/release.json`.

After deploy, **verify the live bundle**:

```bash
LIVE=$(curl -s https://spark-run-poc.web.app/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
ls dist/assets/$LIVE  # should match
curl -s "https://spark-run-poc.web.app/assets/$LIVE" | grep -oE '1\.3\.[0-9]'  # sanity

IMAGE=$(node -p "require('./vm-image/image.json').diskFile")
test -f "dist/vm-images/$IMAGE"
curl -sSI "https://spark-run-poc.web.app/vm-images/$IMAGE" \
  | grep -Ei 'access-control-allow-origin|cross-origin-resource-policy|cache-control|accept-ranges'
test "$(curl -sSL --range 1024-1087 --output /dev/null \
  --write-out '%{http_code}' \
  "https://spark-run-poc.web.app/vm-images/$IMAGE")" = 206
test "$(curl -sS --output /dev/null --write-out '%{http_code}' \
  https://spark-run-poc.web.app/vm-images/does-not-exist.ext2)" = 404
```

The Setup → Diagnostics card also shows build SHA + timestamp + CheerpX
runtime, so you can confirm in the running app.

## Debugging discipline

When a bug is intermittent or machine-specific, **don't ship hypothesis-based
fixes**. Build an isolated reproducer first.

We have one already: `public/diag.html` (deployed at `/diag.html`). It's a
self-contained page that loads the currently pinned CheerpX version directly with no React, no
agent, no Tailscale (or with a real authKey if you paste one). Five buttons:

- **Run tests** — basic mount, write, read, ls, append, redirect, bg, python3
- **Run app-config tests** — same as our app's setup, no real Tailnet
- **Run Tailscale-key tests** — requires a real authKey, exercises full path
- **Run race-condition test** — writes during Tailnet activation
- **Run app-config WITHOUT WebDevice** — historical, kept for comparison

Run these on any "broken" machine before changing app code. If the diag
passes but the real app fails, the bug is in our code, not CheerpX. If both
fail, capture the trace and figure out what's environment-specific.

## What's in the Diagnostics log (per phase)

Every event has a `phase` and most have `status` (0 = ok, non-zero = error):

- `sparkrun-build` — build SHA + timestamp at boot
- `cheerpx-version` — pinned + runtime version
- `tailnet-init` — auth key length (or absent)
- `tailnet-state` — every Tailscale state transition
- `tailnet-netmap` — every netmap callback (with addresses)
- `tailnet-login` — networkLogin() rejections (rare)
- `tailnet-login-url` — manual login flow URLs
- `disk` — active `CloudDevice` or candidate `HttpBytesDevice` load failures;
  HTTPS fallback applies only to the official cloud profile
- `boot` — devices created
- `exec` / `exec-result` — every shell command
- `write` — file write failures (after our `cp` status check)
- `server` / `server-stop` — python server lifecycle
- `server-log` — streaming tail of `/tmp/sparkrun/server.log` while waiting for port
- `health` — bind certificate + tracked PID check; outer Chrome supplies the
  end-to-end Tailnet request proof
- `terminal` / `terminal-exit` — interactive shell
- `console-vt` — output captured from non-default virtual terminals (rare)
- `window-error` / `unhandled-rejection` — global JS errors (often noise)

## When everything is broken

Order of operations to recover, cheapest first:

1. **Hard reload** (Cmd+Shift+R) — bypass HTML cache
2. **Verify build**: open Setup → Diagnostics, confirm timestamp is recent
   and CheerpX pinned matches expected
3. **Reset workspace** (Setup → Diagnostics) — deletes the active project's
   exact `sparkrun-workspace-v3-<project>` cache, then restores its committed
   Browser Vault checkpoint after reload
4. **Reset VM caches** — also deletes the active environment's versioned root
   overlay; the base disk is fetched again on next boot, while the project vault
   remains intact
5. **Run `/diag.html`** isolation tests — narrow down whether the bug is in
   CheerpX, our code, or environmental
6. **Different browser / incognito** — rules out extension or per-origin
   storage issues

Most of the time, hard reload + Reset workspace is enough. Do not delete the
Browser Vault database unless the user explicitly wants a destructive factory
reset; it is the independent recovery copy.
