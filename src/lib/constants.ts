export const MODEL_ID = 'gemini-3.7-flash';
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
  url: 'wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2',
};

export const WEBVM_CODING_CANDIDATE_PROFILE: WebVmDiskProfile = {
  id: 'sparkrun-coding-2026-08-27-rc3',
  label: 'SparkRun coding image 2026.08.27-rc3',
  distribution: 'Alpine Linux 3.24.1',
  kind: 'bytes',
  timeoutRunner: 'busybox',
  nodeCompatibility: {
    preloadPath: '/usr/local/lib/sparkrun/node-exit-preload.cjs',
    addonPath: '/usr/local/lib/sparkrun/node-exit-addon.node',
    compileCachePath: '/usr/local/lib/sparkrun/node-compile-cache',
  },
  // Keep byte-backed disks on the app origin. HttpBytesDevice discovers the
  // image size through the Content-Range response header; same-origin access
  // avoids making that correctness depend on CORS header exposure. Vite
  // proxies this immutable path to Firebase during local development.
  url: '/vm-images/sparkrun-coding-2026.08.27-rc3.ext2',
};

export const WEBVM_VENDOR_ALPINE_PROFILE: WebVmDiskProfile = {
  id: 'webvm-alpine-2025-10-07',
  label: 'WebVM vendor Alpine compatibility image',
  distribution: 'Alpine Linux 3.17 baseline',
  kind: 'cloud',
  timeoutRunner: 'busybox',
  url: 'wss://disks.webvm.io/alpine_20251007.ext2',
};

// The custom profile becomes the default only after its real Chrome/CheerpX
// smoke test passes. Keeping the cutover in one constant makes that release
// decision explicit and keeps IndexedDB cache names deterministic.
export const DEFAULT_WEBVM_DISK_PROFILE = WEBVM_OFFICIAL_DISK_PROFILE;
