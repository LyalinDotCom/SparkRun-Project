import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SERVER_PORT,
  SITE_ROOT,
  WEBVM_CODING_CANDIDATE_PROFILE,
  WORKSPACE_ROOT,
} from './constants';

type RunCall = {
  fileName: string;
  args: string[];
  options?: { cwd?: string; env?: string[]; uid?: number; gid?: number };
};

const mockState = vi.hoisted(() => ({
  consoleCallback: null as
    | ((buf: ArrayBuffer | Uint8Array, vt?: number) => void)
    | null,
  dataFiles: new Map<string, string | Uint8Array>(),
  dataWrites: [] as Array<{ path: string; content: string | Uint8Array }>,
  nextDataStageStatus: null as number | null,
  nextDataStageError: null as string | null,
  emitEarlyIp: false,
  consoleVt: 1,
  commandCompletionVts: new Map<string, number>(),
  commandConsoleEvents: new Map<string, Array<{ text: string; vt: number }>>(),
  commandTrailingOutputs: new Map<string, Array<{ text: string; vt: number }>>(),
  deferredCompletionDelayMs: new Map<string, number>(),
  commandOutputs: new Map<string, string>(),
  commandStatuses: new Map<string, number>(),
  omitCompletionMarkers: new Set<string>(),
  cloudUrls: [] as string[],
  githubUrls: [] as string[],
  bytesUrls: [] as string[],
  httpHealthy: true,
  httpProbeDelayMs: 0,
  idbNames: [] as string[],
  linuxCreateCalls: 0,
  serverAlive: true,
  serverReady: true,
  serverLaunchExitStatus: null as number | null,
  serverLaunchResolve: null as null | ((result: { status: number }) => void),
  serverLaunches: 0,
  serverPortProbeTimeoutsRemaining: 0,
  pauseReadinessCommand: false,
  readinessCommandStarted: false,
  releaseReadinessCommand: null as null | (() => void),
  pauseServerLogRead: false,
  serverLogReadStarted: false,
  releaseServerLogRead: null as null | (() => void),
  networkInterface: null as {
    authKey?: string;
    loginUrlCb?: (url: string) => void;
    stateUpdateCb?: (state: number) => void;
    netmapUpdateCb?: (map: { self?: { addresses?: string[] } }) => void;
  } | null,
  runCalls: [] as RunCall[],
  workspaceFiles: new Map<string, string | Uint8Array>(),
  cx: null as null | {
    delete: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    setCustomConsole: ReturnType<typeof vi.fn>;
    networkLogin: ReturnType<typeof vi.fn>;
  },
}));

function emitConsole(text: string, vt = mockState.consoleVt): void {
  mockState.consoleCallback?.(
    new TextEncoder().encode(text),
    vt,
  );
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
    .map(([path, type]) => {
      const content = mockState.workspaceFiles.get(`/site/${path}`);
      const size =
        type === 'f' && content !== undefined
          ? typeof content === 'string'
            ? new TextEncoder().encode(content).byteLength
            : content.byteLength
          : 0;
      return `${type} ${size} ${SITE_ROOT}/${path}`;
    })
    .join('\n');
}

vi.mock('@leaningtech/cheerpx', () => {
  const cx = {
    delete: vi.fn(),
    run: vi.fn(async (
      fileName: string,
      args: string[],
      options?: { cwd?: string; env?: string[]; uid?: number; gid?: number },
    ) => {
      mockState.runCalls.push({ fileName, args, options });
      const rawCommand = args.at(-1) ?? '';
      const wrappedStart = rawCommand.indexOf('(\n');
      const wrappedEnd = rawCommand.lastIndexOf(
        '\n)\nsparkrun_command_status=$?',
      );
      const command =
        wrappedStart >= 0 && wrappedEnd > wrappedStart
          ? rawCommand.slice(wrappedStart + 2, wrappedEnd)
          : rawCommand;
      const completionMarker = rawCommand.match(
        /(__SPARKRUN_COMMAND_COMPLETED_[a-f0-9]+__:\s*)/,
      )?.[1]?.trim();
      const complete = (status: number) => {
        for (const path of [...mockState.dataFiles.keys()]) {
          if (
            command.includes(`/data${path}`) &&
            (command.includes('trap ') || command.includes(`rm -f '/data${path}'`))
          ) {
            mockState.dataFiles.delete(path);
          }
        }
        const emitCompletionEvents = () => {
          if (
            completionMarker &&
            !mockState.omitCompletionMarkers.has(command)
          ) {
            emitConsole(
              `\n${completionMarker}${status}\n`,
              mockState.commandCompletionVts.get(command) ?? mockState.consoleVt,
            );
          }
          for (const event of mockState.commandTrailingOutputs.get(command) ?? []) {
            emitConsole(event.text, event.vt);
          }
        };
        const deferredCompletionDelayMs =
          mockState.deferredCompletionDelayMs.get(command);
        if (deferredCompletionDelayMs !== undefined) {
          setTimeout(emitCompletionEvents, deferredCompletionDelayMs);
        } else {
          emitCompletionEvents();
        }
        return { status };
      };

      if (
        fileName === '/usr/bin/setsid' &&
        command.includes('/tmp/sparkrun/server.launch.pid') &&
        command.includes('exec ')
      ) {
        mockState.serverLaunches += 1;
        if (mockState.serverLaunchExitStatus !== null) {
          return { status: mockState.serverLaunchExitStatus };
        }
        return await new Promise<{ status: number }>((resolve) => {
          mockState.serverLaunchResolve = resolve;
        });
      }

      if (
        mockState.pauseReadinessCommand &&
        command.includes("> '/tmp/sparkrun/server.ready'")
      ) {
        mockState.readinessCommandStarted = true;
        await new Promise<void>((resolve) => {
          mockState.releaseReadinessCommand = resolve;
        });
      }
      if (
        mockState.pauseServerLogRead &&
        command.includes('tail -40 /tmp/sparkrun/server.log')
      ) {
        mockState.serverLogReadStarted = true;
        await new Promise<void>((resolve) => {
          mockState.releaseServerLogRead = resolve;
        });
      }

      if (command.includes("rm -rf '/workspace/site'")) {
        for (const path of Array.from(mockState.workspaceFiles.keys())) {
          if (path === '/site' || path.startsWith('/site/')) {
            mockState.workspaceFiles.delete(path);
          }
        }
      }

      const cpSource = parseSingleQuoted(command, "cp '/data/");
      const cpDestination = parseSingleQuoted(command, "' '/workspace/");
      if (cpSource && cpDestination) {
        const content = mockState.dataFiles.get(`/${cpSource}`);
        if (content !== undefined) {
          mockState.workspaceFiles.set(
            cpDestination.startsWith('site/')
              ? `/${cpDestination}`
              : `/workspace/${cpDestination}`,
            typeof content === 'string' ? content : content.slice(),
          );
        }
      }

      if (command.includes('find ')) {
        const findPath = parseSingleQuoted(command, "find '");
        if (findPath) {
          const listing = listImmediate(findPath);
          emitConsole('mesg: ttyname failed: Success\n');
          if (listing) {
            emitConsole(`${listing}\n`);
          }
        }
      }

      if (command.includes('kill -0')) {
        if (!mockState.serverAlive) {
          emitConsole('SPARKRUN_DEAD\n');
        } else if (command.includes('/tmp/sparkrun/server.ready')) {
          emitConsole(
            mockState.serverReady
              ? 'SPARKRUN_ALIVE\nSPARKRUN_BOUND\n'
              : 'SPARKRUN_NOT_READY\n',
          );
        } else {
          emitConsole('SPARKRUN_ALIVE\n');
        }
      } else if (command.includes('cat /tmp/sparkrun/server.pid')) {
        emitConsole('4242\n');
      }

      const probeMatch = command.match(
        /printf '%s' '([^']+)' > '\/workspace\/site\/\.sparkrun-write-probe'/,
      );
      if (probeMatch && command.includes("cat '/workspace/site/.sparkrun-write-probe'")) {
        emitConsole(probeMatch[1]);
      }

      if (command.includes('cat /tmp/sparkrun/server.port')) {
        if (mockState.serverPortProbeTimeoutsRemaining > 0) {
          mockState.serverPortProbeTimeoutsRemaining -= 1;
          return complete(124);
        }
        if (mockState.serverReady) {
          emitConsole(`${SERVER_PORT + 1}\n`);
        }
      }

      if (command.includes('http://127.0.0.1:')) {
        emitConsole(`internal: HTTP 200 from http://127.0.0.1:${SERVER_PORT + 1}/\n`);
        if (command.includes('http://100.64.0.10:')) {
          emitConsole(`tailnet: HTTP 200 from http://100.64.0.10:${SERVER_PORT + 1}/\n`);
        }
      }

      if (
        command.includes('curl') &&
        command.includes('SPARKRUN_HTTP_%{http_code}')
      ) {
        if (mockState.httpProbeDelayMs > 0) {
          const nestedSetsidIndex = args.lastIndexOf('/usr/bin/setsid');
          const timeoutSeconds = Number.parseFloat(
            nestedSetsidIndex > 0 ? (args[nestedSetsidIndex - 1] ?? '') : '',
          );
          const guestTimeoutMs = Number.isFinite(timeoutSeconds)
            ? timeoutSeconds * 1_000
            : Number.POSITIVE_INFINITY;
          await new Promise<void>((resolve) => {
            setTimeout(
              resolve,
              Math.min(mockState.httpProbeDelayMs, guestTimeoutMs),
            );
          });
          if (mockState.httpProbeDelayMs >= guestTimeoutMs) {
            // The guest timeout kills the command before its wrapper can emit
            // the nonce-bound completion marker.
            return { status: 124 };
          }
        }
        if (mockState.httpHealthy) {
          emitConsole('SPARKRUN_HTTP_200\n');
          return complete(0);
        }
        emitConsole('curl: (7) Failed to connect\nSPARKRUN_HTTP_000\n');
        return complete(1);
      }

      for (const event of mockState.commandConsoleEvents.get(command) ?? []) {
        emitConsole(event.text, event.vt);
      }
      const configuredOutput = mockState.commandOutputs.get(command);
      if (configuredOutput !== undefined) {
        emitConsole(
          configuredOutput,
          mockState.commandCompletionVts.get(command) ?? mockState.consoleVt,
        );
      }

      if (
        mockState.nextDataStageError !== null &&
        command.includes('trap ') &&
        command.includes('/data/')
      ) {
        const message = mockState.nextDataStageError;
        mockState.nextDataStageError = null;
        throw new Error(message);
      }

      if (
        mockState.nextDataStageStatus !== null &&
        command.includes('trap ') &&
        command.includes('/data/')
      ) {
        const status = mockState.nextDataStageStatus;
        mockState.nextDataStageStatus = null;
        return complete(status);
      }

      return complete(mockState.commandStatuses.get(command) ?? 0);
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
      create: vi.fn(async (url: string) => {
        mockState.cloudUrls.push(url);
        return { kind: 'cloud', url };
      }),
    },
    GitHubDevice: {
      create: vi.fn(async (url: string) => {
        mockState.githubUrls.push(url);
        return { kind: 'github', url };
      }),
    },
    HttpBytesDevice: {
      create: vi.fn(async (url: string) => {
        mockState.bytesUrls.push(url);
        return { kind: 'bytes', url };
      }),
    },
    IDBDevice: {
      create: vi.fn(async (name: string) => {
        mockState.idbNames.push(name);
        return {
          name,
          readFileAsBlob: async (path: string) => {
            const content = mockState.workspaceFiles.get(path);
            if (content === undefined) {
              return null;
            }
            const bytes =
              typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content.slice();
            return {
              size: bytes.byteLength,
              text: async () => new TextDecoder().decode(bytes),
              arrayBuffer: async () =>
                bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength,
                ),
            } as Blob;
          },
          reset: async () => {
            if (name.includes('workspace')) {
              mockState.workspaceFiles.clear();
            }
          },
        };
      }),
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
          mockState.dataWrites.push({
            path,
            content:
              typeof content === 'string' ? content : content.slice(),
          });
        },
      })),
    },
    Linux: {
      create: vi.fn(async (options: { networkInterface?: unknown }) => {
        mockState.linuxCreateCalls += 1;
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

import {
  API_RETRY_LIMIT,
  cacheBustedByteDeviceUrl,
  isFatalTailnetRuntimeError,
  resetFatalTailnetRuntimeFailureForTests,
  validateGoogleApiKey,
  validateTailscaleAuthKey,
  WebVmBackend,
  withEightApiRetries,
} from './webvm';

const FATAL_TCP_INPUT_ERROR =
  'RuntimeError: memory access out of bounds at tcp_input (wasm) at ipstack.js:623 at tailscale_tun.js:52';
const FATAL_TCP_BIND_ERROR =
  'RuntimeError: memory access out of bounds at tcp_bind (wasm) at tailscale_tun.js:91';

function dispatchFatalNetworkError(message = FATAL_TCP_INPUT_ERROR): void {
  window.dispatchEvent(
    new ErrorEvent('error', {
      error: new Error(message),
      message,
      filename: 'https://cxrtnc.leaningtech.com/1.3.9/ipstack.js',
      lineno: 623,
      colno: 17,
    }),
  );
}

describe('external API retries', () => {
  it('keeps byte-device retry URLs same-origin when the image path is relative', () => {
    expect(
      cacheBustedByteDeviceUrl('/vm-images/coding.ext2', 0),
    ).toBe('/vm-images/coding.ext2');
    expect(
      cacheBustedByteDeviceUrl('/vm-images/coding.ext2?channel=rc', 3),
    ).toBe('/vm-images/coding.ext2?channel=rc&sparkrun-range-retry=3');
  });

  it('preserves an absolute byte-device origin while cache-busting a retry', () => {
    expect(
      cacheBustedByteDeviceUrl(
        'https://images.example.test/vm-images/coding.ext2',
        2,
      ),
    ).toBe(
      'https://images.example.test/vm-images/coding.ext2?sparkrun-range-retry=2',
    );
  });

  it('makes one initial attempt plus exactly eight retries before failure', async () => {
    const operation = vi.fn(async () => {
      throw new Error('still unavailable');
    });
    const delays: number[] = [];

    await expect(
      withEightApiRetries(operation, {
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
      }),
    ).rejects.toThrow('still unavailable');

    expect(operation).toHaveBeenCalledTimes(API_RETRY_LIMIT + 1);
    expect(delays).toHaveLength(API_RETRY_LIMIT);
  });

  it('returns immediately after a retry succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ready');

    await expect(
      withEightApiRetries(operation, { delay: async () => undefined }),
    ).resolves.toBe('ready');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe('Google API key validation', () => {
  it('accepts current opaque Google keys without requiring the legacy AIza prefix', () => {
    expect(validateGoogleApiKey('opaque_google_key_1234567890-ABC')).toBeNull();
    expect(validateGoogleApiKey(`AI${'za'}${'1'.repeat(30)}`)).toBeNull();
    expect(validateGoogleApiKey('auth.key.segment_1234567890-ABC')).toBeNull();
  });

  it('rejects empty, short, whitespace-bearing, and punctuated values', () => {
    expect(validateGoogleApiKey('')).toContain('required');
    expect(validateGoogleApiKey('too-short')).toContain('does not look');
    expect(validateGoogleApiKey('valid-looking-key with-space-12345')).toContain(
      'no spaces',
    );
    expect(validateGoogleApiKey('valid-looking-key!with-symbol-12345')).toContain(
      'does not look',
    );
  });
});

describe('Tailscale auth key validation', () => {
  it('accepts device auth keys and rejects OAuth client credentials', () => {
    expect(
      validateTailscaleAuthKey(
        ['tskey', 'auth', 'k12345678901234567890-12345678901234567890'].join('-'),
      ),
    ).toBeNull();
    expect(
      validateTailscaleAuthKey(
        ['tskey', 'client', 'k12345678901234567890-12345678901234567890'].join('-'),
      ),
    ).toContain('OAuth client credential');
  });

  it('rejects missing, malformed, and short values', () => {
    expect(validateTailscaleAuthKey('')).toContain('required');
    expect(validateTailscaleAuthKey('not-a-key')).toContain('start with');
    expect(validateTailscaleAuthKey('tskey-auth-too-short')).toContain(
      'too short',
    );
    expect(
      validateTailscaleAuthKey('tskey-auth-valid-looking but-spaced-1234567890'),
    ).toContain('does not look');
  });
});

describe('CheerpX Tailnet fatal-error classification', () => {
  it.each([
    ['tcp_input string with both network modules', FATAL_TCP_INPUT_ERROR],
    ['tcp_bind Error from the Tailscale tunnel', new Error(FATAL_TCP_BIND_ERROR)],
    [
      'structured worker rejection',
      {
        name: 'RuntimeError',
        message: 'memory access out of bounds at tcp_input',
        stack: 'tcp_input@https://example.test/ipstack.js:623',
      },
    ],
    [
      'case-insensitive module and symbol names',
      'MEMORY ACCESS OUT OF BOUNDS at TCP_BIND in IPSTACK.JS',
    ],
  ])('accepts %s', (_label, candidate) => {
    expect(isFatalTailnetRuntimeError(candidate)).toBe(true);
  });

  it.each([
    ['benign CheerpX worker noise', 'TypeError: Cannot read properties of undefined (reading a1) at cx_esm.js'],
    ['unrelated guest memory error', 'RuntimeError: memory access out of bounds in guest.js'],
    ['network module without memory failure', 'tcp_input failed at ipstack.js'],
    ['memory failure without a TCP symbol', 'memory access out of bounds at ipstack.js'],
    ['TCP symbol without an allowed module', 'memory access out of bounds at tcp_bind in socket.js'],
    ['near-match symbol', 'memory access out of bounds at tcp_input_buffer in ipstack.js'],
    ['empty value', ''],
    ['null value', null],
  ])('rejects %s', (_label, candidate) => {
    expect(isFatalTailnetRuntimeError(candidate)).toBe(false);
  });
});

describe('WebVM backend setup', () => {
  beforeEach(() => {
    resetFatalTailnetRuntimeFailureForTests();
    mockState.consoleCallback = null;
    mockState.dataFiles.clear();
    mockState.dataWrites = [];
    mockState.nextDataStageStatus = null;
    mockState.nextDataStageError = null;
    mockState.emitEarlyIp = false;
    mockState.consoleVt = 1;
    mockState.commandCompletionVts.clear();
    mockState.commandConsoleEvents.clear();
    mockState.commandTrailingOutputs.clear();
    mockState.deferredCompletionDelayMs.clear();
    mockState.commandOutputs.clear();
    mockState.commandStatuses.clear();
    mockState.cloudUrls = [];
    mockState.githubUrls = [];
    mockState.bytesUrls = [];
    mockState.httpHealthy = true;
    mockState.httpProbeDelayMs = 0;
    mockState.idbNames = [];
    mockState.linuxCreateCalls = 0;
    mockState.serverAlive = true;
    mockState.serverReady = true;
    mockState.serverLaunchExitStatus = null;
    mockState.serverLaunchResolve = null;
    mockState.serverLaunches = 0;
    mockState.serverPortProbeTimeoutsRemaining = 0;
    mockState.pauseReadinessCommand = false;
    mockState.readinessCommandStarted = false;
    mockState.releaseReadinessCommand = null;
    mockState.pauseServerLogRead = false;
    mockState.serverLogReadStarted = false;
    mockState.releaseServerLogRead = null;
    mockState.networkInterface = null;
    mockState.runCalls = [];
    mockState.omitCompletionMarkers.clear();
    mockState.workspaceFiles.clear();
    mockState.cx?.run.mockClear();
    mockState.cx?.delete.mockClear();
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
    expect(mockState.runCalls[0].args.at(-1)).toContain(`rm -rf '${SITE_ROOT}'`);
    expect(mockState.runCalls[0].args.at(-1)).toContain(`mkdir -p '${SITE_ROOT}'`);
    expect(statuses).toContain('booting:Loading CheerpX and disk image');
    expect(statuses).toContain('ready:VM ready');
  });

  it('shares concurrent disposal and deletes the CheerpX instance exactly once', async () => {
    const backend = await WebVmBackend.create({});

    const first = backend.dispose();
    const second = backend.dispose();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    await backend.dispose();

    expect(mockState.cx?.delete).toHaveBeenCalledTimes(1);
    await expect(backend.runCommand('echo stale')).resolves.toMatchObject({
      status: 1,
      output: expect.stringContaining('disposed'),
    });
    expect(backend.startInteractiveShell()).toMatchObject({
      status: 1,
      output: expect.stringContaining('disposed'),
    });
    expect(backend.writeTerminalInput('pwd\n')).toMatchObject({
      status: 1,
      output: expect.stringContaining('disposed'),
    });
  });

  it('restores vault archives without unsupported ownership changes', async () => {
    const backend = await WebVmBackend.create({});

    await backend.restoreWorkspaceArchive(
      new Blob(['checkpoint-bytes'], { type: 'application/gzip' }),
    );

    const restoreCall = mockState.runCalls.find((call) =>
      call.args.at(-1)?.includes('/data/restore-'),
    );
    expect(restoreCall?.args.at(-1)).toContain('tar --no-same-owner');
    expect(restoreCall?.args.at(-1)).toContain("-C '/tmp/sparkrun/");
    expect(restoreCall?.args.at(-1)).toContain("cp -dR '/tmp/sparkrun/");
    expect(restoreCall?.args.at(-1)).not.toContain(
      `tar --no-same-owner -C '${WORKSPACE_ROOT}'`,
    );
    expect(mockState.dataFiles.size).toBe(0);
  });

  it('removes the in-memory restore stage after a failed restore', async () => {
    const backend = await WebVmBackend.create({});
    mockState.nextDataStageStatus = 7;

    await expect(
      backend.restoreWorkspaceArchive(
        new Blob(['bad-checkpoint'], { type: 'application/gzip' }),
      ),
    ).rejects.toThrow('Could not restore the VM workspace checkpoint');

    expect(mockState.dataFiles.size).toBe(0);
  });

  it('best-effort removes a restore stage when cx.run rejects before its EXIT trap executes', async () => {
    const backend = await WebVmBackend.create({});
    mockState.nextDataStageError = 'restore shell transport rejected';

    await expect(
      backend.restoreWorkspaceArchive(
        new Blob(['bad-checkpoint'], { type: 'application/gzip' }),
      ),
    ).rejects.toThrow('Could not restore the VM workspace checkpoint');

    expect(mockState.dataFiles.size).toBe(0);
    expect(
      mockState.runCalls.some((call) =>
        (call.args.at(-1) ?? '').includes("(\nrm -f '/data/restore-"),
      ),
    ).toBe(true);
  });

  it('fails closed by disposing the VM when a command signal is aborted', async () => {
    const backend = await WebVmBackend.create({});
    const controller = new AbortController();
    controller.abort();

    await expect(
      backend.runCommand('echo should-not-complete', {
        cwd: SITE_ROOT,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.isDisposed()).toBe(true);
    expect(mockState.cx?.delete).toHaveBeenCalledTimes(1);
  });

  it('deletes CheerpX when workspace preparation fails after Linux.create', async () => {
    mockState.commandStatuses.set(
      `rm -rf '${SITE_ROOT}' && mkdir -p '${SITE_ROOT}'`,
      7,
    );

    await expect(WebVmBackend.create({})).rejects.toThrow(
      `Could not prepare ${SITE_ROOT}`,
    );
    expect(mockState.cx?.delete).toHaveBeenCalledTimes(1);
  });

  it('loads the versioned custom coding image through HttpBytesDevice', async () => {
    const backend = await WebVmBackend.create({
      diskProfile: WEBVM_CODING_CANDIDATE_PROFILE,
      prepareWorkspace: 'preserve',
    });

    expect(mockState.bytesUrls).toEqual([
      WEBVM_CODING_CANDIDATE_PROFILE.url,
    ]);
    expect(mockState.githubUrls).toEqual([]);
    expect(mockState.cloudUrls).toEqual([]);

    await backend.runCommand('alpine-command');
    const alpineCall = mockState.runCalls.find((call) =>
      call.args.at(-1)?.includes('\nalpine-command\n'),
    );
    expect(alpineCall?.fileName).toBe('/bin/busybox');
    expect(alpineCall?.args.slice(0, 5)).toEqual([
      'timeout',
      '-s',
      'TERM',
      '-k',
      '2s',
    ]);
    const setsidIndex = alpineCall?.args.indexOf('/usr/bin/setsid') ?? -1;
    expect(alpineCall?.args.slice(setsidIndex, setsidIndex + 3)).toEqual([
      '/usr/bin/setsid',
      '-f',
      '-w',
    ]);
    expect(alpineCall?.options?.env).toEqual(
      expect.arrayContaining([
        'NODE_OPTIONS=--require=/usr/local/lib/sparkrun/node-exit-preload.cjs',
        'SPARKRUN_NODE_EXIT_ADDON=/usr/local/lib/sparkrun/node-exit-addon.node',
        'NODE_COMPILE_CACHE=/usr/local/lib/sparkrun/node-compile-cache',
      ]),
    );
  });

  it('supports named per-project databases and an explicit preserved workspace', async () => {
    mockState.workspaceFiles.set('/site/resume.txt', 'survived');

    const backend = await WebVmBackend.create({
      workspaceDbName: 'sparkrun-workspace-project-123',
      rootCacheDbName: 'sparkrun-root-project-123',
      prepareWorkspace: 'preserve',
    });

    expect(mockState.idbNames).toEqual([
      'sparkrun-root-project-123',
      'sparkrun-workspace-project-123',
    ]);
    expect(await backend.readText('resume.txt')).toBe('survived');
    expect(mockState.runCalls[0].args.at(-1)).toContain(
      `mkdir -p '${SITE_ROOT}'`,
    );
  });

  it('makes explicit reset destructive even after a preserved boot', async () => {
    mockState.workspaceFiles.set('/site/stale.txt', 'stale');
    const backend = await WebVmBackend.create({ prepareWorkspace: 'preserve' });
    expect(await backend.readText('stale.txt')).toBe('stale');

    await backend.resetWorkspace();

    await expect(backend.readText('stale.txt')).rejects.toThrow('File not found');
    expect(
      mockState.runCalls.some((call) =>
        call.args.at(-1)?.includes(`rm -rf '${SITE_ROOT}'`),
      ),
    ).toBe(true);
  });

  it('keeps Tailnet IP updates even when netmap arrives during Linux.create', async () => {
    mockState.emitEarlyIp = true;

    const backend = await WebVmBackend.create({});

    expect(backend.getPreviewUrl()).toBeNull();
    await backend.startServer();
    expect(backend.getPreviewUrl()).toBe(`http://100.64.0.10:${SERVER_PORT + 1}/`);
  });

  it('stages writes through DataDevice before copying into the VM workspace', async () => {
    const backend = await WebVmBackend.create({});

    await backend.writeText('nested/index.html', '<h1>quoted "hello"</h1>');

    const copyCall = mockState.runCalls.find((call) =>
      call.args.at(-1)?.includes(' cp '),
    );
    expect(mockState.dataFiles.size).toBe(0);
    expect(mockState.dataWrites).toHaveLength(1);
    expect(copyCall?.args.at(-1)).toContain("cp '/data/stage-");
    expect(copyCall?.args.at(-1)).toContain(`' '${SITE_ROOT}/nested/index.html'`);
    expect(await backend.readText('nested/index.html')).toBe('<h1>quoted "hello"</h1>');
  });

  it('removes every in-memory write stage after success and failure', async () => {
    const backend = await WebVmBackend.create({});

    await backend.writeText('one.txt', 'one');
    await backend.writeText('two.txt', 'two');
    mockState.nextDataStageStatus = 9;
    await expect(backend.writeText('failed.txt', 'failed')).rejects.toThrow(
      'Failed to write',
    );

    expect(mockState.dataWrites).toHaveLength(3);
    expect(mockState.dataFiles.size).toBe(0);
  });

  it('best-effort removes an in-memory stage when cx.run rejects before the EXIT trap executes', async () => {
    const backend = await WebVmBackend.create({});
    mockState.nextDataStageError = 'worker transport rejected before shell start';

    await expect(backend.writeText('failed-before-shell.txt', 'failed')).rejects.toThrow(
      'Failed to write',
    );

    expect(mockState.dataFiles.size).toBe(0);
    expect(
      mockState.runCalls.some((call) => {
        const command = call.args.at(-1) ?? '';
        return command.includes("(\nrm -f '/data/stage-");
      }),
    ).toBe(true);
  });

  it('throws a clear file-not-found error when CheerpX returns a null blob', async () => {
    const backend = await WebVmBackend.create({});

    await expect(backend.readText('missing.js')).rejects.toThrow(
      `File not found: ${SITE_ROOT}/missing.js`,
    );
  });

  it('reads workspace files as byte-exact binary data', async () => {
    const backend = await WebVmBackend.create({});
    const expected = new Uint8Array([0x00, 0xff, 0x80, 0x41]);
    mockState.workspaceFiles.set('/site/artifact.bin', expected);

    const actual = await backend.readBytes('artifact.bin');

    expect(actual).toEqual(expected);
    expect(actual).not.toBe(expected);
  });

  it('writes workspace files as byte-exact binary data', async () => {
    const backend = await WebVmBackend.create({});
    const expected = new Uint8Array([0x00, 0xff, 0x80, 0x41]);

    await backend.writeBytes('artifacts/result.bin', expected);

    expect(mockState.dataFiles.size).toBe(0);
    const staged = mockState.dataWrites.at(-1)?.content;
    expect(staged).toEqual(expected);
    expect(await backend.readBytes('artifacts/result.bin')).toEqual(expected);
  });

  it('lists workspace files through the VM command path', async () => {
    const backend = await WebVmBackend.create({});
    mockState.workspaceFiles.set('/site/index.html', '');
    mockState.workspaceFiles.set('/site/assets/site.css', '');

    const entries = await backend.listDirectory('');

    expect(entries).toEqual([
      { path: 'assets', type: 'directory' },
      { path: 'index.html', type: 'file', sizeBytes: 0 },
    ]);
  });

  it('rejects a failed directory listing instead of treating it as empty', async () => {
    const debugEntries: Array<{
      phase: string;
      status?: number;
      output?: string;
    }> = [];
    const backend = await WebVmBackend.create({
      onDebug: (entry) => debugEntries.push(entry),
    });
    const listCommand =
      `if [ -d '${SITE_ROOT}' ]; then find '${SITE_ROOT}' ` +
      "-mindepth 1 -maxdepth 1 -printf '%y %s %p\\n'; fi";
    mockState.commandStatuses.set(listCommand, 7);
    mockState.commandOutputs.set(
      listCommand,
      'sensitive guest output that must not reach diagnostics\n',
    );

    await expect(backend.listDirectory('')).rejects.toThrow(
      'Could not list the workspace directory because the VM command failed (status 7).',
    );
    expect(debugEntries).toContainEqual({
      phase: 'directory-list',
      status: 7,
      output:
        'Could not list the workspace directory because the VM command failed (status 7).',
    });
    expect(
      debugEntries.find((entry) => entry.phase === 'directory-list')?.output,
    ).not.toContain('sensitive guest output');
  });

  it('rejects a timed-out directory listing with restart guidance', async () => {
    const backend = await WebVmBackend.create({});
    const listCommand =
      `if [ -d '${SITE_ROOT}' ]; then find '${SITE_ROOT}' ` +
      "-mindepth 1 -maxdepth 1 -printf '%y %s %p\\n'; fi";
    mockState.commandStatuses.set(listCommand, 124);

    await expect(backend.listDirectory('')).rejects.toThrow(
      'Could not list the workspace directory because the VM command timed out (status 124). Restart the VM before continuing.',
    );
  });

  it('does not stream internal directory listings into the user terminal', async () => {
    const terminal: string[] = [];
    const backend = await WebVmBackend.create({
      onConsole: (text) => terminal.push(text),
    });
    mockState.workspaceFiles.set('/site/index.html', '');

    await backend.listDirectory('');

    expect(terminal.join('')).not.toContain('/workspace/site/index.html');
    expect(terminal.join('')).not.toContain('mesg: ttyname failed');
  });

  it('preserves a proven command status and keeps later captures clean', async () => {
    const backend = await WebVmBackend.create({});
    mockState.commandStatuses.set('slow-command', 124);
    mockState.commandOutputs.set('slow-command', 'partial output\n');
    mockState.commandOutputs.set('next-command', 'next output\n');

    const timedOut = await backend.runCommand('slow-command', {
      cwd: SITE_ROOT,
      timeoutMs: 25,
    });
    const next = await backend.runCommand('next-command', {
      cwd: SITE_ROOT,
      timeoutMs: 25,
    });

    expect(timedOut.status).toBe(124);
    expect(timedOut.output).toBe('partial output');
    expect(next).toMatchObject({ status: 0, output: 'next output' });
    expect(next.output).not.toContain('partial output');
    const slowCall = mockState.runCalls.find((call) =>
      call.args.at(-1)?.includes('\nslow-command\n'),
    );
    expect(slowCall?.fileName).toBe('/usr/bin/timeout');
    expect(slowCall?.args).toContain('--kill-after=2s');
    const setsidIndex = slowCall?.args.indexOf('/usr/bin/setsid') ?? -1;
    expect(slowCall?.args.slice(setsidIndex, setsidIndex + 3)).toEqual([
      '/usr/bin/setsid',
      '-f',
      '-w',
    ]);
  });

  it('rejects generic detached commands without launching a guest process', async () => {
    const backend = await WebVmBackend.create({});
    const callsBefore = mockState.runCalls.length;

    const result = await backend.runCommand('npm test && false', {
      background: true,
    });

    expect(result).toMatchObject({ status: 1, background: false });
    expect(result.output).toContain('Detached commands are intentionally unsupported');
    expect(mockState.runCalls).toHaveLength(callsBefore);
  });

  it('rejects common shell-level detachment without rejecting finite shell syntax', async () => {
    const backend = await WebVmBackend.create({});
    const callsBefore = mockState.runCalls.length;

    for (const command of [
      'sleep 100 &',
      'nohup npm run dev',
      'disown',
      'coproc sleep 100',
      'setsid -f sleep 100',
      'setsid --fork sleep 100',
    ]) {
      const result = await backend.runCommand(command);
      expect(result).toMatchObject({ status: 1, background: false });
      expect(result.output).toContain('Detached shell processes');
    }
    expect(mockState.runCalls).toHaveLength(callsBefore);

    const finite = await backend.runCommand(
      `printf '%s\\n' "query=a&b" 2>&1 && printf done`,
    );
    expect(finite.status).toBe(0);
    expect(mockState.runCalls).toHaveLength(callsBefore + 1);
  });

  it('treats BusyBox false-zero without completion proof as a timeout and stops the VM', async () => {
    const backend = await WebVmBackend.create({
      diskProfile: WEBVM_CODING_CANDIDATE_PROFILE,
    });
    mockState.commandStatuses.set('timed-command', 0);
    mockState.commandOutputs.set('timed-command', 'truncated output\n');
    mockState.omitCompletionMarkers.add('timed-command');

    const result = await backend.runCommand('timed-command', {
      timeoutMs: 25,
    });
    const callsAfterTimeout = mockState.runCalls.length;
    const next = await backend.runCommand('must-not-run');

    expect(result).toMatchObject({ status: 124, background: false });
    expect(result.output).toContain('completion proof');
    expect(result.output).toContain('truncated output');
    expect(mockState.cx?.delete).toHaveBeenCalledTimes(1);
    expect(next.status).toBe(1);
    expect(next.output).toContain('disposed');
    expect(mockState.runCalls).toHaveLength(callsAfterTimeout);
    await expect(backend.resetWorkspace()).rejects.toThrow('fresh VM');
  });

  it('uses the completion marker status instead of trusting the timeout runner', async () => {
    const backend = await WebVmBackend.create({});
    mockState.commandStatuses.set('exit-seven', 7);
    mockState.commandOutputs.set('exit-seven', 'application output\n');

    const result = await backend.runCommand('exit-seven');

    expect(result).toEqual({
      status: 7,
      output: 'application output',
      background: false,
    });
    expect(mockState.cx?.delete).not.toHaveBeenCalled();
  });

  it('does not copy a failed command into the browser console', async () => {
    const backend = await WebVmBackend.create({});
    const secret = `ghp_${'s'.repeat(36)}`;
    const command = `trap '' EXIT; printf /data/probe; curl -H 'Authorization: Bearer ${secret}' https://example.invalid`;
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    mockState.nextDataStageError = 'worker transport failed';

    try {
      const result = await backend.runCommand(command);

      expect(result.status).toBe(1);
      expect(consoleError).toHaveBeenCalled();
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain(secret);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain(command);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('accepts a nonce completion line followed by late buffered VT output', async () => {
    const backend = await WebVmBackend.create({});
    mockState.commandOutputs.set('buffered-command', 'command output\n');
    mockState.deferredCompletionDelayMs.set('buffered-command', 35);
    mockState.commandTrailingOutputs.set('buffered-command', [
      { vt: 1, text: 'late buffered output\n' },
    ]);

    const result = await backend.runCommand('buffered-command');

    expect(result).toEqual({
      status: 0,
      output: 'command output\nlate buffered output',
      background: false,
    });
    expect(mockState.cx?.delete).not.toHaveBeenCalled();
  });

  it('does not mistake stale or user-printed completion text for the current nonce', async () => {
    const backend = await WebVmBackend.create({});
    mockState.commandOutputs.set(
      'print-stale-marker',
      '__SPARKRUN_COMMAND_COMPLETED_stale__:0\nuser output\n',
    );

    const result = await backend.runCommand('print-stale-marker');

    expect(result.status).toBe(0);
    expect(result.output).toContain('__SPARKRUN_COMMAND_COMPLETED_stale__:0');
    expect(result.output).toContain('user output');
  });

  it('selects the VT containing the nonce when an interactive shell emits first', async () => {
    const backend = await WebVmBackend.create({});
    mockState.commandConsoleEvents.set('managed-command', [
      { vt: 1, text: 'interactive-shell-prompt$ ' },
    ]);
    mockState.commandCompletionVts.set('managed-command', 2);
    mockState.commandOutputs.set('managed-command', 'managed-output\n');

    const result = await backend.runCommand('managed-command');

    expect(result).toEqual({
      status: 0,
      output: 'managed-output',
      background: false,
    });
    expect(mockState.cx?.delete).not.toHaveBeenCalled();
  });

  it('checks the static server bind certificate and live PID without loopback', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    const result = await backend.checkServer();

    expect(result).toMatchObject({
      status: 0,
      background: false,
    });
    expect(result.output).toContain(
      `internal: server process is alive and bound on port ${SERVER_PORT + 1}`,
    );
    expect(result.output).not.toContain('tailnet:');
  });

  it('reports a dead server and clears cached state so it can be restarted', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    await backend.startServer();
    expect(backend.getServerPort()).toBe(SERVER_PORT + 1);

    // The recorded PID is no longer alive (server crashed). checkServer must not
    // trust the lingering port file.
    mockState.serverAlive = false;
    const dead = await backend.checkServer();
    expect(dead.status).toBe(1);
    expect(dead.output).toContain('Server process is not running.');
    expect(backend.getServerPort()).toBeNull();

    // Because the cached state was cleared, startServer no longer short-circuits
    // on "already running" and actually relaunches.
    mockState.serverAlive = true;
    const restart = await backend.startServer();
    expect(restart.status).toBe(0);
    expect(restart.output).not.toContain('already running');
  });

  it('re-proves cached server liveness before reporting it already running', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    await backend.startServer();
    const launchesAfterFirstStart = mockState.serverLaunches;
    mockState.serverAlive = false;

    const restart = backend.startServer();
    await vi.waitFor(() => expect(mockState.serverLaunches).toBe(
      launchesAfterFirstStart + 1,
    ));
    mockState.serverAlive = true;

    await expect(restart).resolves.toMatchObject({ status: 0 });
    expect((await restart).output).not.toContain('already running');
  });

  it('does not return cached success while a tracked server exit is settling', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    await backend.startServer();
    const launchesAfterFirstStart = mockState.serverLaunches;

    // Resolve the attached process and immediately call startServer, before its
    // Promise reaction has had a microtask in which to invalidate the cache.
    mockState.serverLaunchResolve?.({ status: 13 });
    const restart = backend.startServer();

    await vi.waitFor(() =>
      expect(mockState.serverLaunches).toBe(launchesAfterFirstStart + 1),
    );
    await expect(restart).resolves.toMatchObject({ status: 0 });
    expect((await restart).output).not.toContain('already running');
  });

  it('fails closed when startServer races disposal of a cached live server', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    await backend.startServer();
    const runCallsBeforeDispose = mockState.runCalls.length;
    const disposal = backend.dispose();
    const result = await backend.startServer();

    expect(result).toMatchObject({ status: 1, background: true });
    expect(result.output).toContain('disposed');
    expect(backend.getServerPort()).toBeNull();
    expect(mockState.runCalls).toHaveLength(runCallsBeforeDispose);
    await disposal;
  });

  it('starts the real VM web server command without invalid shell composition', async () => {
    mockState.emitEarlyIp = true;
    const statuses: string[] = [];
    const backend = await WebVmBackend.create({
      onStatus: (status) => statuses.push(status.lifecycle),
    });

    const result = await backend.startServer();

    const cleanupCommand =
      mockState.runCalls.find((call) =>
        call.args.at(-1)?.includes('rm -f /tmp/sparkrun/server.pid'),
      )?.args.at(-1) ?? '';
    const serverLaunch = mockState.runCalls.find(
      (call) =>
        call.fileName === '/usr/bin/setsid' &&
        call.args.at(-1)?.includes('exec /usr/bin/python3') &&
        call.args.at(-1)?.includes('.sparkrun_static_server.py'),
    );
    const stagedServerScript = mockState.dataWrites
      .map(({ content }) => content)
      .find(
        (content) =>
          typeof content === 'string' &&
          content.includes('ThreadingHTTPServer'),
      );
    const stagedServerText =
      typeof stagedServerScript === 'string' ? stagedServerScript : '';
    expect(result).toMatchObject({
      status: 0,
      background: true,
    });
    expect(serverLaunch?.args.at(-1)).toContain('/workspace/.sparkrun_static_server.py');
    expect(serverLaunch?.args.at(-1)).toContain('/tmp/sparkrun/server.log');
    expect(serverLaunch?.args.at(-1)).toContain('/tmp/sparkrun/server.launch.pid');
    expect(serverLaunch?.args.slice(0, 4)).toEqual([
      '-f',
      '-w',
      '/bin/bash',
      '-c',
    ]);
    expect(serverLaunch?.args.at(-1)).not.toContain('nohup');
    expect(mockState.serverLaunches).toBe(1);
    expect(cleanupCommand).toContain('/tmp/sparkrun/server.pid');
    expect(cleanupCommand).toContain('/tmp/sparkrun/server.launch.pid');
    expect(cleanupCommand).toContain('[.]sparkrun_static_server.py');
    expect(cleanupCommand).toContain('ps -eo pid,args');
    expect(cleanupCommand).toContain('kill -TERM -- "-$1"');
    expect(cleanupCommand).toContain('kill -KILL -- "-$1"');
    expect(cleanupCommand).not.toContain('pkill');
    expect(cleanupCommand).not.toContain('& &&');
    expect(stagedServerScript).not.toContain('Cross-Origin-Embedder-Policy');
    expect(stagedServerScript).toContain('Access-Control-Allow-Origin');
    expect(stagedServerScript).toContain('cross-origin');
    expect(stagedServerScript).toContain('ready_file.write("SPARKRUN_BOUND")');
    expect(stagedServerScript).not.toContain('HTTPConnection');
    expect(stagedServerText.indexOf('with open(PORT_PATH')).toBeLessThan(
      stagedServerText.indexOf('server.serve_forever()'),
    );
    expect(statuses).toContain('booting');
  });

  it('captures server handshake commands from a non-default virtual terminal', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    // CheerpX may assign the port poller a non-default VT.
    mockState.consoleVt = 2;
    const result = await backend.startServer();

    expect(result.status).toBe(0);
    expect(backend.getServerPort()).toBe(SERVER_PORT + 1);
  });

  it('does not launch a second interpreter or loopback probe after the static server binds', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({
      diskProfile: WEBVM_CODING_CANDIDATE_PROFILE,
    });
    const result = await backend.startServer();
    const serverLaunchIndex = mockState.runCalls.findIndex(
      (call) =>
        call.fileName === '/usr/bin/setsid' &&
        call.args.at(-1)?.includes('.sparkrun_static_server.py'),
    );
    const postLaunchCalls = mockState.runCalls.slice(serverLaunchIndex + 1);

    expect(result).toMatchObject({ status: 0, background: true });
    expect(result.output).toContain('bound port');
    expect(postLaunchCalls.some((call) =>
      call.args.at(-1)?.includes('http.client.HTTPConnection'),
    )).toBe(false);
    expect(postLaunchCalls.some((call) =>
      call.args.at(-1)?.includes('SPARKRUN_HTTP_%{http_code}'),
    )).toBe(false);
    expect(backend.isDisposed()).toBe(false);
    expect(mockState.cx?.delete).not.toHaveBeenCalled();

    mockState.commandOutputs.set('echo runner-ok', 'runner-ok\n');
    await expect(backend.runCommand('echo runner-ok')).resolves.toMatchObject({
      status: 0,
      output: 'runner-ok',
    });
  });

  it('does not poison the command runner when a short server port probe times out', async () => {
    mockState.emitEarlyIp = true;
    mockState.serverPortProbeTimeoutsRemaining = 1;
    const backend = await WebVmBackend.create({});

    const result = await backend.startServer();
    mockState.commandOutputs.set('echo runner-ok', 'runner-ok\n');
    const followUp = await backend.runCommand('echo runner-ok', {
      cwd: SITE_ROOT,
    });

    expect(result.status).toBe(0);
    expect(backend.getServerPort()).toBe(SERVER_PORT + 1);
    expect(followUp).toMatchObject({ status: 0, output: 'runner-ok' });
  });

  it('reports an attached server process that exits before writing its port', async () => {
    mockState.emitEarlyIp = true;
    mockState.serverLaunchExitStatus = 7;
    const backend = await WebVmBackend.create({});

    const result = await backend.startServer();

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/Server process exited.*status 7\./);
    expect(backend.getServerPort()).toBeNull();
  });

  it('rejects a managed preview that exits zero before answering HTTP', async () => {
    mockState.emitEarlyIp = true;
    mockState.serverLaunchExitStatus = 0;
    const backend = await WebVmBackend.create({});

    const result = await backend.startPreview({
      command: 'npm run dev',
      port: 5173,
      cwd: SITE_ROOT,
    });

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/exited before readiness with status 0/i);
    expect(backend.getPreviewUrl()).toBeNull();
    expect(
      mockState.runCalls.some((call) =>
        call.args.at(-1)?.includes(
          `> '/tmp/sparkrun/server.ready'`,
        ),
      ),
    ).toBe(false);
  });

  it('does not resurrect a managed preview that exits between HTTP health and readiness persistence', async () => {
    mockState.emitEarlyIp = true;
    mockState.pauseReadinessCommand = true;
    const statuses: string[] = [];
    const backend = await WebVmBackend.create({
      onStatus: (status) => statuses.push(status.message),
    });

    const pending = backend.startPreview({
      command: 'npm run dev',
      port: 5173,
      cwd: SITE_ROOT,
    });
    await vi.waitFor(() => expect(mockState.readinessCommandStarted).toBe(true));
    mockState.serverLaunchResolve?.({ status: 0 });
    await vi.waitFor(() =>
      expect(statuses.some((message) => message.includes('exited before readiness'))).toBe(
        true,
      ),
    );
    mockState.releaseReadinessCommand?.();

    const result = await pending;
    expect(result.status).toBe(1);
    expect(result.output).toContain('exited before readiness with status 0');
    expect(backend.getPreviewUrl()).toBeNull();
    expect(statuses.at(-1)).not.toContain('running on port');
  });

  it('does not resurrect the static preview when its process exits after the port poll', async () => {
    mockState.emitEarlyIp = true;
    mockState.pauseServerLogRead = true;
    const backend = await WebVmBackend.create({});

    const pending = backend.startServer();
    await vi.waitFor(() => expect(mockState.serverLogReadStarted).toBe(true));
    mockState.serverLaunchResolve?.({ status: 0 });
    await vi.waitFor(() => expect(backend.getServerPort()).toBeNull());
    mockState.releaseServerLogRead?.();

    const result = await pending;
    expect(result.status).toBe(1);
    expect(result.output).toContain('exited before readiness with status 0');
    expect(backend.getPreviewUrl()).toBeNull();
  });

  it('does not mark a preview live when disposal wins during final readiness', async () => {
    mockState.emitEarlyIp = true;
    mockState.pauseReadinessCommand = true;
    const backend = await WebVmBackend.create({});

    const pending = backend.startPreview({
      command: 'npm run dev',
      port: 5173,
      cwd: SITE_ROOT,
    });
    await vi.waitFor(() => expect(mockState.readinessCommandStarted).toBe(true));
    await backend.dispose();
    mockState.releaseReadinessCommand?.();

    const result = await pending;
    expect(result.status).not.toBe(0);
    expect(backend.getPreviewUrl()).toBeNull();
    expect(backend.getServerPort()).toBeNull();
  });

  it('does not mark a preview live when the fatal network latch wins during final readiness', async () => {
    mockState.emitEarlyIp = true;
    mockState.pauseReadinessCommand = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const backend = await WebVmBackend.create({});
      const pending = backend.startPreview({
        command: 'npm run dev',
        port: 5173,
        cwd: SITE_ROOT,
      });
      await vi.waitFor(() => expect(mockState.readinessCommandStarted).toBe(true));

      dispatchFatalNetworkError();
      mockState.releaseReadinessCommand?.();

      await expect(pending).rejects.toMatchObject({
        name: 'CheerpXNetworkReloadRequiredError',
      });
      expect(backend.getPreviewUrl()).toBeNull();
      expect(backend.getServerPort()).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('publishes a non-live status when a healthy preview exits asynchronously', async () => {
    mockState.emitEarlyIp = true;
    const statuses: Array<{ lifecycle: string; previewUrl?: string | null }> = [];
    const backend = await WebVmBackend.create({
      onStatus: (status) => statuses.push(status),
    });
    await backend.startServer();
    expect(backend.getPreviewUrl()).toContain('100.64.0.10');

    mockState.serverLaunchResolve?.({ status: 13 });
    await vi.waitFor(() => expect(backend.getPreviewUrl()).toBeNull());

    expect(statuses.at(-1)).toMatchObject({ lifecycle: 'error', previewUrl: null });
  });

  it('rejects a managed preview process that never accepts HTTP', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});
    mockState.httpHealthy = false;
    vi.useFakeTimers();
    try {
      const pending = backend.startPreview({
        command: 'sleep 100',
        port: 4173,
        cwd: SITE_ROOT,
      });
      await vi.advanceTimersByTimeAsync(46_000);
      const result = await pending;

      expect(result.status).toBe(1);
      expect(result.output).toContain('did not accept HTTP connections');
      expect(backend.getServerPort()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a managed preview and its TERM-ignoring descendants as a process group', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    const started = await backend.startPreview({
      command: `trap '' TERM; sh -c 'trap "" TERM; sleep 100' & wait`,
      port: 4173,
      cwd: SITE_ROOT,
    });
    const stopped = await backend.stopServer();

    expect(started.status).toBe(0);
    expect(stopped.status).toBe(0);
    const launch = mockState.runCalls.find(
      (call) => call.fileName === '/usr/bin/setsid',
    );
    expect(launch?.args.slice(0, 4)).toEqual([
      '-f',
      '-w',
      '/bin/bash',
      '-c',
    ]);
    expect(launch?.args.at(-1)).toContain('/tmp/sparkrun/server.launch.pid');
    const cleanup = mockState.runCalls.at(-1)?.args.at(-1) ?? '';
    expect(cleanup).toContain('sparkrun_term_group "$sparkrun_group"');
    expect(cleanup).toContain('kill -TERM -- "-$1"');
    expect(cleanup).toContain('sleep 1');
    expect(cleanup).toContain('sparkrun_kill_group "$sparkrun_group"');
    expect(cleanup).toContain('kill -KILL -- "-$1"');
  });

  it('does not relaunch the VM web server before the health check runs', async () => {
    mockState.emitEarlyIp = true;
    const backend = await WebVmBackend.create({});

    await backend.startServer();
    const runCallsAfterFirstStart = mockState.runCalls.length;

    const secondStart = await backend.startServer();

    expect(secondStart).toMatchObject({
      status: 0,
      background: true,
    });
    expect(secondStart.output).toBe(
      `Server is already running on port ${SERVER_PORT + 1}.`,
    );
    const cachedStartCalls = mockState.runCalls.slice(runCallsAfterFirstStart);
    expect(cachedStartCalls).toHaveLength(1);
    expect(cachedStartCalls[0]?.args.at(-1)).toContain('kill -0');
    expect(mockState.serverLaunches).toBe(1);
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
    expect(backend.getPreviewUrl()).toBeNull();
    await backend.startServer();
    expect(backend.getPreviewUrl()).toBe(`http://100.64.0.20:${SERVER_PORT + 1}/`);
  });

  it('coalesces overlapping Tailnet callers without replacing their waiter', async () => {
    const backend = await WebVmBackend.create({});

    const first = backend.connectTailnet({ timeoutMs: 2_000 });
    const second = backend.connectTailnet({ timeoutMs: 2_000, forceLogin: true });
    expect(mockState.cx?.networkLogin).toHaveBeenCalledTimes(1);

    mockState.networkInterface?.loginUrlCb?.('https://login.tailscale.com/a/shared');

    await expect(first).resolves.toBe('https://login.tailscale.com/a/shared');
    await expect(second).resolves.toBe('https://login.tailscale.com/a/shared');
    expect(mockState.cx?.networkLogin).toHaveBeenCalledTimes(1);
  });

  it('releases a timed-out Tailnet waiter while retaining a late login URL', async () => {
    const backend = await WebVmBackend.create({});

    await expect(backend.connectTailnet({ timeoutMs: 0 })).resolves.toBeNull();
    mockState.networkInterface?.loginUrlCb?.('https://login.tailscale.com/a/late');

    await expect(backend.connectTailnet()).resolves.toBe(
      'https://login.tailscale.com/a/late',
    );
    expect(mockState.cx?.networkLogin).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe Tailscale login URLs without caching or exposing them', async () => {
    const debug: string[] = [];
    const backend = await WebVmBackend.create({
      onDebug: (entry) => debug.push(entry.output ?? ''),
    });
    const unsafeUrls = [
      'http://login.tailscale.com/a/insecure',
      'https://user:password@login.tailscale.com/a/credentials',
      'https://login.tailscale.com/a/fragment#secret',
      'https://login.tailscale.com.evil.example/a/lookalike',
      'https://login.tailscale.com:8443/a/custom-port',
      'javascript:alert(1)',
    ];

    for (const unsafeUrl of unsafeUrls) {
      const pending = backend.connectTailnet({ timeoutMs: 2_000 });
      mockState.networkInterface?.loginUrlCb?.(unsafeUrl);
      await expect(pending).resolves.toBeNull();
    }

    expect(debug.join('\n')).not.toContain('user:password');
    expect(debug.join('\n')).not.toContain('evil.example');

    const valid = backend.connectTailnet({ timeoutMs: 2_000 });
    mockState.networkInterface?.loginUrlCb?.(
      'https://login.tailscale.com/a/safe?next=console',
    );
    await expect(valid).resolves.toBe(
      'https://login.tailscale.com/a/safe?next=console',
    );
  });

  it('rejects an active Tailnet connection immediately when window error reports a poisoned IP stack', async () => {
    const statuses: string[] = [];
    const debug: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const backend = await WebVmBackend.create({
        tailscaleAuthKey: 'tskey-auth-test',
        onStatus: (status) => statuses.push(status.message),
        onDebug: (entry) => debug.push(entry.output ?? ''),
      });
      const pending = backend.connectTailnet({ timeoutMs: 60_000 });

      dispatchFatalNetworkError();

      await expect(pending).rejects.toMatchObject({
        name: 'CheerpXNetworkReloadRequiredError',
      });
      expect(mockState.cx?.networkLogin).toHaveBeenCalledTimes(1);
      expect(statuses).toContain('Network runtime crashed — reload required');
      expect(statuses.join('\n')).not.toContain('auth key rejected');
      expect(debug.join('\n')).not.toContain('almost certainly rejected');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('hides a stale live preview after a fatal network fault and rejects reconnect', async () => {
    mockState.emitEarlyIp = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const backend = await WebVmBackend.create({});
      await backend.startServer();
      expect(backend.getTailnetIp()).toBe('100.64.0.10');
      expect(backend.getPreviewUrl()).toBe(
        `http://100.64.0.10:${SERVER_PORT + 1}/`,
      );

      dispatchFatalNetworkError(FATAL_TCP_BIND_ERROR);

      expect(backend.getTailnetIp()).toBeNull();
      expect(backend.getPreviewUrl()).toBeNull();
      await expect(backend.connectTailnet()).rejects.toMatchObject({
        name: 'CheerpXNetworkReloadRequiredError',
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores late Tailnet state and netmap callbacks after the fatal latch trips', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const backend = await WebVmBackend.create({});
      const networkInterface = mockState.networkInterface;

      dispatchFatalNetworkError();
      networkInterface?.stateUpdateCb?.(6);
      networkInterface?.netmapUpdateCb?.({
        self: { addresses: ['100.64.0.99'] },
      });

      expect(backend.getTailnetIp()).toBeNull();
      expect(backend.getPreviewUrl()).toBeNull();
      await expect(backend.connectTailnet()).rejects.toMatchObject({
        name: 'CheerpXNetworkReloadRequiredError',
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('runs no guest commands when a server, managed preview, or health check is requested after a fatal fault', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const backend = await WebVmBackend.create({});
      dispatchFatalNetworkError();
      const runCallsBefore = mockState.runCalls.length;

      await expect(backend.startServer()).rejects.toMatchObject({
        name: 'CheerpXNetworkReloadRequiredError',
      });
      await expect(
        backend.startPreview({
          command: 'npm run dev',
          port: 4173,
          cwd: SITE_ROOT,
        }),
      ).rejects.toMatchObject({ name: 'CheerpXNetworkReloadRequiredError' });
      await expect(backend.checkPreview()).rejects.toMatchObject({
        name: 'CheerpXNetworkReloadRequiredError',
      });
      expect(mockState.runCalls).toHaveLength(runCallsBefore);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('classifies a fatal networkLogin rejection instead of reporting an expired key', async () => {
    const statuses: string[] = [];
    const debug: string[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockState.cx?.networkLogin.mockRejectedValueOnce(
      new Error(FATAL_TCP_BIND_ERROR),
    );
    try {
      const backend = await WebVmBackend.create({
        tailscaleAuthKey: 'tskey-auth-test',
        onStatus: (status) => statuses.push(status.message),
        onDebug: (entry) => debug.push(entry.output ?? ''),
      });

      await expect(
        backend.connectTailnet({ timeoutMs: 60_000 }),
      ).rejects.toMatchObject({ name: 'CheerpXNetworkReloadRequiredError' });
      expect(backend.getFatalNetworkFailure()).toContain(
        'Reload the browser tab',
      );
      expect(statuses.join('\n')).not.toContain('auth key rejected');
      expect(debug.join('\n')).not.toContain('almost certainly rejected');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps the fatal page latch across dispose and blocks a second Linux.create', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await WebVmBackend.create({});
      expect(mockState.linuxCreateCalls).toBe(1);
      dispatchFatalNetworkError();
      await first.dispose();

      await expect(WebVmBackend.create({})).rejects.toMatchObject({
        name: 'CheerpXNetworkReloadRequiredError',
      });
      expect(mockState.linuxCreateCalls).toBe(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores late Tailnet callbacks and rejects reconnect after disposal', async () => {
    const backend = await WebVmBackend.create({});
    const networkInterface = mockState.networkInterface;
    await backend.dispose();

    networkInterface?.stateUpdateCb?.(6);
    networkInterface?.netmapUpdateCb?.({
      self: { addresses: ['100.64.0.99'] },
    });

    expect(backend.getHighestTailnetState()).toBeNull();
    expect(backend.getTailnetIp()).toBeNull();
    expect(backend.getPreviewUrl()).toBeNull();
    await expect(backend.connectTailnet()).rejects.toThrow('disposed');
    expect(mockState.cx?.networkLogin).not.toHaveBeenCalled();
  });
});
