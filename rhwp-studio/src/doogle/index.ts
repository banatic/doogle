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
    .catch((error) => console.error('[doogle] 셸을 올리지 못했습니다', error));
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

  sidebar = new DoogleSidebar({
    hub,
    pending: runtime?.pending ?? null,
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
    onVisibilityChange: (open) => sidebar.setVisible(open),
  });
  host.automation.registerCommand({
    id: DOOGLE_TOGGLE_COMMAND,
    label: '두글 에이전트',
    execute: () => { host.ui.toggleSidePanel(DOOGLE_PANEL_ID); },
  });
  host.automation.addMenuItem({ menuId: 'tool', commandId: DOOGLE_TOGGLE_COMMAND, position: 'top' });

  const offs: Array<() => void> = [];
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
    offs.push(await desk.onHubEvent((event) => {
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
  host.ui.toggleSidePanel(DOOGLE_PANEL_ID, true);

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
  } catch (error) {
    console.error('[doogle] 문서를 열지 못했습니다', path, error);
  }
}
