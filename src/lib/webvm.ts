import { SERVER_COMMAND, SERVER_PORT, SITE_ROOT, WEBVM_DISK_URL } from './constants';
import {
  normalizeSitePath,
  toVmPath,
  type DirectoryEntry,
  type VmCommandResult,
  type VmFileBackend,
} from './tools';

type ConsoleCallback = (text: string) => void;
type StatusCallback = (status: WebVmStatus) => void;

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
  readFileAsBlob(path: string): Promise<Blob>;
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
}

export interface CreateWebVmBackendOptions {
  tailscaleAuthKey?: string;
  onConsole?: ConsoleCallback;
  onStatus?: StatusCallback;
}

export interface ConnectTailnetOptions {
  timeoutMs?: number;
}

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
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

class ReusableServer(ThreadingHTTPServer):
    allow_reuse_address = True

ReusableServer(("0.0.0.0", ${SERVER_PORT}), Handler).serve_forever()
`.trimStart();

function formatPreviewUrl(ip: string | null): string | null {
  if (!ip) {
    return null;
  }
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${SERVER_PORT}/`;
}

export class WebVmBackend implements VmFileBackend {
  private activeCapture: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private tailnetIp: string | null = null;
  private loginUrl: string | null = null;
  private serverStarted = false;
  private tailnetLoginStarted = false;
  private resolveTailnetSignal: ((url: string | null) => void) | null = null;
  private rejectTailnetSignal: ((error: Error) => void) | null = null;

  private constructor(
    private readonly cx: CheerpXLinux,
    private readonly workspaceDevice: IdbDevice,
    private readonly dataDevice: DataDevice,
    private readonly onConsole?: ConsoleCallback,
    private readonly onStatus?: StatusCallback,
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
      options.onConsole,
      options.onStatus,
    );
    backend.attachConsole();
    await backend.prepareWorkspace();
    if (pendingTailnetIp) {
      backend.setTailnetIp(pendingTailnetIp);
    }
    backend.publishStatus('ready', 'VM ready');
    return backend;
  }

  getPreviewUrl(): string | null {
    return formatPreviewUrl(this.tailnetIp);
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
    await this.workspaceDevice.reset();
    this.serverStarted = false;
    await this.prepareWorkspace();
    this.publishStatus('ready', 'Workspace reset');
  }

  async readText(relativePath: string): Promise<string> {
    const blob = await this.workspaceDevice.readFileAsBlob(
      toWorkspaceDevicePath(relativePath),
    );
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
    );
    return result.output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const typeCode = line.slice(0, 1);
        const fullPath = line.slice(2);
        const relative = normalizeSitePath(
          fullPath.startsWith(`${SITE_ROOT}/`)
            ? fullPath.slice(SITE_ROOT.length + 1)
            : fullPath,
        );
        return {
          path: relative,
          type: typeCode === 'd' ? 'directory' : 'file',
        } satisfies DirectoryEntry;
      });
  }

  async runCommand(
    command: string,
    options: { cwd: string; background?: boolean },
  ): Promise<VmCommandResult> {
    if (command === SERVER_COMMAND || options.background) {
      return this.startServer();
    }
    return this.execBash(command, options.cwd, false);
  }

  async startServer(): Promise<VmCommandResult> {
    if (this.serverStarted) {
      return {
        status: 0,
        output: `Server already running on port ${SERVER_PORT}`,
        background: true,
      };
    }

    await this.copyTextToVm(SERVER_SCRIPT_PATH, SERVER_SCRIPT, SITE_ROOT);
    const command = [
      `if [ -f /workspace/site/.server.pid ]; then kill $(cat /workspace/site/.server.pid) 2>/dev/null || true; fi`,
      `cd ${shellQuote(SITE_ROOT)}`,
      `(nohup python3 ${shellQuote(
        SERVER_SCRIPT_PATH,
      )} > /workspace/site/.server.log 2>&1 & echo $! > /workspace/site/.server.pid)`,
      'sleep 1',
      'cat /workspace/site/.server.pid',
    ].join(' && ');
    const result = await this.execBash(command, SITE_ROOT, true);
    if (result.status === 0) {
      this.serverStarted = true;
      this.publishStatus('server-running', 'VM web server running');
    }
    return result;
  }

  private attachConsole(): void {
    const decoder = new TextDecoder();
    this.cx.setCustomConsole((buf, vt) => {
      if (vt !== undefined && vt !== 1) {
        return;
      }
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      const text = decoder.decode(bytes);
      this.onConsole?.(text);
      if (this.activeCapture !== null) {
        this.activeCapture += text;
      }
    }, 100, 30);
  }

  private async prepareWorkspace(): Promise<void> {
    await this.execBash(`mkdir -p ${shellQuote(SITE_ROOT)}`, '/', false);
  }

  private async execBash(
    command: string,
    cwd: string,
    background: boolean,
  ): Promise<VmCommandResult> {
    const run = async (): Promise<VmCommandResult> => {
      this.activeCapture = '';
      try {
        const result = await this.cx.run('/bin/bash', ['-lc', command], {
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
        });
        const output = this.activeCapture.trim();
        return { status: result.status, output, background };
      } finally {
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
    });
  }
}
