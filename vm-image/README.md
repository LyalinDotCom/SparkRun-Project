# SparkRun coding image

This directory defines the Linux filesystem that SparkRun runs inside CheerpX.
It is source code, not a hand-maintained VM: the Dockerfile, image metadata,
executable conformance test, and publishing workflow are the complete recipe.

The retained rc3 image is Alpine Linux 3.24.1 with musl for `linux/386`.
CheerpX executes 32-bit x86 Linux programs, so the architecture is a runtime
constraint rather than a compatibility preference. The architecture-specific
base image digest and critical runtime package revisions are pinned in both
`Dockerfile` and `image.json`; the immutable Release also records every
transitive package actually installed.

Alpine/musl was a necessary clean baseline, but it did not by itself fix a
CheerpX 1.3.9 hang in Node's native platform teardown. The rc3 image therefore
ships a narrowly scoped, root-owned Node compatibility layer. It is enabled for
image shells with:

```text
NODE_OPTIONS=--require=/usr/local/lib/sparkrun/node-exit-preload.cjs
```

The preload runs only in the main thread. It loads a small stable N-API addon,
records Node's already-resolved status during the ordinary JavaScript `exit`
event, and calls `_exit(status)` from an environment cleanup hook before Node
reaches the broken native teardown path. Workers skip the hook; forked Node
children inherit the preload and install their own. The listener explicitly
flushes Node 24's compile cache before recording the status because `_exit`
precedes Node's automatic cache flush. This preserves observable exit semantics
but intentionally skips later native platform cleanup. The source and
threat/behavior notes live in `compat/`.

Docker `ENV` metadata is not part of the exported ext2 filesystem. The image
also installs a root-owned `/etc/profile.d/sparkrun-node.sh`, which supplies the
same defaults to login shells without overriding explicit caller values.
SparkRun supplies them through CheerpX `runOptions` for non-login launches.

`NODE_COMPILE_CACHE` points at a root-only directory under
`/usr/local/lib/sparkrun`. The image-build smoke run safely prewarms it for the
default root shell without making executable cache state writable by other
users. A non-root shell can override or unset that variable.

The ext2 container is 1600 MiB, below the Firebase Hosting 2 GB per-file limit
and large enough for the development stack plus filesystem metadata and guest
working space. Its measured rootfs usage is recorded by every image build.

> **Candidate rc4 (2026.09.02):** identical recipe to rc3 plus a
> `process.reallyExit` override in the compatibility layer (see
> [`compat/README.md`](compat/README.md)). rc3's Chrome gate failed on
> `process.exit()`; the override passed the in-guest hypothesis probe on
> 2026-09-02. rc4 must still pass the full `probe=release-gate` in Chrome
> before promotion.
>
> **Rejected for promotion (rc3):** `vm-image/image.json` and
> `src/lib/constants.ts` retain rc3's historical candidate identity. Its immutable GitHub
> Release and Firebase byte-range mirror are published and verified; those facts
> prove provenance and delivery only. Real-Chrome measurements found that its
> modern Node/npm command lifecycle did not complete reliably, so the image is
> not selected as SparkRun's default or fallback runtime.

## What belongs inside the image

The image contains the Linux-side development loop: shells, Git and SSH, HTTP
and DNS diagnostics, Node/npm/pnpm/yarn, Python/pip/venv, Go, C/C++ build tools,
SQLite, tmux, search tools, archives, and process/port diagnostics.

Modern Chrome does not publish a supported Linux 32-bit binary. Browser testing
therefore runs in the user's outer Chrome browser, controlled by SparkRun, while
the application server runs inside the VM. This gives projects a current real
browser without putting an obsolete browser binary in the image.

The rc3 artifact remains useful for diagnostics. Container validation covers
exact Node exit statuses, exit handlers, workers, forked children, 200 KiB
stdout delivery, package-manager versions, Python threads, POSIX threads and a
parked condition-variable broadcast/join, C, Go, SQLite, and PTYs, but SparkRun
will not advertise any custom-image runtime as supported until the same suite
passes under the selected runtime in Chrome. rc3 failed this gate for modern
Node/npm. This gate also exists because an earlier glibc
candidate passed Docker checks while Node and Go hung in the browser VM.

## Build provenance and publication

`.github/workflows/vm-image.yml` performs the reference build on an x86 Linux
runner. It:

1. Builds the digest-pinned `linux/386` OCI image.
2. Runs `sparkrun-toolchain-check --smoke`, including the Node compatibility
   conformance matrix, records the exact Alpine package inventory, and records
   the Docker builder version.
3. Exports the root filesystem, enforces free-space headroom, and records a
   normalized file-by-file manifest.
4. Builds and validates a 1600 MiB ext2 revision-0 image.
5. Records the disk SHA-256, Dockerfile SHA-256, compatibility-source and baked
   addon/preload SHA-256 values, package-inventory SHA-256,
   rootfs-manifest SHA-256, source commit, measured rootfs size, and toolchain
   result in the release provenance.
6. Publishes the disk and provenance files as a versioned, non-latest GitHub
   Release named `vm-image-<version>`.
7. Requests bytes 1024–1087 from the published disk, requires HTTP 206 and 64
   returned bytes, and verifies the ext2 `53ef` magic at its superblock offset.

An already-published version is immutable. When a later workflow run references
the same version, the workflow requires the filesystem recipe inputs to be
unchanged, verifies that every expected asset is present, and cross-checks the
published image digest against `disk.sha256`. A filesystem-changing edit must
bump the image version; documentation and workflow-only edits may re-verify the
existing immutable Release.

Each successful Release contains the ext2 file, `disk.sha256`,
`manifest.json`, the package inventory, rootfs manifest, Docker version, and
toolchain result. A successful container smoke or Release upload still does not
prove the programs work under CheerpX.

## Browser delivery

The 1600 MiB disk is too large for GitHub Pages. GitHub Release assets can hold
it and provide the immutable provenance source, but their direct responses do
not provide the browser CORS contract needed by `CheerpX.HttpBytesDevice`.
SparkRun therefore uses a verified mirror rather than loading the Release URL
directly:

```text
versioned GitHub Release asset
        |
        | scripts/stage-vm-image.mjs
        | initial attempt + exactly 8 retries + size/SHA-256 verification
        v
dist/vm-images/<versioned-image>.ext2
        |
        | Firebase Hosting deploy
        v
/vm-images/<versioned-image>.ext2
        |
        | CORS + cross-origin resource policy + byte ranges + immutable cache
        v
CheerpX.HttpBytesDevice
```

`npm run stage:vm-image` downloads `disk.sha256`, `manifest.json`, and the disk
from the matching Release. Each network download has one initial attempt plus
exactly eight retries. The script requires the manifest to link the profile,
version, filename, exact 1600 MiB byte length, disk SHA-256, source commit, and
passing toolchain/Node conformance result. It then atomically moves the verified
file into `dist/vm-images/` and finalizes the build-generated
`dist/release.json` with the exact image provenance.

Firebase Hosting is configured to supply cross-origin access, cross-origin
resource policy, byte-range delivery, and immutable caching for
`/vm-images/**`. The application loads the mirrored versioned URL through
`HttpBytesDevice`. rc3's delivery passed, but its modern Node/npm runtime gate
did not; it is rejected for promotion. A future image must boot and pass the
full tool matrix in real Chrome before becoming the default environment.

The hosting gate must also prove a nonexistent `.ext2` path returns 404. A
catch-all single-page-app rewrite must never turn a missing image into HTTP 200
HTML carrying the image's one-year immutable cache policy.

The guarded deployment sequence is:

```sh
npm run release:deploy
```

For a two-step release handoff, run `npm run release:prepare` and then
`firebase deploy --only hosting`. Both require a committed, clean worktree.
Firebase's predeploy hook reruns the release verifier and rejects a missing or
changed app asset, image, or provenance field.

## Local inspection

On a Linux host with Docker and ext2 tools installed:

```sh
docker build --platform linux/386 -f vm-image/Dockerfile -t sparkrun-coding .
docker run --rm --platform linux/386 sparkrun-coding \
  /usr/local/bin/sparkrun-toolchain-check --json --smoke
```

The GitHub workflow is the canonical ext2 build because macOS cannot natively
mount and populate the required Linux filesystem. Contributors should compare
the Release's `manifest.json`, checksums, rootfs manifest, package inventory,
and toolchain result; a successful Docker build is not CheerpX compatibility.

## Image release rule

Any filesystem-changing edit to `Dockerfile`, `image.json`, `bin/`, or `compat/`
must bump
`version` and `diskFile` in `vm-image/image.json`. Never replace the contents
behind an existing image version: browser root overlays are keyed by that
identity and assume the base image is immutable. The GitHub Release tag,
staged Firebase filename, disk profile ID, and environment overlay identity
must advance together.
