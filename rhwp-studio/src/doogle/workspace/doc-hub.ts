/**
 * 문서 묶음(탭) 관리 — 두글 전용.
 *
 * upstream 편집기는 "문서 하나"를 전제로 짜여 있다: `main.ts` 가 `wasm`·`eventBus`·`documentState`·
 * `autosaveManager` 를 하나씩 만들고, 메뉴·도구 모음·커맨드·플러그인이 그 객체를 붙잡는다.
 * 엔진(`engine/`·`view/`·`core/wasm-bridge`)은 인스턴스 단위라 문서마다 따로 만들 수 있다.
 *
 * 그래서 두글에서는 이렇게 한다:
 *  - 문서(탭)마다 **세션** 하나: WasmBridge(문서 IR) + EventBus + 편집기(CanvasView·InputHandler·Ruler…)
 *    + dirty 상태 + 자동 저장. WASM 모듈 자체는 하나를 같이 쓴다.
 *  - `main.ts` 의 전역 넷은 **대리 객체**다 — 부를 때마다 "지금 문서"(초점 세션)로 넘긴다. 그래서 리본·
 *    상태 표시줄·찾기·저장·인쇄·플러그인은 고치지 않아도 초점 문서를 대상으로 한다.
 *  - 전역 이벤트 버스는 초점 세션의 버스와만 이어진다. 초점이 아닌 문서의 이벤트는 그 세션 안에서만 돈다.
 *  - `scoped(session, fn)` 은 fn 이 도는 동안만 "지금 문서"를 그 세션으로 본다(동기 구간 전용).
 *    에이전트 tool call 을 시작한 문서에 묶을 때 쓴다 — 탭을 바꿔도 편집이 다른 문서로 새지 않는다.
 *
 * 비두글 모드에서는 이 파일의 어떤 것도 만들어지지 않는다(`getDocHub()` 가 null).
 */
import { EventBus } from '@/core/event-bus';
import { WasmBridge } from '@/core/wasm-bridge';
import { DocumentDirtyState } from '@/core/document-dirty-state';
import { AutosaveManager } from '@/recovery/autosave-manager';
import type { CanvasView } from '@/view/canvas-view';
import type { InputHandler } from '@/engine/input-handler';
import type { Ruler } from '@/view/ruler';
import type { RendererSession } from '@/view/renderer-session';
import type { DocumentAgentController } from '@/document-agent/controller';
import { getDocHub, registerDocHub } from './hub-ref.ts';

/** 세션 하나가 차지하는 화면 틀 — 눈금자 + 스크롤 영역. 칸(pane)의 쌓임 영역에 들어간다. */
export interface SessionFrame {
  root: HTMLElement;
  hRuler: HTMLCanvasElement;
  vRuler: HTMLCanvasElement;
  /** 스크롤 영역. 초점 세션의 것만 id="scroll-container" 를 갖는다. */
  container: HTMLElement;
}

/** main.ts 가 세션마다 만드는 편집기 묶음 */
export interface SessionEngine {
  canvasView: CanvasView;
  inputHandler: InputHandler;
  documentAgent: DocumentAgentController;
  ruler: Ruler | null;
  rendererSession: RendererSession;
}

export interface DocSession {
  readonly id: number;
  readonly wasm: WasmBridge;
  readonly eventBus: SessionBus;
  readonly documentState: DocumentDirtyState;
  readonly autosaveManager: AutosaveManager;
  readonly frame: SessionFrame;
  readonly engine: SessionEngine;
  /** main.ts 가 문서별로 들고 있던 값(구역 수·문서 글꼴 등) — 초점이 옮겨갈 때 넣고 뺀다 */
  vars: Record<string, unknown>;
  /** 전체 경로(데스크탑) · 마지막 저장 시각 — doc-state 가 초점 문서의 것을 여기에 적어 둔다 */
  path: string | null;
  savedAt: number | null;
  /** 새 문서로 만든 뒤 아직 손대지 않았다 — 다른 문서를 열면 이 탭을 대신 쓴다 */
  blank: boolean;
  /** 문서가 다 열렸다(열기 도중이 아니다) */
  ready: boolean;
  disposed: boolean;
  /** 세션을 닫을 때 부를 정리 함수 */
  readonly disposers: Array<() => void>;
}

/** main.ts 가 주는 세션 공장 — 틀이 화면에 붙은 뒤 불린다 */
export type SessionFactory = (frame: SessionFrame, bus: SessionBus, disposers: Array<() => void>) => Promise<Omit<DocSession,
  'id' | 'eventBus' | 'frame' | 'vars' | 'path' | 'savedAt' | 'blank' | 'ready' | 'disposed' | 'disposers'>>;

/** 화면(칸·탭 줄)이 hub 에 주는 것 — workspace.ts 가 구현한다 */
export interface WorkspaceUi {
  /** 초점 칸에 새 탭 자리를 만들고 틀을 돌려준다 */
  addFrame(): SessionFrame;
  /** 세션이 만들어졌다 — 탭을 그 세션에 잇는다 */
  attach(frame: SessionFrame, session: DocSession): void;
  /** 틀(과 탭)을 없앤다 */
  removeFrame(frame: SessionFrame): void;
  /** 세션 목록·초점·이름·dirty 가 바뀌었다 — 탭 줄을 다시 그린다 */
  refresh(): void;
}

/**
 * 초점이 옮겨갈 때 이어서 다시 내보내는 "지금 상태" 이벤트와, 그 문서가 한 번도 내지 않았을 때의 기본값.
 * 기본값이 없는 것은 그 문서가 낸 적이 있을 때만 다시 낸다.
 */
const STICKY_EVENTS: Record<string, unknown[] | null> = {
  'headerFooterModeChanged': ['none'],
  'footnoteModeChanged': [false],
  'insert-mode-changed': [true],
  'field-info-changed': [null],
  'cell-selection-phase-changed': [null],
  'picture-object-selection-changed': [false],
  'table-object-selection-changed': [false],
  'zoom-level-display': null,
  'current-page-changed': null,
  'cursor-format-changed': null,
  'cursor-para-changed': null,
  'cursor-style-changed': null,
  'cursor-cell-changed': null,
  'highlight-pen-changed': null,
};

/** 문서가 하나도 없게 됐을 때 화면에 되돌려 놓을 값 */
const EMPTY_STATE_EVENTS: Record<string, unknown[]> = {
  'zoom-level-display': [1],
  'current-page-changed': [0, 1],
};

/** 전역에서 낸 것을 열린 문서 모두가 들어야 하는 이벤트(보기 설정·테마) */
const BROADCAST_EVENTS = new Set(['theme-changed', 'page-view-settings-changed', 'grid-view-changed']);

function deliver(bus: EventBus, event: string, args: unknown[]): unknown {
  try {
    EventBus.prototype.emit.call(bus, event, ...args);
    return null;
  } catch (error) {
    return { error };
  }
}

/** 세션(문서) 하나의 이벤트 버스. 초점 세션이면 낸 이벤트가 전역 구독자에게도 간다. */
export class SessionBus extends EventBus {
  readonly sticky = new Map<string, unknown[]>();
  private readonly hub: DocHub;

  constructor(hub: DocHub) {
    super();
    this.hub = hub;
  }

  emit(event: string, ...args: unknown[]): void {
    if (event in STICKY_EVENTS) this.sticky.set(event, args);
    const local = deliver(this, event, args) as { error: unknown } | null;
    const global = this.hub.focused?.eventBus === this
      ? deliver(this.hub.eventBus, event, args) as { error: unknown } | null
      : null;
    const failure = local ?? global;
    if (failure) throw failure.error;
  }

  /** 세션 안 구독자에게만 */
  emitLocal(event: string, ...args: unknown[]): void {
    const failure = deliver(this, event, args) as { error: unknown } | null;
    if (failure) throw failure.error;
  }
}

/** 전역 이벤트 버스. 전역에서 낸 이벤트는 전역 구독자 + "지금 문서" 세션의 구독자에게 간다. */
export class HubBus extends EventBus {
  private readonly hub: DocHub;

  constructor(hub: DocHub) {
    super();
    this.hub = hub;
  }

  emit(event: string, ...args: unknown[]): void {
    let failure = deliver(this, event, args) as { error: unknown } | null;
    const targets = BROADCAST_EVENTS.has(event)
      ? this.hub.sessions
      : [this.hub.current()].filter((s): s is DocSession => !!s);
    for (const session of targets) {
      if (event in STICKY_EVENTS) session.eventBus.sticky.set(event, args);
      failure ??= deliver(session.eventBus, event, args) as { error: unknown } | null;
    }
    if (failure) throw failure.error;
  }

  /** 전역 구독자에게만 — 초점이 옮겨간 뒤 화면 상태를 다시 맞출 때 쓴다 */
  emitGlobal(event: string, ...args: unknown[]): void {
    const failure = deliver(this, event, args) as { error: unknown } | null;
    if (failure) throw failure.error;
  }
}

/** 부를 때마다 resolve() 가 준 객체로 넘기는 대리 객체 */
function facade<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const target = resolve();
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, key, value) {
      const target = resolve();
      return Reflect.set(target, key, value, target);
    },
    has(_target, key) {
      return key in resolve();
    },
  });
}

export type FocusListener = (next: DocSession | null, prev: DocSession | null) => void;

export class DocHub {
  readonly sessions: DocSession[] = [];
  focused: DocSession | null = null;
  private scopedSession: DocSession | null = null;
  private nextId = 1;
  private factory: SessionFactory | null = null;
  private ui: WorkspaceUi | null = null;
  /** 그 문서에 검토 대기 중인 에이전트 변경 수 — 실행기를 잇는 쪽(runtime-wiring)이 채운다 */
  pendingOf: (session: DocSession) => number = () => 0;
  /** 문서를 여는 중 — 끝날 때까지 탭을 바꾸지 못한다(열기 코드가 "지금 문서"에 이어서 쓴다) */
  private opening = false;

  /** 문서가 하나도 없을 때의 빈 대상 */
  readonly baseWasm = new WasmBridge();
  private readonly baseState = new DocumentDirtyState(new EventBus());
  private readonly baseAutosave = new AutosaveManager({ exportBytes: () => new Uint8Array() });

  readonly eventBus = new HubBus(this);
  readonly wasm = facade<WasmBridge>(() => this.current()?.wasm ?? this.baseWasm);
  readonly documentState = facade<DocumentDirtyState>(() => this.current()?.documentState ?? this.baseState);
  readonly autosaveManager = facade<AutosaveManager>(() => this.current()?.autosaveManager ?? this.baseAutosave);

  /** "지금 문서"가 바뀔 때(초점 이동·scoped 드나듦) — main.ts 가 자기 변수(canvasView 등)를 갈아 끼운다 */
  private applyListeners: Array<(session: DocSession | null) => void> = [];
  /** 초점이 옮겨가기 직전(prev 가 아직 "지금 문서") */
  private blurListeners: FocusListener[] = [];
  /** 초점이 옮겨간 뒤 */
  private focusListeners: FocusListener[] = [];
  /** 세션이 닫힌 뒤 */
  private closeListeners: Array<(session: DocSession) => void> = [];

  /** 지금 문서 — scoped 중이면 그 세션, 아니면 초점 세션 */
  current(): DocSession | null {
    return this.scopedSession ?? this.focused;
  }

  get isOpening(): boolean {
    return this.opening;
  }

  setFactory(factory: SessionFactory): void {
    this.factory = factory;
  }

  setUi(ui: WorkspaceUi): void {
    this.ui = ui;
  }

  onApply(cb: (session: DocSession | null) => void): void {
    this.applyListeners.push(cb);
  }

  onBlur(cb: FocusListener): void {
    this.blurListeners.push(cb);
  }

  onFocus(cb: FocusListener): () => void {
    this.focusListeners.push(cb);
    return () => { this.focusListeners = this.focusListeners.filter((fn) => fn !== cb); };
  }

  onClose(cb: (session: DocSession) => void): () => void {
    this.closeListeners.push(cb);
    return () => { this.closeListeners = this.closeListeners.filter((fn) => fn !== cb); };
  }

  byId(id: number): DocSession | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  /** 탭 줄을 다시 그리게 한다(이름·dirty 가 바뀌었을 때) */
  refreshUi(): void {
    this.ui?.refresh();
  }

  /** 모달이 떠 있거나 문서를 여는 중이면 초점을 옮기지 않는다 */
  canSwitch(): boolean {
    return !this.opening && !document.querySelector('.modal-overlay, dialog[open]');
  }

  private apply(session: DocSession | null): void {
    for (const cb of this.applyListeners) {
      try { cb(session); } catch (error) { console.error('[doogle] 문서 전환 실패', error); }
    }
  }

  /**
   * fn 이 도는 동안만 "지금 문서"를 session 으로 본다. **동기 구간 전용** — fn 안에서 await 하면 안 된다.
   * 닫힌 세션이면 던진다.
   */
  scoped<T>(session: DocSession, fn: () => T): T {
    if (session.disposed) throw new Error('문서가 이미 닫혔습니다');
    if (this.current() === session) return fn();
    const before = this.scopedSession;
    this.scopedSession = session;
    this.apply(session);
    try {
      return fn();
    } finally {
      this.scopedSession = before;
      this.apply(this.current());
    }
  }

  /** 초점을 옮긴다. 옮겼으면 true. force 는 열기·닫기 내부 전환용(잠금을 넘는다). */
  focus(session: DocSession | null, force = false): boolean {
    if (session === this.focused) return true;
    if (session?.disposed) return false;
    if (!force && !this.canSwitch()) return false;
    const prev = this.focused;
    for (const cb of this.blurListeners) {
      try { cb(session, prev); } catch (error) { console.error('[doogle] 초점 이동 준비 실패', error); }
    }
    this.focused = session;
    this.apply(this.current());
    // id="scroll-container" 를 새 문서의 스크롤 영역으로 먼저 옮긴다 — 아래 구독자들이 그 id 로 찾는다
    this.ui?.refresh();
    // 화면 상태(쪽·배율·삽입/수정·머리말 편집 등)를 새 문서의 것으로 맞춘다
    for (const [event, fallback] of Object.entries(STICKY_EVENTS)) {
      const args = session?.eventBus.sticky.get(event)
        ?? (prev?.eventBus.sticky.has(event) || !session ? fallback : null)
        ?? (session ? null : EMPTY_STATE_EVENTS[event] ?? null);
      if (!args) continue;
      try { this.eventBus.emitGlobal(event, ...args); } catch (error) { console.error(`[doogle] ${event} 다시 내기 실패`, error); }
    }
    for (const cb of this.focusListeners) {
      try { cb(session, prev); } catch (error) { console.error('[doogle] 초점 이동 알림 실패', error); }
    }
    try { this.eventBus.emitGlobal('command-state-changed'); } catch { /* 표시 갱신 */ }
    this.ui?.refresh();
    return true;
  }

  /** 새 세션(빈 탭)을 초점 칸에 만든다. 초점은 옮기지 않는다. */
  private async createSession(): Promise<DocSession> {
    if (!this.factory || !this.ui) throw new Error('문서 영역이 아직 준비되지 않았습니다');
    const frame = this.ui.addFrame();
    try {
      const bus = new SessionBus(this);
      const disposers: Array<() => void> = [];
      const parts = await this.factory(frame, bus, disposers);
      const session: DocSession = {
        ...parts,
        id: this.nextId++,
        eventBus: bus,
        frame,
        vars: {},
        path: null,
        savedAt: null,
        blank: false,
        ready: false,
        disposed: false,
        disposers,
      };
      this.sessions.push(session);
      this.ui.attach(frame, session);
      return session;
    } catch (error) {
      this.ui.removeFrame(frame);
      throw error;
    }
  }

  /**
   * 새 탭을 만들어 초점을 옮긴 뒤 run 을 돌린다(run 은 "지금 문서"에 문서를 연다 — main.ts 의 기존 열기 코드).
   * 실패하면 탭을 없애고 이전 문서로 돌아간다. 성공하면, 이전 문서가 손대지 않은 새 문서였을 때 그 탭을 닫는다.
   */
  async openInNewSession(run: () => Promise<void>, options: { blank?: boolean } = {}): Promise<DocSession> {
    if (this.opening) throw new Error('다른 문서를 여는 중입니다. 끝난 뒤 다시 시도해 주세요.');
    this.opening = true;
    const prev = this.focused;
    let session: DocSession | null = null;
    try {
      session = await this.createSession();
      this.focus(session, true);
      await run();
      if (session.wasm.pageCount === 0) throw new Error('문서를 열지 못했습니다');
      session.ready = true;
      session.blank = options.blank === true;
    } catch (error) {
      if (session) this.dispose(session, prev);
      throw error;
    } finally {
      this.opening = false;
    }
    if (prev && prev !== session && prev.blank && !prev.documentState.isDirty() && !prev.disposed) {
      this.dispose(prev, session);
    }
    this.ui?.refresh();
    return session;
  }

  /**
   * 세션을 닫는다(확인은 부르는 쪽이 이미 마쳤다). 초점 세션이었으면 next 로 옮긴다.
   * 자동 저장 임시본은 지운다 — 사용자가 닫기로 한 문서다.
   */
  dispose(session: DocSession, next?: DocSession | null): void {
    if (session.disposed) return;
    const index = this.sessions.indexOf(session);
    if (index >= 0) this.sessions.splice(index, 1);
    if (this.focused === session) {
      const fallback = next && !next.disposed ? next : (this.sessions[Math.min(index, this.sessions.length - 1)] ?? null);
      this.focus(fallback, true);
    }
    session.disposed = true;
    void session.autosaveManager.discardCurrentDraft('tab-closed').catch(() => undefined);
    for (const off of session.disposers.splice(0).reverse()) {
      try { off(); } catch (error) { console.error('[doogle] 문서 정리 실패', error); }
    }
    const { engine } = session;
    const steps: Array<() => void> = [
      () => engine.documentAgent.dispose(),
      () => engine.inputHandler.dispose(),
      () => engine.ruler?.dispose(),
      () => engine.canvasView.dispose(),
      () => engine.rendererSession.dispose(),
      () => session.autosaveManager.dispose(),
      () => session.eventBus.removeAll(),
      () => session.wasm.releaseDocument(),
    ];
    for (const step of steps) {
      try { step(); } catch (error) { console.error('[doogle] 문서 정리 실패', error); }
    }
    this.ui?.removeFrame(session.frame);
    for (const cb of this.closeListeners) {
      try { cb(session); } catch (error) { console.error('[doogle] 문서 닫힘 알림 실패', error); }
    }
    this.ui?.refresh();
  }
}

/** 두글 모드에서 main.ts 가 한 번 부른다 */
export function createDocHub(): DocHub {
  const existing = getDocHub();
  if (existing) return existing;
  const hub = new DocHub();
  registerDocHub(hub);
  return hub;
}

export { getDocHub };
