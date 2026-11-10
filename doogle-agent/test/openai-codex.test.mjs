// codex-app-server provider 테스트 — 가짜 app-server 프로세스(JSONL) 사용, 실제 Codex/네트워크 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCodexAppServerProvider, denyServerRequest } from '../src/providers/codex-app-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'openai-fake-codex-app-server.mjs');
const TOOLS = [{ name: 'get_text', description: '문서 텍스트', parameters: { type: 'object', properties: {} } }];

function makeProvider(scenario, extra = {}) {
  process.env.FAKE_SCENARIO = scenario;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doogle-codex-test-'));
  return createCodexAppServerProvider({ command: process.execPath, prefixArgs: [FAKE], workDir, ...extra });
}

function collector() {
  const events = [];
  return { events, emit: (e) => events.push(e) };
}

test('detect: 로그인 상태와 모델 목록(hidden 제외)', async () => {
  const p = makeProvider('tool');
  try {
    const d = await p.detect();
    assert.equal(d.available, true);
    assert.deepEqual(d.models, [{ id: 'gpt-x', label: 'GPT X' }]);
  } finally { await p.dispose(); }
});

test('detect: 미로그인 → available:false + codex login 안내', async () => {
  const p = makeProvider('nologin');
  try {
    const d = await p.detect();
    assert.equal(d.available, false);
    assert.match(d.authHint, /codex login/);
  } finally { await p.dispose(); }
});

test('detect: codex 미설치 → available:false', async () => {
  const p = createCodexAppServerProvider({ command: path.join(os.tmpdir(), 'no-such-codex-binary-xyz') });
  const d = await p.detect();
  assert.equal(d.available, false);
  await p.dispose();
});

test('runTurn: dynamic tool 호출 → callTool, 텍스트 스트림, usage, read-only/never/ephemeral', async () => {
  const p = makeProvider('tool');
  const { events, emit } = collector();
  const calls = [];
  try {
    const r = await p.runTurn({
      threadId: 'T1', model: 'gpt-x', messages: [{ role: 'user', content: '이전 질문' }, { role: 'assistant', content: '이전 답' }],
      text: '안녕', mode: 'agent', systemPrompt: 'SYS', tools: TOOLS,
      callTool: async (name, args) => { calls.push({ name, args }); return { ok: true, result: { text: '본문' } }; },
      emit, signal: new AbortController().signal,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, { q: 1 });
    const text = events.filter((e) => e.kind === 'text_delta').map((e) => e.text).join('');
    const seen = JSON.parse(text.replace(/^seen:/, ''));
    assert.equal(seen.success, true);
    assert.match(seen.toolText, /본문/);
    assert.equal(seen.sandbox, 'read-only');
    assert.equal(seen.approvalPolicy, 'never');
    assert.equal(seen.ephemeral, true);
    assert.equal(seen.base, 'SYS');
    assert.match(seen.input, /\[이전 대화\][\s\S]*이전 질문[\s\S]*안녕$/);
    assert.ok(events.some((e) => e.kind === 'tool_use' && e.callId === 'call-1'));
    assert.ok(events.some((e) => e.kind === 'tool_result' && e.ok === true));
    assert.ok(events.some((e) => e.kind === 'text_done'));
    assert.deepEqual(events.find((e) => e.kind === 'usage'), { kind: 'usage', inputTokens: 11, outputTokens: 7 });
    assert.equal(r.messages.at(-2).content, '안녕');
    assert.equal(r.messages.at(-1).role, 'assistant');
  } finally { await p.dispose(); }
});

test('runTurn: 승인 요청은 decline, tool 실패는 success:false', async () => {
  const p = makeProvider('approval');
  const { events, emit } = collector();
  try {
    await p.runTurn({
      threadId: 'T2', messages: [], text: 'x', systemPrompt: '', tools: TOOLS,
      callTool: async () => ({ ok: false, error: { code: 'NO_DOCUMENT', message: '문서 없음' } }),
      emit, signal: new AbortController().signal,
    });
    const seen = JSON.parse(events.filter((e) => e.kind === 'text_delta').map((e) => e.text).join('').replace(/^seen:/, ''));
    assert.deepEqual(seen.approval, { decision: 'decline' });
    assert.equal(seen.success, false);
    assert.ok(events.some((e) => e.kind === 'tool_result' && e.ok === false));
  } finally { await p.dispose(); }
});

test('runTurn: usageLimitExceeded → limit 이벤트 + ProviderError(emitted)', async () => {
  const p = makeProvider('limit');
  const { events, emit } = collector();
  try {
    await assert.rejects(p.runTurn({
      threadId: 'T3', messages: [], text: 'x', tools: TOOLS, callTool: async () => ({ ok: true }), emit, signal: new AbortController().signal,
    }), (e) => e.code === 'LIMIT' && e.emitted === true);
    const lim = events.find((e) => e.kind === 'limit');
    assert.ok(lim);
    assert.equal(lim.resetAt, new Date(1800000000 * 1000).toISOString());
  } finally { await p.dispose(); }
});

test('runTurn: abort → turn/interrupt 후 정상 반환', async () => {
  const p = makeProvider('interrupt');
  const ac = new AbortController();
  try {
    const run = p.runTurn({ threadId: 'T4', messages: [], text: 'x', tools: TOOLS, callTool: async () => ({ ok: true }), emit: () => {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await run;
    assert.equal(r.messages.at(-1).content, 'x');
  } finally { await p.dispose(); }
});

test('SIWC 주입 + MCP 폴백: ACCESS_TOKEN env와 -c 인자', async () => {
  const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doogle-codex-args-')), 'args.json');
  process.env.FAKE_ARGS_FILE = argsFile;
  const p = makeProvider('tool', { useSiwcToken: true, getSiwcToken: async () => 'tok-123', toolMode: 'mcp' });
  try {
    const d = await p.detect();
    assert.equal(d.available, true);
    const { argv, accessToken } = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(accessToken, 'tok-123');
    const joined = argv.join(' ');
    assert.match(joined, /model_provider="openai_chatgpt_plan"/);
    assert.match(joined, /model_providers\.openai_chatgpt_plan\.env_key="ACCESS_TOKEN"/);
    assert.match(joined, /requires_openai_auth=false/);
    assert.match(joined, /supports_websockets=false/);
    assert.match(joined, /mcp_servers\.doogle\.command=/);
    assert.match(joined, /mcp_servers\.doogle\.args=\[".*doogle-mcp\.mjs"\]/);
    assert.ok(argv.includes('--disable') && argv.includes('shell_tool'));
    assert.ok(!argv.includes('code_mode_host'), 'code_mode_host must stay enabled for dynamic tools');
  } finally { delete process.env.FAKE_ARGS_FILE; await p.dispose(); }
});

test('denyServerRequest: 모든 승인 거절', () => {
  assert.deepEqual(denyServerRequest('item/fileChange/requestApproval', {}), { decision: 'decline' });
  assert.deepEqual(denyServerRequest('item/commandExecution/requestApproval', {}), { decision: 'decline' });
  assert.ok(denyServerRequest('execCommandApproval', {}).decision.denied);
  assert.deepEqual(denyServerRequest('mcpServer/elicitation/request', { serverName: 'other', mode: 'form' }).action, 'decline');
  assert.equal(denyServerRequest('unknown/method', {}), undefined);
});
