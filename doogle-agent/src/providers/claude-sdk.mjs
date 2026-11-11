// Claude provider — Claude Agent SDK + 사용자가 직접 로그인한 Claude Code (PLAN §5.5').
// Ported (in part) from banatic/rhwp-x (MIT) rhwp/rhwp-agent/agents/claude.mjs
// (SDK query 옵션, stream_event/assistant/result/rate_limit_event 처리).
//
// 정책 (CONTRACT §0, TOOLS.md §4):
// - Claude 자격증명(~/.claude/.credentials.json, Keychain 등)을 읽기/복사/저장/중계하지 않는다.
// - 격리 홈(CLAUDE_CONFIG_DIR)·자격증명 미러링을 쓰지 않는다. SDK는 사용자의 기본 환경 그대로 실행한다.
// - 두글은 claude.ai 로그인 UI를 제공하지 않는다. 미로그인이면 터미널에서 `claude` → /login 안내.
import { promises as fs, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn as spawnRaw } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';

import { ProviderError } from '../errors.mjs';
import { appDataDir } from '../paths.mjs';
import { splitToolImage } from '../tools/index.mjs';

const require = createRequire(import.meta.url);

/** 정적 목록 — 실시간 조회(supportedModels)와 캐시가 모두 실패할 때만 쓴다 (source 'fallback'). */
export const MODELS = Object.freeze([
  { id: 'default', label: '기본값 (Claude Code 권장)', description: 'Claude Code가 계정에 맞게 고르는 기본 모델', default: true },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
]);
/** 'default'(또는 미지정)이면 SDK에 model을 넘기지 않아 Claude Code 기본 모델을 쓴다. */
export const DEFAULT_MODEL = 'default';
export const LIST_MODELS_TIMEOUT_MS = 15_000;
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

/**
 * Claude 데스크탑 앱이 품고 있는 Claude Code (Windows) — 데스크탑 앱만 깔린 PC 에서도 쓰게.
 * 수정하지 않은 공식 바이너리를 그대로 실행할 뿐이고, 자격증명은 건드리지 않는다.
 * 앱이 버전을 갈아 끼우므로 매번 가장 최근 것을 고른다. 없으면 null.
 *   - MSIX 설치: %LOCALAPPDATA%\Claude-Data\claude_<id>\claude-code\<버전>\<빌드>\claude.exe
 *   - 일반 설치: %APPDATA%\Claude\claude-code\<버전>\...\claude.exe
 */
export function desktopClaudeBinary(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return null;
  const roots = [];
  if (env.LOCALAPPDATA) {
    const data = path.join(env.LOCALAPPDATA, 'Claude-Data');
    for (const name of safeList(data)) if (/^claude_/i.test(name)) roots.push(path.join(data, name, 'claude-code'));
  }
  if (env.APPDATA) roots.push(path.join(env.APPDATA, 'Claude', 'claude-code'));
  let best = null;
  const visit = (dir, depth) => {
    for (const name of safeList(dir)) {
      const full = path.join(dir, name);
      if (/^claude\.exe$/i.test(name)) {
        try {
          const at = statSync(full).mtimeMs;
          if (!best || at > best.at) best = { file: full, at };
        } catch { /* 지워지는 중 */ }
      } else if (depth < 3) {
        visit(full, depth + 1);
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return best?.file ?? null;
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 실행할 Claude Code — PATH 의 claude → 공식 설치 스크립트 위치(~/.local/bin) → Claude 데스크탑 앱 안.
 * 설치본은 GUI 에서 떠서 PATH 가 터미널과 다를 수 있어 두 번째 후보를 직접 본다. 없으면 null.
 */
export function findClaude(env = process.env, platform = process.platform) {
  const onPath = claudeOnPath(env, platform);
  if (onPath) return onPath;
  const local = path.join(os.homedir(), '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude');
  try {
    if (statSync(local).isFile()) return local;
  } catch { /* 없음 */ }
  return desktopClaudeBinary(env, platform);
}

/**
 * 새 터미널 창에 Claude Code 를 띄운다 — 사용자가 거기서 직접 /login 한다. 두글은 로그인 화면을 만들지도,
 * 로그인 과정에 끼어들지도 않고 공식 CLI 를 여는 것까지만 한다 (CONTRACT §0: 로그인은 사용자가 claude 로 직접).
 * @returns {string} 띄운 실행 파일
 */
export function openClaudeTerminal({ exe = findClaude(), cwd = os.homedir(), platform = process.platform, spawnFn = spawnRaw } = {}) {
  if (!exe) throw new ProviderError('CLAUDE_NOT_FOUND', 'Claude Code를 찾을 수 없습니다. Claude 데스크탑 앱이나 Claude Code를 설치하세요.');
  const quiet = { cwd, detached: true, stdio: 'ignore' };
  let child;
  if (platform === 'win32') {
    // start "제목" "실행 파일" — 새 콘솔 창. 따옴표를 그대로 넘기려고 verbatim
    child = spawnFn('cmd.exe', ['/d', '/s', '/c', `"start "Claude Code" "${exe}""`], { ...quiet, windowsVerbatimArguments: true, windowsHide: false });
  } else if (platform === 'darwin') {
    child = spawnFn('open', ['-a', 'Terminal', exe], quiet);
  } else {
    child = spawnFn('x-terminal-emulator', ['-e', exe], quiet);
  }
  child.on?.('error', () => { /* 터미널을 못 띄우면 복사 안내가 남아 있다 */ });
  child.unref?.();
  return exe;
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
  const { image, rest } = splitToolImage(res);
  if (image) {
    return {
      content: [
        { type: 'image', data: image.data, mimeType: image.mimeType },
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

// ── 모델 목록 ─────────────────────────────────────────────────

function fallbackModels() {
  return MODELS.map((m) => ({ ...m, source: 'fallback' }));
}

/**
 * SDK ModelInfo[] → 공통 모델 형태. value 'default' 행을 기본으로 표시하고,
 * 별칭 행(sonnet, opus …)은 resolvedModel을 함께 둔다.
 * @param {any[]} infos
 */
export function mapClaudeModels(infos) {
  const out = [];
  const seen = new Set();
  for (const i of Array.isArray(infos) ? infos : []) {
    const id = typeof i?.value === 'string' ? i.value.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = { id, label: typeof i.displayName === 'string' && i.displayName.trim() ? i.displayName.trim() : id, source: 'live' };
    if (typeof i.description === 'string' && i.description.trim()) row.description = i.description.trim().split(/\r?\n/)[0];
    if (id === 'default') row.default = true;
    if (typeof i.resolvedModel === 'string' && i.resolvedModel && i.resolvedModel !== id) {
      row.resolvedModel = i.resolvedModel;
      if (!/^claude-/.test(id) && id !== 'default') row.aliasOf = i.resolvedModel;
    }
    if (typeof i.supportsEffort === 'boolean') row.supportsEffort = i.supportsEffort;
    if (Array.isArray(i.supportedEffortLevels) && i.supportedEffortLevels.length) row.effortLevels = [...i.supportedEffortLevels];
    out.push(row);
  }
  return out;
}

/**
 * Claude Code가 이 계정에서 쓸 수 있다고 알려 주는 모델 목록을 읽는다.
 *
 * streaming-input 모드로 query를 시작하되 prompt(async iterable)는 아무 메시지도 내보내지 않는다.
 * supportedModels()는 SDK가 시작 시 보내는 `initialize` 제어 요청의 응답(models)을 돌려줄 뿐이므로
 * (sdk.mjs: `supportedModels(){return(await this.initialization).models}`) 사용자 메시지가 없는 한
 * 모델 요청은 나가지 않고 사용량도 쓰지 않는다. 혹시 assistant/result/usage 메시지가 보이면 경고로 남긴다.
 * tool·MCP·settings는 모두 끄고, 자격증명은 건드리지 않으며 사용자의 기본 환경 그대로 실행한다.
 * @param {{sdk?: any, timeoutMs?: number, cwd?: string, exe?: string|null, log?: (m:string)=>void}} [opts]
 */
export async function listClaudeModels({ sdk, timeoutMs = LIST_MODELS_TIMEOUT_MS, cwd, exe, log } = {}) {
  sdk ??= await loadSdk();
  if (cwd === undefined) {
    cwd = path.join(appDataDir(), 'claude-workspace');
    await fs.mkdir(cwd, { recursive: true });
  }
  if (exe === undefined) {
    const bundled = bundledClaudeBinary();
    exe = bundled && await exists(bundled) ? null : findClaude();
  }
  let release;
  const gate = new Promise((r) => { release = r; });
  async function* silentPrompt() { await gate; } // 아무것도 보내지 않는다
  const abortController = new AbortController();
  const q = sdk.query({
    prompt: silentPrompt(),
    options: {
      abortController,
      cwd,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: '모델 목록 조회 전용 세션' }),
      ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),
    },
  });
  let unexpected = null;
  const drain = (async () => {
    try {
      for await (const m of q) {
        if (m?.type === 'assistant' || m?.type === 'result' || m?.type === 'stream_event') unexpected ??= m.type;
      }
    } catch { /* close/abort */ }
  })();
  let timer;
  try {
    const infos = await Promise.race([
      Promise.resolve().then(() => q.supportedModels()),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`모델 목록 조회 시간 초과 (${Math.round(timeoutMs / 1000)}초)`)), timeoutMs); }),
    ]);
    const models = mapClaudeModels(infos);
    if (!models.length) throw new Error('Claude Code가 모델 목록을 보내지 않았습니다');
    return models;
  } finally {
    clearTimeout(timer);
    release();
    try { q.close?.(); } catch { /* ignore */ }
    abortController.abort();
    await Promise.race([drain, new Promise((r) => setTimeout(r, 1000))]);
    if (unexpected) (log ?? ((m) => process.emitWarning(m)))(`claude-sdk 모델 목록 조회 중 예상하지 못한 메시지: ${unexpected}`);
  }
}

// ── provider ─────────────────────────────────────────────────

export default {
  id: 'claude-sdk',
  label: 'Claude (Claude Code 로그인)',

  async detect() {
    try {
      await loadSdk();
    } catch (err) {
      return { available: false, reason: `Claude Agent SDK를 불러올 수 없습니다: ${err?.message ?? err}`, models: fallbackModels() };
    }
    const bundled = bundledClaudeBinary();
    const bundledOk = bundled ? await exists(bundled) : false;
    const onPath = findClaude();
    if (!bundledOk && !onPath) {
      return {
        available: false,
        reason: 'Claude Code를 찾을 수 없습니다. Claude 데스크탑 앱이나 Claude Code를 설치한 뒤 터미널에서 `claude`로 로그인하세요.',
        models: fallbackModels(),
        authHint: AUTH_HINT,
      };
    }
    const loggedIn = await cliLoggedIn(onPath ?? bundled);
    if (loggedIn === false) {
      // PATH 에 없는 claude(데스크탑 앱 안 등)면 터미널에 붙여 넣을 명령을 전체 경로로 준다
      const loginCommand = onPath && !claudeOnPath() ? `& "${onPath}"` : 'claude';
      return { available: false, reason: 'Claude Code에 로그인되어 있지 않습니다.', models: fallbackModels(), authHint: AUTH_HINT, loginCommand };
    }
    return { available: true, models: fallbackModels(), authHint: AUTH_HINT };
  },

  /** 로그인하라고 터미널에 Claude Code 를 띄운다 (hub `open_terminal`) */
  async openTerminal() {
    const cwd = path.join(appDataDir(), 'claude-workspace');
    await fs.mkdir(cwd, { recursive: true });
    return { exe: openClaudeTerminal({ cwd }) };
  },

  /** 실시간 모델 목록 (hub의 model-catalog가 캐시·fallback을 맡는다) */
  async listModels() {
    return listClaudeModels();
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
    const exe = bundled && await exists(bundled) ? null : findClaude();

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
    ...(model && model !== 'default' ? { model } : {}),
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
              // 진단용(선택 필드): 모델 요청 횟수와 캐시 적중량
              ...(Number.isFinite(e.num_turns) ? { turns: e.num_turns } : {}),
              ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
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
