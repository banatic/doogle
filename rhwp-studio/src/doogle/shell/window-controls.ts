/**
 * 테두리 없는 창(doogle-desk `decorations: false`)의 제목 막대 동작.
 *
 *  - 끌기·두 번 눌러 최대화: Tauri 2 가 주입하는 drag 스크립트가 `data-tauri-drag-region` 을 본다.
 *    속성은 막대와 비대화형 자식(앱 이름·구분선·문서 제목·빠른 실행 틀)에만 단다. 단추에는 달지 않는다.
 *  - 최소화·최대화/이전 크기 단추: `plugin:window|*` 를 `__TAURI_INTERNALS__` 로 직접 부른다
 *    (desk-bridge 와 같은 방식 — `@tauri-apps/api` 의존성 없음).
 *  - 닫기 단추: close-guard 의 `requestClose()` (저장 안 한 문서 확인 → `confirm_close`).
 *  - macOS: 네이티브 신호등(titleBarStyle Overlay)을 쓰므로 단추를 숨기고 왼쪽을 비운다.
 *  - 브라우저(?doogle=1, Tauri 없음): 단추를 만들지 않는다. drag 속성은 무해하다.
 */
import { invoke, isDesk } from '../ui/desk-bridge';
import { requestClose } from './close-guard';

const DRAG_ATTR = 'data-tauri-drag-region';
const WINDOW_LABEL = 'main';

export type DeskPlatform = 'mac' | 'other';

export function deskPlatform(): DeskPlatform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const name = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac/i.test(name) ? 'mac' : 'other';
}

/** 끌기 영역 표시. 막대 자신과 비대화형 자식에만 쓴다. */
export function markDragRegion(...els: HTMLElement[]): void {
  for (const el of els) el.setAttribute(DRAG_ATTR, '');
}

const GLYPH = {
  minimize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>',
  maximize: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  restore: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  close: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>',
} as const;

function windowCall<T = void>(command: string): Promise<T> {
  return invoke<T>(`plugin:window|${command}`, { label: WINDOW_LABEL });
}

function controlButton(kind: keyof typeof GLYPH, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `dg-winbtn dg-winbtn-${kind === 'restore' ? 'maximize' : kind}`;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.tabIndex = -1; // 키보드 사용자는 Alt+Space / Alt+F4 등 OS 단축키를 쓴다
  b.innerHTML = GLYPH[kind];
  // 문서 캐럿·선택을 빼앗지 않는다
  b.addEventListener('mousedown', (e) => e.preventDefault());
  // 단추 위 두 번 누르기가 막대의 최대화 토글로 번지지 않게
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  b.addEventListener('click', onClick);
  return b;
}

/**
 * 제목 막대에 창 단추를 붙이고 플랫폼에 맞게 꾸민다.
 * 데스크탑이 아니면 아무것도 붙이지 않는다.
 */
export function installWindowControls(bar: HTMLElement): void {
  if (!isDesk()) return;
  const platform = deskPlatform();
  bar.dataset.platform = platform;
  if (platform === 'mac') return; // 네이티브 신호등 사용

  const wrap = document.createElement('div');
  wrap.className = 'dg-winctl';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', '창 조절');

  const report = (error: unknown) => console.warn('[doogle] 창 조절 실패', error);

  const min = controlButton('minimize', '최소화', () => { windowCall('minimize').catch(report); });
  const max = controlButton('maximize', '최대화', () => {
    windowCall('toggle_maximize').then(syncMaximized, report);
  });
  // 닫기는 네이티브 닫기 요청(CloseRequested → doogle://close-requested)과 같은 확인 경로를 탄다:
  // 저장 안 한 문서가 있으면 확인 대화상자, 그다음 confirm_close.
  const close = controlButton('close', '닫기', () => { void requestClose(); });

  let maximized: boolean | null = null;
  function render(next: boolean): void {
    if (maximized === next) return;
    maximized = next;
    const label = next ? '이전 크기로' : '최대화';
    max.innerHTML = next ? GLYPH.restore : GLYPH.maximize;
    max.setAttribute('aria-label', label);
    max.title = label;
    bar.dataset.maximized = String(next);
  }
  function syncMaximized(): void {
    windowCall<boolean>('is_maximized').then(render, () => {});
  }
  render(false);
  syncMaximized();

  // 최대화·복원·스냅은 모두 뷰포트 크기를 바꾼다 → resize 뒤에 실제 상태를 묻는다.
  let timer: number | undefined;
  window.addEventListener('resize', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(syncMaximized, 80);
  });

  wrap.append(min, max, close);
  bar.append(wrap);
}
