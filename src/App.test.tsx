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
  return {
    connectTailnet: vi.fn(async () => 'https://login.tailscale.com/a/abc'),
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
    resetWorkspace: vi.fn(async () => undefined),
    startServer: vi.fn(async () => ({
      status: 0,
      output: '4242',
      background: true,
    })),
  };
}

describe('SparkRun app flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal('open', vi.fn());
    appMocks.runWebsiteAgent.mockResolvedValue({
      finalText: 'Website generation finished.',
      changedFiles: ['index.html'],
    });
  });

  it('shows the configured model and keeps keys as local form input', () => {
    render(<App />);

    expect(screen.getByText(MODEL_ID)).toBeInTheDocument();
    expect(screen.getByText(/keys stay in browser memory unless/i)).toBeInTheDocument();
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
    expect(screen.getByLabelText(/Remember keys on this browser/i)).toBeChecked();

    fireEvent.click(screen.getByLabelText(/Remember keys on this browser/i));
    expect(window.localStorage.getItem('sparkrun.savedKeys.v1')).toBeNull();
  });

  it('blocks build until a Google AI key is present', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /Build and Serve/i }));

    expect(
      await screen.findByText(/Google AI key is required before building/i),
    ).toBeInTheDocument();
    expect(appMocks.createBackend).not.toHaveBeenCalled();
    expect(appMocks.runWebsiteAgent).not.toHaveBeenCalled();
  });

  it('boots the VM, runs the agent, starts the server, and loads the iframe preview', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async (options) => {
      options.onStatus({
        lifecycle: 'tailnet-connected',
        message: 'Tailnet connected',
        tailnetIp: '100.64.0.25',
        loginUrl: null,
        previewUrl: 'http://100.64.0.25:8080/',
      });
      options.onConsole('boot ok\n');
      return backend;
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Google AI key/i), {
      target: { value: 'test-api-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Build and Serve/i }));

    await waitFor(() => expect(appMocks.runWebsiteAgent).toHaveBeenCalledTimes(1));
    expect(appMocks.runWebsiteAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-api-key',
        backend,
      }),
    );
    expect(backend.startServer).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('index.html')).toBeInTheDocument();
    expect(screen.getByText('assets/site.css')).toBeInTheDocument();
    expect(screen.getByTitle('VM hosted website preview')).toHaveAttribute(
      'src',
      '/__sparkrun_preview__/100.64.0.25:8080/',
    );
    expect(screen.getByText(/Website generation finished/i)).toBeInTheDocument();
  });

  it('uses the Tailscale auth key during boot and opens the manual login URL', async () => {
    const backend = fakeBackend();
    appMocks.createBackend.mockImplementation(async () => backend);

    render(<App />);
    fireEvent.change(screen.getByLabelText(/Tailscale auth key/i), {
      target: { value: 'tskey-auth-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Tailnet/i }));

    await waitFor(() => expect(appMocks.createBackend).toHaveBeenCalledTimes(1));
    expect(appMocks.createBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        tailscaleAuthKey: 'tskey-auth-test',
      }),
    );
    expect(backend.connectTailnet).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(
      'https://login.tailscale.com/a/abc',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
