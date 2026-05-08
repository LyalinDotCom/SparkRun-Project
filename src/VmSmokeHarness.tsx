import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Play, Server, Terminal, TriangleAlert } from 'lucide-react';
import { SERVER_PORT, SERVER_PORT_RANGE_END, SITE_ROOT } from './lib/constants';
import { WebVmBackend, type WebVmStatus } from './lib/webvm';

type SmokeState = 'idle' | 'running' | 'passed' | 'failed';

function readStoredTailKey(): string {
  try {
    const raw = window.localStorage.getItem('sparkrun.savedKeys.v1');
    if (!raw) {
      return '';
    }
    const parsed = JSON.parse(raw) as { tailscaleAuthKey?: unknown };
    return typeof parsed.tailscaleAuthKey === 'string' ? parsed.tailscaleAuthKey : '';
  } catch {
    return '';
  }
}

function envTailKey(): string {
  const meta = import.meta as ImportMeta & {
    env?: { VITE_TAILSCALE_AUTH_KEY?: string };
  };
  return meta.env?.VITE_TAILSCALE_AUTH_KEY ?? '';
}

function resolveTailKey(): { value: string; source: string } {
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get('tailkey')?.trim();
  if (queryValue) {
    return { value: queryValue, source: 'query string' };
  }
  const envValue = envTailKey().trim();
  if (envValue) {
    return { value: envValue, source: '.env' };
  }
  const storedValue = readStoredTailKey().trim();
  if (storedValue) {
    return { value: storedValue, source: 'browser storage' };
  }
  return { value: '', source: '' };
}

function timestamp(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function collectVmDiagnostics(vm: WebVmBackend, label: string): Promise<string> {
  const command = [
    "echo '--- " + label + " ---'",
    "echo '--- ip addr ---'",
    "(ip addr || ifconfig -a || true) 2>&1",
    "echo '--- /proc/net/tcp ---'",
    "(cat /proc/net/tcp | head -20 || true) 2>&1",
    "echo '--- tailscaled ---'",
    "(pgrep -a tailscaled || echo 'no tailscaled') 2>&1",
    "echo '--- /var/run/tailscale ---'",
    "(ls -la /var/run/tailscale 2>/dev/null || echo 'no /var/run/tailscale') 2>&1",
    "echo '--- tailscale status ---'",
    "(if command -v tailscale >/dev/null 2>&1; then tailscale status 2>&1 | head -20; else echo 'no tailscale cli'; fi)",
  ].join('\n');
  const result = await vm.runCommand(command, {
    cwd: SITE_ROOT,
    timeoutMs: 8_000,
  });
  return `diagnostics status=${result.status}\n${result.output}`;
}

async function checkTailnetFromBrowser(url: string): Promise<{
  status: number;
  output: string;
}> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(url, {
      cache: 'no-store',
      mode: 'no-cors',
      signal: controller.signal,
    });
    return {
      status: 0,
      output: `browser: reachable at ${url}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 1,
      output: `browser: Tailnet fetch failed for ${url}: ${message}`,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export default function VmSmokeHarness() {
  const [state, setState] = useState<SmokeState>('idle');
  const [status, setStatus] = useState<WebVmStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [tailKeySource, setTailKeySource] = useState('');
  const runIdRef = useRef(0);
  const logRef = useRef<HTMLPreElement | null>(null);

  const append = (message: string) => {
    setLogs((current) => [...current, `[${timestamp()}] ${message}`].slice(-400));
  };

  const run = async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setState('running');
    setLogs([]);
    setStatus(null);

    const tailKey = resolveTailKey();
    setTailKeySource(tailKey.source);
    append(
      tailKey.value
        ? `Tailnet auth key loaded from ${tailKey.source}`
        : 'No Tailnet auth key loaded',
    );
    if (!tailKey.value) {
      setState('failed');
      append('VITE_TAILSCALE_AUTH_KEY is required for the full smoke test.');
      return;
    }

    try {
      append('Booting WebVM smoke harness');
      const vm = await WebVmBackend.create({
        tailscaleAuthKey: tailKey.value || undefined,
        onStatus: (next) => {
          setStatus(next);
          append(
            `status ${next.lifecycle}: ${next.message}${
              next.previewUrl ? ` (${next.previewUrl})` : ''
            }`,
          );
        },
        onDebug: (entry) => {
          const lines = [
            `${entry.phase}${entry.status !== undefined ? ` status=${entry.status}` : ''}`,
            entry.command ? `$ ${entry.command}` : '',
            entry.output ?? '',
          ].filter(Boolean);
          append(lines.join('\n'));
        },
      });
      if (runIdRef.current !== runId) return;

      append('Resetting /workspace/site');
      await vm.resetWorkspace();
      append('Writing smoke index.html');
      await vm.writeText(
        'index.html',
        '<!doctype html><html><head><title>SparkRun smoke</title></head><body><h1>SparkRun VM smoke passed</h1></body></html>',
      );

      append('Connecting Tailnet before server start');
      await vm.connectTailnet({ timeoutMs: 20_000 });
      append(`Tailnet IP before server: ${vm.getTailnetIp() ?? 'not available yet'}`);
      append(await collectVmDiagnostics(vm, 'before server start'));

      append(
        `Starting Python server on 0.0.0.0, trying ports ${SERVER_PORT}-${SERVER_PORT_RANGE_END}`,
      );
      const start = await vm.startServer();
      append(`server start status=${start.status}\n${start.output}`);
      if (start.status !== 0) {
        append(await collectVmDiagnostics(vm, 'after server start failure'));
        throw new Error('VM server failed to start.');
      }

      append('Checking internal VM HTTP endpoint');
      const health = await vm.checkServer();
      append(`health status=${health.status}\n${health.output}`);

      if (health.status !== 0) {
        throw new Error('Internal VM health check failed.');
      }

      const tailnetUrl = vm.getPreviewUrl();
      append(`Tailnet URL: ${tailnetUrl ?? 'not available yet'}`);
      if (!tailnetUrl) {
        throw new Error('Tailnet URL was not available after server start.');
      }

      append('Checking Tailnet URL from the browser side');
      const tailnetHealth = await checkTailnetFromBrowser(tailnetUrl);
      append(`tailnet browser status=${tailnetHealth.status}\n${tailnetHealth.output}`);
      if (tailnetHealth.status !== 0) {
        throw new Error('Browser-side Tailnet health check failed.');
      }

      setState('passed');
    } catch (error) {
      append(error instanceof Error ? error.message : String(error));
      setState('failed');
    }
  };

  useEffect(() => {
    void run();
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    window.localStorage.setItem('sparkrun.vmSmokeLogs', logs.join('\n'));
  }, [logs]);

  const previewUrl = status?.previewUrl ?? null;

  return (
    <main className="smoke-page">
      <section className="smoke-card">
        <div className="smoke-head">
          <div>
            <p className="eyebrow">VM smoke harness</p>
            <h1>WebVM server test</h1>
            <p>
              Boots CheerpX, writes a one-file site, starts the VM HTTP server,
              and checks it from inside Linux.
            </p>
          </div>
          <button disabled={state === 'running'} onClick={() => void run()} type="button">
            <Play size={14} aria-hidden="true" />
            Run smoke
          </button>
        </div>

        <div className="smoke-status">
          <span className={`pill ${state === 'passed' ? 'ok' : state === 'failed' ? 'err' : 'run'}`}>
            {state === 'passed' ? (
              <CheckCircle2 size={12} aria-hidden="true" />
            ) : state === 'failed' ? (
              <TriangleAlert size={12} aria-hidden="true" />
            ) : (
              <Server size={12} aria-hidden="true" />
            )}
            {state}
          </span>
          <span className="pill">{status?.lifecycle ?? 'no vm status'}</span>
          <span className="pill">
            {previewUrl ?? (status?.serverPort ? `:${status.serverPort}` : ':auto')}
          </span>
        </div>

        <pre className="smoke-log" ref={logRef}>
          {logs.length ? logs.join('\n') : 'Waiting for harness output...'}
        </pre>

        <div className="smoke-foot">
          <Terminal size={14} aria-hidden="true" />
          <span>
            {tailKeySource ? (
              <>
                Tailnet auth key loaded from <code>{tailKeySource}</code>.
              </>
            ) : (
              <>
                Add <code>VITE_TAILSCALE_AUTH_KEY</code> to a local <code>.env</code>{' '}
                or reuse saved browser keys to include Tailnet in this smoke run.
              </>
            )}
          </span>
        </div>
      </section>
    </main>
  );
}
