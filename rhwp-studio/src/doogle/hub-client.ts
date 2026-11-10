/**
 * studio ↔ doogle agent hub WebSocket 클라이언트 (CONTRACT §2, `/studio`).
 *
 * - 연결 정보: 데스크탑(Tauri)이면 `hub_info` 명령, 브라우저 개발이면 URL `?hubPort=&hubToken=`.
 * - 끊기면 지수 백오프로 다시 붙는다. 매 시도마다 연결 정보를 다시 묻는다 — hub 가 재시작되면 포트가 바뀐다.
 * - hub→studio `tool_call` 은 주입받은 실행기로 돌리고 `tool_result` 로 답한다.
 *
 * 이 파일은 DOM 을 만지지 않는다. 화면은 `ui/` 가 이 클라이언트를 구독해 그린다.
 */

export const HUB_PROTOCOL = 1;

export type AgentMode = 'agent' | 'full';
export type ToolOrigin = 'agent' | 'mcp';

export interface HubEndpoint {
  port: number;
  token: string;
}

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  models: ProviderModel[];
  authHint?: string;
}

export interface ToolError {
  code: string;
  message: string;
  data?: unknown;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: ToolError };

/** CONTRACT §3 */
export type AgentEvent =
  | { kind: 'status'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text_done' }
  | { kind: 'tool_use'; callId: string; name: string; args: unknown }
  | { kind: 'tool_result'; callId: string; ok: boolean; summary?: string }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number }
  | { kind: 'limit'; message: string; resetAt?: string | number }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'turn_end'; reason: 'done' | 'cancelled' | 'error' };

export interface ToolCallMessage {
  type: 'tool_call';
  callId: string;
  name: string;
  args: unknown;
  origin: ToolOrigin;
  threadId?: string;
}

export interface ChatContext {
  selection?: string;
  documentName?: string;
}

/** 이 클라이언트가 받는 hub→studio 메시지. 알 수 없는 type 은 `HubMessage` 의 일반형으로 흘려보낸다. */
export type HubMessage =
  | { type: 'welcome'; protocol: number; hubVersion?: string }
  | { type: 'providers'; list: ProviderInfo[] }
  | { type: 'agent_event'; threadId: string; event: AgentEvent }
  | ToolCallMessage
  | { type: string; [key: string]: unknown };

export type HubConnectionState =
  /** 연결 정보가 없다 (브라우저에 ?hubPort 없음, 데스크탑 hub 시작 실패 등) */
  | 'unavailable'
  | 'connecting'
  | 'open'
  /** 끊겼고 다시 붙을 예정 */
  | 'retrying'
  | 'stopped';

export interface HubClientOptions {
  /** 연결 정보. 못 구하면 null 이나 throw — 둘 다 'unavailable' 로 보고 재시도한다. */
  resolveEndpoint(): Promise<HubEndpoint | null>;
  /** hub→studio `tool_call` 실행. 던지면 `TOOL_FAILED` 로 답한다. */
  onToolCall(call: ToolCallMessage): Promise<ToolOutcome>;
  /** 테스트용 WebSocket 생성자 주입 */
  createSocket?(url: string): WebSocket;
}

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type Listener = (message: HubMessage) => void;

export class HubRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'HubRequestError';
  }
}

export class HubClient {
  private socket: WebSocket | null = null;
  private stateValue: HubConnectionState = 'connecting';
  private stateDetail = '';
  private hubVersion = '';
  private retryMs = MIN_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connecting = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly anyListeners = new Set<Listener>();
  private readonly stateListeners = new Set<(state: HubConnectionState, detail: string) => void>();
  private readonly options: HubClientOptions;
  private reqSeq = 0;
  /** 실행 중인 hub→studio tool_call. hub 가 `tool_cancel` 을 보내면 결과를 버린다. */
  private readonly inflight = new Map<string, { cancelled: boolean }>();

  constructor(options: HubClientOptions) {
    this.options = options;
  }

  get state(): HubConnectionState {
    return this.stateValue;
  }

  get detail(): string {
    return this.stateDetail;
  }

  get version(): string {
    return this.hubVersion;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'studio closed');
    this.setState('stopped', '');
  }

  /** 지금 바로 다시 붙는다 (hub 재시작 알림을 받았을 때). */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = MIN_RETRY_MS;
    if (this.stateValue === 'open') {
      // 열린 소켓이 이미 죽은 hub 를 가리킬 수 있다. 닫으면 onclose 가 재연결한다.
      this.socket?.close(4000, 'hub restarted');
      return;
    }
    void this.connect();
  }

  onState(cb: (state: HubConnectionState, detail: string) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** 특정 type 메시지 구독. `'*'` 는 모든 메시지. */
  on(type: string, cb: Listener): () => void {
    if (type === '*') {
      this.anyListeners.add(cb);
      return () => this.anyListeners.delete(cb);
    }
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** 열려 있으면 보내고 true. 아니면 false — 호출자가 사용자에게 알린다. */
  send(message: { type: string; [key: string]: unknown }): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.stateValue !== 'open') return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  /**
   * 요청 하나를 보내고 `responseType` 메시지 하나를 기다린다. CONTRACT 의 메시지에는 요청 번호가 없어
   * `reqId` 를 함께 실어 보내고, 응답에 `reqId` 가 있으면 그것으로, 없으면 type(+match)으로 짝을 짓는다.
   */
  request<T extends HubMessage>(
    message: { type: string; [key: string]: unknown },
    responseType: string,
    options: { timeoutMs?: number; match?(response: T): boolean } = {},
  ): Promise<T> {
    const reqId = `r${++this.reqSeq}`;
    return new Promise<T>((resolve, reject) => {
      let off: () => void = () => {};
      let offError: () => void = () => {};
      const timer = setTimeout(() => {
        off();
        offError();
        reject(new HubRequestError('TIMEOUT', `hub 가 응답하지 않습니다 (${message.type})`));
      }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      const finish = () => {
        clearTimeout(timer);
        off();
        offError();
      };
      off = this.on(responseType, (response) => {
        const id = (response as { reqId?: unknown }).reqId;
        if (typeof id === 'string' && id !== reqId) return;
        if (id === undefined && options.match && !options.match(response as T)) return;
        finish();
        resolve(response as T);
      });
      // hub 가 모르는 요청이면 `{type:"error", reqId?, code, message}` 로 답하길 기대한다 (제안).
      offError = this.on('error', (response) => {
        const r = response as { reqId?: unknown; code?: unknown; message?: unknown; requestType?: unknown };
        if (r.reqId !== reqId && r.requestType !== message.type) return;
        finish();
        reject(new HubRequestError(String(r.code ?? 'HUB_ERROR'), String(r.message ?? 'hub 오류')));
      });
      if (!this.send({ ...message, reqId })) {
        finish();
        reject(new HubRequestError('NOT_CONNECTED', 'agent hub 에 연결되어 있지 않습니다'));
      }
    });
  }

  // ─── CONTRACT §2 메시지 도우미 ───────────────────────────

  async queryProviders(): Promise<ProviderInfo[]> {
    const response = await this.request<{ type: 'providers'; list: ProviderInfo[] }>(
      { type: 'providers_query' },
      'providers',
      { timeoutMs: 30_000 },
    );
    return Array.isArray(response.list) ? response.list : [];
  }

  sendChat(input: {
    threadId: string;
    providerId: string;
    model?: string;
    text: string;
    mode: AgentMode;
    context?: ChatContext;
  }): boolean {
    return this.send({ type: 'chat_send', ...input });
  }

  cancelChat(threadId: string): boolean {
    return this.send({ type: 'chat_cancel', threadId });
  }

  reviewDecision(threadId: string, decision: 'accept_all' | 'reject_all' | 'partial', note?: string): boolean {
    return this.send({ type: 'review_decision', threadId, decision, ...(note ? { note } : {}) });
  }

  /**
   * 비밀값 저장/삭제. key = 'anthropic-api-key' | 'openai-api-key'.
   * S→H `secrets_set {key, value}` / `secret_delete {key}` → H→S `secret_ack {key, ok, error?}` → 새 `providers`.
   */
  async setSecret(key: string, value: string | null): Promise<void> {
    const response = await this.request<{ type: 'secret_ack'; key: string; ok: boolean; error?: ToolError | string }>(
      value === null ? { type: 'secret_delete', key } : { type: 'secrets_set', key, value },
      'secret_ack',
      { timeoutMs: 10_000, match: (r) => r.key === key },
    );
    if (!response.ok) {
      const error = response.error;
      throw new HubRequestError(
        typeof error === 'object' && error ? error.code : 'SECRET_FAILED',
        typeof error === 'object' && error ? error.message : String(error ?? '저장하지 못했습니다'),
      );
    }
  }

  /**
   * provider 로그인 시작 (CONTRACT 추가: S→H `auth_start {providerId}`).
   * hub 는 `auth_url {providerId, url}` (시스템 브라우저로 열 주소) 을 보내고, 끝나면
   * `auth_done {providerId, ok, error?}` 와 새 `providers` 를 보낸다. 이 둘은 `on()` 으로 구독한다.
   */
  startLogin(providerId: string): boolean {
    return this.send({ type: 'auth_start', providerId });
  }

  /** 진행 중인 로그인 취소 (S→H `auth_cancel {providerId}`). */
  cancelLogin(providerId: string): boolean {
    return this.send({ type: 'auth_cancel', providerId });
  }

  /** 로그아웃 (S→H `auth_logout {providerId}` → H→S `auth_logout_done {providerId, ok, error?}` → `providers`). */
  logout(providerId: string): boolean {
    return this.send({ type: 'auth_logout', providerId });
  }

  // ─── 연결 ────────────────────────────────────────────

  private setState(state: HubConnectionState, detail: string): void {
    if (this.stateValue === state && this.stateDetail === detail) return;
    this.stateValue = state;
    this.stateDetail = detail;
    for (const cb of this.stateListeners) {
      try { cb(state, detail); } catch (error) { console.error('[doogle] hub state listener', error); }
    }
  }

  private scheduleRetry(detail: string, unavailable = false): void {
    if (this.stopped) return;
    this.setState(unavailable ? 'unavailable' : 'retrying', detail);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.connecting = true;
    this.setState('connecting', '');
    let endpoint: HubEndpoint | null = null;
    try {
      endpoint = await this.options.resolveEndpoint();
    } catch (error) {
      this.connecting = false;
      this.scheduleRetry(error instanceof Error ? error.message : String(error), true);
      return;
    }
    if (!endpoint) {
      this.connecting = false;
      this.scheduleRetry('agent hub 연결 정보가 없습니다', true);
      return;
    }
    const url = `ws://127.0.0.1:${endpoint.port}/studio?token=${encodeURIComponent(endpoint.token)}`;
    let socket: WebSocket;
    try {
      socket = this.options.createSocket ? this.options.createSocket(url) : new WebSocket(url);
    } catch (error) {
      this.connecting = false;
      this.scheduleRetry(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
    this.connecting = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'studio', protocol: HUB_PROTOCOL }));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: HubMessage;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '') as HubMessage;
      } catch {
        console.warn('[doogle] hub 가 JSON 이 아닌 메시지를 보냈습니다');
        return;
      }
      if (!message || typeof message.type !== 'string') return;
      this.dispatch(message);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      const reason = event.code === 1008 || event.code === 4401 ? '인증 실패 — 토큰을 다시 받습니다' : 'agent hub 연결이 끊겼습니다';
      this.scheduleRetry(reason);
    };
    socket.onerror = () => {
      // onclose 가 뒤따른다. 여기서는 따로 하지 않는다.
    };
  }

  private dispatch(message: HubMessage): void {
    if (message.type === 'welcome') {
      const welcome = message as { protocol?: number; hubVersion?: string };
      this.hubVersion = String(welcome.hubVersion ?? '');
      this.retryMs = MIN_RETRY_MS;
      if (welcome.protocol !== undefined && welcome.protocol !== HUB_PROTOCOL) {
        console.warn(`[doogle] hub 프로토콜 ${welcome.protocol} (studio ${HUB_PROTOCOL})`);
      }
      this.setState('open', this.hubVersion);
    } else if (message.type === 'tool_call') {
      void this.handleToolCall(message as ToolCallMessage);
    } else if (message.type === 'tool_cancel') {
      // 실행기는 중간에 멈출 수 없다(편집은 transaction 1건으로 원자적). 결과만 보내지 않는다.
      const entry = this.inflight.get(String((message as { callId?: unknown }).callId));
      if (entry) entry.cancelled = true;
    }
    for (const cb of this.anyListeners) this.safeCall(cb, message);
    const set = this.listeners.get(message.type);
    if (set) for (const cb of [...set]) this.safeCall(cb, message);
  }

  private safeCall(cb: Listener, message: HubMessage): void {
    try { cb(message); } catch (error) { console.error('[doogle] hub listener', error); }
  }

  private async handleToolCall(call: ToolCallMessage): Promise<void> {
    const entry = { cancelled: false };
    this.inflight.set(call.callId, entry);
    let outcome: ToolOutcome;
    try {
      outcome = await this.options.onToolCall(call);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      outcome = {
        ok: false,
        error: {
          code: typeof code === 'string' ? code : 'TOOL_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.inflight.delete(call.callId);
    if (entry.cancelled) return;
    const reply = outcome.ok
      ? { type: 'tool_result', callId: call.callId, ok: true, result: outcome.result }
      : { type: 'tool_result', callId: call.callId, ok: false, error: outcome.error };
    if (!this.send(reply)) {
      console.warn(`[doogle] tool_result 를 보내지 못했습니다 (연결 끊김): ${call.name}`);
    }
  }
}

/** 브라우저 개발용 — URL `?hubPort=&hubToken=` */
export function endpointFromUrl(search: string = location.search): HubEndpoint | null {
  const params = new URLSearchParams(search);
  const port = Number(params.get('hubPort'));
  const token = params.get('hubToken');
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) return null;
  return { port, token };
}

/** 대화 스레드 id */
export function newThreadId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
