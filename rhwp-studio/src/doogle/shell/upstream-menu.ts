/**
 * 숨긴 upstream 메뉴 막대(#menu-bar)의 항목을 리본 '더보기'·파일 백스테이지로 다시 펼친다.
 *
 * 메뉴 구조의 정본은 index.html 마크업이다(automation/menu-dom.ts 와 같은 판단). 여기서는 그 DOM 을
 * 읽기만 하고, 실행은 `MenuBar.setupItemClicks` 와 같은 규칙(data-* → params)으로 디스패처에 보낸다.
 * data-cmd 가 없는 항목(최근 문서의 개별 onClick 등)은 upstream 요소를 그대로 click 한다.
 */
import type { PopupEntry } from './popup-menu';
import { commandShortcut, hasCommand, isEnabled, run } from './studio';

export function menuBody(menuId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#menu-bar .menu-item[data-menu="${menuId}"] .menu-dropdown`);
}

export function menuTitle(menuId: string): string {
  return document.querySelector(`#menu-bar .menu-item[data-menu="${menuId}"] .menu-title`)?.textContent?.trim() ?? menuId;
}

function labelOf(el: Element): string {
  return (el.querySelector('.md-label')?.textContent ?? el.textContent ?? '').trim();
}

/** upstream 항목 하나를 실행한다. */
export function activateUpstreamItem(el: HTMLElement, anchor: HTMLElement): void {
  const cmd = el.dataset.cmd;
  if (!cmd) {
    el.click();
    return;
  }
  const params: Record<string, unknown> = { anchorEl: anchor };
  for (const [key, val] of Object.entries(el.dataset)) {
    if (key !== 'cmd') params[key] = val;
  }
  run(cmd, params);
}

/** 메뉴 본문을 팝업 항목으로 편다. 하위 메뉴는 제목 + 항목으로 평탄화한다. */
export function upstreamMenuEntries(menuId: string): PopupEntry[] {
  const body = menuBody(menuId);
  if (!body) return [];
  const out: PopupEntry[] = [];
  const walk = (container: Element, depth: number) => {
    for (const el of Array.from(container.children)) {
      const h = el as HTMLElement;
      if (h.hidden || h.style.display === 'none') continue;
      if (h.classList.contains('md-sep')) {
        if (out.length && !out[out.length - 1].separator) out.push({ label: '', separator: true });
        continue;
      }
      if (h.classList.contains('md-sub')) {
        const panel = h.querySelector('.md-sub-panel');
        if (!panel) continue;
        if (out.length && !out[out.length - 1].separator) out.push({ label: '', separator: true });
        out.push({ label: labelOf(h), heading: true });
        walk(panel, depth + 1);
        continue;
      }
      if (!h.classList.contains('md-item')) continue;
      const cmd = h.dataset.cmd;
      if (cmd && !hasCommand(cmd)) continue;
      out.push({
        label: labelOf(h),
        shortcut: cmd ? commandShortcut(cmd) : undefined,
        disabled: cmd ? !isEnabled(cmd) : h.classList.contains('disabled'),
        onPick: (anchor) => activateUpstreamItem(h, anchor),
      });
    }
  };
  walk(body, 0);
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/**
 * 파일 메뉴의 '최근 문서' 하위 패널은 MenuBar 가 메뉴를 열 때만 다시 그린다(main.ts renderRecentSubmenu).
 * 숨긴 메뉴 제목에 열기→닫기 mousedown 을 보내 그 갱신만 일으킨다.
 */
export function refreshRecentDocs(): void {
  const title = document.querySelector<HTMLElement>('#menu-bar .menu-item[data-menu="file"] .menu-title');
  if (!title) return;
  title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}
