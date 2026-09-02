# SparkRun

SparkRun is a browser-native coding workbench where Gemini gets a real Linux
computer—files, a root shell, development tools, servers, and an interactive
terminal—inside your Chrome tab. The working copy runs locally in a CheerpX
WebAssembly VM, Gemini 3.7 Flash drives it through explicit coding tools, and
Tailscale can expose the result at a private URL without a remote build machine.

> **Experimental software.** The workbench and coding harness are implemented,
> but browser-VM behavior is promoted only after it passes the release gates in
> [`docs/TESTING.md`](docs/TESTING.md). Alpine `2026.08.27-rc3` failed its
> modern Node/npm gate in real Chrome and is rejected for promotion. BrowserPod
> is a deferred concept with no implemented adapter, not a release runtime.

## Status at a glance

| Track | Status | What that means |
| --- | --- | --- |
| Workbench and coding harness | **Implemented; local checkpoint ready** | The UI, Interactions harness, conversations, Browser Vault, managed previews, and xterm are automated. Chrome proved the VM, terminal, persistence, Tailnet, server, and outer-browser request. The August 28 live Gemini turn did not complete; a separate direct SDK probe observed provider high demand, while the app's terminal 400 remains unexplained. |
| Default Linux environment | **Verified compatibility baseline** | The app still selects the official Debian 10 WebVM disk. Debian 10 is end-of-life and does not satisfy the long-term modern-toolchain goal. |
| Custom coding image `2026.08.27-rc3` | **Rejected for promotion** | Its immutable Release, provenance, container checks, and Firebase byte-range mirror are verified. In real Chrome, the modern Node/npm command lifecycle did not complete reliably. |
| BrowserPod runtime | **Deferred; not implemented** | It remains a design concept until live-key, licensing, process-control, portal/file-bridge, and security gates pass at the real browser boundary. |
| Public site | **May lag this checkout** | Use Setup → Diagnostics to compare the deployed build SHA, timestamp, CheerpX pin, and selected disk with this repository. |

The detailed definitions of verified, candidate, rejected, and planned behavior live in
[the architecture document](docs/ARCHITECTURE.md#status-vocabulary).

Each release selects one canonical runtime and one live project filesystem.
SparkRun does not hide failures by mixing CheerpX and BrowserPod filesystem
trees or command state. Browser Vault remains outside either runtime as the
independent checkpoint and recovery authority.

For a visual walk-through of the real Chrome session, see the
[screenshot tour](docs/SCREENSHOT_TOUR.md). The complete verified capability,
limitation, and test handoff is in the [August 28 checkpoint
report](docs/CHECKPOINT-2026-08-28.md); peer-review findings are dispositioned
in the [curated bug-bash report](docs/BUG_BASH.md).

## How it works

```text
You
 |
 v
Outer Chrome tab: React workbench + xterm + Browser Vault
 |                         |
 | HTTPS                   | validated file/shell/preview tools
 v                         v
Gemini Interactions     CheerpX 1.3.9 Linux guest
API                     - 32-bit x86 userland in WebAssembly
                        - per-project /workspace
                        - baseline shell, Python, and servers
                                   |
                                   v
                        userspace Tailscale -> private preview URL
```

The outer browser owns the user interface, credentials, Gemini requests,
browser storage, and preview checks. The CheerpX guest owns the project files,
shell commands, packages, and server processes. Generated code does not receive
a mount of the host filesystem. An optional local-folder sync copies selected
project files through an explicitly granted browser directory handle; the model
never receives that handle.

The workbench deliberately uses progressive disclosure instead of a wall of VM
logs:

- the left rail holds projects and their conversations;
- the center keeps the chat, compact agent/tool activity, and coding composer in
  one continuous stream;
- the model selector is visible at the composer—3.7 Flash is the only enabled
  model in this release;
- the collapsible Environment inspector exposes Preview, Files, and Activity
  only when the user needs the lower-level detail;
- the terminal is a full-width, resizable bottom dock (toolbar button or
  Ctrl/Cmd+`) with a real xterm.js root shell and a Start VM control; the VM
  boots automatically as soon as a project opens in the workbench;
- detailed commands and output remain expandable, while milestones and failures
  stay readable at a glance.

The coding harness uses `@google/genai` 2.19.0 and the
[Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview).
It uses `previous_interaction_id` for efficient tool continuation within one
submitted request and also saves a local transcript because provider-side
interactions have finite retention. Each later user request starts a fresh,
bounded provider episode from the compact durable transcript and current VM
workspace. This prevents a surgical follow-up from inheriting complete prior
file bodies and hidden reasoning retained by an unbounded provider chain.
High-thinking turns use
[background execution](https://ai.google.dev/gemini-api/docs/background-execution):
SparkRun persists the returned Interaction ID, polls it to completion, and
cancels it on Stop. Every classified transient `create`, `get`, or `cancel`
operation gets one initial attempt plus **exactly eight retries** while its run
remains active. A user Stop or the absolute turn deadline is a control-plane
termination and may end an operation earlier; it is never mislabeled as an
API-retry exhaustion. SDK-level retries are disabled so the real maximum is
nine attempts, not nine multiplied by a hidden second retry loop. A failed
remote cancellation keeps its Interaction ID in Browser Vault and blocks a new
provider execution until cancellation is reconciled. **Provider execution resubmission.** On September 2, 2026 the live probes
showed that an accepted `gemini-3.7-flash` background Interaction dies with
`500 high demand` at a roughly constant rate (about half survive 20 s; long
generations never finished, synchronous and streaming requests died the same
way), after which that id answers `500` or `400 Request contains an invalid
argument` forever, including to `cancel`. The harness therefore treats the
first "high demand" `5xx` from a poll as the execution's death notice, clears
the id without demanding a cancellation, and resubmits the identical turn to
the same model with backoff, up to eight times inside the turn deadline. The
agent is instructed to keep each response short and to build long files with
`write_file` plus `append_file` parts so one killed response costs one part.
The transport retry contract below is unchanged for transient errors.
Redacted per-interaction telemetry records create/poll time,
actual request counts, provider timestamps, and reported input/output/thought
tokens without storing prompt or tool bodies in diagnostics.

### Why the Linux VM is unusual

[WebVM](https://github.com/leaningtech/webvm) is not a conventional cloud VM.
CheerpX translates 32-bit x86 instructions to WebAssembly, emulates Linux system
calls, and provides virtual filesystems in the page. This lets SparkRun run an
unmodified Linux userland without booting a kernel or sending execution to a
server.

That architecture has real constraints:

- CheerpX custom images must use 32-bit x86 (`i386`/`i686`), and ext2 images are
  limited to 2 GB. An `amd64` binary cannot simply be copied into the guest.
- Modern Chrome for Testing publishes Linux 64-bit builds, not Linux i386.
  Headless browser testing therefore runs in the **outer Chrome**, against the
  server inside the guest.
- WebVM's userspace network does not support the ICMP path used by `ping`.
  Network checks use `curl`, `wget`, DNS tools, and real application requests.
- Public internet egress from the guest requires a Tailscale exit node. Joining
  a tailnet by itself only provides tailnet connectivity.

See the official [CheerpX custom-image guide](https://cheerpx.io/docs/guides/custom-images)
and [Chrome for Testing asset list](https://googlechromelabs.github.io/chrome-for-testing/).

## Run it locally

### Prerequisites

- Current Google Chrome. Other browsers are not part of the present release
  gate.
- Node.js `>=22.12.0` and npm. CI is pinned to Node.js 24.14.1.
- IndexedDB and WebAssembly enabled.
- A [Google AI Studio API key](https://aistudio.google.com/api-keys) allowed to
  use `gemini-3.7-flash`.
- For a reachable private preview, a
  [Tailscale auth key](https://login.tailscale.com/admin/settings/keys) and a
  host computer connected to the same tailnet.
- The authenticated Firebase CLI is needed only if you intend to deploy.

Clone and start the app:

```sh
git clone https://github.com/LyalinDotCom/SparkRun-Project.git
cd SparkRun-Project
npm ci
npm run dev
```

Open the Vite URL printed in the terminal. Vite supplies the cross-origin
isolation headers CheerpX needs in development.

### Credentials

Enter credentials in SparkRun's Setup screen:

1. Use a Google AI key for model requests.
2. Use a Tailscale **auth key**, not an API access token, for VM enrollment.
3. For repeated browser-VM starts, the current prototype expects a reusable,
   ephemeral key. Enable pre-approval when your tailnet requires device
   approval. A dedicated tag and restrictive tailnet policy are strongly
   recommended.
4. Leave “Remember keys on this browser” off unless you accept local browser
   storage of those credentials.

Never commit a populated `.env` file. The normal app reads keys from the Setup
screen, and `/?vm-smoke` only reuses a key the user explicitly chose to save
there. It does not accept credentials through a URL or Vite environment
variable. The committed [`.env.example`](.env.example) contains empty,
unprefixed names for future maintainer-side automation; those values are not
imported into the browser bundle. Never add a `VITE_` prefix to a secret because
Vite exposes such values to client JavaScript.

Read [Tailscale's auth-key guidance](https://tailscale.com/docs/features/access-control/auth-keys)
before giving an automated guest access to a real tailnet.

## The default creation-to-preview flow

1. Create or select a project and start a conversation.
2. SparkRun opens the project's Browser Vault record and boots CheerpX with a
   per-project IndexedDB workspace and a versioned root overlay.
3. Gemini treats the latest request as the active objective, inspects only the
   minimum unknown state, and uses typed tools to read, write, replace, list,
   run commands, and start a managed preview when the task needs one.
4. File tools remain inside `/workspace/site`; shell commands can use the full
   guest. The verified Debian baseline provides a root shell, Python, and core
   utilities. Modern Node/npm/Go are not guaranteed until a replacement image
   passes the Chrome runtime gate.
5. A web project calls `start_preview` with a foreground server command and an
   exact port. A plain `index.html` receives a built-in Python static-server
   fallback.
6. SparkRun activates Tailscale only after normal workspace writes and starts
   the server under supervision. The built-in static server proves readiness
   with its bind certificate and tracked PID; an agent-started preview is
   proven by the outer browser receiving an HTTP response from the tailnet
   URL (no guest loopback request, which can wedge CheerpX's network stack).
   Opening the reported URL in outer Chrome and observing its request in the
   server log is the end-to-end connection proof.
7. The app saves the harness session after model and tool steps and checkpoints
   the project after the run, including on recoverable failures.

The workbench exposes conversations, agent/tool events, generated files,
diagnostics, storage state, snapshots, VM restart controls, and a real xterm
terminal (docked at the bottom, resizable, Ctrl/Cmd+`) with raw input, resize,
arrow keys, paste, and Ctrl-C. These surfaces
are implemented; the release gate still requires their complete real-Chrome
flow rather than treating unit coverage as browser proof.

## Persistence, reset, and resume

SparkRun separates the operating environment from the project and keeps an
independent recovery copy outside the guest filesystem:

| Layer | Role |
| --- | --- |
| Immutable ext2 image | Reproducible operating system and preinstalled tools |
| Versioned root-overlay IndexedDB | Replaceable environment changes and caches |
| Per-project workspace IndexedDB | Fast working copy at `/workspace/site` |
| Browser Vault IndexedDB | Projects, conversations, harness sessions, terminal metadata, and checkpoint archives |

A normal checkpoint is a SHA-256-recorded `tar.gz` of `/workspace/site`. It
preserves binary files, dotfiles, modes, symlinks, and empty directories. The
vault commits checkpoints in two phases so an interrupted write cannot become
the project head. Restore extracts and validates the archive under the root
overlay at `/tmp/sparkrun`, then copies it into the healthy workspace inode;
real Chrome proved that extracting tar directly into CheerpX's directory mount
can wedge the filesystem.

The reset contract—still part of the Chrome release gate—is:

| Operation | Processes | Environment overlay | Project | Browser Vault |
| --- | --- | --- | --- | --- |
| Restart VM | Lost | Preserved | Preserved | Preserved |
| Reset workspace | Lost | Preserved | Cache deleted; latest committed checkpoint restores on reload | Preserved |
| Reset VM caches | Lost | Rebuilt from pinned image | Cache deleted; latest committed checkpoint restores on reload | Preserved |
| Delete project | Lost for the active project | Preserved | Deleted | Its project records are deleted |
| Clear this origin's site data | Lost | Deleted | Deleted | Deleted |

The resume contract reconstructs files, conversations, bounded provider
context, and terminal metadata. A normal reload or Restart VM reuses the
versioned root-overlay cache, so ad-hoc installed tools usually remain; Browser
Vault does not serialize or replay those installations, and Reset VM caches
removes them. Automated tests prove Browser Vault as
the authoritative recovery copy for stale or unidentified caches, while a
matching per-project cache keeps newer uncheckpointed edits. Tests also cover
active-project and terminal-scrollback restoration, harness-session
continuation, atomic checkpoint heads, and exact dynamic reset targets. The
full live-guest round trip and project isolation remain part of the real-Chrome
release gate. Resume does **not** mean freezing and restoring guest RAM or live
processes. Browser Vault is also not an off-device backup: clearing site data,
losing the browser profile, or changing origins can still erase it. Use source
control or another external backup for important work.

The rebuild does not migrate the prototype's old localStorage or IndexedDB
formats. There are no public users to migrate yet; the goal is one clean
storage contract before stability.

## Custom coding image

The currently selected VM disk is the official Debian 10 Buster WebVM image.
Buster is end-of-life, so it is a verified baseline rather than the target
environment.

The repository retains rejected rc3 artifact `2026.08.27-rc3`: Alpine Linux 3.24.1 with
musl for `linux/386`, based on the following architecture-specific digest:

```text
sha256:95a35dbffc3da87221f8b4eea3ed90cb52c634fedfdf4d22f3eb50e8883656cd
```

It includes bash and zsh, Git/SSH/LFS, TLS and network diagnostics, Node.js
24.18.1 with npm/pnpm/Yarn, Python 3.14 with pip/pipx, Go 1.26, C/C++ tools,
SQLite, tmux, search tools, archives, and process/port diagnostics. The image is
a 1600 MiB ext2 revision-0 filesystem, below CheerpX's 2 GB image limit and
Firebase Hosting's 2 GB per-file limit.

Alpine's musl C library removed the previous glibc baseline, but it did **not**
fix a CheerpX 1.3.9 hang during Node's native shutdown. rc3 therefore includes
a small, root-owned N-API addon and preload. The preload records Node's resolved
exit status, flushes Node's compile cache, and the addon calls `_exit(status)`
from an environment cleanup hook before the broken teardown path. User `exit`
handlers, workers, forked children, failure statuses, and large stdout are
covered by conformance tests.

This compatibility layer has a real caveat: `_exit` bypasses native cleanup
that would happen later. Node programs should close databases, sockets, and
other durable native resources before the event loop finishes. The guest runs
as root to make an autonomous coding environment practical; root is confined
to the browser VM, but can still destroy the guest, exhaust browser resources,
or reach anything allowed by its tailnet policy.

The pinned GitHub Actions workflow:

1. build the `linux/386` container;
2. run the Node compatibility matrix and Node, Python, POSIX-thread, C, Go,
   SQLite, PTY, and package-manager smoke fixtures;
3. inventory exact Alpine packages and the normalized root filesystem;
4. create and hash the 1600 MiB ext2 image;
5. publish a versioned immutable GitHub Release containing the disk, checksums,
   package/rootfs inventories, Docker version, toolchain result, and source
   provenance;
6. verify that the published asset supports byte ranges and contains the ext2
   magic at the expected superblock offset.

GitHub Pages cannot host an image this large. GitHub Release assets can, but
their direct responses do not expose the browser CORS contract CheerpX needs.
SparkRun therefore treats the Release as the immutable provenance source and
mirrors the exact verified bytes under Firebase Hosting at `/vm-images/`.

`npm run stage:vm-image` downloads `disk.sha256`, `manifest.json`, and—when it
is not already present in the verified cache—the disk. Each network download
gets one initial attempt plus exactly eight retries. Staging links the manifest
to the expected profile, version, filename, size, disk hash, source commit, and
toolchain/Node conformance result before atomically placing the image in
`dist/vm-images/`. It then advances the build-generated `dist/release.json`
from `built` to `staged` with the exact image provenance.

Passing the container workflow proves the recipe, provenance, and native
container checks. It does **not** prove CheerpX compatibility. Real-Chrome
measurements rejected rc3 for promotion: modern Node/npm commands did not
reliably reach completion under CheerpX. The precise internal failure boundary
is not yet proven, so the repository does not attribute it to npm, the compile
cache, or the exit preload. Modern headless Chrome remains an outer-host tool,
not an image package.

For rc3, the versioned
[GitHub Release](https://github.com/LyalinDotCom/SparkRun-Project/releases/tag/vm-image-2026.08.27-rc3)
and the 1600 MiB Firebase mirror are published, and the mirror's byte-range and
cross-origin headers have been verified. These artifacts remain useful as
reproducible evidence and diagnostics, but rc3 must not be selected as the
default or represented as a working modern Node/npm environment.

See [`vm-image/README.md`](vm-image/README.md) for the build contract and
[`vm-image/image.json`](vm-image/image.json) for machine-readable metadata.

On an x86 Linux host with Docker:

```sh
docker build --platform linux/386 -f vm-image/Dockerfile -t sparkrun-coding .
docker run --rm --platform linux/386 sparkrun-coding \
  /usr/local/bin/sparkrun-toolchain-check --json --smoke
```

The GitHub workflow is the canonical ext2 build because macOS cannot natively
mount and populate the Linux filesystem used by the pipeline.

## Development and verification

```sh
npm test          # Vitest unit and integration suite
npm run build     # Type-check and create production assets
npm run preview   # Serve dist with the required isolation headers
```

What the automated suite is expected to prove:

- type safety and a production build;
- workbench orchestration, project/conversation isolation, deletion races, and
  Browser Vault checkpoint transactions;
- harness-session continuation and recovery when a provider interaction has
  expired;
- the exact Gemini retry contract: one initial attempt and eight retries, with
  SDK retries disabled;
- command completion markers, trustworthy exit statuses, timeout disposal, and
  binary-safe file transfer;
- VM image staging retries, exact size, SHA-256 verification, and atomic
  placement;
- the fail-closed release manifest: full app commit, clean-worktree state,
  package-lock hash, app asset inventory, default/candidate disk identities,
  and exact staged image provenance.

Run the commands above for the current count and result. Documentation avoids a
hard-coded test total because the suite changes frequently. The Alpine rc3
image remains rejected even when every unit test passes.

Do not translate “the code compiles” into “the browser VM works.” The release
gate includes a clean-origin Chrome run that creates a project, lets Gemini use
real tools, starts a server, receives a connection from outer Chrome, exercises
the terminal, snapshots, restarts, resumes the conversation, and proves project
isolation.

### Diagnostics

- `/diag.html` loads CheerpX without React or Gemini and isolates mount, file,
  process, Python, Tailnet, and activation-race behavior.
- `/?vm-smoke` reuses an auth key explicitly saved through Setup, exercises the
  app's VM configuration, writes a minimal site, starts the server, checks it
  internally, and checks the private URL from the browser.
- `/?vm-smoke&image=candidate&probe=release-gate` retains the historical
  candidate query name and runs the baked rc3 toolchain
  JSON contract and then proves command timeout fails closed. Explicit probes
  automatically use fresh IndexedDB names; add `run=<label>` only when a stable,
  human-readable run identity helps evidence capture.
- Setup → Diagnostics shows build SHA/time and compares build-time versus
  runtime CheerpX versions.
- `GEMINI_API_KEY=… npx vitest run src/lib/geminiLive.probe.test.ts` runs the
  real harness, system instruction, tools, and Debian environment notes
  against an in-memory guest-like runtime, building a Three.js solar system and
  then editing it in a second episode. It is skipped without the key.
- `node scripts/probe-gemini-poll.mjs` and `node scripts/probe-gemini-long.mjs
  --mode sync|bg --thinking high --model …` characterize background-interaction
  deaths and long generations per model.
- `node scripts/probe-gemini.mjs` (maintainer-only; reads `GEMINI_API_KEY`
  from the environment or the untracked `.env`) replays the app's exact
  Interactions request shape from Node—system instruction, bounded function
  tools, `thinking_level`, background execution, and a `function_result`
  continuation—and prints the full provider error body. Run it first when the
  in-app coding turn ends in an unexplained 4xx.

The coding agent's system instruction includes the selected disk profile's
`agentEnvironmentNotes` (see [`src/lib/constants.ts`](src/lib/constants.ts)):
what is installed, what is missing, and that the guest has no public internet.
On the Debian baseline this steers the model toward static HTML/ES-module
projects that load libraries such as Three.js from a CDN import map instead of
burning turns on `npm`/Vite commands that cannot succeed there.

When a failure is machine-specific, run `/diag.html` before changing app code.
If diagnostics fail too, investigate the image, CheerpX, browser, or machine. If
they pass, investigate SparkRun orchestration.

The complete test matrix is in [`docs/TESTING.md`](docs/TESTING.md).

## Deployment

Firebase Hosting serves `dist/` and the COOP/COEP headers required by CheerpX:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The versioned image mirror under `/vm-images/` additionally receives CORS,
cross-origin resource policy, immutable caching, and byte-range delivery.
Single-byte `Range` requests are CORS-safelisted; the endpoint also explicitly
allows `Range`, `If-Range`, and `GET`/`HEAD`/`OPTIONS` so conditional or
multi-range clients can complete a preflight. A release must come from a
committed, clean worktree so `dist/release.json` can identify the full app
commit and exact asset inventory.

Firebase makes `/`, `/index.html`, `/diag.html`, and the stable deployment
metadata URL `/release.json` revalidate with `Cache-Control: no-cache`; Vite's
content-hashed `/assets/**` and the versioned `/vm-images/**` artifact use a
one-year immutable cache. The fail-closed release verifier pins those cache
rules together with COOP, COEP, and VM-image CORS so a configuration regression
stops deployment.

The preferred one-command deployment is:

```sh
npm run release:deploy
```

For a reviewable two-step handoff, prepare first and deploy the already verified
tree:

```sh
npm run release:prepare
firebase deploy --only hosting
```

`release:prepare` refuses a dirty worktree, runs the full test suite, builds the app, stages and validates
the published image manifest and bytes, and runs the final `dist` verifier.
Firebase also runs `npm run release:verify` as a fail-closed predeploy hook, so a
raw deploy cannot silently publish stale app files, a missing image, a changed
asset inventory, or an unlinked release manifest. Run `npm ci` first when
dependencies are not installed. Then verify the live origin:

```sh
LIVE_BUNDLE=$(curl -fsSL https://spark-run-poc.web.app/ \
  | grep -oE 'index-[A-Za-z0-9_-]+\.js' \
  | head -1)
test -n "$LIVE_BUNDLE"
test -f "dist/assets/$LIVE_BUNDLE"
curl -fsSI https://spark-run-poc.web.app/ \
  | grep -Ei 'cross-origin-(opener|embedder)-policy'

IMAGE_NAME=$(node -p "require('./vm-image/image.json').diskFile")
test -f "dist/vm-images/$IMAGE_NAME"
curl -fsSI "https://spark-run-poc.web.app/vm-images/$IMAGE_NAME" \
  | grep -Ei 'access-control-allow-origin|cross-origin-resource-policy|cache-control|accept-ranges'
test "$(curl -fsSL --range 1024-1087 \
  --output /dev/null --write-out '%{http_code}' \
  "https://spark-run-poc.web.app/vm-images/$IMAGE_NAME")" = 206
test "$(curl -sS --output /dev/null --write-out '%{http_code}' \
  https://spark-run-poc.web.app/vm-images/does-not-exist.ext2)" = 404
```

A successful Firebase upload is not an application health check. Finish with a
real Chrome creation-to-connection smoke on the deployed origin.

## Security and licensing

SparkRun runs model-selected commands as root **inside the guest**. Root in the
guest is not root on the host, but generated code can destroy guest state,
consume browser resources, and attack anything its tailnet policy permits it to
reach. File-tool confinement and secret redaction are defenses in depth, not a
general guarantee that arbitrary agent-generated code is safe.

Important boundaries:

- Gemini prompts, selected file contents, and tool results leave the browser
  for Google's API.
- Remembered keys are stored in the browser. Checkpoints are not encrypted and
  may contain secrets created from the terminal.
- A reusable Tailscale auth key is powerful. Use a dedicated tag, restrictive
  access policy, short expiry, and an ephemeral node; revoke it after testing.
- Public egress through a Tailscale exit node also creates an exfiltration path.
- Generated previews use a separate tailnet origin and must never be injected
  into SparkRun's privileged DOM.

Read [`docs/SECURITY.md`](docs/SECURITY.md) before connecting a valuable
tailnet or using proprietary source code.

SparkRun's source and associated documentation are available under the
[MIT License](LICENSE). That license covers SparkRun-authored material in this
repository; it does not relicense CheerpX, hosted runtime assets, Gemini,
Tailscale, Firebase, or any other third-party software or service.

That distinction matters because the
[WebVM repository](https://github.com/leaningtech/webvm) is Apache-2.0, while the
CheerpX runtime has separate terms. Leaning Technologies permits community use
for personal projects, FOSS projects, and technical evaluation, while many
organizational, commercial, self-hosted, redistribution, and OEM uses require a
commercial license. SparkRun's MIT license does not grant additional CheerpX
rights. Review the current [CheerpX licensing guide](https://cheerpx.io/docs/licensing)
and each service provider's terms before deployment or redistribution.

SparkRun is an independent experiment, not an official Google, Tailscale,
Leaning Technologies, or Firebase product.

## Roadmap

Near-term work is deliberately ordered by proof, not by feature count:

1. Select one replacement runtime and live filesystem only after its complete
   modern toolchain passes in Chrome; rc3 remains rejected evidence, not a
   fallback runtime.
2. Evaluate BrowserPod experimentally through live-key, licensing,
   process-control, portal/file-bridge, and security gates before considering
   it for that role.
3. Run and capture the complete deployed creation, preview, checkpoint, reload,
   resume, reset, and project-isolation flow.
4. Add explicit workspace export/import and a real off-device backup option.
5. Replace long-lived client credentials with a production-grade credential
   design and complete Content Security Policy/security review.
6. Reevaluate Pi after the runtime is stable; do not adopt an unfinished
   browser harness or regress Gemini Interactions/retry behavior to get it.

### Non-goals for this rebuild

- A remote SaaS build farm hidden behind the browser UI.
- Preserving live process memory across a tab or browser crash.
- Backwards compatibility with the one-user prototype storage schema.
- Multi-user collaboration or enterprise tenant isolation.
- Running modern Chrome inside a 32-bit guest without a supported binary.
- Public Tailscale Funnel hosting; SparkRun previews are private tailnet URLs.
- Claiming every Alpine package works under CheerpX merely because it installs.
- Automatic failover or filesystem merging between CheerpX and BrowserPod.
- Shipping Pi as the browser harness before its separate bake-off passes.

## Repository guide

- [`src/App.tsx`](src/App.tsx) — workbench UI and end-to-end orchestration.
- [`src/lib/geminiCodingHarness.ts`](src/lib/geminiCodingHarness.ts) — Gemini
  Interactions coding loop, recovery, timeouts, and retry policy.
- [`src/lib/codingHarness.ts`](src/lib/codingHarness.ts) — provider/runtime-neutral
  session and capability contracts.
- [`src/lib/codingHarnessTools.ts`](src/lib/codingHarnessTools.ts) — validated
  file, shell, and managed-preview tools.
- [`src/lib/browserVault.ts`](src/lib/browserVault.ts) — projects,
  conversations, sessions, terminal metadata, and checkpoint transactions.
- [`src/lib/webvm.ts`](src/lib/webvm.ts) — CheerpX filesystems, command/PTY
  bridge, Tailscale state, previews, health checks, and reset helpers.
- [`vm-image/`](vm-image/) — candidate Alpine coding image, Node compatibility
  layer, and toolchain checks.
- [`.github/workflows/vm-image.yml`](.github/workflows/vm-image.yml) — pinned
  candidate-image build and publication pipeline.
- [`scripts/stage-vm-image.mjs`](scripts/stage-vm-image.mjs) — verified Release
  download, provenance linking, and Firebase-staging bridge.
- [`scripts/verify-release-dist.mjs`](scripts/verify-release-dist.mjs) — clean
  source and immutable `dist/release.json` deployment gate.
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — pinned Node.js
  install, test, and production-build gate.
- [`public/diag.html`](public/diag.html) — standalone CheerpX reproducer.

## Deeper documentation

- [Architecture](docs/ARCHITECTURE.md) — component boundaries, data flow,
  persistence layers, reset semantics, and candidate image.
- [Security](docs/SECURITY.md) — trust boundaries, credentials, network risk,
  supply chain, and incident response.
- [Testing](docs/TESTING.md) — unit, browser, image, recovery, and deployment
  gates.
- [Decisions](docs/DECISIONS.md) — why the project chose CheerpX, Interactions,
  Browser Vault, exactly eight retries, outer Chrome, and not-yet-Pi.
