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
import { mountReviewList, type ReviewListHandle } from '../review/list.ts';
import { reviewStore, type DecisionReport } from '../review/state.ts';
import { countdownText, describeConnection, userWords, type DeskHubStatus } from './connection.ts';
import type { DeskHubEvent } from './desk-bridge.ts';
import { icon, type IconName } from './icons.ts';
import { SettingsSheet } from './settings-sheet.ts';
import {
  describeToolCall, doneText, formatToolFailure, needsUserAction, parseBatchFailures, progressText,
  type ToolCallView,
} from './tool-presentation.ts';
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
  /** 문서·선택 상황 — 빈 대화의 상황별 제안과 첫 실행 체크리스트 */
  getDocContext?(): DocContext;
  /** 문서 열기 (체크리스트 ②, "문서를 열면…" 안내) */
  openDocument?(): void;
  /** 데스크탑 앱인가 (연결 카드의 "로그 열기") */
  isDesk?: boolean;
  /** 에이전트 서비스 로그를 연다. 실패하면 reject — 로그 경로 복사로 물러선다. */
  openHubLog?(): Promise<void>;
}

const STORE_PROVIDER = 'doogle.provider';
/** 예전 단일 키 — provider별 키(`doogle.model.<id>`)가 없을 때 한 번 읽는다. */
const STORE_MODEL_LEGACY = 'doogle.model';
const STORE_MODEL_PREFIX = 'doogle.model.';
/** 목록을 받기 전에도 버튼에 보일 마지막 모델 이름 */
const STORE_MODEL_LABEL = 'doogle.modelLabel';
const STORE_MODE = 'doogle.mode';

/** 첫 실행 체크리스트를 끝냈다(첫 요청을 보냈다) — 다시 보이지 않는다 */
const STORE_ONBOARDED = 'doogle.onboarded';

/** 문서·선택 상황 (상황별 제안 칩·첫 실행 체크리스트) */
export interface DocContext {
  hasDocument: boolean;
  hasSelection: boolean;
  inTable: boolean;
  /** 누름틀(양식 칸)이 있다 */
  hasFields: boolean;
}

const GENERIC_SUGGESTIONS = ['이 문서를 세 줄로 요약해 줘', '맞춤법과 띄어쓰기를 고쳐 줘'];

/** 상황별 제안: 상황 칩(파란색)이 앞으로, 일반 칩이 뒤로. 문서가 없으면 빈 배열. */
export function suggestionsFor(ctx: DocContext): Array<{ text: string; contextual: boolean }> {
  if (!ctx.hasDocument) return [];
  const out: Array<{ text: string; contextual: boolean }> = [];
  if (ctx.hasSelection) out.push({ text: '선택한 부분을 더 간결하게 다듬어 줘', contextual: true });
  if (ctx.inTable) out.push({ text: '이 표에 합계 행을 추가해 줘', contextual: true });
  if (ctx.hasFields) out.push({ text: '양식의 빈칸을 채워 줘', contextual: true });
  for (const text of GENERIC_SUGGESTIONS) out.push({ text, contextual: false });
  return out.slice(0, 4);
}

/** "2일 3시간 뒤" */
function relativeUntil(at: Date, now = Date.now()): string {
  const min = Math.max(0, Math.round((at.getTime() - now) / 60_000));
  if (min < 1) return '곧';
  if (min < 60) return `${min}분 뒤`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간${min % 60 ? ` ${min % 60}분` : ''} 뒤`;
  const d = Math.floor(h / 24);
  return `${d}일${h % 24 ? ` ${h % 24}시간` : ''} 뒤`;
}

function parseResetAt(value: string | number | undefined): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

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

/** "Claude (Claude Code 로그인)" → "Claude" */
function providerShortName(label: string): string {
  return label.replace(/\s*\(.*\)\s*$/, '').trim() || label;
}

/**
 * 입력창 단추에 보일 짧은 이름 — "Claude · 기본값", "Claude · Sonnet 5.5".
 * 전체 이름("기본값 (Claude Code 권장)")은 메뉴와 툴팁에서 보인다.
 */
export function modelButtonLabel(provider: Pick<ProviderInfo, 'label'>, model: Pick<ProviderModel, 'id' | 'label'>): string {
  const who = providerShortName(provider.label);
  let name = model.id === 'default' ? '기본값' : (model.label || model.id).replace(/\s*\(.*\)\s*$/, '').trim();
  // 제공자 이름이 모델 이름 앞에 겹치면 뗀다: "Claude Sonnet 5.5" → "Sonnet 5.5"
  if (name.toLowerCase().startsWith(`${who.toLowerCase()} `)) name = name.slice(who.length + 1).trim();
  return `${who} · ${name || model.id}`;
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
  view: ToolCallView;
  /** 묶음 도구의 하위 항목 줄 (apply_edits.edits[i] 순서) */
  items?: HTMLLIElement[];
  /** 실패 사유 줄 — 에이전트가 이어서 해냈으면 "다시 시도함" 을 덧붙인다 */
  reason?: HTMLElement;
}

/** 질문 카드 (ask_user_question) — 답하면 닫힌다 */
interface AskCard {
  root: HTMLElement;
  options: HTMLButtonElement[];
  other: HTMLButtonElement | null;
  threadId: string;
  answered: boolean;
}

interface TurnView {
  threadId: string;
  root: HTMLElement;
  userText: string;
  /** 이 턴을 보낸 AI 계정 (한도 카드의 "다른 계정으로 보내기") */
  providerId: string;
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
  /** 끝난 편집을 한 줄씩 남기는 자리 (연달아 끝난 것은 한 덩이로) */
  doneList: HTMLUListElement | null;
  /** 이미 보인 "사용자가 손써야 하는 실패" 카드 (코드별 한 번) */
  actionCards: Set<string>;
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
  /** 데스크 hub 이벤트(hub.rs)로 안 원인·재시작 예정 */
  private readonly desk: DeskHubStatus = { failure: '', restartAt: 0 };
  private connTimer: ReturnType<typeof setInterval> | null = null;
  private contextFrame = 0;
  private sheet!: SettingsSheet;
  private gearBtn!: HTMLButtonElement;

  // 화면 부품
  private titleBtn!: HTMLButtonElement;
  private titleText!: HTMLElement;
  private historyBtn!: HTMLButtonElement;
  private threadMenu!: HTMLElement;
  private conn!: HTMLElement;
  private scroller!: HTMLElement;
  private review!: HTMLElement;
  /** 입력창 바로 위에 붙는 검토 머리줄 (건수 · 모두 거절 · 모두 적용) */
  private reviewBar!: HTMLElement;
  private reviewList: ReviewListHandle | null = null;
  private readonly askCards: AskCard[] = [];
  /** "직접 입력" 을 눌러 답을 기다리는 중 — 입력창 안내문이 바뀐다 */
  private awaitingAnswer = false;
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
    this.sheet = this.buildSheet();
    root.append(this.buildHead(), this.buildBody(), this.buildComposer(), this.sheet.root);
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
        if (this.sheet.isOpen) this.announce(ok === true ? '로그아웃했습니다' : `로그아웃하지 못했습니다: ${errorText(error)}`);
        else this.addNotice(ok === true ? '로그아웃했습니다.' : `로그아웃하지 못했습니다: ${errorText(error)}`, ok === true ? 'info' : 'error');
      }),
    );
    // 열려 있는 동안 선택·커서가 바뀌면 빈 대화의 제안 칩을 다시 고른다
    const onFocusIn = () => {
      this.refreshContext();
      // 적용 뒤 되돌리기는 문서가 그대로일 때만 — 패널로 돌아올 때 다시 확인한다
      for (const t of this.thread?.turns ?? []) if (t.done) this.renderTurnActions(t);
    };
    root.addEventListener('pointerenter', onFocusIn);
    root.addEventListener('focusin', onFocusIn);
    this.offs.push(() => {
      if (this.connTimer) clearInterval(this.connTimer);
      this.connTimer = null;
      if (this.contextFrame) cancelAnimationFrame(this.contextFrame);
    });
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
      this.refreshContext();
      requestAnimationFrame(() => this.input?.focus());
    } else {
      this.closeMenu(false);
    }
  }

  /** 문서·선택이 바뀌었다 — 빈 대화의 제안 칩·체크리스트를 다시 그린다(한 프레임에 한 번). */
  refreshContext(): void {
    if (this.contextFrame || !this.root) return;
    this.contextFrame = requestAnimationFrame(() => {
      this.contextFrame = 0;
      this.renderEmpty();
    });
  }

  /** doogle-desk `doogle://hub` 이벤트 (hub.rs: ready · exited{restartInMs} · failed{message}) */
  noteDeskHubEvent(event: DeskHubEvent): void {
    if (!event) return;
    if (event.state === 'ready') {
      this.desk.failure = '';
      this.desk.restartAt = 0;
    } else if (event.state === 'exited') {
      this.desk.restartAt = Date.now() + Math.max(0, Number(event.restartInMs) || 0);
    } else if (event.state === 'failed') {
      this.desk.failure = String(event.message ?? '');
      this.desk.restartAt = 0;
    }
    this.renderConnection(this.deps.hub.state, this.deps.hub.detail);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.reviewList?.dispose();
    this.reviewList = null;
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

  /** 설정 시트 (AI 계정 · 기본 적용 방식 · 에이전트 서비스 · 데이터 안내) */
  openSettings(focus?: 'accounts' | 'api'): void {
    if (!this.sheet) return;
    this.closeMenu(false);
    this.sheet.open(focus);
    this.gearBtn?.setAttribute('aria-expanded', 'true');
  }

  private buildSheet(): SettingsSheet {
    return new SettingsSheet({
      hub: this.deps.hub,
      providers: () => this.providers,
      mode: () => this.mode,
      setMode: (mode) => {
        this.setMode(mode);
        this.sheet.render();
      },
      busy: () => this.busy,
      loginPending: () => this.loginPending,
      startLogin: (id) => {
        this.startLogin(id);
        this.sheet.render();
      },
      cancelLogin: (id) => {
        this.deps.hub.cancelLogin(id);
        this.loginPending = null;
        this.sheet.render();
      },
      refreshProviders: () => this.refreshProviders(),
      announce: (text) => this.announce(text),
      connection: () => {
        const state = this.deps.hub.state;
        if (state === 'open') return { ok: true, text: `연결됨${this.deps.hub.version ? ` · v${this.deps.hub.version}` : ''}` };
        const view = describeConnection(state, this.deps.hub.detail, this.desk, { isDesk: !!this.deps.isDesk, nextRetryAt: 0 });
        return { ok: false, text: view?.title ?? '연결되지 않음' };
      },
      retryConnection: () => this.retryConnection(),
      onClosed: () => {
        this.gearBtn?.setAttribute('aria-expanded', 'false');
        this.gearBtn?.focus();
      },
    });
  }

  private retryConnection(): void {
    this.desk.failure = '';
    this.desk.restartAt = 0;
    this.deps.hub.reconnectNow();
    this.renderConnection(this.deps.hub.state, this.deps.hub.detail);
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
    this.threadMenu.dataset.dgFloating = '';
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

    this.reviewBar = el('div', 'dg-review-bar');
    this.reviewBar.hidden = true;

    this.live = el('div', 'dg-sr-only');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('aria-atomic', 'true');

    body.append(this.conn, this.scroller, this.reviewBar, this.live);
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
    this.fillEmpty(box);
    return box;
  }

  /** 지금 대화가 비어 있으면 그 빈 상태를 상황에 맞게 다시 채운다 */
  private renderEmpty(): void {
    const box = this.thread?.log.querySelector<HTMLElement>(':scope > .dg-empty');
    if (box) this.fillEmpty(box);
  }

  private docContext(): DocContext {
    try {
      return this.deps.getDocContext?.() ?? { hasDocument: true, hasSelection: false, inTable: false, hasFields: false };
    } catch {
      return { hasDocument: true, hasSelection: false, inTable: false, hasFields: false };
    }
  }

  private fillEmpty(box: HTMLElement): void {
    const ctx = this.docContext();
    const onboarded = storeGet(STORE_ONBOARDED) === '1';
    const account = this.providers.find((p) => p.available)?.id ?? '';
    // 바뀐 것이 없으면 다시 그리지 않는다 — 칩에 있던 키보드 포커스를 잃지 않게
    const sig = [ctx.hasDocument, ctx.hasSelection, ctx.inTable, ctx.hasFields, onboarded, account, this.providerId, this.deps.hub.state].join('|');
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const parts: HTMLElement[] = [
      el('p', 'dg-empty-title', '무엇을 도와드릴까요?'),
      el('p', 'dg-empty-sub', '열린 문서를 읽고, 고칠 곳은 검토할 수 있게 제안해요.'),
    ];
    if (!onboarded) parts.push(this.buildChecklist(ctx));

    const chips = el('div', 'dg-suggest');
    const list = suggestionsFor(ctx);
    if (list.length === 0) {
      const none = el('p', 'dg-suggest-none', '문서를 열면 시작할 수 있어요.');
      chips.append(none);
      if (this.deps.openDocument) {
        const open = button('dg-btn', '', () => this.deps.openDocument?.());
        open.append(icon('folder', 13), el('span', '', '문서 열기…'));
        chips.append(open);
      }
    }
    for (const item of list) {
      chips.append(button(`dg-suggest-chip${item.contextual ? ' dg-suggest-ctx' : ''}`, item.text, () => {
        this.input.value = item.text;
        this.renderComposer();
        if (!this.sendBtn.disabled) this.submit();
        else this.input.focus();
      }));
    }
    parts.push(chips);
    box.replaceChildren(...parts);
  }

  /** 첫 실행 체크리스트: ① AI 계정 연결 → ② 문서 열기 → ③ 첫 요청. 첫 요청을 보내면 다시 보이지 않는다. */
  private buildChecklist(ctx: DocContext): HTMLElement {
    const card = el('div', 'dg-card dg-start');
    card.append(el('div', 'dg-card-title', '시작하기'));
    const account = this.providers.find((p) => p.available && p.id === this.providerId) ?? this.providers.find((p) => p.available);
    const steps: Array<{ done: boolean; title: string; sub: string; act?: () => void }> = [
      {
        done: !!account,
        title: 'AI 계정 연결',
        sub: account ? `${account.label} 사용 가능` : this.deps.hub.state === 'open' ? 'Claude Code · ChatGPT · API 키 중 하나' : '에이전트 서비스에 연결되면 확인합니다',
        act: () => this.openSettings('accounts'),
      },
      {
        done: ctx.hasDocument,
        title: '문서 열기',
        sub: ctx.hasDocument ? '문서가 열려 있습니다' : '파일 › 열기 또는 끌어다 놓기',
        ...(this.deps.openDocument ? { act: () => this.deps.openDocument?.() } : {}),
      },
      { done: false, title: '첫 요청 보내기', sub: '예: "맞춤법을 고쳐 줘"', act: () => this.input.focus() },
    ];
    const ol = el('ol', 'dg-steps');
    let current = steps.findIndex((s) => !s.done);
    if (current === -1) current = steps.length - 1;
    steps.forEach((step, index) => {
      const li = el('li', '');
      const row = button('dg-step', '', () => step.act?.());
      row.dataset.state = step.done ? 'done' : index === current ? 'now' : 'todo';
      row.disabled = step.done || !step.act;
      row.setAttribute('aria-label', `${index + 1}단계 ${step.title}${step.done ? ' (완료)' : ''}`);
      const text = el('span', 'dg-step-text');
      text.append(el('span', 'dg-step-title', step.title), el('span', 'dg-step-sub', step.sub));
      row.append(el('span', 'dg-step-n', step.done ? '✓' : String(index + 1)), text);
      li.append(row);
      ol.append(li);
    });
    card.append(ol);
    return card;
  }

  private showThread(view: ThreadView): void {
    this.thread = view;
    this.scroller?.replaceChildren(view.log);
    if (this.titleText) this.titleText.textContent = view.title;
    if (this.titleBtn) this.titleBtn.setAttribute('aria-label', `대화: ${view.title}`);
    this.awaitingAnswer = false;
    this.renderPlaceholder();
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
    this.placeInTurn(node);
  }

  /** 진행 중인 턴이 있으면 그 안(생각 중 줄 앞)에, 아니면 대화 끝에 */
  private placeInTurn(node: HTMLElement, turn: TurnView | null = this.turn): void {
    if (turn && !turn.done) {
      // 대화 끝을 보고 있었으면 새로 들어온 카드·알림이 보이게 따라 내려간다
      const follow = turn === this.turn && this.isNearBottom();
      turn.root.insertBefore(node, this.tail(turn));
      if (turn === this.turn) turn.text = null;
      if (follow) this.scrollToBottom();
    } else {
      this.appendToLog(node);
    }
  }

  /** 이 턴 안에 검토 목록이 놓여 있으면 그 목록 — 목록은 늘 턴의 맨 끝(답변 아래)에 둔다 */
  private reviewIn(turn: TurnView): HTMLElement | null {
    return this.review && this.review.parentElement === turn.root ? this.review : null;
  }

  /** 턴에 새 내용을 넣을 자리: 진행 줄 앞, 없으면 검토 목록 앞, 그것도 없으면 맨 끝 */
  private tail(turn: TurnView): HTMLElement | null {
    return turn.thinking ?? this.reviewIn(turn);
  }

  /**
   * 오류 카드 — 무엇이(제목) + 왜(한 문장) + 다음 행동(단추). 코드는 "자세히"에만 (UI_AUDIT §3.12).
   */
  private buildCard(spec: {
    tone: 'warn' | 'bad';
    iconName: IconName;
    title: string;
    body?: string;
    code?: string;
    actions?: Array<{ label: string; primary?: boolean; run: () => void }>;
  }): HTMLElement {
    const card = el('div', 'dg-card');
    card.dataset.tone = spec.tone;
    card.setAttribute('role', spec.tone === 'bad' ? 'alert' : 'status');
    const title = el('div', 'dg-card-title');
    title.append(icon(spec.iconName, 14, 2), el('span', '', spec.title));
    card.append(title);
    if (spec.body) card.append(el('p', 'dg-card-sub', spec.body));
    if (spec.actions?.length) {
      const acts = el('div', 'dg-card-acts');
      for (const action of spec.actions) {
        acts.append(button(action.primary ? 'dg-btn dg-btn-primary' : 'dg-btn', action.label, action.run));
      }
      card.append(acts);
    }
    if (spec.code) {
      const details = el('details', '');
      details.append(el('summary', '', '자세히'), el('code', '', spec.code));
      card.append(details);
    }
    return card;
  }

  // ─── 연결 / provider / 로그인 ──────────────────────────

  private renderConnection(state: HubConnectionState, detail: string): void {
    if (!this.conn) return;
    const view = describeConnection(state, detail, this.desk, {
      isDesk: !!this.deps.isDesk,
      nextRetryAt: this.deps.hub.nextRetryAt,
    });
    if (this.connTimer) {
      clearInterval(this.connTimer);
      this.connTimer = null;
    }
    if (!view) {
      this.conn.hidden = true;
      this.conn.replaceChildren();
    } else {
      this.conn.hidden = false;
      this.conn.dataset.state = state;
      this.conn.dataset.tone = view.tone;
      if (view.tone === 'quiet') {
        this.conn.className = 'dg-conn';
        this.conn.replaceChildren(el('span', '', view.title));
      } else {
        this.conn.className = 'dg-conn dg-card';
        const title = el('div', 'dg-card-title');
        title.append(icon('alert', 14, 2), el('span', '', view.title));
        const parts: HTMLElement[] = [title];
        if (view.body) parts.push(el('p', 'dg-card-sub', view.body));
        let countdown: HTMLElement | null = null;
        if (view.retryAt) {
          countdown = el('p', 'dg-card-sub dg-countdown', countdownText(view.retryAt));
          parts.push(countdown);
        }
        const acts = el('div', 'dg-card-acts');
        if (view.canRetry) acts.append(button('dg-btn dg-btn-primary', '다시 시도', () => this.retryConnection()));
        if (view.canOpenLog) acts.append(button('dg-btn', '로그 열기', () => this.openLog(view.logPath)));
        if (view.help) {
          const help = view.help;
          acts.append(button('dg-btn dg-btn-quiet', help.label, () => { void this.deps.openExternal(help.url); }));
        }
        if (acts.childElementCount) parts.push(acts);
        if (view.raw && view.tone === 'bad') {
          const details = el('details', '');
          details.append(el('summary', '', '자세히'), el('code', '', userWords(view.raw)));
          parts.push(details);
        }
        this.conn.replaceChildren(...parts);
        if (countdown && view.retryAt > Date.now()) {
          const node = countdown;
          const at = view.retryAt;
          this.connTimer = setInterval(() => {
            node.textContent = countdownText(at);
            if (Date.now() >= at && this.connTimer) {
              clearInterval(this.connTimer);
              this.connTimer = null;
            }
          }, 1000);
        }
      }
    }
    if (state === 'open') void this.refreshProviders();
    this.renderModelButton();
    if (state !== 'open' && this.busy) {
      this.addNotice('에이전트 서비스 연결이 끊겨 응답을 더 받지 못했습니다.', 'error');
      this.endTurn();
    }
    this.renderComposer();
    this.sheet?.render();
    this.refreshContext();
  }

  private openLog(logPath: string): void {
    const fallback = () => {
      if (logPath && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(logPath).then(
          () => this.addNotice(`로그를 열지 못해 파일 경로를 복사했습니다: ${logPath}`, 'info'),
          () => this.addNotice(`로그 파일: ${logPath}`, 'info'),
        );
      } else {
        this.addNotice('로그를 열지 못했습니다. 앱 로그 폴더의 hub.log 를 확인하세요.', 'error');
      }
    };
    if (!this.deps.openHubLog) {
      fallback();
      return;
    }
    this.deps.openHubLog().catch(fallback);
  }

  private async refreshProviders(): Promise<void> {
    try {
      this.setProviders(await this.deps.hub.queryProviders());
    } catch (error) {
      if (this.deps.hub.state !== 'open') return; // 연결 카드가 이미 말한다
      this.addNotice(`AI 계정 목록을 받지 못했습니다: ${userWords(error instanceof Error ? error.message : String(error))}`, 'error');
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
    this.sheet?.render();
    this.refreshContext();
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
      this.addNotice('에이전트 서비스에 연결되어 있지 않습니다.', 'error');
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
    let full = '';
    if (model && provider) {
      label = modelButtonLabel(provider, model);
      full = modelDisplayName(model, provider.models);
      storeSet(STORE_MODEL_LABEL, label);
    } else if (provider) {
      label = provider.available ? '모델 고르기' : 'AI 계정 연결 필요';
    } else {
      label = storeGet(STORE_MODEL_LABEL) || (this.deps.hub.state === 'open' ? '모델 불러오는 중…' : '연결 대기 중');
    }
    this.modelText.textContent = label;
    const title = provider ? (provider.available ? `${provider.label} · ${full || label}` : `${provider.label}: 연결되지 않음`) : label;
    this.modelBtn.title = title;
    this.modelBtn.setAttribute('aria-label', `모델: ${title}`);
    this.modelBtn.classList.toggle('dg-warn', !!provider && !provider.available);
  }

  /** 모델 메뉴: 쓸 수 있는 AI 계정의 모델 + 새로고침. 계정 연결·키·로그아웃은 설정 시트에서. */
  private renderModelMenu(): void {
    const parts: HTMLElement[] = [];
    const usable = this.providers.filter((p) => p.available);
    if (this.providers.length === 0) {
      parts.push(el('p', 'dg-menu-hint', this.deps.hub.state === 'open' ? '모델 목록을 받는 중…' : '에이전트 서비스에 연결되면 모델을 고를 수 있습니다.'));
    } else if (usable.length === 0) {
      parts.push(el('p', 'dg-menu-hint', '사용할 수 있는 AI 계정이 없습니다. 설정에서 계정을 연결하세요.'));
    }
    for (const provider of usable) {
      const group = el('div', 'dg-menu-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', provider.label);
      group.append(el('div', 'dg-menu-heading', provider.label));
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
      parts.push(group);
    }
    const manage = button('dg-menu-item dg-menu-minor', '', () => this.openSettings('accounts'));
    manage.setAttribute('role', 'menuitem');
    manage.append(icon('gear', 13), el('span', '', 'AI 계정 관리…'));
    const foot = el('div', usable.length ? 'dg-menu-foot' : '');
    foot.append(manage);
    parts.push(foot);
    this.modelMenu.replaceChildren(...parts);
  }

  private startLogin(providerId: string): void {
    if (!this.deps.hub.startLogin(providerId)) {
      this.addNotice('에이전트 서비스에 연결되어 있지 않아 로그인을 시작할 수 없습니다.', 'error');
      return;
    }
    this.loginPending = providerId;
  }

  private handleAuthUrl(message: HubMessage): void {
    const { url, providerId } = message as { url?: unknown; providerId?: unknown };
    if (typeof url !== 'string') return;
    this.loginPending = typeof providerId === 'string' ? providerId : this.loginPending;
    this.sheet?.render();
    this.deps.openExternal(url).catch((error) => {
      this.addNotice(`브라우저를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
    });
  }

  private handleAuthDone(message: HubMessage): void {
    const { ok, error } = message as { ok?: unknown; error?: unknown };
    this.loginPending = null;
    const text = ok === true ? '로그인했습니다.' : `로그인하지 못했습니다: ${errorText(error) || '알 수 없는 오류'}`;
    if (this.sheet?.isOpen) this.announce(text);
    else this.addNotice(text, ok === true ? 'info' : 'error');
    this.sheet?.render();
    // hub 가 새 providers 를 보내지만, 놓쳤을 때를 대비해 한 번 더 묻는다.
    void this.refreshProviders();
  }

  // ─── 입력 상자 ─────────────────────────────────────────

  private buildComposer(): HTMLElement {
    const wrap = el('div', 'dg-composer-wrap');
    const box = el('div', 'dg-composer');
    const label = el('label', 'dg-sr-only', '두글에게 요청');
    label.htmlFor = 'dg-msg';
    this.input = el('textarea', 'dg-input');
    this.input.id = 'dg-msg';
    this.input.rows = 2;
    this.renderPlaceholder();
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
    this.modelMenu.dataset.dgFloating = '';
    this.modelMenu.setAttribute('role', 'menu');
    this.modelMenu.setAttribute('aria-label', '모델 고르기');
    this.modelMenu.hidden = true;

    this.gearBtn = iconButton('dg-gear', 'gear', '설정 (AI 계정 · 적용 방식)', () => {
      if (this.sheet.isOpen) this.sheet.close();
      else this.openSettings();
    }, 16);
    this.gearBtn.setAttribute('aria-expanded', 'false');

    this.sendBtn = button('dg-send', '', () => (this.busy ? this.cancel() : this.submit()));

    row.append(attach, this.modeBtn, el('div', 'dg-grow'), this.modelBtn, this.gearBtn, this.sendBtn);
    box.append(label, this.input, row);
    wrap.append(this.modelMenu, box);
    return wrap;
  }

  /** 새 대화면 무엇을 적을지, 이어지는 대화면 이어서 요청하라고 알린다 */
  private renderPlaceholder(): void {
    if (!this.input) return;
    this.input.placeholder = this.awaitingAnswer
      ? '답을 적어 주세요'
      : this.thread && this.thread.turns.length > 0 ? '이어서 요청하기' : '문서에서 바꿀 내용을 적어 주세요';
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
      this.sendBtn.title = ready ? '보내기 (Enter)' : this.deps.hub.state !== 'open' ? '에이전트 서비스에 연결되어 있지 않습니다' : provider ? `${provider.label}: AI 계정을 연결하세요` : '모델을 고르세요';
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
      if (this.providers.some((p) => p.available)) {
        this.addNotice('사용할 수 있는 모델을 고르세요.', 'error');
        this.openMenu('model', this.modelBtn);
      } else {
        this.openSettings('accounts');
      }
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
      this.addNotice('에이전트 서비스에 연결되어 있지 않습니다.', 'error');
      return;
    }
    storeSet(STORE_ONBOARDED, '1');
    // 어떤 답이든 보내면 열려 있던 질문 카드는 답한 것이 된다
    this.closeAskCards(this.thread.id, text);
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
    const bubble = el('div', 'dg-user', text);
    bubble.classList.add('dg-keep-all');
    this.appendToLog(bubble);
    this.scrollToBottom();
    this.startTurn(text, provider.id);
  }

  private cancel(): void {
    if (!this.busy) return;
    this.deps.hub.cancelChat(this.thread.id);
    if (this.turn?.thinking) this.turn.thinking.textContent = '중지하는 중…';
  }

  private startTurn(userText: string, providerId = this.providerId): void {
    const root = el('div', 'dg-turn');
    const thinking = el('div', 'dg-thinking', '생각하는 중…');
    root.append(thinking);
    const turn: TurnView = {
      threadId: this.thread.id, root, userText, providerId, chip: null, chipText: null, toolList: null, tools: new Map(),
      text: null, prose: [], thinking, actions: null, changeIds: new Set(), doneList: null, actionCards: new Set(), done: false,
    };
    this.turn = turn;
    this.thread.turns.push(turn);
    this.appendToLog(root);
    this.renderPlaceholder();
    this.busy = true;
    reviewStore.setBusy(true);
    this.announce('응답을 작성하는 중');
    this.renderComposer();
    this.renderReview();
  }

  private endTurn(): void {
    const turn = this.turn;
    const follow = this.isNearBottom();
    if (turn) {
      this.closeTextBlock();
      turn.thinking?.remove();
      turn.thinking = null;
      turn.done = true;
      let unresolved = 0;
      for (const entry of turn.tools.values()) {
        if (entry.li.dataset.state === 'running') entry.li.dataset.state = 'done';
        // 끝까지 다시 해내지 못한 실패만 오류로 남긴다
        if (entry.li.dataset.state === 'failed') {
          entry.li.dataset.state = 'error';
          unresolved++;
        }
      }
      this.updateChip(turn);
      if (unresolved > 0 && turn.chip && turn.toolList) {
        turn.chip.setAttribute('aria-expanded', 'true');
        turn.toolList.hidden = false;
      }
      turn.actions = this.buildActions(turn);
      turn.root.insertBefore(turn.actions, this.reviewIn(turn));
    }
    this.turn = null;
    this.busy = false;
    reviewStore.setBusy(false);
    this.renderComposer();
    this.renderReview();
    this.renderAskCards();
    // 턴 끝에 붙는 것(동작 줄·검토 목록·펼친 실패 사유)까지 보이게 한다
    if (follow) requestAnimationFrame(() => this.scrollToBottom());
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
          const node = el('div', 'dg-prose dg-keep-all dg-streaming');
          turn.root.insertBefore(node, this.reviewIn(turn));
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
        this.addTool(turn, event.callId, view);
        if (!turn.thinking) {
          turn.thinking = el('div', 'dg-thinking');
          turn.root.insertBefore(turn.thinking, this.reviewIn(turn));
        }
        // 진행 줄에 지금 하는 일을 적는다 — "문서 구조 읽는 중…", "6곳 글자 서식 바꾸는 중…"
        turn.thinking.textContent = `${progressText(view)}…`;
        this.announce(progressText(view));
        break;
      }
      case 'tool_result': {
        const turn = this.turn;
        const entry = turn?.tools.get(event.callId);
        if (turn && entry) {
          // 실패는 일단 "넘어간 실패"로 둔다 — 에이전트가 스스로 다시 해내는 일이 많다.
          // 턴이 끝날 때까지 같은 종류의 일을 해내지 못한 것만 오류로 올린다(endTurn).
          entry.li.dataset.state = event.ok ? 'done' : 'failed';
          const status = entry.li.querySelector('.dg-tool-status');
          if (status) status.setAttribute('aria-label', event.ok ? '완료' : '실패');
          if (event.ok) {
            this.markRecovered(turn, entry);
            if (entry.view.category === 'edit') this.addDoneLine(turn, doneText(entry.view));
          } else {
            this.showToolFailure(turn, entry, event.summary);
          }
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
        this.addLimitCard(this.turn, event.message, event.resetAt);
        break;
      }
      case 'error': {
        this.addErrorCard(this.turn, event.code, event.message);
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

  // ─── 한도·오류 카드 (UI_AUDIT §3.12) ───────────────────

  private addLimitCard(turn: TurnView | null, message: string, resetAt: string | number | undefined): void {
    const providerId = turn?.providerId ?? this.providerId;
    const provider = this.providers.find((p) => p.id === providerId);
    const reset = parseResetAt(resetAt);
    const body = reset
      ? `${formatResetAt(resetAt)}에 다시 쓸 수 있습니다 (${relativeUntil(reset)}).`
      : '한도가 다시 채워지면 이어서 쓸 수 있습니다.';
    const actions: Array<{ label: string; primary?: boolean; run: () => void }> = [];
    const userText = turn?.userText ?? '';
    if (userText) {
      const others = this.providers.filter((p) => p.available && p.id !== providerId).slice(0, 2);
      others.forEach((other, index) => {
        actions.push({ label: `${other.label}로 보내기`, primary: index === 0, run: () => this.resendWith(other.id, userText) });
      });
    }
    if (!this.providers.some((p) => p.available && (p.id === 'anthropic-api' || p.id === 'openai-api'))) {
      actions.push({ label: 'API 키 추가', run: () => this.openSettings('api') });
    }
    const title = message?.trim() || `${provider?.label ?? 'AI 계정'} 사용 한도를 다 썼습니다`;
    this.placeInTurn(this.buildCard({ tone: 'warn', iconName: 'clock', title, body, actions }), turn);
  }

  private addErrorCard(turn: TurnView | null, code: string, message: string): void {
    const actions: Array<{ label: string; primary?: boolean; run: () => void }> = [];
    if (turn?.userText) actions.push({ label: '다시 시도', run: () => this.retry(turn) });
    this.placeInTurn(this.buildCard({
      tone: 'bad',
      iconName: 'alert',
      title: '요청을 끝내지 못했습니다',
      body: message ? userWords(message) : '잠시 뒤 다시 시도하세요.',
      ...(code ? { code } : {}),
      actions,
    }), turn);
  }

  /** 한도 카드: 같은 요청을 다른 AI 계정으로 다시 보낸다 */
  private resendWith(providerId: string, text: string): void {
    if (this.busy) {
      this.announce('응답이 끝난 뒤 다시 누르세요');
      return;
    }
    const provider = this.providers.find((p) => p.id === providerId && p.available);
    if (!provider) return;
    const stored = storeGet(`${STORE_MODEL_PREFIX}${provider.id}`);
    const model = provider.models.some((m) => m.id === stored)
      ? stored!
      : provider.defaultModel && provider.models.some((m) => m.id === provider.defaultModel)
        ? provider.defaultModel
        : provider.models[0]?.id ?? '';
    this.selectModel(provider.id, model);
    this.submit(text);
  }

  // ─── 도구 칩 ───────────────────────────────────────────

  /**
   * 도구 실패 — 영어 원문(에이전트에게 주는 안내)은 접어 두고 한국어 한 줄만 보인다.
   * 사용자가 손써야 풀리는 실패(문서 없음·편집기 멈춤·다른 대화의 검토 대기)만 강조 카드로 올린다.
   */
  private showToolFailure(turn: TurnView, entry: ToolEntry, summary: string | undefined): void {
    const failure = formatToolFailure(summary);
    const byItem = entry.items ? parseBatchFailures(summary) : new Map<number, { code: string; text: string; raw: string }>();
    const reason = el('span', 'dg-tool-reason', byItem.size > 0
      ? `${entry.items!.length}곳 중 ${byItem.size}곳을 끝내지 못해 하나도 적용하지 않았습니다.`
      : failure.text);
    entry.reason = reason;
    // 사유 줄은 하위 항목 목록보다 위에 둔다
    const list = entry.li.querySelector('.dg-tool-items');
    if (list) list.before(reason); else entry.li.append(reason);
    for (const [index, item] of byItem) {
      const row = entry.items?.[index];
      if (!row) continue;
      row.dataset.state = 'failed';
      const why = el('span', 'dg-tool-reason', item.text);
      why.title = item.raw;
      row.append(why);
    }
    if (failure.raw) {
      const details = el('details', 'dg-tool-raw');
      details.append(el('summary', '', '자세히'), el('code', '', failure.raw.length > 700 ? `${failure.raw.slice(0, 700)}…` : failure.raw));
      entry.li.append(details);
    }
    const codes = new Set<string>([failure.code ?? '', ...[...byItem.values()].map((item) => item.code)]);
    for (const code of codes) if (needsUserAction(code)) this.addActionCard(turn, code);
  }

  /** 같은 종류의 일이 뒤에서 성공했다 — 앞서 넘어간 실패에 "다시 시도함" 을 붙인다 */
  private markRecovered(turn: TurnView, done: ToolEntry): void {
    for (const entry of turn.tools.values()) {
      if (entry === done || entry.li.dataset.state !== 'failed' || entry.view.category !== done.view.category) continue;
      entry.li.dataset.state = 'retried';
      if (entry.reason && !entry.reason.dataset.retried) {
        entry.reason.dataset.retried = '1';
        entry.reason.textContent = `${(entry.reason.textContent ?? '').replace(/[.。]\s*$/, '')} · 다시 시도함`;
      }
      entry.li.querySelector('.dg-tool-status')?.setAttribute('aria-label', '다시 시도함');
    }
  }

  /** 사용자가 손써야 하는 실패 — 무엇을 하면 되는지 단추로 준다 (코드별 한 번) */
  private addActionCard(turn: TurnView, code: string): void {
    if (turn.actionCards.has(code)) return;
    turn.actionCards.add(code);
    const spec: { title: string; body: string; actions: Array<{ label: string; primary?: boolean; run: () => void }> } = (() => {
      switch (code) {
        case 'NO_DOCUMENT':
          return {
            title: '열린 문서가 없습니다',
            body: '문서를 열면 이어서 요청할 수 있습니다.',
            actions: this.deps.openDocument ? [{ label: '문서 열기…', primary: true, run: () => this.deps.openDocument?.() }] : [],
          };
        case 'DOCUMENT_WRITER_BUSY':
          return {
            title: '다른 대화의 변경이 검토를 기다리고 있습니다',
            body: '그 변경을 적용하거나 거절하면 이 대화에서 문서를 고칠 수 있습니다.',
            actions: [{ label: '검토 목록 보기', primary: true, run: () => this.review?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }],
          };
        case 'STAGING_BASELINE_LOST':
          return {
            title: '변경을 되돌릴 기준을 잃었습니다',
            body: '되돌리려면 실행 취소(Ctrl+Z)를 쓰세요.',
            actions: [],
          };
        default:
          return {
            title: '편집기가 편집을 멈췄습니다',
            body: '실행 취소(Ctrl+Z)하거나 문서를 다시 연 뒤 다시 요청하세요.',
            actions: [],
          };
      }
    })();
    this.placeInTurn(this.buildCard({ tone: 'warn', iconName: 'alert', ...spec }), turn);
  }

  /** 끝난 편집을 대화에 한 줄로 남긴다 — 도구 묶음을 펼치지 않아도 무엇을 했는지 보인다 */
  private addDoneLine(turn: TurnView, text: string): void {
    const follow = this.isNearBottom();
    const tail = this.tail(turn);
    const prev = tail ? tail.previousElementSibling : turn.root.lastElementChild;
    if (follow) requestAnimationFrame(() => this.scrollToBottom());
    if (!turn.doneList || prev !== turn.doneList) {
      turn.doneList = el('ul', 'dg-done');
      turn.root.insertBefore(turn.doneList, tail);
      if (turn === this.turn) this.closeTextBlock();
    }
    const li = el('li', 'dg-done-item');
    li.append(icon('check', 13, 2.2), el('span', '', text));
    turn.doneList.append(li);
  }

  private addTool(turn: TurnView, callId: string, view: ToolCallView): void {
    const { label, summary, items } = view;
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
    // 묶음 편집은 무엇을 바꾸려는지 항목마다 한 줄씩 보인다
    let itemRows: HTMLLIElement[] | undefined;
    if (items && items.length > 0) {
      const ol = el('ol', 'dg-tool-items');
      itemRows = items.map((item) => {
        const row = el('li', 'dg-tool-item');
        row.append(el('span', 'dg-tool-label', item.label));
        if (item.summary) row.append(el('span', 'dg-tool-summary', item.summary));
        ol.append(row);
        return row;
      });
      li.append(ol);
    }
    turn.toolList!.append(li);
    turn.tools.set(callId, { li, label, view, ...(itemRows ? { items: itemRows } : {}) });
    this.updateChip(turn);
  }

  private updateChip(turn: TurnView): void {
    if (!turn.chipText) return;
    const entries = [...turn.tools.values()];
    const labels = [...new Set(entries.map((e) => e.label))];
    const shown = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` 외 ${labels.length - 3}개` : '');
    const running = entries.some((e) => e.li.dataset.state === 'running');
    // 다시 해낸 실패(retried)는 세지 않는다 — 끝내 못 한 것만 알린다
    const failed = entries.filter((e) => e.li.dataset.state === 'error').length;
    turn.chipText.textContent = `도구 ${entries.length}개 사용 · ${shown}${failed ? ` · ${failed}개 끝내지 못함` : ''}`;
    turn.chip!.dataset.state = running ? 'running' : failed ? 'error' : 'done';
    turn.chip!.title = failed ? `${failed}개를 끝내지 못했습니다` : '';
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
    // 검토 대기 중에는 목록 머리줄의 "모두 거절" 하나만 둔다. 이 단추는 적용한 뒤에만 보인다.
    const revert = button('dg-act dg-act-text', '', () => this.revertApplied(turn));
    revert.append(icon('undo', 14), el('span', 'dg-act-revert-text', '이 요청의 변경 되돌리기'));
    revert.classList.add('dg-act-revert');
    revert.hidden = true;
    row.append(copy, retry, revert);
    // 실패한 도구가 있으면 그것만 다시 해 달라고 요청한다(도구 재생은 프로토콜에 없어 같은 대화의 새 요청으로)
    const failed = [...new Set([...turn.tools.values()].filter((e) => e.li.dataset.state === 'error').map((e) => e.label))];
    if (failed.length > 0 && turn.userText) {
      const again = button('dg-act dg-act-text dg-act-failed', '', () => {
        if (this.busy) return;
        this.submit(`방금 실패한 작업(${failed.join(', ')})만 원인을 확인해 다시 시도해 줘.`);
      });
      again.append(icon('retry', 14), el('span', '', '끝내지 못한 작업만 다시 시도'));
      row.append(again);
    }
    this.renderTurnActions(turn, row);
    return row;
  }

  /**
   * "이 요청의 변경 되돌리기" 는 이 턴의 변경을 적용한 뒤, 문서가 그대로인 동안만 보인다.
   * 검토 대기 중의 되돌리기는 목록의 "모두 거절" 이 맡는다 (같은 일을 하는 단추를 둘 두지 않는다).
   */
  private renderTurnActions(turn: TurnView, row = turn.actions): void {
    const revert = row?.querySelector<HTMLButtonElement>('.dg-act-revert');
    if (!revert) return;
    const info = this.appliedOf(turn);
    revert.hidden = !info;
    revert.disabled = this.busy;
    if (info) {
      const text = revert.querySelector('.dg-act-revert-text');
      const label = info.whole ? '이 요청의 변경 되돌리기' : `적용한 변경 ${info.count}건 되돌리기`;
      if (text) text.textContent = label;
      revert.title = `적용한 변경 ${info.count}건을 요청 전 상태로 되돌립니다. 실행 취소(Ctrl+Z)와 같은 동작입니다.`;
    }
    for (const b of row?.querySelectorAll<HTMLButtonElement>('.dg-act-retry, .dg-act-failed') ?? []) b.disabled = this.busy;
  }

  /**
   * 이 턴이 "방금 적용한 묶음"의 마지막 턴이면 그 묶음. whole = 묶음이 모두 이 턴의 변경이다.
   * 적용 뒤 문서가 바뀌었으면(직접 편집·실행 취소·새 요청) null.
   */
  private appliedOf(turn: TurnView): { count: number; whole: boolean } | null {
    let info: { threadId: string; ids: string[]; count: number } | null = null;
    try { info = this.deps.pending?.revertInfo?.() ?? null; } catch { info = null; }
    if (!info || info.count === 0) return null;
    const owners = info.ids.map((id) => this.changeTurn.get(id));
    const last = [...this.thread.turns].reverse().find((t) => owners.includes(t));
    if (last !== turn) return null;
    return { count: info.count, whole: owners.every((t) => t === turn) };
  }

  /** 적용한 변경을 요청 전 상태로 되돌린다 — 실행기가 스냅샷으로 복원한다(되돌리기 1단계) */
  private revertApplied(turn: TurnView): void {
    if (this.busy) return;
    const pending = this.deps.pending;
    try {
      const reverted = pending?.revertAccepted?.().reverted ?? 0;
      if (reverted > 0) {
        this.addNotice(`적용한 변경 ${reverted}건을 되돌렸습니다.`, 'info');
        this.deps.hub.reviewDecision(turn.threadId, 'reject_all', `사용자가 방금 적용했던 변경 ${reverted}건을 모두 되돌렸습니다. 문서는 그 요청 전 상태입니다.`);
      } else {
        this.addNotice('그 뒤로 문서가 바뀌어 한 번에 되돌릴 수 없습니다. 실행 취소(Ctrl+Z)를 쓰세요.', 'info');
      }
    } catch (error) {
      this.addNotice(`되돌리지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    for (const t of this.thread.turns) if (t.done) this.renderTurnActions(t);
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
      // 검토 목록은 변경을 만든 턴의 맨 끝에 놓는다 — 도구 사용 → 답변 → 검토 목록 순서
      if (turn && this.review.parentElement !== turn.root) turn.root.append(this.review);
    }
    for (const t of this.thread.turns) if (t.done) this.renderTurnActions(t);
  }

  /**
   * 검토 목록은 review/list.ts(mountReviewList)가 그린다 — reviewStore 를 스스로 구독하고 비면 숨는다.
   * 여기서는 목록 상자를 변경을 만든 턴 안의 알맞은 자리에 놓기만 한다.
   */
  private renderReview(): void {
    const review = this.review;
    if (!review || !this.deps.pending) return;
    const rows = reviewStore.rows();
    if (rows.length > 0 && !this.thread.log.contains(review)) {
      // 다른 대화의 변경이면 이 대화 끝에 붙인다
      const owner = rows.map((r) => this.changeTurn.get(r.id)).find((t) => t && this.thread.turns.includes(t));
      if (owner) owner.root.append(review);
      else this.thread.log.append(review);
    }
    if (!this.reviewList) {
      this.reviewList = mountReviewList(review, {
        headHost: this.reviewBar,
        onError: (message) => this.addNotice(message, 'error'),
        title: (list) => list.some((r) => r.threadId !== this.thread.id && !this.changeTurn.has(r.id))
          ? '검토 대기 (다른 대화)'
          : '검토 대기',
        onRender: () => {
          for (const t of this.thread?.turns ?? []) if (t.done) this.renderTurnActions(t);
        },
      });
    } else {
      this.reviewList.render();
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

  // ─── 질문 카드 (ask_user_question) ─────────────────────

  /**
   * 에이전트의 되묻기를 선택 단추로 보인다. 기다리지 않고 곧바로 돌아온다 —
   * 사용자가 고른 답(또는 직접 적은 답)은 다음 메시지로 간다.
   */
  showQuestion(call: ToolCallMessage): { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } } {
    const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
    const question = typeof args['question'] === 'string' ? args['question'].trim() : '';
    const options = (Array.isArray(args['options']) ? args['options'] : [])
      .map((raw) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}))
      .map((o) => ({ label: typeof o['label'] === 'string' ? o['label'].trim() : '', description: typeof o['description'] === 'string' ? o['description'].trim() : '' }))
      .filter((o) => o.label);
    const turn = this.turn;
    if (call.origin !== 'agent' || !turn || turn.done || (call.threadId && call.threadId !== turn.threadId)) {
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: 'ask_user_question works only during a turn of the doogle sidebar chat — ask in prose instead.' } };
    }
    if (!question || options.length < 2) {
      return { ok: false, error: { code: 'INVALID_ARGS', message: 'ask_user_question needs a question and at least 2 options with labels' } };
    }
    if (this.askCards.some((card) => !card.answered && card.threadId === turn.threadId)) {
      return { ok: false, error: { code: 'INVALID_ARGS', message: 'A question is already on screen. Ask one question per turn — end your turn now and wait for the answer.' } };
    }
    const card = el('div', 'dg-card dg-ask');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `질문: ${question}`);
    card.append(el('div', 'dg-card-title dg-keep-all', question));
    const list = el('div', 'dg-ask-opts');
    const entry: AskCard = { root: card, options: [], other: null, threadId: turn.threadId, answered: false };
    for (const option of options) {
      const b = button('dg-ask-opt', '', () => this.answerQuestion(entry, b, option.label));
      b.append(el('span', 'dg-ask-label dg-keep-all', option.label));
      if (option.description) b.append(el('span', 'dg-ask-desc dg-keep-all', option.description));
      entry.options.push(b);
      list.append(b);
    }
    if (args['allowOther'] !== false) {
      entry.other = button('dg-ask-opt dg-ask-other', '직접 입력…', () => {
        this.awaitingAnswer = true;
        this.renderPlaceholder();
        this.input.focus();
      });
      list.append(entry.other);
    }
    card.append(list, el('p', 'dg-ask-wait', '응답이 끝나면 고를 수 있습니다.'));
    this.askCards.push(entry);
    this.placeInTurn(card, turn);
    this.renderAskCards();
    this.announce(`질문: ${question}`);
    return {
      ok: true,
      result: {
        shown: true,
        note: 'The question card is on screen. End your turn now — no more tool calls, at most one short sentence. The user\'s choice arrives as their next message.',
      },
    };
  }

  private answerQuestion(card: AskCard, picked: HTMLButtonElement, label: string): void {
    if (card.answered || this.busy) return;
    if (this.thread.id !== card.threadId) return;
    picked.setAttribute('aria-pressed', 'true');
    this.submit(label);
    // 보내지 못했으면(연결 끊김 등) 다시 고를 수 있게 둔다
    if (!card.answered) picked.removeAttribute('aria-pressed');
  }

  /** 이 대화의 열린 질문 카드를 닫는다 — 고른 단추만 남기고 나머지는 흐리게 */
  private closeAskCards(threadId: string, answer: string): void {
    for (const card of this.askCards) {
      if (card.answered || card.threadId !== threadId) continue;
      card.answered = true;
      card.root.dataset.answered = '1';
      const picked = card.options.find((b) => b.getAttribute('aria-pressed') === 'true');
      if (!picked && card.other) {
        card.other.textContent = `직접 입력: ${clipTitle(answer)}`;
        card.other.setAttribute('aria-pressed', 'true');
      }
    }
    this.awaitingAnswer = false;
    this.renderPlaceholder();
    this.renderAskCards();
  }

  /** 응답 중이거나 이미 답한 카드의 단추는 누를 수 없다 */
  private renderAskCards(): void {
    for (const card of this.askCards) {
      const locked = card.answered || this.busy;
      for (const b of [...card.options, ...(card.other ? [card.other] : [])]) b.disabled = locked;
      card.root.dataset.waiting = !card.answered && this.busy ? '1' : '';
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
