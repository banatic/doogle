#!/usr/bin/env node
// 기록 요약 보기: node eval/show.mjs <tag>/<scenario> [argChars] [resultChars]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/session.mjs';

const [target, a = '500', r = '400'] = process.argv.slice(2);
const rec = JSON.parse(readFileSync(path.join(REPO_ROOT, 'output', 'agent-eval', target, 'transcript.json'), 'utf8'));
const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s; };
for (const c of rec.checks ?? []) console.log(`${c.pass ? '✔' : '✖'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
for (const [i, t] of rec.turns.entries()) {
  if (t.review) { console.log(`\n== review ${t.review} clicked=${t.clicked}`); continue; }
  console.log(`\n== turn ${i + 1}: ${t.prompt}\n   usage ${JSON.stringify(t.usage)} ${Math.round(t.durationMs / 1000)}s`);
  const calls = new Map(t.toolCalls.map((c) => [c.seq, c]));
  for (const item of t.timeline) {
    if (item.kind === 'text') console.log(`\n[model +${Math.round(item.t / 1000)}s] ${clip(item.text.trim(), 1200)}`);
    else if (item.kind === 'tool') {
      const c = calls.get(item.seq);
      console.log(`\n#${c.seq} ${c.name} ${c.ok ? 'OK' : 'ERR'} +${Math.round(c.t / 1000)}s ${c.ms}ms out=${c.resultChars}\n  > ${clip(c.args, Number(a))}\n  < ${clip(c.ok ? c.result : c.error, Number(r))}`);
    } else console.log(`\n[${item.kind}] ${clip(item, 300)}`);
  }
}
