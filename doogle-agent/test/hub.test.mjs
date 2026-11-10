// hub 프로토콜 테스트: 가짜 studio 클라이언트 + 가짜 provider.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';

import { createHub } from '../src/hub.mjs';
import { stubTools } from '../src/tools-loader.mjs';
import { createMemorySecretBackend, setSecretBackend, getSecret } from '../src/secrets.mjs';

setSecretBackend(createMemorySecretBackend());

/** 테스트용 tools 모듈 */
function fakeTools() {
  const TOOLS = [
    { name: 'get_structure', description: 'read', kind: 'read', shape: {} },
    { name: 'replace_range', description: 'write', kind: 'write', shape: {} },
  ];
  return {
    ...stubTools(),
    stub: false,
    TOOL_RULES: 'FAKE TOOL RULES',
    TOOLS,
    getTool: (n) => TOOLS.find((t) => t.name === n),
    validateArgs: (n, args) => (args && args.bad
      ? { ok: false, error: { code: 'INVALID_ARGS', message: 'bad' } }
      : { ok: true, args }),
  };
}

/** 가짜 provider: 받은 입력을 기록하고, 'tool' 이 들어 있으면 get_structure를 호출한다. */
function fakeProvider() {
  const calls = [];
  return {
    calls,
    id: 'fake',
    label: 'Fake',
    async detect() { return { available: true, models: [{ id: 'm1', label: 'M1' }] }; },
    async startLogin() {
      return { authUrl: 'https://auth.example/authorize?x=1', waitForCompletion: async () => ({ sub: 's' }), cancel() {} };
    },
    async logout() {},
    async runTurn(p) {
      calls.push(p);
      p.emit({ kind: 'text_delta', text: '안녕' });
      p.emit({ kind: 'turn_end', reason: 'done' }); // hub 소유 이벤트 — 무시되어야 함
      if (p.userText.includes('wait')) {
        await new Promise((resolve) => p.signal.addEventListener('abort', resolve, { once: true }));
        return { messages: p.messages };
      }
      let toolRes = null;
      if (p.userText.includes('tool')) toolRes = await p.callTool('get_structure', { pages: [0, 0] });
      if (p.userText.includes('boom')) throw Object.assign(new Error('폭발'), { code: 'BOOM' });
      p.emit({ kind: 'text_done' });
      return { messages: [...p.messages, { role: 'user', content: p.userText }, { toolRes }] };
    },
  };
}

class Client {
  constructor(url, opts) {
    this.ws = new WebSocket(url, opts);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      this.queue.push(m);
      this.#flush();
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  #flush() {
    for (const w of [...this.waiters]) {
      const i = this.queue.findIndex(w.pred);
      if (i >= 0) {
        const [m] = this.queue.splice(i, 1);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }
  next(pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error('timeout waiting for message')), ms) };
      this.waiters.push(w);
      this.#flush();
    });
  }
  /** turn_end까지 해당 thread의 agent_event 수집 */
  async collectTurn(threadId, ms = 3000) {
    const events = [];
    for (;;) {
      const m = await this.next((x) => x.type === 'agent_event' && x.threadId === threadId, ms);
      events.push(m.event);
      if (m.event.kind === 'turn_end') return events;
    }
  }
  close() { this.ws.close(); }
}

describe('doogle hub', () => {
  let hub;
  let dataDir;
  let provider;
  const studioUrl = () => `ws://127.0.0.1:${hub.port}/studio?token=${encodeURIComponent(hub.token)}`;
  const mcpUrl = () => `ws://127.0.0.1:${hub.port}/mcp?token=${encodeURIComponent(hub.token)}`;

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-hub-test-'));
    provider = fakeProvider();
    hub = await createHub({
      port: 0,
      dataDir,
      providers: [provider],
      tools: fakeTools(),
      toolTimeouts: { read: 300, write: 300 },
      log: () => {},
    });
  });

  after(async () => {
    await hub.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test('hub.json 기록 (port/token/pid/version)', async () => {
    const j = JSON.parse(await fs.readFile(path.join(dataDir, 'hub.json'), 'utf8'));
    assert.deepEqual(j, { port: hub.port, token: hub.token, pid: process.pid, version: 1 });
    if (process.platform !== 'win32') {
      const st = await fs.stat(path.join(dataDir, 'hub.json'));
      assert.equal(st.mode & 0o777, 0o600);
    }
  });

  test('잘못된 token은 401로 거절', async () => {
    const c = new Client(`ws://127.0.0.1:${hub.port}/studio?token=wrong`);
    await assert.rejects(c.open(), (e) => e.status === 401);
    const c2 = new Client(`ws://127.0.0.1:${hub.port}/studio`);
    await assert.rejects(c2.open(), (e) => e.status === 401);
  });

  test('허용되지 않은 Origin은 403, 허용 Origin은 통과', async () => {
    const bad = new Client(studioUrl(), { origin: 'https://evil.example' });
    await assert.rejects(bad.open(), (e) => e.status === 403);
    const ok = new Client(mcpUrl(), { origin: 'tauri://localhost' });
    await ok.open();
    ok.close();
  });

  test('studio 미연결 시 mcp tool_call은 NO_DOCUMENT', async () => {
    const mcp = new Client(mcpUrl());
    await mcp.open();
    mcp.send({ type: 'tool_call', callId: 'x1', name: 'get_structure', args: {} });
    const r = await mcp.next((m) => m.type === 'tool_result');
    assert.equal(r.callId, 'x1');
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NO_DOCUMENT');
    mcp.close();
  });

  test('hello/welcome, providers_query', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'hello', role: 'studio', protocol: 1 });
    const w = await s.next((m) => m.type === 'welcome');
    assert.equal(w.protocol, 1);
    s.send({ type: 'providers_query' });
    const p = await s.next((m) => m.type === 'providers');
    assert.deepEqual(p.list, [{ id: 'fake', label: 'Fake', available: true, models: [{ id: 'm1', label: 'M1' }] }]);
    s.close();
  });

  test('chat_send → tool_call 중계(callId 대응) → agent_event 및 turn_end', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'chat_send', threadId: 't1', providerId: 'fake', text: 'tool please', mode: 'agent', context: { documentName: 'a.hwp' } });
    const call = await s.next((m) => m.type === 'tool_call');
    assert.equal(call.name, 'get_structure');
    assert.equal(call.origin, 'agent');
    assert.equal(call.threadId, 't1');
    assert.deepEqual(call.args, { pages: [0, 0] });
    s.send({ type: 'tool_result', callId: 'not-a-real-call', ok: true, result: 'ignored' });
    s.send({ type: 'tool_result', callId: call.callId, ok: true, result: { revision: 3 } });
    const events = await s.collectTurn('t1');
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['text_delta', 'tool_use', 'tool_result', 'text_done', 'turn_end']);
    assert.equal(events.at(-1).reason, 'done');
    assert.equal(events[1].callId, call.callId);
    assert.equal(events[2].ok, true);

    const p = provider.calls.at(-1);
    assert.match(p.systemPrompt, /FAKE TOOL RULES/);
    assert.match(p.text, /<doogle_mode>/);
    assert.match(p.text, /a\.hwp/);
    assert.equal(p.mode, 'agent');
    s.close();
  });

  test('히스토리가 thread에 저장되고 review_decision이 다음 턴에 주입됨', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'chat_send', threadId: 't2', providerId: 'fake', text: '첫 턴', mode: 'full' });
    await s.collectTurn('t2');
    s.send({ type: 'review_decision', threadId: 't2', decision: 'reject_all', note: '표는 그대로 둬' });
    // review_decision 처리 후 chat_send (같은 소켓 순서 보장)
    s.send({ type: 'chat_send', threadId: 't2', providerId: 'fake', text: '둘째 턴', mode: 'agent' });
    await s.collectTurn('t2');
    const p = provider.calls.at(-1);
    assert.match(p.text, /<doogle_review>/);
    assert.match(p.text, /거절/);
    assert.match(p.text, /표는 그대로 둬/);
    assert.equal(p.messages.length, 2);
    assert.equal(p.messages[0].content, '첫 턴');
    // 그 다음 턴엔 검토 블록 없음
    s.send({ type: 'chat_send', threadId: 't2', providerId: 'fake', text: '셋째 턴', mode: 'agent' });
    await s.collectTurn('t2');
    assert.doesNotMatch(provider.calls.at(-1).text, /<doogle_review>/);
    await hub.store.flush();
    const files = await fs.readdir(path.join(dataDir, 'threads'));
    assert.ok(files.includes('t2.json'));
    s.close();
  });

  test('tool_call 타임아웃 → TIMEOUT 결과 + tool_cancel', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'chat_send', threadId: 't3', providerId: 'fake', text: 'tool', mode: 'agent' });
    const call = await s.next((m) => m.type === 'tool_call');
    // 응답하지 않는다
    const cancel = await s.next((m) => m.type === 'tool_cancel', 2000);
    assert.equal(cancel.callId, call.callId);
    const events = await s.collectTurn('t3');
    const tr = events.find((e) => e.kind === 'tool_result');
    assert.equal(tr.ok, false);
    assert.match(tr.summary, /TIMEOUT/);
    s.close();
  });

  test('mcp tool_call이 studio로 중계되고 결과가 원래 callId로 돌아감', async () => {
    const s = new Client(studioUrl());
    await s.open();
    const mcp = new Client(mcpUrl());
    await mcp.open();
    mcp.send({ type: 'tool_call', callId: 'm-1', name: 'replace_range', args: { text: 'x' } });
    const call = await s.next((m) => m.type === 'tool_call');
    assert.equal(call.origin, 'mcp');
    assert.notEqual(call.callId, 'm-1');
    s.send({ type: 'tool_result', callId: call.callId, ok: false, error: { code: 'STALE_REVISION', message: 'stale' } });
    const r = await mcp.next((m) => m.type === 'tool_result');
    assert.deepEqual(r, { type: 'tool_result', callId: 'm-1', ok: false, error: { code: 'STALE_REVISION', message: 'stale' } });
    // 검증 실패와 미지의 tool은 studio로 가지 않는다
    mcp.send({ type: 'tool_call', callId: 'm-2', name: 'replace_range', args: { bad: true } });
    assert.equal((await mcp.next((m) => m.callId === 'm-2')).error.code, 'INVALID_ARGS');
    mcp.send({ type: 'tool_call', callId: 'm-3', name: 'rm_rf', args: {} });
    assert.equal((await mcp.next((m) => m.callId === 'm-3')).error.code, 'UNKNOWN_TOOL');
    mcp.close();
    s.close();
  });

  test('chat_cancel → turn_end cancelled, 진행 중 턴에 chat_send는 TURN_IN_PROGRESS', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'chat_send', threadId: 't4', providerId: 'fake', text: 'wait', mode: 'agent' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 't4' && m.event.kind === 'text_delta');
    s.send({ type: 'chat_send', threadId: 't4', providerId: 'fake', text: 'again', mode: 'agent' });
    const busy = await s.next((m) => m.type === 'agent_event' && m.threadId === 't4' && m.event.kind === 'error');
    assert.equal(busy.event.code, 'TURN_IN_PROGRESS');
    s.send({ type: 'chat_cancel', threadId: 't4' });
    const end = await s.next((m) => m.type === 'agent_event' && m.threadId === 't4' && m.event.kind === 'turn_end');
    assert.equal(end.event.reason, 'cancelled');
    s.close();
  });

  test('provider 예외 → error 이벤트 + turn_end error, 없는 provider', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'chat_send', threadId: 't5', providerId: 'fake', text: 'boom', mode: 'agent' });
    let ev = await s.collectTurn('t5');
    assert.deepEqual(ev.filter((e) => e.kind === 'error').map((e) => e.code), ['BOOM']);
    assert.equal(ev.at(-1).reason, 'error');
    s.send({ type: 'chat_send', threadId: 't6', providerId: 'nope', text: 'hi', mode: 'agent' });
    ev = await s.collectTurn('t6');
    assert.equal(ev[0].code, 'PROVIDER_UNAVAILABLE');
    s.close();
  });

  test('studio 연결이 끊기면 대기 중 tool_call은 STUDIO_DISCONNECTED', async () => {
    const s = new Client(studioUrl());
    await s.open();
    const mcp = new Client(mcpUrl());
    await mcp.open();
    mcp.send({ type: 'tool_call', callId: 'd-1', name: 'get_structure', args: {} });
    await s.next((m) => m.type === 'tool_call');
    s.close();
    const r = await mcp.next((m) => m.callId === 'd-1');
    assert.equal(r.error.code, 'STUDIO_DISCONNECTED');
    mcp.close();
  });

  test('auth_start → auth_url → auth_done → providers, auth_logout', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'auth_start', providerId: 'fake' });
    assert.equal((await s.next((m) => m.type === 'auth_url')).url, 'https://auth.example/authorize?x=1');
    assert.deepEqual(await s.next((m) => m.type === 'auth_done'), { type: 'auth_done', providerId: 'fake', ok: true });
    await s.next((m) => m.type === 'providers');
    s.send({ type: 'auth_logout', providerId: 'fake' });
    assert.equal((await s.next((m) => m.type === 'auth_logout_done')).ok, true);
    s.send({ type: 'auth_start', providerId: 'nope' });
    assert.equal((await s.next((m) => m.type === 'auth_done')).error.code, 'AUTH_UNSUPPORTED');
    s.close();
  });

  test('secret_set (허용 키만)', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'secret_set', key: 'anthropic-api-key', value: 'sk-test' });
    assert.equal((await s.next((m) => m.type === 'secret_ack')).ok, true);
    assert.equal(await getSecret('anthropic-api-key'), 'sk-test');
    await s.next((m) => m.type === 'providers');
    s.send({ type: 'secrets_set', key: 'claude-oauth', value: 'x' });
    assert.equal((await s.next((m) => m.type === 'secret_ack')).ok, false);
    s.close();
  });
});
