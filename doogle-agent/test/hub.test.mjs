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
      if (p.userText.includes('pause')) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        p.emit({ kind: 'text_delta', text: ' 끊긴 사이' });
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
    assert.deepEqual(p.list, [{
      id: 'fake', label: 'Fake', available: true,
      models: [{ id: 'm1', label: 'M1', source: 'live' }],
      defaultModel: 'm1', modelsUpdatedAt: null,
    }]);
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

  test('응답 도중 저장 → 새로고침(새 studio)이면 interrupted → 목록·불러오기로 복원', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'chat_send', threadId: 't20', providerId: 'fake', text: 'wait 저장 확인', mode: 'agent' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 't20' && m.event.kind === 'text_delta');
    // 글 조각은 0.8초 모아서 쓴다 — 턴이 끝나기 전에 파일에 있어야 한다
    await new Promise((r) => setTimeout(r, 1100));
    const mid = JSON.parse(await fs.readFile(path.join(dataDir, 'threads', 't20.json'), 'utf8'));
    assert.deepEqual(mid.transcript.map((e) => e.kind), ['user', 'text_delta']);
    assert.equal(mid.transcript[1].text, '안녕');
    assert.equal(mid.title, 'wait 저장 확인');

    // 새로고침: 새 화면이 붙으면 옛 화면 문서에 대던 응답은 멈춘다
    const s2 = new Client(studioUrl());
    await s2.open();
    const end = await s2.next((m) => m.type === 'agent_event' && m.threadId === 't20' && m.event.kind === 'turn_end');
    assert.equal(end.event.reason, 'interrupted');

    s2.send({ type: 'threads_query', reqId: 'q1' });
    const list = await s2.next((m) => m.type === 'threads' && m.reqId === 'q1');
    const item = list.list.find((t) => t.id === 't20');
    assert.ok(item, 't20 이 목록에 있다');
    assert.equal(item.turns, 1);
    assert.equal(item.running, false);

    s2.send({ type: 'thread_load', reqId: 'l1', threadId: 't20' });
    const loaded = await s2.next((m) => m.type === 'thread' && m.reqId === 'l1');
    assert.deepEqual(loaded.transcript.map((e) => e.kind), ['user', 'text_delta', 'turn_end']);
    assert.equal(loaded.transcript.at(-1).reason, 'interrupted');
    s.close();
    s2.close();
  });

  test('대화는 문서에 딸린다 — threads_query 는 그 문서의 대화만, 문서 없음(null)은 빈 목록', async () => {
    const s = new Client(studioUrl());
    await s.open();
    const a = { key: 'c:\\docs\\a.hwp', name: 'a.hwp' };
    const b = { key: 'c:\\docs\\b.hwp', name: 'b.hwp' };
    s.send({ type: 'chat_send', threadId: 't30', providerId: 'fake', text: 'A 문서 요청', mode: 'agent', doc: a });
    await s.collectTurn('t30');
    s.send({ type: 'chat_send', threadId: 't31', providerId: 'fake', text: 'B 문서 요청', mode: 'agent', doc: b });
    await s.collectTurn('t31');
    s.send({ type: 'threads_query', reqId: 'qa', doc: a });
    const la = await s.next((m) => m.type === 'threads' && m.reqId === 'qa');
    assert.deepEqual(la.list.map((t) => t.id), ['t30']);
    // 경로를 모르는 쪽(브라우저)은 파일 이름으로 맞춘다
    s.send({ type: 'threads_query', reqId: 'qn', doc: { key: '', name: 'B.HWP' } });
    const ln = await s.next((m) => m.type === 'threads' && m.reqId === 'qn');
    assert.deepEqual(ln.list.map((t) => t.id), ['t31']);
    // 자동 저장에서 복구한 문서("b 복구본.hwp", 경로 없음)도 원래 문서의 대화를 본다
    s.send({ type: 'threads_query', reqId: 'qr', doc: { key: '', name: 'b 복구본.hwp' } });
    const lr = await s.next((m) => m.type === 'threads' && m.reqId === 'qr');
    assert.deepEqual(lr.list.map((t) => t.id), ['t31']);
    s.send({ type: 'threads_query', reqId: 'q0', doc: null });
    const l0 = await s.next((m) => m.type === 'threads' && m.reqId === 'q0');
    assert.deepEqual(l0.list, []);
    s.close();
  });

  test('끝맺지 못한 기록(허브가 죽음)은 불러올 때 interrupted 로 닫는다', async () => {
    await fs.mkdir(path.join(dataDir, 'threads'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'threads', 't21.json'), JSON.stringify({
      id: 't21', title: '죽은 턴', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      histories: {}, pendingReviews: [],
      transcript: [{ kind: 'user', text: '죽은 턴' }, { kind: 'tool_use', callId: 'c', name: 'get_structure', args: {} }],
    }));
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'thread_load', reqId: 'l2', threadId: 't21' });
    const loaded = await s.next((m) => m.type === 'thread' && m.reqId === 'l2');
    assert.deepEqual(loaded.transcript.map((e) => e.kind), ['user', 'tool_use', 'turn_end']);
    assert.equal(loaded.running, false);
    s.close();
  });

  test('thread_delete — 파일과 목록에서 사라지고, 응답 중인 대화는 THREAD_BUSY', async () => {
    const s = new Client(studioUrl());
    await s.open();
    s.send({ type: 'chat_send', threadId: 't40', providerId: 'fake', text: '지울 대화', mode: 'agent' });
    await s.collectTurn('t40');
    const file = path.join(dataDir, 'threads', 't40.json');
    await fs.access(file);
    s.send({ type: 'thread_delete', reqId: 'd1', threadId: 't40' });
    const done = await s.next((m) => m.type === 'thread_deleted' && m.reqId === 'd1');
    assert.equal(done.ok, true);
    assert.equal(done.threadId, 't40');
    await assert.rejects(fs.access(file), (e) => e.code === 'ENOENT');
    s.send({ type: 'threads_query', reqId: 'd2' });
    const list = await s.next((m) => m.type === 'threads' && m.reqId === 'd2');
    assert.equal(list.list.some((t) => t.id === 't40'), false);
    // 뒤늦게 온 검토 결정이 지운 대화를 되살리지 않는다
    s.send({ type: 'review_decision', threadId: 't40', decision: 'accept_all' });
    await new Promise((r) => setTimeout(r, 80));
    await assert.rejects(fs.access(file), (e) => e.code === 'ENOENT');

    s.send({ type: 'chat_send', threadId: 't41', providerId: 'fake', text: 'wait 지우기 금지', mode: 'agent' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 't41' && m.event.kind === 'text_delta');
    s.send({ type: 'thread_delete', reqId: 'd3', threadId: 't41' });
    const busy = await s.next((m) => m.type === 'thread_deleted' && m.reqId === 'd3');
    assert.equal(busy.ok, false);
    assert.equal(busy.error.code, 'THREAD_BUSY');
    s.send({ type: 'chat_cancel', threadId: 't41' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 't41' && m.event.kind === 'turn_end');
    s.send({ type: 'thread_delete', reqId: 'd4' });
    const bad = await s.next((m) => m.type === 'thread_deleted' && m.reqId === 'd4');
    assert.equal(bad.error.code, 'INVALID_ARGS');
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

describe('doogle hub — 연결이 뜻밖에 끊겼을 때', () => {
  let hub;
  let dataDir;
  const GRACE_MS = 500;
  const url = (client) => `ws://127.0.0.1:${hub.port}/studio?token=${encodeURIComponent(hub.token)}${client ? `&client=${client}` : ''}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** 대화의 마지막 기록 줄 */
  const lastEntry = async (s, threadId) => {
    const reqId = `l-${threadId}`;
    s.send({ type: 'thread_load', reqId, threadId });
    const loaded = await s.next((m) => m.type === 'thread' && m.reqId === reqId);
    return { running: loaded.running, last: loaded.transcript.at(-1) };
  };

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-hub-grace-'));
    hub = await createHub({
      port: 0,
      dataDir,
      providers: [fakeProvider()],
      tools: fakeTools(),
      toolTimeouts: { read: 3000, write: 3000 },
      reconnectGraceMs: GRACE_MS,
      log: () => {},
    });
  });

  after(async () => {
    await hub.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test('같은 화면이 제때 돌아오면 응답을 이어 간다 — 끊긴 사이의 글과 tool_call 이 순서대로 온다', async () => {
    const s = new Client(url('page-aaaa-1111'));
    await s.open();
    s.send({ type: 'hello', role: 'studio', protocol: 1 });
    assert.equal((await s.next((m) => m.type === 'welcome')).resumed, false);
    s.send({ type: 'chat_send', threadId: 'g1', providerId: 'fake', text: 'pause tool 이어 가기', mode: 'agent' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 'g1' && m.event.kind === 'text_delta');
    s.ws.terminate(); // 뜻밖의 끊김 (닫는 인사 없이)
    await sleep(300); // 끊긴 사이: 글 조각 하나와 tool_call 이 나온다

    const s2 = new Client(url('page-aaaa-1111'));
    await s2.open();
    // 모아 둔 것이 낸 순서대로 온다
    const delta = await s2.next((m) => m.type === 'agent_event' || m.type === 'tool_call');
    assert.equal(delta.type, 'agent_event');
    assert.deepEqual(delta.event, { kind: 'text_delta', text: ' 끊긴 사이' });
    const use = await s2.next((m) => m.type === 'agent_event' || m.type === 'tool_call');
    assert.equal(use.event?.kind, 'tool_use');
    const call = await s2.next((m) => m.type === 'agent_event' || m.type === 'tool_call');
    assert.equal(call.type, 'tool_call');
    s2.send({ type: 'hello', role: 'studio', protocol: 1 });
    assert.equal((await s2.next((m) => m.type === 'welcome')).resumed, true);
    // 새 소켓으로 보낸 결과가 그 호출에 닿는다
    s2.send({ type: 'tool_result', callId: call.callId, ok: true, result: { pages: 1 } });
    const rest = await s2.collectTurn('g1');
    assert.deepEqual(rest.map((e) => e.kind), ['tool_result', 'text_done', 'turn_end']);
    assert.equal(rest[0].ok, true);
    assert.equal(rest.at(-1).reason, 'done');
    s2.close();
  });

  test('끊기기 전에 받은 tool_call 의 결과를 다시 붙은 뒤 보내도 닿는다', async () => {
    const s = new Client(url('page-bbbb-2222'));
    await s.open();
    s.send({ type: 'chat_send', threadId: 'g2', providerId: 'fake', text: 'tool 결과는 나중에', mode: 'agent' });
    const call = await s.next((m) => m.type === 'tool_call');
    s.ws.terminate();
    await sleep(100);
    const s2 = new Client(url('page-bbbb-2222'));
    await s2.open();
    s2.send({ type: 'tool_result', callId: call.callId, ok: true, result: { pages: 2 } });
    const rest = await s2.collectTurn('g2');
    assert.equal(rest.at(-1).reason, 'done');
    s2.close();
  });

  test('돌아오지 않으면 유예가 끝난 뒤 interrupted 로 멈춘다', async () => {
    const s = new Client(url('page-cccc-3333'));
    await s.open();
    s.send({ type: 'chat_send', threadId: 'g3', providerId: 'fake', text: 'wait 돌아오지 않음', mode: 'agent' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 'g3' && m.event.kind === 'text_delta');
    s.ws.terminate();
    await sleep(150);
    // 유예 중에는 아직 돌고 있다 (화면이 없어 확인은 hub 안쪽 상태로)
    assert.equal(hub.studioConnected, false);
    await sleep(GRACE_MS + 200);
    const s2 = new Client(url('page-cccc-3333'));
    await s2.open();
    s2.send({ type: 'hello', role: 'studio', protocol: 1 });
    assert.equal((await s2.next((m) => m.type === 'welcome')).resumed, false);
    const { running, last } = await lastEntry(s2, 'g3');
    assert.equal(running, false);
    assert.deepEqual([last.kind, last.reason], ['turn_end', 'interrupted']);
    s2.close();
  });

  test('유예 중에 다른 화면(새로고침)이 붙으면 바로 멈춘다', async () => {
    const s = new Client(url('page-dddd-4444'));
    await s.open();
    s.send({ type: 'chat_send', threadId: 'g4', providerId: 'fake', text: 'wait 새로고침', mode: 'agent' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 'g4' && m.event.kind === 'text_delta');
    s.ws.terminate();
    await sleep(60);
    const s2 = new Client(url('page-eeee-5555'));
    await s2.open();
    s2.send({ type: 'hello', role: 'studio', protocol: 1 });
    assert.equal((await s2.next((m) => m.type === 'welcome')).resumed, false);
    await sleep(60);
    const { running, last } = await lastEntry(s2, 'g4');
    assert.equal(running, false);
    assert.deepEqual([last.kind, last.reason], ['turn_end', 'interrupted']);
    s2.close();
  });

  test('화면이 스스로 닫으면(새로고침·창 닫힘) 기다리지 않고 멈춘다', async () => {
    const s = new Client(url('page-ffff-6666'));
    await s.open();
    s.send({ type: 'chat_send', threadId: 'g5', providerId: 'fake', text: 'wait 스스로 닫음', mode: 'agent' });
    await s.next((m) => m.type === 'agent_event' && m.threadId === 'g5' && m.event.kind === 'text_delta');
    s.ws.close(1001, 'going away');
    await sleep(120); // 유예(500ms)보다 훨씬 짧다
    const s2 = new Client(url('page-ffff-6666'));
    await s2.open();
    s2.send({ type: 'hello', role: 'studio', protocol: 1 });
    assert.equal((await s2.next((m) => m.type === 'welcome')).resumed, false);
    const { running, last } = await lastEntry(s2, 'g5');
    assert.equal(running, false);
    assert.deepEqual([last.kind, last.reason], ['turn_end', 'interrupted']);
    s2.close();
  });
});
