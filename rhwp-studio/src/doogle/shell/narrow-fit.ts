/**
 * 좁은 창 대응 — 창이 좁아 문서가 폭에 다 들어오지 않으면 배율을 잠깐 줄였다가, 넓어지면 되돌린다.
 *
 * 사이드바를 연 채 창을 줄이면 문서 영역이 쪽 너비보다 좁아져 쪽의 왼쪽이 잘린다
 * (가운데 정렬된 쪽의 왼쪽 넘침은 스크롤로도 닿지 않는다). 사이드바 폭 자체는 CSS 가 줄이고
 * (shell.css: 1100px 아래 340px, 900px 아래는 문서 위에 겹치는 서랍), 여기서는 그래도 모자랄 때
 * 배율을 문서 영역 폭에 맞춘다.
 *
 *  - 사용자가 고른 맞춤 규칙(폭 맞춤·쪽 맞춤)은 건드리지 않는다: `view:zoom-set` 은 수치만 바꾼다.
 *  - 우리가 줄인 배율을 사용자가 직접 바꾸면 손을 뗀다(되돌리지 않는다).
 */
import type { PluginHost } from '@/plugin/types';
import { getDocHub } from '../workspace/hub-ref.ts';

/** 셸이 건네는 upstream 창구 (studio.ts) — 이 모듈은 DOM·호스트 밖의 의존이 없게 둔다(단위 시험) */
export interface NarrowFitStudio {
  context(): { hasDocument: boolean; zoom: number } | null;
  run(id: string, params?: Record<string, unknown>): boolean;
}

/** 이 너비보다 좁은 창에서만 배율에 손댄다 (shell.css 의 사이드바 축소 기준과 같다) */
export const NARROW_WINDOW_PX = 1100;
/** 쪽 양옆에 남길 여백 (upstream 폭 맞춤과 같은 값) */
const FRAME_PADDING_PX = 40;
const MIN_PERCENT = 30;

interface AutoFit {
  /** 우리가 줄이기 전 배율(%) — 넓어지면 여기로 돌아간다 */
  prev: number;
  /** 우리가 마지막으로 넣은 배율(%) */
  applied: number;
}

/**
 * 지금 넣어야 할 배율(%)을 정한다. 바꿀 것이 없으면 null. 순수 함수 (테스트용 export).
 * @param zoom 지금 배율(%)  @param fit 문서 영역에 쪽이 다 들어오는 배율(%)
 */
export function nextAutoFit(
  auto: AutoFit | null, zoom: number, fit: number, narrow: boolean,
): { auto: AutoFit | null; set: number | null } {
  let state = auto;
  // 사용자가 배율을 직접 바꿨다 — 그 선택을 따른다
  if (state && Math.abs(zoom - state.applied) > 1) state = null;
  if (!state) {
    if (narrow && fit < zoom - 1) {
      const applied = Math.max(MIN_PERCENT, fit);
      return { auto: { prev: zoom, applied }, set: applied };
    }
    return { auto: null, set: null };
  }
  const target = narrow ? Math.max(MIN_PERCENT, Math.min(state.prev, fit)) : state.prev;
  const set = Math.abs(target - zoom) > 1 ? target : null;
  return { auto: target >= state.prev ? null : { prev: state.prev, applied: target }, set };
}

/** 문서 하나의 맞춤 기억 */
export interface FitMemory {
  auto: AutoFit | null;
  /** 지난번에 본(또는 우리가 넣은) 배율(%) — 그사이 달라졌으면 사용자가 직접 바꾼 것이다 */
  lastZoom: number | null;
  /** 사용자가 고른 배율을 지키는 중 — 쪽이 넘쳐도 줄이지 않는다 */
  hold: boolean;
}

/**
 * `nextAutoFit` 에 "사용자가 직접 고른 배율은 넘쳐도 줄이지 않는다"를 더한 것. 순수 함수 (테스트용 export).
 *
 * 좁은 자리(좁은 창·나눈 칸·메모 말풍선 자리)에서 확대하면 쪽이 넘친다 — 그 뒤 크기를 다시 잴 때마다
 * 폭 맞춤으로 되돌리면 확대를 할 수 없다. 사용자가 배율을 바꾼 것을 보면 손을 떼고, 그 배율이 다시
 * 폭에 들어오거나 좁은 상태가 풀릴 때까지 그대로 둔다.
 */
export function nextFit(
  memory: FitMemory | null, zoom: number, fit: number, narrow: boolean,
): { memory: FitMemory; set: number | null } {
  let hold = memory?.hold ?? false;
  const lastZoom = memory?.lastZoom ?? null;
  if (lastZoom !== null && Math.abs(zoom - lastZoom) > 1) hold = true;
  if (hold && (!narrow || fit >= zoom - 1)) hold = false;
  if (hold) return { memory: { auto: null, lastZoom: zoom, hold: true }, set: null };
  const next = nextAutoFit(memory?.auto ?? null, zoom, fit, narrow);
  return { memory: { auto: next.auto, lastZoom: next.set ?? zoom, hold: false }, set: next.set };
}

export function installNarrowFit(host: PluginHost, studio: NarrowFitStudio): void {
  const first = document.getElementById('scroll-container');
  if (!first || typeof ResizeObserver === 'undefined') return;
  const hub = getDocHub();
  /** 문서별 자동 맞춤 상태 (문서 탭이 아니면 0 번 하나) */
  const autos = new Map<number, FitMemory | null>();
  let timer: number | undefined;

  function pageWidth(): number | null {
    try {
      return host.read((doc) => {
        const info = JSON.parse((doc as unknown as { getPageInfo(page: number): string }).getPageInfo(0)) as { width?: unknown };
        return typeof info.width === 'number' && info.width > 0 ? info.width : null;
      });
    } catch {
      return null;
    }
  }

  /** key 문서(지금 문서로 보고 있는 동안 부른다)의 배율을 container 폭에 맞춘다. narrow 가 아니면 되돌리기만 한다. */
  function settleOne(key: number, container: HTMLElement, narrow: boolean): void {
    const ctx = studio.context();
    if (!ctx?.hasDocument || container.clientWidth <= 0) return;
    const width = pageWidth();
    if (!width) return;
    const zoom = Math.round((ctx.zoom || 1) * 100);
    // clientWidth 는 안쪽 여백을 포함한다 — 메모 말풍선 자리(오른쪽 여백)는 쪽이 쓸 수 없는 폭이다
    const style = getComputedStyle(container);
    const usable = container.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const fit = Math.floor(((usable - FRAME_PADDING_PX) / width) * 100);
    const next = nextFit(autos.get(key) ?? null, zoom, fit, narrow);
    autos.set(key, next.memory);
    if (next.set !== null) studio.run('view:zoom-set', { percent: next.set });
  }

  const resizes = new ResizeObserver(() => queue());
  // 안쪽 여백만 바뀌면(메모 자리 생김·사라짐) 크기 관찰이 돌지 않는다
  const styles = new MutationObserver(() => queue());
  const watch = (container: HTMLElement) => {
    resizes.observe(container);
    styles.observe(container, { attributes: true, attributeFilter: ['style'] });
  };

  function settle(): void {
    const narrowWindow = window.innerWidth < NARROW_WINDOW_PX;
    if (!hub) {
      settleOne(0, first!, narrowWindow);
      return;
    }
    // 문서 탭: 화면에 보이는 문서(칸마다 하나)를 각각 맞춘다. 화면을 나눈 동안은 창이 넓어도 칸이 좁다.
    const split = document.getElementById('dg-workspace')?.dataset.split === 'true';
    for (const session of hub.sessions) {
      if (!session.ready || session.frame.root.dataset.active !== 'true') continue;
      watch(session.frame.container);
      try {
        hub.scoped(session, () => settleOne(session.id, session.frame.container, narrowWindow || split));
      } catch (error) {
        console.warn('[doogle] 좁은 칸 배율 맞춤 실패', error);
      }
    }
  }

  function queue(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(settle, 140);
  }

  if (hub) {
    hub.onClose((session) => { autos.delete(session.id); });
    window.addEventListener('doogle:doc-focus', queue);
    // 탭을 옮기거나 칸을 나누고 합칠 때 — 칸 배치가 바뀐다
    const workspace = document.getElementById('dg-workspace');
    if (workspace) new MutationObserver(queue).observe(workspace, { attributes: true, attributeFilter: ['data-split', 'data-orientation'] });
    host.onDocumentSwap(() => queue());
  } else {
    watch(first);
    host.onDocumentSwap(() => { autos.set(0, null); queue(); });
  }
  window.addEventListener('resize', queue);
  queue();
}
