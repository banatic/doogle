#!/usr/bin/env node
// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-agent/mcp-stdio.mjs
// Copyright (c) banatic, Hataewook/Rauhwpx, Edward Kim/rhwp — MIT License.
//
// 두글 MCP stdio 서버 — 외부 MCP 클라이언트(Claude Desktop/Code, Codex)가 두글에 열린 문서를
// 읽고 편집하게 한다. tool 호출은 hub(ws://127.0.0.1:{port}/mcp?token=…)로 보내고 hub 가 studio 로
// 중계한다 (CONTRACT §1–2). hub 주소·토큰은 hub.json 에서 읽는다 (연결할 때마다 다시 읽어
// hub 재시작으로 포트가 바뀌어도 따라간다).
//
// 환경변수(선택):
//   DOOGLE_HUB_JSON          hub.json 경로 재지정 (테스트용)
//   DOOGLE_MCP_CALL_TIMEOUT_MS  tool 호출 타임아웃 (기본 180000)
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import {
  HUMAN_WAIT_TOOL_NAMES,
  TOOL_RULES,
  prepareInsertImageArgs,
  toToolContent,
  toolsForProvider,
  validateArgs,
} from '../src/tools/index.mjs';

const VERSION = '0.1.0';
const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = Number(process.env.DOOGLE_MCP_CALL_TIMEOUT_MS) > 0
  ? Number(process.env.DOOGLE_MCP_CALL_TIMEOUT_MS) : 180_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_INFLIGHT_CALLS = 64;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HUMAN_WAIT = new Set(HUMAN_WAIT_TOOL_NAMES);

const NO_HUB_MESSAGE = '두글 앱을 실행하고 문서를 열어주세요 (Start the 두글 app and open a document.)';

function log(msg) {
  process.stderr.write(`[doogle-mcp] ${msg}\n`);
}

function hubError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** CONTRACT §1 hub.json 위치. */
function hubJsonPath(env = process.env, platform = process.platform) {
  if (env.DOOGLE_HUB_JSON) return env.DOOGLE_HUB_JSON;
  const home = os.homedir();
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'doogle', 'hub.json');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'doogle', 'hub.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'doogle', 'hub.json');
}

function readHubInfo() {
  const file = hubJsonPath();
  let info;
  try {
    info = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw hubError('NO_HUB', `${NO_HUB_MESSAGE} — hub.json not readable (${e?.code ?? e?.message ?? e})`);
  }
  const port = Number(info?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof info?.token !== 'string' || !info.token) {
    throw hubError('NO_HUB', `${NO_HUB_MESSAGE} — hub.json is malformed`);
  }
  return { port, token: info.token };
}

// ─── hub 연결 ───

/** @type {WebSocket | null} */
let ws = null;
/** @type {Promise<WebSocket> | null} */
let connecting = null;
/** @type {NodeJS.Timeout | null} */
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let shuttingDown = false;
/** @type {Map<string, {resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout | null}>} */
const inflight = new Map();

function failAllInflight(err) {
  for (const [, entry] of inflight) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(err);
  }
  inflight.clear();
}

/** 끊긴 뒤 백그라운드로 다시 붙는다 (다음 호출이 기다리지 않게). 실패하면 간격을 늘린다. */
function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected().then(
      () => { reconnectDelay = RECONNECT_MIN_MS; },
      () => {
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        scheduleReconnect();
      },
    );
  }, reconnectDelay);
  reconnectTimer.unref?.();
}

function ensureConnected() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  // executor 는 동기로 돈다 — 안에서 connecting = null 을 해도 바로 아래 대입이 덮으므로
  // 정리는 promise 가 끝난 뒤에 한다 (안 그러면 거절된 promise 가 영원히 남는다).
  const attempt = new Promise((resolve, reject) => {
    let sock;
    try {
      const { port, token } = readHubInfo();
      const url = new URL(`ws://127.0.0.1:${port}/mcp`);
      url.searchParams.set('token', token);
      sock = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES });
    } catch (e) {
      connecting = null;
      reject(e?.code ? e : hubError('NO_HUB', NO_HUB_MESSAGE));
      return;
    }
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      connecting = null;
      try { sock.terminate(); } catch {}
      reject(err);
    };
    const openTimer = setTimeout(() => fail(hubError('NO_HUB', `${NO_HUB_MESSAGE} — hub did not answer`)), CONNECT_TIMEOUT_MS);

    sock.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer);
      ws = sock;
      connecting = null;
      reconnectDelay = RECONNECT_MIN_MS;
      log('connected to 두글 hub');
      resolve(sock);
    });
    sock.on('unexpected-response', (_req, res) => {
      fail(hubError('NO_HUB', `${NO_HUB_MESSAGE} — hub refused the connection (HTTP ${res?.statusCode ?? '?'}); hub.json may be stale`));
    });
    sock.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log('ignoring unparseable hub frame');
        return;
      }
      if (msg?.type !== 'tool_result' || typeof msg.callId !== 'string') return;
      const entry = inflight.get(msg.callId);
      if (!entry) return;
      inflight.delete(msg.callId);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(hubError(msg.error?.code ?? 'TOOL_ERROR', msg.error?.message ?? 'unknown hub error'));
    });
    sock.on('error', (err) => {
      log(`ws error: ${err?.message ?? err}`);
      fail(hubError('NO_HUB', NO_HUB_MESSAGE));
    });
    sock.on('close', () => {
      // 대체된 옛 소켓의 close 가 현재 연결의 in-flight 호출을 죽이면 안 된다.
      if (ws !== sock) {
        fail(hubError('NO_HUB', NO_HUB_MESSAGE));
        return;
      }
      ws = null;
      log('hub connection closed');
      failAllInflight(hubError('HUB_DISCONNECTED', `connection to the 두글 hub was closed; if this was a document edit, re-read before retrying. ${NO_HUB_MESSAGE}`));
      scheduleReconnect();
    });
  });
  connecting = attempt;
  const clear = () => { if (connecting === attempt) connecting = null; };
  attempt.then(clear, clear);
  return attempt;
}

async function callHub(name, args) {
  const sock = await ensureConnected();
  if (inflight.size >= MAX_INFLIGHT_CALLS) {
    throw hubError('TOO_MANY_INFLIGHT_CALLS', `At most ${MAX_INFLIGHT_CALLS} tool calls may be in flight`);
  }
  const callId = randomUUID();
  return new Promise((resolve, reject) => {
    // 사용자 응답을 기다리는 tool 은 사람이 답할 때까지 둔다 — 보통 타임아웃이면 정상 대기를 실패로 만든다.
    const timer = HUMAN_WAIT.has(name)
      ? null
      : setTimeout(() => {
        inflight.delete(callId);
        reject(hubError('TOOL_TIMEOUT', `The 두글 hub did not respond within ${Math.round(CALL_TIMEOUT_MS / 1000)}s; if this was a document edit, re-read before retrying to avoid duplicates`));
      }, CALL_TIMEOUT_MS);
    inflight.set(callId, { resolve, reject, timer });
    try {
      sock.send(JSON.stringify({ type: 'tool_call', callId, name, args, origin: 'mcp' }));
    } catch (e) {
      inflight.delete(callId);
      if (timer) clearTimeout(timer);
      reject(hubError('NO_HUB', `failed to send to the 두글 hub: ${e?.message ?? e}`));
    }
  });
}

// ─── MCP 서버 ───

// 공유 규칙(revision·스테이징·셀 주소·오프셋·단위)은 tool 설명마다 반복하지 않고
// 서버 instructions 로 한 번만 보낸다. hub 시스템 프롬프트도 같은 텍스트를 싣는다.
const server = new Server(
  { name: 'doogle', version: VERSION },
  { capabilities: { tools: {}, resources: {} }, instructions: TOOL_RULES },
);

// 대화 제어 tool(질문 카드)은 두글 사이드바 대화 전용이라 외부 에이전트에는 싣지 않는다.
const MCP_TOOLS = toolsForProvider('mcp', { filter: (t) => t.kind !== 'control' && t.kind !== 'hub' });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MCP_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  // 인자는 SDK 가 아니라 여기서 검증한다 — 모르는 키·documentId 를 조용히 지우지 않고 안내와 함께 거절.
  const checked = validateArgs(name, rawArgs ?? {});
  if (!checked.ok) {
    return { content: [{ type: 'text', text: `${checked.error.code}: ${checked.error.message}` }], isError: true };
  }
  try {
    let args = checked.args;
    // 이미지 파일은 이 프로세스(사용자 기기)가 읽어 base64 로 넘긴다 — hub/studio 는 경로를 읽지 않는다.
    if (name === 'insert_image') args = await prepareInsertImageArgs(args);
    const result = await callHub(name, args);
    return { content: toToolContent(result) };
  } catch (e) {
    const code = e?.code ?? 'TOOL_ERROR';
    return { content: [{ type: 'text', text: `${code}: ${e?.message ?? e}` }], isError: true };
  }
});

// 두글은 리소스를 내보내지 않는다. 클라이언트가 리소스 목록을 먼저 살필 때 "Method not found" 대신
// 빈 목록을 받도록 빈 응답을 둔다.
server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, (request) => {
  throw new McpError(ErrorCode.InvalidParams, `doogle exposes no MCP resources: ${request.params.uri}`);
});

// 부모 CLI 가 시그널 대신 stdin 을 닫아 종료하는 경우에도 프로세스가 남지 않도록 명시적으로 나간다.
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  failAllInflight(hubError('NO_HUB', 'doogle-mcp is shutting down'));
  try { ws?.terminate(); } catch {}
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
server.onclose = () => shutdown('stdio transport closed');
process.stdin.on('end', () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
log(`두글 MCP stdio server started (hub.json: ${hubJsonPath()})`);

ensureConnected().then(
  () => log('eager hub connection established'),
  (e) => {
    log(`hub not available yet (will retry): ${e?.message ?? e}`);
    scheduleReconnect();
  },
);
