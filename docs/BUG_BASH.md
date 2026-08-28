# SparkRun bug-bash disposition

Date: August 28, 2026

This is the curated disposition for the multi-model review. Raw model output is
not treated as a source of truth: it can be incomplete, stale, confidently
wrong, or produced against a changing dirty tree. The primary agent verified
findings against source, tests, and real Chrome before accepting them.

## Review matrix

- AGY with Gemini 3.1 Pro High: three rounds;
- AGY with Gemini 3.7 Flash High: three rounds;
- Claude Fable 5 Medium: two requested rounds, with quota/availability limiting
  the useful output;
- Grok 4.6 High: three rounds;
- independent Codex source, release, documentation, and timeout reviews.

The three main rounds were broad correctness, guided core mechanisms, and
guided UI/security/release. The repeatable runner is
[`scripts/run-final-bug-bash.sh`](../scripts/run-final-bug-bash.sh). Its
`captured` status means only that a CLI exited successfully with nonempty
stdout; it does not approve the report. Raw outputs are ignored under
`docs/bug-bash/` and must be curated before publication.

## Confirmed and addressed

| Area | Verified problem | Disposition |
| --- | --- | --- |
| Provider deadline | A timer could fire while `Date.now()` still reported a sub-millisecond budget, permitting one unintended background `get`. | The poll delay now consumes the terminal budget without issuing that GET. The focused deadline regression passed 20 consecutive runs. |
| Checkpoint lineage | A Browser Vault archive could commit while the guest marker update failed, allowing the UI to imply a completely successful snapshot. | Marker advancement is mandatory and surfaces a recovery error while preserving the already committed archive. |
| Secret redaction | Bare AWS access-key IDs and Google OAuth `ya29` tokens were not covered by the persisted-output scrubber. | Added redaction patterns and regression tests. |
| Modal accessibility | Responsive panels could leave background rail controls focusable. | Background controls become inert while the modal panel is open. |
| Composer hint | The UI advertised only a Mac shortcut. | Copy now says `⌘/Ctrl + Enter`. |
| Tailscale validation | The field accepted `tskey-client-*`, an OAuth client credential that cannot enroll a device. | Validation now accepts only `tskey-auth-*` and explains the difference. |
| VM smoke truth | The no-key smoke used `... || true`, so it could claim runtime success without proving the command. | It now requires a successful Python baseline and explicitly reserves modern-toolchain checks for the candidate probe. |
| Preview truth | “Site is live” conflated VM bind/PID readiness with an outer-browser request. | Source now says “Server is ready at” and tells the user to open the URL; the release gate separately proves Chrome's GET in the guest log. |
| Release guard | `release:prepare` could compile and stage without running Vitest. | The guarded release sequence now runs the full test suite before the production build. |
| Documentation | Resume, BrowserPod, modern-toolchain, security, and rejected-image claims had drifted beyond the implementation. | Canonical docs now separate implemented, Chrome-proven, and deployed behavior. |
| Evidence hygiene | Screenshot extensions did not match their JPEG bytes, and raw review manifests called nonempty output `ok`. | Screenshots are real PNGs; duplicate/mislabeled evidence was removed; raw status is now `captured`. |

## Open or accepted risk

- Gemini `interactions.create` has no pre-response interaction ID or documented
  idempotency key. A network timeout after server acceptance can consume quota
  without giving SparkRun a handle to cancel. The app does not replay local
  tool calls, and the ambiguity is documented.
- Projects isolate `/workspace`, but projects using the same environment ID
  share one root-overlay IndexedDB cache. Concurrent multi-tab/multi-project VM
  use is not release-proven.
- The official Debian 10 compatibility disk remains the default. The modern
  Alpine rc3 image is rejected because Node/npm teardown did not pass the real
  Chrome gate.
- The Browser Vault protects project files and metadata, not guest RAM,
  processes, off-device backup, or reproducible replay of ad-hoc package
  installs after Reset VM caches.
- The guest root shell is deliberately broad. It is not a hostile-code sandbox.
- Live provider availability remains external. The August 28 checkpoint saw
  Gemini 3.7 Flash accept background work and then return high-demand errors.

## Review claims deliberately rejected

Several raw reports treated documented product boundaries as new defects,
reported stale line numbers after concurrent fixes, or declared success after
emitting only a meta-response. In particular, publication of an immutable VM
image was never accepted as proof of CheerpX runtime compatibility; VM-side
bind/PID health was never accepted as proof of an outer-Chrome HTTP request;
and the general guest root shell was never intended to be a per-command
sandbox. The current checkpoint report records the verified boundary for each.
