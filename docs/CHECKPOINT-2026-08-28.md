# SparkRun checkpoint — August 28, 2026

This is the first rebuilt-product checkpoint intended for hands-on testing. The
source builds cleanly, the automated suite is green, and Chrome proved the real
Linux VM, terminal, workspace snapshot/restart file survival, Tailscale
enrollment, supervised server, and an outer-browser HTTP connection. The live
Gemini coding turn did not complete: the first app run timed out and the second
ended in an unexplained terminal 400. A separate direct SDK probe independently
observed explicit high-demand failures for Gemini 3.7 Flash.

The commit containing this document is the checkpoint source. The Chrome
captures were made immediately before the clean commit from a production build
whose Diagnostics card reported base SHA `960e9b5` plus `dirty`; they are
runtime evidence for this working tree, not a claim that the old SHA is the
final checkpoint identity.

## Readiness summary

| Boundary | Result | Evidence |
| --- | --- | --- |
| TypeScript and production bundle | Passed | `npm run build`; Vite 8.2.2 transformed 2,080 modules. |
| Automated suite | Passed | 11 files, 371 tests. |
| Dependency health | Passed | `npm audit` reported no vulnerabilities; `npm outdated` reported no newer installed package targets during the checkpoint. |
| Chrome UI and CheerpX boot | Passed | CheerpX build/runtime 1.3.9 matched; the Debian guest mounted its project workspace. |
| Root terminal | Passed | `pwd`, `uname`, Python, `id`, file write, read, and `stat` completed in the guest. |
| Workspace snapshot/restart persistence | Passed | After Snapshot now and Restart VM, `checkpoint-proof.txt` survived with exact content, 24 bytes, mode 644. This proves file survival through restart, not archive extraction. |
| Tailscale enrollment | Passed | The saved device auth key reached Running and assigned a private `100.x.x.x` address. |
| Server readiness | Passed | Supervised Python server wrote its bind certificate; the tracked PID remained alive on port 8081. |
| Outer-Chrome connection | Passed | A separate Chrome tab rendered the page; the guest log recorded `GET / HTTP/1.1` with status 200. |
| Gemini 3.7 Flash live coding | Not passed; mixed provider/API failure | Attempt one timed out after 720,000 ms. Attempt two showed retries and a terminal 400. A separate correctly parsed SDK probe received explicit 500 high-demand responses after a background interaction was accepted. No tool call was returned in this checkpoint run. |
| Firebase promotion | Not performed | The existing public site may lag. This checkpoint is intentionally not described as deployed until a clean-commit live-provider smoke passes. |

## What the app can do

### Workbench and conversations

- Present a Codex-inspired three-pane experience: project/conversation rail,
  continuous user/model/tool activity, compact composer, and collapsible
  Environment inspector.
- Collapse the rail and inspector; turn those panels into accessible modal
  surfaces on narrow screens.
- Create isolated projects and multiple conversations, restore the active
  selection, and reject late asynchronous writes after a project is deleted or
  changed.
- Expose Preview, Files, Terminal, and Activity without flooding the normal
  conversation with raw VM logs.
- Use Gemini 3.7 Flash as the one enabled coding model. Thinking level is fixed
  to high for this release.

### Coding harness

- Call the current Google GenAI SDK's Interactions `create`, `get`, and `cancel`
  operations using background execution for high-thinking work.
- Persist the pending Interaction ID before polling, cancel on Stop or deadline,
  and reconcile an unconfirmed cancellation before admitting new provider work.
- Give each classified transient `create`, `get`, or `cancel` operation one
  initial request plus exactly eight retries, with SDK retries disabled.
  Permanent client errors, user Stop, and the absolute turn deadline terminate
  earlier by design.
- Continue tool calls within one provider episode using
  `previous_interaction_id`; start later user requests as fresh bounded episodes
  reconstructed from the durable transcript and current workspace.
- Reject repeated identical successful reads/lists without an intervening
  mutation and stop repeated “I will do it” responses from masquerading as
  completed work.
- Provide typed `read_file`, `write_file`, `replace`, `list_directory`,
  `run_command`, and `start_preview` tools. File tools remain inside
  `/workspace/site`; output is bounded and scrubbed before persistence.

### Linux VM and terminal

- Boot CheerpX 1.3.9 in Chrome with a versioned root-overlay cache, an isolated
  per-project `/workspace`, an in-memory staging mount, and the official Debian
  compatibility disk.
- Run commands as guest root and prove completion with a nonce-bearing shell
  marker rather than trusting the launcher return value.
- Dispose the entire VM after a command watchdog timeout so late output or
  processes cannot contaminate a later command.
- Provide a real xterm pseudo-terminal with keyboard input, paste, resize,
  scrollback, Ctrl-C, and a compact inline-command field.
- Read and write binary or text project files, preserve dotfiles in snapshots,
  and stage vault restores outside the CheerpX directory mount before copying
  into the live workspace.

### Persistence and recovery

- Store projects, conversations, activity, harness sessions, terminal metadata,
  settings, and SHA-256-recorded project archives in Browser Vault (IndexedDB).
- Commit checkpoints in two phases, recover from a torn head, reject conflicting
  parent heads, and keep the committed archive safe if the guest marker update
  fails.
- Reuse a matching per-project cache so newer uncheckpointed edits are not
  overwritten; restore the Browser Vault archive when the cache is empty,
  stale, or identified as another lineage.
- Snapshot on successful turns and on recoverable failure paths; support manual
  Snapshot now, Restart VM, Reset workspace, Reset VM caches, and project
  deletion with distinct erase boundaries.
- Optionally export collected project files one way to a user-approved local
  Chrome folder. The model never receives the directory handle.

### Private previews and diagnostics

- Activate the CheerpX userspace Tailscale stack only after normal workspace
  writes, avoiding a reproduced filesystem failure boundary.
- Supervise a built-in Python static server or an agent-provided foreground
  preview command, record its PID/port/readiness, and stop older processes
  before replacement.
- Distinguish VM bind/PID readiness from the release-level outer-Chrome request
  proof. The UI now says “Server is ready at” and asks the user to open the URL.
- Surface build SHA/time, pinned/runtime CheerpX versions, disk profile,
  Tailnet states, commands, server lifecycle, and errors in Diagnostics.
- Provide `/diag.html` for CheerpX isolation and `/?vm-smoke` for the app's VM
  configuration without pretending mocked or VM-internal checks are a browser
  connection.

### Release engineering

- Pin direct dependencies, CheerpX 1.3.9, `@google/genai` 2.19.0, and commit the
  npm lockfile.
- Run tests as part of `release:prepare`, then type-check/build, stage the exact
  published VM image, and verify the commit, package-lock hash, asset inventory,
  image size/SHA/provenance, and Firebase header contract.
- Refuse a dirty-tree deployment and re-run the final verifier from Firebase's
  predeploy hook.

## Known limitations and broken or missing scenarios

### Currently blocked

- The live Gemini coding path did not complete during this checkpoint. The key
  was accepted and background resources were created, but app attempt one timed
  out and attempt two ended in an unexplained terminal 400 before any tool call.
  A separate direct SDK probe independently received explicit provider
  high-demand failures. Retry later before treating this as an app regression;
  changing the VM or Tailscale key will not address provider-capacity events.
- A complete default creation-to-agent-code-to-preview pass is therefore not
  claimed for August 28, even though the same preview boundary passed using the
  real terminal.

### Linux environment

- The default is Debian 10 Buster, which is end-of-life. It reliably supplies
  the compatibility shell, Python 3.7, and core tools, but modern Node/npm/Go,
  current TLS/package repositories, and headless Chrome are not promised.
- Alpine `2026.08.27-rc3` contains the desired modern toolchain but is rejected
  for promotion because Node/npm lifecycle teardown did not pass under CheerpX
  in real Chrome. Its release artifact remains diagnostic evidence only.
- Public package-manager egress from the guest needs a suitable Tailscale exit
  node. Joining a tailnet alone provides private-tailnet reachability.

### Product surface

- Files is a read-only inspector, not an embedded editor. There is no first-class
  Git/diff/review UI, manual checkpoint-history picker, continuous folder sync,
  workspace import, or off-device/cloud backup.
- Pi is not integrated. BrowserPod is a deferred concept, not an implemented
  runtime. There is no provider failover or multi-model selector.
- Local-folder export omits dotfiles and common dependency/build/cache/vendor
  trees, has depth/entry limits, and does not delete stale destination files.

### Persistence and concurrency

- Browser Vault is local to one origin and browser profile. Clearing site data,
  losing that profile, or switching origins loses it. Saved keys and checkpoints
  do not have an additional application encryption layer.
- Checkpoints cover `/workspace/site`, not arbitrary guest paths. Ad-hoc tool
  installs live in the root-overlay cache and normally survive Restart VM, but
  Reset VM caches removes them; Browser Vault does not replay package installs.
- Different projects have separate workspace locks but normally share the
  default environment's root-overlay database. Concurrent VMs in multiple tabs
  or projects are not release-proven.
- Processes and guest RAM never resume. Full hidden provider context is not
  durable; only the bounded transcript, provider handles, and current files are.
- Frequent full-workspace checkpoints retain a bounded history but can consume
  substantial browser storage for dependency-heavy projects.

### Networking and security

- Tailscale requires a reusable ephemeral `tskey-auth-*` device key for repeated
  prototype starts, host Chrome on the same tailnet, and device approval when
  the tailnet policy requires it. A poisoned page-global CheerpX network runtime
  still needs a full page reload.
- Production HTTPS cannot safely embed the VM's HTTP Tailnet page as a same-page
  preview; open the private URL in its own Chrome tab.
- The guest root shell is intentionally powerful. File tools block common secret
  paths and outputs are redacted, but `run_command` is not a hostile-code
  sandbox. Generated code can erase guest state or attack anything allowed by
  the tailnet policy.
- There is no credential broker, Content Security Policy, multi-user isolation,
  external security audit, or server-side key custody yet.

### Provider and release edges

- A background Interaction may legitimately take minutes. SparkRun waits up to
  12 minutes, then cancels and checkpoints. A permanent 4xx is not retried eight
  more times; replaying a bad request would only waste quota.
- If `interactions.create` is accepted but its HTTP response is lost, the API
  supplies no pre-response ID or idempotency key that SparkRun can use to find
  and cancel the orphan. Local tools are never replayed, but provider quota may
  still be consumed.
- The main production JavaScript chunk is about 1.01 MB minified (about 288 KB
  gzip). Vite emits a size advisory; this is not a functional failure but is a
  future code-splitting target.
- Release automation now runs tests and verifies static live-origin contracts,
  but a full credentialed Chrome smoke remains a manual promotion gate.

## How to run the checkpoint

```sh
git clone https://github.com/LyalinDotCom/SparkRun-Project.git
cd SparkRun-Project
npm ci
npm test
npm run build
npm run preview
```

Open the printed `127.0.0.1` URL in current Chrome.

1. Enter the Google AI Studio key and Tailscale **device auth key** in Setup.
   The browser application intentionally does not import `.env`; that avoids
   bundling client secrets. `.env` is ignored and is only for maintainer-side
   diagnostics.
2. Keep “Remember keys” off unless storing them in this browser profile is
   acceptable.
3. Start with a small request such as “Create one index.html with a heading and
   start the preview.” High thinking can take minutes. A visible high-demand
   retry is a provider event, not a reason to reset the VM.
4. Open Terminal and run `pwd; python3 --version; id`.
5. Use Snapshot now, Restart VM, and confirm a terminal-created file survives.
6. When a server URL appears, open it in a new Chrome tab and run
   `tail -20 /tmp/sparkrun/server.log` in Terminal. A `200` GET is the real
   connection proof.

## Recovery order

1. Hard reload Chrome.
2. Check Setup → Diagnostics for the expected build SHA/time and CheerpX 1.3.9.
3. Reset workspace; the latest Browser Vault checkpoint remains authoritative.
4. Reset VM caches only when necessary; this also removes ad-hoc installed
   tools while preserving the project vault.
5. Run `/diag.html` to distinguish CheerpX/environment failures from app logic.
6. Use a disposable Chrome profile before destructive clear-site-data testing.

## Evidence

- [Screenshot tour](SCREENSHOT_TOUR.md)
- [Testing and release gates](TESTING.md)
- [Architecture](ARCHITECTURE.md)
- [Security model](SECURITY.md)
- [Curated bug-bash disposition](BUG_BASH.md)

The strongest current screenshots are the [live terminal](screenshots/18-live-terminal-proof.png),
[restart restore](screenshots/19-live-restart-restore.png), [private Chrome
preview](screenshots/20-live-tailnet-preview.png), and [guest request-log
proof](screenshots/21-live-connection-proof.png). The [provider timeout
capture](screenshots/17-live-provider-timeout.png) is included deliberately so
the checkpoint does not conceal the one boundary that failed.
