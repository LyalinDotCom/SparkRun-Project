import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_ID } from './lib/constants';

const appMocks = vi.hoisted(() => ({
  createBackend: vi.fn(),
  runWebsiteAgent: vi.fn(),
}));

vi.mock('./lib/webvm', () => ({
  WebVmBackend: {
    create: appMocks.createBackend,
  },
}));

vi.mock('./lib/agent', () => ({
  runWebsiteAgent: appMocks.runWebsiteAgent,
}));

import App from './App';

function fakeBackend() {
  const files = new Map<string, string>([
    ['index.html', '<h1>Hello</h1>'],
    ['assets/site.css', 'body { color: teal; }'],
  ]);
  return {
    connectTailnet: vi.fn(async () => 'https://login.tailscale.com/a/abc'),
    getTailnetIp: vi.fn(() => '100.64.0.25'),
    getPreviewUrl: vi.fn(() => 'http://100.64.0.25:8080/'),
    listDirectory: vi.fn(async (path: string) => {
      if (!path) {
        return [
          { path: 'index.html', type: 'file' },
          { path: 'assets', type: 'directory' },
        ];
      }
      return [{ path: 'assets/site.css', type: 'file' }];
    }),
    readText: vi.fn(async (path: string) => files.get(path) ?? ''),
    writeText: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    resetWorkspace: vi.fn(async () => undefined),
    startServer: vi.fn(async () => ({
      status: 0,
      output: '4242',
      background: true,
    })),
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
    checkServer: vi.fn(async () => ({
      status: 0,
      output: 'internal: server process is listening on port 8081',
      background: false,
    })),
    stopServer: vi.fn(async () => ({
      status: 0,
      output: 'stopped',
      background: false,
    })),
    runCommand: vi.fn(async (command: string) => ({
      status: 0,
      output: command === 'pwd' ? '/workspace/site' : 'ok',
      background: false,
    })),
  };
}

function gotoChat() {
  fireEvent.click(screen.getByRole('button', { name: /Continue|Back to project/i }));
}

describe('SparkRun setup screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal('open', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200 })),
    );
    appMocks.runWebsiteAgent.mockResolvedValue({
      finalText: 'Website generation finished.',
      changedFiles: ['index.html'],
    });
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

  it('saves and reloads browser-cached projects', async () => {
    const { unmount } = render(<App />);

    fireEvent.change(screen.getByLabelText(/Project name/i), {
      target: { value: 'Hello app' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Project/i }));

    expect(window.localStorage.getItem('sparkrun.projects.v1')).toContain(
      'Hello app',
    );

    unmount();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hello app' }));
    expect(screen.getByLabelText(/Project name/i)).toHaveValue('Hello app');
  });

  it('falls back to "Untitled site" when the project name is cleared', () => {
    render(<App />);

    const input = screen.getByLabelText(/Project name/i);
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue('');

    fireEvent.blur(input);
    expect(input).toHaveValue('Untitled site');
  });
});

describe('SparkRun chat screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal('open', vi.fn());
    appMocks.runWebsiteAgent.mockResolvedValue({
      finalText: 'Website generation finished.',
      changedFiles: ['index.html'],
    });
  });

  it('exposes the configured model in the composer', () => {
    const { container } = render(<App />);
    gotoChat();
    expect(container.querySelector('.composer-model')?.textContent).toContain(
      MODEL_ID,
    );
    expect(screen.getByLabelText(/Website brief/i)).toBeInTheDocument();
  });

  it('blocks build until a Google AI key is present', async () => {
    render(<App />);
    gotoChat();

    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(
      await screen.findByText(/Google AI key is required before building/i),
    ).toBeInTheDocument();
    expect(appMocks.createBackend).not.toHaveBeenCalled();
    expect(appMocks.runWebsiteAgent).not.toHaveBeenCalled();
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

    await waitFor(() => expect(appMocks.runWebsiteAgent).toHaveBeenCalledTimes(1));
    expect(appMocks.runWebsiteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        backend,
      }),
    );
    expect(backend.startServer).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Site is live/i)).toBeInTheDocument();
    expect(screen.getByText(/server process is listening on port 8081/i)).toBeInTheDocument();
    expect(screen.getByText(/browser: reachable at/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open generated files/i }));
    expect(screen.getByRole('listbox', { name: /Generated files/i })).toBeInTheDocument();
    expect(screen.getByText('index.html')).toBeInTheDocument();
    expect(screen.getAllByText('14 B').length).toBeGreaterThan(0);
    expect(screen.getByText(/Website generation finished/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Open website/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open terminal/i }));
    fireEvent.change(screen.getByLabelText(/VM command/i), {
      target: { value: 'pwd' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }));
    expect(backend.startInteractiveShell).toHaveBeenCalledTimes(1);
    expect(backend.writeTerminalInput).toHaveBeenCalledWith('pwd\n');
    expect(screen.queryByText(/ttyname failed/i)).not.toBeInTheDocument();
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
    appMocks.runWebsiteAgent.mockImplementation(async (options) => {
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
        message: 'run_shell_command ls -R /workspace/site',
      });
      options.onEvent?.({
        type: 'error',
        message:
          'run_shell_command failed: Command is not allowed in this prototype: ls -R /workspace/site',
      });
      return {
        finalText: 'Done.',
        changedFiles: ['index.html'],
      };
    });

    const { container } = render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    expect(await screen.findByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('write index.html')).toBeInTheDocument();
    expect(screen.getByText('wrote index.html')).toBeInTheDocument();
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(
      Array.from(container.querySelectorAll('.log-label')).map((node) =>
        node.textContent?.trim(),
      ),
    ).not.toContain('Run');

    fireEvent.click(screen.getByRole('button', { name: /Open logs/i }));
    expect(await screen.findByText(/Diagnostics log/i)).toBeInTheDocument();
    expect(screen.getByText('$ pwd')).toBeInTheDocument();
    expect(screen.getByText('/workspace/site')).toBeInTheDocument();
  });

  it('keeps a successful build live when a generated file disappears during project snapshotting', async () => {
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

    expect(await screen.findByText(/Site is live/i)).toBeInTheDocument();
    expect(screen.getByText(/Could not snapshot ghost.js/i)).toBeInTheDocument();

    const rawProjects = window.localStorage.getItem('sparkrun.projects.v1') ?? '';
    expect(rawProjects).toContain('index.html');
    expect(rawProjects).not.toContain('ghost.js');
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

  it('renders markdown summaries, hides model turns, and rewrites localhost preview URLs', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async () => backend);
    appMocks.runWebsiteAgent.mockImplementation(async (options) => {
      options.onEvent?.({
        type: 'model',
        message: 'Calling gemini-3-flash-preview, turn 1',
      });
      options.onEvent?.({
        type: 'done',
        message:
          '### Features\n\n- **Interactive physics**\n\nThe server is running at `http://localhost:8080`.',
      });
      return {
        finalText:
          '### Features\n\n- **Interactive physics**\n\nThe server is running at `http://localhost:8080`.',
        changedFiles: ['index.html'],
      };
    });

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

  it('restores saved project files into the VM before continuing a project', async () => {
    window.localStorage.setItem(
      'sparkrun.projects.v1',
      JSON.stringify([
        {
          id: 'saved-project',
          name: 'Black hole sim',
          prompt: 'continue the black hole sim',
          previewUrl: 'http://100.64.0.25:8080/',
          updatedAt: new Date().toISOString(),
          files: [{ path: 'index.html', content: '<h1>Old sim</h1>' }],
        },
      ]),
    );
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async () => backend);

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Black hole sim' }),
    );
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    gotoChat();
    fireEvent.click(screen.getByRole('button', { name: /^Build$/i }));

    await waitFor(() =>
      expect(backend.writeText).toHaveBeenCalledWith(
        'index.html',
        '<h1>Old sim</h1>',
      ),
    );
    await waitFor(() => expect(appMocks.runWebsiteAgent).toHaveBeenCalledTimes(1));
  });
});
