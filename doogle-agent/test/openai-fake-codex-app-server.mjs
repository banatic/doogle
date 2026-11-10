// 테스트용 가짜 `codex app-server` (stdio JSONL, "jsonrpc" 필드 없음 — 실제 0.157.1 실측 형식).
// 사용: node openai-fake-codex-app-server.mjs app-server --listen stdio:// ...
// 시나리오: env FAKE_SCENARIO = tool | limit | approval | interrupt | nologin
import fs from 'node:fs';

const scenario = process.env.FAKE_SCENARIO || 'tool';
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), accessToken: process.env.ACCESS_TOKEN || null }));

let nextServerId = 0;
const waiting = new Map();
let buf = '';
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const serverRequest = (method, params) => new Promise((resolve) => {
  const id = nextServerId++;
  waiting.set(id, resolve);
  send({ id, method, params });
});
let interrupted = null;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(m) {
  if (m.method === undefined && waiting.has(m.id)) { const r = waiting.get(m.id); waiting.delete(m.id); r(m.result ?? { error: m.error }); return; }
  if (m.id === undefined) return; // notification (initialized)
  switch (m.method) {
    case 'initialize':
      if (!m.params?.clientInfo?.name || m.params?.capabilities?.experimentalApi !== true) send({ id: m.id, error: { code: -32602, message: 'bad initialize' } });
      else send({ id: m.id, result: { userAgent: 'fake/0.0.0', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } });
      break;
    case 'account/read':
      send({ id: m.id, result: scenario === 'nologin'
        ? { account: null, requiresOpenaiAuth: true, workspaceRouting: null }
        : { account: { type: 'chatgpt', email: 'u@example.com', planType: 'plus' }, requiresOpenaiAuth: true, workspaceRouting: null } });
      break;
    case 'model/list':
      send({ id: m.id, result: { data: [{ id: 'gpt-x', model: 'gpt-x', displayName: 'GPT X', hidden: false }, { id: 'h', model: 'h', displayName: 'Hidden', hidden: true }], nextCursor: null } });
      break;
    case 'thread/start':
      globalThis.lastThreadStart = m.params;
      send({ id: m.id, result: { thread: { id: 'th-1' }, model: m.params.model || 'gpt-x' } });
      break;
    case 'turn/interrupt':
      interrupted = m.params;
      send({ id: m.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'th-1', turn: { id: 'tu-1', items: [], status: 'interrupted', error: null } } });
      break;
    case 'turn/start':
      send({ id: m.id, result: { turn: { id: 'tu-1', items: [], status: 'inProgress', error: null } } });
      runTurn(m.params);
      break;
    default:
      send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
}

async function runTurn(p) {
  const base = { threadId: p.threadId, turnId: 'tu-1' };
  const ts = globalThis.lastThreadStart || {};
  send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: 'tu-1', status: 'inProgress' } } });
  if (scenario === 'limit') {
    send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, resetsAt: 1800000000 } } } });
    send({ method: 'error', params: { ...base, error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false } });
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'tu-1', items: [], status: 'failed', error: { message: 'usage limit', codexErrorInfo: 'usageLimitExceeded' } } } });
    return;
  }
  if (scenario === 'interrupt') return; // 클라이언트의 turn/interrupt 대기
  let approval = null;
  if (scenario === 'approval') {
    approval = await serverRequest('item/commandExecution/requestApproval', { ...base, itemId: 'c1', command: 'rm -rf /' });
  }
  const tool = ts.dynamicTools?.[0]?.type === 'namespace' ? ts.dynamicTools[0].tools[0]?.name : ts.dynamicTools?.[0]?.name;
  const res = await serverRequest('item/tool/call', { ...base, callId: 'call-1', namespace: 'doogle', tool: tool || 'none', arguments: { q: 1 } });
  const toolText = res?.contentItems?.[0]?.text || '';
  const reply = `seen:${JSON.stringify({ toolText, success: res?.success, approval, input: p.input?.[0]?.text, sandbox: ts.sandbox, approvalPolicy: ts.approvalPolicy, ephemeral: ts.ephemeral, base: ts.baseInstructions })}`;
  send({ method: 'item/started', params: { ...base, item: { type: 'agentMessage', id: 'm1', text: '' } } });
  send({ method: 'item/agentMessage/delta', params: { ...base, itemId: 'm1', delta: reply.slice(0, 10) } });
  send({ method: 'item/agentMessage/delta', params: { ...base, itemId: 'm1', delta: reply.slice(10) } });
  send({ method: 'item/completed', params: { ...base, item: { type: 'agentMessage', id: 'm1', text: reply } } });
  send({ method: 'thread/tokenUsage/updated', params: { ...base, tokenUsage: { last: { inputTokens: 11, outputTokens: 7 }, total: {} } } });
  send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: 'tu-1', items: [], status: 'completed', error: null } } });
}
