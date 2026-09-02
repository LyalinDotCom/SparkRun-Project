export const MODEL_ID = 'gemini-3.7-flash';
/** The only model this release drives. Resilience is per-model resubmission, not a lower-model fallback. */
export const ENABLED_MODELS: ReadonlyArray<{
  id: string;
  label: string;
  sub: string;
}> = [{ id: MODEL_ID, label: '3.7 Flash', sub: 'Only model enabled' }];
export const WORKSPACE_ROOT = '/workspace';
export const SITE_ROOT = `${WORKSPACE_ROOT}/site`;
export const SERVER_PORT = 8081;
export const SERVER_PORT_RANGE_END = 8120;
export const SERVER_COMMAND = `python3 ${WORKSPACE_ROOT}/.sparkrun_static_server.py --host 0.0.0.0 --port auto`;

export interface WebVmDiskProfile {
  id: string;
  label: string;
  distribution: string;
  kind: 'cloud' | 'github' | 'bytes';
  timeoutRunner: 'gnu' | 'busybox';
  /**
   * Plain-language facts about the guest that the coding agent needs before
   * it picks a toolchain: what is installed, what is missing, and the
   * no-public-egress rule. Rendered into the model's system instruction.
   */
  agentEnvironmentNotes?: string;
  nodeCompatibility?: {
    preloadPath: string;
    addonPath: string;
    compileCachePath: string;
  };
  url: string;
}

export const WEBVM_OFFICIAL_DISK_PROFILE: WebVmDiskProfile = {
  id: 'webvm-buster-2026-06-01',
  label: 'WebVM official compatibility image',
  distribution: 'Debian GNU/Linux 10 (buster)',
  kind: 'cloud',
  timeoutRunner: 'gnu',
  agentEnvironmentNotes: [
    'Guest OS: Debian GNU/Linux 10 (buster), 32-bit x86, running as root inside a CheerpX WebAssembly VM in the user\'s browser tab. It is slow compared with a native machine; keep commands small and avoid heavy builds.',
    'Installed: a POSIX shell with GNU coreutils and Python 3.7 (python3, including the http.server module). Check other tools with `command -v` before relying on them.',
    'NOT installed and NOT installable: Node.js, npm, npx, pnpm, Yarn, Go, Docker, and modern package repositories. Never run npm/npx/node/vite commands here and never try to install them.',
    'No public internet from the guest: apt-get, pip install, npm install, curl/wget to public hosts, and internet git clones all fail. Only the user\'s browser fetches remote assets.',
    'Build browser projects as static HTML/CSS/JavaScript ES modules with no build step. Load libraries through a <script type="importmap"> that points at a CDN, for example Three.js: "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js" and "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/". Do not use bundlers, TypeScript compilation, or frameworks that require npm.',
    'Serve the site with start_preview using `python3 -m http.server <port> --bind 0.0.0.0` from the site directory, or leave index.html at the workspace root and SparkRun starts its own static server after the run. Verify a started server inside the guest with python3 urllib against http://127.0.0.1:<port>.',
  ].join('\n'),
  url: 'wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2',
};

export const WEBVM_CODING_CANDIDATE_PROFILE: WebVmDiskProfile = {
  id: 'sparkrun-coding-2026-09-02-rc4',
  label: 'SparkRun coding image 2026.09.02-rc4',
  distribution: 'Alpine Linux 3.24.1',
  kind: 'bytes',
  timeoutRunner: 'busybox',
  agentEnvironmentNotes: [
    'Guest OS: Alpine Linux 3.24 (musl, 32-bit x86), running as root inside a CheerpX WebAssembly VM in the user\'s browser tab. It is slow compared with a native machine; keep commands small.',
    'Installed: bash, Node.js 24 with npm/pnpm/Yarn, Python 3.14 with pip, Go 1.26, gcc/g++, SQLite, git, curl, and common CLI tools.',
    'No public internet from the guest: npm install, pip install, go get, apk add, and internet git clones all fail. Use only preinstalled tools and load browser libraries from a CDN through an import map, because only the user\'s browser fetches remote assets.',
    'Serve web projects with start_preview binding 0.0.0.0 on the exact port you pass.',
  ].join('\n'),
  nodeCompatibility: {
    preloadPath: '/usr/local/lib/sparkrun/node-exit-preload.cjs',
    addonPath: '/usr/local/lib/sparkrun/node-exit-addon.node',
    compileCachePath: '/usr/local/lib/sparkrun/node-compile-cache',
  },
  // Keep byte-backed disks on the app origin. HttpBytesDevice discovers the
  // image size through the Content-Range response header; same-origin access
  // avoids making that correctness depend on CORS header exposure. Vite
  // proxies this immutable path to Firebase during local development.
  url: '/vm-images/sparkrun-coding-2026.09.02-rc4.ext2',
};

export const WEBVM_VENDOR_ALPINE_PROFILE: WebVmDiskProfile = {
  id: 'webvm-alpine-2025-10-07',
  label: 'WebVM vendor Alpine compatibility image',
  distribution: 'Alpine Linux 3.17 baseline',
  kind: 'cloud',
  timeoutRunner: 'busybox',
  agentEnvironmentNotes: [
    'Guest OS: Alpine Linux 3.17 baseline with busybox, 32-bit x86, running as root inside a CheerpX WebAssembly VM in the user\'s browser tab.',
    'Assume no Node.js, npm, or Go, and check for python3 with `command -v` before using it. No public internet from the guest: package installs and internet downloads fail. Build browser projects as static files that load libraries from a CDN through an import map.',
  ].join('\n'),
  url: 'wss://disks.webvm.io/alpine_20251007.ext2',
};

// The custom profile becomes the default only after its real Chrome/CheerpX
// smoke test passes. Keeping the cutover in one constant makes that release
// decision explicit and keeps IndexedDB cache names deterministic.
export const DEFAULT_WEBVM_DISK_PROFILE = WEBVM_OFFICIAL_DISK_PROFILE;
