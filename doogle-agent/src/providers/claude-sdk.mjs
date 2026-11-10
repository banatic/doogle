// Claude provider — Claude Agent SDK + 사용자가 직접 로그인한 Claude Code (PLAN §5.5').
// Ported (in part) from banatic/rhwp-x (MIT) rhwp/rhwp-agent/agents/claude.mjs
// (SDK query 옵션, stream_event/assistant/result/rate_limit_event 처리).
//
// 정책 (CONTRACT §0, TOOLS.md §4):
// - Claude 자격증명(~/.claude/.credentials.json, Keychain 등)을 읽기/복사/저장/중계하지 않는다.
// - 격리 홈(CLAUDE_CONFIG_DIR)·자격증명 미러링을 쓰지 않는다. SDK는 사용자의 기본 환경 그대로 실행한다.
// - 두글은 claude.ai 로그인 UI를 제공하지 않는다. 미로그인이면 터미널에서 `claude` → /login 안내.
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import spawn from 'cross-spawn';

import { ProviderError } from '../errors.mjs';
import { appDataDir } from '../paths.mjs';

const require = createRequire(import.meta.url);

export const MODELS = Object.freeze([
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]);
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const AUTH_HINT = '두글은 Claude 로그인 화면을 제공하지 않습니다. 터미널에서 `claude`를 실행한 뒤 /login 으로 로그인하고 다시 시도하세요.';
const MCP_PREFIX = 'mcp__doogle__';
const SESSION_MARKER = 'claude-sdk-session';

const LOGIN_TEXT = /not logged in|please run \/login|\/login\b|invalid api key|authentication[_ ](?:failed|error|required)|oauth token (?:has )?(?:expired|been revoked|is invalid)|\b401\b/i;
const MISSING_SESSION = /No conversation found with session ID/i;

// ── 실행 파일 위치 ────────────────────────────────────────────

/** SDK에 포함된 플랫폼별 Claude Code 바이너리 경로 (없으면 null) */
export function bundledClaudeBinary(platform = process.platform, arch = process.arch) {
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  for (const pkg of [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`, `@anthropic-ai/claude-agent-sdk-${platform}-${arch}-musl`]) {
    try {
      return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), exe);
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/** PATH의 `claude` 실행 파일 (없으면 null) */
export function claudeOnPath(env = process.env, platform = process.platform) {
  const finder = platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawn.sync(finder, ['claude'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status !== 0) return null;
    const first = String(r.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 로그인 여부를 사용자의 Claude Code CLI에 묻는다(`claude auth status --json`).
 * 자격증명 파일을 직접 보지 않으며, 출력 중 `loggedIn` 불리언만 사용하고 나머지는 버린다.
 * @returns {Promise<boolean|null>} 알 수 없으면 null
 */
export function cliLoggedIn(bin, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(bin, ['auth', 'status', '--json'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const v = JSON.parse(out)?.loggedIn;
        finish(typeof v === 'boolean' ? v : null);
      } catch {
        finish(null);
      }
    });
  });
}

async function loadSdk() {
  return import('@anthropic-ai/claude-agent-sdk');
}

// ── tool 결과 변환 ────────────────────────────────────────────

/** hub callTool 결과 → MCP CallToolResult */
export function toCallToolResult(r) {
  if (!r?.ok) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: r?.error ?? { code: 'TOOL_ERROR', message: 'tool 실행 실패' } }) }] };
  }
  const res = r.result;
  if (res && Array.isArray(res.content) && res.content.every((b) => b && typeof b.type === 'string')) {
    return { content: res.content };
  }
  if (res && typeof res === 'object' && res.image && typeof res.image.data === 'string') {
    const { image, ...rest } = res;
    return {
      content: [
        { type: 'image', data: image.data, mimeType: image.mimeType ?? 'image/png' },
        ...(Object.keys(rest).length ? [{ type: 'text', text: JSON.stringify(rest) }] : []),
      ],
    };
  }
  return { content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res ?? null) }] };
}

function sessionIdOf(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type === SESSION_MARKER && typeof m.sessionId === 'string') return m.sessionId;
  }
  return null;
}

function sessionMessages(sessionId) {
  return sessionId ? [{ type: SESSION_MARKER, sessionId }] : [];
}

// ── provider ─────────────────────────────────────────────────

export default {
  id: 'claude-sdk',
  label: 'Claude (Claude Code 로그인)',

  async detect() {
    try {
      await loadSdk();
    } catch (err) {
      return { available: false, reason: `Claude Agent SDK를 불러올 수 없습니다: ${err?.message ?? err}`, models: [...MODELS] };
    }
    const bundled = bundledClaudeBinary();
    const bundledOk = bundled ? await exists(bundled) : false;
    const onPath = claudeOnPath();
    if (!bundledOk && !onPath) {
      return {
        available: false,
        reason: 'Claude Code를 찾을 수 없습니다. Claude Code를 설치한 뒤 터미널에서 `claude`로 로그인하세요.',
        models: [...MODELS],
        authHint: AUTH_HINT,
      };
    }
    const loggedIn = await cliLoggedIn(onPath ?? bundled);
    if (loggedIn === false) {
      return { available: false, reason: 'Claude Code에 로그인되어 있지 않습니다.', models: [...MODELS], authHint: AUTH_HINT };
    }
    return { available: true, models: [...MODELS], authHint: AUTH_HINT };
  },

  /**
   * @param {{threadId:string, model?:string, messages:any[], text:string, systemPrompt:string,
   *   tools:any[], callTool:(name:string, args:any)=>Promise<any>, emit:(e:any)=>void, signal:AbortSignal}} p
   */
  async runTurn({ model, messages, text, systemPrompt, tools, callTool, emit, signal }) {
    const sdk = await loadSdk();
    const mcpTools = (tools ?? []).map((t) => sdk.tool(
      t.name,
      t.description ?? '',
      t.shape ?? {},
      async (args) => toCallToolResult(await callTool(t.name, args)),
      { annotations: { readOnlyHint: t.kind === 'read' } },
    ));
    const server = sdk.createSdkMcpServer({ name: 'doogle', version: '0.1.0', tools: mcpTools, alwaysLoad: true });

    const cwd = path.join(appDataDir(), 'claude-workspace');
    await fs.mkdir(cwd, { recursive: true });
    const bundled = bundledClaudeBinary();
    const exe = bundled && await exists(bundled) ? null : claudeOnPath();

    let sessionId = sessionIdOf(messages);
    const first = await runQuery({ sdk, server, model, text, systemPrompt, cwd, exe, resume: sessionId, emit, signal });
    let outcome = first;
    if (first.missingSession && sessionId) {
      // 저장된 세션이 Claude Code 쪽에 없다 — 새 세션으로 한 번 다시 보낸다.
      emit({ kind: 'status', text: '이전 Claude 세션을 찾을 수 없어 새 세션으로 시작합니다' });
      outcome = await runQuery({ sdk, server, model, text, systemPrompt, cwd, exe, resume: null, emit, signal });
    }
    sessionId = outcome.sessionId ?? sessionId;
    const out = sessionMessages(sessionId);

    if (signal.aborted) return { messages: out };
    if (outcome.loginRequired) {
      emit({ kind: 'error', code: 'CLAUDE_LOGIN_REQUIRED', message: `Claude Code 로그인이 필요합니다. ${AUTH_HINT}` });
      throw Object.assign(new ProviderError('CLAUDE_LOGIN_REQUIRED', 'Claude Code 로그인이 필요합니다', { emitted: true }), { messages: out });
    }
    if (outcome.limit) {
      emit({ kind: 'limit', message: outcome.limit.message, ...(outcome.limit.resetAt ? { resetAt: outcome.limit.resetAt } : {}) });
      throw Object.assign(new ProviderError('LIMIT', outcome.limit.message, { emitted: true }), { messages: out });
    }
    if (outcome.error) {
      throw Object.assign(new ProviderError(outcome.error.code, outcome.error.message), { messages: out });
    }
    return { messages: out };
  },
};

/** 한 번의 SDK query 실행. 예외를 던지지 않고 결과를 요약해 돌려준다. */
async function runQuery({ sdk, server, model, text, systemPrompt, cwd, exe, resume, emit, signal }) {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal.aborted) abortController.abort();
  else signal.addEventListener('abort', onAbort, { once: true });

  /** @type {{sessionId:string|null, loginRequired:boolean, missingSession:boolean, limit:any, error:any}} */
  const st = { sessionId: null, loginRequired: false, missingSession: false, limit: null, error: null };
  let rateLimit = null;
  let apiErrorCode = null;
  let apiErrorText = '';
  /** index → block type (현재 assistant 메시지의 스트리밍 블록) */
  const blockTypes = new Map();

  const options = {
    abortController,
    cwd,
    model: model || DEFAULT_MODEL,
    systemPrompt,
    tools: [], // Claude Code 기본 tool(Bash, Read, Edit …) 전부 차단
    allowedTools: [`${MCP_PREFIX}*`],
    permissionMode: 'default',
    canUseTool: async (toolName, input) => (toolName.startsWith(MCP_PREFIX)
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: '두글에서는 문서 tool(mcp__doogle__*)만 사용할 수 있습니다.' }),
    mcpServers: { doogle: server },
    strictMcpConfig: true,
    settingSources: [], // 사용자/프로젝트 settings·CLAUDE.md·hook을 불러오지 않는다 (로그인은 영향 없음)
    includePartialMessages: true,
    ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
    ...(resume ? { resume } : {}),
  };

  try {
    const q = sdk.query({ prompt: text, options });
    for await (const e of q) {
      if (typeof e?.session_id === 'string' && e.session_id) st.sessionId = e.session_id;
      switch (e?.type) {
        case 'stream_event': {
          if (e.parent_tool_use_id) break;
          const ev = e.event;
          if (ev?.type === 'content_block_start') blockTypes.set(ev.index, ev.content_block?.type);
          else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            emit({ kind: 'text_delta', text: ev.delta.text });
          } else if (ev?.type === 'content_block_stop') {
            if (blockTypes.get(ev.index) === 'text') emit({ kind: 'text_done' });
            blockTypes.delete(ev.index);
          } else if (ev?.type === 'message_start') blockTypes.clear();
          break;
        }
        case 'assistant': {
          if (!e.parent_tool_use_id && typeof e.error === 'string' && e.error && e.error !== 'max_output_tokens') {
            apiErrorCode = e.error;
            const t = (e.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
            if (t) apiErrorText = t;
          }
          break;
        }
        case 'rate_limit_event': {
          const info = e.rate_limit_info;
          if (info?.status === 'rejected' && !info.isUsingOverage
            && (!info.overageStatus || info.overageStatus === 'rejected')) {
            const resetsAt = Number(info.resetsAt);
            rateLimit = {
              resetAt: Number.isFinite(resetsAt) && resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : undefined,
              type: info.rateLimitType ?? null,
            };
          }
          break;
        }
        case 'auth_status': {
          if (e.error) {
            apiErrorText = String(e.error);
            if (LOGIN_TEXT.test(apiErrorText)) st.loginRequired = true;
          }
          break;
        }
        case 'result': {
          const u = e.usage;
          if (u) {
            emit({
              kind: 'usage',
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              outputTokens: u.output_tokens ?? 0,
            });
          }
          if (e.is_error) {
            const errors = Array.isArray(e.errors) ? e.errors.filter((x) => typeof x === 'string' && x.trim()) : [];
            const msg = errors.join('\n') || (typeof e.result === 'string' ? e.result.trim() : '') || apiErrorText
              || 'Claude가 오류 원인을 보내지 않았습니다.';
            if (MISSING_SESSION.test(msg)) st.missingSession = true;
            else st.error = { code: 'CLAUDE_ERROR', message: msg, status: Number(e.api_error_status) || undefined };
          }
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const msg = String(err?.message ?? err);
      if (MISSING_SESSION.test(msg)) st.missingSession = true;
      else st.error = { code: 'CLAUDE_ERROR', message: msg };
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  // 실패 분류: 인증 → 한도 → 일반
  const errText = `${st.error?.message ?? ''}\n${apiErrorText}`;
  if (apiErrorCode === 'authentication_failed' || st.error?.status === 401 || (st.error && LOGIN_TEXT.test(errText))) {
    st.loginRequired = true;
  }
  if (!st.loginRequired && (rateLimit || apiErrorCode === 'rate_limit' || apiErrorCode === 'billing_error')) {
    if (st.error || apiErrorCode) { // 'rejected' 이벤트만 있고 턴이 성공했으면 한도로 보지 않는다
      st.limit = {
        message: rateLimit
          ? 'Claude 구독 사용 한도에 도달했습니다.'
          : apiErrorCode === 'billing_error' ? 'Claude 사용량/결제 한도에 도달했습니다.' : 'Claude 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.',
        ...(rateLimit?.resetAt ? { resetAt: rateLimit.resetAt } : {}),
      };
    }
  }
  if (st.loginRequired || st.limit) st.error = null;
  else if (!st.error && apiErrorCode && apiErrorCode !== 'max_output_tokens') {
    st.error = { code: 'CLAUDE_ERROR', message: apiErrorText || `Claude 오류: ${apiErrorCode}` };
  }
  return st;
}
