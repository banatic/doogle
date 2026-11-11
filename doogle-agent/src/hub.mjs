// 두글 hub: studio(WebView)와 provider/외부 MCP 클라이언트 사이의 WebSocket 중계 서버.
// 프로토콜은 docs/doogle/CONTRACT.md §1–3.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { defaultModelId, ModelCatalog, normalizeModels } from './model-catalog.mjs';
import { appDataDir } from './paths.mjs';
import { loadProviders, sortProviders } from './provider-registry.mjs';
import { buildSystemPrompt, buildTurnText } from './system-prompt.mjs';
import { ThreadStore, closeDanglingTurn, recordTranscript } from './threads.mjs';
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
    s = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
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
  const store = new ThreadStore({ dir: opts.persistThreads === false ? null : path.join(dataDir, 'threads') });

  /** 현재 studio 소켓 (하나만 유지) */
  /** @type {WebSocket | null} */
  let studio = null;
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
    const socket = studio;
    if (!socket || socket.readyState !== WebSocket.OPEN) return { ok: false, error: { ...NO_DOCUMENT } };

    // 사용자 응답·검토를 기다릴 수 있는 tool(질문/권한 요청, 쓰기)은 긴 대기 시간
    const waitsForHuman = humanWaitTools.has(name) || def?.kind === 'write';
    const timeoutMs = waitsForHuman ? timeouts.write : timeouts.read;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r, { notifyStudio = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        pending.delete(callId);
        if (notifyStudio) send(socket, { type: 'tool_cancel', callId });
        resolve(r);
      };
      const onAbort = () => finish({ ok: false, error: { code: 'CANCELLED', message: '취소되었습니다' } }, { notifyStudio: true });
      const timer = setTimeout(() => finish({
        ok: false,
        error: { code: 'TIMEOUT', message: `두글이 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다 (${name})` },
      }, { notifyStudio: true }), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.set(callId, { resolve: (r) => finish(r), socket });
      send(socket, { type: 'tool_call', callId, name, args, origin, ...(threadId ? { threadId } : {}) });
    });
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
    send(studio, { type: 'agent_event', threadId, event });
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
      if (typeof msg.text !== 'string' || !msg.text.trim()) {
        emitHub({ kind: 'error', code: 'INVALID_MESSAGE', message: '메시지가 비어 있습니다' });
        reason = 'error';
        return;
      }
      const mode = msg.mode === 'full' ? 'full' : 'agent';
      const thread = await store.get(threadId);
      // 앞선 기록이 끝맺지 못했으면(허브가 죽었던 경우) 먼저 닫는다
      closeDanglingTurn(thread);
      if (!thread.title) thread.title = msg.text.replace(/\s+/g, ' ').trim().slice(0, 40);
      (thread.transcript ??= []).push({ kind: 'user', text: msg.text, providerId, at: new Date().toISOString() });
      recordTo = thread;
      saveSoon(thread, true);
      const reviews = thread.pendingReviews.splice(0);
      const text = buildTurnText({ text: msg.text, mode, context: msg.context, reviews });
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
          userText: msg.text,
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
    const list = await store.list(typeof msg.limit === 'number' ? Math.max(1, Math.min(200, msg.limit)) : 50);
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
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      running,
      transcript: Array.isArray(thread.transcript) ? thread.transcript : [],
    });
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
    try {
      const login = await p.startLogin();
      logins.set(providerId, login);
      send(socket, { type: 'auth_url', providerId, url: login.authUrl ?? login.url });
      try {
        await login.waitForCompletion();
        send(socket, { type: 'auth_done', providerId, ok: true });
        await refreshModels(providerId);
      } finally {
        if (logins.get(providerId) === login) logins.delete(providerId);
      }
    } catch (err) {
      send(socket, { type: 'auth_done', providerId, ok: false, error: { code: typeof err?.code === 'string' ? err.code : 'AUTH_FAILED', message: String(err?.message ?? err) } });
    }
    send(socket, { type: 'providers', list: await providersList() });
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

  function onStudioConnection(ws) {
    if (studio && studio !== ws) {
      const old = studio;
      // 새 화면이 붙었다(새로고침) — 옛 화면의 문서에 대고 하던 응답은 멈춘다
      interruptTurns();
      failPendingFor(old);
      try { old.close(4000, 'replaced'); } catch { /* ignore */ }
    }
    studio = ws;
    ws.on('message', (data) => {
      const msg = parse(data);
      if (!msg) return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'JSON 객체가 아닙니다' });
      switch (msg.type) {
        case 'hello':
          return send(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, hubVersion: HUB_VERSION });
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
        default:
          return send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `알 수 없는 메시지: ${msg.type}` });
      }
    });
    ws.on('close', () => {
      if (studio === ws) interruptTurns();
      failPendingFor(ws);
      if (studio === ws) studio = null;
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
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (route === '/studio') onStudioConnection(ws);
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

  if (opts.refreshModelsOnStart !== false) {
    // 기동 시: 캐시가 없거나 오래된 provider만 뒤에서 갱신 (끝나면 연결된 studio에 push)
    void refreshModels(null, { onlyStale: true }).then(() => scheduleProvidersBroadcast());
  }

  async function close() {
    closing = true;
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
    await catalog.idle();
    for (const l of logins.values()) l?.cancel?.();
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
    close,
    /** 테스트·내부용 */
    callTool,
    get studioConnected() { return !!studio && studio.readyState === WebSocket.OPEN; },
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
