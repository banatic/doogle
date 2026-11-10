/**
 * 검토 목록 — 사이드바 안에 놓는 "검토 대기 중인 변경" 목록 부품.
 *
 * ```ts
 * import { mountReviewList } from '../review/list.ts';
 * const list = mountReviewList(container, { onError: (msg) => this.addNotice(msg, 'error') });
 * // … list.dispose();
 * ```
 *
 * - 행: 위치(2쪽 ¶4) · 지운 글/넣은 글 또는 서식 칩 · 적용 ✓ / 거절 ✕
 * - 파급: 행에 마우스를 올리거나 포커스하면(기본은 지금 보는 행) 거절 시 함께 되돌아갈 뒤 행이 흐려지고
 *   행 아래에 "거절하면 아래 N건도 함께 되돌아갑니다" 가 본문으로 뜬다.
 * - 뒤 행·직접 고친 내용이 함께 되돌아가는 거절은 행 아래 인라인 확인을 거친다.
 * - 행 사이에 사용자가 직접 고친 자리를 표시한다.
 * 상태는 reviewStore 하나를 본다 — 문서 위 막(overlay)과 같은 "지금 보는 변경"을 공유한다.
 */
import type { PendingChangeSet } from '../agent/types.ts';
import { icon } from '../ui/icons.ts';
import { describeChange } from './describe.ts';
import { REVIEW_KEYS, chainSentence, impactSentence } from './keys.ts';
import { reviewStore } from './state.ts';
import './list.css';

export interface ReviewListDeps {
  /** 검토 처리 실패 알림 (사이드바 알림 줄) */
  onError?(message: string): void;
  /** 머리 제목 (기본 "검토 대기 중인 변경") — 다른 대화의 변경이면 사이드바가 바꿔 줄 수 있다 */
  title?(rows: PendingChangeSet[]): string;
  /** 비면 container.hidden = true (기본 true) */
  hideWhenEmpty?: boolean;
  /** 다시 그린 뒤 (사이드바가 턴 동작 줄을 갱신할 때) */
  onRender?(count: number): void;
}

export interface ReviewListHandle {
  render(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function kbd(text: string): HTMLElement {
  const k = el('kbd', 'dg-rl-kbd', text);
  k.setAttribute('aria-hidden', 'true');
  return k;
}

export function mountReviewList(container: HTMLElement, deps: ReviewListDeps = {}): ReviewListHandle {
  const root = el('div', 'dg-rl');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '검토 대기 중인 변경');
  container.append(root);
  /** 확인 중인 거절 — 행 id 또는 'all' */
  let confirming: string | null = null;
  /** 파급을 보여 줄 행 (마우스·포커스). 없으면 지금 보는 행 */
  let rippleId: string | null = null;
  let disposed = false;

  function fail(error: unknown): void {
    const message = `검토를 처리하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    if (deps.onError) deps.onError(message);
    else console.error('[doogle]', message);
  }

  function decide(kind: 'accept' | 'reject', id?: string, confirmed = false): void {
    if (reviewStore.busy) return;
    if (kind === 'reject' && !confirmed && reviewStore.needsConfirm(id)) {
      confirming = id ?? 'all';
      render();
      root.querySelector<HTMLButtonElement>('.dg-rl-confirm .dg-rl-danger')?.focus();
      return;
    }
    confirming = null;
    try {
      reviewStore.decide(kind, id);
    } catch (error) {
      fail(error);
    }
    render();
  }

  function cancelConfirm(): void {
    const id = confirming;
    confirming = null;
    render();
    const sel = id && id !== 'all' ? `.dg-rl-row[data-id="${CSS.escape(id)}"] .dg-rl-no` : '.dg-rl-head .dg-rl-reject-all';
    root.querySelector<HTMLElement>(sel)?.focus();
  }

  function confirmBlock(text: string, label: string, onYes: () => void): HTMLElement {
    const box = el('div', 'dg-rl-confirm');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-label', '거절 확인');
    const msg = el('p', 'dg-rl-confirm-msg dg-keep-all', text);
    msg.id = `dg-rl-confirm-${Math.random().toString(36).slice(2, 8)}`;
    box.setAttribute('aria-describedby', msg.id);
    const yes = button('dg-rl-btn dg-rl-danger', label, onYes);
    const no = button('dg-rl-btn', '취소', cancelConfirm);
    const acts = el('div', 'dg-rl-confirm-acts');
    acts.append(yes, no);
    box.append(msg, acts);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelConfirm();
      }
    });
    return box;
  }

  function what(row: PendingChangeSet): HTMLElement {
    const view = describeChange(row);
    const node = el('span', 'dg-rl-what dg-keep-all');
    if (view.del || view.ins) {
      if (view.del) node.append(el('del', 'dg-rl-del', view.del));
      if (view.del && view.ins) node.append(' ');
      if (view.ins) node.append(el('ins', 'dg-rl-ins', view.ins));
      if (view.summary) node.append(el('span', 'dg-rl-more', ` ${view.summary}`));
    } else if (view.chips.length > 0) {
      node.classList.add('dg-rl-fx');
      node.append(el('span', 'dg-rl-fx-label', view.summary));
      for (const chip of view.chips) node.append(el('span', 'dg-rl-chip', chip));
    } else {
      node.textContent = view.summary;
    }
    return node;
  }

  function gap(text: string): HTMLElement {
    return el('li', 'dg-rl-gap', text);
  }

  function render(): void {
    if (disposed) return;
    const rows = reviewStore.rows();
    const hide = deps.hideWhenEmpty !== false;
    if (rows.length === 0) {
      confirming = null;
      root.replaceChildren();
      if (hide) container.hidden = true;
      deps.onRender?.(0);
      return;
    }
    if (hide) container.hidden = false;
    if (confirming && confirming !== 'all' && !rows.some((r) => r.id === confirming)) confirming = null;
    const busy = reviewStore.busy;
    const current = reviewStore.currentId;
    const focusKey = (document.activeElement as HTMLElement | null)?.closest?.('.dg-rl') === root
      ? (document.activeElement as HTMLElement).dataset['focusKey'] ?? null : null;

    // ─── 머리 ───
    const head = el('div', 'dg-rl-head');
    const count = el('span', 'dg-rl-count dg-tnum', String(rows.length));
    count.setAttribute('aria-label', `${rows.length}건`);
    const rejectAll = button('dg-rl-btn dg-rl-quiet dg-rl-reject-all', '모두 거절', () => decide('reject'));
    rejectAll.dataset['focusKey'] = 'reject-all';
    const acceptAll = button('dg-rl-btn dg-rl-primary', '모두 적용', () => decide('accept'));
    acceptAll.dataset['focusKey'] = 'accept-all';
    acceptAll.append(kbd('Ctrl ↵'));
    acceptAll.setAttribute('aria-keyshortcuts', 'Control+Enter');
    rejectAll.disabled = busy;
    acceptAll.disabled = busy;
    head.append(el('span', 'dg-rl-title', deps.title?.(rows) ?? '검토 대기 중인 변경'), count, el('span', 'dg-rl-grow'), rejectAll, acceptAll);
    const parts: HTMLElement[] = [head];
    if (confirming === 'all') {
      const impact = reviewStore.rejectImpact();
      parts.push(confirmBlock(impactSentence(impact, true), `모두 거절 (${impact.count}건)`, () => decide('reject', undefined, true)));
    }

    // ─── 행 ───
    const list = el('ul', 'dg-rl-list');
    // 직접 편집 표시 — 적용 표시해 숨긴 행 앞의 것은 다음 보이는 행 앞으로 옮긴다
    const gapBefore = new Set<string>();
    let carry = false;
    for (const c of reviewStore.pending?.list() ?? []) {
      if (c.userEditsBefore) carry = true;
      if (!c.kept) {
        if (carry) gapBefore.add(c.id);
        carry = false;
      }
    }
    for (const row of rows) {
      if (gapBefore.has(row.id)) list.append(gap('이 사이에 직접 고친 내용이 있습니다'));
      const li = el('li', 'dg-rl-row');
      li.dataset['id'] = row.id;
      const on = row.id === current;
      li.classList.toggle('dg-rl-current', on);
      const view = describeChange(row);

      const go = button('dg-rl-go', '', () => reviewStore.focus(row.id, true));
      go.dataset['focusKey'] = `go:${row.id}`;
      if (on) go.setAttribute('aria-current', 'true');
      go.setAttribute('aria-keyshortcuts', REVIEW_KEYS.reveal.aria);
      go.append(el('span', 'dg-rl-loc dg-tnum', view.location), what(row));

      const impact = reviewStore.rejectImpact(row.id);
      const acts = el('span', 'dg-rl-acts');
      const ok = button('dg-rl-icon dg-rl-ok', '', () => decide('accept', row.id));
      ok.append(icon('check', 14, 2.2));
      ok.setAttribute('aria-label', `${view.location} 변경 적용`);
      ok.title = `적용 (${REVIEW_KEYS.accept.label})`;
      ok.dataset['focusKey'] = `ok:${row.id}`;
      const no = button('dg-rl-icon dg-rl-no', '', () => decide('reject', row.id));
      no.append(icon('close', 13, 2.2));
      no.setAttribute('aria-label', impact.later > 0
        ? `${view.location} 변경 거절 — 뒤 변경 ${impact.later}건도 함께 되돌아갑니다`
        : `${view.location} 변경 거절`);
      no.title = `거절 (${REVIEW_KEYS.reject.label})`;
      no.dataset['focusKey'] = `no:${row.id}`;
      if (impact.later > 0) {
        const plus = el('span', 'dg-rl-plus dg-tnum', `+${impact.later}`);
        plus.setAttribute('aria-hidden', 'true');
        no.append(plus);
      }
      ok.disabled = busy;
      no.disabled = busy;
      acts.append(ok, no);
      li.append(go, acts);

      const text = chainSentence(impact);
      if (text) {
        li.append(el('div', 'dg-rl-chain dg-keep-all', text));
      }
      if (confirming === row.id) {
        li.append(confirmBlock(impactSentence(impact), `함께 되돌리기 (${impact.count}건)`, () => decide('reject', row.id, true)));
        li.classList.add('dg-rl-confirming');
      }
      li.addEventListener('mouseenter', () => ripple(row.id));
      li.addEventListener('focusin', () => ripple(row.id));
      list.append(li);
    }
    if (reviewStore.trailingUserEdits()) list.append(gap('마지막 변경 뒤에 직접 고친 내용이 있습니다'));
    list.addEventListener('mouseleave', () => ripple(null));
    list.addEventListener('focusout', (event) => {
      if (!list.contains(event.relatedTarget as Node | null)) ripple(null);
    });
    list.addEventListener('keydown', onListKey);
    parts.push(list);
    root.replaceChildren(...parts);
    applyRipple();

    if (focusKey) root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    if (confirming) root.querySelector<HTMLButtonElement>('.dg-rl-confirm .dg-rl-danger')?.focus();
    deps.onRender?.(rows.length);
  }

  function ripple(id: string | null): void {
    rippleId = id;
    applyRipple();
  }

  /** 기준 행 뒤 행을 흐리고 기준 행의 파급 배지만 보인다 (다시 그리지 않고 클래스만) */
  function applyRipple(): void {
    const anchor = confirming && confirming !== 'all' ? confirming : rippleId ?? reviewStore.currentId;
    const rows = [...root.querySelectorAll<HTMLElement>('.dg-rl-row')];
    const index = rows.findIndex((r) => r.dataset['id'] === anchor);
    rows.forEach((r, i) => {
      r.classList.toggle('dg-rl-dim', index >= 0 && i > index);
      r.classList.toggle('dg-rl-anchor', i === index);
    });
    const gaps = [...root.querySelectorAll<HTMLElement>('.dg-rl-gap')];
    for (const g of gaps) {
      // 기준 행 뒤의 직접 편집 표시도 함께 흐린다 (거절하면 되돌아간다)
      const next = g.nextElementSibling as HTMLElement | null;
      const nextIndex = next ? rows.indexOf(next) : rows.length;
      g.classList.toggle('dg-rl-dim', index >= 0 && nextIndex > index);
    }
  }

  function onListKey(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const gos = [...root.querySelectorAll<HTMLButtonElement>('.dg-rl-go')];
    const index = gos.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = gos[Math.max(0, Math.min(gos.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
  }

  const off = reviewStore.onChange(render);
  render();

  return {
    render,
    dispose(): void {
      disposed = true;
      off();
      root.remove();
    },
  };
}
