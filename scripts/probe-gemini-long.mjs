#!/usr/bin/env node
// Long-generation probe for one model.
//   node scripts/probe-gemini-long.mjs --mode sync|bg|stream --thinking high --model gemini-3.7-flash --lines 350 --attempts 1
import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
function dotenv(name) { try { const m = new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync('.env', 'utf8')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; } catch { return ''; } }
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const apiKey = process.env.GEMINI_API_KEY || dotenv('GEMINI_API_KEY');
const mode = arg('--mode', 'bg'), thinking = arg('--thinking', 'high'), model = arg('--model', 'gemini-3.7-flash');
const lines = Number(arg('--lines', '350')), attempts = Number(arg('--attempts', '1'));
const client = new GoogleGenAI({ apiKey });
const describe = (e) => ({ name: e?.name, status: e?.status ?? e?.code, message: String(e?.message ?? e).slice(0, 160) });
const params = {
  model,
  system_instruction: 'You are a coding agent. Produce complete files when asked.',
  generation_config: { thinking_level: thinking },
  input: `Write a complete single-file index.html (about ${lines} lines) implementing a Three.js solar system with an import map, eight planets, orbit rings, a starfield, and OrbitControls. Output the entire file in one code block.`,
};
const tag = `[${mode}/${thinking}/${model}/${lines}l]`;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  try {
    if (mode === 'sync') {
      const r = await client.interactions.create(params, { timeout: 8 * 60_000, maxRetries: 0 });
      console.log(`${tag} #${attempt} sync ${r.status} output_len=${(r.output_text ?? '').length} in ${secs()}s out=${r.usage?.total_output_tokens} thought=${r.usage?.total_thought_tokens}`);
    } else if (mode === 'stream') {
      const stream = await client.interactions.create({ ...params, stream: true }, { timeout: 8 * 60_000, maxRetries: 0 });
      let text = '', events = 0, last = null, firstDeltaAt = null;
      for await (const ev of stream) {
        events += 1;
        const type = ev?.event_type ?? ev?.type ?? '';
        if (/delta/.test(type) && typeof ev?.delta?.text === 'string') { text += ev.delta.text; if (!firstDeltaAt) firstDeltaAt = secs(); }
        if (/complete|failed|error/.test(type)) last = ev;
      }
      console.log(`${tag} #${attempt} stream done events=${events} text_len=${text.length} first_delta=${firstDeltaAt}s in ${secs()}s last=${JSON.stringify(last?.event_type ?? last?.type ?? null)} status=${last?.interaction?.status ?? ''}`);
    } else {
      let cur = await client.interactions.create({ ...params, background: true }, { timeout: 15_000, maxRetries: 0 });
      let polls = 0, died = false;
      while (cur.status === 'queued' || cur.status === 'in_progress') {
        await new Promise((r) => setTimeout(r, 4000)); polls += 1;
        try { cur = await client.interactions.get(cur.id, undefined, { timeout: 15_000, maxRetries: 0 }); }
        catch (e) { console.log(`${tag} #${attempt} DIED poll ${polls} at ${secs()}s: ${JSON.stringify(describe(e))}`); died = true; break; }
      }
      if (!died) console.log(`${tag} #${attempt} bg ${cur.status} output_len=${(cur.output_text ?? '').length} in ${secs()}s out=${cur.usage?.total_output_tokens} thought=${cur.usage?.total_thought_tokens}`);
    }
  } catch (e) {
    console.log(`${tag} #${attempt} FAILED at ${secs()}s: ${JSON.stringify(describe(e))}`);
  }
}
