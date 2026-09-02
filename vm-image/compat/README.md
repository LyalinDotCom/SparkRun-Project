# CheerpX Node exit compatibility layer

CheerpX 1.3.9 can hang during Node's native platform teardown after a script
has already completed. Moving the image from glibc to musl did **not** remove
that failure. This directory contains the small, auditable compatibility layer
used by the SparkRun image.

`node-exit-preload.cjs` is loaded through the image's default `NODE_OPTIONS`.
In the main thread it loads `node-exit-addon.node` and wraps the process event
emission boundary. The wrapper records `process.exitCode` only after every user
`exit` listener has run, matching Node's own final-status reload semantics. A
stable N-API environment cleanup hook then calls `_exit(recorded_status)` before
Node enters the broken CheerpX native teardown path. Worker environments
deliberately do not install the hook; child Node processes inherit the preload
and install their own hook. Because `_exit` also precedes Node's automatic
compile-cache flush, the preload calls Node 24's `flushCompileCache()` before
the native hook runs.

**rc4 addition — explicit exits.** The cleanup hook only fires on Node's
natural teardown. `process.exit()` (and the runtime's own exit after an
unhandled uncaught exception) goes through `process.reallyExit`, Node's C++
`Exit` path, which disposes the platform without running environment cleanup
hooks and never returns under CheerpX 1.3.9. rc3 failed its Chrome gate
exactly there: `node -e 'void 0'` returned, `node -e 'process.exit(7)'` hung
for the full watchdog. The preload therefore replaces `process.reallyExit`
with the addon's `exitNow(status)` (`_exit` after a best-effort compile-cache
flush) and installs a lowest-priority `uncaughtException` listener that
reproduces Node's default report and status 1 on that same path when no user
listener exists. The override was proven inside the real CheerpX VM on
2026-09-02 with the `probe=node-exit-override` smoke step, which compiles the
same addon in the guest and checks explicit, deferred, natural, nested,
uncaught, 64 KiB stdout, and forked-child exits, before this image rebuild.

Docker image environment metadata is not included by `docker export`.
`sparkrun-node.sh` therefore persists both defaults in `/etc/profile.d` for
login shells without overwriting caller-supplied values. Non-login CheerpX
launches must supply the same variables in their `runOptions`.

This is a targeted teardown mitigation, not a claim that musl fixed the
runtime. Calling `_exit` bypasses any native cleanup that would occur after
N-API environment cleanup. The conformance suite therefore verifies exit
handlers, exact success and failure statuses, workers, forked children, and
large standard-output delivery. Applications must still close durable native
resources before returning from their JavaScript work, as they should for an
explicit `process.exit()`.
