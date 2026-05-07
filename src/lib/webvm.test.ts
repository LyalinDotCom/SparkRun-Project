import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_PORT, SITE_ROOT } from './constants';

type RunCall = {
  fileName: string;
  args: string[];
  options?: { cwd?: string };
};

const mockState = vi.hoisted(() => ({
  consoleCallback: null as
    | ((buf: ArrayBuffer | Uint8Array, vt?: number) => void)
    | null,
  dataFiles: new Map<string, string | Uint8Array>(),
  emitEarlyIp: false,
  networkInterface: null as {
    authKey?: string;
    loginUrlCb?: (url: string) => void;
    stateUpdateCb?: (state: number) => void;
    netmapUpdateCb?: (map: { self?: { addresses?: string[] } }) => void;
  } | null,
  runCalls: [] as RunCall[],
  workspaceFiles: new Map<string, string>(),
  cx: null as null | {
    run: ReturnType<typeof vi.fn>;
    setCustomConsole: ReturnType<typeof vi.fn>;
    networkLogin: ReturnType<typeof vi.fn>;
  },
}));

function emitConsole(text: string): void {
  mockState.consoleCallback?.(new TextEncoder().encode(text), 1);
}

function parseSingleQuoted(command: string, prefix: string): string | null {
  const start = command.indexOf(prefix);
  if (start === -1) {
    return null;
  }
  const rest = command.slice(start + prefix.length);
  const end = rest.indexOf("'");
  return end === -1 ? null : rest.slice(0, end);
}

function listImmediate(vmPath: string): string {
  const relative = vmPath === SITE_ROOT ? '' : vmPath.slice(SITE_ROOT.length + 1);
  const workspacePrefix = relative ? `/site/${relative}/` : '/site/';
  const seen = new Map<string, 'f' | 'd'>();
  for (const path of mockState.workspaceFiles.keys()) {
    if (!path.startsWith(workspacePrefix)) {
      continue;
    }
    const rest = path.slice(workspacePrefix.length);
    if (!rest) {
      continue;
    }
    const [first, ...remaining] = rest.split('/');
    const childRelative = relative ? `${relative}/${first}` : first;
    const type = remaining.length > 0 ? 'd' : 'f';
    if (!seen.has(childRelative) || type === 'd') {
      seen.set(childRelative, type);
    }
  }
  return Array.from(seen.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, type]) => `${type} ${SITE_ROOT}/${path}`)
    .join('\n');
}

vi.mock('@leaningtech/cheerpx', () => {
  const cx = {
    run: vi.fn(async (fileName: string, args: string[], options?: { cwd?: string }) => {
      mockState.runCalls.push({ fileName, args, options });
      const command = args[1] ?? '';

      const cpSource = parseSingleQuoted(command, "cp '/data/");
      const cpDestination = parseSingleQuoted(command, "' '/workspace/");
      if (cpSource && cpDestination) {
        const content = mockState.dataFiles.get(`/${cpSource}`);
        if (content !== undefined) {
          mockState.workspaceFiles.set(
            cpDestination.startsWith('site/')
              ? `/${cpDestination}`
              : `/workspace/${cpDestination}`,
            String(content),
          );
        }
      }

      if (command.includes('find ')) {
        const findPath = parseSingleQuoted(command, "find '");
        if (findPath) {
          const listing = listImmediate(findPath);
          if (listing) {
            emitConsole(`${listing}\n`);
          }
        }
      }

      if (command.includes('cat /workspace/site/.server.pid')) {
        emitConsole('4242\n');
      }

      return { status: 0 };
    }),
    setCustomConsole: vi.fn((callback) => {
      mockState.consoleCallback = callback;
      return vi.fn();
    }),
    networkLogin: vi.fn(),
  };
  mockState.cx = cx;

  const cheerpx = {
    CloudDevice: {
      create: vi.fn(async (url: string) => ({ kind: 'cloud', url })),
    },
    IDBDevice: {
      create: vi.fn(async (name: string) => ({
        name,
        readFileAsBlob: async (path: string) => {
          const content = mockState.workspaceFiles.get(path);
          if (content === undefined) {
            throw new Error(`missing ${path}`);
          }
          return { text: async () => content } as Blob;
        },
        reset: async () => {
          if (name.includes('workspace')) {
            mockState.workspaceFiles.clear();
          }
        },
      })),
    },
    OverlayDevice: {
      create: vi.fn(async (baseDevice: unknown, overlayDevice: unknown) => ({
        baseDevice,
        overlayDevice,
      })),
    },
    WebDevice: {
      create: vi.fn(async (path: string) => ({ kind: 'web', path })),
    },
    DataDevice: {
      create: vi.fn(async () => ({
        writeFile: async (path: string, content: string | Uint8Array) => {
          mockState.dataFiles.set(path, content);
        },
      })),
    },
    Linux: {
      create: vi.fn(async (options: { networkInterface?: unknown }) => {
        mockState.networkInterface = options.networkInterface as typeof mockState.networkInterface;
        if (mockState.emitEarlyIp) {
          mockState.networkInterface?.netmapUpdateCb?.({
            self: { addresses: ['100.64.0.10'] },
          });
        }
        return cx;
      }),
    },
  };

  return {
    default: cheerpx,
    ...cheerpx,
  };
});

import { WebVmBackend } from './webvm';

describe('WebVM backend setup', () => {
  beforeEach(() => {
    mockState.consoleCallback = null;
    mockState.dataFiles.clear();
    mockState.emitEarlyIp = false;
    mockState.networkInterface = null;
    mockState.runCalls = [];
    mockState.workspaceFiles.clear();
    mockState.cx?.run.mockClear();
    mockState.cx?.setCustomConsole.mockClear();
    mockState.cx?.networkLogin.mockClear();
  });

  it('boots CheerpX with persistent workspace and Tailscale network wiring', async () => {
    const statuses: string[] = [];
    const backend = await WebVmBackend.create({
      tailscaleAuthKey: 'tskey-auth-test',
      onStatus: (status) => statuses.push(`${status.lifecycle}:${status.message}`),
    });

    expect(backend).toBeInstanceOf(WebVmBackend);
    expect(mockState.networkInterface?.authKey).toBe('tskey-auth-test');
    expect(mockState.cx?.setCustomConsole).toHaveBeenCalledWith(
      expect.any(Function),
      100,
      30,
    );
    expect(mockState.runCalls[0].args[1]).toContain(`mkdir -p '${SITE_ROOT}'`);
    expect(statuses).toContain('booting:Loading CheerpX and disk image');
    expect(statuses).toContain('ready:VM ready');
  });

  it('keeps Tailnet IP updates even when netmap arrives during Linux.create', async () => {
    mockState.emitEarlyIp = true;

    const backend = await WebVmBackend.create({});

    expect(backend.getPreviewUrl()).toBe(`http://100.64.0.10:${SERVER_PORT}/`);
  });

  it('stages writes through DataDevice before copying into the VM workspace', async () => {
    const backend = await WebVmBackend.create({});

    await backend.writeText('nested/index.html', '<h1>quoted "hello"</h1>');

    const copyCall = mockState.runCalls.find((call) => call.args[1].includes(' cp '));
    expect(mockState.dataFiles.size).toBe(1);
    expect(copyCall?.args[1]).toContain("cp '/data/stage-");
    expect(copyCall?.args[1]).toContain(`' '${SITE_ROOT}/nested/index.html'`);
    expect(await backend.readText('nested/index.html')).toBe('<h1>quoted "hello"</h1>');
  });

  it('lists workspace files through the VM command path', async () => {
    const backend = await WebVmBackend.create({});
    mockState.workspaceFiles.set('/site/index.html', '');
    mockState.workspaceFiles.set('/site/assets/site.css', '');

    const entries = await backend.listDirectory('');

    expect(entries).toEqual([
      { path: 'assets', type: 'directory' },
      { path: 'index.html', type: 'file' },
    ]);
  });

  it('starts the real VM web server command without invalid shell composition', async () => {
    const statuses: string[] = [];
    const backend = await WebVmBackend.create({
      onStatus: (status) => statuses.push(status.lifecycle),
    });

    const result = await backend.startServer();

    const command = mockState.runCalls.at(-1)?.args[1] ?? '';
    const stagedServerScript = Array.from(mockState.dataFiles.values()).find(
      (content) =>
        typeof content === 'string' &&
        content.includes('Cross-Origin-Resource-Policy'),
    );
    expect(result).toMatchObject({
      status: 0,
      background: true,
    });
    expect(command).toContain('python3');
    expect(command).toContain('/workspace/.sparkrun_static_server.py');
    expect(command).not.toContain('& &&');
    expect(stagedServerScript).toContain('Cross-Origin-Embedder-Policy');
    expect(stagedServerScript).toContain('cross-origin');
    expect(statuses).toContain('server-running');
  });

  it('opens manual Tailscale login and converts netmap IP to preview URL', async () => {
    const backend = await WebVmBackend.create({});

    const loginPromise = backend.connectTailnet();
    mockState.networkInterface?.loginUrlCb?.('https://login.tailscale.com/a/123');
    mockState.networkInterface?.stateUpdateCb?.(6);
    mockState.networkInterface?.netmapUpdateCb?.({
      self: { addresses: ['100.64.0.20'] },
    });

    await expect(loginPromise).resolves.toBe('https://login.tailscale.com/a/123');
    expect(mockState.cx?.networkLogin).toHaveBeenCalledTimes(1);
    expect(backend.getPreviewUrl()).toBe(`http://100.64.0.20:${SERVER_PORT}/`);
  });
});
