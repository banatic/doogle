/**
 * 두글(doogle) studio 진입점.
 *
 * upstream `main.ts` 는 이 파일만 정적으로 import 한다 — 그래서 여기에는 가벼운 판정 함수와
 * 플러그인 껍데기만 두고, 화면·hub 클라이언트·실행기는 `activate` 때 동적 import 한다.
 * 두글 모드가 아니면(Tauri 아님 + `?doogle=1` 없음) 아무 것도 올라오지 않는다.
 *
 * 문서는 `PluginHost` 로만 만진다(upstream 플러그인 계약) — 쓰기는 `host.transaction` 이라
 * 도구 호출 1건 = undo 1단계다.
 */
import type { PluginHost, PluginSurface, StudioPlugin } from '@/plugin/types';
import { PLUGIN_API_VERSION } from '@/plugin/types';
// 두글 셸(시안 F) 스타일 — 전부 `:root[data-doogle]` 범위라 비두글 모드에는 영향이 없다.
// 정적 import 로 두어야 upstream 크롬이 잠깐 보였다 사라지는 깜빡임이 없다. JS 는 아래에서 동적 로드.
import './theme/tokens.css';
import './theme/overlays.css';
import './shell/shell.css';

export const DOOGLE_PLUGIN_ID = 'doogle';
export const DOOGLE_PANEL_ID = 'agent';
export const DOOGLE_TOGGLE_COMMAND = 'ext:doogle.toggle-panel';
export const DOOGLE_OPEN_COMMAND = 'ext:doogle.open-native';
/** 사이드바 열림 상태 기억 ('1' | '0'). 없으면 첫 실행 — 그때만 자동으로 연다 (UI_AUDIT §3.5). */
const STORE_PANEL = 'doogle.panel';
/** 에이전트 서비스 연결 상태를 셸(상태 표시줄 등)에 알리는 window 이벤트 */
export const HUB_STATE_EVENT = 'doogle:hub-state';

/** 두글 데스크탑(Tauri) 안이거나 URL 에 `?doogle=1` 이 있으면 두글 모드다. */
export function isDoogleMode(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return true;
  try {
    return new URLSearchParams(window.location.search).get('doogle') === '1';
  } catch {
    return false;
  }
}

// 두글 모드면 문서 로드 전부터 셸(제목 막대·리본)을 세운다. host 가 필요한 부분은 initDoogle 에서 잇는다.
if (isDoogleMode()) {
  document.documentElement.setAttribute('data-doogle', '');
  void import('./shell/index.ts')
    .then((shell) => shell.mountShell())
    .catch((error) => console.error('[doogle] 셸을 올리지 못했습니다', error))
    // 부팅 가림막(public/theme-init.js)을 걷는다 — 셸이 붙은 뒤 첫 프레임에서. 실패해도 걷는다.
    .finally(() => requestAnimationFrame(() => document.documentElement.removeAttribute('data-doogle-booting')));
}

export const dooglePlugin: StudioPlugin = {
  id: DOOGLE_PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  activate: (host) => initDoogle(host),
  deactivate: () => {
    activeDispose?.();
    activeDispose = null;
  },
};

let activeDispose: (() => void) | null = null;

/**
 * 실행기(agent E) + hub 클라이언트 + 사이드바를 잇는다. 플러그인 활성화 때 한 번 부른다.
 */
export async function initDoogle(host: PluginHost): Promise<PluginSurface> {
  const [{ HubClient, endpointFromUrl }, { DoogleSidebar }, desk, { createRuntime }, shell] = await Promise.all([
    import('./hub-client.ts'),
    import('./ui/sidebar.ts'),
    import('./ui/desk-bridge.ts'),
    import('./ui/runtime-wiring.ts'),
    import('./shell/index.ts'),
  ]);
  shell.attachShellHost(host);

  const runtime = await createRuntime(host);
  let mode: 'agent' | 'full' = 'agent';

  // eslint-disable-next-line prefer-const
  let sidebar: InstanceType<typeof DoogleSidebar>;
  const hub = new HubClient({
    resolveEndpoint: async () => (desk.isDesk() ? desk.hubInfo() : endpointFromUrl()),
    onToolCall: async (call) => {
      sidebar?.noteExternalTool(call);
      if (!runtime) {
        return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: '두글 문서 실행기가 아직 없습니다' } };
      }
      // 외부(MCP) 쓰기도 검토 파이프라인을 지난다(PLAN §2). hub 가 mode 를 실어 보내면 그 값을 쓴다.
      const callMode = (call as { mode?: unknown }).mode;
      const effective = callMode === 'agent' || callMode === 'full'
        ? callMode
        : call.origin === 'mcp' ? 'agent' : mode;
      return runtime.executeTool(call.name, call.args, {
        origin: call.origin,
        ...(call.threadId ? { threadId: call.threadId } : {}),
        mode: effective,
      });
    },
  });

  const openDocument = () => {
    const id = desk.isDesk() ? DOOGLE_OPEN_COMMAND : 'file:open';
    try {
      host.automation.execute(id, {}, { allowDialog: true });
    } catch (error) {
      console.error('[doogle] 열기를 실행하지 못했습니다', error);
    }
  };

  sidebar = new DoogleSidebar({
    hub,
    pending: runtime?.pending ?? null,
    getDocContext: () => docContext(host),
    openDocument,
    isDesk: desk.isDesk(),
    openHubLog: () => desk.openHubLog(),
    getContext: () => {
      const selection = host.getSelectionText();
      const documentName = currentDocumentName();
      return {
        ...(selection?.text ? { selection: selection.text } : {}),
        ...(documentName ? { documentName } : {}),
      };
    },
    openExternal: (url) => desk.openExternal(url),
    onModeChange: (next) => { mode = next; },
  });
  mode = sidebar.state.mode;

  host.ui.registerSidePanel({
    id: DOOGLE_PANEL_ID,
    title: '두글 에이전트',
    defaultWidth: 420,
    mount: (container) => sidebar.mount(container),
    unmount: () => sidebar.dispose(),
    onVisibilityChange: (open) => {
      storeSet(STORE_PANEL, open ? '1' : '0');
      sidebar.setVisible(open);
    },
  });
  host.automation.registerCommand({
    id: DOOGLE_TOGGLE_COMMAND,
    label: '두글 에이전트',
    execute: () => { host.ui.toggleSidePanel(DOOGLE_PANEL_ID); },
  });
  host.automation.addMenuItem({ menuId: 'tool', commandId: DOOGLE_TOGGLE_COMMAND, position: 'top' });

  const offs: Array<() => void> = [];
  // 상황별 제안 칩: 문서·선택·커서가 바뀌면 사이드바가 (빈 대화일 때만) 다시 고른다
  fieldsCache = null;
  const refreshContext = () => sidebar.refreshContext();
  offs.push(host.onDocumentSwap(() => { fieldsCache = null; refreshContext(); }));
  for (const name of ['command-state-changed', 'cursor-format-changed', 'field-info-changed']) {
    offs.push(host.events.on(name, refreshContext));
  }
  offs.push(host.events.on('document-changed', () => { fieldsCache = null; refreshContext(); }));
  // 셸이 내는 문서 상태(dirty·형식·경로) — 문서가 바뀌었을 수 있다
  window.addEventListener('doogle:doc-state', refreshContext);
  offs.push(() => window.removeEventListener('doogle:doc-state', refreshContext));
  // 연결 상태를 셸 표면(상태 표시줄 점 등)에 알린다 — 상태는 한 곳(HubClient)에서 여러 표면으로
  offs.push(hub.onState((state, detail) => {
    window.dispatchEvent(new CustomEvent(HUB_STATE_EVENT, { detail: { state, detail } }));
  }));
  // 문서가 없을 때의 캔버스 빈 상태
  const { mountEmptyCanvas } = await import('./ui/empty-canvas.ts');
  offs.push(mountEmptyCanvas(host, { openDocument }));

  if (desk.isDesk()) {
    host.automation.registerCommand({
      id: DOOGLE_OPEN_COMMAND,
      label: '열기(두글)…',
      opensDialog: true,
      execute: async () => {
        const path = await desk.pickOpenFile();
        if (path) await openPath(host, desk, path);
      },
    });
    host.automation.addMenuItem({ menuId: 'file', commandId: DOOGLE_OPEN_COMMAND, position: 'top' });
    // hub.rs: ready · exited{restartInMs} · failed{message} — 연결 카드가 원인·카운트다운을 보인다
    offs.push(await desk.onHubEvent((event) => {
      sidebar.noteDeskHubEvent(event);
      if (event?.state === 'ready') hub.reconnectNow();
    }));
    const drainOpens = async () => {
      const paths = await desk.takeOpenRequests().catch(() => [] as string[]);
      // 한 창에 문서 하나 — 여러 개가 오면 마지막 것을 연다.
      const last = paths[paths.length - 1];
      if (last) await openPath(host, desk, last);
    };
    offs.push(await desk.onOpenRequest(() => void drainOpens()));
    void drainOpens();
  }

  hub.start();
  // 첫 실행에만 자동으로 열고, 이후에는 마지막 열림 상태를 따른다
  const remembered = storeGet(STORE_PANEL);
  if (remembered === null || remembered === '1') host.ui.toggleSidePanel(DOOGLE_PANEL_ID, true);

  activeDispose = () => {
    for (const off of offs) off();
    hub.stop();
    runtime?.dispose();
  };

  return {
    /** 패널 열림 여부 — e2e 가 화면 대신 상태로 확인하는 자리 */
    isPanelOpen: () => host.ui.isSidePanelOpen(DOOGLE_PANEL_ID),
    togglePanel: (open?: boolean) => host.ui.toggleSidePanel(DOOGLE_PANEL_ID, open),
    hubState: () => ({ state: hub.state, detail: hub.detail, version: hub.version }),
    sidebarState: () => sidebar.state,
    hasRuntime: () => runtime !== null,
  };
}

function storeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 무시 */ }
}

/** 누름틀 유무 — 문서가 바뀔 때만 다시 센다 */
let fieldsCache: boolean | null = null;

function hasFields(host: PluginHost): boolean {
  if (fieldsCache !== null) return fieldsCache;
  try {
    fieldsCache = host.read((doc) => {
      const raw = (doc as unknown as { getFieldList?: () => unknown }).getFieldList?.();
      const list = typeof raw === 'string' ? (raw ? JSON.parse(raw) : []) : raw;
      return Array.isArray(list) && list.length > 0;
    });
  } catch {
    fieldsCache = false;
  }
  return fieldsCache;
}

/** 상황별 제안 칩의 입력 — automation 게이트와 같은 EditorContext 를 읽는다 */
function docContext(host: PluginHost): { hasDocument: boolean; hasSelection: boolean; inTable: boolean; hasFields: boolean } {
  const hasDocument = host.borrowDocument() !== null;
  if (!hasDocument) return { hasDocument, hasSelection: false, inTable: false, hasFields: false };
  let ctx: { hasSelection?: boolean; inTable?: boolean } = {};
  try { ctx = host.automation.getContext(); } catch { /* 화면 없는 구성 */ }
  return {
    hasDocument,
    hasSelection: !!ctx.hasSelection && !!host.getSelectionText()?.text,
    inTable: !!ctx.inTable,
    hasFields: hasFields(host),
  };
}

function currentDocumentName(): string {
  const title = document.title.replace(/ - rhwp-studio$/, '');
  return title === 'rhwp-studio' ? '' : title;
}

async function openPath(
  host: PluginHost,
  desk: typeof import('./ui/desk-bridge.ts'),
  path: string,
): Promise<void> {
  try {
    const bytes = await desk.readFile(path);
    await host.loadDocument(bytes, desk.baseName(path));
    // shell 의 제목 표시줄·최근 문서 카드·「폴더에서 보기」가 경로를 알 수 있게 알린다.
    window.dispatchEvent(new CustomEvent('doogle:doc-path', { detail: { path } }));
  } catch (error) {
    console.error('[doogle] 문서를 열지 못했습니다', path, error);
  }
}
