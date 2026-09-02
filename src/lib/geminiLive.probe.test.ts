// @vitest-environment node
/**
 * Live provider probe for the real coding harness. Skipped unless
 * GEMINI_API_KEY is present in the environment, so CI and the normal suite
 * never touch the network:
 *
 *   GEMINI_API_KEY=... npx vitest run src/lib/geminiLive.probe.test.ts
 *
 * It drives GeminiInteractionsCodingHarness with the production system
 * instruction, tool declarations, and Debian environment notes against an
 * in-memory runtime that answers like the guest (no node/npm, python3 ok), so a
 * provider 4xx or an environment-blind model plan reproduces outside Chrome.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeminiInteractionsCodingHarness } from './geminiCodingHarness';
import { DEFAULT_WEBVM_DISK_PROFILE } from './constants';
import type {
  CodingHarnessEvent,
  CodingHarnessSession,
  CodingRuntime,
  CodingRuntimeCommandOptions,
  CodingRuntimeDirectoryEntry,
  CodingRuntimePreviewOptions,
  CodingRuntimePreviewResult,
} from './codingHarness';

const apiKey = process.env.GEMINI_API_KEY ?? '';
const outDir = process.env.SPARKRUN_LIVE_PROBE_OUT ?? '';

class GuestLikeRuntime implements CodingRuntime {
  readonly id = 'live-probe-runtime';
  readonly workspaceRoot = '/workspace/site';
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];
  readonly previews: CodingRuntimePreviewOptions[] = [];

  async readText(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`No such file: ${path}`);
    return content;
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async listDirectory(path: string): Promise<CodingRuntimeDirectoryEntry[]> {
    const prefix = path ? `${path}/` : '';
    const entries = new Map<string, CodingRuntimeDirectoryEntry>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest) continue;
      const [name, ...tail] = rest.split('/');
      entries.set(name, {
        path: `${prefix}${name}`,
        type: tail.length > 0 ? 'directory' : 'file',
      });
    }
    return [...entries.values()];
  }

  async runCommand(command: string, _options?: CodingRuntimeCommandOptions) {
    this.commands.push(command);
    if (/\b(?:node|npm|npx|pnpm|yarn|go|apt-get|apt|pip3?|curl|wget)\b/.test(command)) {
      const tool = /\b(node|npm|npx|pnpm|yarn|go|apt-get|apt|pip3?|curl|wget)\b/.exec(command)?.[1];
      return { status: 127, output: `bash: ${tool}: command not found` };
    }
    if (/^\s*ls\b/.test(command)) {
      return { status: 0, output: [...this.files.keys()].join('\n') };
    }
    if (/\bpython3\b/.test(command)) {
      return { status: 0, output: 'Python 3.7.3' };
    }
    return { status: 0, output: '' };
  }

  async startPreview(
    options: CodingRuntimePreviewOptions,
  ): Promise<CodingRuntimePreviewResult> {
    this.previews.push(options);
    return {
      status: 0,
      output: `Managed preview accepted an HTTP connection on port ${options.port}.`,
      background: true,
      port: options.port,
      url: `http://100.64.0.25:${options.port}`,
    };
  }
}

describe.skipIf(!apiKey)('live Gemini coding harness', () => {
  it(
    'builds a Three.js solar system without reaching for npm, then edits it in a second episode',
    async () => {
      const runtime = new GuestLikeRuntime();
      const events: CodingHarnessEvent[] = [];
      const harness = new GeminiInteractionsCodingHarness({
        apiKey,
        environmentInstruction: DEFAULT_WEBVM_DISK_PROFILE.agentEnvironmentNotes,
      });
      const log = (event: CodingHarnessEvent) => {
        events.push(event);
        process.stdout.write(`[${event.type}] ${event.message.slice(0, 300)}\n`);
      };

      let firstResult: Awaited<ReturnType<typeof harness.run>> | undefined;
      try {
      firstResult = await harness.run({
        prompt:
          'Build a Three.js solar system: sun, eight orbiting planets with distinct sizes and colors, orbit rings, a starfield, and OrbitControls, in a single index.html with an import map. Then start a preview.',
        runtime,
        onEvent: log,
        maxTurns: 40,
      });
      } finally {
        if (outDir) {
          mkdirSync(outDir, { recursive: true });
          for (const [path, content] of runtime.files) {
            writeFileSync(join(outDir, path.replace(/\//g, '__')), content);
          }
          writeFileSync(join(outDir, 'events-run1.json'), JSON.stringify({ events, commands: runtime.commands, previews: runtime.previews }, null, 2));
        }
      }
      const first = firstResult!;
      process.stdout.write(`FINAL 1: ${first.finalText}\n`);
      const dump = (label: string, extra: Record<string, unknown>) => {
        if (!outDir) return;
        mkdirSync(outDir, { recursive: true });
        for (const [path, content] of runtime.files) {
          const target = join(outDir, path);
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, content);
        }
        writeFileSync(
          join(outDir, `probe-log-${label}.json`),
          JSON.stringify({ events, commands: runtime.commands, previews: runtime.previews, ...extra }, null, 2),
        );
      };
      dump('run1', { first: first.finalText, transcript: first.session.transcript });
      const html = runtime.files.get('index.html') ?? '';
      expect(html).toMatch(/importmap/);
      expect(html).toMatch(/cdn\.jsdelivr\.net\/npm\/three@|unpkg\.com\/three@/);
      expect(html).toMatch(/OrbitControls/);
      expect(
        runtime.commands.filter((c) => /\b(npm|npx|node|vite)\b/.test(c)),
      ).toEqual([]);
      expect(first.session.model).toBe('gemini-3.7-flash');
      expect(first.reachedTurnBudget).toBe(false);

      const session: CodingHarnessSession = first.session;
      const second = await harness.run({
        prompt: 'Make the sun 25% larger. Do not touch anything else.',
        runtime,
        session,
        onEvent: log,
        maxTurns: 20,
      });
      process.stdout.write(`FINAL 2: ${second.finalText}\n`);
      dump('run2', { second: second.finalText, transcript: second.session.transcript });
      expect(second.reachedTurnBudget).toBe(false);
      expect(runtime.files.get('index.html')).not.toBe(html);

    },
    15 * 60_000,
  );
});
