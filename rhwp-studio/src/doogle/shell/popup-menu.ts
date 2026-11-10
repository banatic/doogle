/**
 * 리본의 작은 드롭다운 메뉴(장평·자간, 더보기). role=menu + 방향키 이동 + Esc 닫기.
 * 항목을 고르면 메뉴를 닫고 `onPick` 을 부른다. 편집 선택을 지키려고 mousedown 기본 동작을 막는다.
 */

export interface PopupEntry {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** 하위 제목(구분용, 선택 불가) */
  heading?: boolean;
  separator?: boolean;
  onPick?: (itemEl: HTMLElement) => void;
}

let current: { close: (returnFocus?: boolean) => void } | null = null;

export function closePopupMenu(): void {
  current?.close(false);
}

export function openPopupMenu(anchor: HTMLElement, entries: PopupEntry[], label: string, focusFirst = false): void {
  current?.close(false);

  const menu = document.createElement('div');
  menu.className = 'dg-popup';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);

  const items: HTMLButtonElement[] = [];
  for (const entry of entries) {
    if (entry.separator) {
      const sep = document.createElement('div');
      sep.className = 'dg-popup-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }
    if (entry.heading) {
      const h = document.createElement('div');
      h.className = 'dg-popup-heading';
      h.textContent = entry.label;
      menu.appendChild(h);
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dg-popup-item';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    const text = document.createElement('span');
    text.className = 'dg-popup-label';
    text.textContent = entry.label;
    item.appendChild(text);
    if (entry.shortcut) {
      const sc = document.createElement('span');
      sc.className = 'dg-popup-shortcut';
      sc.textContent = entry.shortcut;
      item.appendChild(sc);
    }
    if (entry.disabled) {
      item.setAttribute('aria-disabled', 'true');
    }
    const pick = () => {
      if (entry.disabled) return;
      close(false);
      entry.onPick?.(anchor);
    };
    item.addEventListener('mousedown', (e) => { e.preventDefault(); });
    item.addEventListener('click', pick);
    menu.appendChild(item);
    items.push(item);
  }

  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - w - 4))}px`;
  const below = r.bottom + 4;
  menu.style.top = `${below + h > window.innerHeight - 4 ? Math.max(4, r.top - h - 4) : below}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const focusAt = (i: number) => {
    if (!items.length) return;
    const n = (i + items.length) % items.length;
    items[n].focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(idx < 0 ? -1 : idx - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
    else if (e.key === 'Tab') { close(false); }
  };
  const onDown = (e: Event) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !anchor.contains(t)) close(false);
  };
  menu.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', () => close(false), { once: true });

  function close(returnFocus = false) {
    if (current?.close !== close) return;
    current = null;
    document.removeEventListener('pointerdown', onDown, true);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus) anchor.focus();
  }
  current = { close };
  if (focusFirst) focusAt(0);
}
