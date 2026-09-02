import {
  SERVER_COMMAND,
  SERVER_PORT,
  SERVER_PORT_RANGE_END,
  SITE_ROOT,
  DEFAULT_WEBVM_DISK_PROFILE,
  WORKSPACE_ROOT,
  type WebVmDiskProfile,
} from './constants';
import {
  normalizeSitePath,
  toVmPath,
  type DirectoryEntry,
  type VmCommandResult,
  type VmFileBackend,
} from './vmFileContract';
import type {
  CodingRuntime,
  CodingRuntimePreviewOptions,
  CodingRuntimePreviewResult,
} from './codingHarness';
import type {
  PrivateNetworkConnectOptions,
  WorkspaceRuntime,
} from './workspaceRuntime';

type ConsoleCallback = (text: string) => void;
type StatusCallback = (status: WebVmStatus) => void;
type DebugCallback = (entry: WebVmDebugEntry) => void;

type CheerpXModule = {
  CloudDevice: {
    create(url: string): Promise<unknown>;
  };
  GitHubDevice: {
    create(url: string): Promise<unknown>;
  };
  HttpBytesDevice: {
    create(url: string): Promise<unknown>;
  };
  IDBDevice: {
    create(name: string): Promise<IdbDevice>;
  };
  OverlayDevice: {
    create(baseDevice: unknown, overlayDevice: unknown): Promise<unknown>;
  };
  DataDevice: {
    create(): Promise<DataDevice>;
  };
  Linux: {
    create(options: {
      mounts: Array<{ type: string; path: string; dev?: unknown }>;
      networkInterface?: unknown;
    }): Promise<CheerpXLinux>;
  };
};

type IdbDevice = {
  readFileAsBlob(path: string): Promise<Blob | null>;
  reset(): Promise<void>;
};

type DataDevice = {
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
};

export const API_RETRY_LIMIT = 8;

type ApiRetryOptions = {
  delay?: (milliseconds: number) => Promise<void>;
  onRetry?: (retry: number, error: unknown) => void;
};

const defaultRetryDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

/** Run one initial API attempt plus exactly eight retries before failing. */
export async function withEightApiRetries<T>(
  operation: (retry: number) => Promise<T>,
  options: ApiRetryOptions = {},
): Promise<T> {
  const delay = options.delay ?? defaultRetryDelay;
  let lastError: unknown;
  for (let retry = 0; retry <= API_RETRY_LIMIT; retry += 1) {
    try {
      return await operation(retry);
    } catch (error) {
      lastError = error;
      if (retry === API_RETRY_LIMIT) break;
      const nextRetry = retry + 1;
      options.onRetry?.(nextRetry, error);
      await delay(Math.min(250 * 2 ** retry, 2_000));
    }
  }
  throw lastError;
}

export function cacheBustedByteDeviceUrl(url: string, retry: number): string {
  if (retry === 0) return url;
  const isRootRelative = url.startsWith('/');
  const parsed = new URL(url, 'https://sparkrun.invalid');
  parsed.searchParams.set('sparkrun-range-retry', String(retry));
  return isRootRelative
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}

type CheerpXLinux = {
  delete(): void;
  run(
    fileName: string,
    args: string[],
    options?: {
      env?: string[];
      cwd?: string;
      uid?: number;
      gid?: number;
    },
  ): Promise<{ status: number }>;
  setCustomConsole(
    callback: (buf: ArrayBuffer | Uint8Array, vt?: number) => void,
    cols?: number,
    rows?: number,
  ): (charCode: number) => void;
  networkLogin?: () => Promise<void> | void;
};

export type WebVmLifecycle =
  | 'idle'
  | 'booting'
  | 'ready'
  | 'tailnet-login-ready'
  | 'tailnet-connected'
  | 'server-running'
  | 'error';

export interface WebVmStatus {
  lifecycle: WebVmLifecycle;
  message: string;
  tailnetIp?: string | null;
  loginUrl?: string | null;
  previewUrl?: string | null;
  serverPort?: number | null;
}

export interface WebVmDebugEntry {
  phase: string;
  command?: string;
  cwd?: string;
  status?: number;
  output?: string;
  background?: boolean;
}

export interface CreateWebVmBackendOptions {
  tailscaleAuthKey?: string;
  workspaceDbName?: string;
  rootCacheDbName?: string;
  prepareWorkspace?: 'preserve' | 'clean-site';
  diskProfile?: WebVmDiskProfile;
  onConsole?: ConsoleCallback;
  onStatus?: StatusCallback;
  onDebug?: DebugCallback;
  /**
   * Outer-browser readiness probe for a managed preview URL. Resolves true
   * when the browser received any HTTP response from the URL. Defaults to a
   * no-cors fetch; tests inject a fake.
   */
  probePreviewUrl?: PreviewUrlProbe;
}

export type PreviewUrlProbe = (
  url: string,
  signal: AbortSignal,
) => Promise<boolean>;

/**
 * Managed previews are proven from the outer browser, never from inside the
 * guest. A loopback `curl`/`python` GET against 127.0.0.1 can wedge inside
 * CheerpX 1.3.9's userspace network stack, outlive the command watchdog, and
 * dispose an otherwise healthy VM (observed on the live site, 2026-09-02).
 * A no-cors fetch resolves for any HTTP response, including an opaque one
 * from a server that sets no CORS headers, and rejects on connection failure.
 */
export const defaultPreviewUrlProbe: PreviewUrlProbe = async (url, signal) => {
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal });
    return true;
  } catch {
    return false;
  }
};
const MANAGED_PREVIEW_PROBE_TIMEOUT_MS = 4_000;
const MANAGED_PREVIEW_PROBE_INTERVAL_MS = 1_000;

export interface ConnectTailnetOptions {
  timeoutMs?: number;
  forceLogin?: boolean;
}

type ActiveCapture = {
  outputByVirtualTerminal: Map<number | 'default', string>;
  streamToConsole: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function containsUnsupportedDetachment(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let unquoted = '';
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (escaped) {
      escaped = false;
      unquoted += ' ';
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      unquoted += ' ';
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      unquoted += character === '\n' ? '\n' : ' ';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      unquoted += ' ';
      continue;
    }
    if (character === '#') {
      const previous = index === 0 ? '\n' : (command[index - 1] ?? '');
      if (/\s/.test(previous)) {
        while (index < command.length && command[index] !== '\n') index += 1;
        unquoted += '\n';
        continue;
      }
    }
    unquoted += character;
  }

  if (/(^|[\s;|()])(?:nohup|disown|coproc)(?=$|[\s;|&()])/m.test(unquoted)) {
    return true;
  }
  if (
    /(^|[\s;|()])setsid(?=$|[\s;|&()])[^\n;|&]*(?:--fork|(?:^|\s)-[^\s-]*f)/m.test(
      unquoted,
    )
  ) {
    return true;
  }
  for (let index = 0; index < unquoted.length; index += 1) {
    if (unquoted[index] !== '&') continue;
    const previous = unquoted[index - 1] ?? '';
    const next = unquoted[index + 1] ?? '';
    if (next === '&') {
      index += 1;
      continue;
    }
    // Redirection (`2>&1`, `<&0`, `&>file`) and Bash's `|&` pipe are finite
    // shell syntax, not a detached process request.
    if (previous === '>' || previous === '<' || previous === '|' || next === '>') {
      continue;
    }
    return true;
  }
  return false;
}


function toWorkspaceDevicePath(relativePath: string): string {
  return `/site/${normalizeSitePath(relativePath)}`;
}

function stageName(): string {
  return `stage-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
}

/**
 * The CodingRuntime contract documents cwd as "absolute VM path, or a path
 * relative to workspaceRoot"; resolve the relative form here instead of
 * handing it to cx.run unresolved.
 */
function resolveRuntimeCwd(rawCwd: string | undefined): string {
  const trimmed = rawCwd?.trim();
  if (!trimmed) return SITE_ROOT;
  return trimmed.startsWith('/') ? trimmed : `${SITE_ROOT}/${trimmed}`;
}

function commandAbortError(): Error {
  const error = new Error('VM command was stopped.');
  error.name = 'AbortError';
  return error;
}

const SERVER_SCRIPT_PATH = `${WORKSPACE_ROOT}/.sparkrun_static_server.py`;
const SERVER_SCRIPT = `
import argparse
import errno
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SITE_ROOT = "${SITE_ROOT}"
BASE_PORT = ${SERVER_PORT}
MAX_PORT = ${SERVER_PORT_RANGE_END}
STATE_DIR = "/tmp/sparkrun"
LOG_PATH = STATE_DIR + "/server.log"
PID_PATH = STATE_DIR + "/server.pid"
PORT_PATH = STATE_DIR + "/server.port"
HOST_PATH = STATE_DIR + "/server.host"
URL_PATH = STATE_DIR + "/server.url"
READY_PATH = STATE_DIR + "/server.ready"
os.makedirs(STATE_DIR, exist_ok=True)

def write_log(message):
    with open(LOG_PATH, "a", encoding="utf-8") as log:
        log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\\n")
        log.flush()

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        write_log("%s - %s" % (self.address_string(), format % args))

class ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="auto")
parser.add_argument("--port", default="auto")
args = parser.parse_args()

auto_port = args.port == "auto"
start_port = BASE_PORT if auto_port else int(args.port)
os.makedirs(SITE_ROOT, exist_ok=True)
os.chdir(SITE_ROOT)
for path in (PORT_PATH, HOST_PATH, URL_PATH, READY_PATH):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass

server = None
bound_host = None
bound_port = None
hosts = ["0.0.0.0", "127.0.0.1"] if args.host == "auto" else [args.host]
ports = range(start_port, MAX_PORT + 1)
last_error = None
for host in hosts:
    for port in ports:
        try:
            server = ReusableServer((host, port), Handler)
            bound_host = host
            bound_port = server.server_address[1]
            break
        except OSError as exc:
            last_error = exc
            write_log(
                f"bind failed host={host} port={port}: "
                f"errno={exc.errno} strerror={exc.strerror!r}"
            )
            if exc.errno == errno.EADDRINUSE:
                continue
            break
    if server is not None:
        break

if server is None or bound_host is None or bound_port is None:
    detail = f": errno={last_error.errno} strerror={last_error.strerror!r}" if last_error else ""
    raise RuntimeError(f"No available bind target for host={args.host} port={args.port}{detail}")

with open(PID_PATH, "w", encoding="utf-8") as pid_file:
    pid_file.write(str(os.getpid()))
with open(PORT_PATH, "w", encoding="utf-8") as port_file:
    port_file.write(str(bound_port))
with open(HOST_PATH, "w", encoding="utf-8") as host_file:
    host_file.write(str(bound_host))
with open(URL_PATH, "w", encoding="utf-8") as url_file:
    url_file.write(f"http://{bound_host}:{bound_port}/")
# CheerpX 1.3.9's userspace Tailscale stack cannot reliably loop a second
# connection from this VM back into itself. The bind succeeded synchronously;
# READY_PATH records that bind, while outer Chrome performs release E2E proof.
with open(READY_PATH, "w", encoding="utf-8") as ready_file:
    ready_file.write("SPARKRUN_BOUND")
write_log(f"SparkRun Python server bound {bound_host}:{bound_port}")
server.serve_forever()
`.trimStart();

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const BOOTSTRAP_COMMAND_TIMEOUT_MS = 60_000;
const VM_TIMEOUT_KILL_GRACE_SECONDS = 2;
// The completion marker travels through the Worker->main console pipeline and
// can trail cx.run settling by however long the queued output takes to drain.
// The drain is therefore progress-based: keep waiting while bytes are still
// arriving, give up only after a quiet period with no marker, and always stop
// at a hard cap so a truly wedged pipeline still fails closed.
const COMMAND_COMPLETION_QUIET_DRAIN_MS = 1_000;
const COMMAND_COMPLETION_DRAIN_HARD_LIMIT_MS = 30_000;
const COMMAND_CONSOLE_DRAIN_POLL_MS = 5;
const COMMAND_TRAILING_OUTPUT_DRAIN_MS = 20;
const HOST_COMMAND_WATCHDOG_GRACE_MS = 15_000;
const COMMAND_COMPLETION_PREFIX = '__SPARKRUN_COMMAND_COMPLETED_';
const SERVER_STATE_DIR = '/tmp/sparkrun';
const SERVER_LOG_PATH = `${SERVER_STATE_DIR}/server.log`;
const SERVER_PORT_PATH = `${SERVER_STATE_DIR}/server.port`;
const SERVER_PID_PATH = `${SERVER_STATE_DIR}/server.pid`;
const SERVER_HOST_PATH = `${SERVER_STATE_DIR}/server.host`;
const SERVER_URL_PATH = `${SERVER_STATE_DIR}/server.url`;
const SERVER_READY_PATH = `${SERVER_STATE_DIR}/server.ready`;
const SERVER_LAUNCH_PID_PATH = `${SERVER_STATE_DIR}/server.launch.pid`;
const TAILSCALE_LOGIN_HOSTS = new Set(['login.tailscale.com']);

const SERVER_CLEANUP_COMMAND = [
  `mkdir -p ${SERVER_STATE_DIR}`,
  'sparkrun_valid_pid() { case "$1" in ""|*[!0-9]*) return 1 ;; esac; [ "$1" -gt 1 ]; }',
  'sparkrun_own_group="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d " \\n")"',
  `sparkrun_group="$([ -f ${SERVER_LAUNCH_PID_PATH} ] && cat ${SERVER_LAUNCH_PID_PATH} 2>/dev/null || true)"`,
  `sparkrun_pid="$([ -f ${SERVER_PID_PATH} ] && cat ${SERVER_PID_PATH} 2>/dev/null || true)"`,
  'sparkrun_term_group() { sparkrun_valid_pid "$1" || return 0; [ "$1" = "$sparkrun_own_group" ] && return 0; kill -TERM -- "-$1" 2>/dev/null || true; }',
  'sparkrun_kill_group() { sparkrun_valid_pid "$1" || return 0; [ "$1" = "$sparkrun_own_group" ] && return 0; kill -KILL -- "-$1" 2>/dev/null || true; }',
  'sparkrun_term_pid() { sparkrun_valid_pid "$1" || return 0; kill -TERM -- "$1" 2>/dev/null || true; }',
  'sparkrun_kill_pid() { sparkrun_valid_pid "$1" || return 0; kill -KILL -- "$1" 2>/dev/null || true; }',
  'sparkrun_term_group "$sparkrun_group"',
  'sparkrun_term_pid "$sparkrun_pid"',
  "for pid in $(ps -eo pid,args 2>/dev/null | awk '/[.]sparkrun_static_server.py/ {print $1}'); do sparkrun_term_pid \"$pid\"; done",
  'sleep 1',
  'sparkrun_kill_group "$sparkrun_group"',
  'sparkrun_kill_pid "$sparkrun_pid"',
  "for pid in $(ps -eo pid,args 2>/dev/null | awk '/[.]sparkrun_static_server.py/ {print $1}'); do sparkrun_kill_pid \"$pid\"; done",
  `rm -f ${SERVER_PID_PATH} ${SERVER_PORT_PATH} ${SERVER_HOST_PATH} ${SERVER_URL_PATH} ${SERVER_READY_PATH} ${SERVER_LAUNCH_PID_PATH} ${SERVER_LOG_PATH}`,
].join(' ; ');

function formatPreviewUrl(ip: string | null, port: number | null): string | null {
  if (!ip || !port) {
    return null;
  }
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${port}/`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

type FatalTailnetRuntimeListener = (
  error: CheerpXNetworkReloadRequiredError,
) => void;

interface FatalTailnetRuntimeRegistry {
  fatalDiagnostic: string | null;
  listeners: Set<FatalTailnetRuntimeListener>;
  listenerInstalled: boolean;
  lastDebugSink: DebugCallback | null;
}

const FATAL_TAILNET_REGISTRY_KEY = '__sparkrunFatalTailnetRuntimeV1__';
const fatalTailnetRegistry = (() => {
  const globalRecord = globalThis as typeof globalThis & {
    [FATAL_TAILNET_REGISTRY_KEY]?: FatalTailnetRuntimeRegistry;
  };
  const existing = globalRecord[FATAL_TAILNET_REGISTRY_KEY];
  if (existing) return existing;
  const created: FatalTailnetRuntimeRegistry = {
    fatalDiagnostic: null,
    listeners: new Set(),
    listenerInstalled: false,
    lastDebugSink: null,
  };
  globalRecord[FATAL_TAILNET_REGISTRY_KEY] = created;
  return created;
})();

const FATAL_TAILNET_RECOVERY_MESSAGE =
  'The in-page WebVM network runtime crashed. Reload the browser tab to rebuild it; restarting only the VM cannot repair it. The Browser Vault workspace is safe.';

export class CheerpXNetworkReloadRequiredError extends Error {
  constructor() {
    super(FATAL_TAILNET_RECOVERY_MESSAGE);
    this.name = 'CheerpXNetworkReloadRequiredError';
  }
}

function normalizeFatalTailnetRuntimeCandidate(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 20_000);
  if (value instanceof Error) {
    return [value.name, value.message, value.stack]
      .filter(Boolean)
      .join('\n')
      .slice(0, 20_000);
  }
  if (typeof ErrorEvent !== 'undefined' && value instanceof ErrorEvent) {
    return [
      normalizeFatalTailnetRuntimeCandidate(value.error),
      value.message,
      value.filename,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 20_000);
  }
  if (value && typeof value === 'object') {
    const candidate = value as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
      filename?: unknown;
    };
    return [
      candidate.name,
      candidate.message,
      candidate.stack,
      candidate.filename,
    ]
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
      .slice(0, 20_000);
  }
  return String(value).slice(0, 20_000);
}

export function isFatalTailnetRuntimeError(value: unknown): boolean {
  const message = normalizeFatalTailnetRuntimeCandidate(value);
  return (
    /memory access out of bounds/i.test(message) &&
    /\b(?:tcp_input|tcp_bind)\b/i.test(message) &&
    /(?:ipstack|tailscale_tun)(?:\.js)?/i.test(message)
  );
}

function recordFatalTailnetRuntimeError(value: unknown): boolean {
  if (!isFatalTailnetRuntimeError(value)) return false;
  if (fatalTailnetRegistry.fatalDiagnostic) return true;
  fatalTailnetRegistry.fatalDiagnostic =
    normalizeFatalTailnetRuntimeCandidate(value);
  const error = new CheerpXNetworkReloadRequiredError();
  for (const listener of [...fatalTailnetRegistry.listeners]) {
    listener(error);
  }
  return true;
}

export function getFatalTailnetRuntimeFailure(): string | null {
  return fatalTailnetRegistry.fatalDiagnostic
    ? FATAL_TAILNET_RECOVERY_MESSAGE
    : null;
}

/** Test-only reset for the page-lifetime fault latch. */
export function resetFatalTailnetRuntimeFailureForTests(): void {
  fatalTailnetRegistry.fatalDiagnostic = null;
  fatalTailnetRegistry.listeners.clear();
  fatalTailnetRegistry.lastDebugSink = null;
}

declare const __CHEERPX_PINNED_VERSION__: string;
declare const __SPARKRUN_BUILD_SHA__: string;
declare const __SPARKRUN_BUILD_TIME__: string;

export const CHEERPX_PINNED_VERSION: string =
  typeof __CHEERPX_PINNED_VERSION__ === 'string'
    ? __CHEERPX_PINNED_VERSION__
    : 'unknown';

export const SPARKRUN_BUILD_SHA: string =
  typeof __SPARKRUN_BUILD_SHA__ === 'string' ? __SPARKRUN_BUILD_SHA__ : 'dev';

export const SPARKRUN_BUILD_TIME: string =
  typeof __SPARKRUN_BUILD_TIME__ === 'string'
    ? __SPARKRUN_BUILD_TIME__
    : 'dev';

export const DEFAULT_WORKSPACE_DB_NAME = 'sparkrun-workspace';
export const DEFAULT_ROOT_CACHE_DB_NAME = 'sparkrun-root-cache-debian-2026-06-01';

export const SPARKRUN_IDB_DATABASES = [
  DEFAULT_WORKSPACE_DB_NAME,
  DEFAULT_ROOT_CACHE_DB_NAME,
] as const;

export async function hardResetSparkrunCaches(options: {
  includeDiskCache?: boolean;
  workspaceDbName?: string;
  rootCacheDbName?: string;
} = {}): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment.');
  }
  const targets: string[] = [
    options.workspaceDbName?.trim() || DEFAULT_WORKSPACE_DB_NAME,
  ];
  if (options.includeDiskCache) {
    targets.push(
      options.rootCacheDbName?.trim() || DEFAULT_ROOT_CACHE_DB_NAME,
    );
  }
  await Promise.all(
    Array.from(new Set(targets)).map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
          request.onblocked = () => {
            // Another tab still holds it open. Resolve anyway so caller can
            // reload the page, which releases the connection.
            resolve();
          };
        }),
    ),
  );
}

export function detectCheerpxRuntimeVersion(): string | null {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) {
    return null;
  }
  const entries = performance.getEntriesByType('resource') as Array<{
    name: string;
  }>;
  for (const entry of entries) {
    const match = entry.name.match(
      /cxrtnc\.leaningtech\.com\/(\d+\.\d+\.\d+)\//,
    );
    if (match) {
      return match[1] ?? null;
    }
  }
  return null;
}

const TAILSCALE_AUTH_KEY_PATTERN = /^tskey-auth-[A-Za-z0-9_-]+$/;

export function validateTailscaleAuthKey(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return 'Tailscale auth key is required.';
  }
  if (!value.startsWith('tskey-')) {
    return 'Tailscale auth keys start with "tskey-". Generate one in the Tailscale admin console under Settings → Keys.';
  }
  if (value.startsWith('tskey-client-')) {
    return 'This is an OAuth client credential, not a device auth key. Generate an auth key in the Tailscale admin console under Settings → Keys.';
  }
  if (!TAILSCALE_AUTH_KEY_PATTERN.test(value)) {
    return 'This does not look like a Tailscale auth key. It should look like "tskey-auth-..." with no spaces.';
  }
  if (value.length < 30) {
    return 'This auth key looks too short. Reusable keys are typically 40+ characters.';
  }
  return null;
}

// Google AI Studio now issues both legacy standard keys and dotted
// authorization keys. Keep this check deliberately structural: the API is
// the authority on whether an opaque key is valid.
const GOOGLE_API_KEY_PATTERN = /^[A-Za-z0-9_.-]{20,200}$/;

export function validateGoogleApiKey(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return 'Google AI Studio API key is required.';
  }
  if (!GOOGLE_API_KEY_PATTERN.test(value)) {
    return 'This does not look like a Google API key. Paste the key exactly as issued, with no spaces.';
  }
  return null;
}

export class WebVmBackend
  implements VmFileBackend, CodingRuntime, WorkspaceRuntime
{
  readonly id = `cheerpx-${crypto.randomUUID()}`;
  readonly provider = 'cheerpx' as const;
  readonly workspaceRoot = SITE_ROOT;
  readonly capabilities = {
    interactiveTerminal: true,
    managedPreview: true,
    privatePreview: true,
    workspaceArchive: true,
    hardDispose: true,
  } as const;
  private activeCapture: ActiveCapture | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private tailnetIp: string | null = null;
  private loginUrl: string | null = null;
  private serverPort: number | null = null;
  private serverStarted = false;
  private startServerPromise: Promise<VmCommandResult> | null = null;
  private serverProcessPromise: Promise<{ status: number }> | null = null;
  private serverLastExit: VmCommandResult | null = null;
  private commandRunnerTimedOut = false;
  private consoleInput: ((charCode: number) => void) | null = null;
  private interactiveShellRunning = false;
  private interactiveShellPromise: Promise<{ status: number }> | null = null;
  private tailnetLoginStarted = false;
  private probePreviewUrl: PreviewUrlProbe = defaultPreviewUrlProbe;
  private tailnetConnectPromise: Promise<string | null> | null = null;
  private resolveTailnetSignal: ((url: string | null) => void) | null = null;
  private rejectTailnetSignal: ((error: Error) => void) | null = null;
  private highestTailnetState: number | null = null;
  private fatalNetworkFailurePublished = false;
  private readonly fatalNetworkRuntimeListener: FatalTailnetRuntimeListener;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  private constructor(
    private readonly cx: CheerpXLinux,
    private readonly workspaceDevice: IdbDevice,
    private readonly dataDevice: DataDevice,
    private readonly autoConnectTailnetForServer: boolean,
    private readonly timeoutRunner: 'gnu' | 'busybox',
    private readonly nodeCompatibility: WebVmDiskProfile['nodeCompatibility'],
    private readonly onConsole?: ConsoleCallback,
    private readonly onStatus?: StatusCallback,
    private readonly onDebug?: DebugCallback,
  ) {
    this.fatalNetworkRuntimeListener = () => {
      this.publishFatalNetworkFailure();
    };
    fatalTailnetRegistry.listeners.add(this.fatalNetworkRuntimeListener);
  }

  private async awaitAbortable<T>(
    operation: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return operation;
    if (signal.aborted) {
      await this.dispose();
      throw commandAbortError();
    }

    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        // CheerpX exposes no reliable per-process kill handle. Deleting the VM
        // is the only fail-closed process-tree cancellation boundary.
        void this.dispose();
        reject(commandAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  static async create(options: CreateWebVmBackendOptions): Promise<WebVmBackend> {
    if (typeof window !== 'undefined' && !fatalTailnetRegistry.listenerInstalled) {
      fatalTailnetRegistry.listenerInstalled = true;
      window.addEventListener('error', (event) => {
        const message = [
          normalizeFatalTailnetRuntimeCandidate(event.error ?? event),
          event.filename
            ? `${event.filename}:${event.lineno}:${event.colno}`
            : '',
        ]
          .filter(Boolean)
          .join('\n');
        console.error('[webvm] window.onerror', event);
        recordFatalTailnetRuntimeError(event.error ?? event);
        fatalTailnetRegistry.lastDebugSink?.({
          phase: 'window-error',
          status: 1,
          output: message,
        });
      });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        const message = normalizeFatalTailnetRuntimeCandidate(reason);
        console.error('[webvm] unhandledrejection', event);
        recordFatalTailnetRuntimeError(reason);
        fatalTailnetRegistry.lastDebugSink?.({
          phase: 'unhandled-rejection',
          status: 1,
          output: message,
        });
      });
    }
    fatalTailnetRegistry.lastDebugSink = options.onDebug ?? null;

    if (getFatalTailnetRuntimeFailure()) {
      options.onStatus?.({
        lifecycle: 'error',
        message: 'Network runtime crashed — reload required',
        tailnetIp: null,
        loginUrl: null,
        previewUrl: null,
        serverPort: null,
      });
      throw new CheerpXNetworkReloadRequiredError();
    }

    options.onStatus?.({
      lifecycle: 'booting',
      message: 'Loading CheerpX and disk image',
    });

    options.onDebug?.({
      phase: 'sparkrun-build',
      output: `SparkRun build sha=${SPARKRUN_BUILD_SHA} time=${SPARKRUN_BUILD_TIME}`,
    });

    const imported = await import('@leaningtech/cheerpx');
    const CheerpX = (
      'default' in imported ? imported.default : imported
    ) as unknown as CheerpXModule;
    options.onDebug?.({
      phase: 'cheerpx-version',
      output: `CheerpX pinned=${CHEERPX_PINNED_VERSION} runtime=${
        detectCheerpxRuntimeVersion() ?? 'unknown (no resource entries yet)'
      }`,
    });

    const diskProfile = options.diskProfile ?? DEFAULT_WEBVM_DISK_PROFILE;
    options.onDebug?.({
      phase: 'disk',
      output: `Loading ${diskProfile.label} (${diskProfile.id}) from ${diskProfile.url}`,
    });

    let rootDevice: unknown;
    const createRootDevice = async (url: string): Promise<unknown> => {
      if (diskProfile.kind === 'github') {
        return CheerpX.GitHubDevice.create(url);
      }
      if (diskProfile.kind === 'bytes') {
        return CheerpX.HttpBytesDevice.create(url);
      }
      return CheerpX.CloudDevice.create(url);
    };
    const createRootDeviceWithRetries = (url: string) =>
      withEightApiRetries(
        (retry) =>
          createRootDevice(
            diskProfile.kind === 'bytes'
              ? cacheBustedByteDeviceUrl(url, retry)
              : url,
          ),
        {
          onRetry: (retry, error) => {
            const message = error instanceof Error ? error.message : String(error);
            options.onDebug?.({
              phase: 'disk-retry',
              status: 1,
              output: `Disk initialization failed; retry ${retry}/${API_RETRY_LIMIT}: ${message}`,
            });
          },
        },
      );
    try {
      rootDevice = await createRootDeviceWithRetries(diskProfile.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[webvm] ${diskProfile.kind} disk create failed for`,
        diskProfile.url,
        error,
      );
      options.onDebug?.({
        phase: 'disk',
        status: 1,
        output: `${diskProfile.kind} disk create failed for ${diskProfile.url}: ${message}`,
      });
      if (diskProfile.kind === 'cloud' && diskProfile.url.startsWith('wss:')) {
        const fallbackUrl = `https:${diskProfile.url.slice('wss:'.length)}`;
        options.onDebug?.({
          phase: 'disk',
          output: `Retrying disk load over HTTPS fallback: ${fallbackUrl}`,
        });
        try {
          rootDevice = await withEightApiRetries(
            () => CheerpX.CloudDevice.create(fallbackUrl),
            {
              onRetry: (retry, retryError) => {
                const retryMessage =
                  retryError instanceof Error
                    ? retryError.message
                    : String(retryError);
                options.onDebug?.({
                  phase: 'disk-retry',
                  status: 1,
                  output: `HTTPS fallback initialization failed; retry ${retry}/${API_RETRY_LIMIT}: ${retryMessage}`,
                });
              },
            },
          );
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          console.error(
            '[webvm] CloudDevice HTTPS fallback failed for',
            fallbackUrl,
            fallbackError,
          );
          options.onDebug?.({
            phase: 'disk',
            status: 1,
            output: `CloudDevice HTTPS fallback failed for ${fallbackUrl}: ${fallbackMessage}`,
          });
          throw fallbackError;
        }
      } else {
        throw error;
      }
    }

    const rootCacheDbName =
      options.rootCacheDbName?.trim() || DEFAULT_ROOT_CACHE_DB_NAME;
    const workspaceDbName =
      options.workspaceDbName?.trim() || DEFAULT_WORKSPACE_DB_NAME;
    options.onDebug?.({
      phase: 'boot',
      output: `IndexedDB rootCache=${rootCacheDbName} workspace=${workspaceDbName} prepareWorkspace=${options.prepareWorkspace ?? 'clean-site'}`,
    });
    const rootCache = await CheerpX.IDBDevice.create(rootCacheDbName);
    const overlayDevice = await CheerpX.OverlayDevice.create(rootDevice, rootCache);
    const workspaceDevice = await CheerpX.IDBDevice.create(workspaceDbName);
    const dataDevice = await CheerpX.DataDevice.create();

    const trimmedAuthKey = options.tailscaleAuthKey?.trim() || undefined;
    const authKeyValidationError = trimmedAuthKey
      ? validateTailscaleAuthKey(trimmedAuthKey)
      : null;
    options.onDebug?.({
      phase: 'tailnet-init',
      status: authKeyValidationError ? 1 : 0,
      output: trimmedAuthKey
        ? authKeyValidationError
          ? `Tailscale auth key looks malformed: ${authKeyValidationError}`
          : `Tailscale auth key present (length=${trimmedAuthKey.length})`
        : 'Tailscale auth key NOT provided — networkLogin will be skipped or fail',
    });

    let backend: WebVmBackend | null = null;
    let pendingTailnetIp: string | null = null;
    const TAILNET_STATE_NAMES: Record<number, string> = {
      0: 'NoState',
      1: 'InUseOtherUser',
      2: 'NeedsLogin',
      3: 'NeedsMachineAuth',
      4: 'Stopped',
      5: 'Starting',
      6: 'Running',
    };
    const networkInterface = {
      authKey: trimmedAuthKey,
      loginUrlCb: (url: string) => {
        if (getFatalTailnetRuntimeFailure()) return;
        options.onDebug?.({
          phase: 'tailnet-login-url',
          output: 'Tailscale login URL callback received.',
        });
        try {
          backend?.handleLoginUrl(url);
        } catch (error) {
          console.error('[webvm] handleLoginUrl threw', error);
          options.onDebug?.({
            phase: 'tailnet-login-url',
            status: 1,
            output: `handleLoginUrl threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      },
      stateUpdateCb: (state: number) => {
        if (getFatalTailnetRuntimeFailure()) return;
        const name = TAILNET_STATE_NAMES[state] ?? `Unknown(${state})`;
        options.onDebug?.({
          phase: 'tailnet-state',
          output: `stateUpdateCb: state=${state} (${name})`,
        });
        backend?.recordTailnetState(state);
        if (state === 6) {
          backend?.publishTailnetState();
        }
      },
      netmapUpdateCb: (map: {
        self?: { addresses?: string[] };
      }) => {
        if (getFatalTailnetRuntimeFailure()) return;
        const addresses = map.self?.addresses ?? [];
        const ip = addresses[0] ?? null;
        options.onDebug?.({
          phase: 'tailnet-netmap',
          output: `netmapUpdateCb: addresses=[${addresses.join(', ')}] selectedIp=${
            ip ?? 'null'
          }`,
        });
        if (!ip) {
          console.warn('[webvm] netmapUpdateCb received empty self.addresses', map);
          // A transient empty netmap must not wipe an address we already have,
          // which would regress status to "waiting for address" and null the
          // preview URL while the server is still serving.
          if (backend?.getTailnetIp()) {
            return;
          }
        }
        if (backend) {
          backend.setTailnetIp(ip);
        } else if (ip || !pendingTailnetIp) {
          // Mirror the live-backend guard: a transient empty netmap must not
          // wipe an address captured before the backend was constructed.
          pendingTailnetIp = ip;
        }
      },
    };

    let cx: CheerpXLinux;
    try {
      cx = await CheerpX.Linux.create({
        mounts: [
          { type: 'ext2', dev: overlayDevice, path: '/' },
          { type: 'dir', dev: workspaceDevice, path: WORKSPACE_ROOT },
          { type: 'dir', dev: dataDevice, path: '/data' },
          { type: 'devs', path: '/dev' },
          { type: 'devpts', path: '/dev/pts' },
          { type: 'proc', path: '/proc' },
          { type: 'sys', path: '/sys' },
        ],
        networkInterface,
      });
    } catch (error) {
      recordFatalTailnetRuntimeError(error);
      if (getFatalTailnetRuntimeFailure()) {
        throw new CheerpXNetworkReloadRequiredError();
      }
      throw error;
    }
    if (getFatalTailnetRuntimeFailure()) {
      cx.delete();
      throw new CheerpXNetworkReloadRequiredError();
    }

    backend = new WebVmBackend(
      cx,
      workspaceDevice,
      dataDevice,
      Boolean(options.tailscaleAuthKey?.trim()),
      diskProfile.timeoutRunner,
      diskProfile.nodeCompatibility,
      options.onConsole,
      options.onStatus,
      options.onDebug,
    );
    if (options.probePreviewUrl) {
      backend.probePreviewUrl = options.probePreviewUrl;
    }
    try {
      backend.attachConsole();
      await backend.prepareWorkspace(options.prepareWorkspace ?? 'clean-site');
      // Note: we deliberately do NOT run probeWorkspaceWritable here at boot.
      // On some machines, the probe's write+rm cycle (`printf > .probe; cat; rm`)
      // leaves the IDB workspace in a half-committed state where the next
      // unrelated cp immediately fails with "Read-only file system" — even
      // though the probe itself succeeded. The probe was useful diagnostically
      // but it became the cause of what it was trying to detect. The agent's
      // first cp serves as the implicit probe; if it fails we surface the
      // failure with a clear message at that point.
      if (pendingTailnetIp) {
        backend.setTailnetIp(pendingTailnetIp);
      }
      if (!backend.tailnetIp) {
        backend.publishStatus('ready', 'VM ready');
      }
      backend.throwIfFatalNetworkFailure();
      return backend;
    } catch (error) {
      // Linux.create has already mounted both IndexedDB devices. A failed
      // console/workspace initialization must still release the CheerpX
      // instance or the next boot can find a blocked/half-open database.
      await backend.dispose().catch(() => undefined);
      throw error;
    }
  }

  getPreviewUrl(): string | null {
    return this.disposed || this.getFatalNetworkFailure()
      ? null
      : formatPreviewUrl(this.tailnetIp, this.serverPort);
  }

  getTailnetIp(): string | null {
    return this.disposed || this.getFatalNetworkFailure() ? null : this.tailnetIp;
  }

  getPrivateNetworkAddress(): string | null {
    return this.getTailnetIp();
  }

  getFatalNetworkFailure(): string | null {
    return getFatalTailnetRuntimeFailure();
  }

  private publishFatalNetworkFailure(): void {
    const message = this.getFatalNetworkFailure();
    if (!message || this.fatalNetworkFailurePublished || this.disposed) return;
    this.fatalNetworkFailurePublished = true;
    this.publishStatus('error', 'Network runtime crashed — reload required');
    this.publishDebug({
      phase: 'tailnet',
      status: 1,
      output: message,
    });
  }

  private throwIfFatalNetworkFailure(): void {
    if (!this.getFatalNetworkFailure()) return;
    this.publishFatalNetworkFailure();
    throw new CheerpXNetworkReloadRequiredError();
  }

  connectPrivateNetwork(
    options: PrivateNetworkConnectOptions = {},
  ): Promise<string | null> {
    return this.connectTailnet(options);
  }

  getServerPort(): number | null {
    return this.serverPort;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  async connectTailnet(
    options: ConnectTailnetOptions = {},
  ): Promise<string | null> {
    if (this.disposed) {
      throw new Error(
        'The VM has been disposed. Start a fresh VM before connecting its private network.',
      );
    }
    this.throwIfFatalNetworkFailure();
    if (this.tailnetIp) {
      this.publishStatus('tailnet-connected', 'Tailnet connected');
      return null;
    }
    if (!this.cx.networkLogin) {
      throw new Error('This CheerpX build does not expose networkLogin.');
    }

    // networkInterface exposes only one set of callbacks, so two independent
    // attempts cannot safely own separate resolver slots. Coalesce every
    // overlapping caller onto the same attempt. This also prevents a second
    // caller (including startServer) from invoking networkLogin again while
    // the first login is still progressing.
    if (this.tailnetConnectPromise) {
      this.publishDebug({
        phase: 'tailnet',
        output: 'Reusing the in-flight Tailnet connection attempt.',
      });
      return this.tailnetConnectPromise;
    }

    if (this.loginUrl && !options.forceLogin) {
      return this.loginUrl;
    }

    const connectPromise = this.connectTailnetInner(options);
    this.tailnetConnectPromise = connectPromise;
    try {
      return await connectPromise;
    } finally {
      if (this.tailnetConnectPromise === connectPromise) {
        this.tailnetConnectPromise = null;
      }
    }
  }

  private async connectTailnetInner(
    options: ConnectTailnetOptions,
  ): Promise<string | null> {
    this.throwIfFatalNetworkFailure();
    const networkLogin = this.cx.networkLogin;
    if (!networkLogin) {
      throw new Error('This CheerpX build does not expose networkLogin.');
    }
    if (options.forceLogin) {
      this.resolveTailnetSignal = null;
      this.rejectTailnetSignal = null;
      this.loginUrl = null;
      this.tailnetLoginStarted = false;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let resolveSignal!: (url: string | null) => void;
    let rejectSignal!: (error: Error) => void;
    const signalPromise = new Promise<string | null>((resolve, reject) => {
      resolveSignal = resolve;
      rejectSignal = reject;
    });
    this.resolveTailnetSignal = resolveSignal;
    this.rejectTailnetSignal = rejectSignal;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), options.timeoutMs ?? 15_000);
    });
    let rejectFatalRuntime!: FatalTailnetRuntimeListener;
    const fatalRuntimePromise = new Promise<never>((_resolve, reject) => {
      rejectFatalRuntime = (error) => reject(error);
      fatalTailnetRegistry.listeners.add(rejectFatalRuntime);
      if (this.getFatalNetworkFailure()) {
        rejectFatalRuntime(new CheerpXNetworkReloadRequiredError());
      }
    });

    this.publishStatus('booting', 'Starting Tailscale login');
    if (!this.tailnetLoginStarted) {
      this.tailnetLoginStarted = true;
      const reportLoginFailure = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[webvm] cx.networkLogin() rejected', error);
        const isFatal = recordFatalTailnetRuntimeError(error);
        this.publishDebug({
          phase: 'tailnet-login',
          status: 1,
          output: `networkLogin() rejected: ${message}`,
        });
        this.tailnetLoginStarted = false;
        if (this.rejectTailnetSignal === rejectSignal) {
          rejectSignal(
            isFatal
              ? new CheerpXNetworkReloadRequiredError()
              : error instanceof Error
                ? error
                : new Error(String(error)),
          );
        }
      };
      try {
        void Promise.resolve(networkLogin.call(this.cx)).catch(reportLoginFailure);
      } catch (error) {
        reportLoginFailure(error);
      }
    }

    try {
      const result = await Promise.race([
        signalPromise.catch((error: unknown) => {
          if (error instanceof CheerpXNetworkReloadRequiredError) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          console.error('[webvm] tailnet signal rejected', error);
          this.publishDebug({
            phase: 'tailnet',
            status: 1,
            output: `Tailnet signal rejected: ${message}`,
          });
          return null;
        }),
        timeoutPromise,
        fatalRuntimePromise,
      ]);
      this.throwIfFatalNetworkFailure();
      if (result === null && !this.tailnetIp && !this.loginUrl) {
        if (
          this.highestTailnetState === null ||
          this.highestTailnetState <= 0
        ) {
          this.publishStatus(
            'error',
            'Tailscale auth key rejected — generate a fresh reusable key',
          );
          this.publishDebug({
            phase: 'tailnet',
            status: 1,
            output:
              'Tailnet stuck at NoState. The Tailscale auth key was almost certainly rejected — it may be expired, single-use and already consumed, or for a different tailnet. Generate a new reusable, ephemeral auth key in the Tailscale admin console (Settings → Keys) and try again.',
          });
        } else {
          this.publishStatus('booting', 'Tailnet connection started; waiting for IP');
          this.publishDebug({
            phase: 'tailnet',
            output: `connectTailnet timed out after ${
              options.timeoutMs ?? 15_000
            }ms; highest state seen: ${
              this.highestTailnetState ?? 'none'
            }. Check DevTools console for COEP/CORP errors.`,
          });
        }
      }
      this.throwIfFatalNetworkFailure();
      return result;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      fatalTailnetRegistry.listeners.delete(rejectFatalRuntime);
      // A timeout settles the caller but not signalPromise. Release the exact
      // callbacks owned by this attempt so they cannot become orphaned or be
      // mistaken for a later retry's waiters.
      if (this.resolveTailnetSignal === resolveSignal) {
        this.resolveTailnetSignal = null;
      }
      if (this.rejectTailnetSignal === rejectSignal) {
        this.rejectTailnetSignal = null;
      }
    }
  }

  async resetWorkspace(): Promise<void> {
    if (this.commandRunnerTimedOut || this.disposed) {
      throw new Error(
        'This VM was stopped after an unverified command timeout. Start a fresh VM before resetting its workspace.',
      );
    }
    await this.stopServer();
    await this.workspaceDevice.reset();
    this.serverStarted = false;
    this.startServerPromise = null;
    this.serverLastExit = null;
    this.serverPort = null;
    await this.prepareWorkspace('clean-site');
    this.publishStatus('ready', 'Workspace reset');
  }

  /**
   * Create a byte-faithful recovery archive outside the app's metadata store.
   * The tarball preserves binary files, dotfiles, modes, symlinks and empty
   * directories; the caller commits the returned Blob to the independent
   * SparkRun browser vault before any destructive VM action.
   */
  async createWorkspaceArchive(): Promise<Blob> {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const archiveName = `.sparkrun-vault-export-${stamp}.tar.gz`;
    const archiveVmPath = `${WORKSPACE_ROOT}/${archiveName}`;
    const archiveDevicePath = `/${archiveName}`;
    const command = [
      `rm -f ${shellQuote(archiveVmPath)}`,
      `tar -C ${shellQuote(WORKSPACE_ROOT)} --exclude=${shellQuote(
        '.sparkrun-vault-export-*.tar.gz',
      )} -czf ${shellQuote(archiveVmPath)} site`,
    ].join(' && ');
    const result = await this.execBash(
      command,
      WORKSPACE_ROOT,
      false,
      false,
      120_000,
    );
    if (result.status !== 0) {
      throw new Error(
        `Could not archive the VM workspace: ${
          result.output || `tar exited with status ${result.status}`
        }`,
      );
    }
    try {
      const blob = await this.workspaceDevice.readFileAsBlob(archiveDevicePath);
      if (!blob || blob.size === 0) {
        throw new Error('The VM created an empty workspace archive.');
      }
      // Detach the returned bytes from the workspace database. Some IDBDevice
      // implementations stream lazily, so deleting the staging inode before a
      // copy is materialized can invalidate the Blob.
      return new Blob([await blob.arrayBuffer()], { type: 'application/gzip' });
    } finally {
      await this.execBash(
        `rm -f ${shellQuote(archiveVmPath)}`,
        WORKSPACE_ROOT,
        false,
        false,
        15_000,
        false,
      ).catch(() => undefined);
    }
  }

  /** Restore a previously committed tar.gz checkpoint into a clean site root. */
  async restoreWorkspaceArchive(archive: Blob): Promise<void> {
    const stage = `restore-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`;
    const restoreRoot = `/tmp/sparkrun/${stage}-tree`;
    const stopped = await this.stopServer();
    if (stopped.status !== 0) {
      throw new Error(
        `Could not stop the preview before restoring the VM workspace checkpoint: ${
          stopped.output || `cleanup exited with status ${stopped.status}`
        }`,
      );
    }
    await this.dataDevice.writeFile(`/${stage}`, new Uint8Array(await archive.arrayBuffer()));
    const result = await this.execBash(
      [
        // /data is an in-memory DataDevice. Always remove the unique staging
        // archive when this shell exits, including ordinary extraction/copy
        // failures, so repeated restores cannot exhaust browser memory.
        `trap ${shellQuote(
          `rm -f ${shellQuote(`/data/${stage}`)}; rm -rf ${shellQuote(restoreRoot)}`,
        )} EXIT`,
        // Extract on the root overlay first. Direct tar extraction into the
        // IDBDevice workspace triggers CheerpX's fileData worker failure, and
        // root-owned archives also attempt an unsupported chown syscall.
        `rm -rf ${shellQuote(restoreRoot)}`,
        `mkdir -p ${shellQuote(restoreRoot)}`,
        `tar --no-same-owner -C ${shellQuote(restoreRoot)} -xzf ${shellQuote(`/data/${stage}`)}`,
        `test -d ${shellQuote(`${restoreRoot}/site`)}`,
        // Keep the healthy SITE_ROOT inode created at boot. Copying ordinary
        // files across mounts follows the same path as writeText/writeBytes,
        // which CheerpX handles reliably, without tar applying metadata to IDB.
        `mkdir -p ${shellQuote(SITE_ROOT)}`,
        `rm -rf ${shellQuote(SITE_ROOT)}/* ${shellQuote(SITE_ROOT)}/.[!.]* ${shellQuote(SITE_ROOT)}/..?*`,
        `cp -dR ${shellQuote(`${restoreRoot}/site`)}/. ${shellQuote(SITE_ROOT)}/`,
        `rm -rf ${shellQuote(restoreRoot)}`,
        `test -d ${shellQuote(SITE_ROOT)}`,
      ].join(' && '),
      '/',
      false,
      false,
      120_000,
    );
    if (result.status !== 0) {
      await this.cleanupDataStage(stage, restoreRoot);
      throw new Error(
        `Could not restore the VM workspace checkpoint: ${
          result.output || `tar exited with status ${result.status}`
        }`,
      );
    }
    this.publishDebug({
      phase: 'checkpoint-restore',
      output: `Restored ${archive.size} bytes through the root overlay into ${SITE_ROOT}.`,
    });
  }

  async readText(relativePath: string): Promise<string> {
    const normalized = normalizeSitePath(relativePath);
    const blob = await this.workspaceDevice.readFileAsBlob(
      toWorkspaceDevicePath(normalized),
    );
    if (!blob || typeof blob.text !== 'function') {
      throw new Error(`File not found: ${toVmPath(normalized)}`);
    }
    return blob.text();
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    const normalized = normalizeSitePath(relativePath);
    const blob = await this.workspaceDevice.readFileAsBlob(
      toWorkspaceDevicePath(normalized),
    );
    if (!blob || typeof blob.arrayBuffer !== 'function') {
      throw new Error(`File not found: ${toVmPath(normalized)}`);
    }
    return new Uint8Array(await blob.arrayBuffer());
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    const normalized = normalizeSitePath(relativePath);
    await this.copyContentToVm(toVmPath(normalized), content, SITE_ROOT);
  }

  async writeBytes(relativePath: string, content: Uint8Array): Promise<void> {
    const normalized = normalizeSitePath(relativePath);
    await this.copyContentToVm(toVmPath(normalized), content, SITE_ROOT);
  }

  private async copyContentToVm(
    destination: string,
    content: string | Uint8Array,
    cwd: string,
  ): Promise<void> {
    const staged = stageName();
    await this.dataDevice.writeFile(`/${staged}`, content);
    const directory = destination.slice(0, destination.lastIndexOf('/')) || SITE_ROOT;
    const result = await this.execBash(
      [
        // DataDevice has no JavaScript unlink API. A shell EXIT trap removes
        // the unique in-memory stage on both successful and failed copies.
        `trap ${shellQuote(`rm -f ${shellQuote(`/data/${staged}`)}`)} EXIT`,
        `mkdir -p ${shellQuote(directory)}`,
        `cp ${shellQuote(`/data/${staged}`)} ${shellQuote(destination)}`,
      ].join(' && '),
      SITE_ROOT,
      false,
      false,
    );
    if (result.status !== 0) {
      await this.cleanupDataStage(staged);
      // The boot-time write probe was removed (it caused the corruption it
      // detected), so the known phantom read-only workspace state surfaces
      // here on the first write. Name the recovery path instead of letting
      // the agent retry a permanently failing write.
      const readOnlyWorkspace = /read-?only file ?system/i.test(result.output);
      const message = `Failed to write ${destination}: ${
        result.output || `cp exited with status ${result.status}`
      }${
        readOnlyWorkspace
          ? '\nThe workspace mount is in the known read-only corruption state and no retry can succeed. Use "Reset workspace" in SparkRun to restore the latest durable checkpoint.'
          : ''
      }`;
      this.publishDebug({
        phase: 'write',
        status: result.status,
        output: message,
      });
      throw new Error(message);
    }
  }

  private async cleanupDataStage(
    staged: string,
    restoreRoot?: string,
  ): Promise<void> {
    if (this.disposed || this.commandRunnerTimedOut) return;
    await this.execBash(
      [
        `rm -f ${shellQuote(`/data/${staged}`)}`,
        ...(restoreRoot ? [`rm -rf ${shellQuote(restoreRoot)}`] : []),
      ].join(' && '),
      '/',
      false,
      false,
      5_000,
      false,
    ).catch(() => undefined);
  }

  async listDirectory(relativePath: string): Promise<DirectoryEntry[]> {
    const vmPath = toVmPath(normalizeSitePath(relativePath));
    const result = await this.execBash(
      `if [ -d ${shellQuote(vmPath)} ]; then find ${shellQuote(
        vmPath,
      )} -mindepth 1 -maxdepth 1 -printf '%y %s %p\\n'; fi`,
      SITE_ROOT,
      false,
      false,
    );
    if (result.status !== 0) {
      const message =
        result.status === 124
          ? 'Could not list the workspace directory because the VM command timed out (status 124). Restart the VM before continuing.'
          : `Could not list the workspace directory because the VM command failed (status ${result.status}).`;
      this.publishDebug({
        phase: 'directory-list',
        status: result.status,
        output: message,
      });
      throw new Error(message);
    }
    return result.output
      .split('\n')
      .map((line) => line.trim())
      .flatMap((line) => {
        // Accept every find(1) type code: the agent contract includes
        // symlinks and other entries, and silently hiding them previously let
        // the model clobber links it could not see.
        const match = /^([a-z]) ([0-9]+) (.+)$/.exec(line);
        if (!match) {
          return [];
        }
        const [, typeCode, rawSize, fullPath] = match;
        if (fullPath !== SITE_ROOT && !fullPath.startsWith(`${SITE_ROOT}/`)) {
          return [];
        }
        const relative = normalizeSitePath(
          fullPath.startsWith(`${SITE_ROOT}/`)
            ? fullPath.slice(SITE_ROOT.length + 1)
            : fullPath,
        );
        if (!relative) {
          return [];
        }
        const type =
          typeCode === 'd'
            ? 'directory'
            : typeCode === 'f'
              ? 'file'
              : typeCode === 'l'
                ? 'symlink'
                : 'other';
        return {
          path: relative,
          type,
          ...(typeCode === 'f' ? { sizeBytes: Number(rawSize) } : {}),
        } satisfies DirectoryEntry;
      });
  }

  async runCommand(
    command: string,
    options: {
      cwd?: string;
      background?: boolean;
      stream?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<VmCommandResult> {
    const cwd = resolveRuntimeCwd(options.cwd);
    const normalized = command.trim().replace(/\s+/g, ' ');
    if (normalized === SERVER_COMMAND) {
      return this.awaitAbortable(this.startServer(), options.signal);
    }
    if (options.background) {
      return {
        status: 1,
        output:
          'Detached commands are intentionally unsupported because SparkRun cannot verify their process lifetime or exit status. Run finite work in the foreground or use start_preview for a supervised server.',
        background: false,
      };
    }
    if (containsUnsupportedDetachment(command)) {
      return {
        status: 1,
        output:
          'Detached shell processes are intentionally unsupported because SparkRun cannot verify their lifetime or exit status. Run finite work in the foreground or use start_preview for a supervised server.',
        background: false,
      };
    }
    return this.awaitAbortable(
      this.execBash(
        command,
        cwd,
        false,
        options.stream ?? false,
        options.timeoutMs,
      ),
      options.signal,
    );
  }

  async startPreview(
    options: CodingRuntimePreviewOptions,
  ): Promise<CodingRuntimePreviewResult> {
    this.throwIfFatalNetworkFailure();
    const command = options.command.trim();
    const port = options.port;
    const cwd = resolveRuntimeCwd(options.cwd);
    if (!command) {
      return {
        status: 1,
        output: 'A preview command is required.',
        background: true,
        port,
        url: null,
      };
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return {
        status: 1,
        output: 'Preview port must be an integer between 1024 and 65535.',
        background: true,
        port,
        url: null,
      };
    }
    // A different start (another command/port, or the default static server)
    // may be in flight. Wait for it to settle, then launch the requested
    // preview — returning the other start's result here previously reported
    // the wrong server's port and URL as this preview's success.
    while (this.startServerPromise) {
      const pending = this.startServerPromise;
      await this.awaitAbortable(
        pending.then(
          () => undefined,
          () => undefined,
        ),
        options.signal,
      );
      if (this.startServerPromise === pending) break;
    }
    const startPromise = this.startManagedPreviewInner(command, port, cwd);
    this.startServerPromise = startPromise;
    try {
      const result = await this.awaitAbortable(startPromise, options.signal);
      return {
        ...result,
        port: this.serverPort ?? port,
        url: this.getPreviewUrl(),
      };
    } finally {
      // Identity-guarded: a stop or a newer start may already own the slot.
      if (this.startServerPromise === startPromise) {
        this.startServerPromise = null;
      }
    }
  }

  private async startManagedPreviewInner(
    command: string,
    port: number,
    cwd: string,
  ): Promise<VmCommandResult> {
    this.throwIfFatalNetworkFailure();
    if (this.commandRunnerTimedOut) {
      return {
        status: 124,
        output:
          'The VM command runner hit its catastrophic host watchdog. Restart the VM before launching a preview.',
        background: true,
      };
    }

    // Keep the same hard-won ordering as the static server: the agent finishes
    // all workspace writes first, then we clean process state, activate the
    // Tailnet, and launch using only /tmp state writes.
    const cleanup = await this.execBash(
      SERVER_CLEANUP_COMMAND,
      SITE_ROOT,
      false,
      false,
      15_000,
    );
    if (cleanup.status !== 0) {
      return {
        status: cleanup.status,
        output: `Could not stop the previous preview.\n${cleanup.output}`,
        background: true,
      };
    }
    this.serverStarted = false;
    this.serverLastExit = null;
    this.serverPort = null;

    this.throwIfFatalNetworkFailure();
    await this.prepareTailnetForServer();
    this.throwIfFatalNetworkFailure();
    if (!this.getTailnetIp()) {
      return {
        status: 1,
        output:
          'Tailnet IP is not available. The preview process was not started because it could not expose a reachable address.',
        background: true,
      };
    }

    const state = await this.execBash(
      [
        `mkdir -p ${shellQuote(SERVER_STATE_DIR)}`,
        `: > ${shellQuote(SERVER_LOG_PATH)}`,
        `rm -f ${shellQuote(SERVER_READY_PATH)}`,
        `printf '%s\\n' ${shellQuote(String(port))} > ${shellQuote(SERVER_PORT_PATH)}`,
        `printf '%s\\n' '0.0.0.0' > ${shellQuote(SERVER_HOST_PATH)}`,
        `printf '%s\\n' ${shellQuote(`http://${this.tailnetIp}:${port}`)} > ${shellQuote(SERVER_URL_PATH)}`,
      ].join(' && '),
      '/',
      false,
      false,
      15_000,
    );
    if (state.status !== 0) {
      return {
        status: state.status,
        output: `Could not initialize preview state.\n${state.output}`,
        background: true,
      };
    }

    this.throwIfFatalNetworkFailure();
    const launch = this.launchTrackedServerProcess(command, cwd);
    if (launch.status !== 0) return launch;

    const health = await this.waitForManagedPreviewReadiness(port, 45_000);
    if (health.status !== 0) {
      const log = await this.readServerLog(60);
      const lastExit = this.getServerLastExit();
      await this.stopServer().catch(() => undefined);
      return {
        status: 1,
        output: [
          `Preview process did not answer HTTP on port ${port} from the browser.`,
          health.output,
          lastExit?.output,
          log,
        ]
          .filter(Boolean)
          .join('\n'),
        background: true,
      };
    }
    const interruptionAfterHealth = this.getPreviewStartupInterruption();
    if (interruptionAfterHealth) return interruptionAfterHealth;

    const readiness = await this.execBash(
      `printf '%s\\n' ${shellQuote(health.output.trim())} > ${shellQuote(SERVER_READY_PATH)}`,
      '/',
      false,
      false,
      5_000,
    );
    if (readiness.status !== 0) {
      const log = await this.readServerLog(60);
      await this.stopServer().catch(() => undefined);
      return {
        status: readiness.status,
        output: [
          'Preview answered HTTP, but SparkRun could not persist its readiness certificate.',
          readiness.output,
          log,
        ]
          .filter(Boolean)
          .join('\n'),
        background: true,
      };
    }
    const interruptionAfterReadiness = this.getPreviewStartupInterruption();
    if (interruptionAfterReadiness) return interruptionAfterReadiness;

    this.serverPort = port;
    this.serverStarted = true;
    this.publishStatus('server-running', `Preview process running on port ${port}`);
    this.publishDebug({
      phase: 'server',
      command,
      cwd,
      status: 0,
      output: `Managed preview started at ${this.getPreviewUrl() ?? `port ${port}`}.`,
      background: true,
    });
    return {
      status: 0,
      output: `Managed preview accepted an HTTP connection on port ${port}. ${health.output}`,
      background: true,
    };
  }

  startInteractiveShell(): VmCommandResult {
    if (this.disposed) {
      return {
        status: 1,
        output: 'The VM has been disposed. Start a fresh VM before opening a terminal.',
        background: true,
      };
    }
    if (this.interactiveShellRunning) {
      return {
        status: 0,
        output: 'Interactive shell is already running.',
        background: true,
      };
    }
    if (this.commandRunnerTimedOut) {
      return {
        status: 124,
        output:
          'The VM command runner is recovering from a previous timeout. Start a fresh VM run before opening an interactive shell.',
        background: true,
      };
    }

    this.interactiveShellRunning = true;
    this.onConsole?.(`\n[vm] interactive shell started in ${SITE_ROOT}\n`);
    this.publishDebug({
      phase: 'terminal',
      command: '/bin/bash -l',
      cwd: SITE_ROOT,
      background: true,
    });
    this.interactiveShellPromise = this.cx
      .run('/bin/bash', ['-l'], this.runOptions(SITE_ROOT))
      .then((result) => {
        if (this.disposed) return result;
        this.interactiveShellRunning = false;
        this.onConsole?.(`\n[vm] interactive shell exited with ${result.status}\n`);
        this.publishDebug({
          phase: 'terminal-exit',
          command: '/bin/bash -l',
          cwd: SITE_ROOT,
          status: result.status,
        });
        return result;
      })
      .catch((error: unknown) => {
        this.interactiveShellRunning = false;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[webvm] interactive shell threw', error);
        this.onConsole?.(`\n[vm] interactive shell failed: ${message}\n`);
        this.publishDebug({
          phase: 'terminal-exit',
          command: '/bin/bash -l',
          cwd: SITE_ROOT,
          status: 1,
          output: message,
        });
        return { status: 1 };
      });

    return {
      status: 0,
      output: 'Interactive shell started.',
      background: true,
    };
  }

  writeTerminalInput(input: string): VmCommandResult {
    if (this.disposed) {
      return {
        status: 1,
        output: 'The VM has been disposed. Start a fresh VM before sending terminal input.',
        background: false,
      };
    }
    if (!this.interactiveShellRunning) {
      const started = this.startInteractiveShell();
      if (started.status !== 0) {
        return started;
      }
    }
    if (!this.consoleInput) {
      return {
        status: 1,
        output: 'The VM console input stream is not available.',
        background: false,
      };
    }
    // Send UTF-8 bytes, not UTF-16 code units. charCodeAt(0) would corrupt any
    // non-ASCII character (accents, smart quotes, emoji) into a single >127
    // value instead of its multi-byte UTF-8 sequence.
    for (const byte of new TextEncoder().encode(input)) {
      this.consoleInput(byte);
    }
    return {
      status: 0,
      output: '',
      background: false,
    };
  }

  startDefaultPreview(): Promise<VmCommandResult> {
    return this.startServer();
  }

  async startServer(): Promise<VmCommandResult> {
    if (this.disposed) {
      return {
        status: 1,
        output: 'The VM has been disposed. Start a fresh VM before launching the server.',
        background: true,
      };
    }
    this.throwIfFatalNetworkFailure();
    if (this.serverStarted && this.serverPort) {
      const cachedPort = this.serverPort;
      const health = await this.checkServer();
      if (this.disposed) {
        return {
          status: 1,
          output: 'The VM was disposed while confirming the existing server.',
          background: true,
        };
      }
      this.throwIfFatalNetworkFailure();
      const interruption = this.getPreviewStartupInterruption();
      if (
        health.status === 0 &&
        !interruption &&
        this.serverStarted &&
        this.serverPort === cachedPort
      ) {
        return {
          status: 0,
          output: `Server is already running on port ${cachedPort}.`,
          background: true,
        };
      }
    }

    // In-flight guard: the early "already running" check only flips true after
    // the whole multi-phase startup (staging, up-to-45s Tailnet connect, launch,
    // port poll) completes. A second concurrent startServer() would otherwise
    // pass that check and have its cleanup command kill the first launch
    // mid-flight. Coalesce overlapping calls onto a single promise.
    if (this.startServerPromise) {
      return this.startServerPromise;
    }
    const startPromise = this.startServerInner();
    this.startServerPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      // Identity-guarded: a stop or a newer start may already own the slot.
      if (this.startServerPromise === startPromise) {
        this.startServerPromise = null;
      }
    }
  }

  private async startServerInner(): Promise<VmCommandResult> {
    this.throwIfFatalNetworkFailure();
    if (this.commandRunnerTimedOut) {
      const output =
        'The VM command runner hit its catastrophic host watchdog. Start a fresh VM before launching the server.';
      this.publishDebug({
        phase: 'server',
        status: 124,
        output,
        background: true,
      });
      return { status: 124, output, background: true };
    }

    // PHASE 1: All filesystem writes happen FIRST, before Tailnet activation.
    // On some machines, activating CheerpX's userspace Tailscale flips the
    // workspace IDB mount to read-only. So we stage everything beforehand.

    await this.copyContentToVm(SERVER_SCRIPT_PATH, SERVER_SCRIPT, SITE_ROOT);
    this.serverStarted = false;
    this.serverLastExit = null;
    this.serverPort = null;
    this.publishStatus('booting', 'Staging server files before Tailnet activation');
    this.publishDebug({
      phase: 'server',
      output: `Staging Python static server (writes happen before Tailnet activation)`,
      background: true,
    });

    const cleanup = await this.execBash(
      SERVER_CLEANUP_COMMAND,
      SITE_ROOT,
      false,
      false,
    );
    if (cleanup.status !== 0) {
      const output = `Could not clean up the previous server process.\n${cleanup.output}`;
      this.publishDebug({
        phase: 'server',
        status: cleanup.status,
        output,
        background: true,
      });
      return { status: cleanup.status, output, background: true };
    }

    const pythonCheck = await this.execBash(
      'command -v python3',
      SITE_ROOT,
      false,
      false,
    );
    if (pythonCheck.status === 124) {
      const output = `Could not check for python3 — the command runner timed out. Try Retry, or boot a fresh VM.\n${pythonCheck.output}`;
      this.publishDebug({
        phase: 'server',
        status: 124,
        output,
        background: true,
      });
      return { status: 124, output, background: true };
    }
    if (pythonCheck.status !== 0) {
      return {
        status: pythonCheck.status,
        output: `python3 is not available in this WebVM image.\n${pythonCheck.output}`,
        background: true,
      };
    }

    // PHASE 2: Now activate Tailnet. After this point, /workspace may go
    // read-only on some machines, but /tmp (rootCache overlay) stays writable.
    this.throwIfFatalNetworkFailure();
    await this.prepareTailnetForServer();
    this.throwIfFatalNetworkFailure();
    if (!this.getTailnetIp()) {
      const output =
        'Tailnet IP is not available yet. Skipping VM web server start because CheerpX cannot bind 0.0.0.0 until the browser-side Tailnet network is connected.';
      this.publishStatus('error', 'Tailnet unavailable');
      this.publishDebug({
        phase: 'server',
        command: SERVER_COMMAND,
        cwd: SITE_ROOT,
        status: 1,
        output,
        background: true,
      });
      return {
        status: 1,
        output,
        background: true,
      };
    }

    // PHASE 3: Start the server as a foreground CheerpX process, but retain its
    // Promise in JavaScript instead of awaiting it. A detached `nohup ... &`
    // shell can report status 0 before CheerpX has scheduled the child (and in
    // a real Chrome reproduction never produced server.port). Keeping cx.run
    // attached gives CheerpX a concrete long-lived process to schedule while
    // other cx.run calls continue on separate virtual terminals.
    this.throwIfFatalNetworkFailure();
    const launch = this.launchServerProcess();
    if (launch.status !== 0) {
      return launch;
    }

    // ThreadingHTTPServer binds synchronously before the Python process writes
    // server.ready and server.port. Do not perform a VM-internal loopback GET:
    // CheerpX 1.3.9's Tailscale transport can wedge that connection. Outer
    // Chrome provides the real Tailnet connection proof during E2E validation.
    const port = await this.waitForServerPort(45_000);
    let interruption = this.getPreviewStartupInterruption();
    const log = interruption ? '' : await this.readServerLog(40);
    interruption ??= this.getPreviewStartupInterruption();
    const lastExit = this.getServerLastExit();
    const provenPort = interruption ? null : port;
    const result: VmCommandResult = provenPort
      ? {
          status: 0,
          output: [
            `Server bound port ${provenPort} and its tracked process is running.`,
            log,
          ]
            .filter(Boolean)
            .join('\n'),
          background: true,
        }
      : {
          status: 1,
          output: [
            'Server did not publish its bind-readiness certificate.',
            interruption?.output,
            lastExit?.output,
            log,
            'The preview process must bind its port and write /tmp/sparkrun/server.ready before SparkRun marks it live.',
          ]
            .filter(Boolean)
            .join('\n'),
          background: true,
        };
    this.publishDebug({
      phase: 'server',
      command: SERVER_COMMAND,
      cwd: SITE_ROOT,
      status: result.status,
      output: result.output,
      background: true,
    });
    if (provenPort) {
      this.serverStarted = true;
      this.publishStatus(
        'server-running',
        `VM web server started on port ${provenPort}`,
      );
    } else {
      await this.stopServer().catch(() => undefined);
      this.serverStarted = false;
      this.serverPort = null;
    }
    return result;
  }

  private launchServerProcess(): VmCommandResult {
    return this.launchTrackedServerProcess(
      `/usr/bin/python3 ${shellQuote(
        SERVER_SCRIPT_PATH,
      )} --host 0.0.0.0 --port auto`,
      SITE_ROOT,
      false,
    );
  }

  private launchTrackedServerProcess(
    serverCommand: string,
    cwd: string,
    throughShell = true,
  ): VmCommandResult {
    const processCommand = throughShell
      ? `/bin/bash -c ${shellQuote(serverCommand)}`
      : serverCommand;
    const wrapperCommand = [
      `echo $$ > ${SERVER_LAUNCH_PID_PATH}`,
      `echo $$ > ${SERVER_PID_PATH}`,
      `exec ${processCommand} >> ${SERVER_LOG_PATH} 2>&1`,
    ].join(' ; ');
    this.serverLastExit = null;
    this.publishDebug({
      phase: 'server-launch',
      command: serverCommand,
      cwd,
      background: true,
    });

    try {
      // util-linux `setsid -f -w` gives every preview its own session/process
      // group while keeping cx.run attached until the preview exits. The PID
      // written by the inner shell is therefore also the process-group ID.
      // Cleanup can TERM the whole tree and then KILL the group after a bounded
      // grace period, including npm/Vite children that ignore or outlive TERM.
      const rawPromise = this.cx.run(
        '/usr/bin/setsid',
        ['-f', '-w', '/bin/bash', '-c', wrapperCommand],
        this.runOptions(cwd),
      );
      const trackedPromise = rawPromise
        .then((result) => {
          if (!this.disposed && this.serverProcessPromise === trackedPromise) {
            // A preview is a long-lived process. Exiting before explicit Stop
            // is a startup/runtime failure even when the child returns 0 (for
            // example a one-shot install command). Never treat that clean exit
            // as an HTTP-health success.
            const failureStatus = result.status === 0 ? 1 : result.status;
            this.serverProcessPromise = null;
            this.serverStarted = false;
            this.serverPort = null;
            this.serverLastExit = {
              status: failureStatus,
              output: `Server process exited before readiness with status ${result.status}.`,
              background: true,
            };
            this.publishDebug({
              phase: 'server-exit',
              command: serverCommand,
              cwd,
              status: failureStatus,
              output: this.serverLastExit.output,
              background: true,
            });
            this.publishStatus(
              'error',
              `Preview process exited before readiness with status ${result.status}`,
            );
            return { status: failureStatus };
          }
          return result;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!this.disposed && this.serverProcessPromise === trackedPromise) {
            this.serverProcessPromise = null;
            this.serverStarted = false;
            this.serverPort = null;
            this.serverLastExit = {
              status: 1,
              output: `Server process failed to launch: ${message}`,
              background: true,
            };
            this.publishDebug({
              phase: 'server-exit',
              command: serverCommand,
              cwd,
              status: 1,
              output: this.serverLastExit.output,
              background: true,
            });
            this.publishStatus('error', 'Preview process stopped unexpectedly');
          }
          return { status: 1 };
        });
      this.serverProcessPromise = trackedPromise;
      return {
        status: 0,
        output: 'Server process launch requested.',
        background: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.serverLastExit = {
        status: 1,
        output: `Server process failed to launch: ${message}`,
        background: true,
      };
      return this.serverLastExit;
    }
  }

  private async prepareTailnetForServer(): Promise<void> {
    this.throwIfFatalNetworkFailure();
    if (
      this.tailnetIp ||
      !this.cx.networkLogin ||
      !this.autoConnectTailnetForServer
    ) {
      return;
    }
    this.publishDebug({
      phase: 'tailnet',
      output: 'Connecting Tailnet before starting the VM web server',
      background: false,
    });
    try {
      const loginUrl = await this.connectTailnet({ timeoutMs: 45_000 });
      this.publishDebug({
        phase: 'tailnet',
        output: this.tailnetIp
          ? `Tailnet IP ready: ${this.tailnetIp}`
          : loginUrl
            ? `Tailscale login required: ${loginUrl}`
            : 'Tailnet IP not available before server start.',
        background: false,
      });
    } catch (error) {
      console.error('[webvm] prepareTailnetForServer threw', error);
      this.publishDebug({
        phase: 'tailnet',
        status: 1,
        output: error instanceof Error ? error.message : String(error),
        background: false,
      });
      if (error instanceof CheerpXNetworkReloadRequiredError) {
        throw error;
      }
    }
    this.throwIfFatalNetworkFailure();
  }

  async dumpMountDiagnostics(): Promise<void> {
    const cmd = [
      `echo '== /proc/mounts =='`,
      `cat /proc/mounts 2>&1 || true`,
      `echo '== ls -la / =='`,
      `ls -la / 2>&1 || true`,
      `echo '== ls -la ${WORKSPACE_ROOT} =='`,
      `ls -la ${WORKSPACE_ROOT} 2>&1 || true`,
      `echo '== ls -la ${SITE_ROOT} =='`,
      `ls -la ${SITE_ROOT} 2>&1 || true`,
      `echo '== stat ${WORKSPACE_ROOT} =='`,
      `stat ${WORKSPACE_ROOT} 2>&1 || true`,
      `echo '== stat ${SITE_ROOT} =='`,
      `stat ${SITE_ROOT} 2>&1 || true`,
    ].join(' ; ');
    const result = await this.execBash(cmd, '/', false, false);
    this.publishDebug({
      phase: 'mount-diag',
      output: result.output,
    });
  }

  async probeWorkspaceWritable(): Promise<{
    writable: boolean;
    message: string;
  }> {
    const probePath = `${SITE_ROOT}/.sparkrun-write-probe`;
    const stamp = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const probeCmd = [
      `mkdir -p ${shellQuote(SITE_ROOT)}`,
      `printf '%s' ${shellQuote(stamp)} > ${shellQuote(probePath)}`,
      `cat ${shellQuote(probePath)}`,
      `rm -f ${shellQuote(probePath)}`,
    ].join(' && ');
    const result = await this.execBash(probeCmd, SITE_ROOT, false, false);
    if (result.status !== 0) {
      const message = [
        `Workspace at ${SITE_ROOT} is not writable.`,
        `The probe failed with status ${result.status}:`,
        result.output || '(no output)',
        'This usually means the in-browser IndexedDB workspace is half-mounted — the directory entry exists but writes fail. Try the Reset workspace button, or wipe the sparkrun-workspace IndexedDB in DevTools → Application.',
      ].join('\n');
      this.publishDebug({
        phase: 'workspace-probe',
        status: 1,
        output: message,
      });
      return { writable: false, message };
    }
    if (!result.output.includes(stamp)) {
      const message = [
        `Workspace at ${SITE_ROOT} accepted the write but did not return the expected content.`,
        `Wrote stamp "${stamp}" but read back "${result.output}".`,
        'The IndexedDB workspace is in a corrupt state. Try the Reset workspace button.',
      ].join('\n');
      this.publishDebug({
        phase: 'workspace-probe',
        status: 1,
        output: message,
      });
      return { writable: false, message };
    }
    this.publishDebug({
      phase: 'workspace-probe',
      output: `Workspace ${SITE_ROOT} is writable (stamp round-tripped).`,
    });
    return { writable: true, message: 'ok' };
  }

  private async waitForServerPort(timeoutMs: number): Promise<number | null> {
    const started = Date.now();
    let lastLogSize = 0;
    while (Date.now() - started < timeoutMs) {
      if (this.disposed || this.getFatalNetworkFailure()) {
        return null;
      }
      if (this.getServerLastExit() || this.commandRunnerTimedOut) {
        return null;
      }
      const result = await this.execBash(
        `if [ -s ${SERVER_READY_PATH} ] && [ -f ${SERVER_PORT_PATH} ]; then cat ${SERVER_PORT_PATH}; fi`,
        SITE_ROOT,
        false,
        false,
        2_000,
        false,
      );
      if (
        this.disposed ||
        this.getFatalNetworkFailure() ||
        this.getServerLastExit() ||
        this.commandRunnerTimedOut
      ) {
        return null;
      }
      // The port file contains only the port number on its own line. Match a
      // line that is *entirely* a 2-5 digit number rather than the first digits
      // anywhere in the capture, so stray output (e.g. from a concurrent
      // interactive shell) can't be misread as the server port.
      const portLine = result.output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => /^\d{2,5}$/.test(line));
      const port = Number(portLine);
      if (result.status === 0 && Number.isInteger(port) && port > 0) {
        this.serverPort = port;
        return port;
      }
      if (this.getServerLastExit() || this.commandRunnerTimedOut) {
        return null;
      }

      const sizeResult = await this.execBash(
        `if [ -f ${SERVER_LOG_PATH} ]; then wc -c < ${SERVER_LOG_PATH}; else echo 0; fi`,
        SITE_ROOT,
        false,
        false,
        2_000,
        false,
      );
      if (this.disposed || this.getFatalNetworkFailure()) return null;
      const currentSize = Number(sizeResult.output.trim());
      if (Number.isFinite(currentSize) && currentSize > lastLogSize) {
        const tail = await this.execBash(
          `tail -c +${lastLogSize + 1} ${SERVER_LOG_PATH}`,
          SITE_ROOT,
          false,
          false,
          2_000,
          false,
        );
        if (this.disposed || this.getFatalNetworkFailure()) return null;
        if (tail.output.trim().length > 0) {
          this.publishDebug({
            phase: 'server-log',
            output: tail.output,
            background: true,
          });
        }
        lastLogSize = currentSize;
      }

      await sleep(300);
    }
    return null;
  }

  /**
   * Prove a managed preview from the outer browser: the tailnet URL must
   * answer an HTTP request. Guest-side liveness (early exit, watchdog) still
   * fails fast, but no guest command is issued for the network check itself.
   */
  private async waitForManagedPreviewReadiness(
    port: number,
    timeoutMs: number,
  ): Promise<VmCommandResult> {
    const started = Date.now();
    let attempts = 0;
    const tailnetIp = this.tailnetIp;
    if (!tailnetIp) {
      return {
        status: 1,
        output: 'Tailnet IP is not available, so the preview cannot be reached from the browser.',
        background: false,
      };
    }
    const url = `http://${tailnetIp}:${port}/`;
    while (Date.now() - started < timeoutMs) {
      if (this.disposed || this.getFatalNetworkFailure()) {
        return {
          status: 1,
          output: this.getFatalNetworkFailure() ?? 'The VM was disposed.',
          background: false,
        };
      }
      const earlyExit = this.getServerLastExit();
      if (earlyExit || this.commandRunnerTimedOut) {
        return earlyExit ?? {
          status: 124,
          output: 'The command runner timed out while waiting for HTTP health.',
          background: false,
        };
      }
      attempts += 1;
      const controller = new AbortController();
      const abortTimer = setTimeout(
        () => controller.abort(),
        MANAGED_PREVIEW_PROBE_TIMEOUT_MS,
      );
      let responded = false;
      try {
        responded = await this.probePreviewUrl(url, controller.signal);
      } catch {
        responded = false;
      } finally {
        clearTimeout(abortTimer);
      }
      if (this.disposed || this.getFatalNetworkFailure()) {
        return {
          status: 1,
          output: this.getFatalNetworkFailure() ?? 'The VM was disposed.',
          background: false,
        };
      }
      const exitAfterProbe = this.getServerLastExit();
      if (exitAfterProbe || this.commandRunnerTimedOut) {
        return exitAfterProbe ?? {
          status: 124,
          output: 'The command runner timed out while waiting for HTTP health.',
          background: false,
        };
      }
      if (responded) {
        return {
          status: 0,
          output: `SPARKRUN_HTTP_RESPONSE browser received an HTTP response from ${url} after ${attempts} attempt${
            attempts === 1 ? '' : 's'
          }.`,
          background: false,
        };
      }
      await sleep(MANAGED_PREVIEW_PROBE_INTERVAL_MS);
    }
    return {
      status: 1,
      output: `No HTTP response from ${url} within ${Math.round(
        timeoutMs / 1_000,
      )}s (${attempts} browser attempt${attempts === 1 ? '' : 's'}).`,
      background: false,
    };
  }

  private async readServerLog(lines: number): Promise<string> {
    const result = await this.execBash(
      `if [ -f ${SERVER_LOG_PATH} ]; then tail -${lines} ${SERVER_LOG_PATH}; else echo "No server log found."; fi`,
      SITE_ROOT,
      false,
      false,
      3_000,
    );
    return result.output;
  }

  stopPreview(): Promise<VmCommandResult> {
    return this.stopServer();
  }

  async stopServer(): Promise<VmCommandResult> {
    this.publishDebug({
      phase: 'server-stop',
      command: SERVER_CLEANUP_COMMAND,
      cwd: SITE_ROOT,
    });
    // Disown the tracked process before killing it so its expected signal exit
    // cannot race this explicit stop and republish stale failure state.
    this.serverProcessPromise = null;
    const result = await this.execBash(
      SERVER_CLEANUP_COMMAND,
      SITE_ROOT,
      false,
      false,
      10_000,
    );
    this.serverStarted = false;
    this.startServerPromise = null;
    this.serverLastExit = null;
    this.serverPort = null;
    this.publishStatus('ready', 'VM web server stopped');
    return result;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    // Flip the public lifecycle state and publish the shared promise before
    // running teardown. Project deletion and the command watchdog can reach
    // this method concurrently; neither may queue a stop command behind the
    // command that is itself waiting for disposal, and cx.delete() must run
    // exactly once. Deleting the CheerpX instance is the process-tree cleanup
    // boundary, so a guest-side stopServer() adds a deadlock risk without
    // preserving anything that survives this operation.
    this.disposed = true;
    // Invalidate every public preview cache in the same turn as disposal. A
    // caller can invoke startServer() before the teardown microtask runs; it
    // must never observe a disposed VM as an already-running server.
    this.serverProcessPromise = null;
    this.startServerPromise = null;
    this.serverStarted = false;
    this.serverLastExit = null;
    this.serverPort = null;
    fatalTailnetRegistry.listeners.delete(this.fatalNetworkRuntimeListener);
    this.disposePromise = Promise.resolve().then(() => {
      this.interactiveShellPromise = null;
      this.interactiveShellRunning = false;
      this.consoleInput = null;
      this.resolveTailnetSignal?.(null);
      this.resolveTailnetSignal = null;
      this.rejectTailnetSignal = null;
      this.tailnetConnectPromise = null;
      if (fatalTailnetRegistry.lastDebugSink === this.onDebug) {
        fatalTailnetRegistry.lastDebugSink = null;
      }
      this.cx.delete();
    });
    return this.disposePromise;
  }

  checkPreview(): Promise<VmCommandResult> {
    return this.checkServer();
  }

  async checkServer(): Promise<VmCommandResult> {
    if (this.disposed) {
      return {
        status: 1,
        output: 'The VM has been disposed. Start a fresh VM before checking its preview.',
        background: false,
      };
    }
    this.throwIfFatalNetworkFailure();
    const port = this.serverPort ?? (await this.waitForServerPort(4_000));
    this.throwIfFatalNetworkFailure();
    if (this.disposed) {
      return {
        status: 1,
        output: 'The VM was disposed while checking its preview.',
        background: false,
      };
    }
    if (!port) {
      const log = await this.readServerLog(40);
      const result: VmCommandResult = {
        status: 1,
        output: ['Server port was not written.', log].filter(Boolean).join('\n'),
        background: false,
      };
      this.publishDebug({
        phase: 'health',
        status: result.status,
        output: result.output,
      });
      return result;
    }

    // The readiness file certifies that this process synchronously bound its
    // socket. Pair it with PID liveness so stale files from a crashed process
    // can never manufacture a healthy result.
    const liveness = await this.execBash(
      `if [ -f ${SERVER_PID_PATH} ] && kill -0 "$(cat ${SERVER_PID_PATH})" 2>/dev/null; then if [ -s ${SERVER_READY_PATH} ]; then echo SPARKRUN_ALIVE; cat ${SERVER_READY_PATH}; else echo SPARKRUN_NOT_READY; fi; else echo SPARKRUN_DEAD; fi`,
      SITE_ROOT,
      false,
      false,
      3_000,
    );
    this.throwIfFatalNetworkFailure();
    if (this.disposed) {
      return {
        status: 1,
        output: 'The VM was disposed while checking its preview.',
        background: false,
      };
    }
    if (liveness.output.includes('SPARKRUN_DEAD')) {
      this.serverStarted = false;
      this.serverPort = null;
      const log = await this.readServerLog(40);
      const result: VmCommandResult = {
        status: 1,
        output: ['Server process is not running.', log].filter(Boolean).join('\n'),
        background: false,
      };
      this.publishStatus('ready', 'VM web server is not running');
      this.publishDebug({
        phase: 'health',
        status: result.status,
        output: result.output,
      });
      return result;
    }
    if (!liveness.output.includes('SPARKRUN_ALIVE')) {
      this.serverStarted = false;
      this.serverPort = null;
      const log = await this.readServerLog(40);
      const result: VmCommandResult = {
        status: 1,
        output: [
          `Server process is alive but has not published a bind-readiness certificate for port ${port}.`,
          log,
        ]
          .filter(Boolean)
          .join('\n'),
        background: false,
      };
      this.publishStatus('ready', 'VM web server is not ready');
      this.publishDebug({
        phase: 'health',
        status: result.status,
        output: result.output,
      });
      return result;
    }
    const exitAfterLiveness = this.getServerLastExit();
    if (exitAfterLiveness) {
      this.serverStarted = false;
      this.serverPort = null;
      return {
        status: exitAfterLiveness.status,
        output: exitAfterLiveness.output,
        background: false,
      };
    }

    this.serverPort = port;
    this.serverStarted = true;
    this.publishStatus('server-running', `VM web server listening on port ${port}`);
    const result: VmCommandResult = {
      status: 0,
      output: `internal: server process is alive and bound on port ${port} (${liveness.output
        .split('\n')
        .find((line) => /^SPARKRUN_(?:HTTP_\d{3}|BOUND)$/.test(line.trim()))
        ?.trim() ?? 'readiness certificate present'})`,
      background: false,
    };
    this.publishDebug({
      phase: 'health',
      status: result.status,
      output: result.output,
    });
    return result;
  }

  private publishDebug(entry: WebVmDebugEntry): void {
    if (this.disposed) return;
    this.onDebug?.(entry);
  }

  private getServerLastExit(): VmCommandResult | null {
    return this.serverLastExit;
  }

  private getPreviewStartupInterruption(): VmCommandResult | null {
    this.throwIfFatalNetworkFailure();
    if (this.disposed) {
      return {
        status: 1,
        output: 'The VM was disposed while the preview was starting.',
        background: true,
      };
    }
    if (this.serverLastExit) return this.serverLastExit;
    if (!this.serverProcessPromise) {
      return {
        status: 1,
        output: 'The preview process is no longer tracked and was not marked live.',
        background: true,
      };
    }
    return null;
  }

  private attachConsole(): void {
    // One streaming decoder per virtual terminal: a multi-byte UTF-8 sequence
    // can be split across console callbacks (and VTs interleave), so a single
    // non-streaming decoder corrupts exactly the output the agent reads.
    const decoders = new Map<number | 'default', TextDecoder>();
    const decodeChunk = (key: number | 'default', bytes: Uint8Array): string => {
      let decoder = decoders.get(key);
      if (!decoder) {
        decoder = new TextDecoder();
        decoders.set(key, decoder);
      }
      return decoder.decode(bytes, { stream: true });
    };
    this.consoleInput = this.cx.setCustomConsole((buf, vt) => {
      if (this.disposed) return;
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      const text = decodeChunk(vt ?? 'default', bytes);
      // A long-lived interactive shell and a managed cx.run command can emit
      // concurrently on different VTs. Keep every VT separate; after cx.run
      // settles, the nonce-bound completion marker identifies which buffer
      // actually belongs to the managed command. Selecting the first VT would
      // let an unrelated shell prompt manufacture a false timeout.
      if (this.activeCapture !== null) {
        const key = vt ?? 'default';
        const previous = this.activeCapture.outputByVirtualTerminal.get(key) ?? '';
        this.activeCapture.outputByVirtualTerminal.set(key, previous + text);
        if (this.activeCapture.streamToConsole) {
          this.onConsole?.(text);
        }
        return;
      }
      if (vt !== undefined && vt !== 1) {
        if (text.trim().length > 0) {
          this.publishDebug({
            phase: 'console-vt',
            output: `vt=${vt}: ${text}`,
          });
        }
        return;
      }
      this.onConsole?.(text);
    }, 100, 30);
  }

  private async prepareWorkspace(
    mode: 'preserve' | 'clean-site' = 'clean-site',
  ): Promise<void> {
    // clean-site (the default) recreates SITE_ROOT from scratch on boot. The
    // IDB workspace persists across reloads, and prior interrupted sessions can
    // leave per-directory corruption: the directory entry survives but its
    // inode contents are half-committed, so writes inside it return EROFS
    // ("Read-only file system") while reads still work and `mount` reports
    // rw. The corruption is confined to the subdir; the parent /workspace
    // mount itself is fine. Nuking the dir and recreating it clears the
    // corrupt entries and gives us a clean inode. User project files are
    // restored from the project's BrowserVault tar checkpoint after this.
    // preserve is an explicit opt-in for resumable per-project workspaces; it
    // only ensures the directory exists and deliberately accepts the caller's
    // responsibility to recover a corrupt project database when needed.
    const cmd =
      mode === 'clean-site'
        ? [
            `rm -rf ${shellQuote(SITE_ROOT)}`,
            `mkdir -p ${shellQuote(SITE_ROOT)}`,
          ].join(' && ')
        : `mkdir -p ${shellQuote(SITE_ROOT)}`;
    const result = await this.execBash(
      cmd,
      '/',
      false,
      false,
      BOOTSTRAP_COMMAND_TIMEOUT_MS,
    );
    if (result.status !== 0) {
      throw new Error(
        `Could not prepare ${SITE_ROOT}: ${
          result.output || `command exited with status ${result.status}`
        }`,
      );
    }
  }

  private runOptions(cwd: string): NonNullable<Parameters<CheerpXLinux['run']>[2]> {
    return {
      cwd,
      uid: 0,
      gid: 0,
      env: [
        'HOME=/root',
        'TERM=xterm',
        'USER=root',
        'SHELL=/bin/bash',
        'EDITOR=vi',
        'LANG=en_US.UTF-8',
        'LC_ALL=C',
        ...(this.nodeCompatibility
          ? [
              `NODE_OPTIONS=--require=${this.nodeCompatibility.preloadPath}`,
              `SPARKRUN_NODE_EXIT_ADDON=${this.nodeCompatibility.addonPath}`,
              `NODE_COMPILE_CACHE=${this.nodeCompatibility.compileCachePath}`,
            ]
          : []),
      ],
    };
  }

  private async execBash(
    command: string,
    cwd: string,
    background: boolean,
    streamToConsole: boolean,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
    debug: boolean = true,
  ): Promise<VmCommandResult> {
    const run = async (): Promise<VmCommandResult> => {
      if (this.disposed) {
        return {
          status: 1,
          output: 'The VM has been disposed. Start a fresh VM before running commands.',
          background,
        };
      }
      if (this.commandRunnerTimedOut) {
        return {
          status: 124,
          output:
            'The VM command runner is recovering from a previous timeout. Start a fresh VM run before executing more commands.',
          background,
        };
      }
      if (debug) {
        this.publishDebug({
          phase: 'exec',
          command,
          cwd,
          background,
        });
      }
      this.activeCapture = {
        outputByVirtualTerminal: new Map<number | 'default', string>(),
        streamToConsole,
      };
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let hostWatchdogFired = false;
      try {
        // Terminate inside the VM before advancing the serialized queue. A
        // JavaScript-only Promise.race abandons the actual shell process; its
        // delayed output can then be captured as if it belonged to the next
        // command. `setsid -f -w` isolates the command tree while keeping the
        // timeout runner attached until the session leader exits. Some guest
        // timeout implementations can still kill only that waiter or report a
        // false zero, so their numeric status is never trusted: only the
        // nonce-bound completion proof below establishes a normal finish. A
        // missing proof disposes the whole VM, which is the final process-tree
        // cleanup boundary available through CheerpX.
        // Whole seconds only: busybox `timeout` rejects fractional durations
        // unless built with FEATURE_FLOAT_DURATION, and a rejected duration
        // means no completion proof — which would dispose the entire VM.
        const durationSeconds = `${Math.max(Math.ceil(timeoutMs / 1_000), 1)}s`;
        const completionNonce = crypto.randomUUID().replaceAll('-', '');
        const completionMarker = `${COMMAND_COMPLETION_PREFIX}${completionNonce}__:`;
        const wrappedCommand = [
          'sparkrun_cancel_command_group() {',
          '  trap - TERM INT HUP',
          '  kill -TERM -- "-$$" 2>/dev/null || true',
          '}',
          "trap 'sparkrun_cancel_command_group' TERM INT HUP",
          `(
${command}
)`,
          'sparkrun_command_status=$?',
          `printf '\\n${completionMarker}%s\\n' "$sparkrun_command_status"`,
          'exit "$sparkrun_command_status"',
        ].join('\n');
        const timeoutFile =
          this.timeoutRunner === 'busybox' ? '/bin/busybox' : '/usr/bin/timeout';
        const timeoutArgs =
          this.timeoutRunner === 'busybox'
            ? [
                'timeout',
                '-s',
                'TERM',
                '-k',
                `${VM_TIMEOUT_KILL_GRACE_SECONDS}s`,
                durationSeconds,
                '/usr/bin/setsid',
                '-f',
                '-w',
                '/bin/bash',
                '-lc',
                wrappedCommand,
              ]
            : [
                '--signal=TERM',
                `--kill-after=${VM_TIMEOUT_KILL_GRACE_SECONDS}s`,
                durationSeconds,
                '/usr/bin/setsid',
                '-f',
                '-w',
                '/bin/bash',
                '-lc',
                wrappedCommand,
              ];
        const commandPromise = this.cx.run(
          timeoutFile,
          timeoutArgs,
          this.runOptions(cwd),
        );
        const hostWatchdogMs =
          timeoutMs +
          VM_TIMEOUT_KILL_GRACE_SECONDS * 1_000 +
          HOST_COMMAND_WATCHDOG_GRACE_MS;
        await Promise.race([
          commandPromise,
          new Promise<{ status: number }>((resolve) => {
            timeoutId = globalThis.setTimeout(
              () => {
                hostWatchdogFired = true;
                resolve({ status: 124 });
              },
              hostWatchdogMs,
            );
          }),
        ]);
        if (!hostWatchdogFired && timeoutId) {
          globalThis.clearTimeout(timeoutId);
          timeoutId = null;
        }
        // CheerpX can settle cx.run before the Worker-delivered console events
        // carrying the final nonce marker reach this task. For output-heavy
        // commands the marker sits behind a queue of chunks, so a fixed short
        // deadline would fail-close (and dispose the VM) on commands that
        // actually succeeded. Drain while progress is still being made, stop
        // after a quiet window with no marker, and enforce a hard cap.
        if (!hostWatchdogFired) {
          const capture = this.activeCapture;
          const markerArrived = () =>
            Array.from(capture.outputByVirtualTerminal.values()).some(
              (value) => value.includes(completionMarker),
            );
          const capturedBytes = () => {
            let total = 0;
            for (const value of capture.outputByVirtualTerminal.values()) {
              total += value.length;
            }
            return total;
          };
          const drainHardDeadline =
            Date.now() + COMMAND_COMPLETION_DRAIN_HARD_LIMIT_MS;
          let lastProgressAt = Date.now();
          let lastCapturedBytes = capturedBytes();
          while (
            !markerArrived() &&
            Date.now() < drainHardDeadline &&
            Date.now() - lastProgressAt < COMMAND_COMPLETION_QUIET_DRAIN_MS
          ) {
            await sleep(COMMAND_CONSOLE_DRAIN_POLL_MS);
            const captured = capturedBytes();
            if (captured !== lastCapturedBytes) {
              lastCapturedBytes = captured;
              lastProgressAt = Date.now();
            }
          }
          if (markerArrived()) {
            await sleep(COMMAND_TRAILING_OUTPUT_DRAIN_MS);
          }
        }
        const escapedMarker = completionMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const completionPattern = new RegExp(
          `(?:^|\\n)${escapedMarker}(-?\\d+)(?:\\r?\\n|$)`,
        );
        const capturedBuffers = Array.from(
          this.activeCapture.outputByVirtualTerminal.values(),
          (value) => value.trim(),
        );
        const capturedOutput =
          capturedBuffers.find((value) => completionPattern.test(value)) ??
          capturedBuffers.sort((left, right) => right.length - left.length)[0] ??
          '';
        const completionMatch = capturedOutput.match(completionPattern);
        const completionStatus = completionMatch
          ? Number.parseInt(completionMatch[1] ?? '', 10)
          : null;
        const output = completionMatch
          ? [
              capturedOutput.slice(0, completionMatch.index).trim(),
              capturedOutput
                .slice(
                  (completionMatch.index ?? 0) + completionMatch[0].length,
                )
                .trim(),
            ]
              .filter(Boolean)
              .join('\n')
          : capturedOutput;
        const completionMissing = !hostWatchdogFired && completionStatus === null;
        if (hostWatchdogFired || completionMissing) {
          // There is no CheerpX process handle to terminate from JavaScript.
          // BusyBox timeout is also known to report status 0 after killing its
          // child. A nonce-bound completion marker is therefore the source of
          // truth. Stop this VM when it is absent so surviving descendants and
          // delayed output can never contaminate a later command capture.
          this.commandRunnerTimedOut = true;
        }
        const finalOutput = hostWatchdogFired
          ? [
              output,
              `VM command did not stop after its ${timeoutMs}ms limit; the command runner is disabled until a fresh VM is started.`,
            ]
              .filter(Boolean)
              .join('\n')
          : completionMissing
            ? [
                output,
                `Command did not produce its completion proof within ${timeoutMs}ms. The VM was stopped to prevent false success or orphaned processes.`,
              ]
              .filter(Boolean)
              .join('\n')
            : output;
        const finalStatus =
          hostWatchdogFired || completionMissing
            ? 124
            : (completionStatus ?? 1);
        const commandResult = { status: finalStatus, output: finalOutput, background };
        if (debug) {
          this.publishDebug({
            phase: 'exec-result',
            command,
            cwd,
            status: finalStatus,
            output: finalOutput,
            background,
          });
        }
        if (this.commandRunnerTimedOut) {
          await this.dispose();
        }
        return { ...commandResult, output: finalOutput };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The command may contain credentials supplied to a package manager or
        // HTTP client. Keep raw command text inside the redacted debug callback
        // boundary instead of duplicating it into the browser console.
        console.error('[webvm] cx.run failed', error);
        const captured = this.activeCapture
          ? Array.from(
              this.activeCapture.outputByVirtualTerminal.values(),
              (value) => value.trim(),
            ).sort((left, right) => right.length - left.length)[0] ?? ''
          : '';
        const finalOutput = [captured, `cx.run threw: ${message}`]
          .filter(Boolean)
          .join('\n');
        if (debug) {
          this.publishDebug({
            phase: 'exec-result',
            command,
            cwd,
            status: 1,
            output: finalOutput,
            background,
          });
        }
        return { status: 1, output: finalOutput, background };
      } finally {
        if (timeoutId) {
          globalThis.clearTimeout(timeoutId);
        }
        this.activeCapture = null;
      }
    };

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private handleLoginUrl(url: string): void {
    if (this.disposed || this.getFatalNetworkFailure()) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      console.error('[webvm] handleLoginUrl: invalid URL', error);
      this.publishDebug({
        phase: 'tailnet-login-url',
        status: 1,
        output: 'Rejected an invalid Tailscale login URL.',
      });
      const reject = this.rejectTailnetSignal;
      this.resolveTailnetSignal = null;
      this.rejectTailnetSignal = null;
      // Allow a later connectTailnet() to retry networkLogin instead of
      // silently waiting out its timeout with no login URL.
      this.tailnetLoginStarted = false;
      reject?.(new Error('Invalid Tailscale login URL.'));
      return;
    }

    const rejection =
      parsed.protocol !== 'https:'
        ? 'Tailscale login URLs must use HTTPS.'
        : !TAILSCALE_LOGIN_HOSTS.has(parsed.hostname)
          ? 'Tailscale login URL host is not allowed.'
          : parsed.username || parsed.password
            ? 'Tailscale login URLs cannot contain credentials.'
            : parsed.hash
              ? 'Tailscale login URLs cannot contain a fragment.'
              : parsed.port && parsed.port !== '443'
                ? 'Tailscale login URLs cannot use a custom port.'
                : null;
    if (rejection) {
      console.error('[webvm] handleLoginUrl rejected an unsafe URL:', rejection);
      this.publishDebug({
        phase: 'tailnet-login-url',
        status: 1,
        output: rejection,
      });
      const reject = this.rejectTailnetSignal;
      this.resolveTailnetSignal = null;
      this.rejectTailnetSignal = null;
      this.tailnetLoginStarted = false;
      reject?.(new Error(rejection));
      return;
    }
    this.loginUrl = parsed.href;
    this.resolveTailnetSignal?.(parsed.href);
    this.resolveTailnetSignal = null;
    this.rejectTailnetSignal = null;
    this.publishStatus('tailnet-login-ready', 'Tailscale login ready');
  }

  recordTailnetState(state: number): void {
    if (this.disposed || this.getFatalNetworkFailure()) return;
    if (this.highestTailnetState === null || state > this.highestTailnetState) {
      this.highestTailnetState = state;
    }
  }

  getHighestTailnetState(): number | null {
    return this.highestTailnetState;
  }

  private setTailnetIp(ip: string | null): void {
    if (this.disposed || this.getFatalNetworkFailure()) return;
    this.tailnetIp = ip;
    if (ip) {
      this.resolveTailnetSignal?.(null);
      this.resolveTailnetSignal = null;
      this.rejectTailnetSignal = null;
    }
    this.publishTailnetState();
  }

  private publishTailnetState(): void {
    if (this.getFatalNetworkFailure()) {
      this.publishFatalNetworkFailure();
      return;
    }
    if (this.tailnetIp) {
      this.publishStatus('tailnet-connected', 'Tailnet connected');
      return;
    }
    this.publishStatus('booting', 'Tailnet connected; waiting for address');
  }

  private publishStatus(lifecycle: WebVmLifecycle, message: string): void {
    if (this.disposed) return;
    if (lifecycle !== 'error' && this.getFatalNetworkFailure()) {
      this.publishFatalNetworkFailure();
      return;
    }
    this.onStatus?.({
      lifecycle,
      message,
      tailnetIp: this.getTailnetIp(),
      loginUrl: this.getFatalNetworkFailure() ? null : this.loginUrl,
      previewUrl: this.getPreviewUrl(),
      serverPort: this.serverPort,
    });
  }
}
