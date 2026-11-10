// OpenAI Responses API provider (사용자 API key) + SIWC provider와 공유하는 Responses 루프.
//
// 참고:
//  - Responses 스트리밍 이벤트(response.output_text.delta / response.output_item.done /
//    response.completed / response.failed / response.incomplete):
//    https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//  - function tool / namespace 형식: https://developers.openai.com/api/docs/guides/function-calling
//
// 히스토리(messages) 형식: Responses `input` 항목 배열 그대로 보관한다
// ({type:'message', role, content} / {type:'function_call', call_id, name, arguments} /
//  {type:'function_call_output', call_id, output} / {type:'reasoning', encrypted_content, ...}).
// store:false 이므로 매 요청마다 필요한 히스토리 전체를 input으로 보낸다(previous_response_id 미사용).
//
// 턴 종료(turn_end)는 hub가 emit한다. provider는 text_delta/text_done/tool_use/tool_result/usage/limit만
// 내보내고, 실패는 ProviderError를 던진다(이미 limit을 emit했으면 emitted:true).

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_TOOL_ROUNDS = 40;
const SECRET_OPENAI_API_KEY = 'openai-api-key';

export const DEFAULT_OPENAI_MODELS = [
  // 문서 예시 모델(models-and-inference). 실제 사용 가능 모델은 계정/키에 따라 다르다.
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna (빠름)' },
];

/** ProviderError (src/errors.mjs, agent C) — 없으면 동일 형태의 로컬 클래스. */
let ProviderErrorClass = null;
async function providerError(code, message, opts = {}) {
  if (!ProviderErrorClass) {
    try {
      ProviderErrorClass = (await import('../errors.mjs')).ProviderError;
    } catch {
      ProviderErrorClass = class ProviderError extends Error {
        constructor(c, m, o = {}) { super(m); this.name = 'ProviderError'; this.code = c; this.emitted = !!o.emitted; }
      };
    }
  }
  return new ProviderErrorClass(code, message, opts);
}
export { providerError };

/**
 * Tool 정의 모듈(agent B)에서 provider용 tool 배열을 얻는다. 모듈이 아직 없으면 runTurn의 tools로 대체.
 * @param {'openai-responses'|'codex-dynamic'} kind
 * @param {any[]} [fallbackTools] CONTRACT §4 TOOLS
 */
export async function loadProviderTools(kind, fallbackTools = []) {
  try {
    const m = await import('../tools/index.mjs');
    if (typeof m.toolsForProvider === 'function') return { tools: m.toolsForProvider(kind), toolsModule: m };
  } catch {
    // tools 모듈 미완성 — 아래 대체 경로
  }
  const tools = (fallbackTools || []).map((t) => {
    const schema = t.parameters || t.inputSchema || t.input_schema || t.jsonSchema || { type: 'object', properties: {} };
    return kind === 'codex-dynamic'
      ? { type: 'function', name: t.name, description: t.description || '', inputSchema: schema }
      : { type: 'function', name: t.name, description: t.description || '', parameters: schema };
  });
  return { tools, toolsModule: null };
}

/** 이전 provider(예: Claude)의 히스토리가 섞여 있어도 Responses input으로 쓸 수 있는 항목만 남긴다. */
export function sanitizeHistory(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'function_call' || m.type === 'function_call_output') { out.push(m); continue; }
    if (m.type === 'reasoning') { if (m.encrypted_content) out.push(m); continue; }
    if ((m.type === 'message' || !m.type) && (m.role === 'user' || m.role === 'assistant' || m.role === 'developer')) {
      if (typeof m.content === 'string') { out.push({ type: 'message', role: m.role, content: m.content }); continue; }
      if (Array.isArray(m.content)) {
        // Responses 형식이면 그대로, 다른 형식(Anthropic 블록 등)이면 텍스트만 추출
        const isResp = m.content.every((c) => c && /^(input_text|output_text|input_image|input_file|refusal)$/.test(c.type));
        if (isResp) { out.push({ type: 'message', role: m.role, content: m.content }); continue; }
        const text = m.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).filter(Boolean).join('\n');
        if (text) out.push({ type: 'message', role: m.role, content: text });
      }
    }
  }
  return out;
}

/** 출력 항목을 다음 요청 input에 넣을 수 있게 정리. store:false라 서버측 id 참조는 제거한다. */
function toInputItem(item) {
  switch (item?.type) {
    case 'message': {
      const content = (item.content || [])
        .filter((c) => c.type === 'output_text' || c.type === 'refusal')
        .map((c) => (c.type === 'refusal' ? { type: 'output_text', text: c.refusal || '' } : { type: 'output_text', text: c.text || '' }));
      return content.length ? { type: 'message', role: 'assistant', content } : null;
    }
    case 'function_call': {
      const o = { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' };
      if (item.namespace) o.namespace = item.namespace;
      return o;
    }
    case 'reasoning':
      // encrypted_content가 있어야 store:false에서 재사용 가능 (include: reasoning.encrypted_content)
      return item.encrypted_content ? { type: 'reasoning', id: item.id, summary: item.summary || [], encrypted_content: item.encrypted_content } : null;
    default:
      return null;
  }
}

/** SSE 바이트 스트림 → {event, data} 비동기 반복자 */
export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buf = '';
  const flush = function* () {
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      let event = null; const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  };
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      yield* flush();
    }
  } else if (body && Symbol.asyncIterator in body) {
    for await (const chunk of body) {
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      yield* flush();
    }
  }
  buf += decoder.decode();
  if (buf.trim()) { buf += '\n\n'; yield* flush(); }
}

// errors-and-recovery 페이지의 구조화 오류 코드
const LIMIT_CODES = {
  subscription_sharing_usage_limit_exceeded:
    'ChatGPT 플랜 사용 한도를 모두 사용했습니다. https://chatgpt.com/settings/usage 에서 사용량을 확인하거나 OpenAI API key로 전환하세요.',
  subscription_sharing_usage_unavailable:
    'ChatGPT 플랜 사용이 일시적으로 불가합니다. 잠시 후 다시 시도하거나 OpenAI API key로 전환하세요.',
};
const AUTH_CODES = new Set(['subscription_sharing_invalid_user', 'invalid_api_key']);

/**
 * 오류(HTTP 본문 또는 response.failed/error 이벤트)를 처리: limit이면 emit 후 ProviderError(emitted).
 * @returns {Promise<Error>}
 */
async function classifyError({ status, error, detail, emit, authKind }) {
  const code = error?.code || error?.type || null;
  if (code && LIMIT_CODES[code]) {
    emit({ kind: 'limit', message: LIMIT_CODES[code] });
    return providerError('LIMIT', LIMIT_CODES[code], { emitted: true });
  }
  if (status === 429 && authKind === 'apiKey') {
    const msg = error?.message || 'OpenAI API 요청 한도에 도달했습니다.';
    emit({ kind: 'limit', message: msg });
    return providerError('LIMIT', msg, { emitted: true });
  }
  if (status === 401 || (code && AUTH_CODES.has(code))) {
    return authKind === 'siwc'
      ? providerError('SIWC_LOGIN_REQUIRED', 'ChatGPT 인증이 거부되었습니다. 계정과 권한을 확인하고 다시 로그인하세요.')
      : providerError('API_KEY_INVALID', 'OpenAI API key가 거부되었습니다. 설정에서 key를 확인하세요.');
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return providerError('NOT_ELIGIBLE', '이 ChatGPT 계정은 플랜 사용 공유 대상이 아닙니다. OpenAI API key를 사용하세요.');
  }
  if (code === 'subscription_sharing_unsupported_capability') {
    return providerError('UNSUPPORTED_CAPABILITY',
      `ChatGPT 플랜 경로에서 지원하지 않는 요청입니다${error?.param ? ` (${error.param})` : ''}.`);
  }
  const msg = error?.message || detail || `OpenAI 요청 실패 (HTTP ${status ?? '?'})`;
  return providerError(code ? String(code).toUpperCase() : 'PROVIDER_ERROR', msg);
}

function summarize(result) {
  try {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return '';
  }
}

/**
 * Responses API function-tool 루프 (공용).
 * @param {object} p
 * @param {(o:{forceRefresh?:boolean})=>Promise<string>} p.getToken bearer token 공급자
 * @param {'apiKey'|'siwc'} p.authKind
 * @param {boolean} [p.namespaceTools] SIWC: function tool을 namespace로 묶어 보낸다(preview-limitations)
 * @param {typeof fetch} [p.fetch]
 * @param {string} [p.url]
 * @param {object} p.turn CONTRACT §5 runTurn 인자
 */
export async function runResponsesTurn({ getToken, authKind, namespaceTools = false, fetch: doFetch = globalThis.fetch, url = RESPONSES_URL, turn }) {
  const { model, messages, text, systemPrompt, tools: contractTools, callTool, emit, signal } = turn;
  const history = sanitizeHistory(messages);
  if (text) history.push({ type: 'message', role: 'user', content: text });

  const { tools: fnTools } = await loadProviderTools('openai-responses', contractTools);
  const plainFns = fnTools.filter((t) => t && t.type === 'function');
  const requestTools = namespaceTools && plainFns.length
    ? [{ type: 'namespace', name: 'doogle', description: '두글 문서 편집 도구', tools: plainFns },
       ...fnTools.filter((t) => t && t.type !== 'function')]
    : fnTools;
  const toolNames = new Set(plainFns.map((t) => t.name));

  let usageIn = 0, usageOut = 0, sawUsage = false;
  let textOpen = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) break;
    const body = {
      model,
      input: history,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
    };
    if (systemPrompt) body.instructions = systemPrompt; // system 메시지 항목 대신 instructions (preview-limitations)
    if (requestTools.length) { body.tools = requestTools; body.parallel_tool_calls = false; }

    let res;
    for (let attempt = 0; ; attempt++) {
      const token = await getToken({ forceRefresh: attempt > 0 });
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (signal?.aborted) return { messages: history };
        throw await providerError('NETWORK', `OpenAI 연결 실패: ${e?.message || e}`, { cause: e });
      }
      // SIWC: 401이면 토큰 갱신 후 1회 재시도
      if (res.status === 401 && authKind === 'siwc' && attempt === 0) {
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        continue;
      }
      break;
    }
    if (!res.ok) {
      let parsed = null;
      try { parsed = await res.json(); } catch { parsed = null; }
      throw await classifyError({ status: res.status, error: parsed?.error, detail: parsed?.detail, emit, authKind });
    }

    const outputItems = [];
    let completed = null;
    try {
      for await (const { data } of parseSse(res.body)) {
        if (data === '[DONE]') break;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        switch (ev.type) {
          case 'response.output_text.delta':
            if (ev.delta) { textOpen = true; emit({ kind: 'text_delta', text: ev.delta }); }
            break;
          case 'response.output_item.done':
            if (ev.item) outputItems.push(ev.item);
            break;
          case 'response.completed':
            completed = ev.response || {};
            break;
          case 'response.incomplete':
            completed = { ...(ev.response || {}), incomplete: true };
            break;
          case 'response.failed':
            throw await classifyError({ status: null, error: ev.response?.error, emit, authKind });
          case 'error':
            throw await classifyError({ status: null, error: ev.error || ev, emit, authKind });
          default:
            break;
        }
      }
    } catch (e) {
      if (signal?.aborted) return { messages: history };
      throw e;
    }
    if (!completed) {
      if (signal?.aborted) return { messages: history };
      throw await providerError('STREAM_INCOMPLETE', 'OpenAI 응답 스트림이 response.completed 없이 끝났습니다.');
    }
    const u = completed.usage;
    if (u) { sawUsage = true; usageIn += u.input_tokens || 0; usageOut += u.output_tokens || 0; }

    const items = outputItems.length ? outputItems : (completed.output || []);
    const calls = [];
    for (const it of items) {
      const inp = toInputItem(it);
      if (inp) history.push(inp);
      if (it.type === 'function_call') calls.push(it);
    }
    if (textOpen) { emit({ kind: 'text_done' }); textOpen = false; }
    if (completed.incomplete && !calls.length) {
      emit({ kind: 'status', text: `응답이 중단되었습니다(${completed.incomplete_details?.reason || 'incomplete'}).` });
    }
    if (!calls.length) break;

    for (const call of calls) {
      if (signal?.aborted) break;
      // namespace 도구는 name이 "doogle.x" 또는 name:"x", namespace:"doogle" 로 올 수 있다(미확인) → 둘 다 처리
      let name = call.name || '';
      if (!toolNames.has(name) && name.includes('.')) name = name.slice(name.lastIndexOf('.') + 1);
      let args = {};
      try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = { __raw: call.arguments }; }
      emit({ kind: 'tool_use', callId: call.call_id, name, args });
      let r;
      try {
        r = await callTool(name, args);
      } catch (e) {
        r = { ok: false, error: { code: 'TOOL_FAILED', message: e?.message || String(e) } };
      }
      const ok = !!r?.ok;
      emit({ kind: 'tool_result', callId: call.call_id, ok, summary: summarize(ok ? r.result : r?.error) });
      history.push({ type: 'function_call_output', call_id: call.call_id, output: functionCallOutput(r) });
    }
    if (round === MAX_TOOL_ROUNDS - 1) emit({ kind: 'status', text: 'tool 호출 횟수 제한에 도달해 턴을 종료합니다.' });
  }
  if (sawUsage) emit({ kind: 'usage', inputTokens: usageIn, outputTokens: usageOut });
  return { messages: history };
}

async function getApiKey(ctx) {
  if (ctx?.openaiApiKey) return ctx.openaiApiKey;
  try {
    const { getSecret } = await import('../secrets.mjs');
    const k = await getSecret(SECRET_OPENAI_API_KEY);
    if (k) return k;
  } catch {
    // secrets 모듈 없음
  }
  return process.env.OPENAI_API_KEY || null;
}

/**
 * @param {{fetch?: typeof fetch, getApiKey?: () => Promise<string|null>}} [deps]
 */
export function createOpenAIApiProvider(deps = {}) {
  const keyOf = deps.getApiKey || (() => getApiKey());
  return {
    id: 'openai-api',
    label: 'OpenAI (API key)',
    async detect() {
      const key = await keyOf();
      return key
        ? { available: true, models: DEFAULT_OPENAI_MODELS }
        : { available: false, reason: 'OpenAI API key가 설정되지 않았습니다.', models: DEFAULT_OPENAI_MODELS, authHint: '설정에서 OpenAI API key를 입력하세요.' };
    },
    async runTurn(turn) {
      const key = await keyOf();
      if (!key) throw await providerError('API_KEY_MISSING', 'OpenAI API key가 설정되지 않았습니다.');
      return runResponsesTurn({
        getToken: async () => key,
        authKind: 'apiKey',
        fetch: deps.fetch,
        turn: { ...turn, model: turn.model || DEFAULT_OPENAI_MODELS[0].id },
      });
    },
  };
}

export default createOpenAIApiProvider();

import { splitToolImage } from '../tools/index.mjs';

/**
 * tool 결과 → Responses `function_call_output.output`. 그림은 input_image 항목으로 떼어 보낸다
 * (base64 를 JSON 문자열에 넣으면 수십만 자의 텍스트 토큰이 된다).
 */
export function functionCallOutput(r) {
  if (!r?.ok) return JSON.stringify({ ok: false, error: r?.error });
  const { image, rest } = splitToolImage(r.result);
  if (!image) return JSON.stringify({ ok: true, result: r.result });
  return [
    { type: 'input_text', text: JSON.stringify({ ok: true, result: rest }) },
    { type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` },
  ];
}
