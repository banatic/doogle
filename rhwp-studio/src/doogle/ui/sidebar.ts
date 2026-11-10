/**
 * 두글 에이전트 사이드바 (시안 F) — 오른쪽 도킹 패널(PluginHost.ui.registerSidePanel) 본문.
 *
 * 구성: 머리(대화 제목 ▾ · 대화 기록 · 새 대화 · 닫기) · 대화(사용자 말풍선 / 에이전트 산문,
 * 턴마다 도구 칩 하나, 검토할 변경 목록, 메시지 동작) · 입력 상자(첨부 · 검토 후 적용/바로 적용 ·
 * 모델 고르기 · 보내기/중지).
 *
 * 모델 응답은 upstream `message-render.ts` 로만 그린다 — 이 파일은 HTML 문자열을 다루지 않는다.
 * 검토 상태(지금 보는 변경·행 단위 결정)는 `../review/state.ts` 를 문서 위 검토 막과 함께 쓴다.
 * CSS 접두어는 `dg-`.
 */
import { renderMarkdown } from '@/ai/ui/message-render';
import type { PendingApi, PendingChangeEvent } from '../agent/types.ts';
import {
  newThreadId,
  type AgentEvent,
  type AgentMode,
  type ChatContext,
  type HubClient,
  type HubConnectionState,
  type HubMessage,
  type ProviderInfo,
  type ProviderModel,
  type ToolCallMessage,
} from '../hub-client.ts';
import { describeChange } from '../review/describe.ts';
import { reviewStore, type DecisionReport } from '../review/state.ts';
import { icon, type IconName } from './icons.ts';
import { describeToolCall } from './tool-presentation.ts';
import './sidebar.css';

export interface SidebarDeps {
  hub: HubClient;
  /** 실행기의 검토 대기 API. 실행기가 없으면 null — 검토 목록을 그리지 않는다. */
  pending: PendingApi | null;
  /** 보낼 때마다 부른다 — 선택 영역·문서 이름 */
  getContext(): ChatContext;
  openExternal(url: string): Promise<void>;
  /** 모드가 바뀌었을 때 (실행기가 다음 도구 호출부터 반영) */
  onModeChange?(mode: AgentMode): void;
}

const STORE_PROVIDER = 'doogle.provider';
/** 예전 단일 키 — provider별 키(`doogle.model.<id>`)가 없을 때 한 번 읽는다. */
const STORE_MODEL_LEGACY = 'doogle.model';
const STORE_MODEL_PREFIX = 'doogle.model.';
/** 목록을 받기 전에도 버튼에 보일 마지막 모델 이름 */
const STORE_MODEL_LABEL = 'doogle.modelLabel';
const STORE_MODE = 'doogle.mode';

/** API 키로 쓰는 provider → keyring 키 */
const SECRET_KEY_OF: Record<string, { key: string; placeholder: string }> = {
  'anthropic-api': { key: 'anthropic-api-key', placeholder: 'sk-ant-…' },
  'openai-api': { key: 'openai-api-key', placeholder: 'sk-…' },
};

const CLAUDE_LOGIN_HINT = '터미널에서 claude 를 실행한 뒤 /login 으로 로그인하세요. 두글은 Claude 로그인 정보를 읽지 않습니다.';

const SUGGESTIONS = ['이 문서를 세 줄로 요약해 줘', '맞춤법과 띄어쓰기를 고쳐 줘', '선택한 문단을 더 간결하게 다듬어 줘'];

function storeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 사생활 보호 모드 등 — 무시 */ }
}

/** 버튼·메뉴에 보일 모델 이름. 'default' 행은 실제 모델 이름을 덧붙인다 (예: "기본 · Opus 5.5"). */
function modelDisplayName(model: ProviderModel, models: readonly ProviderModel[]): string {
  if (model.id === 'default' && model.resolvedModel) {
    const target = models.find((m) => m !== model && (m.id === model.resolvedModel || m.resolvedModel === model.resolvedModel));
    return `기본 · ${target?.label ?? model.resolvedModel}`;
  }
  return model.label || model.id;
}

/** "목록 갱신: n분 전" / "기본 목록" */
function modelsFreshnessNote(provider: ProviderInfo, now = Date.now()): string {
  const source = provider.models[0]?.source;
  if (source === 'fallback' || (!provider.modelsUpdatedAt && source !== 'live')) {
    return provider.modelsError ? '기본 목록 (실시간 목록을 받지 못함)' : '기본 목록';
  }
  if (!provider.modelsUpdatedAt) return '';
  const at = Date.parse(provider.modelsUpdatedAt);
  if (!Number.isFinite(at)) return '';
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  const ago = min < 1 ? '방금' : min < 60 ? `${min}분 전` : min < 48 * 60 ? `${Math.floor(min / 60)}시간 전` : `${Math.floor(min / 1440)}일 전`;
  return `목록 갱신: ${ago}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function iconButton(className: string, name: IconName, ariaLabel: string, onClick: (event: MouseEvent) => void, size = 16): HTMLButtonElement {
  const node = button(className, '', onClick);
  node.setAttribute('aria-label', ariaLabel);
  node.title = ariaLabel;
  node.append(icon(name, size));
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

function clipTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 28 ? `${flat.slice(0, 27)}…` : flat || '새 대화';
}

interface ToolEntry {
  li: HTMLLIElement;
  label: string;
}

interface TurnView {
  threadId: string;
  root: HTMLElement;
  userText: string;
  /** 도구 칩 (턴당 하나) */
  chip: HTMLButtonElement | null;
  chipText: HTMLElement | null;
  toolList: HTMLUListElement | null;
  tools: Map<string, ToolEntry>;
  /** 지금 이어 쓰는 산문 블록 */
  text: { node: HTMLElement; raw: string } | null;
  /** 턴의 산문 전체 (복사용) */
  prose: string[];
  thinking: HTMLElement | null;
  actions: HTMLElement | null;
  /** 이 턴이 만든 검토 변경 id */
  changeIds: Set<string>;
  done: boolean;
}

interface ThreadView {
  id: string;
  title: string;
  log: HTMLElement;
  turns: TurnView[];
  createdAt: number;
}

type MenuKind = 'threads' | 'model';

export class DoogleSidebar {
  private readonly deps: SidebarDeps;
  private root: HTMLElement | null = null;
  private offs: Array<() => void> = [];

  private providers: ProviderInfo[] = [];
  private providerId = storeGet(STORE_PROVIDER) ?? '';
  private model = storeGet(`${STORE_MODEL_PREFIX}${storeGet(STORE_PROVIDER) ?? ''}`) ?? storeGet(STORE_MODEL_LEGACY) ?? '';
  /** models_refresh 를 보내고 새 목록을 기다리는 provider */
  private readonly refreshingModels = new Set<string>();
  private mode: AgentMode = storeGet(STORE_MODE) === 'full' ? 'full' : 'agent';
  private busy = false;
  private turn: TurnView | null = null;
  private loginPending: string | null = null;
  private readonly threads = new Map<string, ThreadView>();
  private thread!: ThreadView;
  private readonly changeTurn = new Map<string, TurnView>();
  private renderFrame = 0;
  private openMenuKind: MenuKind | null = null;
  private menuTrigger: HTMLElement | null = null;
  /** 모델 메뉴 안에서 펼친 API 키 입력 (provider id) */
  private keyFormFor: string | null = null;
  private keyNote = '';

  // 화면 부품
  private titleBtn!: HTMLButtonElement;
  private titleText!: HTMLElement;
  private historyBtn!: HTMLButtonElement;
  private threadMenu!: HTMLElement;
  private conn!: HTMLElement;
  private scroller!: HTMLElement;
  private review!: HTMLElement;
  private live!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private modeBtn!: HTMLButtonElement;
  private modelBtn!: HTMLButtonElement;
  private modelText!: HTMLElement;
  private modelMenu!: HTMLElement;
  private sendBtn!: HTMLButtonElement;

  constructor(deps: SidebarDeps) {
    this.deps = deps;
    this.thread = this.createThread();
  }

  get state(): { busy: boolean; threadId: string; providerId: string; mode: AgentMode; providers: number } {
    return { busy: this.busy, threadId: this.thread.id, providerId: this.providerId, mode: this.mode, providers: this.providers.length };
  }

  mount(container: HTMLElement): void {
    const root = el('div', 'dg-panel');
    this.root = root;
    root.append(this.buildHead(), this.buildBody(), this.buildComposer());
    container.append(root);
    this.showThread(this.thread);

    root.addEventListener('keydown', (event) => this.onPanelKey(event));
    const onDocPointer = (event: PointerEvent) => {
      if (!this.openMenuKind) return;
      const menu = this.openMenuKind === 'threads' ? this.threadMenu : this.modelMenu;
      const target = event.target as Node;
      if (!menu.contains(target) && !this.menuTrigger?.contains(target)) this.closeMenu(false);
    };
    document.addEventListener('pointerdown', onDocPointer, true);
    this.offs.push(() => document.removeEventListener('pointerdown', onDocPointer, true));

    const hub = this.deps.hub;
    this.offs.push(
      hub.onState((state, detail) => this.renderConnection(state, detail)),
      hub.on('providers', (message) => this.setProviders((message as { list?: ProviderInfo[] }).list ?? [])),
      hub.on('agent_event', (message) => this.handleAgentEvent(message)),
      hub.on('auth_url', (message) => this.handleAuthUrl(message)),
      hub.on('auth_done', (message) => this.handleAuthDone(message)),
      hub.on('auth_logout_done', (message) => {
        const { ok, error } = message as { ok?: unknown; error?: unknown };
        this.addNotice(ok === true ? '로그아웃했습니다.' : `로그아웃하지 못했습니다: ${errorText(error)}`, ok === true ? 'info' : 'error');
      }),
    );
    if (this.deps.pending) {
      // 실행기가 있으면 검토 막(runtime-wiring)이 이미 붙였다. 없을 때를 대비해 여기서도 붙인다.
      if (!reviewStore.pending) reviewStore.attach(this.deps.pending);
      this.offs.push(this.deps.pending.onChange((e) => this.onPendingChange(e)));
    }
    this.offs.push(
      reviewStore.onChange(() => this.renderReview()),
      reviewStore.onDecision((report) => this.onDecision(report)),
      reviewStore.onExplain((id) => this.explain(id)),
    );
    this.renderConnection(hub.state, hub.detail);
    this.renderMode();
    this.renderModelButton();
    this.renderReview();
    this.renderComposer();
  }

  setVisible(open: boolean): void {
    if (open) {
      if (this.deps.hub.state === 'open' && this.providers.length === 0) void this.refreshProviders();
      requestAnimationFrame(() => this.input?.focus());
    } else {
      this.closeMenu(false);
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    this.root?.remove();
    this.root = null;
  }

  /** MCP 로 들어온 외부 에이전트의 도구 호출 — 대화에 조용한 한 줄로 남긴다. */
  noteExternalTool(call: ToolCallMessage): void {
    if (call.origin !== 'mcp' || !this.scroller) return;
    const view = describeToolCall(call.name, call.args);
    const row = el('div', 'dg-notice dg-notice-external');
    row.append(icon('tool', 13), el('span', '', `외부 에이전트 · ${view.label}${view.summary ? ` · ${view.summary}` : ''}`));
    this.appendToLog(row);
  }

  /** (호환) 예전 설정 화면 — 이제 모델 메뉴가 로그인·API 키를 맡는다. */
  openSettings(): void {
    this.openMenu('model', this.modelBtn);
  }

  // ─── 머리 ──────────────────────────────────────────────

  private buildHead(): HTMLElement {
    const head = el('header', 'dg-head');
    this.titleBtn = button('dg-title', '', () => this.toggleMenu('threads', this.titleBtn));
    this.titleBtn.setAttribute('aria-haspopup', 'menu');
    this.titleBtn.setAttribute('aria-expanded', 'false');
    this.titleText = el('span', 'dg-title-text', '새 대화');
    this.titleBtn.append(this.titleText, icon('chevronDown', 12, 2));

    this.historyBtn = iconButton('dg-icon-btn', 'history', '대화 기록', () => this.toggleMenu('threads', this.historyBtn), 17);
    this.historyBtn.setAttribute('aria-haspopup', 'menu');
    this.historyBtn.setAttribute('aria-expanded', 'false');

    this.threadMenu = el('div', 'dg-menu dg-thread-menu');
    this.threadMenu.setAttribute('role', 'menu');
    this.threadMenu.setAttribute('aria-label', '대화 목록');
    this.threadMenu.hidden = true;

    head.append(
      this.titleBtn,
      el('div', 'dg-grow'),
      this.historyBtn,
      iconButton('dg-icon-btn', 'compose', '새 대화', () => this.newThread(), 17),
      iconButton('dg-icon-btn', 'close', '패널 닫기', () => this.closePanel(), 15),
      this.threadMenu,
    );
    return head;
  }

  private closePanel(): void {
    // 패널 껍데기(side-panel-host)의 닫기 단추를 누른다 — 호스트 상태와 포커스 복귀를 그쪽이 맡는다.
    let node: HTMLElement | null = this.root;
    while (node) {
      const close = node.querySelector<HTMLButtonElement>(':scope > .spl-header .spl-close');
      if (close) {
        close.click();
        return;
      }
      node = node.parentElement;
    }
  }

  private renderThreadMenu(): void {
    const items: HTMLElement[] = [];
    const fresh = button('dg-menu-item', '', () => { this.closeMenu(true); this.newThread(); });
    fresh.setAttribute('role', 'menuitem');
    fresh.append(icon('compose', 14), el('span', '', '새 대화'));
    items.push(fresh);
    const list = [...this.threads.values()].filter((t) => t.turns.length > 0 || t === this.thread)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 12);
    if (list.length > 0) {
      items.push(el('div', 'dg-menu-heading', '최근 대화'));
      for (const t of list) {
        const item = button('dg-menu-item', '', () => {
          this.closeMenu(true);
          this.switchThread(t.id);
        });
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(t === this.thread));
        item.disabled = this.busy && t !== this.thread;
        item.append(el('span', 'dg-menu-check', t === this.thread ? '✓' : ''), el('span', 'dg-menu-label', t.title));
        items.push(item);
      }
    }
    this.threadMenu.replaceChildren(...items);
  }

  // ─── 메뉴 공통 ─────────────────────────────────────────

  private toggleMenu(kind: MenuKind, trigger: HTMLElement): void {
    if (this.openMenuKind === kind && this.menuTrigger === trigger) this.closeMenu(true);
    else this.openMenu(kind, trigger);
  }

  private openMenu(kind: MenuKind, trigger: HTMLElement): void {
    this.closeMenu(false);
    this.openMenuKind = kind;
    this.menuTrigger = trigger;
    const menu = kind === 'threads' ? this.threadMenu : this.modelMenu;
    if (kind === 'threads') this.renderThreadMenu();
    else this.renderModelMenu();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      const current = menu.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)');
      (current ?? this.menuItems(menu)[0])?.focus();
    });
  }

  private closeMenu(restoreFocus: boolean): void {
    if (!this.openMenuKind) return;
    const menu = this.openMenuKind === 'threads' ? this.threadMenu : this.modelMenu;
    menu.hidden = true;
    this.menuTrigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.menuTrigger?.focus();
    this.openMenuKind = null;
    this.menuTrigger = null;
    this.keyFormFor = null;
  }

  private menuItems(menu: HTMLElement): HTMLElement[] {
    return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), input')];
  }

  private onPanelKey(event: KeyboardEvent): void {
    if (this.openMenuKind) {
      const menu = this.openMenuKind === 'threads' ? this.threadMenu : this.modelMenu;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu(true);
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menu.contains(event.target as Node)) {
        const items = this.menuItems(menu);
        if (items.length === 0) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next].focus();
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && reviewStore.count > 0) {
      event.preventDefault();
      this.decideAll('accept');
    }
  }

  // ─── 본문 ──────────────────────────────────────────────

  private buildBody(): HTMLElement {
    const body = el('div', 'dg-body');
    this.conn = el('div', 'dg-conn');
    this.conn.hidden = true;
    this.conn.setAttribute('role', 'status');
    this.scroller = el('div', 'dg-scroll');
    this.scroller.setAttribute('role', 'log');
    this.scroller.setAttribute('aria-label', '대화');

    this.review = el('section', 'dg-review');
    this.review.setAttribute('aria-label', '검토할 변경');
    this.review.hidden = true;

    this.live = el('div', 'dg-sr-only');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('aria-atomic', 'true');

    body.append(this.conn, this.scroller, this.live);
    return body;
  }

  private createThread(): ThreadView {
    const log = el('div', 'dg-log');
    const view: ThreadView = { id: newThreadId(), title: '새 대화', log, turns: [], createdAt: Date.now() };
    log.append(this.buildEmpty());
    this.threads.set(view.id, view);
    return view;
  }

  private buildEmpty(): HTMLElement {
    const box = el('div', 'dg-empty');
    box.append(el('p', 'dg-empty-title', '무엇을 도와드릴까요?'), el('p', 'dg-empty-sub', '열린 문서를 읽고, 고칠 곳은 검토할 수 있게 제안해요.'));
    const chips = el('div', 'dg-suggest');
    for (const text of SUGGESTIONS) {
      chips.append(button('dg-suggest-chip', text, () => {
        this.input.value = text;
        this.renderComposer();
        if (!this.sendBtn.disabled) this.submit();
        else this.input.focus();
      }));
    }
    box.append(chips);
    return box;
  }

  private showThread(view: ThreadView): void {
    this.thread = view;
    this.scroller?.replaceChildren(view.log);
    if (this.titleText) this.titleText.textContent = view.title;
    if (this.titleBtn) this.titleBtn.setAttribute('aria-label', `대화: ${view.title}`);
    this.renderReview();
  }

  private newThread(): void {
    if (this.busy) this.cancel();
    if (this.thread.turns.length === 0) {
      this.input?.focus();
      return;
    }
    this.turn = null;
    this.showThread(this.createThread());
    this.input?.focus();
  }

  private switchThread(id: string): void {
    const view = this.threads.get(id);
    if (!view || view === this.thread || this.busy) return;
    this.turn = null;
    this.showThread(view);
  }

  private appendToLog(node: HTMLElement): void {
    const nearBottom = this.isNearBottom();
    this.thread.log.querySelector(':scope > .dg-empty')?.remove();
    this.thread.log.append(node);
    if (nearBottom) this.scrollToBottom();
  }

  private isNearBottom(): boolean {
    const s = this.scroller;
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 96;
  }

  private scrollToBottom(): void {
    if (this.scroller) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private announce(text: string): void {
    if (!this.live) return;
    this.live.textContent = '';
    requestAnimationFrame(() => { this.live.textContent = text; });
  }

  private addNotice(text: string, kind: 'info' | 'error' | 'limit'): void {
    if (!this.scroller) return;
    const node = el('div', `dg-notice dg-notice-${kind}`);
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    if (kind !== 'info') node.append(icon('alert', 13));
    node.append(el('span', '', text));
    const turn = this.turn;
    if (turn && !turn.done) {
      turn.root.insertBefore(node, turn.thinking ?? null);
      turn.text = null;
    } else {
      this.appendToLog(node);
    }
  }

  // ─── 연결 / provider / 로그인 ──────────────────────────

  private renderConnection(state: HubConnectionState, detail: string): void {
    if (!this.conn) return;
    const text: Record<HubConnectionState, string> = {
      open: '',
      connecting: 'agent hub 에 연결하는 중…',
      retrying: `agent hub 에 다시 연결하는 중…${detail ? ` (${detail})` : ''}`,
      unavailable: `agent hub 를 쓸 수 없습니다${detail ? `: ${detail}` : ''}`,
      stopped: 'agent hub 연결을 닫았습니다',
    };
    this.conn.textContent = text[state];
    this.conn.hidden = state === 'open';
    this.conn.dataset.state = state;
    if (state === 'open') void this.refreshProviders();
    this.renderModelButton();
    if (state !== 'open' && this.busy) {
      this.addNotice('연결이 끊겨 응답을 더 받지 못했습니다.', 'error');
      this.endTurn();
    }
    this.renderComposer();
  }

  private async refreshProviders(): Promise<void> {
    try {
      this.setProviders(await this.deps.hub.queryProviders());
    } catch (error) {
      this.conn.textContent = `모델 목록을 받지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      this.conn.hidden = false;
    }
  }

  private setProviders(list: ProviderInfo[]): void {
    this.providers = Array.isArray(list) ? list.map((p) => ({ ...p, models: Array.isArray(p.models) ? p.models : [] })) : [];
    this.refreshingModels.clear();
    const current = this.providers.find((p) => p.id === this.providerId);
    if (!current || (!current.available && this.providers.some((p) => p.available))) {
      const pick = this.providers.find((p) => p.available) ?? this.providers[0];
      if (pick && pick.id !== this.providerId) {
        this.providerId = pick.id;
        this.model = storeGet(`${STORE_MODEL_PREFIX}${pick.id}`) ?? '';
      }
    }
    this.normalizeModel();
    this.renderModelButton();
    if (this.openMenuKind === 'model') this.renderModelMenu();
    this.renderComposer();
  }

  private currentProvider(): ProviderInfo | undefined {
    return this.providers.find((p) => p.id === this.providerId);
  }

  /** 저장된 선택을 현재 목록으로 검증: 저장값 → provider defaultModel → 첫 항목 */
  private normalizeModel(): void {
    const provider = this.currentProvider();
    if (!provider) return; // 목록을 받기 전 — 저장값을 그대로 둔다
    const models = provider.models;
    const has = (id: string | null | undefined): id is string => !!id && models.some((m) => m.id === id);
    if (has(this.model)) return;
    const stored = storeGet(`${STORE_MODEL_PREFIX}${provider.id}`);
    this.model = has(stored) ? stored : has(provider.defaultModel) ? provider.defaultModel : models[0]?.id ?? '';
  }

  private selectModel(providerId: string, modelId: string): void {
    this.providerId = providerId;
    this.model = modelId;
    storeSet(STORE_PROVIDER, providerId);
    storeSet(`${STORE_MODEL_PREFIX}${providerId}`, modelId);
    this.renderModelButton();
    this.renderComposer();
  }

  private requestModelRefresh(providerId: string): void {
    if (!this.deps.hub.refreshModels(providerId)) {
      this.addNotice('agent hub 에 연결되어 있지 않습니다.', 'error');
      return;
    }
    this.refreshingModels.add(providerId);
    if (this.openMenuKind === 'model') this.renderModelMenu();
  }

  /** 버튼 글자: 고른 모델 이름. 목록 전에는 마지막으로 본 이름, 그것도 없으면 상태 안내. */
  private renderModelButton(): void {
    if (!this.modelText) return;
    const provider = this.currentProvider();
    const model = provider?.models.find((m) => m.id === this.model);
    let label: string;
    if (model && provider) {
      label = modelDisplayName(model, provider.models);
      storeSet(STORE_MODEL_LABEL, label);
    } else if (provider) {
      label = provider.available ? '모델 고르기' : `${provider.label} · 사용 불가`;
    } else {
      label = storeGet(STORE_MODEL_LABEL) || (this.deps.hub.state === 'open' ? '모델 불러오는 중…' : '연결 대기 중');
    }
    this.modelText.textContent = label;
    const title = provider ? `${provider.label} · ${label}${provider.available ? '' : ' (사용 불가)'}` : label;
    this.modelBtn.title = title;
    this.modelBtn.setAttribute('aria-label', `모델: ${title}`);
    this.modelBtn.classList.toggle('dg-warn', !!provider && !provider.available);
  }

  private renderModelMenu(): void {
    const parts: HTMLElement[] = [];
    if (this.providers.length === 0) {
      parts.push(el('p', 'dg-menu-hint', this.deps.hub.state === 'open' ? '모델 목록을 받는 중…' : 'agent hub 에 연결되면 모델을 고를 수 있습니다.'));
    }
    for (const provider of this.providers) {
      const group = el('div', 'dg-menu-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', provider.label);
      const heading = el('div', 'dg-menu-heading', provider.label);
      if (!provider.available) heading.append(el('span', 'dg-menu-tag', '사용 불가'));
      group.append(heading);

      if (provider.available) {
        for (const model of provider.models) {
          const on = provider.id === this.providerId && model.id === this.model;
          const item = button('dg-menu-item dg-model-item', '', () => {
            this.selectModel(provider.id, model.id);
            this.closeMenu(true);
          });
          item.setAttribute('role', 'menuitemradio');
          item.setAttribute('aria-checked', String(on));
          item.disabled = this.busy;
          const text = el('span', 'dg-model-item-text');
          const name = modelDisplayName(model, provider.models);
          text.append(el('span', 'dg-menu-label', name));
          const desc = model.description || (model.id !== name && model.id !== 'default' ? model.id : '');
          if (desc) text.append(el('span', 'dg-menu-desc', desc));
          item.title = model.resolvedModel && model.resolvedModel !== model.id ? `${name} → ${model.resolvedModel}` : model.id;
          item.append(el('span', 'dg-menu-check', on ? '✓' : ''), text);
          group.append(item);
        }
        const refreshing = this.refreshingModels.has(provider.id);
        const foot = el('div', 'dg-models-foot');
        const note = modelsFreshnessNote(provider);
        if (note) {
          const noteEl = el('span', 'dg-models-note', note);
          if (provider.modelsError) noteEl.title = provider.modelsError;
          foot.append(noteEl);
        }
        const refresh = button('dg-models-refresh', refreshing ? '새로고침 중…' : '새로고침', () => this.requestModelRefresh(provider.id));
        refresh.setAttribute('role', 'menuitem');
        refresh.disabled = refreshing;
        refresh.setAttribute('aria-label', `${provider.label} 모델 목록 새로고침`);
        foot.append(refresh);
        group.append(foot);
        if (provider.id === 'openai-siwc') {
          const logout = button('dg-menu-item dg-menu-minor', '로그아웃', () => {
            this.closeMenu(true);
            if (!this.deps.hub.logout(provider.id)) this.addNotice('agent hub 에 연결되어 있지 않습니다.', 'error');
          });
          logout.setAttribute('role', 'menuitem');
          group.append(logout);
        }
        if (SECRET_KEY_OF[provider.id]) {
          if (this.keyFormFor === provider.id) group.append(this.buildKeyForm(provider.id));
          else {
            const change = button('dg-menu-item dg-menu-minor', 'API 키 바꾸기', () => {
              this.keyFormFor = provider.id;
              this.keyNote = '';
              this.renderModelMenu();
              this.modelMenu.querySelector<HTMLInputElement>('input')?.focus();
            });
            change.setAttribute('role', 'menuitem');
            group.append(change);
          }
        }
      } else {
        const hint = provider.id === 'claude-sdk'
          ? provider.authHint || CLAUDE_LOGIN_HINT
          : provider.authHint || provider.reason || '';
        if (hint) group.append(el('p', 'dg-menu-hint', hint));
        if (provider.id === 'openai-siwc') {
          const pendingLogin = this.loginPending === provider.id;
          const login = button('dg-menu-item dg-menu-action', pendingLogin ? '로그인 취소' : 'ChatGPT로 로그인', () => {
            if (pendingLogin) {
              this.deps.hub.cancelLogin(provider.id);
              this.loginPending = null;
            } else {
              this.startLogin(provider.id);
            }
            this.renderModelMenu();
          });
          login.setAttribute('role', 'menuitem');
          group.append(login);
          if (pendingLogin) group.append(el('p', 'dg-menu-hint', '브라우저에서 로그인을 마치세요…'));
        } else if (SECRET_KEY_OF[provider.id]) {
          group.append(this.buildKeyForm(provider.id));
        }
      }
      parts.push(group);
    }
    this.modelMenu.replaceChildren(...parts);
  }

  private buildKeyForm(providerId: string): HTMLElement {
    const spec = SECRET_KEY_OF[providerId];
    const form = el('form', 'dg-key-form');
    const id = `dg-key-${providerId}`;
    const label = el('label', 'dg-sr-only', 'API 키');
    label.htmlFor = id;
    const input = el('input', 'dg-key-input');
    input.id = id;
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = spec.placeholder;
    const save = el('button', 'dg-key-save', '저장');
    save.type = 'submit';
    const note = el('p', 'dg-menu-hint', this.keyNote || 'OS 보안 저장소(keyring)에 저장되며 다시 표시되지 않습니다.');
    note.setAttribute('aria-live', 'polite');
    form.append(label, input, save, note);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        note.textContent = '키를 입력하세요.';
        return;
      }
      note.textContent = '저장하는 중…';
      this.deps.hub.setSecret(spec.key, value).then(() => {
        input.value = '';
        this.keyNote = '저장했습니다.';
        this.keyFormFor = null;
        note.textContent = '저장했습니다.';
        void this.refreshProviders();
      }).catch((error: unknown) => {
        note.textContent = `저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      });
    });
    return form;
  }

  private startLogin(providerId: string): void {
    if (!this.deps.hub.startLogin(providerId)) {
      this.addNotice('agent hub 에 연결되어 있지 않아 로그인을 시작할 수 없습니다.', 'error');
      return;
    }
    this.loginPending = providerId;
  }

  private handleAuthUrl(message: HubMessage): void {
    const { url, providerId } = message as { url?: unknown; providerId?: unknown };
    if (typeof url !== 'string') return;
    this.loginPending = typeof providerId === 'string' ? providerId : this.loginPending;
    if (this.openMenuKind === 'model') this.renderModelMenu();
    this.deps.openExternal(url).catch((error) => {
      this.addNotice(`브라우저를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
    });
  }

  private handleAuthDone(message: HubMessage): void {
    const { ok, error } = message as { ok?: unknown; error?: unknown };
    this.loginPending = null;
    if (ok === true) this.addNotice('로그인했습니다.', 'info');
    else this.addNotice(`로그인하지 못했습니다: ${errorText(error) || '알 수 없는 오류'}`, 'error');
    if (this.openMenuKind === 'model') this.renderModelMenu();
    // hub 가 새 providers 를 보내지만, 놓쳤을 때를 대비해 한 번 더 묻는다.
    void this.refreshProviders();
  }

  // ─── 입력 상자 ─────────────────────────────────────────

  private buildComposer(): HTMLElement {
    const wrap = el('div', 'dg-composer-wrap');
    const box = el('div', 'dg-composer');
    const label = el('label', 'dg-sr-only', '두글에게 답장');
    label.htmlFor = 'dg-msg';
    this.input = el('textarea', 'dg-input');
    this.input.id = 'dg-msg';
    this.input.rows = 2;
    this.input.placeholder = '두글에게 답장하기';
    this.input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        if (reviewStore.count > 0) {
          event.preventDefault();
          event.stopPropagation();
          this.decideAll('accept');
        }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!this.busy) this.submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.autosize();
      this.renderComposer();
    });

    const row = el('div', 'dg-composer-row');
    const attach = iconButton('dg-comp-btn dg-comp-square', 'plus', '파일 첨부 (준비 중)', () => {});
    attach.disabled = true;

    this.modeBtn = button('dg-comp-btn dg-mode-chip', '', () => this.setMode(this.mode === 'agent' ? 'full' : 'agent'));

    this.modelBtn = button('dg-model-btn', '', () => this.toggleMenu('model', this.modelBtn));
    this.modelBtn.setAttribute('aria-haspopup', 'menu');
    this.modelBtn.setAttribute('aria-expanded', 'false');
    this.modelText = el('span', 'dg-model-text', '연결 대기 중');
    this.modelBtn.append(this.modelText, icon('chevronDown', 12, 2));

    this.modelMenu = el('div', 'dg-menu dg-model-menu');
    this.modelMenu.setAttribute('role', 'menu');
    this.modelMenu.setAttribute('aria-label', '모델 고르기');
    this.modelMenu.hidden = true;

    this.sendBtn = button('dg-send', '', () => (this.busy ? this.cancel() : this.submit()));

    row.append(attach, this.modeBtn, el('div', 'dg-grow'), this.modelBtn, this.sendBtn);
    box.append(label, this.input, row);
    wrap.append(this.modelMenu, box);
    return wrap;
  }

  private autosize(): void {
    const input = this.input;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  private setMode(mode: AgentMode): void {
    if (this.mode === mode || this.busy) return;
    this.mode = mode;
    storeSet(STORE_MODE, mode);
    this.renderMode();
    this.deps.onModeChange?.(mode);
  }

  private renderMode(): void {
    if (!this.modeBtn) return;
    const review = this.mode === 'agent';
    this.modeBtn.replaceChildren(icon(review ? 'check' : 'bolt', 14, 2), el('span', '', review ? '검토 후 적용' : '바로 적용'));
    this.modeBtn.setAttribute('aria-label', `적용 방식: ${review ? '검토 후 적용' : '바로 적용'} (눌러서 바꾸기)`);
    this.modeBtn.title = review
      ? '편집을 문서에 바로 보여 주고, 적용할지 검토합니다'
      : '편집을 바로 적용합니다 (편집 1회 = 되돌리기 1단계)';
    this.modeBtn.classList.toggle('dg-mode-full', !review);
    this.modeBtn.disabled = this.busy;
  }

  private renderComposer(): void {
    if (!this.sendBtn) return;
    const provider = this.currentProvider();
    const ready = this.deps.hub.state === 'open' && !!provider?.available;
    if (this.busy) {
      this.sendBtn.replaceChildren(icon('stop', 14, 2.4));
      this.sendBtn.setAttribute('aria-label', '중지');
      this.sendBtn.title = '중지';
      this.sendBtn.disabled = false;
      this.sendBtn.classList.add('dg-send-stop');
    } else {
      this.sendBtn.replaceChildren(icon('send', 16, 2.2));
      this.sendBtn.setAttribute('aria-label', '보내기');
      this.sendBtn.title = ready ? '보내기 (Enter)' : provider ? `${provider.label}: 사용할 수 없습니다` : '모델을 고르세요';
      this.sendBtn.disabled = !ready || this.input.value.trim() === '';
      this.sendBtn.classList.remove('dg-send-stop');
    }
    this.renderMode();
  }

  // ─── 보내기 / 턴 ───────────────────────────────────────

  private submit(textOverride?: string): void {
    const text = (textOverride ?? this.input.value).trim();
    if (!text || this.busy) return;
    const provider = this.currentProvider();
    if (!provider?.available) {
      this.addNotice('사용할 수 있는 모델을 고르세요.', 'error');
      this.openMenu('model', this.modelBtn);
      return;
    }
    const sent = this.deps.hub.sendChat({
      threadId: this.thread.id,
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
    if (textOverride === undefined) {
      this.input.value = '';
      this.autosize();
    }
    if (this.thread.turns.length === 0) {
      this.thread.title = clipTitle(text);
      this.titleText.textContent = this.thread.title;
      this.titleBtn.setAttribute('aria-label', `대화: ${this.thread.title}`);
    }
    // 이전 턴의 "다시 시도" 는 마지막 턴에서만
    for (const t of this.thread.turns) t.actions?.querySelector('.dg-act-retry')?.setAttribute('hidden', '');
    this.appendToLog(el('div', 'dg-user', text));
    this.scrollToBottom();
    this.startTurn(text);
  }

  private cancel(): void {
    if (!this.busy) return;
    this.deps.hub.cancelChat(this.thread.id);
    if (this.turn?.thinking) this.turn.thinking.textContent = '중지하는 중…';
  }

  private startTurn(userText: string): void {
    const root = el('div', 'dg-turn');
    const thinking = el('div', 'dg-thinking', '생각하는 중…');
    root.append(thinking);
    const turn: TurnView = {
      threadId: this.thread.id, root, userText, chip: null, chipText: null, toolList: null, tools: new Map(),
      text: null, prose: [], thinking, actions: null, changeIds: new Set(), done: false,
    };
    this.turn = turn;
    this.thread.turns.push(turn);
    this.appendToLog(root);
    this.busy = true;
    reviewStore.setBusy(true);
    this.announce('응답을 작성하는 중');
    this.renderComposer();
    this.renderReview();
  }

  private endTurn(): void {
    const turn = this.turn;
    if (turn) {
      this.closeTextBlock();
      turn.thinking?.remove();
      turn.thinking = null;
      turn.done = true;
      for (const entry of turn.tools.values()) {
        if (entry.li.dataset.state === 'running') entry.li.dataset.state = 'done';
      }
      this.updateChip(turn);
      turn.actions = this.buildActions(turn);
      turn.root.append(turn.actions);
    }
    this.turn = null;
    this.busy = false;
    reviewStore.setBusy(false);
    this.renderComposer();
    this.renderReview();
    const count = reviewStore.count;
    this.announce(count > 0 ? `응답 완료. 검토할 변경 ${count}건` : '응답 완료');
    if (turn && count > 0) {
      const first = reviewStore.rows().find((r) => turn.changeIds.has(r.id)) ?? reviewStore.rows()[0];
      if (first) reviewStore.focus(first.id, true);
    }
  }

  private ensureTurn(): TurnView {
    if (!this.turn) this.startTurn('');
    return this.turn!;
  }

  private flushText(final = false): void {
    const turn = this.turn;
    if (!turn?.text) return;
    renderMarkdown(turn.text.node, turn.text.raw);
    if (final) turn.text.node.classList.remove('dg-streaming');
  }

  private scheduleTextRender(): void {
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      const near = this.isNearBottom();
      this.flushText();
      if (near) this.scrollToBottom();
    });
  }

  private closeTextBlock(): void {
    const turn = this.turn;
    if (!turn?.text) return;
    this.flushText(true);
    turn.prose.push(turn.text.raw);
    turn.text = null;
  }

  private handleAgentEvent(message: HubMessage): void {
    const { threadId, event } = message as { threadId?: string; event?: AgentEvent };
    if (!event || threadId !== this.thread.id) return;
    switch (event.kind) {
      case 'status': {
        const turn = this.ensureTurn();
        if (turn.thinking && event.text) turn.thinking.textContent = event.text;
        break;
      }
      case 'text_delta': {
        const turn = this.ensureTurn();
        if (!turn.text) {
          const node = el('div', 'dg-prose dg-streaming');
          turn.root.insertBefore(node, turn.thinking ?? null);
          turn.text = { node, raw: '' };
        }
        turn.text.raw += event.text;
        if (turn.thinking) {
          turn.thinking.remove();
          turn.thinking = null;
        }
        this.scheduleTextRender();
        break;
      }
      case 'text_done': {
        this.closeTextBlock();
        break;
      }
      case 'tool_use': {
        const turn = this.ensureTurn();
        this.closeTextBlock();
        const view = describeToolCall(event.name, event.args);
        this.addTool(turn, event.callId, view.label, view.summary);
        if (!turn.thinking) {
          turn.thinking = el('div', 'dg-thinking');
          turn.root.append(turn.thinking);
        }
        turn.thinking.textContent = `${view.label}…`;
        this.announce(`도구 사용: ${view.label}`);
        break;
      }
      case 'tool_result': {
        const turn = this.turn;
        const entry = turn?.tools.get(event.callId);
        if (turn && entry) {
          entry.li.dataset.state = event.ok ? 'done' : 'error';
          const status = entry.li.querySelector('.dg-tool-status');
          if (status) status.setAttribute('aria-label', event.ok ? '완료' : '실패');
          if (!event.ok && event.summary) entry.li.title = event.summary;
          this.updateChip(turn);
        }
        if (turn?.thinking) turn.thinking.textContent = '생각하는 중…';
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

  // ─── 도구 칩 ───────────────────────────────────────────

  private addTool(turn: TurnView, callId: string, label: string, summary: string): void {
    if (!turn.chip) {
      const chip = button('dg-tools-chip', '', () => {
        const open = chip.getAttribute('aria-expanded') !== 'true';
        chip.setAttribute('aria-expanded', String(open));
        if (turn.toolList) turn.toolList.hidden = !open;
      });
      chip.setAttribute('aria-expanded', 'false');
      const text = el('span', 'dg-tools-text');
      const chev = icon('chevronRight', 12, 2);
      chev.classList.add('dg-tools-chev');
      chip.append(icon('tool', 14, 2), text, chev);
      const list = el('ul', 'dg-tools-list');
      list.hidden = true;
      list.id = `dg-tools-${Math.random().toString(36).slice(2, 9)}`;
      chip.setAttribute('aria-controls', list.id);
      turn.chip = chip;
      turn.chipText = text;
      turn.toolList = list;
      // 칩은 턴 맨 위 — 산문보다 앞
      turn.root.prepend(chip, list);
    }
    const li = el('li', 'dg-tool');
    li.dataset.state = 'running';
    const status = el('span', 'dg-tool-status');
    status.setAttribute('role', 'img');
    status.setAttribute('aria-label', '진행 중');
    li.append(status, el('span', 'dg-tool-label', label));
    if (summary) li.append(el('span', 'dg-tool-summary', summary));
    turn.toolList!.append(li);
    turn.tools.set(callId, { li, label });
    this.updateChip(turn);
  }

  private updateChip(turn: TurnView): void {
    if (!turn.chipText) return;
    const entries = [...turn.tools.values()];
    const labels = [...new Set(entries.map((e) => e.label))];
    const shown = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` 외 ${labels.length - 3}개` : '');
    const running = entries.some((e) => e.li.dataset.state === 'running');
    const failed = entries.filter((e) => e.li.dataset.state === 'error').length;
    turn.chipText.textContent = `도구 ${entries.length}개 사용 · ${shown}`;
    turn.chip!.dataset.state = running ? 'running' : failed ? 'error' : 'done';
    turn.chip!.title = failed ? `${failed}개 실패` : '';
  }

  // ─── 메시지 동작 ───────────────────────────────────────

  private buildActions(turn: TurnView): HTMLElement {
    const row = el('div', 'dg-actions');
    const copy = iconButton('dg-act', 'copy', '복사', () => {
      const text = turn.prose.join('\n\n').trim();
      navigator.clipboard?.writeText(text).then(
        () => this.announce('복사했습니다'),
        () => this.announce('복사하지 못했습니다'),
      );
    }, 15);
    const retry = iconButton('dg-act dg-act-retry', 'retry', '다시 시도', () => this.retry(turn), 15);
    if (!turn.userText) retry.hidden = true;
    const revert = button('dg-act dg-act-text', '', () => this.revertTurn(turn));
    revert.append(icon('undo', 14), el('span', '', '요청 전으로 되돌리기'));
    revert.classList.add('dg-act-revert');
    row.append(copy, retry, revert);
    this.renderTurnActions(turn, row);
    return row;
  }

  /** 되돌리기는 이 턴의 변경이 아직 검토 대기 중일 때만 */
  private renderTurnActions(turn: TurnView, row = turn.actions): void {
    const revert = row?.querySelector<HTMLButtonElement>('.dg-act-revert');
    if (!revert) return;
    const pendingIds = this.pendingIdsOf(turn);
    revert.hidden = pendingIds.length === 0;
    revert.disabled = this.busy;
    if (pendingIds.length > 0) {
      const span = reviewStore.rejectSpan(pendingIds[0]);
      revert.title = span > pendingIds.length
        ? `이 요청의 변경과 그 뒤 변경까지 ${span}건을 되돌립니다`
        : `이 요청의 변경 ${span}건을 되돌립니다`;
    }
    const retry = row?.querySelector<HTMLButtonElement>('.dg-act-retry');
    if (retry) retry.disabled = this.busy;
  }

  private pendingIdsOf(turn: TurnView): string[] {
    const all = reviewStore.pending?.list() ?? [];
    return all.filter((c) => turn.changeIds.has(c.id)).map((c) => c.id);
  }

  private revertTurn(turn: TurnView): boolean {
    const ids = this.pendingIdsOf(turn);
    if (ids.length === 0 || this.busy) return false;
    try {
      reviewStore.decide('reject', ids[0]);
      return true;
    } catch (error) {
      this.addNotice(`되돌리지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return false;
    }
  }

  private retry(turn: TurnView): void {
    if (this.busy || !turn.userText) return;
    // 다시 시도는 같은 요청을 처음부터 — 이 턴의 검토 대기 변경은 먼저 되돌린다
    this.revertTurn(turn);
    this.submit(turn.userText);
  }

  // ─── 검토 ──────────────────────────────────────────────

  private onPendingChange(e: PendingChangeEvent): void {
    if (e.kind === 'added') {
      const turn = this.turn && !this.turn.done && e.threadId === this.turn.threadId ? this.turn : null;
      for (const cs of e.changeSets) {
        if (!turn) continue;
        turn.changeIds.add(cs.id);
        this.changeTurn.set(cs.id, turn);
      }
      // 검토 목록은 변경을 만든 턴의 지금 자리(산문 사이)에 놓는다
      if (turn && !turn.root.contains(this.review)) {
        this.closeTextBlock();
        turn.root.insertBefore(this.review, turn.thinking ?? null);
      }
    }
    for (const t of this.thread.turns) if (t.done) this.renderTurnActions(t);
  }

  private renderReview(): void {
    const review = this.review;
    if (!review) return;
    const rows = this.deps.pending ? reviewStore.rows() : [];
    if (rows.length === 0) {
      review.hidden = true;
      review.replaceChildren();
      for (const t of this.thread?.turns ?? []) if (t.done) this.renderTurnActions(t);
      return;
    }
    // 다른 대화의 변경이면 이 대화 끝에 붙인다
    if (!this.thread.log.contains(review)) {
      const owner = rows.map((r) => this.changeTurn.get(r.id)).find((t) => t && this.thread.turns.includes(t));
      if (owner) owner.root.insertBefore(review, owner.actions ?? owner.thinking ?? null);
      else this.thread.log.append(review);
    }
    review.hidden = false;
    const current = reviewStore.currentId;
    const foreign = rows.some((r) => r.threadId !== this.thread.id && !this.changeTurn.has(r.id));

    const head = el('div', 'dg-review-head');
    const count = el('span', 'dg-count', String(rows.length));
    count.setAttribute('aria-label', `${rows.length}건`);
    const rejectAll = button('dg-review-reject', '모두 거절', () => this.decideAll('reject'));
    const acceptAll = button('dg-review-accept', '모두 적용', () => this.decideAll('accept'));
    acceptAll.append(el('span', 'dg-kbd', 'Ctrl ↵'));
    acceptAll.setAttribute('aria-keyshortcuts', 'Control+Enter');
    rejectAll.disabled = this.busy;
    acceptAll.disabled = this.busy;
    head.append(el('span', 'dg-review-title', foreign ? '변경 (다른 대화)' : '변경'), count, el('div', 'dg-grow'), rejectAll, acceptAll);

    const list = el('ul', 'dg-review-list');
    for (const row of rows) {
      const view = describeChange(row);
      const li = el('li', 'dg-review-row');
      const on = row.id === current;
      li.classList.toggle('dg-current', on);
      const loc = view.location;

      const go = button('dg-review-go', '', () => reviewStore.focus(row.id, true));
      if (on) go.setAttribute('aria-current', 'true');
      go.setAttribute('aria-label', `${loc} 변경으로 이동`);
      const where = el('span', 'dg-review-loc', loc);
      const what = el('span', 'dg-review-what');
      if (view.del || view.ins) {
        if (view.del) what.append(el('del', 'dg-del', view.del));
        if (view.del && view.ins) what.append(' ');
        if (view.ins) what.append(el('ins', 'dg-ins', view.ins));
        if (view.summary) what.append(el('span', 'dg-review-more', ` ${view.summary}`));
      } else {
        what.textContent = view.summary;
      }
      go.append(where, what);

      const btns = el('span', 'dg-review-btns');
      const ok = iconButton('dg-review-ok', 'check', `${loc} 변경 적용`, () => this.decideOne('accept', row.id), 14);
      const span = reviewStore.rejectSpan(row.id);
      const no = iconButton('dg-review-no', 'close', `${loc} 변경 거절`, () => this.decideOne('reject', row.id), 13);
      if (span > 1) no.title = `${loc} 변경 거절 — 그 뒤 변경 ${span - 1}건도 함께 되돌아갑니다`;
      ok.disabled = this.busy;
      no.disabled = this.busy;
      btns.append(ok, no);
      li.append(go, btns);
      list.append(li);
    }
    review.replaceChildren(head, list);
    for (const t of this.thread.turns) if (t.done) this.renderTurnActions(t);
  }

  private decideOne(kind: 'accept' | 'reject', id: string): void {
    if (this.busy) return;
    try {
      reviewStore.decide(kind, id);
    } catch (error) {
      this.addNotice(`검토를 처리하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private decideAll(kind: 'accept' | 'reject'): void {
    if (this.busy || reviewStore.count === 0) return;
    try {
      reviewStore.decide(kind);
    } catch (error) {
      this.addNotice(`검토를 처리하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private onDecision(report: DecisionReport): void {
    if (report.count === 0) return;
    const decision = report.scope === 'all' ? (report.kind === 'accept' ? 'accept_all' : 'reject_all') : 'partial';
    const note = report.scope === 'one'
      ? report.kind === 'accept'
        ? `사용자가 변경 ${report.count}건을 적용했습니다.`
        : `사용자가 최근 변경 ${report.count}건을 거절해 그 전 상태로 되돌렸습니다.`
      : undefined;
    for (const threadId of report.threads) this.deps.hub.reviewDecision(threadId, decision, note);
    if (report.scope === 'all') {
      this.addNotice(
        report.kind === 'accept'
          ? `변경 ${report.count}건을 적용했습니다.`
          : `변경 ${report.count}건을 거절했습니다.${report.userEditsReverted ? ' 그 사이 직접 고친 내용도 함께 되돌아갔습니다.' : ''}`,
        'info',
      );
    } else if (report.kind === 'reject') {
      this.announce(`변경 ${report.count}건을 되돌렸습니다`);
      if (report.userEditsReverted) this.addNotice('그 사이 직접 고친 내용도 함께 되돌아갔습니다.', 'info');
    } else {
      this.announce('변경을 적용했습니다');
    }
  }

  /** "왜 바꿨나요?" — 그 변경을 만든 턴의 설명으로 스크롤하고 잠깐 강조한다 */
  private explain(id: string): void {
    const turn = this.changeTurn.get(id);
    if (!turn) return;
    const view = [...this.threads.values()].find((t) => t.turns.includes(turn));
    if (view && view !== this.thread && !this.busy) this.showThread(view);
    if (this.root && this.root.offsetParent === null) {
      try {
        (window as unknown as { rhwpStudio?: { automation?: { execute(id: string): unknown } } })
          .rhwpStudio?.automation?.execute('ext:doogle.toggle-panel');
      } catch { /* 패널을 못 열어도 스크롤은 시도 */ }
    }
    const target = turn.root.querySelector<HTMLElement>('.dg-prose') ?? turn.root;
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.remove('dg-flash');
      void target.offsetWidth;
      target.classList.add('dg-flash');
    });
  }
}
