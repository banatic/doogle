#!/usr/bin/env node
// 하네스 디버깅: 문서 하나를 열고 사이드바 상태·스크린샷을 남긴다.
//   node eval/debug.mjs <fixture> [prompt]
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureStudioServer, FIXTURE_DIR, launchBrowser, openSession, REPO_ROOT } from './lib/session.mjs';

const [doc = 'biz_plan.hwp', prompt] = process.argv.slice(2);
const out = path.join(REPO_ROOT, 'output', 'agent-eval', 'debug');
await fs.mkdir(out, { recursive: true });
const server = await ensureStudioServer({ log: console.error });
const browser = await launchBrowser();
const provider = (await import('../src/providers/claude-sdk.mjs')).default;
const session = await openSession({ browser, studioUrl: server.url, provider, log: console.error });
try {
  await session.openDocument(path.join(FIXTURE_DIR, doc));
  const state = () => session.page.evaluate(() => ({
    send: (() => { const b = document.querySelector('.dg-send'); return b ? { disabled: b.disabled, title: b.title } : null; })(),
    input: !!document.querySelector('.dg-input'),
    model: document.querySelector('.dg-model, [class*="dg-model"]')?.textContent ?? null,
    notices: [...document.querySelectorAll('.dg-notice, .dg-conn, .dg-card')].map((n) => n.textContent?.slice(0, 200)),
  }));
  console.log(JSON.stringify(await state(), null, 2));
  await session.page.screenshot({ path: path.join(out, 'before-send.png') });
  if (prompt) {
    const turn = await session.send(prompt, { timeoutMs: 180_000 }).catch((e) => ({ error: String(e) }));
    console.log(JSON.stringify(turn, null, 2).slice(0, 6000));
    console.log(JSON.stringify(await state(), null, 2));
    await session.page.screenshot({ path: path.join(out, 'after-send.png') });
  }
  console.log('console errors:', session.consoleErrors.slice(0, 10));
} finally {
  await session.close();
  await browser.close();
  await server.stop();
}
