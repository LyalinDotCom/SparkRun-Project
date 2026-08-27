# SparkRun coding image

This directory defines the Linux filesystem that SparkRun runs inside CheerpX.
It is source code, not a hand-maintained VM: the Dockerfile, dated package
snapshot, image metadata, executable smoke test, and publishing workflow are the
complete recipe.

The current candidate is Debian 13 Trixie for `linux/386`. CheerpX executes
32-bit x86 Linux programs, so the architecture is a runtime constraint rather
than a compatibility preference. The base manifest digest and Debian snapshot
date are pinned in both `Dockerfile` and `image.json`.

## What belongs inside the image

The image contains the Linux-side development loop: shells, Git and SSH, HTTP
and DNS diagnostics, Node/npm/pnpm/yarn, Python/pip/venv, Go, C/C++ build tools,
SQLite, tmux, search tools, archives, and process/port diagnostics.

Modern Chrome does not publish a supported Linux 32-bit binary. Browser testing
therefore runs in the user's outer Chrome browser, controlled by SparkRun, while
the application server runs inside the VM. This gives projects a current real
browser without putting an obsolete browser binary in the image.

Go is deliberately marked provisional. It is installed and tested while the
container is built, but SparkRun will not advertise it as supported until the
same compile-and-run test passes under CheerpX in Chrome.

## Build and publication

`.github/workflows/vm-image.yml` performs the reference build on an x86 Linux
runner. It:

1. Builds the digest-pinned `linux/386` OCI image.
2. Runs `sparkrun-toolchain-check --smoke` inside the container.
3. Exports the root filesystem into a 950 MiB ext2 revision-0 image.
4. Validates the filesystem and required files.
5. Splits the disk into WebVM's 128 KiB `GitHubDevice` chunks.
6. Publishes the chunks and a signed-by-hash manifest to GitHub Pages.

The published candidate is not selected by the application automatically.
Promotion requires the Chrome CheerpX smoke suite to pass first; then the image
URL and environment version are changed together in a reviewed commit. This
prevents an old IndexedDB root overlay from being applied to a different base
disk.

## Local inspection

On a Linux host with Docker and ext2 tools installed:

```sh
docker build --platform linux/386 -f vm-image/Dockerfile -t sparkrun-coding .
docker run --rm --platform linux/386 sparkrun-coding \
  /usr/local/bin/sparkrun-toolchain-check --json --smoke
```

The GitHub workflow is the canonical ext2 build because macOS cannot natively
mount and populate the required Linux filesystem. Contributors should compare
the workflow-produced `manifest.json` and tool inventory, not assume a
successful Docker build proves CheerpX runtime compatibility.

## Image release rule

Any filesystem-changing edit must bump `version` and `diskFile` in
`vm-image/image.json`. Never replace the contents behind an existing image
version: browser root overlays are keyed by that identity and assume the base
image is immutable.
