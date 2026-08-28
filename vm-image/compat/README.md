# CheerpX Node exit compatibility layer

CheerpX 1.3.9 can hang during Node's native platform teardown after a script
has already completed. Moving the image from glibc to musl did **not** remove
that failure. This directory contains the small, auditable compatibility layer
used by the SparkRun image.

`node-exit-preload.cjs` is loaded through the image's default `NODE_OPTIONS`.
In the main thread it loads `node-exit-addon.node` and records Node's resolved
status during the normal JavaScript `exit` event. A stable N-API environment
cleanup hook then calls `_exit(recorded_status)` before Node enters the broken
CheerpX native teardown path. Worker environments deliberately do not install
the hook; child Node processes inherit the preload and install their own hook.
Because `_exit` also precedes Node's automatic compile-cache flush, the preload
calls Node 24's `flushCompileCache()` during the normal `exit` event first.

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
