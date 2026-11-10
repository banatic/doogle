/**
 * 문서 위 검토 막.
 *  - 팝오버: 지금 보는 변경 곁의 유리 카드 — 윗줄에 전·후(<del>이전</del> → <ins>이후</ins>, 서식은 속성 칩,
 *    누르면 펼침), 아랫줄에 적용 / 거절 (+N) | 왜 바꿨나요? 와 단축키. 뒤 변경이나 직접 고친 내용이 함께
 *    되돌아가는 거절은 팝오버 안 인라인 확인을 거친다.
 *  - 알약: 편집 영역 아래 가운데 (‹ 변경 i / n › | 직접 편집 포함 | − 100% +).
 *  - 거터: #scroll-container 오른쪽 6px 스트립에 변경 위치 점 (지금 변경은 accent, 나머지는 warn). 누르면 그 변경으로.
 *  - 단축키 (keys.ts): Alt+↓/↑ 다음·이전, Alt+Shift+Enter 적용, Alt+Shift+X 거절, Alt+Shift+G 변경 위치로.
 *
 * 위치는 엔진이 그린 선택 사각형을 따른다: 변경 자리를 `host.selectTextRange` 로 선택하면
 * upstream SelectionRenderer 가 `#scroll-content .selection-layer` 에 사각형을 그리고, 그 화면 좌표에
 * 팝오버를 붙인다. 표·구역처럼 글 범위가 없는 변경은 캐럿(`.caret`) 위치, 그것도 없으면 팝오버를 숨긴다.
 */
import type { PluginHost, PluginTextRange } from '@/plugin/types';
import type { PendingApi, PendingChangeSet } from '../agent/types.ts';
import { icon } from '../ui/icons.ts';
import { describeChange } from './describe.ts';
import { REVIEW_KEYS, gutterPositions, impactSentence, matchReviewKey, type ReviewKeyAction } from './keys.ts';
import { reviewStore } from './state.ts';
import './overlay.css';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(className: string, label: string, onClick: () => void, ariaLabel?: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  b.addEventListener('click', onClick);
  return b;
}

function kbd(text: string): HTMLElement {
  const k = el('kbd', 'dg-pop-kbd', text);
  k.setAttribute('aria-hidden', 'true');
  return k;
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
    .filter((node) => node.style.display !== 'none')
    .map((node) => node.getBoundingClientRect())
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
  const pop = el('div', 'dg-glass dg-review-pop');
  pop.dataset['dgFloating'] = '';
  pop.setAttribute('role', 'group');
  pop.setAttribute('aria-label', '변경 검토');
  pop.hidden = true;

  const diff = btn('dg-pop-diff dg-keep-all', '', () => {
    expanded = !expanded;
    diff.setAttribute('aria-expanded', String(expanded));
    renderPop();
    schedule();
  });
  diff.setAttribute('aria-expanded', 'false');

  const actions = el('div', 'dg-pop-row');
  actions.setAttribute('role', 'toolbar');
  actions.setAttribute('aria-label', '이 변경');
  const applyBtn = btn('dg-pop-btn dg-pop-primary', '', () => decide('accept'));
  applyBtn.append(el('span', '', '적용'), kbd(REVIEW_KEYS.accept.label));
  applyBtn.setAttribute('aria-keyshortcuts', REVIEW_KEYS.accept.aria);
  const rejectLabel = el('span', '', '거절');
  const rejectBtn = btn('dg-pop-btn', '', () => decide('reject'));
  rejectBtn.append(rejectLabel, kbd(REVIEW_KEYS.reject.label));
  rejectBtn.setAttribute('aria-keyshortcuts', REVIEW_KEYS.reject.aria);
  const sep = el('span', 'dg-glass-sep');
  sep.setAttribute('aria-hidden', 'true');
  const whyBtn = btn('dg-pop-btn dg-pop-quiet', '왜 바꿨나요?', () => {
    const id = reviewStore.currentId;
    if (id) reviewStore.explain(id);
  });
  actions.append(applyBtn, rejectBtn, sep, whyBtn);

  const confirmRow = el('div', 'dg-pop-confirm');
  confirmRow.setAttribute('role', 'alert');
  confirmRow.hidden = true;
  const confirmMsg = el('p', 'dg-pop-confirm-msg dg-keep-all');
  const confirmYes = btn('dg-pop-btn dg-pop-danger', '함께 되돌리기', () => decide('reject', true));
  const confirmNo = btn('dg-pop-btn', '취소', () => cancelConfirm(true));
  const confirmActs = el('div', 'dg-pop-row');
  confirmActs.append(confirmYes, confirmNo);
  confirmRow.append(confirmMsg, confirmActs);

  pop.append(diff, actions, confirmRow);
  pop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (confirming) cancelConfirm(true);
      else hidePopover();
    }
  });
  // 거절에 손이 가면 거터에서 함께 되돌아갈 점을 표시한다
  rejectBtn.addEventListener('mouseenter', () => { cascadeHint = true; renderGutter(); });
  rejectBtn.addEventListener('mouseleave', () => { cascadeHint = false; renderGutter(); });
  rejectBtn.addEventListener('focus', () => { cascadeHint = true; renderGutter(); });
  rejectBtn.addEventListener('blur', () => { cascadeHint = false; renderGutter(); });

  // ─── 알약 ────────────────────────────────────────────
  const pill = el('div', 'dg-glass dg-review-pill');
  pill.dataset['dgFloating'] = '';
  pill.setAttribute('role', 'toolbar');
  pill.setAttribute('aria-label', '변경 탐색과 배율');
  pill.hidden = true;
  const prev = btn('dg-pill-btn', '', () => reviewStore.step(-1), `이전 변경 (${REVIEW_KEYS.prev.label})`);
  prev.append(icon('chevronLeft', 14, 2.2));
  prev.setAttribute('aria-keyshortcuts', REVIEW_KEYS.prev.aria);
  prev.title = `이전 변경 (${REVIEW_KEYS.prev.label})`;
  const counter = el('span', 'dg-pill-count dg-tnum');
  counter.setAttribute('aria-live', 'polite');
  const next = btn('dg-pill-btn', '', () => reviewStore.step(1), `다음 변경 (${REVIEW_KEYS.next.label})`);
  next.append(icon('chevronRight', 14, 2.2));
  next.setAttribute('aria-keyshortcuts', REVIEW_KEYS.next.aria);
  next.title = `다음 변경 (${REVIEW_KEYS.next.label})`;
  const warnSep = el('span', 'dg-glass-sep');
  warnSep.setAttribute('aria-hidden', 'true');
  const warn = el('span', 'dg-pill-warn');
  warn.textContent = '직접 편집 포함';
  warn.title = '검토 대기 중에 문서를 직접 고쳤습니다. 앞선 변경을 거절하면 그 편집도 함께 되돌아갈 수 있습니다.';
  const pillSep = el('span', 'dg-glass-sep');
  pillSep.setAttribute('aria-hidden', 'true');
  const zoomOut = btn('dg-pill-btn dg-pill-zoom', '−', () => runCommand('view:zoom-out'), '축소');
  const zoomLabel = el('span', 'dg-pill-zoomval dg-tnum');
  const zoomIn = btn('dg-pill-btn dg-pill-zoom', '+', () => runCommand('view:zoom-in'), '확대');
  pill.append(prev, counter, next, warnSep, warn, pillSep, zoomOut, zoomLabel, zoomIn);

  // ─── 거터 ────────────────────────────────────────────
  const gutter = el('div', 'dg-review-gutter');
  gutter.dataset['dgFloating'] = '';
  gutter.setAttribute('role', 'navigation');
  gutter.setAttribute('aria-label', '변경 위치');
  gutter.hidden = true;

  document.body.append(gutter, pop, pill);

  let revealedId: string | null = null;
  let frame = 0;
  let expanded = false;
  let confirming = false;
  let cascadeHint = false;

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

  function decide(kind: 'accept' | 'reject', confirmed = false): void {
    const id = reviewStore.currentId;
    if (!id || reviewStore.busy) return;
    if (kind === 'reject' && !confirmed && reviewStore.needsConfirm(id)) {
      // 팝오버가 접혀 있으면(키보드) 먼저 그 자리를 보인다
      if (revealedId !== id) reviewStore.focus(id, true);
      confirming = true;
      renderPop();
      requestAnimationFrame(() => confirmYes.focus());
      schedule();
      return;
    }
    confirming = false;
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

  function cancelConfirm(refocus: boolean): void {
    if (!confirming) return;
    confirming = false;
    renderPop();
    if (refocus) rejectBtn.focus();
    schedule();
  }

  function hidePopover(): void {
    pop.hidden = true;
    revealedId = null;
    confirming = false;
    expanded = false;
    diff.setAttribute('aria-expanded', 'false');
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
    layoutGutter(editor, count);
    if (revealedId === null || revealedId !== reviewStore.currentId || count === 0 || !editor) {
      pop.hidden = true;
      return;
    }
    let anchor = anchorRect();
    if (!anchor || anchor.bottom < editor.top || anchor.top > editor.bottom) {
      if (!confirming) {
        pop.hidden = true;
        return;
      }
      // 글 범위가 없는 변경(쪽 설정·표)의 거절 확인은 알약 위에 띄운다 — 확인 없이 지나가지 않게
      anchor = new DOMRect(editor.left + editor.width / 2, editor.bottom - 200, 0, 0);
    }
    pop.hidden = false;
    const w = pop.offsetWidth || 260;
    const h = pop.offsetHeight || 72;
    let left = anchor.left + anchor.width / 2 - w / 2;
    left = Math.max(editor.left + 8, Math.min(left, editor.right - w - 20));
    let top = anchor.bottom + 8;
    if (top + h > editor.bottom - 64) top = anchor.top - h - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(editor.top + 8, top)}px`;
  }

  function layoutGutter(editor: DOMRect | null, count: number): void {
    const sc = document.getElementById('scroll-container');
    gutter.hidden = count === 0 || !editor || !sc;
    if (gutter.hidden || !editor || !sc) return;
    const scrollbar = Math.max(0, sc.offsetWidth - sc.clientWidth);
    gutter.style.left = `${editor.right - scrollbar - 10}px`;
    gutter.style.top = `${editor.top + 6}px`;
    gutter.style.height = `${Math.max(0, editor.height - 12)}px`;
  }

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(layout);
  }

  function renderPop(): void {
    const id = reviewStore.currentId;
    const change = id ? reviewStore.rows().find((r) => r.id === id) : undefined;
    const busy = reviewStore.busy;
    applyBtn.disabled = busy;
    rejectBtn.disabled = busy;
    confirmYes.disabled = busy;
    if (!change) return;
    const view = describeChange(change);
    diff.replaceChildren();
    diff.classList.toggle('dg-pop-diff-open', expanded);
    if (view.del || view.ins) {
      const del = expanded ? view.delFull : view.del;
      const ins = expanded ? view.insFull : view.ins;
      if (del) diff.append(el('del', 'dg-pop-del', del));
      if (del && ins) {
        const ar = el('span', 'dg-pop-arrow', '→');
        ar.setAttribute('aria-label', '에서');
        diff.append(ar);
      }
      if (ins) diff.append(el('ins', 'dg-pop-ins', ins));
      if (view.summary) diff.append(el('span', 'dg-pop-sum', view.summary));
      const long = view.delFull.length > view.del.length || view.insFull.length > view.ins.length
        || /\s{2,}|\n/.test(view.delFull + view.insFull);
      diff.disabled = !long && !expanded;
      diff.title = long ? (expanded ? '접기' : '전체 보기') : '';
    } else if (view.chips.length > 0) {
      diff.append(el('span', 'dg-pop-sum', view.summary));
      for (const chip of view.chips) diff.append(el('span', 'dg-pop-chip dg-tnum', chip));
      diff.disabled = true;
    } else {
      diff.append(el('span', 'dg-pop-sum', view.summary));
      diff.disabled = true;
    }
    diff.setAttribute('aria-label', `${view.location} 변경: ${diff.textContent ?? ''}`);

    const impact = reviewStore.rejectImpact(change.id);
    rejectLabel.textContent = impact.later > 0 ? `거절 (+${impact.later})` : '거절';
    rejectBtn.setAttribute('aria-label', impact.later > 0
      ? `거절 — 뒤 변경 ${impact.later}건도 함께 되돌아갑니다`
      : '거절');
    actions.hidden = confirming;
    confirmRow.hidden = !confirming;
    if (confirming) {
      confirmMsg.textContent = impactSentence(impact);
      confirmYes.textContent = `함께 되돌리기 (${impact.count}건)`;
    }
  }

  function renderGutter(): void {
    const rows = reviewStore.rows();
    const current = reviewStore.currentId;
    const positions = gutterPositions(rows, reviewStore.pageCount());
    const currentIndex = rows.findIndex((r) => r.id === current);
    const cascadeFrom = cascadeHint && currentIndex >= 0 && pending.rejectFrom ? currentIndex : cascadeHint ? 0 : -1;
    const marks = rows.map((row, i) => {
      const view = describeChange(row);
      const mark = btn('dg-gutter-mark', '', () => reviewStore.focus(row.id, true), `${view.location} 변경으로 이동`);
      mark.style.top = `${(positions[i] * 100).toFixed(2)}%`;
      mark.title = view.location;
      mark.tabIndex = -1; // 키보드는 Alt+↑/↓ 로 — 점마다 탭 정지를 두지 않는다
      if (row.id === current) {
        mark.classList.add('dg-gutter-cur');
        mark.setAttribute('aria-current', 'true');
      }
      if (cascadeFrom >= 0 && i >= cascadeFrom) mark.classList.add('dg-gutter-cascade');
      return mark;
    });
    gutter.replaceChildren(...marks);
  }

  function render(): void {
    const count = reviewStore.count;
    const index = reviewStore.currentIndex();
    counter.textContent = count > 0 ? `변경 ${index + 1} / ${count}` : '';
    prev.disabled = count < 2;
    next.disabled = count < 2;
    const userEdits = count > 0 && reviewStore.hasUserEdits();
    warn.hidden = !userEdits;
    warnSep.hidden = !userEdits;
    if (confirming && revealedId !== reviewStore.currentId) confirming = false;
    renderPop();
    renderGutter();
    schedule();
  }

  reviewStore.setRevealer((change) => {
    const range = rangeOf(change);
    if (revealedId !== change.id) {
      expanded = false;
      confirming = false;
      diff.setAttribute('aria-expanded', 'false');
    }
    revealedId = change.id;
    renderPop();
    if (range) {
      try { host.selectTextRange(range); } catch (error) { console.warn('[doogle] 변경 위치로 이동하지 못했습니다', error); }
    }
    // SelectionRenderer 가 다음 프레임에 그린다
    requestAnimationFrame(() => requestAnimationFrame(layout));
  });

  // ─── 단축키 ──────────────────────────────────────────
  const run: Record<ReviewKeyAction, () => void> = {
    next: () => reviewStore.step(1),
    prev: () => reviewStore.step(-1),
    accept: () => decide('accept'),
    reject: () => (confirming ? decide('reject', true) : decide('reject')),
    reveal: () => {
      const id = reviewStore.currentId;
      if (id) reviewStore.focus(id, true);
    },
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || reviewStore.count === 0) return;
    const action = matchReviewKey(event);
    if (!action) return;
    // 모달 대화상자 안에서는 양보한다 (검토 막 자신 제외)
    const target = event.target as HTMLElement | null;
    const modal = target?.closest?.('[aria-modal="true"], dialog[open], .modal-overlay, .dialog-overlay');
    if (modal && !pop.contains(modal)) return;
    event.preventDefault();
    event.stopPropagation();
    if (reviewStore.busy && (action === 'accept' || action === 'reject')) return;
    run[action]();
  };
  window.addEventListener('keydown', onKey, true);
  offs.push(() => window.removeEventListener('keydown', onKey, true));

  offs.push(reviewStore.onChange(render));
  offs.push(host.events.on('zoom-changed', (zoom) => { renderZoom(typeof zoom === 'number' ? zoom : undefined); schedule(); }));
  // 사용자 직접 편집 — revision 이 움직였을 수 있다. 다음 프레임에 표면들을 다시 그린다.
  let refreshFrame = 0;
  offs.push(host.events.on('document-changed', () => {
    schedule();
    if (!refreshFrame && reviewStore.count > 0) {
      refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; reviewStore.refresh(); });
    }
  }));

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
      if (refreshFrame) cancelAnimationFrame(refreshFrame);
      reviewStore.setRevealer(null);
      reviewStore.attach(null);
      pop.remove();
      pill.remove();
      gutter.remove();
    },
  };
}
