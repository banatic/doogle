// Codex app-server provider — 사용자가 설치·로그인한 Codex CLI를 stdio JSON-RPC(JSONL)로 구동.
//
// 프로토콜 근거:
//  - `codex app-server generate-ts --experimental` (codex-cli 0.157.1) 로 생성한 타입:
//    InitializeParams{clientInfo{name,title,version}, capabilities{experimentalApi}},
//    ThreadStartParams{model, cwd, approvalPolicy, sandbox, baseInstructions, ephemeral, dynamicTools},
//    DynamicToolSpec = {type:'function',name,description,inputSchema} | {type:'namespace',name,description,tools},
//    ServerRequest 'item/tool/call' DynamicToolCallParams{threadId,turnId,callId,namespace,tool,arguments}
//      → DynamicToolCallResponse{contentItems:[{type:'inputText',text}], success},
//    TurnStartParams{threadId,input:[{type:'text',text,text_elements:[]}],model,effort},
//    TurnInterruptParams{threadId,turnId}, GetAccountParams{refreshToken} → {account, requiresOpenaiAuth},
//    notifications item/agentMessage/delta, item/completed, thread/tokenUsage/updated, turn/completed, error,
//    account/rateLimits/updated.
//  - 2026-11-10 로컬 실측(codex-cli 0.157.1, Windows): 메시지에 "jsonrpc" 필드 없음, initialize → initialized
//    → account/read → thread/start(dynamicTools namespace) → turn/start → item/tool/call(id:0) → 응답 →
//    agentMessage → turn/completed(status:"completed") 전 과정 동작 확인.
//    ⚠ features.code_mode_host 를 끄면 dynamic tool이 "tool host is disabled"로 실패 → 끄지 않는다.
//  - SIWC 토큰 주입: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
//    ACCESS_TOKEN env + -c model_provider="openai_chatgpt_plan" + model_providers.openai_chatgpt_plan.{name,
//    base_url,env_key,wire_api,requires_openai_auth=false,supports_websockets=false}. 토큰 갱신 시 app-server 재시작.
//  - App-server 개요: https://learn.chatgpt.com/docs/app-server
//
// Codex 자체 도구 차단: shell_tool/unified_exec 등 feature 비활성 + sandbox "read-only" + 모든 승인 요청 거절.
// ~/.codex/auth.json 은 읽지 않는다. 로그인 상태는 app-server `account/read`로만 확인한다.

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProviderTools, providerError } from './openai-api.mjs';
import { splitToolImage } from '../tools/index.mjs';
import { msixPackageDirs, newestFile } from './find-exe.mjs';

const CLIENT_INFO = { name: 'doogle', title: '두글', version: '0.1.0' };
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'plugins', 'computer_use', 'browser_use', 'in_app_browser',
  'multi_agent', 'image_generation', 'memories',
];
const REQUEST_TIMEOUT_MS = 60_000;
const SIWC_PROVIDER_ARGS = [
  '-c', 'model_provider="openai_chatgpt_plan"',
  '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
  '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"',
  '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
  '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false',
];

const here = path.dirname(fileURLToPath(import.meta.url));

/** PATH 에 codex 가 있는지 (where/which) */
function codexOnPath(env, platform) {
  try {
    const r = spawnSync(platform === 'win32' ? 'where' : 'which', ['codex'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 && String(r.stdout ?? '').trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Codex 데스크탑 앱이 품고 있는 codex.exe (Windows) — CLI 를 따로 깔지 않은 PC 에서도 쓰게.
 * 앱은 %LOCALAPPDATA%\OpenAI\Codex\bin\<빌드>\codex.exe 에 둔다(빌드마다 폴더가 바뀌어 가장 최근 것을 고른다).
 * MSIX 가상화로 %LOCALAPPDATA%\Packages\OpenAI.Codex_<id>\LocalCache\Local\OpenAI\Codex\bin 에 있을 수도 있다.
 */
export function desktopCodexBinary(env = process.env, platform = process.platform) {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return null;
  const roots = [path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin')];
  for (const pkg of msixPackageDirs(env, 'OpenAI.Codex_')) roots.push(path.join(pkg, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin'));
  return newestFile(roots, 'codex.exe', 1);
}

/** 실행할 codex — DOOGLE_CODEX_PATH → PATH 의 codex → Codex 데스크탑 앱 안. 다 없으면 'codex'(ENOENT 로 안내). */
export function findCodex(env = process.env, platform = process.platform) {
  if (env.DOOGLE_CODEX_PATH) return env.DOOGLE_CODEX_PATH;
  if (codexOnPath(env, platform)) return 'codex';
  return desktopCodexBinary(env, platform) || 'codex';
}
export const DOOGLE_MCP_BIN = path.resolve(here, '..', '..', 'bin', 'doogle-mcp.mjs');

async function getSpawn() {
  try {
    const m = await import('cross-spawn'); // Windows .cmd 셔임 처리
    return m.default?.spawn || m.spawn || m.default;
  } catch {
    const cp = await import('node:child_process');
    return (cmd, args, o) => cp.spawn(cmd, args, { ...o, shell: process.platform === 'win32' });
  }
}

/** JSONL JSON-RPC 클라이언트 (app-server는 "jsonrpc" 필드를 쓰지 않는다 — 실측). */
export class AppServerConnection {
  /** @param {import('node:child_process').ChildProcess} child */
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    /** @type {Map<number|string, {resolve:Function, reject:Function, timer:any}>} */
    this.pending = new Map();
    this.onNotification = (_m, _p) => {};
    /** @type {(method:string, params:any) => Promise<any>} */
    this.onRequest = async (method) => { throw Object.assign(new Error(`unsupported: ${method}`), { rpcCode: -32601 }); };
    this.closed = false;
    this.stderrTail = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.#handleLine(line);
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => { this.stderrTail = (this.stderrTail + d).slice(-4000); });
    const onGone = (why) => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`codex app-server 종료: ${why}`)); }
      this.pending.clear();
      this.onClose?.(why);
    };
    child.on('exit', (code, sig) => onGone(`exit ${code ?? sig}`));
    child.on('error', (e) => onGone(e.message));
    child.stdin.on('error', () => {});
  }

  #write(obj) {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  #handleLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method && m.id !== undefined && m.id !== null) {
      // 서버 → 클라이언트 요청
      Promise.resolve()
        .then(() => this.onRequest(m.method, m.params))
        .then((result) => this.#write({ id: m.id, result }))
        .catch((e) => this.#write({ id: m.id, error: { code: e?.rpcCode ?? -32000, message: e?.message || String(e) } }));
      return;
    }
    if (m.method) { this.onNotification(m.method, m.params); return; }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(m.error.message || 'app-server error'), { rpc: m.error }));
    else p.resolve(m.result);
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('codex app-server가 종료되었습니다.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 시간 초과`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method, params) { this.#write(params === undefined ? { method } : { method, params }); }

  close() {
    if (this.closed) return;
    try { this.child.stdin.end(); } catch { /* ignore */ }
    try { this.child.kill(); } catch { /* ignore */ }
  }
}

/** 서버 → 클라이언트 승인/입력 요청은 모두 거절 (Codex 자체 셸·파일 수정 차단). */
export function denyServerRequest(method, params, { mcpMode = false } = {}) {
  switch (method) {
    case 'item/commandExecution/requestApproval': return { decision: 'decline' };
    case 'item/fileChange/requestApproval': return { decision: 'decline' };
    case 'item/permissions/requestApproval': return { permissions: {}, scope: 'turn' };
    case 'execCommandApproval':
    case 'applyPatchApproval': return { decision: { denied: { rejection: '두글에서는 Codex 셸/파일 수정을 사용하지 않습니다.' } } };
    case 'item/tool/requestUserInput': return { answers: {} };
    case 'mcpServer/elicitation/request':
      // MCP 폴백 모드에서 두글 자신의 MCP 서버(doogle) 도구 승인만 허용 (UNVERIFIED: 승인 경로가 elicitation인지 미확인)
      if (mcpMode && params?.serverName === 'doogle' && params?.mode === 'form') return { action: 'accept', content: {}, _meta: null };
      return { action: 'decline', content: null, _meta: null };
    default:
      return undefined;
  }
}

function toUserText(messages, text) {
  // Codex 스레드를 새로 만들었는데 hub 히스토리가 있으면 이전 대화를 요약 텍스트로 앞에 붙인다.
  const prior = (Array.isArray(messages) ? messages : [])
    .map((m) => {
      const role = m?.role;
      if (role !== 'user' && role !== 'assistant') return null;
      const c = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content) ? m.content.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('') : '';
      return c ? `${role === 'user' ? '사용자' : '어시스턴트'}: ${c}` : null;
    })
    .filter(Boolean);
  if (!prior.length) return text;
  return `[이전 대화]\n${prior.join('\n')}\n[/이전 대화]\n\n${text}`;
}

function summarize(v) {
  try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 200 ? `${s.slice(0, 200)}…` : s; } catch { return ''; }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.command] codex 실행 파일 (기본 findCodex(): env DOOGLE_CODEX_PATH → PATH → Codex 데스크탑 앱)
 * @param {string[]} [opts.prefixArgs] command 뒤, 'app-server' 앞에 붙는 인자 (테스트: node fake.mjs)
 * @param {boolean} [opts.useSiwcToken] SIWC access token을 ACCESS_TOKEN으로 주입 (env DOOGLE_CODEX_SIWC=1)
 * @param {'dynamic'|'mcp'} [opts.toolMode] dynamicTools(기본) 또는 doogle-mcp 폴백 (env DOOGLE_CODEX_TOOL_MODE)
 * @param {() => Promise<string>} [opts.getSiwcToken]
 * @param {string} [opts.workDir] Codex cwd (빈 작업 디렉터리)
 * @param {string} [opts.effort] reasoning effort
 */
export function createCodexAppServerProvider(opts = {}) {
  const commandFor = () => opts.command || findCodex();
  const prefixArgs = opts.prefixArgs || [];
  const useSiwc = opts.useSiwcToken ?? process.env.DOOGLE_CODEX_SIWC === '1';
  const toolMode = opts.toolMode || (process.env.DOOGLE_CODEX_TOOL_MODE === 'mcp' ? 'mcp' : 'dynamic');
  const getSiwcToken = opts.getSiwcToken || (async () => (await import('../auth/siwc.mjs')).getAccessToken());

  /** @type {AppServerConnection|null} */
  let conn = null;
  let connP = null;
  let connToken = null;
  /** doogle threadId → codex thread id (현재 연결에서만 유효) */
  const threads = new Map();
  /** codex threadId → 진행 중 턴 핸들러 */
  const active = new Map();
  let lastRateLimit = null;
  let detectCache = null;

  async function workDir() {
    let dir = opts.workDir;
    if (!dir) {
      try { dir = path.join((await import('../paths.mjs')).appDataDir(), 'codex-workspace'); } catch { dir = path.join(os.tmpdir(), 'doogle-codex-workspace'); }
    }
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  function buildArgs() {
    const args = [...prefixArgs, 'app-server', '--listen', 'stdio://'];
    for (const f of DISABLED_FEATURES) args.push('--disable', f);
    args.push('-c', 'web_search="disabled"');
    if (useSiwc) args.push(...SIWC_PROVIDER_ARGS);
    if (toolMode === 'mcp') {
      args.push('-c', `mcp_servers.doogle.command=${JSON.stringify(process.execPath)}`);
      args.push('-c', `mcp_servers.doogle.args=[${JSON.stringify(DOOGLE_MCP_BIN)}]`);
      args.push('-c', 'mcp_servers.doogle.tool_timeout_sec=900'); // 쓰기 도구는 사용자 검토 대기
    }
    return args;
  }

  async function startConnection() {
    const env = { ...process.env };
    let token = null;
    if (useSiwc) {
      token = await getSiwcToken();
      env.ACCESS_TOKEN = token;
    }
    const spawn = await getSpawn();
    const child = spawn(commandFor(), buildArgs(), { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    const c = new AppServerConnection(child);
    c.onClose = () => { if (conn === c) { conn = null; connP = null; threads.clear(); } for (const h of active.values()) h.fail(new Error('codex app-server가 예기치 않게 종료되었습니다.')); };
    c.onNotification = (method, params) => {
      if (method === 'account/rateLimits/updated') lastRateLimit = params?.rateLimits || null;
      const h = params?.threadId ? active.get(params.threadId) : null;
      if (h) h.notify(method, params);
    };
    c.onRequest = async (method, params) => {
      if (method === 'item/tool/call') {
        const h = active.get(params?.threadId);
        if (!h) return { contentItems: [{ type: 'inputText', text: '활성 턴이 없습니다.' }], success: false };
        return h.toolCall(params);
      }
      const r = denyServerRequest(method, params, { mcpMode: toolMode === 'mcp' });
      if (r !== undefined) return r;
      throw Object.assign(new Error(`두글은 ${method}를 지원하지 않습니다.`), { rpcCode: -32601 });
    };
    try {
      await c.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }, 30_000);
    } catch (e) {
      c.close();
      const tail = c.stderrTail.trim().split('\n').slice(-3).join(' ');
      throw await providerError('CODEX_START_FAILED', `codex app-server 시작 실패: ${e.message}${tail ? ` (${tail})` : ''}`, { cause: e });
    }
    c.notify('initialized');
    conn = c;
    connToken = token;
    return c;
  }

  async function ensureConnection() {
    if (useSiwc && conn) {
      // SIWC 토큰이 바뀌면(갱신) app-server 재시작 (문서: restart with the renewed ACCESS_TOKEN)
      const t = await getSiwcToken();
      if (t !== connToken && active.size === 0) { conn.close(); conn = null; connP = null; threads.clear(); }
    }
    if (conn && !conn.closed) return conn;
    if (!connP) connP = startConnection().catch((e) => { connP = null; throw e; });
    return connP;
  }

  async function buildDynamicTools(contractTools) {
    const { tools } = await loadProviderTools('codex-dynamic', contractTools);
    if (tools.some((t) => t?.type === 'namespace')) return tools;
    const fns = tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || t.parameters || { type: 'object', properties: {} },
    }));
    return fns.length ? [{ type: 'namespace', name: 'doogle', description: '두글 문서 편집 도구', tools: fns }] : [];
  }

  async function listModels(c) {
    try {
      const r = await c.request('model/list', {}, 20_000);
      return (r?.data || []).filter((m) => !m.hidden).map((m) => ({ id: m.model || m.id, label: m.displayName || m.model || m.id }));
    } catch {
      return [];
    }
  }

  const provider = {
    id: 'codex-app-server',
    label: 'ChatGPT (Codex 앱 재사용)',

    async detect() {
      if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache.value;
      let value;
      try {
        const c = await ensureConnection();
        let account = null, requiresOpenaiAuth = true;
        if (useSiwc) {
          requiresOpenaiAuth = false;
        } else {
          const r = await c.request('account/read', { refreshToken: false }, 20_000);
          account = r?.account || null;
          requiresOpenaiAuth = !!r?.requiresOpenaiAuth;
        }
        const models = await listModels(c);
        if (!account && requiresOpenaiAuth) {
          value = { available: false, reason: 'Codex에 로그인되어 있지 않습니다.', models, authHint: '터미널에서 `codex login`을 실행해 ChatGPT로 로그인하세요.' };
        } else {
          value = { available: true, models };
        }
      } catch (e) {
        const notFound = /ENOENT|not recognized|not found/i.test(String(e?.message));
        value = {
          available: false,
          reason: notFound ? 'Codex를 찾지 못했습니다.' : `Codex 확인 실패: ${e?.message || e}`,
          models: [],
          authHint: notFound ? 'Codex 데스크탑 앱을 설치하거나 Codex CLI를 설치하세요(npm i -g @openai/codex). ChatGPT 데스크탑 앱에는 Codex가 들어 있지 않으니, 그때는 "ChatGPT로 로그인"을 쓰세요.' : undefined,
        };
      }
      detectCache = { at: Date.now(), value };
      return value;
    },

    async runTurn({ threadId, model, messages, text, systemPrompt, tools, callTool, emit, signal }) {
      const c = await ensureConnection();
      let codexThreadId = threads.get(threadId);
      let fresh = false;
      if (!codexThreadId) {
        const params = {
          ephemeral: true, // 문서 내용을 ~/.codex 세션 기록에 남기지 않음
          cwd: await workDir(),
          sandbox: 'read-only',
          approvalPolicy: 'never',
          baseInstructions: systemPrompt || undefined,
        };
        if (model) params.model = model;
        if (toolMode === 'dynamic') params.dynamicTools = await buildDynamicTools(tools);
        let r;
        try {
          r = await c.request('thread/start', params);
        } catch (e) {
          throw await providerError('CODEX_THREAD_FAILED', `Codex 스레드 시작 실패: ${e.message}`, { cause: e });
        }
        codexThreadId = r?.thread?.id;
        if (!codexThreadId) throw await providerError('CODEX_THREAD_FAILED', 'Codex 스레드 ID를 받지 못했습니다.');
        threads.set(threadId, codexThreadId);
        fresh = true;
      }

      const inputText = fresh ? toUserText(messages, text) : text;
      let fullText = '';
      let textOpen = false;
      const deltaItems = new Set();
      let usage = null;
      let turnId = null;
      let lastError = null;
      let finish, fail;
      const done = new Promise((res, rej) => { finish = res; fail = rej; });

      const handler = {
        fail: (e) => fail(e),
        notify(method, p) {
          if (turnId && p?.turnId && p.turnId !== turnId) return;
          switch (method) {
            case 'item/agentMessage/delta':
              if (p.delta) { deltaItems.add(p.itemId); fullText += p.delta; textOpen = true; emit({ kind: 'text_delta', text: p.delta }); }
              break;
            case 'item/completed': {
              const it = p.item;
              if (it?.type === 'agentMessage' && !deltaItems.has(it.id) && it.text) {
                fullText += it.text; textOpen = true; emit({ kind: 'text_delta', text: it.text });
              }
              if (it?.type === 'agentMessage' && textOpen) { emit({ kind: 'text_done' }); textOpen = false; fullText += '\n'; }
              if (it?.type === 'mcpToolCall' && it.server === 'doogle') {
                emit({ kind: 'tool_result', callId: it.id, ok: it.status === 'completed', summary: summarize(it.result ?? it.error) });
              }
              break;
            }
            case 'item/started':
              if (p.item?.type === 'mcpToolCall' && p.item.server === 'doogle') {
                emit({ kind: 'tool_use', callId: p.item.id, name: p.item.tool, args: p.item.arguments ?? {} });
              }
              break;
            case 'thread/tokenUsage/updated':
              usage = p.tokenUsage?.last || usage;
              break;
            case 'error':
              if (!p.willRetry) lastError = p.error;
              break;
            case 'turn/completed':
              if (!turnId || p.turn?.id === turnId) finish(p.turn);
              break;
            default:
              break;
          }
        },
        async toolCall(p) {
          const name = p.tool;
          const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
          emit({ kind: 'tool_use', callId: p.callId, name, args });
          let r;
          try { r = await callTool(name, args); } catch (e) { r = { ok: false, error: { code: 'TOOL_FAILED', message: e?.message || String(e) } }; }
          const ok = !!r?.ok;
          emit({ kind: 'tool_result', callId: p.callId, ok, summary: summarize(ok ? r.result : r?.error) });
          // 그림은 inputImage 로 떼어 보낸다 — base64 를 텍스트에 넣으면 수십만 자가 된다
          const { image, rest } = ok ? splitToolImage(r.result) : { image: null, rest: null };
          const payload = ok ? { ok: true, result: rest } : { ok: false, error: r?.error };
          return {
            contentItems: [
              { type: 'inputText', text: JSON.stringify(payload) },
              ...(image ? [{ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.data}` }] : []),
            ],
            success: ok,
          };
        },
      };
      active.set(codexThreadId, handler);

      const onAbort = () => {
        if (turnId) c.request('turn/interrupt', { threadId: codexThreadId, turnId }, 10_000).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const turnParams = { threadId: codexThreadId, input: [{ type: 'text', text: inputText, text_elements: [] }] };
        if (model) turnParams.model = model;
        if (opts.effort) turnParams.effort = opts.effort;
        let started;
        try {
          started = await c.request('turn/start', turnParams);
        } catch (e) {
          threads.delete(threadId);
          throw await providerError('CODEX_TURN_FAILED', `Codex 턴 시작 실패: ${e.message}`, { cause: e });
        }
        turnId = started?.turn?.id || null;
        if (signal?.aborted) onAbort();
        const turn = await done;
        if (textOpen) { emit({ kind: 'text_done' }); textOpen = false; }
        if (usage) emit({ kind: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

        const history = [...(Array.isArray(messages) ? messages : []), { role: 'user', content: text }];
        if (fullText.trim()) history.push({ role: 'assistant', content: fullText.trim() });

        if (turn?.status === 'failed') {
          const err = turn.error || lastError || {};
          const info = err.codexErrorInfo;
          if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') {
            const resetsAt = lastRateLimit?.primary?.resetsAt ? new Date(lastRateLimit.primary.resetsAt * 1000).toISOString() : undefined;
            emit({ kind: 'limit', message: 'Codex(ChatGPT) 사용 한도에 도달했습니다.', ...(resetsAt ? { resetAt: resetsAt } : {}) });
            throw await providerError('LIMIT', 'Codex 사용 한도 초과', { emitted: true });
          }
          if (info === 'unauthorized') throw await providerError('CODEX_LOGIN_REQUIRED', 'Codex 인증이 거부되었습니다. `codex login`으로 다시 로그인하세요.');
          let msg = err.message || 'Codex 턴 실패';
          try { msg = JSON.parse(msg)?.error?.message || msg; } catch { /* 원문 유지 */ }
          throw await providerError('CODEX_TURN_FAILED', msg);
        }
        // interrupted → hub가 signal로 cancelled 처리
        return { messages: history };
      } catch (e) {
        if (signal?.aborted && !e?.code) return { messages: [...(messages || []), { role: 'user', content: text }] };
        throw e;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        active.delete(codexThreadId);
      }
    },

    /** 앱 종료 시 정리 */
    async dispose() { conn?.close(); conn = null; connP = null; threads.clear(); },
  };
  return provider;
}

export default createCodexAppServerProvider();
