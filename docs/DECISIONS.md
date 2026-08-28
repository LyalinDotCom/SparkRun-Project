# SparkRun architecture decisions

This is a compact decision log for the clean rebuild. It records why the system
has its unusual boundaries and prevents future contributors from “simplifying”
away behavior that exists because of real browser failures.

Status values:

- **Accepted**: the direction is decided; implementation may still be in
  progress.
- **Candidate**: promising, but a named validation gate can still reject it.
- **Rejected**: evaluated at its named gate and not eligible for promotion in
  that revision; retained artifacts may still be useful evidence.
- **Deferred**: intentionally not part of this release.

## D-001 — Browser-first, local-first execution

**Status:** Accepted

**Decision:** SparkRun's primary coding computer is a CheerpX guest running in
the user's browser. The hosted React application orchestrates it; a remote build
server is not required for the core loop.

**Why:** This makes the system inspectable and personal. The user can watch the
same files, terminal, processes, and preview that the agent uses, while generated
code remains separated from the host filesystem.

**Consequences:** Browser storage, cross-origin isolation, memory pressure,
32-bit guest compatibility, and real-browser testing are core product concerns.
A future cloud runtime can implement the same `CodingRuntime` boundary, but it
must not silently replace the local execution promise.

## D-002 — Pin CheerpX; version the whole environment

**Status:** Accepted

**Decision:** Pin an exact CheerpX package version and compare it with the
runtime-loaded version. Name root-overlay databases with the environment and
CheerpX versions.

**Why:** `latest` turns a routine dependency install into an unreviewed VM
upgrade. A new runtime over an old overlay can produce failures that look like
project corruption.

**Consequences:** Runtime upgrades require focused diagnostics, unit tests, and
a real-Chrome end-to-end run. Old environment overlays are replaceable caches;
project recovery must not depend on them.

The current pin is CheerpX 1.3.9.

## D-003 — Evaluate an Alpine 3.24.1/i386 coding image

**Status:** Rejected for promotion (`2026.08.27-rc3`)

**Decision:** Build and evaluate an Alpine Linux 3.24.1 `linux/386` candidate
as a possible replacement for the end-of-life Debian 10 baseline. Pin its base image by
digest:

```text
sha256:95a35dbffc3da87221f8b4eea3ed90cb52c634fedfdf4d22f3eb50e8883656cd
```

Deliver the toolchain through a reviewed Dockerfile converted to an immutable
1600 MiB ext2 revision-0 artifact. Do not make startup-time package installation
the canonical build.

**Why:** A coding environment needs current TLS roots, shells, compilers,
package managers, network diagnostics, and process tools. Alpine publishes a
current 32-bit x86 userland with pinned Node.js 24, Python 3.14, and Go 1.26
packages. An immutable image makes those choices reviewable and reproducible.

Alpine/musl was a useful clean baseline but did not fix CheerpX 1.3.9 hanging
during Node's native platform teardown. Candidate rc3 therefore includes a
small, root-owned N-API cleanup addon and preload. It records Node's resolved
status, flushes the compile cache, and calls `_exit(status)` before the broken
path. `_exit` bypasses later native cleanup, so this is a tested compatibility
layer rather than a claim of normal Node teardown behavior.

**Gate outcome:** rc3's immutable publication, provenance, container checks,
and Firebase delivery passed. Its real-Chrome modern Node/npm command lifecycle
did not complete reliably, so rc3 failed the boundary that matters and is
rejected for promotion. The exact internal cause is unresolved; do not present
the compile cache, preload, or npm entrypoint as proven root cause. CheerpX requires 32-bit x86 and
limits images to 2 GB; the official
[custom-image guide](https://cheerpx.io/docs/guides/custom-images) is
authoritative.

**Consequences:** “Best available” means best tested 32-bit-compatible version,
not automatically the newest `amd64` release. Node exit semantics, workers,
forks, large output, package managers, Python/POSIX threads, C, Go, SQLite, and
PTY behavior must pass under CheerpX. Publication of the Release or Firebase
mirror is not runtime validation. rc3 remains a reproducible diagnostic
artifact, not a default or fallback environment. The official Debian disk
remains the current compatibility baseline until one replacement passes its
complete browser gate.

## D-004 — Keep projects independent from VM environments

**Status:** Accepted; implemented, browser gate pending

**Decision:** Separate four things:

1. immutable base image;
2. versioned root overlay for environment changes;
3. per-project IndexedDB workspace for fast resume;
4. Browser Vault for metadata, conversations, and authoritative recovery
   checkpoints independent of the runtime.

**Why:** One corrupted global workspace previously contaminated unrelated
projects. A VM reset also should not mean “delete the user's work.”

**Consequences:** Restart, reset workspace, reset environment, and factory reset
are distinct operations. A full project-tree checkpoint uses `tar.gz`, SHA-256,
and a two-phase head update. A preserved live workspace is an operational cache;
it must not override a committed Vault head when stale or unidentified. Browser
Vault protects against a broken or replaced runtime but not against clearing
origin data or losing the browser profile. A matching workspace marker proves
lineage rather than exact contents, so newer uncheckpointed edits remain in the
preserved cache. Boot verifies that cache by rewriting the same marker and fails
without cleaning if the write path is unhealthy.

## D-005 — No backwards-compatibility contract for the prototype

**Status:** Accepted

**Decision:** The clean rebuild may replace the prototype's localStorage,
IndexedDB, conversation, and image formats without migration.

**Why:** There is one active user and no public data contract. Carrying every
prototype workaround into the new architecture would make the durable format
harder to reason about before it has even shipped.

**Consequences:** The rebuild retains no transitional migration or legacy
checkpoint fallback. Make destructive upgrades explicit in release notes and
the UI. After the new contract is declared stable, future breaking changes
require an intentional migration decision and fixtures.

This decision does **not** authorize removing CheerpX corruption mitigations
without a focused reproducer. Runtime workarounds and user-data format promises
are different concerns.

## D-006 — Use Gemini Interactions through a SparkRun-owned harness

**Status:** Accepted; implemented

**Decision:** Use Gemini 3.7 Flash through `@google/genai` 2.19.0 and the
Interactions API. Keep the agent loop behind provider- and runtime-neutral
SparkRun contracts. Persist local transcripts and workspace state even when
using server-side `previous_interaction_id`. Scope provider continuation to one
submitted user request: tool turns chain statefully, while the next user
request starts a fresh provider episode from bounded durable context.

Use `background: true` for high-thinking model turns. Persist the returned
interaction ID before polling, retrieve it until it reaches a terminal state,
and cancel it on Stop. Keep short per-request transport timeouts separate from
the longer background-turn budget.

**Why:** Interactions exposes function calls and convenient server-side
continuation, but provider retention is finite and interaction settings are
turn-scoped. The opaque server chain also retains complete function-call
arguments and thoughts, so carrying it across coding requests can make a tiny
repair inherit an entire generated application. SparkRun needs recovery and
follow-up semantics that do not depend on one provider identifier remaining
valid or small.

Google documents that tools, system instruction, and generation configuration
must be sent again on each Interaction. See the
[Interactions API overview](https://ai.google.dev/gemini-api/docs/interactions-overview).

**Consequences:** Every new user request reconstructs compact context from the
local transcript and authoritative workspace; full file and directory results
are not replayed. Stateful continuation remains active between tool calls in
that request. A model change also preserves local history. A persisted
unfinished background ID is cancelled before local reconstruction so SparkRun
does not silently branch from an ambiguous provider turn.

## D-007 — One initial API attempt plus exactly eight retries

**Status:** Accepted; implemented and covered by conformance tests

**Decision:** SparkRun owns retry behavior. A retryable Gemini `create`, `get`,
or `cancel` operation receives one initial attempt and exactly eight retries
while its run remains active. SDK retries are disabled. Backoff is abortable,
exponential, and capped. User Stop and the absolute turn deadline take
precedence and may terminate an operation early; they are not API-retry
exhaustion.

**Why:** Hidden retry layers make timing and failure counts unpredictable. The
user explicitly requires eight retries before a transient API failure becomes
final.

**Consequences:** Permanent client errors and user aborts fail immediately.
Non-idempotent tool calls are not replayed. A cancellation that exhausts its
nine attempts keeps the remote Interaction ID durable and prevents a new
execution until reconciliation succeeds or the provider confirms the
Interaction is already terminal/missing. Every future outbound API client must
conform or document operation-specific state reconciliation before it can ship.

`interactions.create` has one unavoidable ambiguity: if Google accepts a
background Interaction but the response carrying its ID is lost, the client
has no handle to cancel or reconcile that accepted job and the request surface
used here exposes no idempotency key. Retrying can therefore create an orphaned
provider-only job and consume quota. It cannot execute or replay a local tool,
because tools run only after a response ID is received and polled. This release
accepts that provider-quota risk to honor the explicit eight-retry requirement;
it must be revisited if the API adds idempotency or lookup support.

## D-008 — Full guest shell, constrained file tools

**Status:** Accepted; implemented

**Decision:** The model gets targeted file tools confined to `/workspace/site`
and a shell tool that can use the entire guest. Common secret-bearing files are
blocked from model file tools, outputs are redacted, and obvious whole-VM
destruction is rejected.

**Why:** A real coding harness needs package managers, tests, compilers,
processes, servers, and diagnostics. Restricting every command to a static-site
folder would defeat the rebuild.

**Consequences:** The guest VM, not a command regex, is the primary containment
boundary. Shell access is powerful and can still destroy guest state or attack
reachable network resources. Tailnet policy and independent checkpoints are
part of the safety model. A command-text denylist cannot make a general shell
safe: equivalent reads can be expressed through interpreters, encodings, or
newly installed programs. The visible local terminal therefore remains a real
terminal, while recognizable secrets are redacted at persistence and provider
boundaries.

## D-009 — Keep Tailscale preview activation late

**Status:** Accepted, based on reproduced browser behavior

**Decision:** Finish workspace staging before activating CheerpX's Tailscale
interface. Keep server state under `/tmp/sparkrun` rather than the project
workspace. Coalesce overlapping login attempts.

**Why:** Earlier prototype testing found that Tailnet activation could coincide
with a half-broken IndexedDB workspace. CheerpX process scheduling can also take
tens of seconds, so native-process assumptions produced false server failures.

**Consequences:** Server startup waits for an observed bind certificate and a
live tracked PID. It does not perform a static-server loopback HTTP probe after
Tailnet activation: both a second cold CPython probe and an in-process request
failed under CheerpX 1.3.9 despite a healthy bound server. Outer Chrome loading
the private URL plus the server request log is the end-to-end release proof.
Managed non-Python previews use bounded `curl`; other network checks use
`curl`/`wget` because WebVM does not support ICMP `ping`. Timeouts kill the
guest command rather than merely abandoning a host promise.

## D-010 — Use xterm for the terminal; Chrome for browser integration

**Status:** Accepted; xterm implemented, real-browser gate pending

**Decision:** Use xterm.js for the visible guest terminal with raw input,
resize, Ctrl-C, arrow keys, paste, and normal terminal semantics. Use a pinned
outer Chrome for end-to-end browser automation.

**Why:** A textarea that submits one command at a time is a command launcher,
not a credible coding terminal. Conversely, modern Chrome for Testing does not
publish Linux i386 binaries, so it cannot simply be added to the CheerpX guest.

**Consequences:** Headless Chrome remains outside the guest and connects to the
guest server as an integration client. A future guest-compatible browser may be
added only after its own compatibility and security evaluation.

## D-011 — Do not adopt Pi as the browser harness yet

**Status:** Deferred, with a defined reevaluation gate

**Decision:** Build the clean release on SparkRun's small coding-harness
contract. Do not embed Pi's browser `AgentHarness` or replace the current Gemini
Interactions provider in this release.

**Why:** Pi is an impressive, mature Node coding-agent ecosystem with sessions,
tools, RPC, extensions, and an MIT license. It is also explicit that it has no
built-in permission boundary and runs with its launcher's permissions. More
importantly, Pi 0.84.3 describes its new v2 `AgentHarness` as a compile-complete
scaffold whose unfinished operation paths throw `HarnessNotImplemented`. Pi's
coding agent requires Node 22.19 or newer, while SparkRun's guest must be 32-bit
x86. Adopting it now would combine an unfinished browser path, an unproven guest
runtime, and a provider integration that could regress SparkRun's current
Interactions and retry requirements.

Primary references:

- [Pi repository and security boundary](https://github.com/earendil-works/pi)
- [Pi 0.84.3 AgentHarness changelog](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/CHANGELOG.md#0840---2026-08-06)
- [Pi coding-agent package requirements](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/package.json)

**Reevaluation gate:** Run a separate bake-off after the custom image is stable.
Pi must boot under the chosen runtime, pass resume/cancel/tool tests, preserve
the exactly-eight retry contract, use Gemini Interactions without a capability
regression, and fit the browser performance budget. Its CLI/RPC mode may be
evaluated independently from its browser API.

**Consequences:** SparkRun keeps a narrow runtime/provider boundary so a future
Pi adapter is possible. “Not now” is not “never,” and it is not permission to
copy Pi's internals into SparkRun.

## D-012 — Treat licensing as a release gate

**Status:** Accepted

**Decision:** Keep SparkRun's source license, dependency notices, and CheerpX
deployment rights explicit and separate.

**Why:** The WebVM repository is Apache-2.0, but CheerpX runtime deployment is
covered by Leaning Technologies' separate licensing terms. Opening SparkRun's
source does not grant rights to self-host or commercially deploy CheerpX.

The [CheerpX licensing guide](https://cheerpx.io/docs/licensing) allows community
use for personal projects, FOSS projects, and technical evaluations, while many
organizational, commercial, self-hosted, redistribution, and OEM uses require a
commercial license.

**Consequences:** SparkRun-authored source and associated documentation are now
published under the repository's [MIT License](../LICENSE). That license does
not relicense CheerpX, hosted runtime assets, or external services. Notices must
credit CheerpX/WebVM and other dependencies. Commercial deployment must be
reviewed against the current CheerpX terms or a written agreement. Pi's MIT
license matters only if Pi code is actually added.

## D-013 — Documentation and evidence are part of the product

**Status:** Accepted

**Decision:** Architecture, security boundaries, image provenance, test
evidence, reset behavior, and known limitations live in the repository and are
updated with the code.

**Why:** The system spans browser APIs, an emulated Linux ABI, provider state,
private networking, and multiple persistence layers. Without clear notes, a
reasonable-looking cleanup can reintroduce a failure that took hours to isolate.

**Consequences:** A change that invalidates these documents is incomplete.
Release notes distinguish verified facts, likely explanations, and unknowns.
“Fixed” means the relevant browser-level test passed.

## D-014 — Separate image provenance from browser delivery

**Status:** Accepted; Release and Firebase mirror verified; rc3 runtime gate failed separately

**Decision:** Publish each versioned ext2 image and its provenance as an
immutable GitHub Release. Before Firebase deployment, download that exact asset
with `scripts/stage-vm-image.mjs`. Verify `disk.sha256` and `manifest.json` link
the expected profile, version, filename, 1600 MiB size, SHA-256, source commit,
and passing toolchain result. Mirror those bytes under the versioned
`/vm-images/` path, finalize `dist/release.json`, and load the Firebase URL with
`CheerpX.HttpBytesDevice`.

**Why:** The 1600 MiB disk is too large for GitHub Pages. GitHub Releases can
hold the artifact and provide a
clear immutable provenance boundary, but direct Release responses lack the CORS
contract required by the browser loader. Firebase Hosting can serve the exact
same bytes with cross-origin access, byte ranges, and immutable caching.

**Consequences:** The Release is the source of truth; Firebase is a verified
delivery mirror, never an independently built image. Each staging network
download gets one initial attempt plus exactly eight retries. Staging rejects
unlinked provenance, wrong size, or wrong hash before finalizing the image and
release manifest. Firebase's predeploy verifier refuses a dirty/mismatched app
tree or changed asset inventory. A changed image requires a new Release tag,
filename, disk profile, and environment identity. Release publication,
Firebase mirroring, and CheerpX-in-Chrome validation remain separate gates.

## D-015 — Select one canonical runtime and live filesystem

**Status:** Accepted

**Decision:** A release selects exactly one canonical execution runtime and one
authoritative live project filesystem. Runtime adapters may support isolated
experiments, but SparkRun must not automatically fail over between providers,
merge their filesystem trees, or reconcile partially completed command state.

BrowserPod remains experimental until all of these gates pass at the real
browser boundary: live-key end-to-end operation; acceptable licensing and
redistribution terms; reliable process completion, status, cancellation,
timeouts, and descendant cleanup; verified portal/file-bridge behavior; and a
security and threat-model review. An adapter or source implementation is not
evidence that these gates passed.

Browser Vault remains outside the selected runtime as the independent recovery
authority. Runtime replacement or reset restores an explicit committed
checkpoint; a runtime-local workspace may be a fast working copy, but it cannot
silently supersede or merge into the Vault head.

**Why:** Two live runtimes create split-brain files, processes, and completion
semantics. That makes failures difficult to diagnose and can silently recover
the wrong project state. A single runtime boundary keeps observed behavior and
release evidence attributable.

**Consequences:** BrowserPod can be developed and measured behind an explicit
experimental selection without becoming a fallback. Promotion replaces the
canonical runtime only after its full gate passes and checkpoint restore is
validated. Browser Vault is recovery authority, not an off-device backup.
