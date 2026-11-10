/**
 * 문서 위 검토 막 — 지금 보는 변경 곁에 뜨는 유리 팝오버(적용 / 거절 | 왜 바꿨나요?)와
 * 편집 영역 아래 가운데의 유리 알약(‹ 변경 i / n › | − 100% +).
 *
 * 위치는 엔진이 그린 선택 사각형을 따른다: 변경 자리를 `host.selectTextRange` 로 선택하면
 * upstream SelectionRenderer 가 `#scroll-content .selection-layer` 에 사각형을 그리고
 * (엔진 getSelectionRects → 쪽 오프셋·배율 적용), 그 화면 좌표에 팝오버를 붙인다.
 * 표·구역처럼 글 범위가 없는 변경은 캐럿(`.caret`) 위치, 그것도 없으면 팝오버를 숨긴다.
 */
import type { PluginHost, PluginTextRange } from '@/plugin/types';
import type { PendingApi, PendingChangeSet } from '../agent/types.ts';
import { icon } from '../ui/icons.ts';
import { reviewStore } from './state.ts';
import './overlay.css';

function btn(className: string, label: string, onClick: () => void, ariaLabel?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  b.addEventListener('click', onClick);
  return b;
}

function rangeOf(change: PendingChangeSet): PluginTextRange | null {
  const t = change.targets?.[0];
  if (!t || t.wholeSection) return null;
  if (t.table) {
    return {
      section: t.sectionIdx, paragraph: t.table.paraIdx, charOffset: 0, length: 0,
      cell: { parentPara: t.table.paraIdx, controlIndex: t.table.controlIdx, cellIndex: 0, cellPara: 0 },
    };
  }
  if (t.cell) {
    return {
      section: t.sectionIdx, paragraph: t.paraIdx, charOffset: t.charOffset, length: t.length,
      cell: { parentPara: t.cell.paraIdx, controlIndex: t.cell.controlIdx, cellIndex: t.cell.cellIdx, cellPara: t.paraIdx },
    };
  }
  return { section: t.sectionIdx, paragraph: t.paraIdx, charOffset: t.charOffset, length: t.length };
}

/** 화면에 보이는 선택 사각형들의 합 (없으면 캐럿) */
function anchorRect(): DOMRect | null {
  const boxes = [...document.querySelectorAll<HTMLElement>('#scroll-content .selection-layer > div')]
    .filter((el) => el.style.display !== 'none')
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (boxes.length > 0) {
    const left = Math.min(...boxes.map((r) => r.left));
    const top = Math.min(...boxes.map((r) => r.top));
    const right = Math.max(...boxes.map((r) => r.right));
    const bottom = Math.max(...boxes.map((r) => r.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  }
  const caret = document.querySelector<HTMLElement>('#scroll-content .caret');
  if (caret && caret.offsetParent !== null) {
    const r = caret.getBoundingClientRect();
    if (r.height > 0) return r;
  }
  return null;
}

export interface ReviewOverlay {
  dispose(): void;
}

export function mountReviewOverlay(host: PluginHost, pending: PendingApi): ReviewOverlay {
  reviewStore.attach(pending);
  const offs: Array<() => void> = [];

  // ─── 팝오버 ──────────────────────────────────────────
  const pop = document.createElement('div');
  pop.className = 'dg-glass dg-review-pop';
  pop.setAttribute('role', 'toolbar');
  pop.setAttribute('aria-label', '변경 검토');
  pop.hidden = true;
  const applyBtn = btn('dg-pop-btn dg-pop-primary', '적용', () => decide('accept'));
  const rejectBtn = btn('dg-pop-btn', '거절', () => decide('reject'));
  const sep = document.createElement('span');
  sep.className = 'dg-glass-sep';
  sep.setAttribute('aria-hidden', 'true');
  const whyBtn = btn('dg-pop-btn dg-pop-quiet', '왜 바꿨나요?', () => {
    const id = reviewStore.currentId;
    if (id) reviewStore.explain(id);
  });
  pop.append(applyBtn, rejectBtn, sep, whyBtn);
  pop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hidePopover();
    }
  });

  // ─── 알약 ────────────────────────────────────────────
  const pill = document.createElement('div');
  pill.className = 'dg-glass dg-review-pill';
  pill.setAttribute('role', 'toolbar');
  pill.setAttribute('aria-label', '변경 탐색과 배율');
  pill.hidden = true;
  const prev = btn('dg-pill-btn', '', () => reviewStore.step(-1), '이전 변경');
  prev.append(icon('chevronLeft', 14, 2.2));
  const counter = document.createElement('span');
  counter.className = 'dg-pill-count';
  counter.setAttribute('aria-live', 'polite');
  const next = btn('dg-pill-btn', '', () => reviewStore.step(1), '다음 변경');
  next.append(icon('chevronRight', 14, 2.2));
  const pillSep = document.createElement('span');
  pillSep.className = 'dg-glass-sep';
  pillSep.setAttribute('aria-hidden', 'true');
  const zoomOut = btn('dg-pill-btn dg-pill-zoom', '−', () => runCommand('view:zoom-out'), '축소');
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'dg-pill-zoomval';
  const zoomIn = btn('dg-pill-btn dg-pill-zoom', '+', () => runCommand('view:zoom-in'), '확대');
  pill.append(prev, counter, next, pillSep, zoomOut, zoomLabel, zoomIn);

  document.body.append(pop, pill);

  let revealedId: string | null = null;
  let frame = 0;

  function runCommand(id: string): void {
    try { host.automation.execute(id); } catch (error) { console.warn('[doogle] 명령 실패', id, error); }
    renderZoom();
  }

  function renderZoom(value?: number): void {
    let zoom = value;
    if (typeof zoom !== 'number') {
      try { zoom = host.automation.getContext().zoom; } catch { zoom = 1; }
    }
    zoomLabel.textContent = `${Math.round((zoom ?? 1) * 100)}%`;
  }

  function decide(kind: 'accept' | 'reject'): void {
    const id = reviewStore.currentId;
    if (!id || reviewStore.busy) return;
    try {
      reviewStore.decide(kind, id);
    } catch (error) {
      console.error('[doogle] 검토 처리 실패', error);
      return;
    }
    hidePopover();
    const nextId = reviewStore.currentId;
    if (nextId) reviewStore.focus(nextId, true);
  }

  function hidePopover(): void {
    pop.hidden = true;
    revealedId = null;
  }

  function editorRect(): DOMRect | null {
    const sc = document.getElementById('scroll-container');
    if (!sc || sc.offsetParent === null) return null;
    return sc.getBoundingClientRect();
  }

  function layout(): void {
    frame = 0;
    const editor = editorRect();
    const count = reviewStore.count;
    pill.hidden = count === 0 || !editor;
    if (!pill.hidden && editor) {
      pill.style.left = `${editor.left + editor.width / 2}px`;
      pill.style.top = `${editor.bottom - 20}px`;
    }
    if (revealedId === null || revealedId !== reviewStore.currentId || count === 0 || !editor) {
      pop.hidden = true;
      return;
    }
    const anchor = anchorRect();
    if (!anchor || anchor.bottom < editor.top || anchor.top > editor.bottom) {
      pop.hidden = true;
      return;
    }
    pop.hidden = false;
    const w = pop.offsetWidth || 220;
    const h = pop.offsetHeight || 40;
    let left = anchor.left + anchor.width / 2 - w / 2;
    left = Math.max(editor.left + 8, Math.min(left, editor.right - w - 8));
    let top = anchor.bottom + 8;
    if (top + h > editor.bottom - 64) top = anchor.top - h - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(editor.top + 8, top)}px`;
  }

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(layout);
  }

  function render(): void {
    const count = reviewStore.count;
    const index = reviewStore.currentIndex();
    counter.textContent = count > 0 ? `변경 ${index + 1} / ${count}` : '';
    applyBtn.disabled = reviewStore.busy;
    rejectBtn.disabled = reviewStore.busy;
    prev.disabled = count < 2;
    next.disabled = count < 2;
    const span = reviewStore.currentId ? reviewStore.rejectSpan(reviewStore.currentId) : 0;
    rejectBtn.title = span > 1 ? `이 변경과 그 뒤 변경 ${span - 1}건을 되돌립니다` : '이 변경을 되돌립니다';
    schedule();
  }

  reviewStore.setRevealer((change) => {
    const range = rangeOf(change);
    revealedId = change.id;
    if (range) {
      try { host.selectTextRange(range); } catch (error) { console.warn('[doogle] 변경 위치로 이동하지 못했습니다', error); }
    }
    // SelectionRenderer 가 다음 프레임에 그린다
    requestAnimationFrame(() => requestAnimationFrame(layout));
  });

  offs.push(reviewStore.onChange(render));
  offs.push(host.events.on('zoom-changed', (zoom) => { renderZoom(typeof zoom === 'number' ? zoom : undefined); schedule(); }));
  offs.push(host.events.on('document-changed', schedule));

  const onScroll = () => schedule();
  const onPointer = (event: PointerEvent) => {
    // 사용자가 문서를 직접 누르면 선택이 바뀐다 — 팝오버를 접는다
    if (!pop.hidden && !pop.contains(event.target as Node)) hidePopover();
  };
  const scroller = document.getElementById('scroll-container');
  scroller?.addEventListener('scroll', onScroll, { passive: true });
  scroller?.addEventListener('pointerdown', onPointer);
  window.addEventListener('resize', onScroll);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
  if (scroller) ro?.observe(scroller);

  renderZoom();
  render();

  return {
    dispose(): void {
      for (const off of offs) off();
      scroller?.removeEventListener('scroll', onScroll);
      scroller?.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      reviewStore.setRevealer(null);
      reviewStore.attach(null);
      pop.remove();
      pill.remove();
    },
  };
}
