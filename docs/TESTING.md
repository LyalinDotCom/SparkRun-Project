# Testing SparkRun

SparkRun is only working when the complete browser loop works: the app loads,
the VM boots, a model uses real tools, files persist, a server accepts a
connection, the terminal remains interactive, and the system can resume after a
restart. A green TypeScript build is necessary, but it is not an end-to-end
result.

This document defines the release gates for the current experimental system.

## Current verification status

**Verified baseline:** the existing app path has completed Chrome-driven app
creation, CheerpX boot, Tailscale enrollment, in-VM server startup, health
checking, and an outer-Chrome connection.

**August 28 rebuild checkpoint:** current Chrome proved CheerpX boot, root
terminal commands, a terminal-created file surviving workspace snapshot and VM
restart, Tailscale enrollment, supervised server bind/PID readiness, and an
outer-Chrome `GET /` recorded as `200` by the guest. A current Gemini 3.7 Flash
coding turn did not reach tools: app attempt one timed out and app attempt two
ended in an unexplained terminal 400. A separate direct SDK probe independently
observed provider high demand. The complete rebuilt model-to-code flow therefore
remains a promotion gate. See
[`CHECKPOINT-2026-08-28.md`](CHECKPOINT-2026-08-28.md).

**Implemented and automated:** the current suite covers the Codex-inspired
workbench, harness continuation, Browser Vault-only project recovery, terminal
metadata, exact reset targets, project deletion races, non-web tasks, command
completion markers, timeout disposal, exact Gemini retry semantics, and VM
image staging integrity. Run `npm test` for the current count; this document
does not freeze a test total that changes with every hardening pass.

**Rejected image:** Alpine `2026.08.27-rc3` has a published immutable GitHub
Release and a verified 1600 MiB Firebase byte-range mirror, but its modern
Node/npm command lifecycle did not complete reliably in the real-Chrome
CheerpX gate. It is not eligible for promotion. The matrix below is retained as
the required evidence for future candidates and as a reproducible rc3 diagnostic.

## Fast local checks

Run these for every code change:

```sh
npm ci
npm test
rm -rf dist
npm run build
```

`npm ci` verifies that the committed lockfile is sufficient. Removing `dist`
before the production build prevents a stale artifact from hiding a broken or
missing build.

The test suite must leave no unhandled promise rejections, IndexedDB
`ConstraintError`s, React `act(...)` warnings caused by application races, or
unexpected console errors. A passing assertion count with asynchronous errors
is a failure.

## Test layers

### 1. Pure unit tests

These tests run without a real browser VM and should be fast enough for every
edit.

- path normalization and workspace escape rejection;
- secret-file recognition and output redaction;
- exact replacement semantics and mixed line endings;
- malformed or missing function-call arguments;
- catastrophic command checks;
- local-folder path traversal rejection and writes confined to the explicitly
  selected directory;
- retry classification, abort behavior, delay cap, and exactly eight retries;
- background Interaction queued/in-progress polling without duplicate create;
- persisted pending IDs, server cancellation, overall turn timeout, and the
  terminal-response/Stop race;
- model turn budget and no-tool completion;
- coding-session serialization, fresh bounded provider episodes across user
  requests, stateful continuation within a tool run, and compact recovery that
  omits large file/directory outputs;
- archive metadata and SHA-256 calculation;
- Browser Vault project/conversation transactions;
- two-phase checkpoint commit and torn-write recovery;
- concurrent initialization across multiple IndexedDB connections;
- project isolation and stale asynchronous completion handling.

Use fake timers for backoff tests. A retry test should prove both the number of
attempts and that SDK retries are disabled.

### 2. React/jsdom integration tests

These cover UI orchestration with mocked Gemini and VM boundaries:

- setup to workbench transition;
- one active conversation created under concurrent startup/build events;
- project and conversation switching without history bleed;
- docked terminal opening without blocking the Build action;
- cancellation during model, VM boot, and tool execution;
- snapshot status and recoverable checkpoint errors;
- restart versus workspace reset versus environment reset copy;
- inaccessible/expired `previous_interaction_id` recovery;
- no duplicate event rendering or state updates after unmount;
- terminal history limits and secret redaction.

The test environment must provide intentional shims for browser facilities used
by xterm and storage, such as `matchMedia`, canvas measurement, `ResizeObserver`,
and IndexedDB. Shims should be minimal and must not turn a failing application
contract into a false pass.

### 3. Production-build smoke

The production bundle must:

- type-check and compile from a clean checkout;
- contain the expected build SHA and timestamp;
- report the same CheerpX version at build time and runtime;
- serve the required COOP/COEP headers;
- load the disk image and CheerpX runtime without cross-origin failures;
- contain no source-map or environment artifact that exposes a secret.

Bundle-size changes are reviewed. The goal is not an arbitrary small number;
the goal is to catch accidental inclusion of Node-only packages, duplicate
runtimes, or an entire toolchain in the JavaScript bundle.

### 4. Standalone CheerpX diagnostics

Use `/diag.html` before changing product code for a machine-specific VM
failure. It isolates CheerpX from React, Gemini, and most SparkRun orchestration.

Run:

- basic mount/write/read/append/redirection/background/Python tests;
- app-config tests without a real tailnet;
- Tailscale-key tests with a disposable key;
- the write-during-Tailscale-activation race test;
- the historical no-`WebDevice` comparison when filesystem behavior regresses.

If diagnostics fail, debug the runtime, image, browser, or machine. If
diagnostics pass and SparkRun fails, debug SparkRun. Do not ship a speculative
application workaround without a focused reproducer.

### 5. Real Chrome end-to-end test

This gate uses Chrome, not jsdom and not Safari. CheerpX execution, cross-origin
isolation, IndexedDB scheduling, xterm input, Tailscale networking, and popup
behavior need a real browser.

From a clean origin:

1. Load the local production build in Chrome.
2. Enter disposable Gemini and Tailscale credentials without printing them.
3. Create a project from the default experience.
4. Ask Gemini to inspect the empty workspace and build a small app.
5. Confirm real tool calls write files and execute a relevant build/test.
6. Start the in-VM server and wait for its actual port record.
7. Connect to the preview from outer Chrome and verify a known response marker.
8. Run a command through the xterm terminal, including Ctrl-C on a foreground
   process.
9. Modify a file in the terminal, take a snapshot, and restart the VM.
10. Confirm the edit, conversation, terminal metadata, and installed environment
    survive according to the reset matrix.
11. Continue the same conversation and verify the model sees current files.
12. Create a second project and prove that neither files nor conversation events
    bleed between projects.
13. Exercise Stop, transient API retry, server-start failure, and Tailnet retry.
14. Delete a disposable project and prove late asynchronous work cannot recreate
    it. Separately, clear origin site data in a disposable browser profile and
    verify all local state is gone.

Capture timestamps and diagnostics for the VM boot, Tailscale transitions,
server launch, bind certificate/PID check, and outer-browser request. Slow
CheerpX scheduling is expected; invented success is not.

Do not use a VM-internal loopback request as the static-server release gate.
With CheerpX 1.3.9 plus its userspace Tailnet, a second cold Python probe can
miss the command-proof watchdog and an in-process loopback GET can wedge the
Tailscale stream. The built-in server writes `server.ready` only after its
synchronous bind succeeds; SparkRun then checks that its tracked PID is alive.
The actual HTTP proof is Chrome loading the Tailnet URL and the server log
showing the request.

If diagnostics record `memory access out of bounds` in CheerpX's
`tcp_input`/`tcp_bind` path, the browser-side Tailnet runtime is no longer
reusable in that page. Verify that Retry Tailnet asks for a page reload instead
of blaming the auth key, then use Restart VM: it must checkpoint first and
reload the page so Browser Vault can restore the same files into a clean
network runtime.

Use a pinned [Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)
binary for automated runs. Manual release validation should also cover the
current stable Chrome used by real users.

## Custom-image release gate

The rejected rc3 image is Alpine Linux 3.24.1 with musl on `linux/386`, with its
architecture-specific base pinned by digest. A future candidate must pass all
rows below inside its selected runtime in Chrome, not merely in Docker.

### Build provenance

For every image artifact, record:

- source commit and clean/dirty state;
- Dockerfile path and SHA-256;
- pinned base digest;
- container builder and version;
- exact Alpine package inventory;
- ext2 byte size and SHA-256;
- measured rootfs size and normalized rootfs-manifest SHA-256;
- compatibility-source hashes and baked Node addon/preload hashes;
- ownership and modes for the Node compatibility files and compile cache;
- build log and software bill of materials;
- CheerpX version used for the browser smoke.

Build the same source twice on a clean Linux builder. Investigate any differing
artifact hash. If ext2 metadata prevents byte-for-byte reproducibility, document
the nondeterministic fields and compare a normalized filesystem manifest. Do not
call a build reproducible without evidence.

CheerpX requires 32-bit x86 and limits custom images to 2 GB. rc3 uses a 1600
MiB ext2 revision-0 container. The pipeline must fail before publication when
the architecture, measured free space, filesystem revision, ownership, or size
constraint is wrong. See the official
[custom-image guide](https://cheerpx.io/docs/guides/custom-images).

### Publication and browser-delivery gate

GitHub Pages is not an image host for a 1600 MiB artifact. The workflow instead
publishes a versioned GitHub Release `vm-image-<version>` containing:

- the ext2 image and `disk.sha256`;
- a provenance manifest with source commit, measured rootfs size, disk,
  Dockerfile, package-inventory, and rootfs-manifest hashes;
- the exact Alpine package inventory and normalized rootfs manifest;
- Node compatibility source hashes and baked-file hashes;
- Docker builder version and toolchain smoke result.

The tag and assets become immutable when the Release leaves draft state. A
rerun for the same version must prove that the tag points at the same commit and
that every expected asset has the exact size. Otherwise it fails and requires a
new image version.

After publication, require an HTTP 206 response for bytes 1024–1087, exactly 64
returned bytes, and ext2 magic `53ef` at bytes 56–57 of that range. This proves
range delivery reaches the expected superblock; it does not prove CheerpX can
run the image.

Direct GitHub Release responses do not provide the browser CORS contract needed
by `CheerpX.HttpBytesDevice`. Before Firebase deployment:

1. require a committed, clean worktree and record its full app commit;
2. build `dist/release.json` with the package-lock hash, app asset inventory,
   CheerpX pin, and exact default/candidate disk profiles;
3. fetch `disk.sha256`, `manifest.json`, and the image from the exact versioned
   Release, giving each network download one initial attempt plus exactly eight
   retries;
4. require the published manifest to link profile, version, filename, size,
   disk hash, source commit, and passing toolchain/Node conformance;
5. confirm the verified image lands at `dist/vm-images/<diskFile>` only after a
   complete download, then finalize `dist/release.json` with its provenance;
6. run the fail-closed release verifier and Firebase predeploy verifier;
7. deploy and require HTTP 206 range behavior plus the configured CORS,
   cross-origin resource policy, and immutable-cache headers from
   `/vm-images/<diskFile>`;
8. boot that Firebase URL through `CheerpX.HttpBytesDevice` in real Chrome.

Do not call Release publication, Firebase mirroring, or Chrome validation
complete without captured evidence for each separate boundary.

The dedicated browser probe is:

```text
/?vm-smoke&image=candidate&probe=release-gate
```

It parses and validates the complete baked toolchain JSON, then runs the
fail-closed command-timeout probe last because that probe disposes the VM.
Explicit probes automatically receive a unique IndexedDB suffix. This is not a
substitute for a separate candidate standard smoke that writes and reads the
workspace, starts the server, connects Tailscale, and receives an outer-browser
request.

### Guest tool matrix

Run each check through the same CheerpX command path used by SparkRun:

| Area | Minimum proof |
| --- | --- |
| Operating system | `/etc/os-release` identifies Alpine 3.24.1; architecture is i386/i686; libc is musl |
| Shell/processes | Bash script, pipes, redirection, signals, foreground/background process, timeout cleanup |
| Filesystem | text, binary, dotfile, symlink, empty directory, modes, archive/restore, workspace remount |
| Git/SSH | local repository lifecycle; HTTPS clone of a fixture; SSH client configuration parse without a private key |
| TLS/DNS/network | DNS lookup and HTTPS `curl`/`wget`; expected failure is clear without a Tailscale exit node |
| Node/npm/pnpm/Yarn | exact versions; natural/explicit/failure exits; final exit-listener status; compile-cache disabled; worker; fork; 200 KiB stdout; later command; npm local install/build fixture; pnpm/Yarn version and clean-exit checks |
| Python | exact version; threads; virtual environment; pinned fixture; tests and HTTP server |
| Go | exact version; compile and run a fixture; any hang or runtime panic blocks promotion |
| Native toolchain | compile and run C; create/join a thread; wake and join a thread parked on a POSIX condition variable; exercise `make` or the selected build driver |
| Search/data tools | `rg`, `find`, `jq`, archive tools, SQLite create/query/export |
| Editor/terminal | xterm input, resize, Unicode, paste, arrow keys, Ctrl-C, and exit status |
| Server | bind selected port, write state outside workspace, bind certificate + live PID, outer Chrome Tailscale request and request-log evidence |

The Node matrix is a release blocker because rc3 intentionally exits through a
root-owned N-API cleanup hook before CheerpX's broken native teardown path.
Tests must prove user `exit` handlers finish and the final status is preserved,
while documentation continues to warn that later native cleanup is bypassed.
Confirm the preload is applied to non-login commands as well as interactive
login shells.

Do not use `ping` as a network gate; upstream WebVM does not support the ICMP
path it needs. Use application-layer checks such as HTTPS.

Modern Chrome is not expected inside the i386 guest because Chrome for Testing
does not publish a Linux 32-bit binary. Headless browser validation runs in the
outer integration environment and connects to the guest server. If a different
guest browser is proposed, give it its own compatibility and security gate.

## Persistence and recovery scenarios

Each scenario begins with a project containing text, binary data, a dotfile, a
symlink, an empty directory, installed dependencies, conversation history, and
terminal history.

| Failure or action | Expected outcome |
| --- | --- |
| Normal reload | Workspace and UI state resume without restoration work |
| VM restart | Processes are lost; files, environment overlay, and vault remain |
| Crash during checkpoint write | Prior committed head remains selected |
| Corrupt/delete project workspace DB | Restore from latest committed vault archive |
| Restore a checkpoint | Extract under `/tmp`, validate, then copy into the healthy workspace inode; never untar directly into the directory mount |
| Reset workspace | Project cache is deleted and latest committed vault archive restores after reload |
| Reset VM caches | Root overlay is recreated and project restores from the vault; first boot is slower |
| Expired Gemini interaction | Resume from a compact saved transcript and inspect only needed workspace files |
| Reload/Stop during background Gemini work | Cancel the persisted pending interaction before reconstruction; never execute late tool calls |
| Storage quota exhaustion | Save fails visibly; prior checkpoint remains valid |
| Clear this origin's site data | All local data is lost, by browser design |
| Switch project during async initialization | No events or files land in the wrong project |

There is no backwards-compatibility release gate for the prototype's storage
schema. This release may deliberately reset it. Once the new format is
declared stable, any future migration promise must be a separate, explicit
decision with fixtures and rollback tests.

## API retry conformance

For every SparkRun-owned operation that is classified as retryable:

1. make attempts observable without logging credentials or request bodies;
2. disable overlapping SDK retry behavior;
3. prove initial call plus eight retries equals nine maximum attempts;
4. retry only classified transient failures;
5. honor user abort and the absolute turn deadline during the request and
   during backoff; these control-plane exits may preempt the retry allowance and
   must not be reported as API-retry exhaustion;
6. cap backoff and request time;
7. avoid replaying non-idempotent work;
8. report the final failure with enough context to act;
9. retain and reconcile an unconfirmed background-cancellation ID before any
   new provider execution.

The Gemini conformance suite must cover 408, 429, 5xx, transport failure,
permanent 4xx, abort, timeout, and a failure followed by success. The VM-image
checksum, Release-manifest, and disk downloads must prove the same nine-attempt
ceiling; disk failures must clean partial files. New API clients cannot ship
without equivalent evidence or a documented state-reconciliation design.

## Credentialed tests

Never commit real API keys, Tailnet auth keys, provider responses containing
source code, or a populated `.env` file.

- Unit and CI tests use deterministic fakes.
- Manual end-to-end tests use short-lived, tagged, ephemeral Tailscale keys and
  a disposable provider key where possible.
- Test logs record key presence and redacted length at most, never the value.
- A failure bundle is reviewed for secrets before sharing.
- Revoke the Tailscale key after a release run and remove unexpected nodes.

## Deployment gate

Deploy only after all required rows pass on the exact commit:

```sh
npm run release:deploy
```

For a two-step handoff, use `npm run release:prepare` followed by
`firebase deploy --only hosting`. Both paths require a committed, clean
worktree. `release:prepare` runs the full test suite before building and staging;
Firebase's predeploy hook reruns `npm run release:verify` against the full app
and image manifest.

Then verify:

- the live HTML references the JavaScript bundle in local `dist`;
- build SHA and timestamp match the intended release;
- `dist/release.json` names the full app commit and unchanged asset inventory;
- pinned and runtime CheerpX versions agree;
- COOP/COEP headers are present;
- `/`, `/index.html`, `/diag.html`, and `/release.json` return
  `Cache-Control: no-cache`;
- content-hashed `/assets/**` return a one-year immutable cache policy;
- the live `/vm-images/<diskFile>` has the same size and SHA-256 as the Release
  asset staged locally;
- the image endpoint returns byte ranges and its CORS, cross-origin resource
  policy, and immutable-cache headers;
- a VM-image CORS preflight allows `Range`, `If-Range`, and
  `GET`/`HEAD`/`OPTIONS`;
- a nonexistent `/vm-images/*.ext2` returns 404, never the SPA HTML with an
  immutable image cache header;
- `/diag.html` is the expected version;
- one real Chrome smoke creates a server and receives a connection.

A Firebase “deploy complete” message proves upload, not application health.

## Release evidence template

Record this in the release or pull request:

```text
Commit:
App tests:
Production build:
Bundle review:
Image SHA-256 / manifest:
Release tag and asset verification:
Staged/Firebase image SHA-256:
Firebase range/CORS/cache headers:
CheerpX version:
Chrome for Testing version:
Clean-origin E2E:
Tailscale preview connection:
Persistence/restart scenarios:
Known failures or waived gates:
Reviewer:
```

Do not mark a waived gate as passed. Explain the limitation in the UI and
release notes instead.
