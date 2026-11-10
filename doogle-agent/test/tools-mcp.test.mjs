// doogle-mcp stdio 서버 테스트 — 가짜 ws hub 를 띄우고 MCP SDK 클라이언트로 붙는다.
// 실행: node --test test/tools-mcp.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketServer } from 'ws';
import { TOOL_RULES, TOOLS } from '../src/tools/index.mjs';

const BIN = fileURLToPath(new URL('../bin/doogle-mcp.mjs', import.meta.url));
const TOKEN = 'test-token-123';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'doogle-mcp-test-'));

/** 가짜 hub: /mcp?token= 만 받고 tool_call 에 handler 결과로 답한다. */
async function startHub(hubJson, handler) {
  const calls = [];
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }) => {
      const url = new URL(req.url, 'http://x');
      return url.pathname === '/mcp' && url.searchParams.get('token') === TOKEN;
    },
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (sock) => {
    sock.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      calls.push(msg);
      const reply = handler(msg);
      if (reply) sock.send(JSON.stringify({ type: 'tool_result', callId: msg.callId, ...reply }));
    });
  });
  writeFileSync(hubJson, JSON.stringify({ port: wss.address().port, token: TOKEN, pid: process.pid, version: 1 }));
  return {
    calls,
    wss,
    dropClients: () => { for (const c of wss.clients) c.terminate(); },
    close: () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(resolve); }),
  };
}

async function startClient(hubJson) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...process.env, DOOGLE_HUB_JSON: hubJson },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'doogle-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

const text = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

function defaultHandler(msg) {
  if (msg.name === 'render_page') {
    return { ok: true, result: { revision: 2, pageIndex: msg.args.pageIndex, image: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' } } };
  }
  if (msg.name === 'find_text') return { ok: false, error: { code: 'NO_DOCUMENT', message: '두글에서 문서를 열어주세요' } };
  return { ok: true, result: { revision: 2, echo: msg.args } };
}

let hub;
let client;
const hubJson = path.join(tmp, 'hub.json');

before(async () => {
  hub = await startHub(hubJson, defaultHandler);
  client = await startClient(hubJson);
});

after(async () => {
  await client?.close();
  await hub?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('lists every document tool with JSON schemas and TOOL_RULES as instructions', async () => {
  const { tools } = await client.listTools();
  // 대화 제어 tool(질문 카드)은 두글 사이드바 대화 전용 — 외부 에이전트에는 싣지 않는다
  assert.deepEqual(tools.map((t) => t.name), TOOLS.filter((t) => t.kind !== 'control').map((t) => t.name));
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
  assert.equal(client.getInstructions(), TOOL_RULES);
});

test('forwards tool_call with origin mcp and returns the result', async () => {
  const res = await client.callTool({ name: 'get_structure', arguments: { pages: [0, 1] } });
  assert.ok(!res.isError, text(res));
  assert.deepEqual(JSON.parse(text(res)), { revision: 2, echo: { pages: [0, 1] } });
  const call = hub.calls.at(-1);
  assert.equal(call.type, 'tool_call');
  assert.equal(call.name, 'get_structure');
  assert.equal(call.origin, 'mcp');
  assert.match(call.callId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(call.args, { pages: [0, 1] });
});

test('maps image results to MCP image content', async () => {
  const res = await client.callTool({ name: 'render_page', arguments: { pageIndex: 3 } });
  assert.ok(!res.isError);
  assert.deepEqual(res.content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  assert.deepEqual(JSON.parse(res.content[1].text), { revision: 2, pageIndex: 3 });
});

test('hub errors become tool errors', async () => {
  const res = await client.callTool({ name: 'find_text', arguments: { query: 'x' } });
  assert.equal(res.isError, true);
  assert.match(text(res), /^NO_DOCUMENT: 두글에서 문서를 열어주세요/);
});

test('invalid args are rejected locally, never sent to the hub', async () => {
  const before = hub.calls.length;
  const res = await client.callTool({
    name: 'apply_para_format', arguments: { expectedRevision: 1, paras: [[5, 2]] },
  });
  assert.equal(res.isError, true);
  assert.match(text(res), /^INVALID_ARGS: .*reversed — send \[2, 5\]/);
  const res2 = await client.callTool({ name: 'insert_text', arguments: { expectedRevision: 1, find: 'a', anchor: 'a', text: 'b' } });
  assert.match(text(res2), /pass find or anchor, not both/);
  assert.equal(hub.calls.length, before);
});

test('insert_image reads imagePath locally and sends base64', async () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(40, 16);
  png.writeUInt32BE(30, 20);
  const file = path.join(tmp, 'a.png');
  writeFileSync(file, png);
  const res = await client.callTool({
    name: 'insert_image', arguments: { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, imagePath: file },
  });
  assert.ok(!res.isError, text(res));
  const sent = hub.calls.at(-1).args;
  assert.equal(sent.imagePath, undefined);
  assert.equal(sent.imageBase64, png.toString('base64'));
  assert.equal(sent.extension, 'png');
  assert.equal(sent.naturalWidthPx, 40);
  assert.equal(sent.naturalHeightPx, 30);
});

test('reconnects after the hub drops the connection', async () => {
  hub.dropClients();
  await new Promise((r) => setTimeout(r, 100));
  const res = await client.callTool({ name: 'get_selection', arguments: {} });
  assert.ok(!res.isError, text(res));
});

test('missing hub.json gives a clear Korean+English error, then recovers when the hub starts', async () => {
  const lateJson = path.join(tmp, 'late', 'hub.json');
  const lateClient = await startClient(lateJson);
  try {
    const res = await lateClient.callTool({ name: 'get_selection', arguments: {} });
    assert.equal(res.isError, true);
    assert.match(text(res), /두글 앱을 실행하고 문서를 열어주세요/);
    assert.match(text(res), /Start the 두글 app and open a document/);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.dirname(lateJson), { recursive: true });
    const lateHub = await startHub(lateJson, defaultHandler);
    try {
      const res2 = await lateClient.callTool({ name: 'get_selection', arguments: {} });
      assert.ok(!res2.isError, text(res2));
      assert.equal(lateHub.calls.at(-1).name, 'get_selection');
    } finally {
      await lateHub.close();
    }
  } finally {
    await lateClient.close();
  }
});

test('stale hub.json (wrong token) is reported, not hung', async () => {
  const staleJson = path.join(tmp, 'stale.json');
  writeFileSync(staleJson, JSON.stringify({ port: hub.wss.address().port, token: 'wrong', pid: 1, version: 1 }));
  const staleClient = await startClient(staleJson);
  try {
    const res = await staleClient.callTool({ name: 'get_selection', arguments: {} });
    assert.equal(res.isError, true);
    assert.match(text(res), /두글 앱을 실행하고 문서를 열어주세요/);
  } finally {
    await staleClient.close();
  }
});
