# SparkRun architecture

SparkRun is a coding environment whose computer lives inside the browser. The
human sees a normal web app, but the files, shell, development servers, and most
coding tools run inside an isolated Linux environment provided by CheerpX. A
Gemini coding harness connects the model to that environment through explicit
tools. Tailscale can give a server in the browser VM a private URL.

The important word is **browser**. SparkRun does not silently rent a remote
machine. It also does not give generated code access to the user's Mac or PC.
The browser is the host and the CheerpX guest is the work computer.

## Status vocabulary

These labels keep design documents from presenting an aspiration as a shipped
feature.

- **Verified**: exercised at the boundary where the claim matters, including a
  real browser for browser-VM behavior.
- **Candidate**: implemented and promising, but a named release gate can still
  reject it.
- **Rejected**: evaluated at its named gate and not eligible for promotion in
  that revision.
- **Planned**: an accepted direction that still needs implementation or a
  browser-level proof.

A candidate becomes verified only after the gates in
[`TESTING.md`](./TESTING.md) pass. Source code existing in a branch is not enough.

## The system in one picture

```text
User
  |
  v
Outer Chrome tab (React workbench)
  |-- HTTPS --------------------------> Gemini Interactions API
  |                                      |  model output + function calls
  |<-------------------------------------|
  |
  | validated file/shell tools
  v
CheerpX 1.3.9 Linux guest (32-bit x86 ABI in WebAssembly)
  |-- immutable ext2 base image
  |-- IndexedDB root overlay (environment cache)
  |-- per-project IndexedDB /workspace (fast resume)
  |-- terminal, baseline tools, and dev servers
  |
  `-- userspace Tailscale ------------> private tailnet preview URL

Outer Chrome origin storage
  `-- Browser Vault (projects, conversations, checkpoints, terminal metadata)
```

| Concern | Technology | Status |
| --- | --- | --- |
| Outer application | React 19, TypeScript, Vite | Implemented; release build covered by CI |
| Model API | `@google/genai` 2.19.0, Gemini 3.7 Flash, Interactions | Implemented; credentialed Chrome flow is a release gate |
| Linux guest | CheerpX 1.3.9, 32-bit x86 Linux ABI | Official Debian compatibility baseline; Alpine rc3 rejected for modern Node/npm promotion |
| BrowserPod runtime | Deferred concept; no adapter is implemented | Not a release runtime until live-key, licensing, process-control, portal/file-bridge, and security gates pass |
| Durable metadata | Dexie over IndexedDB | Implemented; live reset/resume is a Chrome gate |
| Terminal | xterm.js connected to the CheerpX pseudo-terminal | Implemented; real PTY behavior is a Chrome gate |
| Private preview network | CheerpX userspace Tailscale | Verified baseline; full rebuilt flow is a release gate |
| Static app hosting | Firebase Hosting with cross-origin isolation headers | Implemented; every deployment still needs live verification |

There are two browsers in discussions about SparkRun, and they must not be
confused:

1. **Outer Chrome** runs SparkRun itself. It owns the page, browser storage,
   provider requests, integration tests, and the visible preview.
2. **A browser inside the guest** would be a Linux program running under
   CheerpX. Modern Chrome for Testing publishes `linux64`, not Linux i386,
   binaries. Therefore headless Chrome remains an outer-host integration until
   a guest-compatible browser is proven. The current Chrome for Testing asset
   matrix is the source of truth for available binaries.

See [Chrome for Testing availability](https://googlechromelabs.github.io/chrome-for-testing/).

## Responsibility boundaries

### React workbench

The outer app owns user intent and orchestration:

- project and conversation selection;
- the visible chat, files, events, preview controls, and xterm terminal;
- model credentials and Tailscale enrollment settings;
- VM boot, restart, reset, snapshot, and restore operations;
- translating harness events into durable UI history;
- opening preview URLs and running outer-browser checks.

The optional local-folder feature is an outer-app copy operation, not a guest
mount. After explicit browser permission, SparkRun copies collected project
files into the selected directory. The guest and model never receive the
`FileSystemDirectoryHandle` directly.

The current Codex-inspired workbench uses a persistent project/conversation rail,
a central conversation and activity stream, a bottom coding composer, and a
collapsible Environment inspector for preview, files, terminal, and activity.
The layout is implemented. Multiple conversations, per-project storage, durable
checkpoints, drawer focus behavior, and real PTY interaction remain part of the
complete browser release gate.

The project is the durable working copy; a conversation is one agent thread that
operates on that copy. Multiple conversations may share one project, but they do
not silently share provider continuation identifiers. The human and agent see
the same files and terminal state. The UI should expose what is happening—model
request, tool call, process, snapshot, network transition, or failure—instead of
collapsing the entire run into an optimistic “done” message.

The intended workbench has persistent navigation for projects, conversations,
environment state, and snapshots; a primary work area for files/preview/terminal;
and a coding conversation that remains visible while commands run. Exact panel
placement may evolve during usability testing. The stable architectural rule is
that the terminal is a first-class surface, not a modal that blocks the build.

### Gemini Interactions coding harness

The harness is the control loop between Gemini and the VM. Its job is to:

1. send a user request to Gemini 3.7 Flash;
2. expose typed file, directory, edit, and shell tools;
3. validate and execute each tool call against a runtime adapter;
4. return the result to Gemini;
5. persist a recoverable session after every meaningful step;
6. continue until the model finishes or the turn budget is reached.

The [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
supports server-managed conversation state through `previous_interaction_id`.
SparkRun scopes that identifier to the tool turns of one submitted user request.
The next request begins a fresh provider episode from a bounded transcript and
the current workspace, avoiding an opaque chain that accumulates complete file
bodies and model thoughts. The identifier is therefore an optimization, not
SparkRun's only copy of history: Interaction retention is finite, so the local
transcript and current workspace remain the recovery source of truth.

`src/lib/codingHarness.ts`,
`src/lib/codingHarnessTools.ts`, and `src/lib/geminiCodingHarness.ts` define a
provider/runtime boundary, full-VM shell access, durable session callbacks,
secret redaction, and transcript-based recovery when a provider interaction is
unavailable. `src/App.tsx` is now wired to this harness and stores its session in
each Browser Vault conversation. SDK retries are disabled; a classified
retryable Interactions `create`, `get`, or `cancel` operation receives one
initial attempt and exactly eight retries while its run is active. User Stop
and the absolute turn deadline are control-plane terminations that can end an
operation earlier without being reported as API-retry exhaustion.

Gemini 3.7 Flash runs with high thinking through Interactions background
execution. SparkRun persists the returned interaction ID immediately, polls
`queued`/`in_progress` interactions to a terminal state, and cancels the remote
job when the user presses Stop. An unconfirmed cancellation ID stays durable
and prevents a second execution until reconciliation succeeds. This separates a short HTTP request timeout from
the longer server-side reasoning budget and avoids recreating an expensive turn
when a foreground connection closes. If the provider chain must be rebuilt,
SparkRun sends a compact transcript: large file/directory results are omitted
because the durable VM workspace is the source of truth.

The session keeps one bounded, redacted telemetry snapshot for the latest
Interaction and emits a compact status event with create time, poll time,
actual API request counts, provider timestamps, and reported token totals. It
never copies prompts, tool arguments, or arbitrary provider fields into that
telemetry. This separates a large-context problem from a low-input request that
simply spends a long time queued or reasoning server-side.

The system instruction and host guard treat the newest user message as a
separate, untruncated active objective; recovered output is delimited as
untrusted evidence. They keep narrow repairs narrow, suppress exact repeated
successful inspections until workspace mutation, and reject repeated
future-intent answers rather than accepting a planning-only turn as success.

### Runtime adapter and CheerpX guest

The harness talks to a small `CodingRuntime` capability interface instead of
importing CheerpX throughout the application. The runtime supplies text files,
directory listings, shell commands, and a durable workspace root. This keeps the
agent loop testable and leaves room for another runtime without rewriting
conversation logic.

The adapter is an abstraction boundary, not runtime federation. A release uses
one canonical runtime and one live workspace filesystem. SparkRun does not
automatically fall back between CheerpX and BrowserPod or merge their files and
partially completed processes. BrowserPod is experimental-only until its
live-key, licensing, process-control, portal/file-bridge, and security gates
pass in the real browser. Source code for an adapter does not satisfy those
gates.

CheerpX is not a conventional virtual machine with a Linux kernel. It provides
an x86-to-WebAssembly just-in-time compiler, Linux system-call emulation, and
virtual filesystems, allowing an unmodified 32-bit x86 Linux userland to run in
the page. The upstream [WebVM README](https://github.com/leaningtech/webvm)
describes the same architecture.

The guest intentionally gives the coding agent broad power **inside the guest**:

- file tools are restricted to the project workspace;
- shell commands can use the full guest filesystem and installed toolchain;
- a narrow guard blocks obvious whole-VM destruction;
- the guest has no direct filesystem bridge to the user's host computer.

This is an operational boundary, not a claim that arbitrary generated code is
safe. See [`SECURITY.md`](./SECURITY.md).

### Private networking and previews

CheerpX includes a userspace Tailscale network interface. SparkRun activates it
late in the build, after workspace writes, because real browser testing found
that early activation could interact badly with the IndexedDB workspace.
Server state lives under `/tmp/sparkrun`, on the root overlay rather than the
project workspace.

The built-in server writes a bind certificate only after
`ThreadingHTTPServer` has synchronously claimed its socket, and SparkRun pairs
that certificate with the tracked PID. It intentionally does not issue a
loopback HTTP request inside the VM after Tailnet activation: CheerpX 1.3.9 can
wedge that userspace network stream, while starting a second CPython probe can
miss the command-proof watchdog. Release validation proves the real route by
loading the `100.x.x.x` URL in outer Chrome and checking the server request log.

The Tailscale address is private. The outer computer must be able to reach the
same tailnet to open it. Public internet access from WebVM requires a tailnet
exit node. ICMP is not available, so connectivity checks use `curl` or `wget`,
not `ping`. These are upstream WebVM constraints documented in the
[WebVM networking guide](https://github.com/leaningtech/webvm#networking).

## Persistence model

“Survives a VM reset” requires data that is independent from the live VM
process. SparkRun therefore separates the environment from the project and
keeps a second recovery copy outside the guest filesystem.

| Layer | Purpose | Expected lifetime |
| --- | --- | --- |
| Base ext2 image | Reproducible operating system and preinstalled tools | Immutable for an environment version |
| Root overlay IndexedDB | Guest changes outside `/workspace`, caches, and ad hoc installs | Survives reload/restart; replaceable |
| Per-project workspace IndexedDB | Fast working copy for source files and dependencies | Survives reload/restart; isolated by project |
| Browser Vault IndexedDB | Project metadata, conversations, terminal metadata, and SHA-256-recorded checkpoints | Independent recovery source for a broken/replaced guest overlay |

The live workspace is the operational working copy, but the latest committed
Browser Vault checkpoint is the independent recovery authority. A stale,
empty, or unidentified runtime workspace must be restored from that checkpoint,
not allowed to overwrite it. Runtime replacement is an explicit checkpoint and
restore operation; runtimes do not silently merge filesystem state. The Vault
is still origin-local storage, not an off-device backup.

`/workspace/site/.sparkrun-vault-head` records which verified Vault checkpoint
the preserved cache descends from. It is a lineage token, not a content hash: a
matching cache can legitimately contain newer work that has not reached the
next checkpoint. Normal boot keeps that cache and rewrites the same marker
through the ordinary staged file path to prove writability. A missing or
mismatched marker is cleaned and restored only when a verified recovery
checkpoint exists; a corrupt Vault head forces the same rollback to its newest
verified ancestor. If the non-destructive write probe fails, boot fails with
Reset-workspace guidance and leaves the cache untouched.

### Checkpoints

A normal checkpoint is a `tar.gz` archive of the project tree at
`/workspace/site`, so it can preserve
binary files, dotfiles, symlinks, empty directories, and Unix modes. The vault
hashes the archive with SHA-256 and commits it in two phases: first a `writing`
record, then a transaction that marks it `committed` and moves the project head.
An interrupted write cannot become the project head.

Restore uses the root overlay as a staging boundary. The archive is extracted
under `/tmp/sparkrun`, validated, and copied into the existing healthy
`/workspace/site` inode. Extracting tar directly into CheerpX's IndexedDB-backed
directory mount failed in real Chrome even with ownership restoration disabled,
so the staging copy is a correctness requirement rather than an optimization.

Browser storage is still local browser storage. `navigator.storage.persist()`
reduces automatic eviction risk but does not protect against clearing site data,
losing the browser profile, disk failure, or origin changes. Export/import or
remote backup is therefore a separate planned feature, not something the vault
already guarantees. See [MDN's storage quota and eviction guide](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

CheerpX workspace directories have a known failure mode where an interrupted
IndexedDB write leaves a phantom directory entry: the mount reports read/write,
but writes inside `/workspace/site` fail with `Read-only file system`. The
default recovery path deliberately removes and recreates that directory. The
rebuild's `preserve` mode is only for isolated per-project databases backed by
vault checkpoints, and it accepts responsibility for detecting corruption and
offering restore. Do not remove the clean-site recovery path because it looks
redundant.

### Reset boundaries

The UI must name destructive operations according to what they actually erase.

| Operation | Live processes | Root overlay/tools | Project workspace | Browser Vault |
| --- | --- | --- | --- | --- |
| Restart VM | Lost and recreated | Preserved | Preserved | Preserved |
| Reset workspace | Lost | Preserved | Cache deleted; latest checkpoint restores on reload | Preserved |
| Reset VM caches | Lost | Recreated from pinned image | Cache deleted; latest checkpoint restores on reload | Preserved |
| Delete project | Lost for the active project | Preserved | Deleted | That project's records are deleted |
| Clear origin site data | Lost | Deleted | Deleted | Deleted |

A running process cannot survive a tab crash. “Resume” reconstructs the
workspace, conversations, bounded provider context, and terminal metadata—not
guest RAM. A normal restart reuses the root-overlay cache, but Browser Vault
does not replay ad-hoc package installations after Reset VM caches.

## Custom coding image

The active default is still the official Debian 10 Buster WebVM disk. Buster is
end-of-life; it remains only as the verified compatibility baseline while a
replacement is evaluated.

**Rejected for promotion:** Alpine Linux 3.24.1 with musl for `linux/386`,
version `2026.08.27-rc3`, pinned to base digest
`sha256:95a35dbffc3da87221f8b4eea3ed90cb52c634fedfdf4d22f3eb50e8883656cd`.
Its immutable artifact remains available for provenance and diagnostics, but it
must not become the default or a fallback runtime.

CheerpX custom images must use 32-bit x86 (`i386`/`i686`) and ext2 images may be
at most 2 GB. The custom-image pipeline must therefore choose packages by
measured guest compatibility, not by assuming an `amd64` binary will work. See
the official [CheerpX custom disk image guide](https://cheerpx.io/docs/guides/custom-images).

The 1600 MiB ext2 revision-0 container is below CheerpX's 2 GB limit but too
large for GitHub Pages. The image workflow therefore publishes a versioned,
non-latest GitHub Release asset. The Release also carries disk, Dockerfile,
compatibility-source, baked-compatibility-file, package-inventory, and
normalized-rootfs hashes; the exact package inventory; builder version;
toolchain result; source commit; and measured rootfs size. The workflow verifies
a byte-range response and the ext2 superblock magic.

GitHub Release delivery is the provenance boundary, not the browser runtime
origin. Direct Release responses do not expose the CORS contract required by
CheerpX, so the browser path is:

```text
immutable GitHub Release
  -> stage-vm-image.mjs (checksum + manifest + disk, initial + 8 retries)
  -> validate profile/version/size/SHA/source commit/toolchain result
  -> dist/vm-images/<versioned disk>
  -> finalize dist/release.json with exact app and image provenance
  -> Firebase Hosting /vm-images/<versioned disk>
  -> CheerpX.HttpBytesDevice
```

Firebase Hosting is configured for cross-origin access, cross-origin resource
policy, byte ranges, and immutable caching on `/vm-images/**`. The staging
script refuses to place a partial, wrong-sized, or wrong-hash image in `dist`.
Release publication, Firebase mirroring, and the real-Chrome runtime gate are
separate facts. None implies another. rc3's immutable Release and Firebase
byte-range mirror are verified. Its real-Chrome modern Node/npm lifecycle did
not complete reliably, so the runtime gate failed and the active default
remains the official Debian 10 image. The precise internal cause is not proven.

The image includes a broad coding baseline: shell and process tools, Git and SSH
clients, TLS/network diagnostics, Node.js 24 with npm/pnpm/Yarn, Python 3.14 and
its packaging tools, Go 1.26, C/C++ tools, archives, search tools, editors,
SQLite, and PTY utilities. Inclusion in a Dockerfile is not proof that a tool
runs under CheerpX.

Alpine/musl alone did not fix a CheerpX 1.3.9 hang during Node's native
teardown. rc3 therefore supplies a root-owned preload and N-API cleanup addon.
The preload records Node's final status and flushes the compile cache; the addon
calls `_exit(status)` before the broken teardown path. Workers skip the hook and
child processes inherit it. This preserves tested exit behavior but bypasses
later native cleanup, so applications must close durable native resources
before returning. Login shells receive the variables from
`/etc/profile.d/sparkrun-node.sh`; non-login CheerpX launches receive the same
values from `WebVmBackend.runOptions()`.

The baked toolchain gate therefore checks natural and explicit Node exits,
uncaught failures, exit listeners, worker threads, `child_process.fork`, exact
200 KiB stdout delivery, a later Node command, all three package managers,
Python threads, a parked POSIX condition-variable thread, C, Go, SQLite, and a
PTY. rc3 did not pass that promotion gate. A future image must pass the entire
suite under its selected runtime in Chrome before promotion.

Installed-tool changes are delivered as a new immutable image and environment
identifier. Runtime package installation is useful during a session, but it is
not the reproducible source of truth.

## What is deliberately not promised yet

- A live Linux process surviving a browser/tab crash.
- Recovery after the user clears all data for the SparkRun origin.
- Modern Chrome running inside the 32-bit guest.
- Any installed tool's CheerpX compatibility before its browser smoke passes.
- A stable migration path from the prototype's localStorage/IndexedDB schema.
- Multi-user isolation, collaboration, or server-side key custody.
- Pi as the production browser harness; the decision and entry criteria are in
  [`DECISIONS.md`](./DECISIONS.md).
- BrowserPod as a production runtime before its named gates pass.
- Automatic runtime failover or a merged live filesystem across providers.
