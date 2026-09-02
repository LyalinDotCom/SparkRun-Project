#!/usr/bin/env node
/**
 * Characterize background-interaction failures: run a long generation in
 * background mode, poll it with raw error logging, and after any poll error
 * keep querying the same interaction id so we can see what the API reports
 * about it (failed status? 400? 404?). Reads GEMINI_API_KEY from env or .env.
 */
import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

function dotenv(name) {
  try {
    const m = new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync('.env', 'utf8'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}
const apiKey = process.env.GEMINI_API_KEY || dotenv('GEMINI_API_KEY');
if (!apiKey) { console.error('no key'); process.exit(2); }
const client = new GoogleGenAI({ apiKey });
const opts = { timeout: 15_000, maxRetries: 0 };
const attempts = Number(process.argv[2] ?? 4);

function describe(e) {
  const r = e && typeof e === 'object' ? e : {};
  return { name: r.name, status: r.status ?? r.code, message: String(r.message ?? e).slice(0, 400), body: r.body ?? r.error ?? undefined, headers: r.headers ? Object.fromEntries(Object.entries(r.headers).filter(([k]) => /retry|request-id|trace|x-goog/i.test(k))) : undefined };
}

async function inspectAfterError(id) {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const got = await client.interactions.get(id, undefined, opts);
      console.log(`  after-error GET ${i + 1}: status=${got.status} errors=${JSON.stringify(got.errors ?? null)} output_len=${(got.output_text ?? '').length}`);
    } catch (e) {
      console.log(`  after-error GET ${i + 1} threw:`, JSON.stringify(describe(e)));
    }
  }
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  console.log(`\n=== attempt ${attempt} ===`);
  let accepted;
  try {
    accepted = await client.interactions.create({
      model: 'gemini-3.7-flash',
      background: true,
      system_instruction: 'You are a coding agent. Produce complete files when asked.',
      generation_config: { thinking_level: 'high' },
      input: 'Write a complete single-file index.html (at least 350 lines) implementing a Three.js solar system with an import map, eight planets, orbit rings, a starfield, and OrbitControls. Output the entire file in one code block.',
    }, opts);
  } catch (e) {
    console.log('create threw:', JSON.stringify(describe(e)));
    continue;
  }
  console.log(`accepted ${accepted.id} status=${accepted.status}`);
  let current = accepted;
  let polls = 0;
  const started = Date.now();
  let sawError = false;
  while (current.status === 'queued' || current.status === 'in_progress') {
    await new Promise((r) => setTimeout(r, 4000));
    polls += 1;
    try {
      current = await client.interactions.get(current.id, undefined, opts);
      console.log(`  poll ${polls} (${Math.round((Date.now() - started) / 1000)}s): ${current.status}`);
    } catch (e) {
      console.log(`  poll ${polls} threw:`, JSON.stringify(describe(e)));
      sawError = true;
      await inspectAfterError(accepted.id);
      break;
    }
    if (polls > 60) break;
  }
  if (!sawError) {
    console.log(`  terminal ${current.status} output_len=${(current.output_text ?? '').length} errors=${JSON.stringify(current.errors ?? null)} usage=${JSON.stringify(current.usage ? { out: current.usage.total_output_tokens, thought: current.usage.total_thought_tokens } : null)}`);
  }
}
