# syntax=docker/dockerfile:1.7

# CheerpX executes 32-bit x86 Linux binaries. Pin the architecture-specific
# Alpine image by digest so the libc and base filesystem cannot drift between
# rebuilds.
FROM --platform=linux/386 docker.io/i386/alpine:3.24.1@sha256:95a35dbffc3da87221f8b4eea3ed90cb52c634fedfdf4d22f3eb50e8883656cd

# Use only the versioned Alpine repositories. The base image digest pins the
# bootstrap apk tooling; the release manifest records the exact installed
# package revisions for every immutable image release.
RUN set -eux; \
    printf '%s\n' \
      "https://dl-cdn.alpinelinux.org/alpine/v3.24/main" \
      "https://dl-cdn.alpinelinux.org/alpine/v3.24/community" \
      > /etc/apk/repositories; \
    apk add --no-cache \
      bash bash-completion zsh \
      ca-certificates curl wget openssl \
      openssh-client-default bind-tools iproute2 netcat-openbsd socat \
      git git-lfs rsync \
      jq ripgrep fd tree file less \
      nano vim tmux \
      procps-ng psmisc lsof \
      coreutils findutils grep sed gawk diffutils patch \
      tar gzip bzip2 xz zip unzip \
      build-base cmake samurai pkgconf gdb \
      nodejs=24.18.1-r0 \
      npm=11.12.1-r0 \
      pnpm=11.20.0-r0 \
      yarn=1.22.22-r1 \
      python3=3.14.7-r1 python3-dev \
      py3-pip=26.1.2-r0 \
      pipx=1.14.0-r0 \
      go=1.26.3-r0 \
      sqlite \
      util-linux; \
    update-ca-certificates; \
    git lfs install --system --skip-repo; \
    git config --system init.defaultBranch main; \
    ln -sf /usr/bin/python3 /usr/local/bin/python; \
    ln -sf /usr/bin/pip3 /usr/local/bin/pip; \
    adduser -D -s /bin/bash coder; \
    mkdir -p /workspace/site /root/.config; \
    chmod 0755 /workspace /workspace/site; \
    rm -rf /tmp/* /var/tmp/*

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

COPY vm-image/compat/node-exit-addon.c /tmp/sparkrun-node-exit-addon.c
COPY vm-image/compat/node-exit-preload.cjs /usr/local/lib/sparkrun/node-exit-preload.cjs
COPY vm-image/compat/sparkrun-node.sh /etc/profile.d/sparkrun-node.sh

RUN install -d -o root -g root -m 0755 /usr/local/lib/sparkrun && \
    gcc -shared -fPIC -O2 -Wall -Wextra -Werror \
      -Wl,-z,relro,-z,now \
      -o /usr/local/lib/sparkrun/node-exit-addon.node \
      /tmp/sparkrun-node-exit-addon.c && \
    strip /usr/local/lib/sparkrun/node-exit-addon.node && \
    chown root:root \
      /usr/local/lib/sparkrun/node-exit-addon.node \
      /usr/local/lib/sparkrun/node-exit-preload.cjs \
      /etc/profile.d/sparkrun-node.sh && \
    chmod 0444 \
      /usr/local/lib/sparkrun/node-exit-addon.node \
      /usr/local/lib/sparkrun/node-exit-preload.cjs \
      /etc/profile.d/sparkrun-node.sh && \
    install -d -o root -g root -m 0700 \
      /usr/local/lib/sparkrun/node-compile-cache && \
    rm /tmp/sparkrun-node-exit-addon.c

ENV NODE_OPTIONS=--require=/usr/local/lib/sparkrun/node-exit-preload.cjs \
    NODE_COMPILE_CACHE=/usr/local/lib/sparkrun/node-compile-cache

COPY vm-image/bin/sparkrun-toolchain-check /usr/local/bin/sparkrun-toolchain-check

RUN chmod 0755 /usr/local/bin/sparkrun-toolchain-check && \
    sparkrun-toolchain-check --smoke

# The smoke run above populates the root-only cache. Also prewarm stable,
# image-owned entry points that do not depend on its temporary fixture path.
RUN node -e "require('node:fs'); require('node:path'); require('node:worker_threads')" && \
    npm --version >/dev/null && \
    pnpm --version >/dev/null && \
    yarn --version >/dev/null

ENV HOME=/root \
    USER=root \
    SHELL=/bin/bash \
    EDITOR=vim \
    TERM=xterm-256color \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace/site

CMD ["/bin/bash", "-l"]
