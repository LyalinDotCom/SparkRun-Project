# Agent notes for SparkRun

This is a browser-built website prototype. A React app boots a CheerpX micro-VM
(Debian, in-browser via WebAssembly), connects to a user-supplied Tailscale
tailnet for a stable preview URL, and lets Gemini drive the build by writing
files into the VM's workspace.

This file is the institutional memory for working with that stack. Most of it
was learned the hard way during a long debugging session and hard-won fixes
are encoded in the code — read this before touching `src/lib/webvm.ts` or
the build/server flow in `src/App.tsx`.

## The CheerpX 1.3.1 footguns we hit

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

Mitigation: at boot, `rm -rf /workspace/site && mkdir -p /workspace/site`
(see `WebVmBackend.prepareWorkspace`). This nukes the corrupt entries and
recreates a clean inode. Top-level `/workspace` writes are not affected, so
the `rm -rf` itself works. User project files persist in localStorage
(`sparkrun.projects.v1`) and are restored after boot via
`restoreProjectFiles`.

**Do not remove the `rm -rf` in `prepareWorkspace`.** It looks aggressive but
it's load-bearing — without it, builds fail intermittently on any machine
whose IDB has accumulated corruption from prior sessions.

### "Cannot read properties of undefined (reading 'a1')" Worker errors

Symptom: console floods with
`TypeError: Cannot read properties of undefined (reading 'a1') at y8 (cx_esm.js:1:190555)`
firing on every CheerpX network event.

Cause: known noise from CheerpX 1.3.1's userspace network worker. **It is
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

Stuck at NoState after `connectTailnet` timeout: the auth key was rejected.
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

Server state files live at `/tmp/sparkrun/server.{pid,port,host,url,log}`,
NOT in `/workspace/site/`. `/tmp` is on the rootCache overlay (a different
IDB device than the workspace), and on machines where Tailscale activation
flips the workspace IDB read-only, `/tmp` stays writable. Python's
`serve_forever` doesn't write to `/workspace` during normal operation —
just reads files for HTTP responses.

App.tsx does NOT pre-connect Tailnet at the start of a build. Don't move
`connectTailnet` earlier in the flow — that's a regression we already paid
for once.

### Mount layout

```
{ type: 'ext2',  dev: overlayDevice,    path: '/' }              // base disk + rootCache IDB
{ type: 'dir',   dev: workspaceDevice,  path: '/workspace' }     // sparkrun-workspace IDB
{ type: 'dir',   dev: dataDevice,       path: '/data' }          // in-memory staging
{ type: 'devs',                         path: '/dev' }
{ type: 'devpts',                       path: '/dev/pts' }
{ type: 'proc',                         path: '/proc' }
{ type: 'sys',                          path: '/sys' }
```

We removed a `WebDevice` mount at `/web` because nothing in the codebase used
it and it was a frequent suspect during debugging. Don't add it back unless
you actually need it.

The disk image is `wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2`
served by leaningtech. CheerpX runtime modules load from
`https://cxrtnc.leaningtech.com/<version>/cx.esm.js` (the dot-named file —
the underscore-named `cx_esm.js` is the Worker bundle, not the main API).

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

## Build and deploy

```bash
rm -rf dist && npm run build && firebase deploy --only hosting
```

Always `rm -rf dist` before `npm run build` before `firebase deploy`. Skipping
the rebuild will deploy whatever is in `dist/` from your last build, even if
your code has moved on. (Yes, this happened. We chased ghosts for an hour
because the live bundle was 1.3.2 while local was 1.3.1.)

After deploy, **verify the live bundle**:

```bash
LIVE=$(curl -s https://spark-run-poc.web.app/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
ls dist/assets/$LIVE  # should match
curl -s "https://spark-run-poc.web.app/assets/$LIVE" | grep -oE '1\.3\.[0-9]'  # sanity
```

The Setup → Diagnostics card also shows build SHA + timestamp + CheerpX
runtime, so you can confirm in the running app.

## Debugging discipline

When a bug is intermittent or machine-specific, **don't ship hypothesis-based
fixes**. Build an isolated reproducer first.

We have one already: `public/diag.html` (deployed at `/diag.html`). It's a
self-contained page that loads CheerpX 1.3.1 directly with no React, no
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
- `disk` — CloudDevice failures and HTTPS fallback
- `boot` — devices created
- `exec` / `exec-result` — every shell command
- `write` — file write failures (after our `cp` status check)
- `server` / `server-stop` — python server lifecycle
- `server-log` — streaming tail of `/tmp/sparkrun/server.log` while waiting for port
- `health` — server health check
- `terminal` / `terminal-exit` — interactive shell
- `console-vt` — output captured from non-default virtual terminals (rare)
- `window-error` / `unhandled-rejection` — global JS errors (often noise)

## When everything is broken

Order of operations to recover, cheapest first:

1. **Hard reload** (Cmd+Shift+R) — bypass HTML cache
2. **Verify build**: open Setup → Diagnostics, confirm timestamp is recent
   and CheerpX pinned matches expected
3. **Reset workspace** button (gear → Setup → Diagnostics) — wipes
   `sparkrun-workspace` IDB via `indexedDB.deleteDatabase`
4. **Reset everything** button — wipes both IDBs (slower next boot, the disk
   re-downloads)
5. **Run `/diag.html`** isolation tests — narrow down whether the bug is in
   CheerpX, our code, or environmental
6. **Different browser / incognito** — rules out extension or per-origin
   storage issues

Most of the time, hard reload + Reset workspace is enough. The boot-time
`rm -rf /workspace/site` makes resets less necessary than they used to be.
