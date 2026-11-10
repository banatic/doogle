// hub + 실제 src/tools 모듈(담당 B) 통합 테스트: 인자 검증, insert_image 준비, 시스템 프롬프트.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';

import { createHub } from '../src/hub.mjs';
import { loadTools } from '../src/tools-loader.mjs';

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let hub;
let dir;
let tools;

function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    queue.push(JSON.parse(String(d)));
    for (const w of [...waiters]) {
      const i = queue.findIndex(w.pred);
      if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); w.resolve(queue.splice(i, 1)[0]); }
    }
  });
  return {
    ws,
    open: () => new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }),
    send: (o) => ws.send(JSON.stringify(o)),
    next: (pred) => new Promise((resolve) => {
      const i = queue.findIndex(pred);
      if (i >= 0) resolve(queue.splice(i, 1)[0]);
      else waiters.push({ pred, resolve });
    }),
  };
}

before(async () => {
  tools = await loadTools();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-hub-real-'));
  await fs.writeFile(path.join(dir, 'a.png'), PNG);
  hub = await createHub({ port: 0, dataDir: dir, writeHubJson: false, providers: [], imageRoots: [dir], log: () => {} });
});
after(async () => {
  await hub.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('실제 tools 모듈이 로드되고 시스템 프롬프트에 TOOL_RULES가 들어감', () => {
  assert.equal(tools.stub, false, tools.loadError);
  assert.ok(tools.TOOLS.length > 10);
  assert.ok(tools.TOOL_RULES.length > 100);
  assert.ok(hub.systemPrompt.includes(tools.TOOL_RULES.trim().slice(0, 80)));
  assert.match(hub.systemPrompt, /두글/);
});

test('insert_image: agent는 imagePath를 hub가 읽어 base64로 넘기고, 허용 폴더 밖은 거절', async () => {
  const studio = connect(`ws://127.0.0.1:${hub.port}/studio?token=${hub.token}`);
  await studio.open();
  const base = { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0 };
  const pending = hub.callTool({ name: 'insert_image', args: { ...base, imagePath: path.join(dir, 'a.png') }, origin: 'agent' });
  const call = await studio.next((m) => m.type === 'tool_call');
  assert.equal(call.args.imageBase64, PNG.toString('base64'));
  assert.equal(call.args.naturalWidthPx, 1);
  assert.equal(call.args.imagePath, undefined);
  studio.send({ type: 'tool_result', callId: call.callId, ok: true, result: { ok: 1 } });
  assert.equal((await pending).ok, true);

  const outside = await hub.callTool({ name: 'insert_image', args: { ...base, imagePath: path.resolve(os.tmpdir(), '..', 'nope.png') }, origin: 'agent' });
  assert.equal(outside.ok, false);

  // doogle-mcp가 이미 준비한 인자(naturalWidthPx 포함)는 그대로 통과
  const prepared = await tools.prepareInsertImageArgs({ ...base, imageBase64: PNG.toString('base64'), extension: 'png' }, []);
  const p2 = hub.callTool({ name: 'insert_image', args: prepared, origin: 'mcp' });
  const call2 = await studio.next((m) => m.type === 'tool_call');
  assert.equal(call2.args.naturalHeightPx, 1);
  studio.send({ type: 'tool_result', callId: call2.callId, ok: true, result: {} });
  assert.equal((await p2).ok, true);
  studio.ws.close();
});

test('잘못된 인자는 studio로 가지 않음', async () => {
  const r = await hub.callTool({ name: 'replace_range', args: { nonsense: 1 }, origin: 'agent' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ARGS');
});
