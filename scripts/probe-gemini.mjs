#!/usr/bin/env node
/**
 * Maintainer-side Gemini Interactions probe.
 *
 * Reproduces the exact request shape SparkRun's browser harness sends
 * (system instruction, function tools with integer bounds, thinking_level,
 * background execution, previous_interaction_id continuation with a
 * function_result) from Node, so a provider 4xx can be read in full instead of
 * through the app's redacted status line.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/probe-gemini.mjs
 *   node scripts/probe-gemini.mjs            # reads GEMINI_API_KEY from .env
 *   node scripts/probe-gemini.mjs --model gemini-3.7-flash --thinking high
 *
 * The key never leaves this process except to Google's API. Nothing here is
 * bundled into the browser app.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GoogleGenAI } from '@google/genai';

function readDotEnvKey(name) {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && match[1] === name) {
        return match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // .env is optional.
  }
  return '';
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : fallback;
}

const apiKey = process.env.GEMINI_API_KEY || readDotEnvKey('GEMINI_API_KEY');
if (!apiKey) {
  console.error(
    'GEMINI_API_KEY is not set. Export it or add it to the untracked .env file.',
  );
  process.exit(2);
}
const model = argValue('--model', 'gemini-3.7-flash');
const thinkingLevel = argValue('--thinking', 'high');
const pollIntervalMs = 3_000;
const turnTimeoutMs = 4 * 60_000;

// Same declaration style as src/lib/codingHarnessTools.ts, including the
// integer minimum/maximum bounds, so schema rejections reproduce here.
const tools = [
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a UTF-8 text file in the durable workspace.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to the workspace root.' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['file_path'],
    },
  },
  {
    type: 'function',
    name: 'run_command',
    description: 'Run a shell command inside the isolated Linux VM.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1_000, maximum: 600_000 },
      },
      required: ['command'],
    },
  },
  {
    type: 'function',
    name: 'start_preview',
    description: 'Start the project web server and expose it on the private preview network.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        port: { type: 'integer', minimum: 1024, maximum: 65535 },
        cwd: { type: 'string' },
      },
      required: ['command', 'port'],
    },
  },
];

const systemInstruction = [
  "You are SparkRun's coding agent operating an isolated Linux VM through tools.",
  'When the user asks you to read a file, call read_file exactly once with the given path, then answer with the single word DONE.',
].join('\n');

const client = new GoogleGenAI({ apiKey });
const requestOptions = { timeout: 15_000, maxRetries: 0 };

function describeError(error) {
  const record = error && typeof error === 'object' ? error : {};
  return {
    name: record.name,
    status: record.status ?? record.code,
    message: record.message,
    ...(record.error ? { error: record.error } : {}),
    ...(record.body ? { body: record.body } : {}),
  };
}

async function waitForTerminal(interaction) {
  const startedAt = Date.now();
  let current = interaction;
  let polls = 0;
  while (current.status === 'queued' || current.status === 'in_progress') {
    if (Date.now() - startedAt > turnTimeoutMs) {
      throw new Error(`Interaction ${current.id} still ${current.status} after ${turnTimeoutMs}ms.`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    polls += 1;
    current = await client.interactions.get(current.id, undefined, requestOptions);
    process.stdout.write(`  poll ${polls}: ${current.status}\n`);
  }
  return current;
}

async function step(label, params) {
  console.log(`\n== ${label} ==`);
  console.log(JSON.stringify({ ...params, system_instruction: '[omitted]', tools: params.tools ? `[${params.tools.length} tools]` : undefined }, null, 2));
  const startedAt = Date.now();
  let accepted;
  try {
    accepted = await client.interactions.create({ ...params, background: true }, requestOptions);
  } catch (error) {
    console.error('create FAILED:', JSON.stringify(describeError(error), null, 2));
    throw error;
  }
  console.log(`accepted ${accepted.id} status=${accepted.status} in ${Date.now() - startedAt}ms`);
  const terminal = await waitForTerminal(accepted);
  console.log(`terminal status=${terminal.status} after ${Date.now() - startedAt}ms`);
  if (terminal.errors?.length) console.log('errors:', JSON.stringify(terminal.errors, null, 2));
  const steps = terminal.steps ?? [];
  for (const s of steps) {
    if (s.type === 'function_call') console.log('function_call:', JSON.stringify({ id: s.id, name: s.name, arguments: s.arguments }));
  }
  if (terminal.output_text) console.log('output_text:', terminal.output_text.slice(0, 500));
  if (terminal.usage) console.log('usage:', JSON.stringify(terminal.usage));
  return terminal;
}

const base = {
  model,
  system_instruction: systemInstruction,
  generation_config: { thinking_level: thinkingLevel },
  tools,
};

try {
  // Phase 1: plain text, no tool expected.
  const first = await step('phase 1: text-only turn', {
    ...base,
    input: 'Reply with the single word OK and do not call any tool.',
  });
  if (first.status === 'failed') process.exit(1);

  // Phase 2: force a function call and continue with previous_interaction_id.
  const second = await step('phase 2: tool call', {
    ...base,
    input: 'Read the file src/app.js.',
  });
  const call = (second.steps ?? []).find((s) => s.type === 'function_call');
  if (!call) {
    console.log('Model did not call a tool; phase 3 skipped.');
    process.exit(second.status === 'completed' ? 0 : 1);
  }
  const third = await step('phase 3: function_result continuation', {
    ...base,
    previous_interaction_id: second.id,
    input: [
      {
        type: 'function_result',
        call_id: call.id,
        name: call.name,
        result: [{ type: 'text', text: "console.log('hello from app.js');" }],
      },
    ],
  });
  process.exit(third.status === 'completed' ? 0 : 1);
} catch (error) {
  console.error('\nPROBE FAILED:', JSON.stringify(describeError(error), null, 2));
  process.exit(1);
}
