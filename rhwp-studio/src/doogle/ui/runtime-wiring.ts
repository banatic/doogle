/**
 * PluginHost → 실행기(agent E, `../agent/`) 의존성 연결.
 *
 * 실행기 모듈은 `import.meta.glob` 으로 찾는다. 아직 없거나 진입 함수 이름이 다르면 null 을 돌려주고
 * 사이드바는 실행기 없이(도구 호출은 NOT_IMPLEMENTED) 뜬다 — 병렬 작업 중에도 빌드가 깨지지 않게 하려는 것이다.
 */
import type { PluginHost, PluginCaret } from '@/plugin/types';
import type {
  DoogleAgentDeps,
  DoogleAgentRuntime,
  EngineDoc,
  PendingApi,
  PendingChangeEvent,
  SelectionInfo,
  SelectionPoint,
  ToolResult,
} from '../agent/types.ts';
import { getDocHub, type DocHub, type DocSession } from '../workspace/doc-hub.ts';

/** 초점 문서(탭)가 바뀌었다 — shell/index.ts 가 쏜다 */
const DOC_FOCUS_EVENT = 'doogle:doc-focus';

/** 문서 탭에서의 실행기 — 대화(thread)를 시작한 문서에 묶는 통로가 더 있다 */
export interface RoutedAgentRuntime extends DoogleAgentRuntime {
  /** 이 대화의 다음 턴은 지금 초점 문서를 고친다 — 사이드바가 요청을 보낼 때 부른다 */
  bindThread(threadId: string): void;
}

/** 도구가 지금 돌고 있는 문서(세션 id → 겹친 수). 문서 탭이 아니면 쓰지 않는다. */
const executing = new Map<number, number>();

/**
 * 에이전트 편집 표시(커서 무리)를 지금 화면에 그려도 되는가 — 도구가 초점 문서에서 돌고 있을 때만.
 * 탭을 바꾼 뒤에도 에이전트는 시작한 문서를 고치므로, 그 표시를 다른 문서 위에 그리면 안 된다.
 */
export function isAgentEditOnFocusedDocument(): boolean {
  const hub = getDocHub();
  if (!hub) return true;
  const focused = hub.focused;
  return !!focused && (executing.get(focused.id) ?? 0) > 0;
}

/**
 * 문서 위 검토 막(유리 팝오버·하단 알약)을 실행기와 함께 올리고 내린다.
 * 진입점(index.ts)을 고치지 않으려고 여기서 붙인다 — runtime.dispose 가 막도 걷는다.
 */
async function withReviewOverlay(host: PluginHost, runtime: DoogleAgentRuntime): Promise<DoogleAgentRuntime> {
  let overlay: { dispose(): void } | null = null;
  try {
    const { mountReviewOverlay } = await import('../review/overlay.ts');
    overlay = mountReviewOverlay(host, runtime.pending);
  } catch (error) {
    console.error('[doogle] 문서 위 검토 막을 올리지 못했습니다', error);
  }
  // 문서가 바뀌면 이전 문서의 검토 대기 목록을 바로 비운다 — 다음 tool 호출까지 남겨 두면
  // 그사이의 "모두 적용/거절" 이 새 문서에 옛 문서의 스냅샷 번호로 들어간다
  const offSwap = host.onDocumentSwap(() => {
    try { runtime.noteDocumentSwap?.(); } catch (error) { console.error('[doogle] 문서 교체 뒤 검토 목록 정리 실패', error); }
  });
  // 문서 탭: 막은 지금 문서의 스크롤 영역에 붙어 있다 — 초점 문서가 바뀌면 그 문서 위에 다시 올린다
  const onFocus = () => {
    if (!getDocHub()) return;
    overlay?.dispose();
    overlay = null;
    void import('../review/overlay.ts').then(({ mountReviewOverlay }) => {
      overlay?.dispose();
      overlay = mountReviewOverlay(host, runtime.pending);
    }).catch((error) => console.error('[doogle] 문서 위 검토 막을 옮기지 못했습니다', error));
  };
  window.addEventListener(DOC_FOCUS_EVENT, onFocus);
  return {
    ...runtime,
    pending: runtime.pending,
    dispose: () => {
      offSwap();
      window.removeEventListener(DOC_FOCUS_EVENT, onFocus);
      overlay?.dispose();
      runtime.dispose();
    },
  };
}

/** 세션 하나에 묶인 실행기 의존성 — host 를 부르는 동안만 "지금 문서"를 그 세션으로 본다(hub.scoped). */
function scopedDeps(host: PluginHost, hub: DocHub, session: DocSession): DoogleAgentDeps {
  const base = depsFromHost(host);
  return {
    getDocument: () => (session.disposed ? null : hub.scoped(session, () => base.getDocument())),
    transaction: (label, fn) => hub.scoped(session, () => base.transaction(label, fn)),
    // 그 문서의 이벤트만 듣는다 — 다른 탭에서의 편집이 이 문서의 revision 을 올리지 않게
    events: { on: (event, handler) => session.eventBus.on(event, (payload) => handler(payload)) },
    documentInstance: () => session.wasm.documentGeneration,
    getSelection: () => (session.disposed ? null : hub.scoped(session, () => base.getSelection?.() ?? null)),
    getDocumentName: () => session.wasm.fileName || null,
  };
}

/**
 * 문서 탭용 실행기 — 문서(세션)마다 실행기를 하나씩 두고 호출을 그 문서로 보낸다.
 *  - 도구 호출: 대화(threadId)가 묶인 문서로. 묶이지 않았으면(외부 MCP 등) 초점 문서로.
 *    탭을 바꿔도 진행 중인 대화의 편집은 시작한 문서에 들어간다.
 *  - 검토 대기 목록(pending): threadId 가 있으면 그 대화의 문서, 변경 id 가 있으면 그 변경이 있는 문서,
 *    둘 다 없으면 초점 문서.
 */
function createRoutedRuntime(
  host: PluginHost, hub: DocHub, factory: RuntimeFactory,
): RoutedAgentRuntime {
  const runtimes = new Map<number, DoogleAgentRuntime>();
  const offs = new Map<number, () => void>();
  const listeners = new Set<(e: PendingChangeEvent) => void>();
  const threadSession = new Map<string, number>();
  let base: DoogleAgentRuntime | null = null;

  const notify = (e: PendingChangeEvent) => {
    for (const cb of [...listeners]) {
      try { cb(e); } catch (error) { console.error('[doogle] 검토 목록 알림 실패', error); }
    }
  };

  const ensure = (session: DocSession | null): DoogleAgentRuntime | null => {
    if (!session || session.disposed) return null;
    const existing = runtimes.get(session.id);
    if (existing) return existing;
    const made = factory(scopedDeps(host, hub, session));
    if (made instanceof Promise) {
      console.error('[doogle] 문서별 실행기를 만들지 못했습니다(비동기 공장은 지원하지 않습니다)');
      return null;
    }
    runtimes.set(session.id, made);
    offs.set(session.id, made.pending.onChange((e) => {
      // 화면(사이드바·문서 위 막)은 초점 문서의 변경만 따른다
      if (hub.focused === session) notify(e);
    }));
    return made;
  };
  /** 문서가 없을 때 — 도구가 NO_DOCUMENT 로 답하게 하는 빈 실행기 */
  const baseRuntime = (): DoogleAgentRuntime | null => {
    if (base) return base;
    const made = factory(depsFromHost(host));
    if (made instanceof Promise) return null;
    base = made;
    return base;
  };
  const focusedPending = (): PendingApi | null => ensure(hub.focused)?.pending ?? null;
  const pendingOfThread = (threadId?: string): PendingApi | null => {
    const bound = threadId ? threadSession.get(threadId) : undefined;
    const session = bound !== undefined ? hub.byId(bound) : null;
    return (session ? ensure(session)?.pending : null) ?? focusedPending();
  };
  const pendingOfChange = (id?: string): PendingApi | null => {
    if (id) {
      for (const runtime of runtimes.values()) {
        if (runtime.pending.list().some((c) => c.id === id)) return runtime.pending;
      }
    }
    return focusedPending();
  };

  hub.pendingOf = (session) => runtimes.get(session.id)?.pending.list().filter((c) => !c.kept).length ?? 0;
  const offClose = hub.onClose((session) => {
    offs.get(session.id)?.();
    offs.delete(session.id);
    try { runtimes.get(session.id)?.dispose(); } catch (error) { console.error('[doogle] 실행기 정리 실패', error); }
    runtimes.delete(session.id);
    for (const [threadId, id] of threadSession) if (id === session.id) threadSession.delete(threadId);
  });
  // 초점 문서가 바뀌면 화면의 검토 목록도 그 문서의 것으로 — 구독자에게 한 번 알린다
  const onFocus = () => notify({ kind: 'added', threadId: null, changeSets: [] });
  window.addEventListener(DOC_FOCUS_EVENT, onFocus);

  const pending: PendingApi = {
    list: (threadId) => pendingOfThread(threadId)?.list(threadId) ?? [],
    acceptAll: (threadId) => pendingOfThread(threadId)?.acceptAll(threadId) ?? { accepted: 0 },
    rejectAll: (threadId) => pendingOfThread(threadId)?.rejectAll(threadId) ?? { rejected: 0, userEditsReverted: false },
    onChange: (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    hasPending: (threadId) => pendingOfThread(threadId)?.hasPending(threadId) ?? false,
    accept: (id) => pendingOfChange(id)?.accept?.(id) ?? { accepted: 0 },
    rejectFrom: (id) => pendingOfChange(id)?.rejectFrom?.(id) ?? { rejected: 0, userEditsReverted: false },
    hasUserEditsSince: (id) => pendingOfChange(id)?.hasUserEditsSince?.(id) ?? false,
    pageCount: () => focusedPending()?.pageCount?.() ?? 0,
    // 문서 위 강조는 지금 화면의 문서 것만 — 다른 문서의 변경 자리를 이 문서 위에 그리지 않는다
    rectsOf: (id) => (hub.focused && runtimes.get(hub.focused.id)?.pending.list().some((c) => c.id === id)
      ? focusedPending()?.rectsOf?.(id) ?? [] : []),
    revertInfo: () => focusedPending()?.revertInfo?.() ?? null,
    revertAccepted: () => focusedPending()?.revertAccepted?.() ?? { reverted: 0 },
  };

  return {
    async executeTool(name, args, ctx): Promise<ToolResult> {
      let session: DocSession | null;
      const bound = ctx.threadId ? threadSession.get(ctx.threadId) : undefined;
      if (bound !== undefined) {
        session = hub.byId(bound);
        if (!session) {
          return { ok: false, error: { code: 'NO_DOCUMENT', message: '이 대화가 고치던 문서의 탭이 닫혔습니다. 문서를 다시 열고 요청해 주세요.' } };
        }
      } else {
        session = hub.focused;
        // 묶이지 않은 대화(새로고침 뒤 이어진 턴 등)는 첫 호출 때의 초점 문서에 묶는다
        if (session && ctx.threadId && ctx.origin !== 'mcp') threadSession.set(ctx.threadId, session.id);
      }
      const runtime = session ? ensure(session) : baseRuntime();
      if (!runtime) return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: '두글 문서 실행기를 만들지 못했습니다' } };
      const key = session?.id ?? 0;
      executing.set(key, (executing.get(key) ?? 0) + 1);
      try {
        return await runtime.executeTool(name, args, ctx);
      } finally {
        const left = (executing.get(key) ?? 1) - 1;
        if (left > 0) executing.set(key, left); else executing.delete(key);
      }
    },
    pending,
    revision: () => ensure(hub.focused)?.revision() ?? 0,
    // 문서 탭에서는 세션의 문서가 갈리지 않는다(새 문서는 새 세션) — 할 일이 없다
    noteDocumentSwap: () => {},
    bindThread: (threadId) => {
      if (hub.focused) threadSession.set(threadId, hub.focused.id);
      else threadSession.delete(threadId);
    },
    dispose: () => {
      offClose();
      window.removeEventListener(DOC_FOCUS_EVENT, onFocus);
      hub.pendingOf = () => 0;
      for (const off of offs.values()) off();
      for (const runtime of runtimes.values()) runtime.dispose();
      base?.dispose();
      runtimes.clear();
      offs.clear();
    },
  };
}

type RuntimeFactory = (deps: DoogleAgentDeps) => DoogleAgentRuntime | Promise<DoogleAgentRuntime>;

const runtimeModules = import.meta.glob<Record<string, unknown>>([
  '../agent/index.ts',
  '../agent/runtime.ts',
]);

function point(caret: PluginCaret): SelectionPoint {
  return {
    sectionIndex: caret.sectionIndex,
    parentParaIndex: caret.parentParaIndex,
    cellPath: caret.cellPath.map((entry) => ({ ...entry })),
    charOffset: caret.charOffset,
  };
}

export function depsFromHost(host: PluginHost): DoogleAgentDeps {
  return {
    getDocument: () => (host.borrowDocument()?.handle as unknown as EngineDoc | undefined) ?? null,
    transaction: (label, fn) => host.transaction(label, (tx) => fn(tx.doc() as unknown as EngineDoc, { noChange: () => tx.noChange() })),
    events: {
      on: (event, handler) => host.events.on(event, (payload) => handler(payload)),
    },
    documentInstance: () => host.currentGeneration(),
    getSelection: (): SelectionInfo | null => {
      const caret = host.getCaret();
      const selection = host.getSelectionText();
      return {
        caret: caret ? point(caret) : null,
        selection: selection
          ? { start: point(selection.start), end: point(selection.end), text: selection.text, truncated: selection.truncated }
          : null,
      };
    },
    getDocumentName: () => {
      const title = document.title.replace(/ - rhwp-studio$/, '');
      return title && title !== 'rhwp-studio' ? title : null;
    },
  };
}

export async function createRuntime(host: PluginHost): Promise<DoogleAgentRuntime | null> {
  for (const [path, load] of Object.entries(runtimeModules)) {
    try {
      const mod = await load();
      const factory = mod['createDoogleAgentRuntime'];
      if (typeof factory === 'function') {
        const hub = getDocHub();
        if (hub) {
          const routed = createRoutedRuntime(host, hub, factory as RuntimeFactory);
          const wrapped = await withReviewOverlay(host, routed);
          return { ...wrapped, bindThread: routed.bindThread } as RoutedAgentRuntime;
        }
        const runtime = await (factory as RuntimeFactory)(depsFromHost(host));
        return withReviewOverlay(host, runtime);
      }
    } catch (error) {
      console.error(`[doogle] 실행기(${path})를 만들지 못했습니다`, error);
    }
  }
  console.warn('[doogle] 실행기(createDoogleAgentRuntime)를 찾지 못했습니다 — 도구 호출은 NOT_IMPLEMENTED 로 답합니다');
  return null;
}
