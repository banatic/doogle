// openai-api / openai-siwc provider 테스트 — fetch 모킹, 실제 네트워크 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIApiProvider, parseSse, sanitizeHistory } from '../src/providers/openai-api.mjs';
import { createOpenAISiwcProvider } from '../src/providers/openai-siwc.mjs';

const TOOLS = [{ name: 'get_text', description: '문서 텍스트', parameters: { type: 'object', properties: {} } }];

function sse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // 일부러 작은 조각으로 나눠 경계 처리 확인
  return new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); },
  });
}
const okSse = (events) => new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function toolCallThenText() {
  return [
    [
      { type: 'response.created', response: {} },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_text', arguments: '{"a":1}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } },
    ],
    [
      { type: 'response.output_text.delta', delta: '안녕' },
      { type: 'response.output_text.delta', delta: '하세요' },
      { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '안녕하세요' }] } },
      { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 5 } } },
    ],
  ];
}

function mockFetch(responders) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const r = responders[calls.length - 1];
    if (!r) throw new Error(`unexpected fetch #${calls.length} ${url}`);
    return typeof r === 'function' ? r(url, init) : r;
  };
  return { f, calls };
}

function turnArgs(extra = {}) {
  const events = [];
  const toolCalls = [];
  return {
    events, toolCalls,
    turn: {
      threadId: 't', model: 'm1', messages: [], text: '문서 요약', mode: 'agent', systemPrompt: 'SYS', tools: TOOLS,
      callTool: async (name, args) => { toolCalls.push({ name, args }); return { ok: true, result: { text: '본문' } }; },
      emit: (e) => events.push(e), signal: new AbortController().signal, ...extra,
    },
  };
}

test('parseSse: 조각난 스트림과 CRLF 처리', async () => {
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"a":1}\r\n\r\ndata: {"b"')); c.enqueue(new TextEncoder().encode(':2}\n\n')); c.close(); } });
  const out = [];
  for await (const e of parseSse(body)) out.push(JSON.parse(e.data));
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test('sanitizeHistory: 다른 provider 형식은 텍스트로 변환', () => {
  const h = sanitizeHistory([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'system', content: 'x' }, { type: 'reasoning', id: 'r' }]);
  assert.deepEqual(h, [{ type: 'message', role: 'user', content: 'hi' }]);
});

test('openai-api: function tool 루프, store:false/stream:true, instructions, usage 합산', async () => {
  const [r1, r2] = toolCallThenText();
  const { f, calls } = mockFetch([okSse(r1), okSse(r2)]);
  const p = createOpenAIApiProvider({ fetch: f, getApiKey: async () => 'sk-test' });
  const { events, toolCalls, turn } = turnArgs();
  const out = await p.runTurn(turn);

  assert.equal(calls.length, 2);
  const b1 = calls[0].body;
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.equal(b1.store, false);
  assert.equal(b1.stream, true);
  assert.equal(b1.instructions, 'SYS');
  assert.equal(b1.model, 'm1');
  assert.ok(b1.tools.length >= 1 && b1.tools.every((t) => t.type === 'function'));
  assert.deepEqual(b1.input, [{ type: 'message', role: 'user', content: '문서 요약' }]);

  assert.deepEqual(toolCalls, [{ name: 'get_text', args: { a: 1 } }]);
  const b2 = calls[1].body;
  const fc = b2.input.find((i) => i.type === 'function_call');
  assert.equal(fc.call_id, 'call_1');
  assert.equal(fc.id, undefined, 'store:false → 서버 id 제거');
  assert.ok(b2.input.some((i) => i.type === 'reasoning' && i.encrypted_content === 'ENC'));
  const fco = b2.input.find((i) => i.type === 'function_call_output');
  assert.deepEqual(JSON.parse(fco.output), { ok: true, result: { text: '본문' } });

  assert.equal(events.filter((e) => e.kind === 'text_delta').map((e) => e.text).join(''), '안녕하세요');
  assert.ok(events.some((e) => e.kind === 'tool_use' && e.name === 'get_text'));
  assert.ok(events.some((e) => e.kind === 'tool_result' && e.ok));
  assert.ok(events.some((e) => e.kind === 'text_done'));
  assert.deepEqual(events.find((e) => e.kind === 'usage'), { kind: 'usage', inputTokens: 30, outputTokens: 8 });
  assert.deepEqual(out.messages.at(-1), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '안녕하세요' }] });
});

test('openai-api: key 없음 → detect unavailable, runTurn API_KEY_MISSING', async () => {
  const p = createOpenAIApiProvider({ fetch: async () => { throw new Error('no'); }, getApiKey: async () => null });
  assert.equal((await p.detect()).available, false);
  await assert.rejects(p.runTurn(turnArgs().turn), (e) => e.code === 'API_KEY_MISSING');
});

test('openai-api: stream이 response.completed 없이 끝나면 오류', async () => {
  const { f } = mockFetch([okSse([{ type: 'response.output_text.delta', delta: 'a' }])]);
  const p = createOpenAIApiProvider({ fetch: f, getApiKey: async () => 'k' });
  await assert.rejects(p.runTurn(turnArgs().turn), (e) => e.code === 'STREAM_INCOMPLETE');
});

function fakeAuth({ signedIn = true, planUsage = true } = {}) {
  const st = { n: 0, forced: 0 };
  return {
    st,
    async status() { return { signedIn, planUsage, email: 'u@x' }; },
    async getAccessToken(o = {}) { st.n++; if (o.forceRefresh) st.forced++; return o.forceRefresh ? 'tok-new' : 'tok-old'; },
    invalidateAccessToken() {},
  };
}

test('openai-siwc: tool을 namespace로 묶고 Bearer SIWC 토큰 사용', async () => {
  const [r1, r2] = toolCallThenText();
  r1[2].item.name = 'get_text';
  r1[2].item.namespace = 'doogle';
  const { f, calls } = mockFetch([okSse(r1), okSse(r2)]);
  const p = createOpenAISiwcProvider({ auth: fakeAuth(), fetch: f });
  const { toolCalls, turn } = turnArgs();
  await p.runTurn(turn);
  const b1 = calls[0].body;
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-old');
  assert.equal(b1.tools[0].type, 'namespace');
  assert.equal(b1.tools[0].name, 'doogle');
  assert.ok(b1.tools[0].tools.every((t) => t.type === 'function'));
  assert.equal(b1.store, false);
  assert.equal(b1.stream, true);
  for (const k of ['temperature', 'max_output_tokens', 'metadata', 'previous_response_id', 'user', 'top_p', 'truncation']) assert.equal(b1[k], undefined);
  assert.equal(toolCalls[0].name, 'get_text');
  assert.equal(calls[1].body.input.find((i) => i.type === 'function_call').namespace, 'doogle');
});

test('openai-siwc: "doogle.name" 형태의 함수 이름도 처리', async () => {
  const [r1, r2] = toolCallThenText();
  const { f } = mockFetch([okSse(r1.map((e) => (e.item?.type === 'function_call' ? { ...e, item: { ...e.item, name: 'doogle.get_text' } } : e))), okSse(r2)]);
  const p = createOpenAISiwcProvider({ auth: fakeAuth(), fetch: f });
  const { toolCalls, turn } = turnArgs();
  await p.runTurn(turn);
  assert.equal(toolCalls[0].name, 'get_text');
});

test('openai-siwc: HTTP 429 subscription_sharing_usage_limit_exceeded → limit 이벤트', async () => {
  const { f } = mockFetch([jsonRes(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } })]);
  const p = createOpenAISiwcProvider({ auth: fakeAuth(), fetch: f });
  const { events, turn } = turnArgs();
  await assert.rejects(p.runTurn(turn), (e) => e.code === 'LIMIT' && e.emitted === true);
  const lim = events.find((e) => e.kind === 'limit');
  assert.match(lim.message, /chatgpt\.com\/settings\/usage/);
});

test('openai-siwc: 스트림 중 response.failed(_unavailable) → limit 이벤트', async () => {
  const { f } = mockFetch([okSse([
    { type: 'response.output_text.delta', delta: '부분' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'x' } } },
  ])]);
  const p = createOpenAISiwcProvider({ auth: fakeAuth(), fetch: f });
  const { events, turn } = turnArgs();
  await assert.rejects(p.runTurn(turn), (e) => e.code === 'LIMIT');
  assert.ok(events.some((e) => e.kind === 'limit'));
});

test('openai-siwc: 401 → 토큰 강제 갱신 후 1회 재시도', async () => {
  const [, r2] = toolCallThenText();
  const { f, calls } = mockFetch([jsonRes(401, { detail: 'nope' }), okSse(r2)]);
  const auth = fakeAuth();
  const p = createOpenAISiwcProvider({ auth, fetch: f });
  await p.runTurn(turnArgs().turn);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers.authorization, 'Bearer tok-new');
  assert.equal(auth.st.forced, 1);
});

test('openai-siwc: 401 두 번 → SIWC_LOGIN_REQUIRED', async () => {
  const { f } = mockFetch([jsonRes(401, { detail: 'nope' }), jsonRes(401, { detail: 'nope' })]);
  const p = createOpenAISiwcProvider({ auth: fakeAuth(), fetch: f });
  await assert.rejects(p.runTurn(turnArgs().turn), (e) => e.code === 'SIWC_LOGIN_REQUIRED');
});

test('openai-siwc: detect — 미로그인 / 모델 목록(visibility=list, 서버 순서)', async () => {
  const p1 = createOpenAISiwcProvider({ auth: fakeAuth({ signedIn: false }), fetch: async () => { throw new Error('no'); } });
  assert.equal((await p1.detect()).available, false);
  const { f, calls } = mockFetch([jsonRes(200, { models: [
    { slug: 'b', display_name: 'B', visibility: 'list' }, { slug: 'h', display_name: 'H', visibility: 'hide' }, { slug: 'a', display_name: 'A', visibility: 'list' },
  ] })]);
  const p2 = createOpenAISiwcProvider({ auth: fakeAuth(), fetch: f });
  const d = await p2.detect();
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.deepEqual(d.models, [{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }]);
});
