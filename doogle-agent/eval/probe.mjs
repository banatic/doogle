#!/usr/bin/env node
// 하네스 탐침: 모델 없이 도구를 직접 불러 본다.
//   node eval/probe.mjs <fixture> <script.mjs>   — script 는 default export async ({session, tool, page}) => any
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureStudioServer, FIXTURE_DIR, launchBrowser, openSession } from './lib/session.mjs';

const [doc, script, mode = 'agent'] = process.argv.slice(2);
const server = await ensureStudioServer({ log: console.error });
const browser = await launchBrowser();
const provider = { id: 'none', label: 'none', detect: async () => ({ available: false, models: [] }), runTurn: async () => ({ messages: [] }) };
const session = await openSession({ browser, studioUrl: server.url, provider, mode, log: console.error });
try {
  await session.openDocument(path.join(FIXTURE_DIR, doc));
  const run = (await import(pathToFileURL(path.resolve(script)).href)).default;
  const out = await run({ session, tool: session.tool, page: session.page });
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  if (session.consoleErrors.length) console.log('console errors:', session.consoleErrors.slice(0, 10));
} finally {
  await session.close();
  await browser.close();
  await server.stop();
}
