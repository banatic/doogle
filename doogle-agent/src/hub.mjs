// 두글 hub: studio(WebView)와 provider/외부 MCP 클라이언트 사이의 WebSocket 중계 서버.
// 프로토콜은 docs/doogle/CONTRACT.md §1–3.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { defaultModelId, ModelCatalog, normalizeModels } from './model-catalog.mjs';
import { AttachmentStore, attachmentsBlock, normalizeAttachments } from './attachments.mjs';
import { CARD_REFS_PER_MESSAGE, CardStore, cardsBlock, fillPlaceholders, maskSensitive, normalizeProposal, readCardView, sensitiveValuesOf } from './cards.mjs';
import { appDataDir } from './paths.mjs';
import { loadProviders, sortProviders } from './provider-registry.mjs';
import { CARD_DRAFT_BLOCK, buildSystemPrompt, buildTurnText } from './system-prompt.mjs';
import { ThreadStore, closeDanglingTurn, normalizeDoc, recordTranscript } from './threads.mjs';
import { backfillFromClaudeSession } from './transcript-import.mjs';
import { loadTools } from './tools-loader.mjs';
import * as secrets from './secrets.mjs';

export const PROTOCOL_VERSION = 1;
export const HUB_VERSION = '0.1.0';

export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:7700',
  'http://127.0.0.1:7700',
]);

/** studio 응답 대기 시간. write는 검토, HUMAN_WAIT_TOOL_NAMES는 사용자 응답을 기다릴 수 있어 길다. */
export const DEFAULT_TOOL_TIMEOUTS = Object.freeze({
  read: 60_000,
  write: 10 * 60_000,
});

/**
 * 화면과의 연결이 뜻밖에 끊겼을 때 같은 화면이 돌아오길 기다리는 시간. 그 안에 돌아오면 응답을 이어 간다.
 * (화면의 재연결 간격은 0.5초부터 두 배씩 — 이 안에 서너 번 시도한다)
 */
export const DEFAULT_RECONNECT_GRACE_MS = 10_000;
/** 끊긴 사이 모아 두는 메시지 수 한도 — 넘치면 돌아오지 않는 것으로 본다 */
const DETACHED_BUFFER_MAX = 5000;
/** 화면 id (`/studio?client=`) 로 받을 수 있는 모양 */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;

const DETECT_TIMEOUT_MS = 15_000;
/** 캐시가 없을 때 providers 응답이 실시간 모델 조회를 기다리는 최대 시간 (넘기면 fallback 후 갱신 push) */
const MODELS_FIRST_WAIT_MS = 4_000;
/** 비밀 키 → 그 키를 쓰는 provider */
const SECRET_PROVIDER = Object.freeze({ 'anthropic-api-key': 'anthropic-api', 'openai-api-key': 'openai-api' });
/** turn 실패가 '없는 모델' 때문인지 (그러면 모델 목록을 다시 받는다) */
export const UNKNOWN_MODEL_ERROR = /(model[^\n]{0,80}(not[ _]found|unknown|invalid|does not exist|not exist|not available|not supported|unavailable))|((unknown|invalid|unsupported)[ _-]model)|(not_found_error[^\n]{0,80}model)/i;
const NO_DOCUMENT = Object.freeze({ code: 'NO_DOCUMENT', message: '두글에서 문서를 열어주세요' });
/** studio가 hub에 저장을 요청할 수 있는 비밀 키 (프로토콜 확장 secret_set/secret_delete). */
const STUDIO_WRITABLE_SECRETS = new Set(['anthropic-api-key', 'openai-api-key']);
/** hub가 직접 내보내는 이벤트 — provider가 emit해도 무시한다(중복 방지). */
const HUB_OWNED_EVENT_KINDS = new Set(['tool_use', 'tool_result', 'turn_end']);

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function summarize(r) {
  // 실패 사유는 화면에 항목별로 풀어 보이므로(apply_edits) 넉넉히 둔다
  if (!r.ok) return `${r.error?.code ?? 'ERROR'}: ${r.error?.message ?? ''}`.slice(0, 2000);
  let s;
  try {
    // 그림(base64)은 요약에 싣지 않는다 — 화면과 대화 기록에 뜻 없는 글자열이 남지 않게
    const image = r.result && typeof r.result === 'object' ? r.result.image : null;
    const value = image && typeof image === 'object' && typeof image.base64 === 'string'
      ? { ...r.result, image: `<${image.mimeType ?? 'image'}>` }
      : r.result;
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(r.result);
  }
  s = s ?? '';
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout()), ms); }),
  ]);
}

/**
 * @param {{
 *   port?: number, host?: string, token?: string,
 *   dataDir?: string,
 *   writeHubJson?: boolean,
 *   persistThreads?: boolean,
 *   providers?: Map<string, any> | any[],
 *   providersDir?: string,
 *   tools?: import('./tools-loader.mjs').ToolsModule,
 *   toolTimeouts?: Partial<Record<'read'|'write', number>>,
 *   imageRoots?: string[],
 *   allowedOrigins?: string[],
 *   modelCatalog?: ModelCatalog,
 *   modelsFirstWaitMs?: number,
 *   refreshModelsOnStart?: boolean,
 *   reconnectGraceMs?: number,
 *   maxThreads?: number,
 *   log?: (msg: string) => void,
 * }} [opts]
 */
export async function createHub(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token || randomBytes(32).toString('base64url');
  const dataDir = opts.dataDir ?? appDataDir();
  const log = opts.log ?? ((m) => process.stderr.write(`[doogle-hub] ${m}\n`));
  const allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  const timeouts = { ...DEFAULT_TOOL_TIMEOUTS, ...(opts.toolTimeouts ?? {}) };
  const tools = opts.tools ?? await loadTools();
  if (tools.stub) log(tools.loadError ?? 'tool 모듈 없음 (stub)');

  /** @type {Map<string, any>} */
  let providers;
  if (opts.providers) {
    const list = opts.providers instanceof Map ? [...opts.providers.values()] : opts.providers;
    providers = sortProviders(new Map(list.map((p) => [p.id, p])));
  } else {
    providers = (await loadProviders(opts.providersDir ? { dir: opts.providersDir } : {})).providers;
  }

  const humanWaitTools = new Set(Array.isArray(tools.HUMAN_WAIT_TOOL_NAMES) ? tools.HUMAN_WAIT_TOOL_NAMES : ['ask_user_question', 'request_permission']);
  /** agent가 imagePath로 읽을 수 있는 폴더 (DOOGLE_IMAGE_ROOTS, 기본: 사용자 홈) */
  const imageRoots = opts.imageRoots ?? (process.env.DOOGLE_IMAGE_ROOTS
    ? process.env.DOOGLE_IMAGE_ROOTS.split(path.delimiter).filter(Boolean)
    : [os.homedir()]);
  const systemPrompt = buildSystemPrompt({ toolRules: tools.TOOL_RULES });
  const catalog = opts.modelCatalog ?? new ModelCatalog({ dataDir, log });
  const modelsFirstWaitMs = opts.modelsFirstWaitMs ?? MODELS_FIRST_WAIT_MS;
  let closing = false;
  // 화면 기록이 없는 옛 대화는 claude-sdk 세션 기록(<dataDir>/claude-workspace 의 SDK 프로젝트)에서 다시 만든다
  const claudeCwd = path.join(dataDir, 'claude-workspace');
  const store = new ThreadStore({
    dir: opts.persistThreads === false ? null : path.join(dataDir, 'threads'),
    backfill: (t) => backfillFromClaudeSession(t, claudeCwd),
    ...(opts.maxThreads !== undefined ? { maxThreads: opts.maxThreads } : {}),
  });
  /** 대화에 붙인 참고 파일 — 내용은 대화 폴더 옆(`<대화>.files/`)에 둔다 */
  const attachments = new AttachmentStore({ dir: store.dir });
  /** 사용자가 만든 카드 — 이 컴퓨터의 `<dataDir>/cards/` 에만 둔다 */
  const cards = new CardStore({ dir: opts.persistThreads === false ? null : path.join(dataDir, 'cards') });
  const reconnectGraceMs = opts.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;

  /** 현재 studio 소켓 (하나만 유지) */
  /** @type {WebSocket | null} */
  let studio = null;
  /**
   * 연결이 뜻밖에 끊긴 화면 — 같은 화면(clientId)이 돌아오길 잠깐 기다린다. 그동안 화면으로 갈 메시지는
   * 모아 두었다가 돌아오면 순서대로 보낸다. 돌아오지 않으면 진행 중 응답을 멈춘다(dropDetached).
   * @type {{clientId: string, socket: WebSocket, buffer: any[], timer: ReturnType<typeof setTimeout>} | null}
   */
  let detached = null;
  /** callId → pending tool call */
  /** @type {Map<string, {resolve:(r:any)=>void, socket: WebSocket}>} */
  const pending = new Map();
  /** threadId → 진행 중 턴 */
  /** @type {Map<string, {abort: AbortController, done: Promise<void>, interrupted?: boolean}>} */
  const turns = new Map();
  /** threadId → 미뤄 둔 저장 타이머 (응답 도중 저장) */
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const saveTimers = new Map();

  /**
   * 응답 도중 저장 — 글 조각은 잠깐 모아서(0.8초), 도구 결과·턴 끝·오류는 바로 쓴다.
   * 새로고침·앱 종료·허브 재시작 뒤에도 그때까지의 대화가 남는다.
   */
  function saveSoon(thread, urgent = false) {
    const prev = saveTimers.get(thread.id);
    if (prev) clearTimeout(prev);
    saveTimers.delete(thread.id);
    if (urgent) {
      void store.save(thread);
      return;
    }
    const timer = setTimeout(() => {
      saveTimers.delete(thread.id);
      void store.save(thread);
    }, 800);
    timer.unref?.();
    saveTimers.set(thread.id, timer);
  }

  /** 화면이 사라졌다(새로고침·창 닫힘) — 열려 있던 문서도 함께 사라지므로 진행 중 응답을 멈춘다 */
  function interruptTurns() {
    for (const t of turns.values()) {
      t.interrupted = true;
      t.abort.abort();
    }
  }

  /** 화면으로 보낸다. 화면이 잠깐 끊긴 사이(detached)면 모아 둔다 */
  function sendStudio(msg) {
    if (studio) {
      if (studio.readyState === WebSocket.OPEN) send(studio, msg);
      // 소켓은 죽었는데 close 처리가 아직인 짧은 틈 — 유예로 넘어가면 이어 보낼 수 있게 붙들어 둔다
      else if ((studio.doogleLimbo ??= []).length < DETACHED_BUFFER_MAX) studio.doogleLimbo.push(msg);
      return;
    }
    if (!detached) return;
    if (detached.buffer.length >= DETACHED_BUFFER_MAX) {
      dropDetached();
      return;
    }
    detached.buffer.push(msg);
  }

  /** 끊긴 화면이 돌아오지 않았다 — 기다리던 것을 정리하고 진행 중 응답을 멈춘다 */
  function dropDetached() {
    const d = detached;
    if (!d) return;
    detached = null;
    clearTimeout(d.timer);
    interruptTurns();
    failPendingFor(d.socket);
  }

  /** old 소켓에 걸려 있던 tool 호출을 새 소켓으로 옮긴다 (같은 화면이 다시 붙었을 때) */
  function rebindPending(old, ws) {
    for (const p of pending.values()) if (p.socket === old) p.socket = ws;
  }

  // ── tool_call 중계 ─────────────────────────────────────────
  /**
   * studio로 tool_call을 보내고 tool_result를 기다린다.
   * @param {{name:string, args:any, origin:'agent'|'mcp', threadId?:string, signal?:AbortSignal, emit?:(e:any)=>void}} p
   * @returns {Promise<{ok:true, result:any}|{ok:false, error:{code:string, message:string, data?:any}}>}
   */
  async function callTool({ name, args, origin, threadId, signal, emit }) {
    const callId = randomUUID();
    const args0 = args ?? {};
    if (origin === 'agent') emit?.({ kind: 'tool_use', callId, name, args: args0 });
    const r = await dispatchTool({ callId, name, args: args0, origin, threadId, signal });
    if (origin === 'agent') emit?.({ kind: 'tool_result', callId, ok: r.ok, summary: summarize(r) });
    return r;
  }

  async function dispatchTool({ callId, name, args, origin, threadId, signal }) {
    if (typeof name !== 'string' || !name) {
      return { ok: false, error: { code: 'INVALID_ARGS', message: 'tool name이 없습니다' } };
    }
    const def = tools.getTool(name);
    if (!def && !tools.stub) return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `알 수 없는 tool: ${name}` } };
    // 대화 제어 tool 은 두글 사이드바의 대화에서만 뜻이 있다 — 외부(MCP) 에이전트는 자기 대화에서 묻는다.
    if (def?.kind === 'control' && origin !== 'agent') {
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: `${name} works only inside the doogle sidebar chat — ask the user in your own conversation instead.` } };
    }
    // 참고 파일 tool 은 그 대화에 붙인 파일을 읽는다 — 대화가 없는 외부(MCP) 에이전트에는 뜻이 없다.
    if (def?.kind === 'hub' && (origin !== 'agent' || !threadId)) {
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: `${name} reads files attached in the doogle sidebar chat — it is not available to external agents.` } };
    }
    if (def) {
      // insert_image: doogle-mcp가 이미 준비한 인자(naturalWidthPx/HeightPx 포함)는 그 두 필드를 빼고 검증한다.
      const prepared = name === 'insert_image' && args && typeof args === 'object'
        && Number.isFinite(args.naturalWidthPx) && Number.isFinite(args.naturalHeightPx) && typeof args.imageBase64 === 'string';
      const { naturalWidthPx, naturalHeightPx, ...plain } = prepared ? args : {};
      let v;
      try {
        v = tools.validateArgs(name, prepared ? plain : args);
      } catch (err) {
        v = { ok: false, error: { code: 'INVALID_ARGS', message: String(err?.message ?? err) } };
      }
      if (!v.ok) return { ok: false, error: v.error };
      args = prepared ? { ...v.args, naturalWidthPx, naturalHeightPx } : v.args;
      if (name === 'insert_image' && !prepared && typeof tools.prepareInsertImageArgs === 'function') {
        // 이미지 파일 읽기/base64 검증은 hub에서 (studio는 바이트만 받는다)
        try {
          args = await tools.prepareInsertImageArgs(args, imageRoots);
        } catch (err) {
          return { ok: false, error: { code: typeof err?.code === 'string' ? err.code : 'INVALID_ARGS', message: String(err?.message ?? err) } };
        }
      }
    }
    if (signal?.aborted) return { ok: false, error: { code: 'CANCELLED', message: '취소되었습니다' } };
    // 카드: 카드 편집 대화는 propose_card 만, 문서로 가는 인자의 자리표시자 {{card:…}} 는 실제 값으로.
    // 카드를 붙인 대화에서는 그 카드들의 민감 값을 모든 도구 결과(바뀐 문단 글, 뒤 턴의 문서 읽기)에서 가려
    // 모델에 돌려준다 — 문서에 들어간 민감 값도 모델에는 가린 모양으로만 보인다.
    let sensitiveValues = [];
    let renderDropped = false;
    if (origin === 'agent' && threadId) {
      const thread = await store.get(threadId);
      const drafting = thread.purpose === 'card-draft';
      if (drafting && name !== 'propose_card') {
        return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'This is the card editor conversation: only propose_card is available here. Do not read or edit the document.' } };
      }
      if (!drafting && name === 'propose_card') {
        return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'propose_card works only in the card editor. To use a card in the document, write placeholders {{card:<id>.<field>}}.' } };
      }
      const attachedCards = def?.kind !== 'hub' && Array.isArray(thread.cards) && thread.cards.length > 0 ? await cardsOf(thread) : [];
      if (def?.kind !== 'hub' && JSON.stringify(args ?? null).includes('{{')) {
        // 카드가 없어도 돌린다 — 모르는 자리표시자를 문서에 그대로 쓰지 않게 CARD_PLACEHOLDER 로 막는다
        const filled = fillPlaceholders(args, (id) => attachedCards.find((c) => c.id === id) ?? null);
        if (!filled.ok) return { ok: false, error: filled.error };
        args = filled.args;
      }
      sensitiveValues = sensitiveValuesOf(attachedCards);
      // 민감 항목이 있는 카드를 붙인 대화에서는 문서 그림을 만들지 않는다 — 그림 속 글자는 가릴 수 없다
      if (sensitiveValues.length > 0) {
        if (name === 'render_page') {
          return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'render_page is off in this conversation: a card with sensitive fields is attached, and a page picture would show those values. Check layout with get_structure / get_table_layout instead, or ask the user to look at the document.' } };
        }
        if (args && typeof args === 'object' && 'render' in args) {
          const { render: _dropped, ...rest } = args;
          args = rest;
          renderDropped = true;
        }
      }
    }
    // hub 가 직접 처리하는 tool(참고 파일) — 화면으로 보내지 않는다. 문서가 열려 있지 않아도 된다.
    if (def?.kind === 'hub') return runHubTool(name, args, threadId);
    // 화면이 잠깐 끊긴 사이면(유예 중, 또는 소켓이 죽고 close 처리가 아직인 틈) 그 화면 앞으로 걸어 둔다 —
    // 돌아오면 전해지고, 안 돌아오면 STUDIO_DISCONNECTED 로 끝난다
    const socket = studio ?? detached?.socket ?? null;
    if (!socket) return { ok: false, error: { ...NO_DOCUMENT } };

    // 사용자 응답·검토를 기다릴 수 있는 tool(질문/권한 요청, 쓰기)은 긴 대기 시간
    const waitsForHuman = humanWaitTools.has(name) || def?.kind === 'write';
    const timeoutMs = waitsForHuman ? timeouts.write : timeouts.read;
    const outcome = await new Promise((resolve) => {
      let settled = false;
      /** socket 은 같은 화면이 다시 붙으면 새 소켓으로 바뀐다 (rebindPending) */
      const entry = { resolve: (r) => finish(r), socket };
      const finish = (r, { notifyStudio = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(callId);
        if (notifyStudio) sendStudio({ type: 'tool_cancel', callId });
        resolve(r);
      };
      const onAbort = () => finish({ ok: false, error: { code: 'CANCELLED', message: '취소되었습니다' } }, { notifyStudio: true });
      const timer = setTimeout(() => finish({
        ok: false,
        error: { code: 'TIMEOUT', message: `두글이 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다 (${name})` },
      }, { notifyStudio: true }), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(callId, entry);
      sendStudio({ type: 'tool_call', callId, name, args, origin, ...(threadId ? { threadId } : {}) });
    });
    const masked = sensitiveValues.length > 0 ? maskSensitive(outcome, sensitiveValues) : outcome;
    if (renderDropped && masked?.ok && masked.result && typeof masked.result === 'object' && !Array.isArray(masked.result)) {
      return { ...masked, result: { ...masked.result, renderSkipped: 'No picture: a card with sensitive fields is attached to this conversation, and a picture would show those values.' } };
    }
    return masked;
  }

  /** hub 가 직접 처리하는 tool (kind 'hub') */
  async function runHubTool(name, args, threadId) {
    try {
      const thread = await store.get(threadId);
      if (name === 'list_attachments') return attachments.list(thread);
      if (name === 'read_attachment') return await attachments.read(thread, args);
      if (name === 'read_card') {
        const attachedCards = await cardsOf(thread);
        const card = attachedCards.find((c) => c.id === args.card);
        if (!card) {
          return { ok: false, error: { code: 'CARD_NOT_FOUND', message: attachedCards.length
            ? `No card ${JSON.stringify(args.card)} in this conversation. Attached cards: ${attachedCards.map((c) => `${c.id} (${c.name})`).join(', ')}`
            : 'The user has not attached any card to this conversation.' } };
        }
        return { ok: true, result: readCardView(card, args) };
      }
      if (name === 'propose_card') {
        let proposal;
        try {
          proposal = normalizeProposal(args);
        } catch (err) {
          return { ok: false, error: { code: 'INVALID_ARGS', message: String(err?.message ?? err) } };
        }
        sendStudio({ type: 'card_proposal', threadId, ...proposal });
        return { ok: true, result: { shown: true, note: 'The draft is on screen. The user reviews and saves it; reply in one or two short sentences.' } };
      }
      return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `알 수 없는 tool: ${name}` } };
    } catch (err) {
      return { ok: false, error: { code: 'HUB_TOOL_FAILED', message: String(err?.message ?? err) } };
    }
  }

  function onToolResult(msg, socket) {
    const p = pending.get(msg.callId);
    if (!p || p.socket !== socket) return;
    if (msg.ok === true) p.resolve({ ok: true, result: msg.result ?? null });
    else {
      const e = msg.error && typeof msg.error === 'object' ? msg.error : {};
      p.resolve({
        ok: false,
        error: {
          code: typeof e.code === 'string' ? e.code : 'TOOL_ERROR',
          message: typeof e.message === 'string' ? e.message : 'tool 실행 실패',
          ...(e.data !== undefined ? { data: e.data } : {}),
        },
      });
    }
  }

  function failPendingFor(socket) {
    for (const p of [...pending.values()]) {
      if (p.socket === socket) p.resolve({ ok: false, error: { code: 'STUDIO_DISCONNECTED', message: '두글 화면과의 연결이 끊겼습니다' } });
    }
  }

  // ── provider ───────────────────────────────────────────────
  function detectCtx() {
    return { dataDir, secrets, hubVersion: HUB_VERSION };
  }

  /** provider.listModels가 있으면 model-catalog(캐시·SWR·fallback)를 거친다. */
  const hasLiveModels = (p) => typeof p?.listModels === 'function';
  const modelsFetcher = (p) => () => Promise.resolve().then(() => p.listModels(detectCtx()));

  async function providersList() {
    const ctx = detectCtx();
    return Promise.all([...providers.values()].map(async (p) => {
      let d;
      try {
        d = await withTimeout(Promise.resolve().then(() => p.detect(ctx)), DETECT_TIMEOUT_MS,
          () => ({ available: false, reason: '감지 시간 초과', models: [] }));
      } catch (err) {
        d = { available: false, reason: String(err?.message ?? err), models: [] };
      }
      const available = d?.available === true;
      let models;
      let modelsUpdatedAt = null;
      let modelsError;
      if (hasLiveModels(p)) {
        const r = await catalog.resolve(p.id, {
          fetch: available ? modelsFetcher(p) : null, // 쓸 수 없는 provider는 캐시/기본 목록만
          fallback: d?.models,
          waitMs: modelsFirstWaitMs,
          onUpdate: () => scheduleProvidersBroadcast(),
        });
        models = r.models;
        modelsUpdatedAt = r.updatedAt;
        modelsError = r.error;
      } else {
        // 자체적으로 목록을 받는 provider(openai-*, codex) — source가 없으면 'live'로 본다.
        models = normalizeModels(d?.models, 'live');
      }
      return {
        id: p.id,
        label: p.label ?? p.id,
        available,
        ...(d?.reason ? { reason: String(d.reason) } : {}),
        models,
        defaultModel: defaultModelId(models),
        modelsUpdatedAt: modelsUpdatedAt ? new Date(modelsUpdatedAt).toISOString() : null,
        ...(modelsError ? { modelsError } : {}),
        ...(d?.authHint ? { authHint: String(d.authHint) } : {}),
        ...(d?.loginCommand ? { loginCommand: String(d.loginCommand) } : {}),
      };
    }));
  }

  /** 연결된 studio에 최신 providers를 보낸다 (짧게 모아서 한 번). */
  let broadcastTimer = null;
  let broadcastChain = Promise.resolve();
  function scheduleProvidersBroadcast(delayMs = 50) {
    if (broadcastTimer || closing) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastChain = broadcastChain.then(async () => {
        if (!studio || closing) return;
        try {
          const list = await providersList();
          send(studio, { type: 'providers', list });
        } catch (err) {
          log(`providers broadcast: ${err?.message ?? err}`);
        }
      });
    }, delayMs);
    broadcastTimer.unref?.();
  }

  /**
   * 모델 목록을 다시 받는다 (provider당 하나만 진행). 실패는 캐시/fallback으로 남긴다.
   * @param {string|null|undefined} providerId 없으면 listModels가 있는 모든 provider
   * @param {{onlyStale?: boolean}} [o]
   */
  async function refreshModels(providerId, { onlyStale = false } = {}) {
    const targets = [...providers.values()].filter((p) => hasLiveModels(p) && (!providerId || p.id === providerId));
    await Promise.all(targets.map(async (p) => {
      if (onlyStale) {
        await catalog.load();
        if (catalog.isFresh(catalog.peek(p.id))) return;
      }
      try {
        await catalog.refresh(p.id, modelsFetcher(p));
      } catch (err) {
        log(`모델 목록 갱신 실패 (${p.id}): ${err?.message ?? err}`);
      }
    }));
  }

  async function onModelsRefresh(msg, socket) {
    const providerId = typeof msg.providerId === 'string' && msg.providerId ? msg.providerId : null;
    await refreshModels(providerId);
    send(socket, { type: 'providers', list: await providersList() });
  }

  function emitTo(threadId, event) {
    sendStudio({ type: 'agent_event', threadId, event });
  }

  async function startTurn(msg) {
    const { threadId, providerId } = msg;
    if (typeof threadId !== 'string' || !threadId) return;
    /** 대화 기록(transcript)에 남길 스레드 — 메시지를 확인한 뒤 붙는다 */
    let recordTo = null;
    const emitHub = (event) => {
      if (recordTo && recordTranscript(recordTo, event)) {
        saveSoon(recordTo, ['tool_result', 'turn_end', 'error', 'limit'].includes(event?.kind));
      }
      emitTo(threadId, event);
    };
    if (turns.has(threadId)) {
      emitTo(threadId, { kind: 'error', code: 'TURN_IN_PROGRESS', message: '이 대화에서 이미 답변을 생성하고 있습니다' });
      return;
    }
    const abort = new AbortController();
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const entry = { abort, done, interrupted: false };
    turns.set(threadId, entry);
    let reason = 'done';
    try {
      const provider = providers.get(providerId);
      if (!provider) {
        emitHub({ kind: 'error', code: 'PROVIDER_UNAVAILABLE', message: `사용할 수 없는 provider: ${providerId}` });
        reason = 'error';
        return;
      }
      // 참고 파일 — 하나라도 받을 수 없으면 턴을 시작하지 않는다 (사용자가 고쳐 다시 보낸다)
      const incoming = normalizeAttachments(msg.attachments);
      if (!incoming.ok) {
        emitHub({ kind: 'error', code: incoming.error.code, message: incoming.error.message });
        reason = 'error';
        return;
      }
      const typed = typeof msg.text === 'string' ? msg.text : '';
      // 카드 — 이 컴퓨터에 있는 카드만, 한 번에 CARD_REFS_PER_MESSAGE 개까지
      const cardIds = Array.isArray(msg.cards) ? [...new Set(msg.cards.filter((id) => typeof id === 'string' && id))] : [];
      if (cardIds.length > CARD_REFS_PER_MESSAGE) {
        emitHub({ kind: 'error', code: 'CARD_LIMIT', message: `카드는 한 번에 ${CARD_REFS_PER_MESSAGE}개까지 붙일 수 있습니다` });
        reason = 'error';
        return;
      }
      const sentCards = (await Promise.all(cardIds.map((id) => cards.get(id)))).filter(Boolean);
      if (sentCards.length !== cardIds.length) {
        emitHub({ kind: 'error', code: 'CARD_NOT_FOUND', message: '붙인 카드 중 지워진 카드가 있습니다. 카드를 다시 붙여 주세요.' });
        reason = 'error';
        return;
      }
      if (!typed.trim() && incoming.list.length === 0 && sentCards.length === 0) {
        emitHub({ kind: 'error', code: 'INVALID_MESSAGE', message: '메시지가 비어 있습니다' });
        reason = 'error';
        return;
      }
      // 글 없이 파일만 보냈으면 무엇을 할지 되묻도록 한 줄을 대신 넣는다
      const userText = typed.trim() ? typed : incoming.list.length > 0 ? '첨부한 파일을 확인해 주세요.' : '붙인 카드를 확인해 주세요.';
      const mode = msg.mode === 'full' ? 'full' : 'agent';
      const thread = await store.get(threadId);
      const attached = await attachments.add(thread, incoming.list);
      if (!attached.ok) {
        emitHub({ kind: 'error', code: attached.error.code, message: attached.error.message });
        reason = 'error';
        return;
      }
      // 카드 편집 화면의 AI 대화 — 문서 tool 을 막고 propose_card 만 연다 (dispatchTool)
      if (msg.purpose === 'card-draft') thread.purpose = 'card-draft';
      if (sentCards.length > 0) thread.cards = [...new Set([...(Array.isArray(thread.cards) ? thread.cards : []), ...sentCards.map((c) => c.id)])];
      // 앞선 기록이 끝맺지 못했으면(허브가 죽었던 경우) 먼저 닫는다
      closeDanglingTurn(thread);
      if (!thread.title) thread.title = userText.replace(/\s+/g, ' ').trim().slice(0, 40);
      // 대화는 문서에 딸린다 — 마지막으로 보낸 때의 문서(다른 이름으로 저장하면 새 이름을 따른다)
      const doc = normalizeDoc(msg.doc);
      if (doc) thread.doc = doc;
      (thread.transcript ??= []).push({
        kind: 'user', text: userText, providerId, at: new Date().toISOString(),
        // 화면 복원용: 그 요청에 붙인 파일(이름·종류만 — 내용은 따로 둔다)
        ...(attached.added.length > 0
          ? { attachments: attached.added.map(({ meta }) => ({ id: meta.id, name: meta.name, kind: meta.kind, size: meta.size, chars: meta.chars, images: meta.images })) }
          : {}),
        ...(sentCards.length > 0 ? { cards: sentCards.map((c) => ({ id: c.id, name: c.name, icon: c.icon })) } : {}),
      });
      recordTo = thread;
      saveSoon(thread, true);
      const reviews = thread.pendingReviews.splice(0);
      const text = buildTurnText({
        text: userText, mode, context: msg.context, reviews,
        attachments: [
          attachmentsBlock(thread.attachments, attached.added),
          cardsBlock(await cardsOf(thread), sentCards.map((c) => c.id)),
          thread.purpose === 'card-draft' ? CARD_DRAFT_BLOCK : '',
        ].filter(Boolean).join('\n\n'),
      });
      const messages = Array.isArray(thread.histories[providerId]) ? thread.histories[providerId] : [];
      const emit = (event) => {
        if (!event || typeof event !== 'object' || HUB_OWNED_EVENT_KINDS.has(event.kind)) return;
        emitHub(event);
      };
      const toolCall = (name, args) => callTool({ name, args, origin: 'agent', threadId, signal: abort.signal, emit: emitHub });
      try {
        const out = await provider.runTurn({
          threadId,
          model: typeof msg.model === 'string' && msg.model ? msg.model : undefined,
          messages,
          text,
          userText,
          mode,
          systemPrompt,
          tools: tools.TOOLS,
          toolsModule: tools,
          callTool: toolCall,
          emit,
          signal: abort.signal,
        });
        if (Array.isArray(out?.messages)) thread.histories[providerId] = out.messages;
        if (abort.signal.aborted) reason = entry.interrupted ? 'interrupted' : 'cancelled';
      } catch (err) {
        if (Array.isArray(err?.messages)) thread.histories[providerId] = err.messages;
        if (abort.signal.aborted) {
          reason = entry.interrupted ? 'interrupted' : 'cancelled';
        } else {
          reason = 'error';
          if (!err?.emitted) {
            emitHub({ kind: 'error', code: typeof err?.code === 'string' ? err.code : 'PROVIDER_ERROR', message: String(err?.message ?? err) });
          }
          log(`turn error (${providerId}): ${err?.stack ?? err}`);
          if (UNKNOWN_MODEL_ERROR.test(String(err?.message ?? ''))) {
            void refreshModels(providerId).then(() => scheduleProvidersBroadcast());
          }
        }
      }
      thread.lastProviderId = providerId;
      await store.save(thread);
      pruneThreads();
    } catch (err) {
      reason = 'error';
      emitHub({ kind: 'error', code: 'HUB_ERROR', message: String(err?.message ?? err) });
    } finally {
      turns.delete(threadId);
      emitHub({ kind: 'turn_end', reason });
      resolveDone();
    }
  }

  /** 화면 복원 — 대화 목록 */
  async function onThreadsQuery(msg, socket) {
    const limit = typeof msg.limit === 'number' ? Math.max(1, Math.min(200, msg.limit)) : 50;
    // doc 을 주면 그 문서의 대화만. doc 이 null 이면(문서 없음·저장 안 한 새 문서) 빈 목록
    if ('doc' in msg && !normalizeDoc(msg.doc)) {
      return send(socket, { type: 'threads', ...(typeof msg.reqId === 'string' ? { reqId: msg.reqId } : {}), list: [] });
    }
    const list = await store.list(limit, normalizeDoc(msg.doc));
    send(socket, {
      type: 'threads',
      ...(typeof msg.reqId === 'string' ? { reqId: msg.reqId } : {}),
      list: list.map((t) => ({ ...t, running: turns.has(t.id) })),
    });
  }

  /** 화면 복원 — 대화 하나의 기록. 끝맺지 못한 기록(허브가 죽었던 경우)은 "중단됨" 으로 닫아 준다 */
  async function onThreadLoad(msg, socket) {
    const reply = (body) => send(socket, { type: 'thread', ...(typeof msg.reqId === 'string' ? { reqId: msg.reqId } : {}), ...body });
    if (typeof msg.threadId !== 'string' || !msg.threadId) {
      return send(socket, { type: 'error', reqId: msg.reqId, requestType: 'thread_load', code: 'INVALID_ARGS', message: 'threadId가 없습니다' });
    }
    const thread = await store.get(msg.threadId);
    const running = turns.has(thread.id);
    if (!running && closeDanglingTurn(thread)) await store.save(thread);
    reply({
      threadId: thread.id,
      title: thread.title || '대화',
      doc: thread.doc ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      running,
      transcript: Array.isArray(thread.transcript) ? thread.transcript : [],
      attachments: Array.isArray(thread.attachments) ? thread.attachments : [],
      cards: (await cardsOf(thread)).map(cardBrief),
    });
  }

  /**
   * 대화에서 카드 떼기 (S→H `thread_card_detach {threadId, id}` → H→S `thread_card_detached {threadId, id, ok, cards?, error?}`).
   * 뗀 카드는 다음 턴부터 <doogle_cards>·자리표시자·read_card 에서 빠지고, 민감 값 가리기·쪽 그림 막기도 풀린다.
   */
  async function onThreadCardDetach(msg, socket) {
    const { threadId, id } = msg;
    const reply = (body) => send(socket, { type: 'thread_card_detached', threadId, id, ...(typeof msg.reqId === 'string' ? { reqId: msg.reqId } : {}), ...body });
    if (typeof threadId !== 'string' || !threadId || typeof id !== 'string' || !id) {
      return reply({ ok: false, error: { code: 'INVALID_ARGS', message: 'threadId 와 id 가 필요합니다' } });
    }
    if (turns.has(threadId)) {
      return reply({ ok: false, error: { code: 'THREAD_BUSY', message: '답변을 만드는 중에는 카드를 뗄 수 없습니다' } });
    }
    const thread = await store.get(threadId);
    const before = Array.isArray(thread.cards) ? thread.cards : [];
    thread.cards = before.filter((c) => c !== id);
    if (thread.cards.length !== before.length) await store.save(thread, { touch: false });
    reply({ ok: true, cards: (await cardsOf(thread)).map(cardBrief) });
  }

  /** 대화 지우기 (S→H `thread_delete {threadId}` → H→S `thread_deleted {threadId, ok, error?}`) */
  async function onThreadDelete(msg, socket) {
    const threadId = msg.threadId;
    const reply = (body) => send(socket, { type: 'thread_deleted', threadId, ...(typeof msg.reqId === 'string' ? { reqId: msg.reqId } : {}), ...body });
    if (typeof threadId !== 'string' || !threadId || threadId.length > 200) {
      return reply({ ok: false, error: { code: 'INVALID_ARGS', message: 'threadId가 없습니다' } });
    }
    if (turns.has(threadId)) {
      return reply({ ok: false, error: { code: 'THREAD_BUSY', message: '답변을 만들고 있는 대화는 지울 수 없습니다' } });
    }
    const timer = saveTimers.get(threadId);
    if (timer) clearTimeout(timer);
    saveTimers.delete(threadId);
    try {
      await store.delete(threadId);
      attachments.forget(threadId);
      reply({ ok: true });
    } catch (err) {
      reply({ ok: false, error: { code: 'DELETE_FAILED', message: String(err?.message ?? err) } });
    }
  }

  /**
   * 카드 (S→H `cards_query` → H→S `cards {list}`,
   *       `card_save {card}` → `card_saved {ok, card?|error?}`,
   *       `card_delete {id}` → `card_deleted {id, ok, error?}`).
   */
  async function onCards(msg, socket) {
    const reqId = typeof msg.reqId === 'string' ? { reqId: msg.reqId } : {};
    const fail = (err, fallback) => ({ code: typeof err?.code === 'string' ? err.code : fallback, message: String(err?.message ?? err) });
    if (msg.type === 'cards_query') {
      try {
        return send(socket, { type: 'cards', ...reqId, list: await cards.list() });
      } catch (err) {
        return send(socket, { type: 'error', ...reqId, requestType: 'cards_query', code: 'HUB_ERROR', message: String(err?.message ?? err) });
      }
    }
    if (msg.type === 'card_save') {
      try {
        return send(socket, { type: 'card_saved', ...reqId, ok: true, card: await cards.save(msg.card) });
      } catch (err) {
        return send(socket, { type: 'card_saved', ...reqId, ok: false, error: fail(err, 'SAVE_FAILED') });
      }
    }
    const id = msg.id;
    if (typeof id !== 'string' || !id) {
      return send(socket, { type: 'card_deleted', ...reqId, id, ok: false, error: { code: 'INVALID_ARGS', message: 'id가 없습니다' } });
    }
    try {
      const gone = await cards.delete(id);
      return send(socket, { type: 'card_deleted', ...reqId, id, ok: gone, ...(gone ? {} : { error: { code: 'NOT_FOUND', message: '그런 카드가 없습니다' } }) });
    } catch (err) {
      return send(socket, { type: 'card_deleted', ...reqId, id, ok: false, error: fail(err, 'DELETE_FAILED') });
    }
  }

  /** 화면에 보일 카드 요약 (값 없음) */
  function cardBrief(c) {
    return { id: c.id, name: c.name, icon: c.icon, sensitive: c.fields.some((f) => f.sensitive) };
  }

  /** 대화에 붙은 카드 (지워진 카드는 빠진다) */
  async function cardsOf(thread) {
    const ids = Array.isArray(thread.cards) ? thread.cards : [];
    const found = await Promise.all(ids.map((id) => cards.get(id)));
    return found.filter(Boolean);
  }

  /** 보관 한도를 넘은 옛 대화를 뒤에서 정리한다 (응답 중인 대화는 남긴다) */
  function pruneThreads() {
    void store.prune((id) => turns.has(id)).then((gone) => {
      if (gone.length > 0) log(`오래된 대화 ${gone.length}개를 정리했습니다 (보관 한도 ${store.maxThreads}개)`);
    }).catch((err) => log(`대화 정리: ${err?.message ?? err}`));
  }

  async function onReviewDecision(msg) {
    if (typeof msg.threadId !== 'string' || !msg.threadId) return;
    if (!['accept_all', 'reject_all', 'partial'].includes(msg.decision)) return;
    const thread = await store.get(msg.threadId);
    thread.pendingReviews.push({
      decision: msg.decision,
      ...(typeof msg.note === 'string' && msg.note ? { note: msg.note.slice(0, 4000) } : {}),
      at: new Date().toISOString(),
    });
    await store.save(thread);
  }

  async function onSecret(msg, socket) {
    const key = msg.key;
    if (!STUDIO_WRITABLE_SECRETS.has(key)) {
      send(socket, { type: 'secret_ack', key, ok: false, error: { code: 'INVALID_KEY', message: '허용되지 않는 키' } });
      return;
    }
    try {
      if (msg.type === 'secret_set' || msg.type === 'secrets_set') await secrets.setSecret(key, String(msg.value ?? ''));
      else await secrets.deleteSecret(key);
      send(socket, { type: 'secret_ack', key, ok: true });
      void providersList().then((list) => send(socket, { type: 'providers', list }));
      // 새 키로 모델 목록을 다시 받아 한 번 더 알린다.
      if (msg.type === 'secret_set' || msg.type === 'secrets_set') {
        const pid = SECRET_PROVIDER[key];
        if (pid) void refreshModels(pid).then(() => scheduleProvidersBroadcast());
      }
    } catch (err) {
      send(socket, { type: 'secret_ack', key, ok: false, error: { code: 'SECRET_ERROR', message: String(err?.message ?? err) } });
    }
  }

  // ── provider 로그인 (SIWC 등: provider.startLogin/logout이 있는 경우) ──
  /** providerId → 진행 중 로그인 (cancel 가능) */
  const logins = new Map();

  async function onAuthStart(msg, socket) {
    const providerId = msg.providerId;
    const p = providers.get(providerId);
    if (!p || typeof p.startLogin !== 'function') {
      send(socket, { type: 'auth_done', providerId, ok: false, error: { code: 'AUTH_UNSUPPORTED', message: '이 provider는 앱 로그인을 지원하지 않습니다' } });
      return;
    }
    logins.get(providerId)?.cancel?.();
    // 브라우저에서 로그인하는 사이 화면이 새 소켓으로 다시 붙을 수 있다 — 끝 알림은 그때의 화면으로 보낸다.
    // (시작한 소켓으로만 보내면 알림이 사라져 화면이 로그인 전 상태로 남는다)
    const toScreen = (m) => (studio || detached ? sendStudio(m) : send(socket, m));
    try {
      const login = await p.startLogin();
      logins.set(providerId, login);
      send(socket, { type: 'auth_url', providerId, url: login.authUrl ?? login.url });
      try {
        await login.waitForCompletion();
        toScreen({ type: 'auth_done', providerId, ok: true });
        await refreshModels(providerId);
      } finally {
        if (logins.get(providerId) === login) logins.delete(providerId);
      }
    } catch (err) {
      toScreen({ type: 'auth_done', providerId, ok: false, error: { code: typeof err?.code === 'string' ? err.code : 'AUTH_FAILED', message: String(err?.message ?? err) } });
    }
    toScreen({ type: 'providers', list: await providersList() });
  }

  /** 터미널 로그인이 필요한 provider — 공식 CLI 를 새 터미널 창에 띄운다 (S→H `open_terminal {providerId}`) */
  async function onOpenTerminal(msg, socket) {
    const providerId = msg.providerId;
    const p = providers.get(providerId);
    const reply = (body) => send(socket, { type: 'open_terminal_done', providerId, ...(typeof msg.reqId === 'string' ? { reqId: msg.reqId } : {}), ...body });
    if (!p || typeof p.openTerminal !== 'function') {
      return reply({ ok: false, error: { code: 'UNSUPPORTED', message: '이 provider는 터미널 열기를 지원하지 않습니다' } });
    }
    try {
      await p.openTerminal();
      reply({ ok: true });
    } catch (err) {
      reply({ ok: false, error: { code: typeof err?.code === 'string' ? err.code : 'OPEN_FAILED', message: String(err?.message ?? err) } });
    }
  }

  async function onAuthLogout(msg, socket) {
    const providerId = msg.providerId;
    const p = providers.get(providerId);
    let ok = false;
    let error;
    if (p && typeof p.logout === 'function') {
      try {
        await p.logout();
        ok = true;
      } catch (err) {
        error = { code: 'AUTH_LOGOUT_FAILED', message: String(err?.message ?? err) };
      }
    } else {
      error = { code: 'AUTH_UNSUPPORTED', message: '이 provider는 앱 로그아웃을 지원하지 않습니다' };
    }
    send(socket, { type: 'auth_logout_done', providerId, ok, ...(error ? { error } : {}) });
    send(socket, { type: 'providers', list: await providersList() });
  }

  // ── 소켓 핸들러 ─────────────────────────────────────────────
  function parse(data) {
    try {
      const m = JSON.parse(String(data));
      return m && typeof m === 'object' && typeof m.type === 'string' ? m : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {string} clientId 화면(페이지) 하나의 id — 새로고침하면 바뀐다. 모르면 ''
   */
  function onStudioConnection(ws, clientId = '') {
    /** 같은 화면이 다시 붙어 진행 중이던 응답을 이어 가는가 (welcome.resumed) */
    let resumed = false;
    if (detached) {
      const d = detached;
      if (clientId && d.clientId === clientId) {
        // 끊겼던 그 화면이 돌아왔다 — 걸려 있던 호출을 옮기고 모아 둔 것을 순서대로 보낸다
        detached = null;
        clearTimeout(d.timer);
        rebindPending(d.socket, ws);
        resumed = true;
        for (const m of d.buffer) send(ws, m);
      } else {
        // 다른 화면이다(새로고침) — 옛 화면의 문서에 대고 하던 응답은 멈춘다
        dropDetached();
      }
    }
    if (studio && studio !== ws) {
      const old = studio;
      if (clientId && old.doogleClientId === clientId) {
        // 같은 화면이 새 소켓으로 붙었다 — 이어 간다 (죽은 옛 소켓에 붙들려 있던 것도 넘긴다)
        rebindPending(old, ws);
        resumed = true;
        for (const m of old.doogleLimbo ?? []) send(ws, m);
        old.doogleLimbo = [];
      } else {
        // 새 화면이 붙었다(새로고침) — 옛 화면의 문서에 대고 하던 응답은 멈춘다
        interruptTurns();
        failPendingFor(old);
      }
      try { old.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    ws.doogleClientId = clientId;
    studio = ws;
    ws.on('message', (data) => {
      const msg = parse(data);
      if (!msg) return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'JSON 객체가 아닙니다' });
      switch (msg.type) {
        case 'hello':
          return send(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, hubVersion: HUB_VERSION, resumed });
        case 'providers_query':
          return void providersList().then((list) => send(ws, { type: 'providers', list }));
        case 'models_refresh':
          return void onModelsRefresh(msg, ws).catch((e) => log(`models_refresh: ${e?.message}`));
        case 'chat_send':
          return void startTurn(msg);
        case 'chat_cancel':
          turns.get(msg.threadId)?.abort.abort();
          return;
        case 'tool_result':
          return onToolResult(msg, ws);
        case 'review_decision':
          return void onReviewDecision(msg).catch((e) => log(`review_decision: ${e?.message}`));
        case 'threads_query':
          return void onThreadsQuery(msg, ws).catch((e) => log(`threads_query: ${e?.message}`));
        case 'thread_load':
          return void onThreadLoad(msg, ws).catch((e) => {
            log(`thread_load: ${e?.message}`);
            send(ws, { type: 'error', reqId: msg.reqId, requestType: 'thread_load', code: 'HUB_ERROR', message: String(e?.message ?? e) });
          });
        case 'thread_delete':
          return void onThreadDelete(msg, ws).catch((e) => log(`thread_delete: ${e?.message}`));
        case 'thread_card_detach':
          return void onThreadCardDetach(msg, ws).catch((e) => log(`thread_card_detach: ${e?.message}`));
        case 'cards_query':
        case 'card_save':
        case 'card_delete':
          return void onCards(msg, ws).catch((e) => log(`${msg.type}: ${e?.message}`));
        case 'secret_set':
        case 'secrets_set':
        case 'secret_delete':
        case 'secrets_delete':
          return void onSecret(msg, ws);
        case 'auth_start':
          return void onAuthStart(msg, ws);
        case 'auth_cancel':
          logins.get(msg.providerId)?.cancel?.();
          return;
        case 'auth_logout':
          return void onAuthLogout(msg, ws);
        case 'open_terminal':
          return void onOpenTerminal(msg, ws);
        default:
          return send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `알 수 없는 메시지: ${msg.type}` });
      }
    });
    ws.on('close', (code) => {
      if (studio !== ws) {
        // 이미 다른 소켓으로 바뀐 옛 소켓 — 옮기지 못하고 남은 호출만 정리한다
        failPendingFor(ws);
        return;
      }
      studio = null;
      // 화면이 스스로 닫았으면(1000·1001·1005: 새로고침·창 닫힘) 문서도 사라졌다 — 바로 멈춘다.
      // 뜻밖에 끊겼고(1006 등) 하던 일이 있으면, 같은 화면이 돌아오길 잠깐 기다린다.
      // (화면이 hub 재시작 알림을 받고 스스로 다시 붙을 때는 4000 으로 닫는다 — 기다리는 쪽)
      const left = code === 1000 || code === 1001 || code === 1005;
      const working = turns.size > 0 || [...pending.values()].some((p) => p.socket === ws);
      if (!left && clientId && working && reconnectGraceMs > 0 && !closing) {
        const d = { clientId, socket: ws, buffer: ws.doogleLimbo ?? [], timer: setTimeout(() => { if (detached === d) dropDetached(); }, reconnectGraceMs) };
        d.timer.unref?.();
        detached = d;
        return;
      }
      interruptTurns();
      failPendingFor(ws);
    });
  }

  function onMcpConnection(ws) {
    const abort = new AbortController();
    ws.on('message', async (data) => {
      const msg = parse(data);
      if (!msg) return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'JSON 객체가 아닙니다' });
      if (msg.type === 'hello') return send(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, hubVersion: HUB_VERSION });
      if (msg.type !== 'tool_call') return send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `알 수 없는 메시지: ${msg.type}` });
      const r = await callTool({ name: msg.name, args: msg.args, origin: 'mcp', signal: abort.signal });
      send(ws, { type: 'tool_result', callId: msg.callId, ...r });
    });
    ws.on('close', () => abort.abort());
  }

  // ── HTTP/WS 서버 ───────────────────────────────────────────
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return reject(400, 'Bad Request');
    }
    const route = url.pathname;
    if (route !== '/studio' && route !== '/mcp') return reject(404, 'Not Found');
    const origin = req.headers.origin;
    // 브라우저 Origin은 허용 목록만. Origin 없는 연결(doogle-mcp 등 Node 클라이언트)은 token으로만 판단.
    if (origin !== undefined && !allowedOrigins.has(origin)) return reject(403, 'Forbidden');
    const given = url.searchParams.get('token') ?? req.headers['x-doogle-token'];
    if (!tokenMatches(token, Array.isArray(given) ? given[0] : given)) return reject(401, 'Unauthorized');
    const client = url.searchParams.get('client') ?? '';
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (route === '/studio') onStudioConnection(ws, CLIENT_ID.test(client) ? client : '');
      else onMcpConnection(ws);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;

  let hubJsonFile = null;
  if (opts.writeHubJson !== false) {
    hubJsonFile = path.join(dataDir, 'hub.json');
    await writeHubJson(hubJsonFile, { port, token, pid: process.pid, version: 1 });
  }

  // 기동 시: 보관 한도를 넘은 옛 대화를 뒤에서 정리한다
  pruneThreads();

  if (opts.refreshModelsOnStart !== false) {
    // 기동 시: 캐시가 없거나 오래된 provider만 뒤에서 갱신 (끝나면 연결된 studio에 push)
    void refreshModels(null, { onlyStale: true }).then(() => scheduleProvidersBroadcast());
  }

  async function close() {
    closing = true;
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
    await catalog.idle();
    for (const l of logins.values()) l?.cancel?.();
    dropDetached();
    interruptTurns();
    await Promise.all([...turns.values()].map((t) => t.done));
    // 미뤄 둔 저장은 지금 쓴다
    for (const [id, timer] of saveTimers) {
      clearTimeout(timer);
      const t = store.threads.get(id);
      if (t) void store.save(t);
    }
    saveTimers.clear();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(() => r()));
    await new Promise((r) => server.close(() => r()));
    await store.flush();
    if (hubJsonFile) {
      try {
        const cur = JSON.parse(await fs.readFile(hubJsonFile, 'utf8'));
        if (cur.pid === process.pid && cur.port === port) await fs.rm(hubJsonFile, { force: true });
      } catch { /* ignore */ }
    }
  }

  return {
    port,
    token,
    host,
    dataDir,
    hubJsonFile,
    providers,
    modelCatalog: catalog,
    refreshModels,
    tools,
    systemPrompt,
    store,
    attachments,
    cards,
    close,
    /** 테스트·내부용 */
    callTool,
    get studioConnected() { return !!studio && studio.readyState === WebSocket.OPEN; },
    /** 테스트·평가용: 화면 소켓을 닫는 인사 없이 끊는다 (뜻밖의 끊김 흉내) */
    dropStudioConnection() { studio?.terminate(); },
  };
}

/** hub.json 기록 (권한 0600). */
export async function writeHubJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}
