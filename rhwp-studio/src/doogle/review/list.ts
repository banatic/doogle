/**
 * 검토 목록 — 사이드바 안에 놓는 "검토 대기 중인 변경" 목록 부품.
 *
 * ```ts
 * import { mountReviewList } from '../review/list.ts';
 * const list = mountReviewList(container, { headHost, onError: (msg) => this.addNotice(msg, 'error') });
 * // … list.dispose();
 * ```
 *
 * - 행: 종류별 줄(위치 `3쪽 “사업명” 외 5곳` · 지운 글/넣은 글 또는 서식 값) + 적용 / 되돌리기.
 * - 머리줄(건수 · 모두 거절 · 모두 적용)은 `headHost` 가 있으면 그쪽(입력창 바로 위 고정 띠)에 그린다 —
 *   목록이 길어도 "모두 적용"이 늘 보인다.
 * - 뒤 행이 함께 되돌아가는 행의 단추는 "여기부터 되돌리기 (N건)" 이고, 단추에 손이 가면
 *   함께 되돌아갈 행을 목록에서 강조한다.
 * - 뒤 행·직접 고친 내용이 함께 되돌아가는 되돌리기는 행 아래 인라인 확인을 거친다.
 * - 행 사이에 사용자가 직접 고친 자리를 표시한다.
 * 상태는 reviewStore 하나를 본다 — 문서 위 막(overlay)과 같은 "지금 보는 변경"을 공유한다.
 */
import type { PendingChangeSet } from '../agent/types.ts';
import { describeChange, type ChangeLine, type Chip } from './describe.ts';
import { REVIEW_KEYS, chainSentence, impactSentence, rejectLabel } from './keys.ts';
import { reviewStore } from './state.ts';
import './list.css';

export interface ReviewListDeps {
  /** 검토 처리 실패 알림 (사이드바 알림 줄) */
  onError?(message: string): void;
  /** 머리 제목 (기본 "검토 대기") — 다른 대화의 변경이면 사이드바가 바꿔 줄 수 있다 */
  title?(rows: PendingChangeSet[]): string;
  /** 비면 container.hidden = true (기본 true) */
  hideWhenEmpty?: boolean;
  /** 다시 그린 뒤 (사이드바가 턴 동작 줄을 갱신할 때) */
  onRender?(count: number): void;
  /**
   * 머리줄(건수 · 모두 거절 · 모두 적용)을 그릴 자리. 없으면 목록 위에 그린다.
   * 비면 이 자리도 숨긴다.
   */
  headHost?: HTMLElement;
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

/** 서식 값 하나 — 색이면 견본을 앞에 둔다 */
export function chipNode(chip: Chip, className: string): HTMLElement {
  const node = el('span', className);
  if (chip.swatch) {
    const swatch = el('i', 'dg-swatch');
    swatch.style.backgroundColor = chip.swatch;
    swatch.setAttribute('aria-hidden', 'true');
    node.append(swatch);
  }
  node.append(chip.text);
  return node;
}

export function mountReviewList(container: HTMLElement, deps: ReviewListDeps = {}): ReviewListHandle {
  const root = el('div', 'dg-rl');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '검토 대기 중인 변경');
  container.append(root);
  const headHost = deps.headHost ?? null;
  const headRoot = headHost ? el('div', 'dg-rl dg-rl-bar') : null;
  if (headHost && headRoot) {
    headRoot.setAttribute('role', 'region');
    headRoot.setAttribute('aria-label', '검토 대기 중인 변경 모두 처리');
    headHost.append(headRoot);
  }
  /** 확인 중인 되돌리기 — 행 id 또는 'all' */
  let confirming: string | null = null;
  /** 되돌리기 단추에 손이 간 행 — 함께 되돌아갈 행을 강조한다 */
  let rippleId: string | null = null;
  let disposed = false;

  function find<T extends HTMLElement>(selector: string): T | null {
    return root.querySelector<T>(selector) ?? headRoot?.querySelector<T>(selector) ?? null;
  }

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
      find<HTMLButtonElement>('.dg-rl-confirm .dg-rl-danger')?.focus();
      return;
    }
    confirming = null;
    rippleId = null;
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
    find<HTMLElement>(sel)?.focus();
  }

  function confirmBlock(text: string, label: string, onYes: () => void): HTMLElement {
    const box = el('div', 'dg-rl-confirm');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-label', '되돌리기 확인');
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

  /** 한 줄: 위치(흐린 글) 아래에 바뀐 내용 */
  function lineNode(line: ChangeLine): HTMLElement {
    const node = el('span', 'dg-rl-line');
    if (line.where) node.append(el('span', 'dg-rl-loc dg-tnum', line.where));
    const what = el('span', 'dg-rl-what dg-keep-all');
    if (line.del || line.ins) {
      if (line.del) what.append(el('del', 'dg-rl-del', line.del));
      if (line.del && line.ins) {
        const arrow = el('span', 'dg-rl-arrow', '→');
        arrow.setAttribute('aria-label', '에서');
        what.append(' ', arrow, ' ');
      }
      if (line.ins) what.append(el('ins', 'dg-rl-ins', line.ins));
      if (line.note) what.append(el('span', 'dg-rl-more', ` ${line.note}`));
    } else if (line.chips.length > 0) {
      what.classList.add('dg-rl-fx');
      line.chips.forEach((chip, index) => {
        if (index > 0) {
          const dot = el('span', 'dg-rl-dot', '·');
          dot.setAttribute('aria-hidden', 'true');
          what.append(dot);
        }
        what.append(chipNode(chip, 'dg-rl-chip'));
      });
    } else {
      what.textContent = line.label;
    }
    node.append(what);
    return node;
  }

  function gap(text: string): HTMLElement {
    return el('li', 'dg-rl-gap', text);
  }

  function clear(): void {
    confirming = null;
    rippleId = null;
    root.replaceChildren();
    headRoot?.replaceChildren();
    if (headHost) headHost.hidden = true;
  }

  function render(): void {
    if (disposed) return;
    const rows = reviewStore.rows();
    const hide = deps.hideWhenEmpty !== false;
    if (rows.length === 0) {
      clear();
      if (hide) container.hidden = true;
      deps.onRender?.(0);
      return;
    }
    if (hide) container.hidden = false;
    if (headHost) headHost.hidden = false;
    if (confirming && confirming !== 'all' && !rows.some((r) => r.id === confirming)) confirming = null;
    if (rippleId && !rows.some((r) => r.id === rippleId)) rippleId = null;
    const busy = reviewStore.busy;
    const current = reviewStore.currentId;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && (active.closest?.('.dg-rl') === root || (headRoot && active.closest?.('.dg-rl') === headRoot))
      ? active.dataset['focusKey'] ?? null : null;

    // ─── 머리 ───
    const head = el('div', 'dg-rl-head');
    const title = deps.title?.(rows) ?? '검토 대기';
    const count = el('span', 'dg-rl-count dg-tnum', `${rows.length}건`);
    const rejectAll = button('dg-rl-btn dg-rl-quiet dg-rl-reject-all', '모두 거절', () => decide('reject'));
    rejectAll.dataset['focusKey'] = 'reject-all';
    rejectAll.title = '검토 대기 중인 변경을 모두 되돌립니다';
    const acceptAll = button('dg-rl-btn dg-rl-primary', '모두 적용', () => decide('accept'));
    acceptAll.dataset['focusKey'] = 'accept-all';
    acceptAll.append(kbd('Ctrl ↵'));
    acceptAll.setAttribute('aria-keyshortcuts', 'Control+Enter');
    rejectAll.disabled = busy;
    acceptAll.disabled = busy;
    head.append(el('span', 'dg-rl-title', title), count, el('span', 'dg-rl-grow'), rejectAll, acceptAll);
    const headParts: HTMLElement[] = [head];
    if (busy) headParts.push(el('p', 'dg-rl-wait', '응답이 끝나면 적용하거나 거절할 수 있습니다.'));
    if (confirming === 'all') {
      const impact = reviewStore.rejectImpact();
      headParts.push(confirmBlock(impactSentence(impact, true), `모두 거절 (${impact.count}건)`, () => decide('reject', undefined, true)));
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
      go.title = '문서에서 이 변경 보기';
      if (on) go.setAttribute('aria-current', 'true');
      go.setAttribute('aria-keyshortcuts', REVIEW_KEYS.reveal.aria);
      for (const line of view.lines) go.append(lineNode(line));

      const impact = reviewStore.rejectImpact(row.id);
      const acts = el('span', 'dg-rl-acts');
      const ok = button('dg-rl-act dg-rl-ok', '적용', () => decide('accept', row.id));
      ok.setAttribute('aria-label', `${view.location} 변경 적용`);
      ok.title = `적용 (${REVIEW_KEYS.accept.label})`;
      ok.dataset['focusKey'] = `ok:${row.id}`;
      const no = button('dg-rl-act dg-rl-no', rejectLabel(impact), () => decide('reject', row.id));
      no.setAttribute('aria-label', impact.later > 0
        ? `${view.location} 변경부터 되돌리기 — 아래 변경 ${impact.later}건도 함께 되돌아갑니다`
        : `${view.location} 변경 되돌리기`);
      no.title = `${impact.later > 0 ? '이 변경과 아래 변경을 함께 되돌립니다' : '이 변경을 되돌립니다'} (${REVIEW_KEYS.reject.label})`;
      no.dataset['focusKey'] = `no:${row.id}`;
      if (impact.later > 0) no.classList.add('dg-rl-chained');
      ok.disabled = busy;
      no.disabled = busy;
      // 되돌리기 단추에 손이 가면 함께 되돌아갈 행을 강조한다
      no.addEventListener('mouseenter', () => ripple(row.id));
      no.addEventListener('mouseleave', () => ripple(null));
      no.addEventListener('focus', () => ripple(row.id));
      no.addEventListener('blur', () => ripple(null));
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
      list.append(li);
    }
    if (reviewStore.trailingUserEdits()) list.append(gap('마지막 변경 뒤에 직접 고친 내용이 있습니다'));
    list.addEventListener('keydown', onListKey);

    if (headRoot) {
      headRoot.replaceChildren(...headParts);
      const caption = el('div', 'dg-rl-caption');
      caption.append(el('span', 'dg-rl-title', title), el('span', 'dg-rl-count dg-tnum', `${rows.length}건`));
      root.replaceChildren(caption, list);
    } else {
      root.replaceChildren(...headParts, list);
    }
    applyRipple();

    if (focusKey) find<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    if (confirming) find<HTMLButtonElement>('.dg-rl-confirm .dg-rl-danger')?.focus();
    deps.onRender?.(rows.length);
  }

  function ripple(id: string | null): void {
    rippleId = id;
    applyRipple();
  }

  /** 되돌리기 단추가 가리키는 행과 그 뒤 행을 강조한다 (다시 그리지 않고 클래스만) */
  function applyRipple(): void {
    const anchor = confirming && confirming !== 'all' ? confirming : rippleId;
    const rows = [...root.querySelectorAll<HTMLElement>('.dg-rl-row')];
    const index = anchor ? rows.findIndex((r) => r.dataset['id'] === anchor) : -1;
    // 행 단위 되돌리기가 없는 실행기면 어느 행이든 전체가 되돌아간다
    const from = index >= 0 && !reviewStore.pending?.rejectFrom ? 0 : index;
    rows.forEach((r, i) => {
      r.classList.toggle('dg-rl-revert', from >= 0 && i >= from);
      r.classList.toggle('dg-rl-anchor', i === index);
    });
    const gaps = [...root.querySelectorAll<HTMLElement>('.dg-rl-gap')];
    for (const g of gaps) {
      // 기준 행 뒤의 직접 편집 표시도 함께 강조한다 (되돌리면 사라진다)
      const next = g.nextElementSibling as HTMLElement | null;
      const nextIndex = next ? rows.indexOf(next) : rows.length;
      g.classList.toggle('dg-rl-revert', from >= 0 && nextIndex > from);
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
      headRoot?.remove();
    },
  };
}
