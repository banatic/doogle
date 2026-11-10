// Claude provider — Anthropic Messages API + 사용자가 입력한 API key (PLAN §5.3).
// tool use 루프를 직접 돈다(tool 실행은 hub → studio). 시스템 프롬프트·tool 정의에 prompt caching.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { ProviderError } from '../errors.mjs';
import { getSecret, SECRET_KEYS } from '../secrets.mjs';

export const MODELS = Object.freeze([
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]);
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const AUTH_HINT = '설정에서 Anthropic Console API key를 입력하세요. (Max/Team 플랜은 월간 API 크레딧을 Console key로 사용할 수 있습니다)';
const MAX_ITERATIONS = 60;
const MAX_TOKENS = 64_000;
/** 거절(refusal) 시 서버 측 대체 모델 — Opus/Sonnet 5.5에서만 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

async function resolveApiKey() {
  try {
    const k = await getSecret(SECRET_KEYS.ANTHROPIC_API_KEY);
    if (k) return k;
  } catch { /* keyring 사용 불가 */ }
  return process.env.ANTHROPIC_API_KEY || null;
}

function jsonSchemaFromShape(shape) {
  try {
    const s = z.toJSONSchema(z.object(shape ?? {}), { target: 'draft-7', unrepresentable: 'any' });
    delete s.$schema;
    return s;
  } catch {
    return { type: 'object', properties: {} };
  }
}

/**
 * Messages API tool 정의. tools 모듈의 toolsForProvider('anthropic')가 있으면 그것을 쓰고,
 * 없으면 TOOLS의 zod shape에서 만든다. 마지막 tool에 cache_control.
 */
export function anthropicTools(tools, toolsModule) {
  let defs = [];
  try {
    const fromModule = toolsModule?.toolsForProvider?.('anthropic');
    if (Array.isArray(fromModule) && fromModule.length) defs = fromModule.map((d) => ({ ...d }));
  } catch { /* fallback */ }
  if (!defs.length) {
    defs = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: toolsModule?.toJsonSchema ? safeSchema(toolsModule, t) : jsonSchemaFromShape(t.shape),
    }));
  }
  if (defs.length) defs[defs.length - 1] = { ...defs[defs.length - 1], cache_control: { type: 'ephemeral' } };
  return defs;
}

function safeSchema(toolsModule, t) {
  try {
    const s = toolsModule.toJsonSchema(t.name);
    if (s && typeof s === 'object' && s.type === 'object') return s;
  } catch { /* fallback */ }
  return jsonSchemaFromShape(t.shape);
}

/** hub callTool 결과 → tool_result 블록 */
export function toToolResult(toolUseId, r) {
  if (!r?.ok) {
    return { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: JSON.stringify({ error: r?.error ?? { code: 'TOOL_ERROR' } }) };
  }
  const res = r.result;
  if (res && typeof res === 'object' && res.image && typeof res.image.data === 'string') {
    const { image, ...rest } = res;
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mimeType ?? 'image/png', data: image.data } },
        ...(Object.keys(rest).length ? [{ type: 'text', text: JSON.stringify(rest) }] : []),
      ],
    };
  }
  return { type: 'tool_result', tool_use_id: toolUseId, content: typeof res === 'string' ? res : JSON.stringify(res ?? null) };
}

export default {
  id: 'anthropic-api',
  label: 'Claude (API key)',

  async detect() {
    const key = await resolveApiKey();
    return key
      ? { available: true, models: [...MODELS] }
      : { available: false, reason: 'Anthropic API key가 없습니다.', models: [...MODELS], authHint: AUTH_HINT };
  },

  /**
   * @param {{model?:string, messages:any[], text:string, systemPrompt:string, tools:any[], toolsModule?:any,
   *   callTool:(name:string, args:any)=>Promise<any>, emit:(e:any)=>void, signal:AbortSignal, client?:any}} p
   */
  async runTurn({ model, messages, text, systemPrompt, tools, toolsModule, callTool, emit, signal, client }) {
    const history = [...(Array.isArray(messages) ? messages : []), { role: 'user', content: text }];
    if (!client) {
      const apiKey = await resolveApiKey();
      if (!apiKey) throw new ProviderError('API_KEY_MISSING', `Anthropic API key가 없습니다. ${AUTH_HINT}`);
      client = new Anthropic({ apiKey });
    }
    const modelId = model || DEFAULT_MODEL;
    const toolDefs = anthropicTools(tools, toolsModule);
    const useFallback = FALLBACK_MODELS.has(modelId);
    const base = {
      model: modelId,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' }, // 대화 이력 자동 캐시
      ...(toolDefs.length ? { tools: toolDefs } : {}),
      ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    };

    try {
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        if (signal.aborted) break;
        const api = useFallback ? client.beta.messages : client.messages;
        const stream = api.stream({ ...base, messages: history }, { signal });
        let sawText = false;
        stream.on('text', (delta) => {
          if (!delta) return;
          sawText = true;
          emit({ kind: 'text_delta', text: delta });
        });
        const msg = await stream.finalMessage();
        if (sawText) emit({ kind: 'text_done' });
        if (msg.usage) {
          emit({
            kind: 'usage',
            inputTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
            outputTokens: msg.usage.output_tokens ?? 0,
          });
        }
        history.push({ role: 'assistant', content: msg.content });

        if (msg.stop_reason === 'pause_turn') continue;
        if (msg.stop_reason === 'refusal') {
          throw new ProviderError('REFUSAL', 'Claude가 이 요청에 대한 응답을 거절했습니다.');
        }
        const toolUses = msg.content.filter((b) => b.type === 'tool_use');
        if (!toolUses.length) break;

        const results = [];
        for (const tu of toolUses) {
          if (msg.stop_reason === 'max_tokens' && tu === toolUses[toolUses.length - 1]) {
            results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: '출력 길이 한도로 tool 입력이 잘렸습니다. 더 작은 단위로 나눠 다시 호출하세요.' });
            continue;
          }
          const r = signal.aborted
            ? { ok: false, error: { code: 'CANCELLED', message: '취소되었습니다' } }
            : await callTool(tu.name, tu.input ?? {});
          results.push(toToolResult(tu.id, r));
        }
        // tool_use에는 항상 tool_result가 짝지어져야 이력이 유효하다(취소 시에도).
        history.push({ role: 'user', content: results });
        if (signal.aborted) break;
        if (iter === MAX_ITERATIONS - 1) emit({ kind: 'status', text: 'tool 호출 반복 한도에 도달해 멈췄습니다' });
      }
      return { messages: history };
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return { messages: trimDangling(history) };
      const out = trimDangling(history);
      if (err instanceof ProviderError) throw Object.assign(err, { messages: out });
      if (err instanceof Anthropic.AuthenticationError) {
        throw Object.assign(new ProviderError('API_KEY_INVALID', `Anthropic API key가 유효하지 않습니다. ${AUTH_HINT}`, { cause: err }), { messages: out });
      }
      if (err instanceof Anthropic.RateLimitError) {
        const retry = Number(err.headers?.get?.('retry-after'));
        const resetAt = Number.isFinite(retry) && retry > 0 ? new Date(Date.now() + retry * 1000).toISOString() : undefined;
        emit({ kind: 'limit', message: 'Anthropic API 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.', ...(resetAt ? { resetAt } : {}) });
        throw Object.assign(new ProviderError('LIMIT', 'Anthropic API 요청 한도', { emitted: true, cause: err }), { messages: out });
      }
      if (err instanceof Anthropic.APIError) {
        throw Object.assign(new ProviderError('ANTHROPIC_ERROR', `Anthropic API 오류 ${err.status ?? ''}: ${err.message}`, { cause: err }), { messages: out });
      }
      throw Object.assign(new ProviderError('PROVIDER_ERROR', String(err?.message ?? err), { cause: err }), { messages: out });
    }
  },
};

/** 끝이 tool_result 없는 assistant tool_use면 제거해 다음 턴 이력을 유효하게 유지 */
function trimDangling(history) {
  const h = [...history];
  const last = h[h.length - 1];
  if (last?.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')) h.pop();
  return h;
}
