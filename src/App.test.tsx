import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CodingHarnessRunOptions,
  CodingHarnessSession,
} from './lib/codingHarness';
import { DEFAULT_WEBVM_DISK_PROFILE, MODEL_ID } from './lib/constants';

const appMocks = vi.hoisted(() => ({
  acquireWorkspaceLease: vi.fn(),
  createBackend: vi.fn(),
  createHarness: vi.fn(),
  getVault: vi.fn(),
  hardReset: vi.fn(async (): Promise<void> => undefined),
  runHarness: vi.fn(),
  xtermReset: vi.fn(),
  xtermWrite: vi.fn(),
}));

vi.mock('./lib/webvm', () => ({
  WebVmBackend: {
    create: appMocks.createBackend,
  },
  validateTailscaleAuthKey: (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return 'Tailscale auth key is required.';
    return null;
  },
  validateGoogleApiKey: (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return 'Google AI Studio API key is required.';
    if (trimmed === 'abc') {
      return 'This does not look like a Google API key.';
    }
    return null;
  },
  CHEERPX_PINNED_VERSION: '1.3.9',
  SPARKRUN_BUILD_SHA: 'test',
  SPARKRUN_BUILD_TIME: 'test',
  detectCheerpxRuntimeVersion: () => null,
  getFatalTailnetRuntimeFailure: () => null,
  hardResetSparkrunCaches: appMocks.hardReset,
}));

vi.mock('./lib/geminiCodingHarness', () => ({
  GeminiInteractionsCodingHarness: class MockGeminiInteractionsCodingHarness {
    constructor(options: unknown) {
      appMocks.createHarness(options);
    }

    run(options: unknown) {
      return appMocks.runHarness(options);
    }
  },
}));

vi.mock('./lib/browserVault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/browserVault')>();
  return {
    ...actual,
    getBrowserVault: () => appMocks.getVault(),
  };
});

vi.mock('./lib/workspaceLease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/workspaceLease')>();
  return {
    ...actual,
    acquireWorkspaceLease: appMocks.acquireWorkspaceLease,
  };
});

// xterm itself is covered by browser E2E. The App unit tests only need the
// terminal bridge lifecycle; mocking the renderer avoids fake canvas and
// matchMedia behavior that jsdom does not implement.
vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
    }

    loadAddon() {}
    open() {}
    write(text: string, callback?: () => void) {
      appMocks.xtermWrite(text, callback);
    }
    reset() {
      appMocks.xtermReset();
    }
    dispose() {}
    onData() {
      return { dispose() {} };
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class MockSearchAddon {},
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

import App, { browserPageLifecycle } from './App';
import { BrowserVault } from './lib/browserVault';

let testVault: BrowserVault;

afterEach(() => {
  vi.unstubAllGlobals();
});

function installSuccessfulWorkspaceLeaseMock() {
  appMocks.acquireWorkspaceLease.mockImplementation(
    async (projectId: string) => {
      let released = false;
      return {
        projectId,
        lockName: `test-workspace-lock:${projectId}`,
        get released() {
          return released;
        },
        release: vi.fn(async () => {
          released = true;
        }),
      };
    },
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harnessSession(
  prompt: string,
  previousInteractionId = 'interaction-1',
  id = 'session-1',
): CodingHarnessSession {
  return {
    version: 1,
    id,
    provider: 'google-interactions',
    model: MODEL_ID,
    createdAt: '2026-08-27T12:00:00.000Z',
    updatedAt: '2026-08-27T12:00:01.000Z',
    previousInteractionId,
    transcript: [
      {
        id: `${id}-user`,
        createdAt: '2026-08-27T12:00:00.000Z',
        role: 'user',
        kind: 'message',
        content: prompt,
      },
      {
        id: `${id}-assistant`,
        createdAt: '2026-08-27T12:00:01.000Z',
        role: 'assistant',
        kind: 'message',
        content: 'Task complete.',
        interactionId: previousInteractionId,
      },
    ],
    providerState: { runtimeId: 'webvm-test' },
  };
}

async function completeHarnessRun(
  options: CodingHarnessRunOptions,
  result: {
    finalText?: string;
    changedFiles?: string[];
    session?: CodingHarnessSession;
  } = {},
) {
  const session =
    result.session ?? harnessSession(options.prompt, 'interaction-1');
  await options.onSession?.(session);
  return {
    finalText: result.finalText ?? 'Website generation finished.',
    changedFiles: result.changedFiles ?? ['index.html'],
    session,
    reachedTurnBudget: false,
  };
}

function fakeBackend(
  options: {
    files?: Array<[string, string]>;
    initialPreviewUrl?: string | null;
  } = {},
) {
  const files = new Map<string, string>(
    options.files ?? [
      ['index.html', '<h1>Hello</h1>'],
      ['assets/site.css', 'body { color: teal; }'],
    ],
  );
  let previewUrl = options.initialPreviewUrl ?? null;
  return {
    id: 'webvm-test',
    provider: 'test' as const,
    workspaceRoot: '/workspace/site',
    capabilities: {
      interactiveTerminal: true,
      managedPreview: true,
      privatePreview: true,
      workspaceArchive: true,
      hardDispose: true,
    },
    connectPrivateNetwork: vi.fn(
      async () => 'https://login.tailscale.com/a/abc',
    ),
    getPrivateNetworkAddress: vi.fn(() => '100.64.0.25'),
    getHighestTailnetState: vi.fn(() => 6),
    getPreviewUrl: vi.fn(() => previewUrl),
    isDisposed: vi.fn(() => false),
    getFatalNetworkFailure: vi.fn(() => null as string | null),
    listDirectory: vi.fn(async (path: string) => {
      const prefix = path ? `${path}/` : '';
      const entries = new Map<string, 'file' | 'directory'>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const remainder = filePath.slice(prefix.length);
        if (!remainder) continue;
        const [first, ...rest] = remainder.split('/');
        const entryPath = path ? `${path}/${first}` : first;
        const type = rest.length > 0 ? 'directory' : 'file';
        if (!entries.has(entryPath) || type === 'directory') {
          entries.set(entryPath, type);
        }
      }
      return [...entries].map(([entryPath, type]) => ({
        path: entryPath,
        type,
        ...(type === 'file'
          ? {
              sizeBytes: new TextEncoder().encode(
                files.get(entryPath) ?? '',
              ).byteLength,
            }
          : {}),
      }));
    }),
    readText: vi.fn(async (path: string) => files.get(path) ?? ''),
    writeText: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    createWorkspaceArchive: vi.fn(
      async () => new Blob([JSON.stringify([...files.entries()])]),
    ),
    restoreWorkspaceArchive: vi.fn(async () => undefined),
    resetWorkspace: vi.fn(async () => undefined),
    startDefaultPreview: vi.fn(async () => {
      previewUrl = 'http://100.64.0.25:8080/';
      return {
        status: 0,
        output: '4242',
        background: true,
      };
    }),
    startInteractiveShell: vi.fn(() => ({
      status: 0,
      output: 'Interactive shell started.',
      background: true,
    })),
    writeTerminalInput: vi.fn(() => ({
      status: 0,
      output: '',
      background: false,
    })),
    checkPreview: vi.fn(async () => ({
      status: 0,
      output: 'internal: server process is listening on port 8081',
      background: false,
    })),
    stopPreview: vi.fn(async () => ({
      status: 0,
      output: 'stopped',
      background: false,
    })),
    dispose: vi.fn(async () => undefined),
    runCommand: vi.fn(async (command: string) => ({
      status: 0,
      output: command === 'pwd' ? '/workspace/site' : 'ok',
      background: false,
    })),
  };
}

interface FakeSourceDirectory {
  name: string;
  files: Map<string, string | Uint8Array>;
  directories: Map<string, FakeSourceDirectory>;
  queryPermission: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  getDirectoryHandle: ReturnType<typeof vi.fn>;
  getFileHandle: ReturnType<typeof vi.fn>;
}

function fakeSourceDirectory(name = 'source'): FakeSourceDirectory {
  const files = new Map<string, string | Uint8Array>();
  const directories = new Map<string, FakeSourceDirectory>();
  const directory: FakeSourceDirectory = {
    name,
    files,
    directories,
    queryPermission: vi.fn(async () => 'granted' as PermissionState),
    requestPermission: vi.fn(async () => 'granted' as PermissionState),
    getDirectoryHandle: vi.fn(async (childName: string) => {
      let child = directories.get(childName);
      if (!child) {
        child = fakeSourceDirectory(childName);
        directories.set(childName, child);
      }
      return child as unknown as FileSystemDirectoryHandle;
    }),
    getFileHandle: vi.fn(async (fileName: string) => ({
      kind: 'file' as const,
      name: fileName,
      createWritable: async () => ({
        write: async (content: string | Uint8Array) => {
          files.set(fileName, content);
        },
        close: async () => undefined,
      }),
    })),
  };
  return directory;
}

function gotoChat() {
  const keyInput = screen.queryByLabelText(/Google AI key/i);
  if (keyInput && !(keyInput as HTMLInputElement).value) {
    fireEvent.change(keyInput, { target: { value: 'test-api-key' } });
  }
  fireEvent.click(
    screen.getByRole('button', { name: /Continue|Back to project/i }),
  );
}

async function waitForManagedRunToFinish() {
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /^Stop$/i }),
    ).not.toBeInTheDocument(),
  );
}

describe('SparkRun setup screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installSuccessfulWorkspaceLeaseMock();
    testVault = new BrowserVault(
      `sparkrun-app-test-${crypto.randomUUID()}`,
    );
    appMocks.getVault.mockReturnValue(testVault);
    window.localStorage.clear();
    vi.stubGlobal('open', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 })),
    );
    appMocks.runHarness.mockImplementation(completeHarnessRun);
    appMocks.xtermWrite.mockImplementation(
      (_text: string, callback?: () => void) => callback?.(),
    );
  });

  it('renders the setup screen with the dev-key warning and password fields', () => {
    render(<App />);

    expect(
      screen.getByText(/keys stay in browser memory unless/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Google AI key/i)).toHaveAttribute(
      'type',
      'password',
    );
    expect(screen.getByLabelText(/Tailscale auth key/i)).toHaveAttribute(
      'type',
      'password',
    );
    expect(
      screen.getByLabelText(/Remember keys on this browser/i),
    ).not.toBeChecked();
    expect(document.getElementById('setup-google-key-status')).toHaveTextContent(
      'No key entered.',
    );
    expect(document.getElementById('setup-tail-key-status')).toHaveTextContent(
      'No key entered.',
    );
    expect(screen.getByText('3.7 Flash')).toBeInTheDocument();
    expect(screen.getByText(/Only model enabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/gemini-3-pro/i)).not.toBeInTheDocument();
  });

  it('saves and reloads keys only when browser saving is enabled', () => {
    const { unmount } = render(<App />);

    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'saved-google-key' },
    });
    fireEvent.change(screen.getByLabelText(/Tailscale auth key/i), {
      target: { value: 'saved-tailnet-key' },
    });
    expect(window.localStorage.length).toBe(0);

    fireEvent.click(screen.getByLabelText(/Remember keys on this browser/i));
    expect(window.localStorage.getItem('sparkrun.savedKeys.v1')).toContain(
      'saved-google-key',
    );
    expect(window.localStorage.getItem('sparkrun.savedKeys.v1')).toContain(
      'saved-tailnet-key',
    );

    unmount();
    render(<App />);
    expect(screen.getByLabelText(/Google AI key/i)).toHaveValue('saved-google-key');
    expect(screen.getByLabelText(/Tailscale auth key/i)).toHaveValue(
      'saved-tailnet-key',
    );
    expect(
      screen.getByLabelText(/Remember keys on this browser/i),
    ).toBeChecked();

    fireEvent.click(screen.getByLabelText(/Remember keys on this browser/i));
    expect(window.localStorage.getItem('sparkrun.savedKeys.v1')).toBeNull();
  });

  it('saves and reloads projects exclusively through BrowserVault', async () => {
    const { unmount } = render(<App />);

    fireEvent.change(screen.getByLabelText(/Project name/i), {
      target: { value: 'Hello app' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Project/i }));

    await waitFor(async () =>
      expect((await testVault.listProjects())[0]?.name).toBe('Hello app'),
    );
    expect(window.localStorage.getItem('sparkrun.projects.v1')).toBeNull();

    unmount();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hello app' }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue('Hello app'),
    );
  });

  it('keeps the last project selection when an earlier transition finishes late', async () => {
    const first = await testVault.createProject({
      id: 'first-selection',
      name: 'First selection',
      prompt: 'First',
    });
    const last = await testVault.createProject({
      id: 'last-selection',
      name: 'Last selection',
      prompt: 'Last',
    });
    const activateProject = testVault.activateProject.bind(testVault);
    let releaseFirst: () => void = () => undefined;
    vi.spyOn(testVault, 'activateProject').mockImplementation((projectId) => {
      if (projectId !== first.id) {
        return activateProject(projectId);
      }
      return new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /^Project name$/i })).toHaveValue(
        last.name,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: first.name }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /^Project name$/i })).toHaveValue(
        first.name,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: last.name }));
    releaseFirst();

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /^Project name$/i })).toHaveValue(
        last.name,
      ),
    );
  });

  it('does not let delayed startup hydration overwrite an intentional build choice', async () => {
    await testVault.createProject({
      id: 'stale-startup-project',
      name: 'Stale startup project',
      prompt: 'This stale prompt must not run.',
    });
    const listProjects = testVault.listProjects.bind(testVault);
    const staleProjects = await listProjects();
    const hydrationGate = deferred();
    const listSpy = vi
      .spyOn(testVault, 'listProjects')
      .mockImplementationOnce(async () => {
        await hydrationGate.promise;
        return staleProjects;
      })
      .mockImplementation(listProjects);
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox', { name: /^Project name$/i }), {
      target: { value: 'User choice project' },
    });
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: 'Run the user-selected build.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    hydrationGate.resolve(undefined);
    await waitForManagedRunToFinish();

    expect(appMocks.runHarness).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Run the user-selected build.' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'User choice project' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Stale startup project' }),
    ).not.toBeInTheDocument();
  });

  it('does not import the removed localStorage project format', async () => {
    window.localStorage.setItem(
      'sparkrun.projects.v1',
      JSON.stringify([{ id: 'legacy', name: 'Legacy project' }]),
    );

    render(<App />);

    expect(screen.queryByText('Legacy project')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Project name/i)).toHaveValue('Untitled site');
    await waitFor(async () => expect(await testVault.listProjects()).toEqual([]));
  });

  it('falls back to "Untitled site" when the project name is cleared', () => {
    render(<App />);

    const input = screen.getByLabelText(/Project name/i);
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');

    fireEvent.blur(input);
    expect(input).toHaveValue('Untitled site');
  });

  it('resets the exact active project workspace and environment databases', async () => {
    const project = await testVault.createProject({
      id: 'reset-target',
      name: 'Reset target',
      prompt: 'Build it',
    });
    appMocks.hardReset.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue('Reset target'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset workspace' }));

    await waitFor(() =>
      expect(appMocks.hardReset).toHaveBeenCalledWith({
        includeDiskCache: false,
        workspaceDbName: project.workspaceDbName,
        rootCacheDbName:
          'sparkrun-env-v2-default-web-cheerpx-1.3.9-webvm-buster-2026-06-01',
      }),
    );
  });

  it('resumes a completed onboarding directly when a saved key and project are usable', async () => {
    await testVault.createProject({
      id: 'resume-project',
      name: 'Resume project',
      prompt: 'Continue the saved work',
    });
    const view = render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue('Resume project'),
    );
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'saved-google-key' },
    });
    fireEvent.click(screen.getByLabelText(/Remember keys on this browser/i));
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Coding request/i)).toBeInTheDocument(),
    );
    await waitFor(async () =>
      expect(await testVault.getSetting('onboarding-complete-v1')).toBe(true),
    );

    view.unmount();
    render(<App />);

    expect(await screen.findByLabelText(/Coding request/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Google AI key/i)).not.toBeInTheDocument();
  });

  it('hydrates the active conversation before an automatic resume without booting', async () => {
    const project = await testVault.createProject({
      id: 'hydrated-project',
      name: 'Hydrated project',
      prompt: 'Continue',
    });
    const conversation = await testVault.createConversation({
      projectId: project.id,
      title: 'Saved conversation',
      model: MODEL_ID,
    });
    await testVault.appendConversationEvent({
      conversationId: conversation.id,
      role: 'assistant',
      kind: 'thought',
      payload: {
        id: 41,
        kind: 'thought',
        text: 'Restored activity is ready.',
        time: '09:30:00',
      },
    });
    await testVault.putSetting('onboarding-complete-v1', true);
    window.localStorage.setItem(
      'sparkrun.savedKeys.v1',
      JSON.stringify({ apiKey: 'saved-google-key', tailscaleAuthKey: '' }),
    );

    render(<App />);

    expect(await screen.findByText('Restored activity is ready.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Saved conversation/i }),
    ).toHaveAttribute('aria-current', 'page');
    expect(appMocks.createBackend).not.toHaveBeenCalled();
    expect(await testVault.db.conversations.count()).toBe(1);
  });

  it('does not auto-resume before onboarding is completed', async () => {
    await testVault.createProject({
      id: 'not-onboarded-project',
      name: 'Not onboarded',
      prompt: 'Wait at setup',
    });
    window.localStorage.setItem(
      'sparkrun.savedKeys.v1',
      JSON.stringify({ apiKey: 'saved-google-key', tailscaleAuthKey: '' }),
    );

    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'Not onboarded',
      ),
    );
    expect(screen.queryByLabelText(/Coding request/i)).not.toBeInTheDocument();
  });

  it('shows compact reconnect settings but never traps a returning user there', async () => {
    await testVault.createProject({
      id: 'reconnect-project',
      name: 'Reconnect project',
      prompt: 'Resume later',
    });
    await testVault.putSetting('onboarding-complete-v1', true);

    render(<App />);

    expect(await screen.findByText(/Workspace settings/i)).toBeInTheDocument();
    const backButton = screen.getByRole('button', { name: /Back to project/i });
    expect(backButton).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: /^Project name$/i }), {
      target: { value: '' },
    });
    expect(backButton).toBeEnabled();
    fireEvent.click(backButton);
    expect(screen.getByLabelText(/Coding request/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    expect(
      await screen.findByText(/Google AI key is required before building/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Setup/i }));
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Back to project/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    expect(
      await screen.findByText(/does not look like a Google API key/i),
    ).toBeInTheDocument();
    expect(appMocks.createBackend).not.toHaveBeenCalled();
    expect(appMocks.createHarness).not.toHaveBeenCalled();
  });
});

describe('SparkRun chat screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installSuccessfulWorkspaceLeaseMock();
    testVault = new BrowserVault(
      `sparkrun-app-test-${crypto.randomUUID()}`,
    );
    appMocks.getVault.mockReturnValue(testVault);
    window.localStorage.clear();
    vi.stubGlobal('open', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    appMocks.runHarness.mockImplementation(completeHarnessRun);
    appMocks.xtermWrite.mockImplementation(
      (_text: string, callback?: () => void) => callback?.(),
    );
  });

  it('exposes the configured model in the composer', () => {
    render(<App />);
    gotoChat();
    const modelSelect = screen.getByRole('combobox', { name: /Coding model/i });
    expect(modelSelect).toHaveValue(MODEL_ID);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveTextContent('Gemini 3.7 Flash');
    modelSelect.focus();
    fireEvent.keyDown(modelSelect, { key: 'ArrowDown' });
    expect(modelSelect).toHaveFocus();
    const codingRequest = screen.getByLabelText(/Coding request/i);
    expect(codingRequest).not.toHaveAttribute('aria-label');
    expect(codingRequest).toHaveAttribute(
      'placeholder',
      'Describe what to build, debug, inspect, or run…',
    );
    expect(
      screen.getByText(/⌘\/Ctrl \+ Enter to send/i),
    ).toBeInTheDocument();
  });

  it('toggles both side panels and supports keyboard workspace tabs', async () => {
    render(<App />);
    gotoChat();

    const railToggle = screen.getByRole('button', {
      name: /Collapse project rail/i,
    });
    expect(railToggle).toHaveAttribute('aria-expanded', 'true');
    expect(railToggle).toHaveAttribute('aria-controls', 'workbench-navigation');
    fireEvent.click(railToggle);
    expect(
      screen.getByRole('button', { name: /Expand project rail/i }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('complementary', { name: /Workspace navigation/i })).not.toBeInTheDocument();

    const inspectorToggle = screen.getByRole('button', {
      name: /Collapse inspector/i,
    });
    expect(inspectorToggle).toHaveAttribute('aria-expanded', 'true');
    expect(inspectorToggle).toHaveAttribute('aria-controls', 'workspace-inspector');
    fireEvent.click(inspectorToggle);
    expect(
      screen.getByRole('button', { name: /Expand inspector/i }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('complementary', { name: /Environment inspector/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Expand inspector/i }));
    const previewTab = screen.getByRole('tab', { name: /Preview/i });
    previewTab.focus();
    fireEvent.keyDown(previewTab, { key: 'ArrowRight' });
    const filesTab = screen.getByRole('tab', { name: /Files/i });
    expect(filesTab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(filesTab).toHaveFocus());
    expect(document.getElementById('workspace-files')).toBeInTheDocument();
    expect(document.getElementById('workspace-preview')).toBeInTheDocument();
  });

  it('keeps narrow-screen workspace panels modal and restores focus', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    );

    render(<App />);
    gotoChat();

    const railOpener = screen.getByRole('button', {
      name: /Expand project rail/i,
    });
    railOpener.focus();
    fireEvent.click(railOpener);
    const railDialog = screen.getByRole('dialog', {
      name: /Workspace navigation/i,
    });
    expect(railDialog).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('.workbench-main')).toHaveAttribute('inert');
    expect(document.querySelector('.appbar')).toHaveAttribute('inert');
    expect(railOpener).toHaveAttribute('inert');
    expect(document.querySelector('.workspace-panel-scrim.rail')).toHaveAttribute(
      'tabindex',
      '-1',
    );
    await waitFor(() =>
      expect(
        document.querySelector('.rail-mobile-close'),
      ).toHaveFocus(),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: /Workspace navigation/i }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(railOpener).toHaveFocus());

    const inspectorOpener = screen.getByRole('button', {
      name: /Expand inspector/i,
    });
    inspectorOpener.focus();
    fireEvent.click(inspectorOpener);
    const inspectorDialog = screen.getByRole('dialog', {
      name: /Environment inspector/i,
    });
    expect(inspectorDialog).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('.agent-pane')).toHaveAttribute('inert');
    expect(document.querySelector('.workspace-panel-scrim.inspector')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: /Environment inspector/i }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(inspectorOpener).toHaveFocus());

    fireEvent.click(inspectorOpener);
    fireEvent.click(screen.getByRole('tab', { name: /Files/i }));
    fireEvent.click(screen.getByRole('button', { name: /Expand files/i }));
    expect(
      screen.queryByRole('dialog', { name: /Environment inspector/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: /Workspace files/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not create conversation history until the first request is sent', async () => {
    render(<App />);
    gotoChat();

    expect(
      screen.getByRole('button', { name: /Start a conversation/i }),
    ).toBeInTheDocument();
    expect(await testVault.db.conversations.count()).toBe(0);
  });

  it('coalesces rapid Build clicks while conversation creation is pending', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    const conversationGate = deferred();
    const createConversation = testVault.getOrCreateActiveConversation.bind(
      testVault,
    );
    const conversationSpy = vi
      .spyOn(testVault, 'getOrCreateActiveConversation')
      .mockImplementation(async (input) => {
        await conversationGate.promise;
        return createConversation(input);
      });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    const buildButton = screen.getByRole('button', { name: /^Build$/i });
    fireEvent.click(buildButton);
    fireEvent.click(buildButton);

    await waitFor(() => expect(conversationSpy).toHaveBeenCalledTimes(1));
    expect(appMocks.acquireWorkspaceLease).not.toHaveBeenCalled();
    expect(appMocks.createBackend).not.toHaveBeenCalled();
    expect(appMocks.runHarness).not.toHaveBeenCalled();

    conversationGate.resolve(undefined);
    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    await waitForManagedRunToFinish();

    expect(appMocks.acquireWorkspaceLease).toHaveBeenCalledTimes(1);
    expect(appMocks.createBackend).toHaveBeenCalledTimes(1);
    expect(appMocks.createHarness).toHaveBeenCalledTimes(1);
    expect(await testVault.db.conversations.count()).toBe(1);
  });

  it('blocks workbench entry until a Google AI key is present', () => {
    render(<App />);
    const continueButton = screen.getByRole('button', { name: /^Continue$/i });
    expect(continueButton).toBeDisabled();
    expect(
      screen.getByText(/project name and a format-valid Google AI key/i),
    ).toBeInTheDocument();
    expect(appMocks.createBackend).not.toHaveBeenCalled();
    expect(appMocks.createHarness).not.toHaveBeenCalled();
    expect(appMocks.runHarness).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    expect(continueButton).toBeEnabled();
  });

  it('restores the active project terminal scrollback from BrowserVault', async () => {
    const project = await testVault.createProject({
      name: 'Terminal project',
      prompt: 'Inspect it',
    });
    await testVault.saveTerminalSession({
      id: `terminal-${project.id}`,
      projectId: project.id,
      title: 'Main terminal',
      cwd: '/workspace/site',
      commandHistory: ['pwd'],
      scrollback: '/workspace/site\nready',
      updatedAt: '2026-08-27T12:00:00.000Z',
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'Terminal project',
      ),
    );
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));

    expect(await screen.findByText(/2 lines/i)).toBeInTheDocument();
  });

  it('flushes terminal scrollback and cancels project timers before a project transition', async () => {
    const backend = fakeBackend();
    let emitConsole: ((text: string) => void) | undefined;
    appMocks.createBackend.mockImplementation(async (options) => {
      emitConsole = options.onConsole;
      options.onDebug?.({
        phase: 'exec',
        command: 'transition-debug-marker',
        cwd: '/workspace/site',
        output: 'debug output',
        status: 0,
      });
      return backend;
    });
    backend.writeTerminalInput.mockImplementation(() => {
      emitConsole?.('latest-transition-output\n');
      return { status: 0, output: '', background: false };
    });
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    const view = render(<App />);
    fireEvent.change(screen.getByLabelText(/Project name/i), {
      target: { value: 'Persisted terminal project' },
    });
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));
    fireEvent.change(screen.getByLabelText(/VM command/i), {
      target: { value: 'pwd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    await waitFor(() =>
      expect(view.container.querySelector('.term-head-meta')).toHaveTextContent(
        '2 lines',
      ),
    );
    const checkpointTimerIndex = timeoutSpy.mock.calls.findIndex(
      ([, delay]) => delay === 2_500,
    );
    expect(checkpointTimerIndex).toBeGreaterThanOrEqual(0);
    const checkpointTimerId = timeoutSpy.mock.results[checkpointTimerIndex]
      ?.value as number;

    fireEvent.click(screen.getByRole('button', { name: /New project/i }));
    await waitFor(() => expect(backend.dispose).toHaveBeenCalled());
    await waitFor(async () => {
      const [project] = (await testVault.listProjects()).filter(
        (candidate) => candidate.name === 'Persisted terminal project',
      );
      const [session] = await testVault.listTerminalSessions(project!.id);
      expect(session?.scrollback).toContain('latest-transition-output');
      expect(session?.commandHistory).toContain('pwd');
    });
    expect(clearTimeoutSpy).toHaveBeenCalledWith(checkpointTimerId);

    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }));
    expect(screen.queryByText(/transition-debug-marker/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close logs/i }));

    fireEvent.click(
      screen.getByRole('button', { name: 'Persisted terminal project' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Persisted terminal project' }),
      ).toHaveAttribute('aria-current', 'page'),
    );
    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));
    expect(await screen.findByText(/2 lines/i)).toBeInTheDocument();

    timeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('keeps the current project UI intact when its required transition checkpoint fails', async () => {
    const currentProject = await testVault.createProject({
      name: 'Checkpoint guarded project',
      prompt: 'Keep this project visible.',
    });
    await testVault.activateProject(currentProject.id);
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async (options) => {
      options.onDebug?.({
        phase: 'exec',
        command: 'guarded-transition-marker',
        status: 0,
      });
      return backend;
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'Checkpoint guarded project',
      ),
    );
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();
    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }));
    expect(screen.getByRole('dialog', { name: /Diagnostics log/i })).toHaveTextContent(
      'guarded-transition-marker',
    );

    backend.createWorkspaceArchive.mockClear();
    backend.dispose.mockClear();
    backend.createWorkspaceArchive.mockRejectedValueOnce(
      new Error('checkpoint transition failed'),
    );
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));

    await screen.findByText(/checkpoint transition failed/i);
    expect(
      screen.getByRole('button', { name: 'Checkpoint guarded project' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('dialog', { name: /Diagnostics log/i })).toHaveTextContent(
      'guarded-transition-marker',
    );
    expect(backend.dispose).not.toHaveBeenCalled();
  });

  it('generation-fences New project against an older in-flight project selection', async () => {
    const currentProject = await testVault.createProject({
      name: 'Current generation',
      prompt: 'Current project.',
    });
    const targetProject = await testVault.createProject({
      name: 'Stale selected project',
      prompt: 'This selection should become stale.',
    });
    await testVault.activateProject(currentProject.id);
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'Current generation',
      ),
    );
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    const firstTransitionArchive = deferred<Blob>();
    backend.createWorkspaceArchive.mockClear();
    backend.createWorkspaceArchive
      .mockImplementationOnce(() => firstTransitionArchive.promise)
      .mockResolvedValue(new Blob(['new-project-checkpoint']));
    fireEvent.click(
      screen.getByRole('button', { name: targetProject.name }),
    );
    await waitFor(() =>
      expect(backend.createWorkspaceArchive).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole('button', { name: /New project/i }));
    firstTransitionArchive.resolve(new Blob(['stale-selection-checkpoint']));

    await waitFor(() =>
      expect(document.querySelector('.agent-pane-head strong')).toHaveTextContent(
        'Untitled site',
      ),
    );
    expect(
      screen.getByRole('button', { name: targetProject.name }),
    ).not.toHaveAttribute('aria-current', 'page');
    expect(backend.dispose).toHaveBeenCalledTimes(1);
  });

  it('pauses the interactive terminal for the entire managed coding run', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    let finishRun: (() => void) | undefined;
    appMocks.runHarness.mockImplementation(
      (options: CodingHarnessRunOptions) =>
        new Promise((resolve) => {
          finishRun = () => {
            void completeHarnessRun(options).then(resolve);
          };
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/i }));
    expect(screen.getByLabelText(/Inline VM command/i)).toBeDisabled();
    expect(
      screen.getByText(/Terminal input is paused while the coding agent owns the VM/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Terminal starts with the VM/i),
    ).not.toBeInTheDocument();
    expect(document.querySelector('.xterm-host')).toBeInTheDocument();
    expect(backend.startInteractiveShell).not.toHaveBeenCalled();
    expect(backend.writeTerminalInput).not.toHaveBeenCalled();

    finishRun?.();
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/i }));
    expect(backend.startInteractiveShell).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/Inline VM command/i)).toBeEnabled();
  });

  it('hides nonfatal Retry Tailnet during an agent run without aborting that run', async () => {
    const firstBackend = fakeBackend();
    firstBackend.getPrivateNetworkAddress.mockReturnValue(null as never);
    firstBackend.startDefaultPreview.mockResolvedValue({
      status: 1,
      output: 'preview unavailable',
      background: false,
    });
    firstBackend.checkPreview.mockResolvedValue({
      status: 1,
      output: 'preview unavailable',
      background: false,
    });
    // A healthy same-project VM is reused across prompts, so both runs share
    // one backend and createBackend is called exactly once.
    appMocks.createBackend.mockResolvedValue(firstBackend);
    let secondRunOptions: CodingHarnessRunOptions | undefined;
    const secondRunGate = deferred<void>();
    appMocks.runHarness
      .mockImplementationOnce((options: CodingHarnessRunOptions) =>
        completeHarnessRun(options),
      )
      .mockImplementationOnce(async (options: CodingHarnessRunOptions) => {
        secondRunOptions = options;
        await secondRunGate.promise;
        return completeHarnessRun(options);
      });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/preview process is not healthy/i);
    await waitForManagedRunToFinish();
    expect(
      screen.getByRole('button', { name: /Retry Tailnet/i }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: 'Continue coding without touching Tailnet.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));
    await waitFor(() => expect(secondRunOptions).toBeDefined());
    expect(
      screen.queryByRole('button', { name: /Retry Tailnet/i }),
    ).not.toBeInTheDocument();
    expect(secondRunOptions?.abortSignal?.aborted).toBe(false);

    secondRunGate.resolve();
    await waitForManagedRunToFinish();
    expect(secondRunOptions?.abortSignal?.aborted).toBe(false);
  });

  it('treats Tailnet retry as a cancellable network operation, not a Gemini run', async () => {
    const backend = fakeBackend();
    backend.getPrivateNetworkAddress.mockReturnValue(null as never);
    backend.startDefaultPreview.mockResolvedValue({
      status: 1,
      output: 'preview unavailable',
      background: false,
    });
    backend.checkPreview.mockResolvedValue({
      status: 1,
      output: 'preview unavailable',
      background: false,
    });
    const networkGate = deferred<string>();
    backend.connectPrivateNetwork.mockImplementation(() => networkGate.promise);
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/preview process is not healthy/i);
    await waitForManagedRunToFinish();

    fireEvent.click(screen.getByRole('button', { name: /Retry Tailnet/i }));
    expect(
      await screen.findByText(/Reconnecting the private Tailnet preview/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Connecting Tailnet/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/Gemini is working in the browser VM/i),
    ).not.toBeInTheDocument();
    expect(appMocks.runHarness).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/i }));
    expect(
      screen.getByText(/paused while SparkRun reconnects Tailnet/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    expect(
      screen.getAllByText(
        /Stopping the Tailnet retry and securing the workspace/i,
      ),
    ).toHaveLength(2);

    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    expect(
      await screen.findAllByText(
        /The Tailnet retry and VM process tree stopped/i,
      ),
    ).toHaveLength(2);
    expect(
      screen.queryByText(/The active request and VM process tree stopped/i),
    ).not.toBeInTheDocument();
    await waitForManagedRunToFinish();

    await act(async () => {
      networkGate.resolve('');
      await Promise.resolve();
    });
  });

  it('keeps an explicit stopping state visible until VM teardown finishes', async () => {
    const backend = fakeBackend();
    const disposeGate = deferred<void>();
    backend.dispose.mockImplementation(async () => {
      await disposeGate.promise;
      return undefined;
    });
    appMocks.createBackend.mockResolvedValue(backend);
    appMocks.runHarness.mockImplementation(
      (options: CodingHarnessRunOptions) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => {
              const error = new Error('stopped');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: /^Files\s*2$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));

    expect(
      screen.getByRole('button', { name: /Stopping/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Stopping the request and securing the workspace/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: /^Update$/i })).not.toBeInTheDocument();

    disposeGate.resolve();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /Stopping/i }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Update$/i })).toBeEnabled();
  });

  it('starts the inline terminal without opening the drawer and can maximize it', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/i }));
    expect(backend.startInteractiveShell).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Interactive VM terminal/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Inline VM command/i), {
      target: { value: 'pwd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    expect(backend.writeTerminalInput).toHaveBeenCalledWith('pwd\n');
    expect(screen.queryByText(/Interactive VM terminal/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Maximize terminal/i }));
    expect(backend.startInteractiveShell).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Interactive VM terminal/i)).toBeInTheDocument();
  });

  it('refreshes the Files surface after a manual checkpoint without restarting the VM', async () => {
    const backend = fakeBackend({
      files: [['index.html', '<h1>Hello</h1>']],
    });
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();
    expect(
      screen.getByRole('tab', { name: /^Files\s*1$/i }),
    ).toBeInTheDocument();

    await backend.writeText('js/app.js', 'console.log("ready");\n');
    fireEvent.click(screen.getByRole('button', { name: /^Snapshot/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: /^Files\s*2$/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /^Files\s*2$/i }));
    expect(screen.getByRole('button', { name: /js\/app\.js/i })).toBeInTheDocument();
  });

  it('does not claim a snapshot fully succeeded when its live lineage marker cannot advance', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    const [projectBefore] = await testVault.listProjects();
    const previousHead = projectBefore.headCheckpointId;
    expect(previousHead).toMatch(/^checkpoint-/);
    const originalWrite = backend.writeText.getMockImplementation();
    backend.writeText.mockImplementation(async (path, content) => {
      if (
        path === '.sparkrun-vault-head' &&
        content.startsWith('checkpoint-') &&
        content !== previousHead
      ) {
        throw new Error('lineage marker write failed');
      }
      return originalWrite?.(path, content);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Snapshot/i }));

    expect(
      await screen.findByText(/recovery snapshot was committed.*could not mark/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Snapshot failed/i })).toBeInTheDocument();
    expect(
      screen.queryByText(/Committed a recovery snapshot to the browser vault/i),
    ).not.toBeInTheDocument();
    const [projectAfter] = await testVault.listProjects();
    expect(projectAfter.headCheckpointId).toMatch(/^checkpoint-/);
    expect(projectAfter.headCheckpointId).not.toBe(previousHead);
  });

  it('refreshes the Files surface after a terminal checkpoint without restarting the VM', async () => {
    const backend = fakeBackend({
      files: [['index.html', '<h1>Hello</h1>']],
    });
    appMocks.createBackend.mockResolvedValue(backend);
    const timeoutSpy = vi.spyOn(window, 'setTimeout');

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    await backend.writeText('js/app.js', 'console.log("ready");\n');
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/i }));
    fireEvent.change(screen.getByLabelText(/Inline VM command/i), {
      target: { value: 'touch js/app.js' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    const checkpointTimer = timeoutSpy.mock.calls.find(
      ([, delay]) => delay === 2_500,
    )?.[0];
    expect(checkpointTimer).toBeDefined();
    checkpointTimer?.();

    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: /^Files\s*2$/i }),
      ).toBeInTheDocument(),
    );
  });

  it('refreshes Files after an agent-tool checkpoint without extending the checkpoint barrier', async () => {
    const backend = fakeBackend({
      files: [['index.html', '<h1>Hello</h1>']],
    });
    appMocks.createBackend.mockResolvedValue(backend);
    const releaseHarness = deferred<void>();
    const baseSession = harnessSession(
      'Create an agent file.',
      'interaction-agent-files',
    );
    const toolResultSession: CodingHarnessSession = {
      ...baseSession,
      transcript: [
        ...baseSession.transcript,
        {
          id: 'agent-file-result',
          createdAt: '2026-08-27T12:00:02.000Z',
          role: 'tool',
          kind: 'tool-result',
          content: '{"status":0}',
          interactionId: 'interaction-agent-files',
          toolCallId: 'agent-file-call',
          toolName: 'write_file',
        },
      ],
    };
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        await options.runtime.writeText('js/app.js', 'console.log("agent");\n');
        await options.onSession?.(toolResultSession);
        await releaseHarness.promise;
        return {
          finalText: 'Agent file written.',
          changedFiles: ['js/app.js'],
          session: toolResultSession,
          reachedTurnBudget: false,
        };
      },
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() =>
      expect(
        screen.getByRole('tab', { name: /^Files\s*2$/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Stop$/i })).toBeInTheDocument();
    releaseHarness.resolve();
    await waitForManagedRunToFinish();
  });

  it('persists terminal output that arrives after the command returns', async () => {
    const backend = fakeBackend();
    let emitConsole: ((text: string) => void) | undefined;
    appMocks.createBackend.mockImplementation(async (options) => {
      emitConsole = options.onConsole;
      return backend;
    });
    const timeoutSpy = vi.spyOn(window, 'setTimeout');

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    fireEvent.click(screen.getByRole('tab', { name: /Terminal/i }));
    fireEvent.change(screen.getByLabelText(/Inline VM command/i), {
      target: { value: 'slow-output' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/i }));
    const checkpointTimer = [...timeoutSpy.mock.calls]
      .reverse()
      .find(([, delay]) => delay === 2_500)?.[0];
    expect(checkpointTimer).toBeDefined();

    await act(async () => {
      emitConsole?.('late terminal output\n');
    });
    await act(async () => {
      checkpointTimer?.();
      await Promise.resolve();
    });

    const [project] = await testVault.listProjects();
    await waitFor(async () => {
      const [session] = await testVault.listTerminalSessions(project.id);
      expect(session?.scrollback).toContain('late terminal output');
    });
  });

  it('runs safe full-page recovery from the fatal network header control', async () => {
    const backend = fakeBackend();
    backend.getFatalNetworkFailure.mockReturnValue(
      'The in-page WebVM network runtime crashed. Reload the browser tab to rebuild it.',
    );
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();
    backend.createWorkspaceArchive.mockClear();
    backend.dispose.mockClear();
    const reload = vi
      .spyOn(browserPageLifecycle, 'reload')
      .mockImplementation(() => undefined);

    expect(
      screen.queryByRole('button', { name: /Open website/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: /Recover network runtime/i }),
    );

    expect(
      await screen.findByText(/Reloading network runtime/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(backend.createWorkspaceArchive).toHaveBeenCalled());
    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/auth key rejected/i)).not.toBeInTheDocument();
    expect(backend.connectPrivateNetwork).not.toHaveBeenCalled();
    reload.mockRestore();
  });

  it('aborts an active coding run before fatal network recovery reloads the page', async () => {
    const backend = fakeBackend();
    backend.getFatalNetworkFailure.mockReturnValue(
      'The in-page WebVM network runtime crashed. Reload the browser tab to rebuild it.',
    );
    appMocks.createBackend.mockResolvedValue(backend);
    let runSignal: AbortSignal | undefined;
    appMocks.runHarness.mockImplementation(
      (options: CodingHarnessRunOptions) =>
        new Promise((_resolve, reject) => {
          runSignal = options.abortSignal;
          options.abortSignal?.addEventListener(
            'abort',
            () => {
              const error = new Error('stopped for recovery');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const reload = vi
      .spyOn(browserPageLifecycle, 'reload')
      .mockImplementation(() => undefined);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    expect(runSignal?.aborted).toBe(false);

    fireEvent.click(
      screen.getByRole('button', { name: /Recover network runtime/i }),
    );

    await waitFor(() => expect(runSignal?.aborted).toBe(true));
    await waitFor(() => expect(backend.createWorkspaceArchive).toHaveBeenCalled());
    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(backend.connectPrivateNetwork).not.toHaveBeenCalled();
    reload.mockRestore();
  });

  it('cancels a pending terminal fit frame when the terminal unmounts', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    const view = render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(733);
    const cancelFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);

    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));
    expect(requestFrame).toHaveBeenCalled();

    view.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(733);

    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it('serializes a full xterm resync when capped terminal state is left-truncated', async () => {
    const backend = fakeBackend();
    let emitConsole: ((text: string) => void) | undefined;
    appMocks.createBackend.mockImplementation(async (options) => {
      emitConsole = options.onConsole;
      return backend;
    });
    let releaseFirstWrite: (() => void) | undefined;
    let heldFirstWrite = false;
    appMocks.xtermWrite.mockImplementation(
      (_text: string, callback?: () => void) => {
        if (!heldFirstWrite) {
          heldFirstWrite = true;
          releaseFirstWrite = callback;
          return;
        }
        callback?.();
      },
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/i }));

    const firstState = 'a'.repeat(200_000);
    await act(async () => {
      emitConsole?.(firstState);
    });
    await waitFor(() => expect(appMocks.xtermWrite).toHaveBeenCalledTimes(1));

    await act(async () => {
      emitConsole?.('TAIL');
    });
    expect(appMocks.xtermReset).not.toHaveBeenCalled();
    expect(appMocks.xtermWrite).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirstWrite?.();
    });
    const expectedResync = `${firstState}TAIL`.slice(-200_000);
    await waitFor(() => expect(appMocks.xtermReset).toHaveBeenCalledTimes(1));
    expect(appMocks.xtermWrite).toHaveBeenCalledTimes(2);
    expect(appMocks.xtermWrite.mock.calls[1]?.[0]).toBe(expectedResync);
  });

  it('boots the VM, runs the agent, starts the server, and reports a live preview', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async (options) => {
      options.onStatus({
        lifecycle: 'tailnet-connected',
        message: 'Tailnet connected',
        tailnetIp: '100.64.0.25',
        loginUrl: null,
        previewUrl: 'http://100.64.0.25:8080/',
      });
      options.onConsole?.(
        'mesg: ttyname failed: Success\nboot ok\nsg: ttyname failed: Success\n',
      );
      return backend;
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    expect(appMocks.createHarness).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      model: MODEL_ID,
      environmentInstruction: DEFAULT_WEBVM_DISK_PROFILE.agentEnvironmentNotes,
    });
    expect(DEFAULT_WEBVM_DISK_PROFILE.agentEnvironmentNotes).toMatch(
      /No public internet from the guest/,
    );
    expect(appMocks.runHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('hello world website'),
        runtime: backend,
        session: null,
      }),
    );
    expect(await screen.findByText(/Server is ready at/i)).toBeInTheDocument();
    await waitForManagedRunToFinish();
    expect(backend.startDefaultPreview).toHaveBeenCalledTimes(1);
    expect(
      screen.getAllByText(/server process is listening on port 8081/i).length,
    ).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole('button', { name: /Open workspace files/i }),
    );
    expect(
      screen.getByRole('button', { name: /index\.html14 B/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByLabelText(/assets\/site\.css contents/i),
    ).toHaveTextContent('body { color: teal; }');
    expect(screen.getAllByText('14 B').length).toBeGreaterThan(0);
    expect(screen.getByText(/Website generation finished/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Open website/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close files/i }));
    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));
    fireEvent.change(screen.getByLabelText(/VM command/i), {
      target: { value: 'pwd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    expect(backend.startInteractiveShell).toHaveBeenCalledTimes(1);
    expect(backend.writeTerminalInput).toHaveBeenCalledWith('pwd\n');
    expect(screen.queryByText(/ttyname failed/i)).not.toBeInTheDocument();
  });

  it('holds the project lease from before VM creation through backend disposal', async () => {
    const order: string[] = [];
    const release = vi.fn(async () => {
      order.push('lease-release');
    });
    appMocks.acquireWorkspaceLease.mockImplementation(async (projectId) => {
      order.push('lease-acquire');
      return {
        projectId,
        lockName: `test-workspace-lock:${projectId}`,
        released: false,
        release,
      };
    });
    const backend = fakeBackend();
    backend.dispose.mockImplementation(async () => {
      order.push('backend-dispose');
    });
    appMocks.createBackend.mockImplementation(async () => {
      order.push('backend-create');
      return backend;
    });

    const view = render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    expect(order.slice(0, 2)).toEqual(['lease-acquire', 'backend-create']);
    view.unmount();
    await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(order.indexOf('backend-dispose')).toBeLessThan(
      order.indexOf('lease-release'),
    );
  });

  it('fails closed before a clean VM mount when another tab owns the lease', async () => {
    appMocks.acquireWorkspaceLease.mockRejectedValue(
      Object.assign(
        new Error(
          'This project is already open in another tab. Close that workspace before trying again.',
        ),
        { code: 'unavailable' },
      ),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(
      (await screen.findAllByText(/already open in another tab/i)).length,
    ).toBeGreaterThan(0);
    expect(appMocks.acquireWorkspaceLease).toHaveBeenCalledTimes(1);
    expect(appMocks.createBackend).not.toHaveBeenCalled();
    expect(appMocks.createHarness).not.toHaveBeenCalled();
    expect(appMocks.runHarness).not.toHaveBeenCalled();
  });

  it('checkpoints a completed tool result before the harness or Stop can continue', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    const archiveGate = deferred<Blob>();
    const order: string[] = [];
    backend.createWorkspaceArchive.mockImplementation(async () => {
      order.push('archive-started');
      return archiveGate.promise;
    });
    backend.dispose.mockImplementation(async () => {
      order.push('backend-disposed');
    });
    const commitCheckpoint = testVault.commitCheckpoint.bind(testVault);
    vi.spyOn(testVault, 'commitCheckpoint').mockImplementation(async (input) => {
      const checkpoint = await commitCheckpoint(input);
      order.push('checkpoint-committed');
      return checkpoint;
    });
    const toolResultSession: CodingHarnessSession = {
      ...harnessSession('Run a completed tool.', 'interaction-tool'),
      transcript: [
        ...harnessSession('Run a completed tool.', 'interaction-tool')
          .transcript,
        {
          id: 'tool-result-1',
          createdAt: '2026-08-27T12:00:02.000Z',
          role: 'tool',
          kind: 'tool-result',
          content: '{"status":0}',
          interactionId: 'interaction-tool',
          toolCallId: 'call-1',
          toolName: 'run_command',
        },
      ],
    };
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        await options.onSession?.(toolResultSession);
        order.push('harness-continued');
        return {
          finalText: 'Tool work complete.',
          changedFiles: ['index.html'],
          session: toolResultSession,
          reachedTurnBudget: false,
        };
      },
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() =>
      expect(backend.createWorkspaceArchive).toHaveBeenCalledTimes(1),
    );
    expect(order).toEqual(['archive-started']);
    expect(
      screen.getByRole('button', { name: /Saving|Snapshot/i }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    expect(backend.dispose).not.toHaveBeenCalled();
    expect(order).not.toContain('harness-continued');

    archiveGate.resolve(new Blob(['completed tool checkpoint']));
    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(order).toContain('harness-continued'));
    expect(order.indexOf('checkpoint-committed')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('checkpoint-committed')).toBeLessThan(
      order.indexOf('harness-continued'),
    );
    expect(order.indexOf('checkpoint-committed')).toBeLessThan(
      order.indexOf('backend-disposed'),
    );
  });

  it('does not checkpoint the same tool result again during late cancel persistence', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    const firstSessionPersisted = deferred<void>();
    const releaseDuplicateCancelSession = deferred<void>();
    const baseSession = harnessSession(
      'Persist a tool result during cancellation.',
      'interaction-stop-race',
    );
    const toolResultSession: CodingHarnessSession = {
      ...baseSession,
      transcript: [
        ...baseSession.transcript,
        {
          id: 'late-tool-result',
          createdAt: '2026-08-27T12:00:02.000Z',
          role: 'tool',
          kind: 'tool-result',
          content: '{"status":0}',
          interactionId: 'interaction-stop-race',
          toolCallId: 'late-call',
          // A mutating tool: read-only inspections no longer trigger
          // workspace checkpoints.
          toolName: 'run_command',
        },
      ],
    };
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        await options.onSession?.(toolResultSession);
        firstSessionPersisted.resolve();
        await new Promise<void>((resolve) => {
          if (options.abortSignal?.aborted) {
            resolve();
            return;
          }
          options.abortSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        await releaseDuplicateCancelSession.promise;
        // Background cancellation persists provider state without appending a
        // transcript item, so the transcript still ends in the old tool result.
        await options.onSession?.(toolResultSession);
        const error = new Error('cancelled after persistence');
        error.name = 'AbortError';
        throw error;
      },
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await firstSessionPersisted.promise;
    expect(backend.createWorkspaceArchive).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));

    releaseDuplicateCancelSession.resolve();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /^Stop$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(backend.createWorkspaceArchive).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Snapshot failed/i)).not.toBeInTheDocument();
  });

  it('rejects a new checkpoint producer after Stop has closed VM admissions', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    const firstSessionPersisted = deferred<void>();
    const releaseLateSession = deferred<void>();
    const baseSession = harnessSession(
      'Persist work before Stop.',
      'interaction-stop-fence',
    );
    const firstToolResultSession: CodingHarnessSession = {
      ...baseSession,
      transcript: [
        ...baseSession.transcript,
        {
          id: 'first-tool-result',
          createdAt: '2026-08-27T12:00:02.000Z',
          role: 'tool',
          kind: 'tool-result',
          content: '{"status":0}',
          interactionId: 'interaction-stop-fence',
          toolCallId: 'first-call',
          toolName: 'write_file',
        },
      ],
    };
    const lateNewToolResultSession: CodingHarnessSession = {
      ...firstToolResultSession,
      transcript: [
        ...firstToolResultSession.transcript,
        {
          id: 'late-new-tool-result',
          createdAt: '2026-08-27T12:00:03.000Z',
          role: 'tool',
          kind: 'tool-result',
          content: '{"status":0,"late":true}',
          interactionId: 'interaction-stop-fence-late',
          toolCallId: 'late-new-call',
          toolName: 'write_file',
        },
      ],
    };
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        await options.onSession?.(firstToolResultSession);
        firstSessionPersisted.resolve();
        await new Promise<void>((resolve) => {
          if (options.abortSignal?.aborted) {
            resolve();
            return;
          }
          options.abortSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        await releaseLateSession.promise;
        await options.onSession?.(lateNewToolResultSession);
        const error = new Error('cancelled after late tool persistence');
        error.name = 'AbortError';
        throw error;
      },
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await firstSessionPersisted.promise;
    expect(backend.createWorkspaceArchive).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));
    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));

    releaseLateSession.resolve();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /^Stop$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(backend.createWorkspaceArchive).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Snapshot failed/i)).not.toBeInTheDocument();
    const [project] = await testVault.listProjects();
    const [conversation] = await testVault.listConversations(project.id);
    const persistedTranscript = conversation.harnessSession?.transcript ?? [];
    expect(
      persistedTranscript.some((item) => item.id === 'first-tool-result'),
    ).toBe(true);
    expect(
      persistedTranscript.some((item) => item.id === 'late-new-tool-result'),
    ).toBe(false);
  });

  it('redacts Google, interaction, and Tailscale keys from terminal persistence', async () => {
    const googleKey = `AIza${'A'.repeat(30)}`;
    const interactionKey = `AQ.${'B'.repeat(24)}`;
    const tailscaleKey = `tskey-auth-${'C'.repeat(20)}`;
    const rawSecrets = `${googleKey} ${interactionKey} ${tailscaleKey}`;
    const backend = fakeBackend();
    let emitConsole: ((text: string) => void) | undefined;
    appMocks.createBackend.mockImplementation(async (options) => {
      emitConsole = options.onConsole;
      return backend;
    });
    backend.writeTerminalInput.mockImplementation(function () {
      const input = arguments[0] as string;
      if (input.includes('printf')) emitConsole?.(`${rawSecrets}\n`);
      return { status: 0, output: '', background: false };
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));
    fireEvent.change(screen.getByLabelText(/VM command/i), {
      target: { value: `printf '%s' '${rawSecrets}'` },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    const [project] = await testVault.listProjects();
    await waitFor(async () => {
      const [session] = await testVault.listTerminalSessions(project.id);
      expect(session?.commandHistory.join('\n')).toContain(
        '[REDACTED_GOOGLE_KEY]',
      );
    });

    fireEvent.change(screen.getByLabelText(/VM command/i), {
      target: { value: 'pwd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));

    await waitFor(async () => {
      const [session] = await testVault.listTerminalSessions(project.id);
      const serialized = JSON.stringify(session);
      expect(serialized).toContain('[REDACTED_GOOGLE_KEY]');
      expect(serialized).toContain('[REDACTED_TAILSCALE_KEY]');
      expect(session?.scrollback).toContain('[REDACTED_GOOGLE_KEY]');
      expect(session?.scrollback).toContain('[REDACTED_TAILSCALE_KEY]');
      expect(serialized).not.toContain(googleKey);
      expect(serialized).not.toContain(interactionKey);
      expect(serialized).not.toContain(tailscaleKey);
    });
  });

  it('redacts credentials from host-side project and activity persistence', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    const leakedKey = `AI${'za'}${'1'.repeat(30)}`;
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) =>
        completeHarnessRun(options, {
          session: harnessSession(
            'Use [REDACTED_GOOGLE_KEY] to inspect the site',
            'interaction-redacted',
            'session-redacted',
          ),
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: `Use ${leakedKey} to inspect the site` },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await waitForManagedRunToFinish();

    await waitFor(async () => {
      const [project] = await testVault.listProjects();
      expect(project?.prompt).toContain('[REDACTED_GOOGLE_KEY]');
      expect(project?.prompt).not.toContain(leakedKey);
      const [conversation] = await testVault.listConversations(project.id);
      const persistedEvents = await testVault.listConversationEvents(
        conversation.id,
      );
      const serialized = JSON.stringify(persistedEvents);
      expect(serialized).toContain('[REDACTED_GOOGLE_KEY]');
      expect(serialized).not.toContain(leakedKey);
    });
  });

  it('redacts credentials from VM Activity before display', async () => {
    const googleKey = `AIza${'D'.repeat(30)}`;
    const interactionKey = `AQ.${'E'.repeat(24)}`;
    const tailscaleKey = `tskey-auth-${'F'.repeat(20)}`;
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async (options) => {
      options.onDebug?.({
        phase: 'exec-result',
        command: `curl -H 'Authorization: Bearer ${googleKey}' /private`,
        output: `${interactionKey} ${tailscaleKey}`,
        status: 0,
      });
      return backend;
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();
    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }));

    const diagnostics = screen.getByRole('dialog', {
      name: /Diagnostics log/i,
    });
    expect(diagnostics).toHaveTextContent('[REDACTED_GOOGLE_KEY]');
    expect(diagnostics).toHaveTextContent('[REDACTED_TAILSCALE_KEY]');
    expect(diagnostics).not.toHaveTextContent(googleKey);
    expect(diagnostics).not.toHaveTextContent(interactionKey);
    expect(diagnostics).not.toHaveTextContent(tailscaleKey);
  });

  it('refreshes an open file preview when an update rewrites the same path', async () => {
    // A healthy same-project VM is reused across prompts, so both runs share
    // one backend and createBackend is called exactly once.
    const firstBackend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(firstBackend);
    let turn = 0;
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        turn += 1;
        await options.runtime.writeText(
          'index.html',
          `<h1>Workspace turn ${turn}</h1>`,
        );
        return completeHarnessRun(options);
      },
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    await waitForManagedRunToFinish();
    fireEvent.click(screen.getByRole('tab', { name: /Files/i }));
    fireEvent.click(screen.getByRole('button', { name: /index\.html/i }));
    expect(
      await screen.findByLabelText(/index\.html contents/i),
    ).toHaveTextContent('Workspace turn 1');

    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: 'Update the same file.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Update$/i }));
    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(2));
    await waitForManagedRunToFinish();

    expect(
      await screen.findByLabelText(/index\.html contents/i),
    ).toHaveTextContent('Workspace turn 2');
  });

  it('gives each workspace drawer dialog focus and restores its opener on Escape', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);

    fireEvent.click(screen.getByRole('tab', { name: /Files/i }));
    expect(
      await screen.findByLabelText(/assets\/site\.css contents/i),
    ).toHaveTextContent('body { color: teal; }');
    expect(
      screen.getByRole('button', { name: /Expand files/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/full navigator/i)).not.toBeInTheDocument();

    const checkDrawer = async (
      openerName: RegExp,
      dialogName: RegExp,
      closeName: RegExp,
    ) => {
      const opener = screen.getByRole('button', { name: openerName });
      opener.focus();
      fireEvent.click(opener);

      const dialog = screen.getByRole('dialog', { name: dialogName });
      const closeButton = screen.getByRole('button', { name: closeName });
      await waitFor(() => expect(closeButton).toHaveFocus());

      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(opener).toHaveFocus();

      const strayEscape = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      });
      expect(document.dispatchEvent(strayEscape)).toBe(true);
      expect(strayEscape.defaultPrevented).toBe(false);
    };

    await checkDrawer(
      /Open workspace files/i,
      /Workspace files/i,
      /Close files/i,
    );
    await checkDrawer(/Open logs/i, /Diagnostics log/i, /Close logs/i);
    await checkDrawer(
      /Open terminal/i,
      /Interactive VM terminal/i,
      /Close terminal/i,
    );
  });

  it('keeps a writable matching-head cache with newer uncheckpointed files', async () => {
    const project = await testVault.createProject({
      id: 'authoritative-vault-project',
      name: 'Authoritative vault',
      prompt: 'Continue from the live tree.',
    });
    const checkpoint = await testVault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['committed workspace archive']),
      reason: 'manual',
      expectedParentId: null,
    });
    const backend = fakeBackend({
      files: [
        ['.sparkrun-vault-head', checkpoint.id],
        ['index.html', '<h1>Newer uncheckpointed cache copy</h1>'],
      ],
    });
    appMocks.createBackend.mockResolvedValue(backend);
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        expect(await backend.readText('index.html')).toBe(
          '<h1>Newer uncheckpointed cache copy</h1>',
        );
        expect(backend.resetWorkspace).not.toHaveBeenCalled();
        expect(backend.restoreWorkspaceArchive).not.toHaveBeenCalled();
        return completeHarnessRun(options);
      },
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'Authoritative vault',
      ),
    );
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() => expect(appMocks.createBackend).toHaveBeenCalledTimes(1));
    expect(appMocks.createBackend).toHaveBeenCalledWith(
      expect.objectContaining({ prepareWorkspace: 'preserve' }),
    );
    await waitFor(() =>
      expect(appMocks.runHarness).toHaveBeenCalledTimes(1),
    );
    expect(backend.writeText.mock.calls[0]).toEqual([
      '.sparkrun-vault-head',
      checkpoint.id,
    ]);
    expect(backend.resetWorkspace).not.toHaveBeenCalled();
    expect(backend.restoreWorkspaceArchive).not.toHaveBeenCalled();
    await waitForManagedRunToFinish();
  });

  it('keeps and probes a writable cache when the vault has no checkpoint', async () => {
    await testVault.createProject({
      id: 'no-vault-head-project',
      name: 'First uncheckpointed project',
      prompt: 'Keep the only workspace copy.',
    });
    const backend = fakeBackend({
      files: [['notes.txt', 'Only copy in the per-project cache.']],
    });
    appMocks.createBackend.mockResolvedValue(backend);
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        expect(await backend.readText('notes.txt')).toBe(
          'Only copy in the per-project cache.',
        );
        return completeHarnessRun(options);
      },
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'First uncheckpointed project',
      ),
    );
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    expect(appMocks.createBackend).toHaveBeenCalledWith(
      expect.objectContaining({ prepareWorkspace: 'preserve' }),
    );
    expect(backend.writeText.mock.calls[0]).toEqual([
      '.sparkrun-vault-head',
      '',
    ]);
    expect(backend.resetWorkspace).not.toHaveBeenCalled();
    expect(backend.restoreWorkspaceArchive).not.toHaveBeenCalled();
    await waitForManagedRunToFinish();
  });

  it.each([
    ['missing', null],
    ['mismatched', 'checkpoint-from-another-lineage'],
  ] as const)(
    'cleans and restores a verified vault checkpoint when the cache marker is %s',
    async (_caseName, cachedMarker) => {
      const project = await testVault.createProject({
        id: `restore-${_caseName}-marker-project`,
        name: `Restore ${_caseName} marker`,
        prompt: 'Recover the verified project tree.',
      });
      const checkpoint = await testVault.commitCheckpoint({
        projectId: project.id,
        archive: new Blob([`verified ${_caseName} archive`]),
        reason: 'manual',
        expectedParentId: null,
      });
      const files: Array<[string, string]> = [
        ['index.html', '<h1>Unidentified cache</h1>'],
      ];
      if (cachedMarker !== null) {
        files.push(['.sparkrun-vault-head', cachedMarker]);
      }
      const backend = fakeBackend({ files });
      appMocks.createBackend.mockResolvedValue(backend);
      const order: string[] = [];
      backend.resetWorkspace.mockImplementation(async () => {
        order.push('workspace-reset');
      });
      backend.restoreWorkspaceArchive.mockImplementation(async () => {
        order.push('archive-restored');
      });
      backend.writeText.mockImplementation(async (path, content) => {
        if (path === '.sparkrun-vault-head' && content === checkpoint.id) {
          order.push('lineage-written');
        }
      });
      appMocks.runHarness.mockImplementation(
        async (options: CodingHarnessRunOptions) => {
          order.push('harness-started');
          return completeHarnessRun(options);
        },
      );

      render(<App />);
      await waitFor(() =>
        expect(screen.getByLabelText(/Project name/i)).toHaveValue(
          `Restore ${_caseName} marker`,
        ),
      );
      fireEvent.change(screen.getByLabelText(/Google AI key/i), {
        target: { value: 'test-api-key' },
      });
      gotoChat();
      fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

      await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
      expect(order.slice(0, 4)).toEqual([
        'workspace-reset',
        'archive-restored',
        'lineage-written',
        'harness-started',
      ]);
      expect(backend.resetWorkspace).toHaveBeenCalledTimes(1);
      expect(backend.restoreWorkspaceArchive).toHaveBeenCalledWith(
        expect.anything(),
      );
      await waitForManagedRunToFinish();
    },
  );

  it.each([
    ['matching checkpoint', true],
    ['no checkpoint', false],
  ] as const)(
    'leaves a %s cache untouched when its lineage write probe fails',
    async (_caseName, withCheckpoint) => {
      const project = await testVault.createProject({
        id: `probe-failure-${withCheckpoint ? 'head' : 'empty'}-project`,
        name: `Probe failure ${_caseName}`,
        prompt: 'Do not erase this cache.',
      });
      const checkpoint = withCheckpoint
        ? await testVault.commitCheckpoint({
            projectId: project.id,
            archive: new Blob(['verified archive']),
            reason: 'manual',
            expectedParentId: null,
          })
        : null;
      const backend = fakeBackend({
        files: [
          ...(checkpoint
            ? ([['.sparkrun-vault-head', checkpoint.id]] as Array<
                [string, string]
              >)
            : []),
          ['only-copy.txt', 'Do not silently clean this file.'],
        ],
      });
      backend.writeText.mockRejectedValueOnce(
        new Error('Read-only file system'),
      );
      appMocks.createBackend.mockResolvedValue(backend);

      render(<App />);
      await waitFor(() =>
        expect(screen.getByLabelText(/Project name/i)).toHaveValue(
          `Probe failure ${_caseName}`,
        ),
      );
      fireEvent.change(screen.getByLabelText(/Google AI key/i), {
        target: { value: 'test-api-key' },
      });
      gotoChat();
      fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

      expect(
        await screen.findByText(/cache was left untouched/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/use Reset workspace/i)).toBeInTheDocument();
      expect(backend.resetWorkspace).not.toHaveBeenCalled();
      expect(backend.restoreWorkspaceArchive).not.toHaveBeenCalled();
      expect(appMocks.runHarness).not.toHaveBeenCalled();
      await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    },
  );

  it('invalidates provider continuations after restoring a verified corrupt-head fallback', async () => {
    const project = await testVault.createProject({
      id: 'corrupt-head-project',
      name: 'Corrupt head recovery',
      prompt: 'Recover before continuing.',
    });
    const conversation = await testVault.createConversation({
      projectId: project.id,
      title: 'Stale provider continuation',
      model: MODEL_ID,
    });
    await testVault.saveConversationHarnessSession(
      conversation.id,
      harnessSession(
        'Recover before continuing.',
        'interaction-from-corrupt-head',
        'rollback-session',
      ),
    );
    const parent = await testVault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['verified parent archive']),
      reason: 'manual',
      expectedParentId: null,
    });
    const corruptHead = await testVault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['newer corrupt archive']),
      reason: 'manual',
      expectedParentId: parent.id,
    });
    await testVault.db.checkpoints.update(corruptHead.id, {
      archiveBytes: await new Blob(['tampered archive bytes']).arrayBuffer(),
    });

    const backend = fakeBackend({
      files: [
        ['.sparkrun-vault-head', parent.id],
        ['index.html', '<h1>Cache descended from verified parent</h1>'],
      ],
    });
    appMocks.createBackend.mockResolvedValue(backend);
    const order: string[] = [];
    let restoredArchive: Blob | null = null;
    backend.resetWorkspace.mockImplementation(async () => {
      order.push('workspace-reset');
    });
    backend.restoreWorkspaceArchive.mockImplementation(async function () {
      const archive = arguments[0] as Blob;
      order.push('archive-restored');
      restoredArchive = archive;
    });
    const invalidateContinuations =
      testVault.invalidateProjectProviderContinuations.bind(testVault);
    vi.spyOn(testVault, 'invalidateProjectProviderContinuations')
      .mockImplementation(async (projectId) => {
        order.push('continuations-invalidated');
        return invalidateContinuations(projectId);
      });
    let resumedSession: CodingHarnessSession | null | undefined;
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        order.push('harness-started');
        resumedSession = options.session;
        if (!options.session) throw new Error('Expected a restored session.');
        return {
          finalText: 'Recovered from the verified workspace.',
          changedFiles: ['index.html'],
          session: options.session,
          reachedTurnBudget: false,
        };
      },
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'Corrupt head recovery',
      ),
    );
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));
    expect(order.slice(0, 4)).toEqual([
      'workspace-reset',
      'archive-restored',
      'continuations-invalidated',
      'harness-started',
    ]);
    expect(backend.resetWorkspace).toHaveBeenCalledTimes(1);
    expect(resumedSession).toMatchObject({
      id: 'rollback-session',
      previousInteractionId: null,
      providerState: {
        pendingProviderTurn: false,
        interruptedDuringTools: false,
      },
    });
    expect(
      new TextDecoder().decode(await restoredArchive!.arrayBuffer()),
    ).toBe('verified parent archive');
    await waitForManagedRunToFinish();
    expect(
      (await testVault.getConversation(conversation.id))?.previousInteractionId,
    ).toBeNull();
  });

  it('checkpoints and disposes the mounted VM before deleting its exact reset cache', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Stop$/i })).not.toBeInTheDocument(),
    );

    const [project] = await testVault.listProjects();
    expect(project).toBeDefined();
    const order: string[] = [];
    backend.createWorkspaceArchive.mockImplementation(async () => {
      order.push('checkpoint');
      return new Blob(['final checkpoint']);
    });
    backend.dispose.mockImplementation(async () => {
      order.push('dispose');
    });
    appMocks.hardReset.mockImplementation(() => {
      order.push('delete');
      return new Promise<void>(() => undefined);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset workspace' }));

    await waitFor(() => expect(appMocks.hardReset).toHaveBeenCalledTimes(1));
    expect(order.slice(0, 3)).toEqual(['checkpoint', 'dispose', 'delete']);
    expect(appMocks.hardReset).toHaveBeenCalledWith({
      includeDiskCache: false,
      workspaceDbName: project!.workspaceDbName,
      rootCacheDbName:
        'sparkrun-env-v2-default-web-cheerpx-1.3.9-webvm-buster-2026-06-01',
    });
  });

  it('requires explicit permanent-loss confirmation when the pre-reset checkpoint fails', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Stop$/i })).not.toBeInTheDocument(),
    );

    backend.createWorkspaceArchive.mockRejectedValue(
      new Error('workspace export failed'),
    );
    const confirmReset = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset workspace' }));

    await waitFor(() => expect(confirmReset).toHaveBeenCalledTimes(2));
    expect(confirmReset.mock.calls[1]?.[0]).toMatch(
      /permanently lose all uncommitted changes/i,
    );
    expect(backend.dispose).not.toHaveBeenCalled();
    expect(appMocks.hardReset).not.toHaveBeenCalled();
  });

  it('merges a long build save into the latest vault metadata without reverting a rename', async () => {
    await testVault.createProject({
      id: 'rename-race-project',
      name: 'Original project name',
      prompt: 'Initial prompt',
    });
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    let releaseHarness: () => void = () => {
      throw new Error('Harness was released before it started.');
    };
    appMocks.runHarness.mockImplementation(
      (options: CodingHarnessRunOptions) =>
        new Promise((resolve) => {
          releaseHarness = () => {
            void completeHarnessRun(options, {
              finalText: 'Long build complete.',
            }).then(resolve);
          };
        }),
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /^Project name$/i })).toHaveValue(
        'Original project name',
      ),
    );
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: 'Build from the long-running prompt.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^Project name$/i }), {
      target: { value: 'Renamed while building' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Project/i }));
    await waitFor(async () =>
      expect((await testVault.getProject('rename-race-project'))?.name).toBe(
        'Renamed while building',
      ),
    );

    releaseHarness();
    await waitFor(() =>
      expect(backend.createWorkspaceArchive).toHaveBeenCalled(),
    );
    await waitFor(async () => {
      const stored = await testVault.getProject('rename-race-project');
      expect(stored?.name).toBe('Renamed while building');
      expect(stored?.prompt).toBe('Build from the long-running prompt.');
    });
  });

  it('aborts the preview URL wait immediately when Stop is pressed', async () => {
    const backend = fakeBackend();
    backend.startDefaultPreview.mockResolvedValue({
      status: 0,
      output: 'server started without a Tailnet URL',
      background: true,
    });
    backend.getPreviewUrl.mockReturnValue(null);
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(
      (await screen.findAllByText(/Waiting for the VM Tailnet IP/i)).length,
    ).toBeGreaterThan(0);
    expect(backend.createWorkspaceArchive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/i }));

    // Stop is fail-closed: it disposes the process boundary, does not archive
    // a potentially half-mutated tree, and keeps Build unavailable until the
    // owning run has actually observed cancellation.
    await waitFor(() => expect(backend.dispose).toHaveBeenCalledTimes(1));
    expect(backend.createWorkspaceArchive).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /^Stop$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /^(?:Build|Update)$/i }),
    ).toBeEnabled();
  });

  it('does not traverse source content when no local folder is attached', async () => {
    const readBytes = vi.fn(async (path: string) =>
      path.endsWith('.css')
        ? new Uint8Array([0, 255, 10, 128])
        : new TextEncoder().encode('<h1>Hello</h1>'),
    );
    const backend = Object.assign(fakeBackend(), { readBytes });
    backend.readText.mockImplementation(async (path: string) => {
      if (path.endsWith('.css')) {
        throw new Error('binary file cannot be decoded as text');
      }
      return '<h1>Hello</h1>';
    });
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await screen.findByText(/Server is ready at/i);
    expect(readBytes).not.toHaveBeenCalled();
    expect(screen.queryByText(/Skipped snapshot/i)).not.toBeInTheDocument();
  });

  it('excludes dependency, build, and cache trees from Files and local-folder scans', async () => {
    const sourceDirectory = fakeSourceDirectory('filtered-source');
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(async () =>
        sourceDirectory as unknown as FileSystemDirectoryHandle,
      ),
    });
    vi.spyOn(testVault, 'putSetting').mockResolvedValue(undefined);
    const backend = fakeBackend({
      files: [
        ['index.html', '<h1>Source</h1>'],
        ['src/main.ts', 'console.log("source")'],
        [
          'src/components/ui/dialog/Modal.tsx',
          'export function Modal() { return null; }',
        ],
        ['node_modules/pkg/index.js', 'dependency'],
        ['dist/app.js', 'bundle'],
        ['build/output.js', 'build output'],
        ['cache/tool.json', '{"cached":true}'],
        ['.cache/private.json', '{"hidden":true}'],
      ],
    });
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /Attach folder/i }));
    expect(await screen.findByText('filtered-source')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    fireEvent.click(screen.getByRole('tab', { name: /Files/i }));
    expect(screen.getAllByText('index.html').length).toBeGreaterThan(0);
    expect(screen.getAllByText('src/main.ts').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('src/components/ui/dialog/Modal.tsx').length,
    ).toBeGreaterThan(0);
    for (const hiddenPath of [
      'node_modules/pkg/index.js',
      'dist/app.js',
      'build/output.js',
      'cache/tool.json',
      '.cache/private.json',
    ]) {
      expect(screen.queryByText(hiddenPath)).not.toBeInTheDocument();
      expect(backend.readText).not.toHaveBeenCalledWith(hiddenPath);
    }
    expect(sourceDirectory.files.get('index.html')).toBe('<h1>Source</h1>');
    expect(sourceDirectory.directories.get('src')?.files.get('main.ts')).toBe(
      'console.log("source")',
    );
    expect(
      sourceDirectory.directories
        .get('src')
        ?.directories.get('components')
        ?.directories.get('ui')
        ?.directories.get('dialog')
        ?.files.get('Modal.tsx'),
    ).toBe('export function Modal() { return null; }');
    expect([...sourceDirectory.directories.keys()]).toEqual(['src']);

    delete window.showDirectoryPicker;
  });

  it('groups tool updates and keeps VM diagnostics in the logs drawer', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async (options) => {
      options.onDebug?.({
        phase: 'exec',
        command: 'pwd',
        cwd: '/workspace/site',
        output: '/workspace/site',
        status: 0,
      });
      return backend;
    });
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        options.onEvent?.({
          type: 'tool',
          message: 'write_file index.html',
        });
        options.onEvent?.({
          type: 'tool',
          message: 'Wrote /workspace/site/index.html',
        });
        options.onEvent?.({
          type: 'tool',
          message: 'run_command npm test',
        });
        options.onEvent?.({
          type: 'error',
          message: 'run_command failed: tests exited with status 1',
        });
        return completeHarnessRun(options, {
          finalText: 'Done.',
          changedFiles: ['index.html'],
        });
      },
    );

    const { container } = render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(await screen.findByText('Edit')).toBeInTheDocument();
    const editSummary = screen.getByText('Edit').closest('summary');
    const editDetails = editSummary?.closest('details');
    expect(editDetails).not.toHaveAttribute('open');
    expect(editSummary).not.toBeNull();
    fireEvent.click(editSummary!);
    expect(editDetails).toHaveAttribute('open');
    expect(screen.getByText('write index.html')).toBeInTheDocument();
    expect(screen.getByText('wrote index.html')).toBeInTheDocument();
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(
      Array.from(container.querySelectorAll('.log-label')).map((node) =>
        node.textContent?.trim(),
      ),
    ).not.toContain('Run');

    fireEvent.click(screen.getByRole('tab', { name: /Activity/i }));
    expect(screen.getByLabelText(/Scrolling VM diagnostics/i)).toHaveAttribute(
      'tabindex',
      '0',
    );

    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }));
    expect(await screen.findByText(/Diagnostics log/i)).toBeInTheDocument();
    expect(screen.getByText('$ pwd')).toBeInTheDocument();
    expect(screen.getByText('/workspace/site')).toBeInTheDocument();
  });

  it('labels bind and PID health as server ready, never live, without outer-request evidence', async () => {
    const backend = fakeBackend();
    backend.listDirectory.mockImplementation(async (path: string) => {
      if (!path) {
        return [
          { path: 'index.html', type: 'file' },
          { path: 'ghost.js', type: 'file' },
        ];
      }
      return [];
    });
    backend.readText.mockImplementation(async (path: string) => {
      if (path === 'ghost.js') {
        throw new Error('File not found: /workspace/site/ghost.js');
      }
      return '<h1>Hello</h1>';
    });
    appMocks.createBackend.mockImplementation(async () => backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(await screen.findByText(/Server is ready at/i)).toBeInTheDocument();
    expect(screen.queryByText(/Could not snapshot ghost.js/i)).not.toBeInTheDocument();
    expect(
      await screen.findByText(/server ready · 100\.64\.0\.25:8080/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Live$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/live ·/i)).not.toBeInTheDocument();
    const openWebsite = screen.getByRole('button', { name: /Open website/i });
    expect(openWebsite.querySelector('.dot')).not.toHaveClass('pulse');

    expect(window.localStorage.getItem('sparkrun.projects.v1')).toBeNull();
    await waitFor(async () => {
      const [project] = await testVault.listProjects();
      expect(project).toBeDefined();
      expect(await testVault.getHeadCheckpoint(project.id)).toMatchObject({
        format: 'tar.gz',
        state: 'committed',
      });
    });
  });

  it('clears all live task state after deleting the active project', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();
    expect(
      await screen.findByRole('button', { name: /Open website/i }),
    ).toBeInTheDocument();

    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));
    fireEvent.change(screen.getByLabelText(/VM command/i), {
      target: { value: 'pwd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    const checkpointTimerIndex = timeoutSpy.mock.calls.findIndex(
      ([, delay]) => delay === 2_500,
    );
    expect(checkpointTimerIndex).toBeGreaterThanOrEqual(0);
    const checkpointTimerId = timeoutSpy.mock.results[checkpointTimerIndex]
      ?.value as number;
    fireEvent.click(screen.getByRole('button', { name: /Close terminal/i }));

    fireEvent.click(screen.getByRole('button', { name: /Setup/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Delete Untitled site/i }),
    );

    await waitFor(async () => expect(await testVault.listProjects()).toEqual([]));
    expect(clearTimeoutSpy).toHaveBeenCalledWith(checkpointTimerId);
    timeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    await waitFor(() => {
      expect(screen.getByLabelText(/Project name/i)).toHaveValue('Untitled site');
    });
    gotoChat();
    await waitFor(() => {
      expect(screen.queryByText(/Server is ready at/i)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Website generation finished/i),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Open website/i }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^Build$/i })).toBeEnabled();
    expect(backend.dispose).toHaveBeenCalled();
  });

  it('uses the Tailscale auth key when booting the VM', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async () => backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    fireEvent.change(screen.getByLabelText(/Tailscale auth key/i), {
      target: { value: 'tskey-auth-test' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() => expect(appMocks.createBackend).toHaveBeenCalledTimes(1));
    expect(appMocks.createBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        tailscaleAuthKey: 'tskey-auth-test',
      }),
    );
  });

  it('checkpoints the workspace before disposing it after a Tailscale key change', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockResolvedValue(backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));
    await screen.findByText(/Server is ready at/i);
    await waitForManagedRunToFinish();

    const [project] = await testVault.listProjects();
    const headBeforeKeyChange = (await testVault.getProject(project.id))
      ?.headCheckpointId;
    const order: string[] = [];
    backend.createWorkspaceArchive.mockClear();
    backend.createWorkspaceArchive.mockImplementation(async () => {
      order.push('checkpoint-archive');
      return new Blob(['checkpoint after Tailscale key change']);
    });
    backend.dispose.mockImplementation(async () => {
      order.push('backend-dispose');
    });

    fireEvent.click(screen.getByRole('button', { name: /Setup/i }));
    fireEvent.change(screen.getByLabelText(/Tailscale auth key/i), {
      target: { value: 'tskey-auth-updated-key' },
    });

    await waitFor(() => expect(backend.dispose).toHaveBeenCalled());
    expect(order.indexOf('checkpoint-archive')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('checkpoint-archive')).toBeLessThan(
      order.indexOf('backend-dispose'),
    );
    await waitFor(async () => {
      expect((await testVault.getProject(project.id))?.headCheckpointId).not.toBe(
        headBeforeKeyChange,
      );
    });
  });

  it('renders markdown summaries, hides model turns, and rewrites localhost preview URLs', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async () => backend);
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) => {
        options.onEvent?.({
          type: 'model',
          message: `Calling ${MODEL_ID}, turn 1`,
        });
        options.onEvent?.({
          type: 'done',
          message:
            '### Features\n\n- **Interactive physics**\n\nThe server is running at `http://localhost:8080`.',
        });
        return completeHarnessRun(options, {
          finalText:
            '### Features\n\n- **Interactive physics**\n\nThe server is running at `http://localhost:8080`.',
          changedFiles: ['index.html'],
        });
      },
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(
      await screen.findByRole('heading', { name: /Features/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Interactive physics')).toBeInTheDocument();
    expect(screen.queryByText(/turn 1/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/localhost:8080/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/100\.64\.0\.25:8080/i).length).toBeGreaterThan(0);
  });

  it('persists and resumes the coding-harness session after an App remount', async () => {
    const firstSession = harnessSession(
      'Create the initial app.',
      'interaction-first',
      'durable-session',
    );
    const secondSession: CodingHarnessSession = {
      ...firstSession,
      updatedAt: '2026-08-27T12:01:00.000Z',
      previousInteractionId: 'interaction-second',
      transcript: [
        ...firstSession.transcript,
        {
          id: 'follow-up-user',
          createdAt: '2026-08-27T12:00:59.000Z',
          role: 'user',
          kind: 'message',
          content: 'Add keyboard navigation.',
        },
      ],
    };
    const firstBackend = fakeBackend();
    const resumedBackend = fakeBackend();
    appMocks.createBackend
      .mockResolvedValueOnce(firstBackend)
      .mockResolvedValueOnce(resumedBackend);
    appMocks.runHarness
      .mockImplementationOnce(async (options: CodingHarnessRunOptions) => {
        expect(options.session).toBeNull();
        return completeHarnessRun(options, {
          finalText: 'Initial app complete.',
          session: firstSession,
        });
      })
      .mockImplementationOnce(async (options: CodingHarnessRunOptions) =>
        completeHarnessRun(options, {
          finalText: 'Keyboard navigation added.',
          session: secondSession,
        }),
      );

    const firstRender = render(<App />);
    fireEvent.change(screen.getByLabelText(/Project name/i), {
      target: { value: 'Resume harness project' },
    });
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: 'Create the initial app.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await screen.findByText(/Server is ready at/i);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /^Stop$/i }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(async () =>
      expect((await testVault.listProjects())[0]?.name).toBe(
        'Resume harness project',
      ),
    );
    expect(window.localStorage.getItem('sparkrun.projects.v1')).toBeNull();
    firstRender.unmount();

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Resume harness project' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/Project name/i)).toHaveValue(
        'Resume harness project',
      ),
    );
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: 'Add keyboard navigation.' },
    });
    fireEvent.click(
      await screen.findByRole('button', { name: /^(?:Build|Update)$/i }),
    );

    await waitFor(() => expect(appMocks.runHarness).toHaveBeenCalledTimes(2));
    const resumedOptions = appMocks.runHarness.mock.calls[1][0] as
      CodingHarnessRunOptions;
    expect(resumedOptions.prompt).toBe('Add keyboard navigation.');
    expect(resumedOptions.session).toMatchObject({
      id: 'durable-session',
      previousInteractionId: 'interaction-first',
      provider: 'google-interactions',
    });
    expect(resumedOptions.session?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'Create the initial app.' }),
      ]),
    );
    expect(resumedBackend.restoreWorkspaceArchive).toHaveBeenCalledTimes(1);
  });

  it('completes a non-web coding task without starting a preview server', async () => {
    const backend = fakeBackend({
      files: [['README.md', '# Tooling notes\n']],
    });
    appMocks.createBackend.mockResolvedValue(backend);
    appMocks.runHarness.mockImplementation(
      async (options: CodingHarnessRunOptions) =>
        completeHarnessRun(options, {
          finalText: 'Updated the repository documentation.',
          changedFiles: ['README.md'],
        }),
    );

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.change(screen.getByLabelText(/Coding request/i), {
      target: { value: 'Document the installed command-line tools.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(await screen.findByText(/Task complete/i)).toBeInTheDocument();
    expect(screen.getByText(/Updated the repository documentation/i)).toBeInTheDocument();
    expect(backend.startDefaultPreview).not.toHaveBeenCalled();
    expect(backend.checkPreview).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Live$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/live ·/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/—:auto/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Open website/i }),
    ).not.toBeInTheDocument();
  });
});
