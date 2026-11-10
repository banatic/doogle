/**
 * 두글 에이전트 사이드바 — 오른쪽 도킹 패널(PluginHost.ui.registerSidePanel) 본문.
 *
 * 구성: provider/model 선택 · 모드(에이전트(검토)/전체) · 로그인 안내 · 대화(스트리밍) ·
 * 도구 칩 · 검토 대기 막대(모두 적용/모두 취소) · 입력/중지 · 설정(API 키).
 *
 * 모델 응답은 upstream `message-render.ts` 로만 그린다 — 이 파일은 HTML 문자열을 다루지 않는다.
 * CSS 접두어는 `dg-`.
 */
import { renderMarkdown } from '@/ai/ui/message-render';
import type { PendingApi } from '../agent/types.ts';
import {
  newThreadId,
  type AgentEvent,
  type AgentMode,
  type ChatContext,
  type HubClient,
  type HubConnectionState,
  type HubMessage,
  type ProviderInfo,
  type ToolCallMessage,
} from '../hub-client.ts';
import { describeToolCall } from './tool-presentation.ts';
import './sidebar.css';

export interface SidebarDeps {
  hub: HubClient;
  /** 실행기의 검토 대기 API. 실행기가 없으면 null — 검토 막대를 그리지 않는다. */
  pending: PendingApi | null;
  /** 보낼 때마다 부른다 — 선택 영역·문서 이름 */
  getContext(): ChatContext;
  openExternal(url: string): Promise<void>;
  /** 모드가 바뀌었을 때 (실행기가 다음 도구 호출부터 반영) */
  onModeChange?(mode: AgentMode): void;
}

const STORE_PROVIDER = 'doogle.provider';
const STORE_MODEL = 'doogle.model';
const STORE_MODE = 'doogle.mode';

const SECRET_KEYS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'anthropic-api-key', label: 'Anthropic API 키', placeholder: 'sk-ant-…' },
  { key: 'openai-api-key', label: 'OpenAI API 키', placeholder: 'sk-…' },
];

const CLAUDE_LOGIN_HINT = '터미널에서 claude 를 실행한 뒤 /login 으로 로그인하세요. 두글은 Claude 로그인 정보를 읽지 않습니다.';

function storeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 사생활 보호 모드 등 — 무시 */ }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  if (title) node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : '';
}

function formatResetAt(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '';
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface TurnView {
  root: HTMLElement;
  /** 지금 이어 쓰는 텍스트 블록 */
  text: { node: HTMLElement; raw: string } | null;
  /** 지금 이어 붙이는 도구 칩 줄 */
  chips: HTMLElement | null;
  status: HTMLElement;
}

export class DoogleSidebar {
  private readonly deps: SidebarDeps;
  private root: HTMLElement | null = null;
  private offs: Array<() => void> = [];

  private providers: ProviderInfo[] = [];
  private providerId = storeGet(STORE_PROVIDER) ?? '';
  private model = storeGet(STORE_MODEL) ?? '';
  private mode: AgentMode = storeGet(STORE_MODE) === 'full' ? 'full' : 'agent';
  private threadId = newThreadId();
  private busy = false;
  private turn: TurnView | null = null;
  private readonly chipsById = new Map<string, HTMLElement>();
  private loginPending: string | null = null;

  // 화면 부품
  private providerSelect!: HTMLSelectElement;
  private modelSelect!: HTMLSelectElement;
  private modeButtons: Record<AgentMode, HTMLButtonElement> = {} as Record<AgentMode, HTMLButtonElement>;
  private connBar!: HTMLElement;
  private authBox!: HTMLElement;
  private log!: HTMLElement;
  private empty!: HTMLElement;
  private reviewBar!: HTMLElement;
  private reviewCount!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private settings!: HTMLElement;
  private chat!: HTMLElement;

  constructor(deps: SidebarDeps) {
    this.deps = deps;
  }

  get state(): { busy: boolean; threadId: string; providerId: string; mode: AgentMode; providers: number } {
    return { busy: this.busy, threadId: this.threadId, providerId: this.providerId, mode: this.mode, providers: this.providers.length };
  }

  mount(container: HTMLElement): void {
    const root = el('div', 'dg-panel');
    this.root = root;
    root.append(this.buildHead(), this.buildConnBar(), this.buildAuthBox(), this.buildChat(), this.buildSettings());
    container.append(root);

    const hub = this.deps.hub;
    this.offs.push(
      hub.onState((state, detail) => this.renderConnection(state, detail)),
      hub.on('providers', (message) => this.setProviders((message as { list?: ProviderInfo[] }).list ?? [])),
      hub.on('agent_event', (message) => this.handleAgentEvent(message)),
      hub.on('auth_url', (message) => this.handleAuthUrl(message)),
      hub.on('auth_done', (message) => this.handleAuthDone(message)),
      hub.on('auth_logout_done', (message) => {
        const { ok, error } = message as { ok?: unknown; error?: unknown };
        this.addNotice(ok === true ? '로그아웃했습니다.' : `로그아웃 실패: ${errorText(error)}`, ok === true ? 'info' : 'error');
      }),
    );
    if (this.deps.pending) {
      this.offs.push(this.deps.pending.onChange(() => this.renderReview()));
    }
    this.renderConnection(hub.state, hub.detail);
    this.renderMode();
    this.renderReview();
    this.renderComposer();
  }

  setVisible(open: boolean): void {
    if (open) {
      if (this.deps.hub.state === 'open' && this.providers.length === 0) void this.refreshProviders();
      requestAnimationFrame(() => this.input?.focus());
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.root?.remove();
    this.root = null;
  }

  /** MCP 로 들어온 외부 에이전트의 도구 호출 — 대화에 따로 표시한다. */
  noteExternalTool(call: ToolCallMessage): void {
    if (call.origin !== 'mcp' || !this.log) return;
    const view = describeToolCall(call.name, call.args);
    const row = el('div', 'dg-msg dg-msg-external');
    row.append(el('span', 'dg-external-tag', '외부 에이전트'), this.makeChip(view.label, view.summary, view.category, 'done'));
    this.appendToLog(row);
  }

  openSettings(): void {
    this.toggleSettings(true);
  }

  // ─── 머리 ──────────────────────────────────────────────

  private buildHead(): HTMLElement {
    const head = el('div', 'dg-head');

    const pickers = el('div', 'dg-pickers');
    this.providerSelect = el('select', 'dg-select');
    this.providerSelect.title = 'AI 제공자';
    this.providerSelect.addEventListener('change', () => {
      this.providerId = this.providerSelect.value;
      storeSet(STORE_PROVIDER, this.providerId);
      this.model = '';
      this.renderModels();
      this.renderAuth();
      this.renderComposer();
    });
    this.modelSelect = el('select', 'dg-select');
    this.modelSelect.title = '모델';
    this.modelSelect.addEventListener('change', () => {
      this.model = this.modelSelect.value;
      storeSet(STORE_MODEL, this.model);
    });
    pickers.append(this.providerSelect, this.modelSelect);

    const row = el('div', 'dg-head-row');
    const modes = el('div', 'dg-mode');
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', '편집 모드');
    const makeMode = (mode: AgentMode, label: string, title: string) => {
      const b = button('dg-mode-btn', label, () => this.setMode(mode), title);
      b.setAttribute('role', 'radio');
      this.modeButtons[mode] = b;
      modes.append(b);
    };
    makeMode('agent', '에이전트(검토)', '편집을 바로 보여 주고, 턴이 끝나면 적용·취소를 고릅니다');
    makeMode('full', '전체', '편집을 바로 적용합니다 (편집 1회 = 되돌리기 1단계)');

    const tools = el('div', 'dg-head-tools');
    tools.append(
      button('dg-icon-btn', '새 대화', () => this.newThread(), '새 대화 시작'),
      button('dg-icon-btn', '설정', () => this.toggleSettings(), 'API 키·로그인 설정'),
    );
    row.append(modes, tools);
    head.append(pickers, row);
    return head;
  }

  private buildConnBar(): HTMLElement {
    this.connBar = el('div', 'dg-conn');
    this.connBar.hidden = true;
    return this.connBar;
  }

  private buildAuthBox(): HTMLElement {
    this.authBox = el('div', 'dg-auth');
    this.authBox.hidden = true;
    return this.authBox;
  }

  private buildChat(): HTMLElement {
    const chat = el('div', 'dg-chat');
    this.chat = chat;
    this.log = el('div', 'dg-log');
    this.log.setAttribute('aria-live', 'polite');
    this.empty = el('p', 'dg-empty', '문서에 대해 묻거나 고칠 내용을 적어 보세요. 에이전트(검토) 모드에서는 편집이 바로 보이고, 끝나면 적용할지 고릅니다.');
    this.log.append(this.empty);

    this.reviewBar = el('div', 'dg-review');
    this.reviewBar.hidden = true;
    this.reviewCount = el('span', 'dg-review-count');
    this.reviewBar.append(
      this.reviewCount,
      button('dg-btn dg-btn-primary', '모두 적용', () => this.decide('accept_all')),
      button('dg-btn', '모두 취소', () => this.decide('reject_all')),
    );

    const composer = el('div', 'dg-composer');
    this.input = el('textarea', 'dg-input');
    this.input.rows = 3;
    this.input.placeholder = '메시지 (Enter 보내기, Shift+Enter 줄바꿈)';
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => this.renderComposer());
    this.sendBtn = button('dg-btn dg-btn-primary dg-send', '보내기', () => (this.busy ? this.cancel() : this.submit()));
    composer.append(this.input, this.sendBtn);

    chat.append(this.log, this.reviewBar, composer);
    return chat;
  }

  private buildSettings(): HTMLElement {
    const box = el('div', 'dg-settings');
    box.hidden = true;
    box.append(el('h3', 'dg-settings-title', '설정'));

    for (const spec of SECRET_KEYS) {
      const field = el('div', 'dg-field');
      const label = el('label', 'dg-field-label', spec.label);
      const id = `dg-secret-${spec.key}`;
      label.htmlFor = id;
      const input = el('input', 'dg-field-input');
      input.id = id;
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = spec.placeholder;
      const note = el('span', 'dg-field-note');
      const save = button('dg-btn dg-btn-primary', '저장', () => void this.saveSecret(spec.key, input, note, false));
      const clear = button('dg-btn', '삭제', () => void this.saveSecret(spec.key, input, note, true));
      const row = el('div', 'dg-field-row');
      row.append(input, save, clear);
      field.append(label, row, note);
      box.append(field);
    }
    box.append(el('p', 'dg-hint', 'API 키는 OS 보안 저장소(keyring)에 저장되며 화면에 다시 표시되지 않습니다.'));

    const account = el('div', 'dg-field');
    account.append(el('div', 'dg-field-label', 'ChatGPT 계정'));
    const accountRow = el('div', 'dg-field-row');
    accountRow.append(
      button('dg-btn', 'ChatGPT로 로그인', () => this.startLogin('openai-siwc')),
      button('dg-btn', '로그아웃', () => {
        if (!this.deps.hub.logout('openai-siwc')) this.addNotice('agent hub 에 연결되어 있지 않습니다.', 'error');
      }),
    );
    account.append(accountRow);
    box.append(account);

    const claude = el('div', 'dg-field');
    claude.append(el('div', 'dg-field-label', 'Claude 구독'), el('p', 'dg-hint', CLAUDE_LOGIN_HINT));
    box.append(claude);

    box.append(button('dg-btn dg-settings-close', '닫기', () => this.toggleSettings(false)));
    this.settings = box;
    return box;
  }

  private toggleSettings(open?: boolean): void {
    const show = open ?? this.settings.hidden;
    this.settings.hidden = !show;
    this.chat.hidden = show;
  }

  private async saveSecret(key: string, input: HTMLInputElement, note: HTMLElement, clear: boolean): Promise<void> {
    const value = clear ? null : input.value.trim();
    if (!clear && !value) {
      note.textContent = '키를 입력하세요.';
      return;
    }
    note.textContent = '저장하는 중…';
    try {
      await this.deps.hub.setSecret(key, value);
      input.value = '';
      note.textContent = clear ? '삭제했습니다.' : '저장했습니다.';
      void this.refreshProviders();
    } catch (error) {
      note.textContent = `실패: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // ─── provider / 로그인 ─────────────────────────────────

  private async refreshProviders(): Promise<void> {
    try {
      this.setProviders(await this.deps.hub.queryProviders());
    } catch (error) {
      this.showAuth(`제공자 목록을 받지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private setProviders(list: ProviderInfo[]): void {
    this.providers = Array.isArray(list) ? list : [];
    if (!this.providers.some((p) => p.id === this.providerId)) {
      this.providerId = (this.providers.find((p) => p.available) ?? this.providers[0])?.id ?? '';
    }
    this.providerSelect.replaceChildren(...this.providers.map((p) => {
      const option = el('option', '', p.available ? p.label : `${p.label} (사용 불가)`);
      option.value = p.id;
      return option;
    }));
    this.providerSelect.value = this.providerId;
    this.providerSelect.disabled = this.providers.length === 0;
    this.renderModels();
    this.renderAuth();
    this.renderComposer();
  }

  private currentProvider(): ProviderInfo | undefined {
    return this.providers.find((p) => p.id === this.providerId);
  }

  private renderModels(): void {
    const provider = this.currentProvider();
    const models = provider?.models ?? [];
    if (!models.some((m) => m.id === this.model)) this.model = models[0]?.id ?? '';
    this.modelSelect.replaceChildren(...models.map((m) => {
      const option = el('option', '', m.label);
      option.value = m.id;
      return option;
    }));
    this.modelSelect.value = this.model;
    this.modelSelect.hidden = models.length === 0;
  }

  private renderAuth(): void {
    const provider = this.currentProvider();
    if (!provider || provider.available) {
      this.authBox.hidden = true;
      this.authBox.replaceChildren();
      return;
    }
    const parts: HTMLElement[] = [];
    if (provider.reason) parts.push(el('p', 'dg-auth-reason', provider.reason));
    if (provider.id === 'claude-sdk') {
      // 정책: 두글은 Claude 로그인 UI 를 두지 않는다 — 사용자가 터미널에서 직접 로그인한다.
      parts.push(el('p', 'dg-auth-hint', provider.authHint || CLAUDE_LOGIN_HINT));
    } else if (provider.id === 'openai-siwc') {
      if (provider.authHint) parts.push(el('p', 'dg-auth-hint', provider.authHint));
      if (this.loginPending === provider.id) {
        parts.push(el('p', 'dg-auth-hint', '브라우저에서 로그인을 마치세요…'));
        parts.push(button('dg-btn', '로그인 취소', () => {
          this.deps.hub.cancelLogin(provider.id);
          this.loginPending = null;
          this.renderAuth();
        }));
      } else {
        parts.push(button('dg-btn dg-btn-primary', 'ChatGPT로 로그인', () => this.startLogin(provider.id)));
      }
    } else if (provider.id === 'anthropic-api' || provider.id === 'openai-api') {
      if (provider.authHint) parts.push(el('p', 'dg-auth-hint', provider.authHint));
      parts.push(button('dg-btn', 'API 키 설정', () => this.toggleSettings(true)));
    } else if (provider.authHint) {
      parts.push(el('p', 'dg-auth-hint', provider.authHint));
    }
    this.authBox.replaceChildren(...parts);
    this.authBox.hidden = parts.length === 0;
  }

  private showAuth(text: string): void {
    this.authBox.replaceChildren(el('p', 'dg-auth-reason', text));
    this.authBox.hidden = false;
  }

  private startLogin(providerId: string): void {
    if (!this.deps.hub.startLogin(providerId)) {
      this.showAuth('agent hub 에 연결되어 있지 않아 로그인을 시작할 수 없습니다.');
      return;
    }
    this.loginPending = providerId;
    this.renderAuth();
  }

  private handleAuthUrl(message: HubMessage): void {
    const { url, providerId } = message as { url?: unknown; providerId?: unknown };
    if (typeof url !== 'string') return;
    this.loginPending = typeof providerId === 'string' ? providerId : this.loginPending;
    this.renderAuth();
    this.deps.openExternal(url).catch((error) => {
      this.showAuth(`브라우저를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private handleAuthDone(message: HubMessage): void {
    const { ok, error } = message as { ok?: unknown; error?: unknown };
    this.loginPending = null;
    if (ok === true) {
      this.addNotice('로그인했습니다.', 'info');
    } else {
      this.addNotice(`로그인 실패: ${errorText(error) || '로그인하지 못했습니다'}`, 'error');
    }
    this.renderAuth();
    // hub 가 새 providers 를 보내지만, 놓쳤을 때를 대비해 한 번 더 묻는다.
    void this.refreshProviders();
  }

  // ─── 연결 / 모드 / 입력 ────────────────────────────────

  private renderConnection(state: HubConnectionState, detail: string): void {
    if (!this.connBar) return;
    const text: Record<HubConnectionState, string> = {
      open: '',
      connecting: 'agent hub 에 연결하는 중…',
      retrying: `agent hub 에 다시 연결하는 중…${detail ? ` (${detail})` : ''}`,
      unavailable: `agent hub 를 쓸 수 없습니다${detail ? `: ${detail}` : ''}`,
      stopped: 'agent hub 연결을 닫았습니다',
    };
    this.connBar.textContent = text[state];
    this.connBar.hidden = state === 'open';
    this.connBar.dataset.state = state;
    if (state === 'open') void this.refreshProviders();
    if (state !== 'open' && this.busy) {
      this.addNotice('연결이 끊겨 응답을 더 받지 못했습니다.', 'error');
      this.endTurn();
    }
    this.renderComposer();
  }

  private setMode(mode: AgentMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    storeSet(STORE_MODE, mode);
    this.renderMode();
    this.deps.onModeChange?.(mode);
  }

  private renderMode(): void {
    for (const mode of ['agent', 'full'] as const) {
      const b = this.modeButtons[mode];
      const on = this.mode === mode;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('dg-on', on);
      b.disabled = this.busy;
    }
  }

  private renderComposer(): void {
    if (!this.sendBtn) return;
    const provider = this.currentProvider();
    const ready = this.deps.hub.state === 'open' && !!provider?.available;
    this.sendBtn.textContent = this.busy ? '중지' : '보내기';
    this.sendBtn.classList.toggle('dg-btn-danger', this.busy);
    this.sendBtn.disabled = !this.busy && (!ready || this.input.value.trim() === '');
    this.input.disabled = false;
    this.providerSelect.disabled = this.busy || this.providers.length === 0;
    this.modelSelect.disabled = this.busy;
  }

  private newThread(): void {
    if (this.busy) this.cancel();
    this.threadId = newThreadId();
    this.turn = null;
    this.chipsById.clear();
    this.log.replaceChildren(this.empty);
    this.empty.hidden = false;
    this.renderReview();
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    const provider = this.currentProvider();
    if (!provider?.available) {
      this.addNotice('사용할 수 있는 AI 제공자를 고르세요.', 'error');
      return;
    }
    const sent = this.deps.hub.sendChat({
      threadId: this.threadId,
      providerId: provider.id,
      ...(this.model ? { model: this.model } : {}),
      text,
      mode: this.mode,
      context: this.deps.getContext(),
    });
    if (!sent) {
      this.addNotice('agent hub 에 연결되어 있지 않습니다.', 'error');
      return;
    }
    this.input.value = '';
    const user = el('div', 'dg-msg dg-msg-user', text);
    this.appendToLog(user);
    this.startTurn();
  }

  private cancel(): void {
    if (!this.busy) return;
    this.deps.hub.cancelChat(this.threadId);
    if (this.turn) this.turn.status.textContent = '중지하는 중…';
  }

  // ─── 대화 ──────────────────────────────────────────────

  private appendToLog(node: HTMLElement): void {
    this.empty.hidden = true;
    const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 48;
    this.log.append(node);
    if (nearBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private addNotice(text: string, kind: 'info' | 'error' | 'limit'): void {
    if (!this.log) return;
    const node = el('div', `dg-notice dg-notice-${kind}`, text);
    if (this.turn) {
      this.turn.root.insertBefore(node, this.turn.status);
      this.turn.text = null;
      this.turn.chips = null;
    } else {
      this.appendToLog(node);
    }
  }

  private startTurn(): void {
    const root = el('div', 'dg-msg dg-msg-assistant');
    const status = el('div', 'dg-status', '생각하는 중…');
    root.append(status);
    this.turn = { root, text: null, chips: null, status };
    this.appendToLog(root);
    this.busy = true;
    this.renderMode();
    this.renderComposer();
  }

  private endTurn(): void {
    if (this.turn) {
      this.flushText();
      this.turn.status.remove();
    }
    this.turn = null;
    this.busy = false;
    this.renderMode();
    this.renderComposer();
    this.renderReview();
  }

  private ensureTurn(): TurnView {
    if (!this.turn) this.startTurn();
    return this.turn!;
  }

  private flushText(): void {
    const turn = this.turn;
    if (!turn?.text) return;
    renderMarkdown(turn.text.node, turn.text.raw);
    turn.text.node.classList.remove('dg-streaming');
  }

  private handleAgentEvent(message: HubMessage): void {
    const { threadId, event } = message as { threadId?: string; event?: AgentEvent };
    if (threadId !== this.threadId || !event) return;
    const scroll = () => {
      const nearBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 96;
      if (nearBottom) this.log.scrollTop = this.log.scrollHeight;
    };
    switch (event.kind) {
      case 'status': {
        this.ensureTurn().status.textContent = event.text;
        break;
      }
      case 'text_delta': {
        const turn = this.ensureTurn();
        if (!turn.text) {
          const node = el('div', 'dg-msg-body dg-streaming');
          turn.root.insertBefore(node, turn.status);
          turn.text = { node, raw: '' };
          turn.chips = null;
        }
        turn.text.raw += event.text;
        turn.text.node.textContent = turn.text.raw;
        turn.status.textContent = '';
        scroll();
        break;
      }
      case 'text_done': {
        this.flushText();
        if (this.turn) this.turn.text = null;
        break;
      }
      case 'tool_use': {
        const turn = this.ensureTurn();
        this.flushText();
        turn.text = null;
        if (!turn.chips) {
          turn.chips = el('div', 'dg-chips');
          turn.root.insertBefore(turn.chips, turn.status);
        }
        const view = describeToolCall(event.name, event.args);
        const chip = this.makeChip(view.label, view.summary, view.category, 'running');
        this.chipsById.set(event.callId, chip);
        turn.chips.append(chip);
        turn.status.textContent = `${view.label}…`;
        scroll();
        break;
      }
      case 'tool_result': {
        const chip = this.chipsById.get(event.callId);
        if (chip) {
          chip.dataset.state = event.ok ? 'done' : 'error';
          if (event.summary) chip.title = `${chip.title ? `${chip.title}\n` : ''}${event.summary}`;
        }
        if (this.turn) this.turn.status.textContent = '';
        this.renderReview();
        break;
      }
      case 'usage': {
        const parts = [
          event.inputTokens !== undefined ? `입력 ${event.inputTokens.toLocaleString()}` : '',
          event.outputTokens !== undefined ? `출력 ${event.outputTokens.toLocaleString()}` : '',
        ].filter(Boolean);
        if (parts.length && this.turn) this.turn.root.dataset.usage = `토큰 ${parts.join(' · ')}`;
        break;
      }
      case 'limit': {
        const reset = formatResetAt(event.resetAt);
        this.addNotice(`${event.message}${reset ? ` — ${reset}에 다시 쓸 수 있습니다` : ''}`, 'limit');
        break;
      }
      case 'error': {
        this.addNotice(event.message || event.code, 'error');
        break;
      }
      case 'turn_end': {
        if (event.reason === 'cancelled') this.addNotice('중지했습니다.', 'info');
        this.endTurn();
        break;
      }
      default:
        break;
    }
  }

  private makeChip(label: string, summary: string, category: string, state: 'running' | 'done' | 'error'): HTMLElement {
    const chip = el('span', 'dg-chip');
    chip.dataset.state = state;
    chip.dataset.category = category;
    chip.append(el('span', 'dg-chip-label', label));
    if (summary) {
      chip.append(el('span', 'dg-chip-summary', summary));
      chip.title = summary;
    }
    return chip;
  }

  // ─── 검토 ──────────────────────────────────────────────

  private renderReview(): void {
    const pending = this.deps.pending;
    if (!pending || !this.reviewBar) return;
    const list = pending.list();
    if (list.length === 0) {
      this.reviewBar.hidden = true;
      return;
    }
    const foreign = list.some((entry) => entry.threadId !== this.threadId);
    this.reviewCount.textContent = `검토 대기 ${list.length}건${foreign ? ' (다른 대화)' : ''}`;
    this.reviewBar.hidden = false;
    for (const b of this.reviewBar.querySelectorAll('button')) b.disabled = this.busy;
  }

  private decide(decision: 'accept_all' | 'reject_all'): void {
    const pending = this.deps.pending;
    if (!pending || this.busy) return;
    const threads = [...new Set(pending.list().map((entry) => entry.threadId).filter(Boolean))];
    try {
      if (decision === 'accept_all') {
        const { accepted } = pending.acceptAll();
        this.addNotice(`편집 ${accepted}건을 적용했습니다.`, 'info');
      } else {
        const { rejected, userEditsReverted } = pending.rejectAll();
        this.addNotice(
          `편집 ${rejected}건을 취소했습니다.${userEditsReverted ? ' 그 사이 직접 고친 내용도 함께 되돌아갔습니다.' : ''}`,
          'info',
        );
      }
    } catch (error) {
      this.addNotice(`검토 처리 실패: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
    for (const threadId of threads) this.deps.hub.reviewDecision(threadId, decision);
    this.renderReview();
  }
}
