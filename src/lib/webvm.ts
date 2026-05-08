import {
  SERVER_COMMAND,
  SERVER_PORT,
  SERVER_PORT_RANGE_END,
  SITE_ROOT,
  WEBVM_DISK_URL,
} from './constants';
import {
  normalizeSitePath,
  toVmPath,
  type DirectoryEntry,
  type VmCommandResult,
  type VmFileBackend,
} from './tools';

type ConsoleCallback = (text: string) => void;
type StatusCallback = (status: WebVmStatus) => void;
type DebugCallback = (entry: WebVmDebugEntry) => void;

type CheerpXModule = {
  CloudDevice: {
    create(url: string): Promise<unknown>;
  };
  IDBDevice: {
    create(name: string): Promise<IdbDevice>;
  };
  OverlayDevice: {
    create(baseDevice: unknown, overlayDevice: unknown): Promise<unknown>;
  };
  WebDevice: {
    create(path: string): Promise<unknown>;
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

type CheerpXLinux = {
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
  onConsole?: ConsoleCallback;
  onStatus?: StatusCallback;
  onDebug?: DebugCallback;
}

export interface ConnectTailnetOptions {
  timeoutMs?: number;
  forceLogin?: boolean;
}

type ActiveCapture = {
  output: string;
  streamToConsole: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toWorkspaceDevicePath(relativePath: string): string {
  return `/site/${normalizeSitePath(relativePath)}`;
}

function stageName(): string {
  return `stage-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
}

const SERVER_SCRIPT_PATH = '/workspace/.sparkrun_static_server.py';
const SERVER_SCRIPT = `
import argparse
import errno
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SITE_ROOT = "${SITE_ROOT}"
BASE_PORT = ${SERVER_PORT}
MAX_PORT = ${SERVER_PORT_RANGE_END}
LOG_PATH = "/workspace/site/.server.log"
PID_PATH = "/workspace/site/.server.pid"
PORT_PATH = "/workspace/site/.server.port"
HOST_PATH = "/workspace/site/.server.host"
URL_PATH = "/workspace/site/.server.url"

def write_log(message):
    with open(LOG_PATH, "a", encoding="utf-8") as log:
        log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\\n")
        log.flush()

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
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
for path in (PORT_PATH, HOST_PATH, URL_PATH):
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
write_log(f"SparkRun Python server listening on {bound_host}:{bound_port}")
server.serve_forever()
`.trimStart();

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const SERVER_CLEANUP_COMMAND = [
  'if [ -f /workspace/site/.server.pid ]; then kill "$(cat /workspace/site/.server.pid)" 2>/dev/null || true; fi',
  'if [ -f /workspace/site/.server.launch.pid ]; then kill "$(cat /workspace/site/.server.launch.pid)" 2>/dev/null || true; fi',
  "for pid in $(ps -eo pid,args 2>/dev/null | awk '/[.]sparkrun_static_server.py/ {print $1}'); do kill \"$pid\" 2>/dev/null || true; done",
  'sleep 0.2',
  "for pid in $(ps -eo pid,args 2>/dev/null | awk '/[.]sparkrun_static_server.py/ {print $1}'); do kill -9 \"$pid\" 2>/dev/null || true; done",
  'rm -f /workspace/site/.server.pid /workspace/site/.server.port /workspace/site/.server.host /workspace/site/.server.url /workspace/site/.server.launch.pid',
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

export class WebVmBackend implements VmFileBackend {
  private activeCapture: ActiveCapture | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private tailnetIp: string | null = null;
  private loginUrl: string | null = null;
  private serverPort: number | null = null;
  private serverStarted = false;
  private serverRunPromise: Promise<{ status: number }> | null = null;
  private serverLastExit: VmCommandResult | null = null;
  private commandRunnerTimedOut = false;
  private consoleInput: ((charCode: number) => void) | null = null;
  private interactiveShellRunning = false;
  private interactiveShellPromise: Promise<{ status: number }> | null = null;
  private tailnetLoginStarted = false;
  private resolveTailnetSignal: ((url: string | null) => void) | null = null;
  private rejectTailnetSignal: ((error: Error) => void) | null = null;

  private constructor(
    private readonly cx: CheerpXLinux,
    private readonly workspaceDevice: IdbDevice,
    private readonly dataDevice: DataDevice,
    private readonly autoConnectTailnetForServer: boolean,
    private readonly onConsole?: ConsoleCallback,
    private readonly onStatus?: StatusCallback,
    private readonly onDebug?: DebugCallback,
  ) {}

  static async create(options: CreateWebVmBackendOptions): Promise<WebVmBackend> {
    options.onStatus?.({
      lifecycle: 'booting',
      message: 'Loading CheerpX and disk image',
    });

    const imported = await import('@leaningtech/cheerpx');
    const CheerpX = (
      'default' in imported ? imported.default : imported
    ) as unknown as CheerpXModule;

    let rootDevice: unknown;
    try {
      rootDevice = await CheerpX.CloudDevice.create(WEBVM_DISK_URL);
    } catch (error) {
      if (WEBVM_DISK_URL.startsWith('wss:')) {
        rootDevice = await CheerpX.CloudDevice.create(
          `https:${WEBVM_DISK_URL.slice('wss:'.length)}`,
        );
      } else {
        throw error;
      }
    }

    const rootCache = await CheerpX.IDBDevice.create('sparkrun-root-cache');
    const overlayDevice = await CheerpX.OverlayDevice.create(rootDevice, rootCache);
    const workspaceDevice = await CheerpX.IDBDevice.create('sparkrun-workspace');
    const dataDevice = await CheerpX.DataDevice.create();
    const webDevice = await CheerpX.WebDevice.create('');

    let backend: WebVmBackend | null = null;
    let pendingTailnetIp: string | null = null;
    const networkInterface = {
      authKey: options.tailscaleAuthKey?.trim() || undefined,
      loginUrlCb: (url: string) => {
        backend?.handleLoginUrl(url);
      },
      stateUpdateCb: (state: number) => {
        if (state === 6) {
          backend?.publishTailnetState();
        }
      },
      netmapUpdateCb: (map: {
        self?: { addresses?: string[] };
      }) => {
        const ip = map.self?.addresses?.[0] ?? null;
        if (backend) {
          backend.setTailnetIp(ip);
        } else {
          pendingTailnetIp = ip;
        }
      },
    };

    const cx = await CheerpX.Linux.create({
      mounts: [
        { type: 'ext2', dev: overlayDevice, path: '/' },
        { type: 'dir', dev: workspaceDevice, path: '/workspace' },
        { type: 'dir', dev: dataDevice, path: '/data' },
        { type: 'dir', dev: webDevice, path: '/web' },
        { type: 'devs', path: '/dev' },
        { type: 'devpts', path: '/dev/pts' },
        { type: 'proc', path: '/proc' },
        { type: 'sys', path: '/sys' },
      ],
      networkInterface,
    });

    backend = new WebVmBackend(
      cx,
      workspaceDevice,
      dataDevice,
      Boolean(options.tailscaleAuthKey?.trim()),
      options.onConsole,
      options.onStatus,
      options.onDebug,
    );
    backend.attachConsole();
    await backend.prepareWorkspace();
    if (pendingTailnetIp) {
      backend.setTailnetIp(pendingTailnetIp);
    }
    if (!backend.tailnetIp) {
      backend.publishStatus('ready', 'VM ready');
    }
    return backend;
  }

  getPreviewUrl(): string | null {
    return formatPreviewUrl(this.tailnetIp, this.serverPort);
  }

  getTailnetIp(): string | null {
    return this.tailnetIp;
  }

  getServerPort(): number | null {
    return this.serverPort;
  }

  async connectTailnet(
    options: ConnectTailnetOptions = {},
  ): Promise<string | null> {
    if (this.tailnetIp) {
      this.publishStatus('tailnet-connected', 'Tailnet connected');
      return null;
    }
    if (!this.cx.networkLogin) {
      throw new Error('This CheerpX build does not expose networkLogin.');
    }
    if (options.forceLogin) {
      this.resolveTailnetSignal = null;
      this.rejectTailnetSignal = null;
      this.loginUrl = null;
      this.tailnetLoginStarted = false;
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const signalPromise = new Promise<string | null>((resolve, reject) => {
      this.resolveTailnetSignal = resolve;
      this.rejectTailnetSignal = reject;
    });
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), options.timeoutMs ?? 15_000);
    });

    this.publishStatus('booting', 'Starting Tailscale login');
    if (!this.tailnetLoginStarted) {
      this.tailnetLoginStarted = true;
      try {
        void Promise.resolve(this.cx.networkLogin()).catch((error: unknown) => {
          this.rejectTailnetSignal?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      } catch (error) {
        this.rejectTailnetSignal?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    try {
      const result = await Promise.race([signalPromise, timeoutPromise]);
      if (result === null && !this.tailnetIp && !this.loginUrl) {
        this.publishStatus('booting', 'Tailnet connection started; waiting for IP');
      }
      return result;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async resetWorkspace(): Promise<void> {
    await this.stopServer();
    await this.workspaceDevice.reset();
    this.serverStarted = false;
    this.serverRunPromise = null;
    this.serverLastExit = null;
    this.serverPort = null;
    await this.prepareWorkspace();
    this.publishStatus('ready', 'Workspace reset');
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

  async writeText(relativePath: string, content: string): Promise<void> {
    const normalized = normalizeSitePath(relativePath);
    await this.copyTextToVm(toVmPath(normalized), content, SITE_ROOT);
  }

  private async copyTextToVm(
    destination: string,
    content: string,
    cwd: string,
  ): Promise<void> {
    const staged = stageName();
    await this.dataDevice.writeFile(`/${staged}`, content);
    const directory = destination.slice(0, destination.lastIndexOf('/')) || SITE_ROOT;
    await this.execBash(
      `mkdir -p ${shellQuote(directory)} && cp ${shellQuote(
        `/data/${staged}`,
      )} ${shellQuote(destination)}`,
      SITE_ROOT,
      false,
      false,
    );
  }

  async listDirectory(relativePath: string): Promise<DirectoryEntry[]> {
    const vmPath = toVmPath(normalizeSitePath(relativePath));
    const result = await this.execBash(
      `if [ -d ${shellQuote(vmPath)} ]; then find ${shellQuote(
        vmPath,
      )} -mindepth 1 -maxdepth 1 -printf '%y %p\\n'; fi`,
      SITE_ROOT,
      false,
      false,
    );
    return result.output
      .split('\n')
      .map((line) => line.trim())
      .flatMap((line) => {
        if (!line || !['f', 'd'].includes(line[0]) || line[1] !== ' ') {
          return [];
        }
        const typeCode = line.slice(0, 1);
        const fullPath = line.slice(2);
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
        return {
          path: relative,
          type: typeCode === 'd' ? 'directory' : 'file',
        } satisfies DirectoryEntry;
      });
  }

  async runCommand(
    command: string,
    options: {
      cwd: string;
      background?: boolean;
      stream?: boolean;
      timeoutMs?: number;
    },
  ): Promise<VmCommandResult> {
    if (command === SERVER_COMMAND || options.background) {
      return this.startServer();
    }
    return this.execBash(
      command,
      options.cwd,
      false,
      options.stream ?? false,
      options.timeoutMs,
    );
  }

  startInteractiveShell(): VmCommandResult {
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
    this.onConsole?.('\n[vm] interactive shell started in /workspace/site\n');
    this.publishDebug({
      phase: 'terminal',
      command: '/bin/bash -l',
      cwd: SITE_ROOT,
      background: true,
    });
    this.interactiveShellPromise = this.cx
      .run('/bin/bash', ['-l'], this.runOptions(SITE_ROOT))
      .then((result) => {
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
    for (const char of input) {
      this.consoleInput(char.charCodeAt(0));
    }
    return {
      status: 0,
      output: '',
      background: false,
    };
  }

  async startServer(): Promise<VmCommandResult> {
    if (this.serverStarted && this.serverPort) {
      return {
        status: 0,
        output: `Server is already running on port ${this.serverPort}.`,
        background: true,
      };
    }

    await this.prepareTailnetForServer();
    if (!this.tailnetIp) {
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

    await this.copyTextToVm(SERVER_SCRIPT_PATH, SERVER_SCRIPT, SITE_ROOT);
    this.serverStarted = false;
    this.serverLastExit = null;
    this.serverPort = null;
    this.publishStatus('booting', 'Starting VM web server');
    this.publishDebug({
      phase: 'server',
      output: `Preparing Python static server with automatic host/port binding`,
      background: true,
    });

    await this.execBash(
      [
        SERVER_CLEANUP_COMMAND,
        'rm -f /workspace/site/.server.log /workspace/site/.server.port /workspace/site/.server.host /workspace/site/.server.url',
      ].join(' && '),
      SITE_ROOT,
      false,
      false,
    );

    const pythonCheck = await this.execBash(
      'command -v python3',
      SITE_ROOT,
      false,
      false,
    );
    if (pythonCheck.status !== 0) {
      return {
        status: pythonCheck.status,
        output: `python3 is not available in this WebVM image.\n${pythonCheck.output}`,
        background: true,
      };
    }

    const command = `(nohup ${SERVER_COMMAND} > /workspace/site/.server.log 2>&1 &)`;
    const launch = await this.execBash(command, SITE_ROOT, true, false);
    if (launch.status !== 0) {
      return launch;
    }

    const port = await this.waitForServerPort(6_000);
    const log = await this.readServerLog(40);
    const result: VmCommandResult = port
      ? {
          status: 0,
          output: [`Server started on port ${port}.`, log].filter(Boolean).join('\n'),
          background: true,
        }
      : {
          status: 1,
          output: [`Server port was not written.`, log].filter(Boolean).join('\n'),
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
    if (port) {
      this.publishStatus('booting', `VM web server started on port ${port}`);
    }
    return result;
  }

  private async prepareTailnetForServer(): Promise<void> {
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
      this.publishDebug({
        phase: 'tailnet',
        status: 1,
        output: error instanceof Error ? error.message : String(error),
        background: false,
      });
    }
  }

  private async waitForServerPort(timeoutMs: number): Promise<number | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = await this.execBash(
        'if [ -f /workspace/site/.server.port ]; then cat /workspace/site/.server.port; fi',
        SITE_ROOT,
        false,
        false,
        2_000,
        false,
      );
      const port = Number(result.output.match(/\b\d{2,5}\b/)?.[0]);
      if (result.status === 0 && Number.isInteger(port) && port > 0) {
        this.serverPort = port;
        return port;
      }
      await sleep(300);
    }
    return null;
  }

  private async readServerLog(lines: number): Promise<string> {
    const result = await this.execBash(
      `if [ -f /workspace/site/.server.log ]; then tail -${lines} /workspace/site/.server.log; else echo "No server log found."; fi`,
      SITE_ROOT,
      false,
      false,
      3_000,
    );
    return result.output;
  }

  async stopServer(): Promise<VmCommandResult> {
    this.publishDebug({
      phase: 'server-stop',
      command: SERVER_CLEANUP_COMMAND,
      cwd: SITE_ROOT,
    });
    const result = await this.execBash(
      SERVER_CLEANUP_COMMAND,
      SITE_ROOT,
      false,
      false,
      10_000,
    );
    this.serverStarted = false;
    this.serverRunPromise = null;
    this.serverLastExit = null;
    this.serverPort = null;
    this.publishStatus('ready', 'VM web server stopped');
    return result;
  }

  async checkServer(): Promise<VmCommandResult> {
    const port = this.serverPort ?? (await this.waitForServerPort(4_000));
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
    this.serverStarted = true;
    this.publishStatus('server-running', `VM web server listening on port ${port}`);
    const result: VmCommandResult = {
      status: 0,
      output: `internal: server process is listening on port ${port}`,
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
    this.onDebug?.(entry);
  }

  private getServerLastExit(): VmCommandResult | null {
    return this.serverLastExit;
  }

  private attachConsole(): void {
    const decoder = new TextDecoder();
    this.consoleInput = this.cx.setCustomConsole((buf, vt) => {
      if (vt !== undefined && vt !== 1) {
        return;
      }
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      const text = decoder.decode(bytes);
      if (this.activeCapture !== null) {
        this.activeCapture.output += text;
        if (this.activeCapture.streamToConsole) {
          this.onConsole?.(text);
        }
        return;
      }
      this.onConsole?.(text);
    }, 100, 30);
  }

  private async prepareWorkspace(): Promise<void> {
    await this.execBash(`mkdir -p ${shellQuote(SITE_ROOT)}`, '/', false, false);
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
      this.activeCapture = { output: '', streamToConsole };
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        const commandPromise = this.cx.run('/bin/bash', ['-lc', command], {
          ...this.runOptions(cwd),
        });
        const result = await Promise.race([
          commandPromise,
          new Promise<{ status: number }>((resolve) => {
            timeoutId = globalThis.setTimeout(
              () => resolve({ status: 124 }),
              timeoutMs,
            );
          }),
        ]);
        const output = this.activeCapture.output.trim();
        const timedOut = result.status === 124;
        if (timedOut) {
          this.commandRunnerTimedOut = true;
        }
        const finalOutput = timedOut
          ? [output, `Command timed out after ${timeoutMs}ms.`]
              .filter(Boolean)
              .join('\n')
          : output;
        const commandResult = { status: result.status, output: finalOutput, background };
        if (debug) {
          this.publishDebug({
            phase: 'exec-result',
            command,
            cwd,
            status: result.status,
            output: finalOutput,
            background,
          });
        }
        return { ...commandResult, output: finalOutput };
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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      this.rejectTailnetSignal?.(new Error('Invalid Tailscale login URL.'));
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      this.rejectTailnetSignal?.(new Error('Invalid Tailscale login URL scheme.'));
      return;
    }
    this.loginUrl = parsed.href;
    this.resolveTailnetSignal?.(parsed.href);
    this.resolveTailnetSignal = null;
    this.rejectTailnetSignal = null;
    this.publishStatus('tailnet-login-ready', 'Tailscale login ready');
  }

  private setTailnetIp(ip: string | null): void {
    this.tailnetIp = ip;
    if (ip) {
      this.resolveTailnetSignal?.(null);
      this.resolveTailnetSignal = null;
      this.rejectTailnetSignal = null;
    }
    this.publishTailnetState();
  }

  private publishTailnetState(): void {
    if (this.tailnetIp) {
      this.publishStatus('tailnet-connected', 'Tailnet connected');
      return;
    }
    this.publishStatus('booting', 'Tailnet connected; waiting for address');
  }

  private publishStatus(lifecycle: WebVmLifecycle, message: string): void {
    this.onStatus?.({
      lifecycle,
      message,
      tailnetIp: this.tailnetIp,
      loginUrl: this.loginUrl,
      previewUrl: this.getPreviewUrl(),
      serverPort: this.serverPort,
    });
  }
}
