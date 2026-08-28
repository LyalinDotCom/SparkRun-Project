# SparkRun security model

SparkRun intentionally lets an AI agent run commands as root in a Linux guest.
The safety story is therefore not “the agent cannot do anything dangerous.” It
is “the dangerous work happens inside a replaceable browser VM, valuable project
state has an independent recovery copy, host credentials stay outside the
workspace, and network access is deliberately constrained.”

This document describes the current experimental system and its release
requirements. It is not a formal security audit.

## Security status

**Current scope:** suitable only for personal, controlled experimentation. The
user supplies provider and Tailscale keys directly to a client-side app. Tool
validation, secret-file blocking, output redaction, per-project storage,
recoverable checkpoints, and explicit reset boundaries are implemented. The
app has not been hardened for untrusted multi-user production use, and the
complete credentialed Chrome flow remains a release gate.

**Planned before a public product:** a credential broker or equivalent
short-lived provider credentials, explicit workspace export, a reviewed Content
Security Policy, continuous dependency scanning, and an external security
review. Image provenance and deploy-time integrity checks are implemented, but
they are not a substitute for that review.

## Assets worth protecting

- Google AI API keys and any future provider credentials.
- Tailscale auth keys and the tailnet resources they can enroll a device to
  reach.
- Project files, repository history, generated artifacts, and terminal history.
- Provider conversation history, which may contain source code or sensitive
  command output.
- The outer browser profile and the host computer.
- The integrity of the custom Linux image and JavaScript dependency graph.

## Trust boundaries

### 1. Outer app versus generated/third-party content

The React application receives keys and controls browser storage. Treat its
origin as privileged. Generated previews must use a different origin, normally
the VM's Tailscale address, and must never inherit access to SparkRun's
IndexedDB, localStorage, or DOM.

Generated pages and fetched dependencies are untrusted. A preview can contain
malicious JavaScript even when the model did not intend it. Do not render
generated HTML with `srcdoc` or inject it into the privileged app DOM.

### 2. Coding harness versus model output

Model text and function calls are untrusted input. The harness, not the prompt,
must enforce tool schemas and path rules.

The file tools:

- normalize paths and reject traversal outside `/workspace/site`;
- block direct reads and writes of common secret files such as `.env`, private
  key formats, and service-account files;
- redact common Google, Tailscale, GitHub, Stripe, connection-string, and
  generic API-key patterns from persisted tool output;
- cap returned output so a command cannot fill the model context or browser
  database without bound.

The shell tool is intentionally broader. It can operate across the guest and
can install packages or start services. A narrow check blocks obvious whole-VM
destruction such as formatting devices or recursively deleting `/`, but it is
not a general command sandbox. The CheerpX guest is the containment boundary.

Repository files, package documentation, web pages, and terminal output can all
contain prompt injection. The model must treat instructions found in those
sources as data unless the user explicitly makes them authoritative. Tool
enforcement must not depend on the model remembering this rule.

### 3. Guest VM versus host computer

CheerpX runs the guest through WebAssembly and Linux system-call emulation. The
guest has no mounted path to the host filesystem by default. Do not add a host
directory mount or browser File System Access handle to the model's shell
without a separate permission design.

SparkRun's optional local-folder sync is a narrow outer-app bridge: the user
selects a directory, the browser grants write permission, and the app copies
collected project files after a build. The agent never receives the directory
handle, and path normalization rejects `..` traversal. Generated contents are
still untrusted and can overwrite same-named files inside the selected folder.
Use a dedicated, version-controlled directory and review changes before running
them on the host.

Root inside the guest is not root on the host. It is still powerful enough to:

- destroy the guest environment or project workspace;
- read anything stored inside the guest;
- run untrusted binaries;
- attack reachable network services;
- consume browser CPU, memory, and storage.

Browser and CheerpX security updates therefore remain part of the trusted
computing base.

### 4. Guest network versus the tailnet

The Tailscale auth key is an enrollment credential, not a normal API access
token. A stolen reusable auth key can enroll more devices. Tailscale explicitly
warns that reusable keys are dangerous if stolen in its
[auth-key documentation](https://tailscale.com/docs/features/access-control/auth-keys).

For controlled SparkRun testing, use an auth key that is:

- ephemeral, so inactive VM nodes are removed;
- pre-approved only when device approval is enabled and unattended startup is
  required;
- tagged with a dedicated `tag:sparkrun` or equivalent identity;
- constrained by tailnet access-control rules to the smallest useful set of
  destinations;
- short-lived and revoked immediately if exposed.

SparkRun currently benefits from a reusable key because a VM restart may enroll
a new ephemeral node. That convenience increases risk. A production design
should exchange a narrowly scoped OAuth client credential through a trusted
broker for short-lived, tagged auth keys instead of retaining a reusable key in
the page.

Do not enable a tailnet exit node merely to make package installation
convenient. An exit node gives the guest public internet egress, which also gives
malicious generated code an exfiltration path. Make that choice explicit and
visible.

### 5. Browser storage versus durable backup

IndexedDB is local to the browser origin. Other pages cannot normally read it,
but any JavaScript that executes with SparkRun's origin can. Browser profile
compromise, cross-site scripting, malicious dependency updates, site-data
clearing, origin changes, and disk loss remain in scope.

The Browser Vault improves recovery from guest corruption; it is **not** an
off-device backup and is not encrypted by SparkRun. A `tar.gz` checkpoint of the
project tree can include a secret that the user created from the terminal, even
though model-facing file tools block common secret filenames. Until encrypted
snapshots and exclusion rules are implemented:

- do not put long-lived credentials in the guest filesystem;
- inspect exports before sharing them;
- assume anyone with the unlocked browser profile can access vault contents;
- keep a separate source-control remote or external backup for important work.

Requesting persistent browser storage reduces automatic eviction but does not
override a user's decision to clear site data. See [browser storage quotas and
eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

### 6. Browser app versus Gemini

The client sends user prompts, tool results, and selected source content to the
Gemini API. The Interactions API stores Interaction objects by default and has
tier-dependent retention. Review Google's current
[Interactions data-storage documentation](https://ai.google.dev/gemini-api/docs/interactions-overview#data-storage-and-retention)
before using proprietary or regulated code.

The current client-side API-key flow means the key exists in page memory and,
when “remember keys” is enabled, browser storage. It must never be:

- committed to Git;
- copied into the guest image or project workspace;
- included in diagnostic exports;
- written into provider transcripts or terminal history;
- placed in a URL query string or fragment controlled by third-party code.

The VM smoke harness follows the same rule: it can reuse the Tailscale key the
user explicitly saved through Setup, but it does not accept secrets through a
query parameter or a `VITE_` environment variable. Vite-prefixed values are
compiled into client JavaScript and are not a secret channel.

SparkRun redacts recognizable key patterns, but redaction is defense in depth,
not proof that an arbitrary secret cannot leak.

The interactive terminal deliberately keeps normal terminal semantics and can
show what the local user types or what a guest process prints. Redaction is
applied before scrollback, commands, tool results, and activity are persisted
or sent to Gemini; it is not a screen-level data-loss-prevention system.

## API retry safety

Where SparkRun owns a retryable API operation, the contract is **one initial
attempt plus exactly eight retries** before a transient failure becomes final
while the owning run remains active. The Gemini harness disables SDK-level
retries so hidden retries do not multiply that number. It retries transient
network failures, timeouts, rate limits, and server errors with bounded
exponential backoff; user abort, the absolute turn deadline, and clearly
permanent client errors take precedence. An unconfirmed remote cancellation ID
is retained and blocks a new provider execution until reconciled. The VM-image
staging downloads use the same initial-plus-eight ceiling.

Retries are not automatically safe for every operation. A state-changing call
must carry an idempotency key or have a documented reconciliation procedure.
Tool calls and shell commands are never replayed just because an API request was
retried. If a run stops during tools, the coding session resets provider
continuation and reconstructs context from the transcript and current
workspace.

The documented exception is an ambiguous `interactions.create`: when the
provider accepts the request but its response is lost, SparkRun has neither an
Interaction ID nor an idempotency key to reconcile. The required retry policy
may leave an unreachable provider-side job consuming quota. It still cannot
mutate the VM, because local tools are dispatched only from a successfully
returned and polled Interaction. See D-007 in `docs/DECISIONS.md`.

**Current evidence:** the harness's focused suite proves the
initial-plus-eight policy and ninth-attempt ceiling with SDK retries disabled.
The current Chrome end-to-end run remains a release gate.

**Still required:** any new external client must adopt the shared policy or
document why replay is unsafe before release. Tailscale login state transitions
are reconciled as a state machine rather than blindly replayed as generic HTTP
calls.

## Supply-chain and image requirements

- Pin direct JavaScript dependencies and commit the npm lockfile.
- Use `npm ci` in continuous integration; do not resolve fresh transitive
  versions during a release build.
- Pin CheerpX to an exact version and verify that the runtime-loaded version
  matches the build-time package version.
- Pin the custom image's base by digest, not only by a mutable distribution tag.
- Record the image SHA-256, Dockerfile SHA-256, exact package inventory,
  normalized rootfs manifest, measured rootfs size, builder version, toolchain
  result, build command, and source commit for every published ext2 artifact.
- Treat npm lifecycle scripts and packages fetched inside the guest as arbitrary
  code.
- Scan application and image dependencies, but do not mistake a clean scanner
  result for runtime compatibility or safety.
- Keep the ext2 artifact immutable. Guest updates go into a versioned overlay or
  a newly reviewed image.
- Verify ownership and modes for the rc3 Node preload, N-API addon, profile
  script, and compile cache in both the exported rootfs and ext2 image.

The versioned GitHub Release is the image's provenance source. The workflow
must refuse to replace a published version with a different commit or asset
size and must verify byte-range behavior plus the ext2 superblock magic. GitHub
Release URLs are not used directly by the browser because their responses do
not provide the CORS contract required by `CheerpX.HttpBytesDevice`.

`scripts/stage-vm-image.mjs` is the trust bridge from the Release to Firebase
Hosting. It downloads `disk.sha256`, `manifest.json`, and the image with one
initial attempt plus exactly eight retries per network download. It requires the
manifest to link profile, version, filename, size, disk hash, source commit, and
passing toolchain/Node conformance before atomically staging the image and
finalizing `dist/release.json`.

`scripts/verify-release-dist.mjs` then requires a clean worktree, the full app
commit, package-lock hash, unchanged app asset inventory, exact default and
candidate disk profiles, and the staged image's size, SHA-256, source commit,
and Release-manifest hash. Firebase runs that verifier as a predeploy hook. The
deploy must mirror those exact verified bytes; rebuilding or modifying an asset
after the manifest is written breaks provenance and fails closed.

The Alpine rc3 image contains a root-owned Node compatibility layer because
CheerpX 1.3.9 can hang after JavaScript has finished but before native platform
teardown completes. The preload records the resolved exit status and flushes
the compile cache; an N-API cleanup hook calls `_exit(status)` before the broken
path. The workflow verifies the ownership, modes, and hashes of those files in
the immutable image. Because the coding agent itself runs as guest root, it can
still replace an overlay copy; file ownership is provenance evidence, not a
sandbox boundary. Resetting VM caches restores the pinned base. `_exit` also
bypasses later native cleanup, so applications must close durable native
resources themselves. This is a known behavioral tradeoff covered by the
Node-exit conformance suite, not a general sandbox or security fix.

The Firebase image URL is intentionally public and cross-origin readable. Do
not bake API keys, private repositories, shell history, credentials, or user
project data into the base image. `Access-Control-Allow-Origin: *` is suitable
for this immutable public artifact, not for a future authenticated image or
credential endpoint. Every changed image needs a new versioned filename so the
one-year immutable cache cannot serve old bytes under a reused identity.

## Required web protections

CheerpX requires cross-origin isolation, so development and production serve:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Those headers are functional requirements, not a complete security policy. The
current release also uses `X-Frame-Options: DENY`, refuses non-HTTPS/non-Tailscale
login URLs, keeps generated HTML outside the privileged origin, and renders
Markdown without raw HTML. Before a public product, it still needs:

- a Content Security Policy reviewed against the pinned CheerpX runtime, disk
  host, Gemini endpoint, and Tailscale behavior;
- an allowlist for any future cross-window messages.

## Licensing boundary

SparkRun-authored source and associated documentation in this repository are
available under the [MIT License](../LICENSE). That is a source-code license,
not a grant of rights to every runtime or service the application uses.

- The upstream [WebVM repository](https://github.com/leaningtech/webvm) is
  Apache-2.0.
- The CheerpX runtime and hosted runtime assets have separate
  [licensing terms](https://cheerpx.io/docs/licensing). SparkRun's MIT license
  does not expand those rights.
- Gemini, Tailscale, Firebase, npm packages, Linux packages, and downloaded
  toolchains remain governed by their own licenses, account terms, and service
  policies.

Review those boundaries before redistributing a bundled runtime, self-hosting,
or offering SparkRun commercially. A dependency being technically reachable
from an MIT-licensed application does not make that dependency MIT-licensed.

## Incident response

If a provider key may have leaked:

1. revoke it at the provider;
2. clear remembered keys in SparkRun;
3. inspect provider logs for unexpected use;
4. generate a replacement with the minimum necessary scope.

If a Tailscale auth key may have leaked:

1. revoke the auth key in the Tailscale admin console;
2. remove unexpected devices from the Machines page—revoking the auth key does
   not remove devices that already enrolled;
3. review tailnet access logs and policy;
4. replace it with a short-lived, tagged, ephemeral key.

If generated code behaved maliciously:

1. disconnect the VM from Tailscale;
2. stop the VM and preserve a checkpoint only if forensic value outweighs the
   chance of retaining secrets;
3. reset the environment overlay;
4. rotate any credential that entered the guest or appeared in tool output;
5. restore source from a known-good checkpoint or external repository.

## Known open risks

- Client-side long-lived provider and Tailscale credentials.
- No cryptographic encryption layer for Browser Vault contents.
- No off-device backup supplied by SparkRun.
- Broad root shell access inside the guest by design.
- Tailnet exposure can make private services reachable to untrusted guest code.
- No completed Content Security Policy or external penetration test.
- The Alpine rc3 image is rejected for promotion because its modern Node/npm
  lifecycle did not complete reliably in real Chrome; its verified publication
  and delivery do not establish runtime safety or compatibility.
- BrowserPod remains experimental until live-key, licensing, process-control,
  portal/file-bridge, and security gates pass at the real browser boundary.
