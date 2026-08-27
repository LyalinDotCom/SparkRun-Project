# syntax=docker/dockerfile:1.7

# CheerpX currently executes 32-bit x86 Linux binaries. Keep both the platform
# and the multi-architecture manifest digest pinned so a rebuild cannot silently
# change the base filesystem.
FROM --platform=linux/386 docker.io/library/debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132

ARG DEBIAN_FRONTEND=noninteractive
ARG DEBIAN_SNAPSHOT=20260827T000000Z

SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]

# A dated Debian snapshot makes package resolution repeatable. The base image
# remains independently digest-pinned above.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* && \
    printf '%s\n' \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} trixie main" \
      "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} trixie-security main" \
      > /etc/apt/sources.list && \
    printf '%s\n' \
      'Acquire::Check-Valid-Until "false";' \
      'Acquire::Retries "8";' \
      'APT::Install-Recommends "false";' \
      'APT::Install-Suggests "false";' \
      > /etc/apt/apt.conf.d/99sparkrun

# The core image favors broadly useful, independently testable command-line
# tools. Browser automation deliberately stays in the outer Chrome process:
# current Chrome/Chromium does not ship a safe, supported linux/386 binary.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash bash-completion zsh \
      ca-certificates curl wget openssl \
      openssh-client dnsutils iproute2 netcat-openbsd socat \
      git git-lfs rsync \
      jq ripgrep fd-find tree file less \
      nano vim-tiny tmux \
      procps psmisc lsof \
      coreutils findutils grep sed gawk diffutils patch \
      tar gzip bzip2 xz-utils zip unzip \
      build-essential cmake ninja-build pkg-config gdb \
      nodejs npm \
      python3 python3-dev python3-pip python3-venv pipx \
      golang-go \
      sqlite3 \
      locales tzdata && \
    npm install --global \
      pnpm@10.34.5 \
      yarn@1.22.22 && \
    npm cache clean --force && \
    git lfs install --system --skip-repo && \
    git config --system init.defaultBranch main && \
    ln -s /usr/bin/fdfind /usr/local/bin/fd && \
    ln -s /usr/bin/python3 /usr/local/bin/python && \
    ln -s /usr/bin/pip3 /usr/local/bin/pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY vm-image/bin/sparkrun-toolchain-check /usr/local/bin/sparkrun-toolchain-check

RUN chmod 0755 /usr/local/bin/sparkrun-toolchain-check && \
    useradd --create-home --shell /bin/bash coder && \
    mkdir -p /workspace/site /root/.config && \
    chmod 0755 /workspace /workspace/site && \
    sparkrun-toolchain-check --smoke

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
