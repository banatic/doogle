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

export function installNarrowFit(host: PluginHost, studio: NarrowFitStudio): void {
  const container = document.getElementById('scroll-container');
  if (!container || typeof ResizeObserver === 'undefined') return;
  let auto: AutoFit | null = null;
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

  function settle(): void {
    const ctx = studio.context();
    if (!ctx?.hasDocument || container!.clientWidth <= 0) return;
    const width = pageWidth();
    if (!width) return;
    const zoom = Math.round((ctx.zoom || 1) * 100);
    const fit = Math.floor(((container!.clientWidth - FRAME_PADDING_PX) / width) * 100);
    const next = nextAutoFit(auto, zoom, fit, window.innerWidth < NARROW_WINDOW_PX);
    auto = next.auto;
    if (next.set !== null) studio.run('view:zoom-set', { percent: next.set });
  }

  function queue(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(settle, 140);
  }

  new ResizeObserver(queue).observe(container);
  window.addEventListener('resize', queue);
  host.onDocumentSwap(() => { auto = null; queue(); });
  queue();
}
