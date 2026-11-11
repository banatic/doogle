#!/usr/bin/env node
// 두글 에이전트 평가 실행기.
//
//   node eval/run.mjs --dump                      # 문서별 구조만 덤프 (모델 호출 없음)
//   node eval/run.mjs                             # 모든 시나리오
//   node eval/run.mjs --only typo-fix,table-row   # 일부만
//   node eval/run.mjs --model claude-sonnet-5-5 --mode full --parallel 3 --tag after-fix
//
// 결과: <repo>/output/agent-eval/<tag>/<scenario>/{transcript.json, audit.md, before.txt, after.txt, diff.txt, page-N.png, screen.png}
//       <repo>/output/agent-eval/<tag>/summary.{json,md}
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { auditTurn, renderAudit, renderSummary, textDiff } from './lib/audit.mjs';
import { ensureStudioServer, FIXTURE_DIR, launchBrowser, openSession, REPO_ROOT } from './lib/session.mjs';
import { SCENARIOS } from './scenarios.mjs';

function parseArgs(argv) {
  const out = { only: null, model: 'default', mode: null, parallel: 2, tag: null, dump: false, headful: false, provider: 'claude-sdk', port: 7700, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--only') out.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--model') out.model = next();
    else if (a === '--mode') out.mode = next();
    else if (a === '--parallel') out.parallel = Math.max(1, Number(next()) || 1);
    else if (a === '--tag') out.tag = next();
    else if (a === '--provider') out.provider = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--repeat') out.repeat = Math.max(1, Number(next()) || 1);
    else if (a === '--dump') out.dump = true;
    else if (a === '--headful') out.headful = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const log = (m) => process.stderr.write(`${m}\n`);

async function loadProvider(id) {
  const mod = await import(`../src/providers/${id}.mjs`);
  return mod.default;
}

async function savePages(session, dir, pages) {
  for (const pageIndex of pages.slice(0, 4)) {
    const r = await session.tool('render_page', { pageIndex, scale: 1 });
    const b64 = r.ok ? r.result?.image?.base64 ?? r.result?.image?.data : null;
    if (b64) await fs.writeFile(path.join(dir, `page-${pageIndex}.png`), Buffer.from(b64, 'base64'));
  }
}

async function runScenario(scenario, ctx) {
  const dir = path.join(ctx.outDir, scenario.id);
  await fs.mkdir(dir, { recursive: true });
  const started = Date.now();
  const session = await openSession({
    browser: ctx.browser, studioUrl: ctx.studioUrl, provider: ctx.provider,
    mode: ctx.mode ?? scenario.mode ?? 'agent', model: ctx.model, log,
  });
  const record = { id: scenario.id, doc: scenario.doc, mode: ctx.mode ?? scenario.mode ?? 'agent', model: ctx.model, turns: [], checks: [], error: null };
  try {
    await session.openDocument(path.join(FIXTURE_DIR, scenario.doc));
    const before = await session.structure();
    await fs.writeFile(path.join(dir, 'before.txt'), before, 'utf8');
    if (ctx.dump) return { ...record, dumped: true };

    const prompts = Array.isArray(scenario.turns) ? scenario.turns : [scenario.prompt];
    for (const [i, item] of prompts.entries()) {
      const turnSpec = typeof item === 'string' ? { prompt: item } : item;
      if (turnSpec.review) {
        const clicked = await session.review(turnSpec.review);
        record.turns.push({ review: turnSpec.review, clicked });
        continue;
      }
      log(`▶ ${scenario.id} [${i + 1}/${prompts.length}] ${turnSpec.prompt.slice(0, 60)}`);
      // 참고 파일: 이 턴의 요청과 함께 올린다 (eval/.fixtures 기준 경로)
      if (Array.isArray(turnSpec.attach) && turnSpec.attach.length > 0) {
        await session.attach(turnSpec.attach.map((f) => path.join(FIXTURE_DIR, f)));
      }
      const turn = await session.send(turnSpec.prompt, { timeoutMs: scenario.timeoutMs });
      for (const [n, image] of turn.images.entries()) {
        await fs.writeFile(path.join(dir, `turn${i + 1}-tool-image-${n}.png`), Buffer.from(image.base64, 'base64'));
      }
      delete turn.images;
      record.turns.push({ prompt: turnSpec.prompt, ...(turnSpec.attach ? { attach: turnSpec.attach } : {}), ...turn });
    }

    const after = await session.structure();
    await fs.writeFile(path.join(dir, 'after.txt'), after, 'utf8');
    await fs.writeFile(path.join(dir, 'diff.txt'), textDiff(before, after), 'utf8');
    const info = await session.tool('get_document_info');
    record.pendingReview = info.ok ? info.result?.pendingReview : null;
    record.pageCount = info.ok ? info.result?.pageCount : null;
    await session.page.screenshot({ path: path.join(dir, 'screen.png') }).catch(() => {});
    const touched = new Set();
    for (const t of record.turns) {
      for (const c of t.toolCalls ?? []) for (const p of c.result?.after?.pages ?? []) touched.add(p);
    }
    await savePages(session, dir, touched.size > 0 ? [...touched].sort((a, b) => a - b) : [0]);

    if (typeof scenario.check === 'function') {
      try {
        const checks = await scenario.check({ before, after, record, tool: session.tool, structure: session.structure });
        record.checks = (Array.isArray(checks) ? checks : []).map((c) => ({ name: c.name, pass: !!c.pass, ...(c.detail ? { detail: String(c.detail).slice(0, 400) } : {}) }));
      } catch (err) {
        record.checks = [{ name: 'check threw', pass: false, detail: String(err?.message ?? err) }];
      }
    }
    record.consoleErrors = session.consoleErrors.slice(0, 20);
  } catch (err) {
    record.error = String(err?.stack ?? err);
    await session.page.screenshot({ path: path.join(dir, 'error.png') }).catch(() => {});
    log(`✖ ${scenario.id}: ${err?.message ?? err}`);
  } finally {
    record.durationMs = Date.now() - started;
    await session.close();
  }
  record.audit = record.turns.filter((t) => t.toolCalls).map((t) => auditTurn(t));
  await fs.writeFile(path.join(dir, 'transcript.json'), JSON.stringify(record, null, 2), 'utf8');
  await fs.writeFile(path.join(dir, 'audit.md'), renderAudit(record), 'utf8');
  const failed = record.checks.filter((c) => !c.pass).length;
  log(`${record.error ? '✖' : failed ? '△' : '✔'} ${scenario.id} — ${Math.round(record.durationMs / 1000)}s, tools ${record.audit.reduce((n, a) => n + a.toolCalls, 0)}, errors ${record.audit.reduce((n, a) => n + a.toolErrors, 0)}${failed ? `, checks failed ${failed}` : ''}`);
  return record;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let scenarios = SCENARIOS;
  if (opts.only) {
    scenarios = SCENARIOS.filter((s) => opts.only.some((o) => s.id === o || s.id.startsWith(o)));
    if (scenarios.length === 0) throw new Error(`해당 시나리오 없음: ${opts.only.join(',')}`);
  }
  if (opts.dump) {
    const seen = new Set();
    scenarios = scenarios.filter((s) => !seen.has(s.doc) && seen.add(s.doc)).map((s) => ({ id: `dump-${s.doc.replace(/[^\w가-힣.-]+/g, '_')}`, doc: s.doc }));
  }
  if (opts.repeat > 1) scenarios = scenarios.flatMap((s) => Array.from({ length: opts.repeat }, (_, i) => ({ ...s, id: `${s.id}#${i + 1}` })));
  const tag = opts.tag ?? (opts.dump ? 'dump' : stamp());
  const outDir = path.join(REPO_ROOT, 'output', 'agent-eval', tag);
  await fs.mkdir(outDir, { recursive: true });

  const server = await ensureStudioServer({ port: opts.port, log });
  const browser = await launchBrowser({ headless: !opts.headful });
  const provider = opts.dump ? { id: 'none', label: 'none', detect: async () => ({ available: false, models: [] }), runTurn: async () => ({ messages: [] }) } : await loadProvider(opts.provider);
  const ctx = { browser, studioUrl: server.url, provider, model: opts.model, mode: opts.mode, outDir, dump: opts.dump };

  const records = [];
  const queue = [...scenarios];
  const workers = Array.from({ length: Math.min(opts.parallel, queue.length) }, async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      records.push(await runScenario(s, ctx));
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    await browser.close().catch(() => {});
    await server.stop();
  }
  records.sort((a, b) => scenarios.findIndex((s) => s.id === a.id) - scenarios.findIndex((s) => s.id === b.id));
  if (!opts.dump) {
    await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(records.map(({ turns: _t, ...r }) => r), null, 2), 'utf8');
    await fs.writeFile(path.join(outDir, 'summary.md'), renderSummary(records, { tag, model: opts.model }), 'utf8');
  }
  log(`결과: ${outDir}`);
  process.exit(records.some((r) => r.error) ? 1 : 0);
}

main().catch((err) => {
  log(String(err?.stack ?? err));
  process.exit(2);
});
