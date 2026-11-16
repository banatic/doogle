/**
 * 메모 말풍선 — 한글처럼 쪽 오른쪽에 메모를 띄우고, 메모가 걸린 글과 선으로 잇는다.
 *
 *  - 자료: 엔진의 `getMemoList()`(작성자·날짜·내용·걸린 자리)와 `getCursorRect*()`(그 자리의 쪽 좌표).
 *  - 자리: `#scroll-content` 안 장식 레이어. 쪽 좌표 → 화면 좌표는 `rhwpStudio.view.pageToContent`.
 *  - 쪽 오른쪽에 자리가 있도록 메모가 있는 동안 `#scroll-container` 에 오른쪽 안쪽 여백을 둔다
 *    (쪽은 남은 폭 가운데로 온다).
 *  - 말풍선 자체는 화면 전용이다. 인쇄·내보내기에는 넣지 않는다.
 *  - 말풍선을 누르면 메모가 걸린 글을 선택한다(본문과 표 한 겹까지).
 *  - 키보드: 말풍선에 초점을 두고 Enter(걸린 글로) · F2(고치기) · Delete(지우기).
 *  - 고칠 수 있는 메모는 연필(또는 두 번 누르기)로 내용을 고치고, 휴지통으로 지운다. 문서 수정은
 *    `host.transaction` 한 건이라 되돌리기 한 번으로 돌아온다. 작성자·날짜는 그대로다.
 */
import type { PluginHost, PluginTextRange, Tx } from '@/plugin/types';
import { icon } from './icons.ts';
import { memoBalloonsOn, setMemoBalloonsOn } from './memo-state.ts';
import './memo-balloons.css';

/** 쪽 오른쪽에 비워 두는 폭(px) = 틈 + 말풍선 + 바깥 여유 */
const ZONE_WIDTH = 252;
const BALLOON_GAP = 16;
const BALLOON_WIDTH = 216;
const STACK_GAP = 6;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 편집기 입력 처리로 새지 않게 막을 이벤트 — 말풍선 안의 글 상자·단추가 직접 받는다 */
const SHIELDED_EVENTS = [
  'pointerdown', 'mousedown', 'mouseup', 'dblclick', 'contextmenu',
  'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
  'compositionstart', 'compositionupdate', 'compositionend', 'copy', 'cut', 'paste', 'wheel',
];

type PathEntry =
  | { type: 'cell'; controlIndex: number; cellIndex: number; paraIndex: number }
  | { type: 'textbox'; controlIndex: number; paraIndex: number };

interface MemoEntry {
  id: number;
  index: number;
  author: string;
  date: string | null;
  text: string;
  sectionIndex: number;
  paraIndex: number | null;
  startCharIdx: number | null;
  endCharIdx: number | null;
  path: PathEntry[] | null;
  editable: boolean;
}

interface PageRect { pageIndex: number; x: number; y: number; height: number }

interface Placed {
  memo: MemoEntry;
  start: PageRect;
  /** 걸린 글이 한 줄 안에서 끝나면 그 끝. 여러 줄이면 null */
  end: PageRect | null;
  pageWidth: number;
}

type PageToContent = (pageIndex: number, x: number, y: number) => { left: number; top: number; zoom: number } | null;
type IconName = Parameters<typeof icon>[0];
type Doc = ReturnType<Tx['doc']>;

function pageToContent(): PageToContent | null {
  const view = (window as unknown as { rhwpStudio?: { view?: { pageToContent?: PageToContent } } }).rhwpStudio?.view;
  return typeof view?.pageToContent === 'function' ? view.pageToContent : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** `2026-04-14T21:36:44Z` → `2026.04.14 21:36` (이 컴퓨터 시각). 읽을 수 없으면 원문 그대로. */
export function formatMemoDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 겹치지 않게 위에서부터 쌓는다. `wanted` 는 오름차순이어야 한다. */
export function stackTops(wanted: readonly number[], heights: readonly number[], gap = STACK_GAP): number[] {
  const tops: number[] = [];
  let floor = -Infinity;
  for (let i = 0; i < wanted.length; i++) {
    const top = Math.max(wanted[i], floor);
    tops.push(top);
    floor = top + (heights[i] ?? 0) + gap;
  }
  return tops;
}

/** 메모가 걸린 글 범위(본문·표 한 겹). 더 깊으면 null. */
function rangeOf(memo: MemoEntry): PluginTextRange | null {
  if (memo.paraIndex === null || memo.startCharIdx === null || memo.endCharIdx === null) return null;
  const length = Math.max(0, memo.endCharIdx - memo.startCharIdx);
  const path = memo.path ?? [];
  if (path.length === 0) {
    return { section: memo.sectionIndex, paragraph: memo.paraIndex, charOffset: memo.startCharIdx, length };
  }
  if (path.length === 1 && path[0].type === 'cell') {
    const entry = path[0];
    return {
      section: memo.sectionIndex, paragraph: entry.paraIndex, charOffset: memo.startCharIdx, length,
      cell: {
        parentPara: memo.paraIndex, controlIndex: entry.controlIndex,
        cellIndex: entry.cellIndex, cellPara: entry.paraIndex,
      },
    };
  }
  return null;
}

export interface MemoBalloonsHandle {
  toggle(): void;
  refresh(): void;
  dispose(): void;
}

export function mountMemoBalloons(host: PluginHost): MemoBalloonsHandle {
  let layer: HTMLDivElement | null = null;
  let observed: Element | null = null;
  let timer: number | null = null;
  let disposed = false;
  /** 고치는 중이거나 지우기 확인 중인 메모. 그동안은 다시 그리지 않는다(쓰던 글이 사라지지 않게). */
  let busyId: number | null = null;

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = window.setTimeout(() => { timer = null; render(); }, 60);
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);

  function setZone(active: boolean): void {
    const sc = document.getElementById('scroll-container');
    // 문서 탭: 말풍선은 지금 문서에만 그린다 — 다른 문서의 스크롤 영역에 남은 자리는 걷는다
    // 자리는 CSS 변수로 낸다 — 스크롤 영역의 오른쪽 여백은 이 값과 다른 여백(유리 사이드바 자리)을 더한 것이다
    for (const other of document.querySelectorAll<HTMLElement>('.dg-doc-view')) {
      if (other !== sc && other.style.getPropertyValue('--dg-memo-zone')) other.style.removeProperty('--dg-memo-zone');
    }
    if (!sc) return;
    const want = active ? `${ZONE_WIDTH}px` : '';
    if (sc.style.getPropertyValue('--dg-memo-zone') !== want) {
      if (want) sc.style.setProperty('--dg-memo-zone', want);
      else sc.style.removeProperty('--dg-memo-zone');
    }
  }

  /** 문서에서 메모와 그 자리를 읽는다. 자리를 알 수 없는 메모는 뺀다. */
  function collect(): Placed[] {
    if (!host.borrowDocument()) return [];
    return host.read((doc) => {
      const memos = JSON.parse(doc.getMemoList()) as MemoEntry[];
      const widths = new Map<number, number>();
      const pageWidth = (pageIndex: number): number => {
        let width = widths.get(pageIndex);
        if (width === undefined) {
          width = Number((JSON.parse(doc.getPageInfo(pageIndex)) as { width?: number }).width) || 0;
          widths.set(pageIndex, width);
        }
        return width;
      };
      const rectAt = (memo: MemoEntry, offset: number): PageRect | null => {
        if (memo.paraIndex === null) return null;
        try {
          const path = memo.path ?? [];
          const json = path.length === 0
            ? doc.getCursorRect(memo.sectionIndex, memo.paraIndex, offset)
            : doc.getCursorRectByPath(memo.sectionIndex, memo.paraIndex, JSON.stringify(path.map((entry) => ({
              controlIndex: entry.controlIndex,
              cellIndex: entry.type === 'cell' ? entry.cellIndex : 0,
              cellParaIndex: entry.paraIndex,
            }))), offset);
          const rect = JSON.parse(json) as Partial<PageRect>;
          return typeof rect.pageIndex === 'number' && typeof rect.x === 'number' && typeof rect.y === 'number'
            ? { pageIndex: rect.pageIndex, x: rect.x, y: rect.y, height: rect.height ?? 0 }
            : null;
        } catch {
          return null;
        }
      };
      const placed: Placed[] = [];
      for (const memo of memos) {
        if (memo.startCharIdx === null) continue;
        const start = rectAt(memo, memo.startCharIdx);
        if (!start) continue;
        const tail = memo.endCharIdx !== null && memo.endCharIdx > memo.startCharIdx
          ? rectAt(memo, memo.endCharIdx)
          : null;
        const sameLine = !!tail && tail.pageIndex === start.pageIndex && Math.abs(tail.y - start.y) < 0.5 && tail.x > start.x;
        placed.push({ memo, start, end: sameLine ? tail : null, pageWidth: pageWidth(start.pageIndex) });
      }
      return placed;
    });
  }

  /** 문서의 메모를 바꾼다. 엔진이 거절하면 무변경으로 끝내고 사유를 돌려준다. */
  function change(label: string, run: (doc: Doc) => string): string | null {
    try {
      return host.transaction(label, (tx) => {
        const result = JSON.parse(run(tx.doc())) as { ok?: boolean; message?: string };
        if (result.ok) return null;
        tx.noChange();
        return result.message || '메모를 바꾸지 못했습니다.';
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  function finish(): void {
    busyId = null;
    render();
  }

  function toolButton(label: string, name: IconName, onClick: () => void): HTMLButtonElement {
    const b = el('button', 'dg-memo-tool');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(name, 13));
    b.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return b;
  }

  function textButton(label: string, kind: '' | 'primary' | 'danger', onClick: () => void): HTMLButtonElement {
    const b = el('button', kind ? `dg-memo-btn dg-memo-btn--${kind}` : 'dg-memo-btn', label);
    b.type = 'button';
    b.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return b;
  }

  /** 말풍선의 내용 자리를 글 상자·단추 줄로 바꾼다 */
  function openPanel(box: HTMLElement, memo: MemoEntry, body: HTMLElement[]): void {
    busyId = memo.id;
    box.classList.add('dg-memo--busy');
    box.querySelector('.dg-memo-text')?.setAttribute('hidden', '');
    box.querySelector('.dg-memo-tools')?.setAttribute('hidden', '');
    const panel = el('div', 'dg-memo-panel');
    panel.append(...body);
    box.append(panel);
  }

  function startEdit(box: HTMLElement, memo: MemoEntry): void {
    if (busyId !== null) return;
    const area = el('textarea', 'dg-memo-input');
    area.value = memo.text;
    area.rows = Math.min(8, Math.max(2, memo.text.split('\n').length + 1));
    area.setAttribute('aria-label', '메모 내용');
    const error = el('p', 'dg-memo-error');
    error.hidden = true;
    const save = () => {
      if (area.value === memo.text) { finish(); return; }
      const failed = change('메모 고치기', (doc) => doc.setMemoText(memo.id, area.value));
      if (failed) { error.textContent = failed; error.hidden = false; return; }
      finish();
    };
    area.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); finish(); }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
    });
    const actions = el('div', 'dg-memo-actions');
    actions.append(
      el('span', 'dg-memo-hint', 'Ctrl+Enter 저장'),
      textButton('취소', '', finish),
      textButton('저장', 'primary', save),
    );
    openPanel(box, memo, [area, error, actions]);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function startRemove(box: HTMLElement, memo: MemoEntry): void {
    if (busyId !== null) return;
    const error = el('p', 'dg-memo-error');
    error.hidden = true;
    const remove = () => {
      const failed = change('메모 지우기', (doc) => doc.removeMemo(memo.id));
      if (failed) { error.textContent = failed; error.hidden = false; return; }
      finish();
    };
    const confirm = textButton('지우기', 'danger', remove);
    const actions = el('div', 'dg-memo-actions');
    actions.append(textButton('취소', '', finish), confirm);
    openPanel(box, memo, [el('p', 'dg-memo-ask', '이 메모를 지울까요? 걸린 글은 그대로 남습니다.'), error, actions]);
    confirm.focus();
  }

  function balloon(memo: MemoEntry): HTMLElement {
    const box = el('article', 'dg-memo');
    box.dataset.memoId = String(memo.id);
    box.tabIndex = 0;
    box.setAttribute('aria-label', `메모 ${memo.index}, ${memo.author || '작성자 없음'}: ${memo.text}`);
    const head = el('header', 'dg-memo-head');
    head.append(el('span', 'dg-memo-author', memo.author || '메모'));
    const date = formatMemoDate(memo.date);
    if (date) head.append(el('time', 'dg-memo-date', date));
    if (memo.editable) {
      const tools = el('span', 'dg-memo-tools');
      tools.append(
        toolButton('메모 고치기', 'compose', () => startEdit(box, memo)),
        toolButton('메모 지우기', 'trash', () => startRemove(box, memo)),
      );
      head.append(tools);
      box.addEventListener('dblclick', () => startEdit(box, memo));
    }
    box.append(head, el('p', 'dg-memo-text', memo.text));
    const range = rangeOf(memo);
    if (range) {
      box.classList.add('dg-memo-jump');
      box.addEventListener('click', () => { if (busyId === null) host.selectTextRange(range); });
    }
    // 키보드: Enter 걸린 글로, F2 고치기, Delete 지우기 (말풍선 자체에 초점이 있을 때만)
    box.addEventListener('keydown', (event) => {
      if (event.target !== box || busyId !== null) return;
      if (event.key === 'Enter' && range) { event.preventDefault(); host.selectTextRange(range); }
      else if (event.key === 'F2' && memo.editable) { event.preventDefault(); startEdit(box, memo); }
      else if (event.key === 'Delete' && memo.editable) { event.preventDefault(); startRemove(box, memo); }
    });
    // 말풍선 안의 입력이 편집기 본문 입력으로 새지 않게 한다
    for (const type of SHIELDED_EVENTS) box.addEventListener(type, (event) => event.stopPropagation());
    return box;
  }

  function render(): void {
    if (disposed || busyId !== null) return;
    const content = document.querySelector<HTMLElement>('#scroll-container > #scroll-content');
    if (content !== observed) {
      if (observed) observer?.unobserve(observed);
      observed = content;
      if (content) observer?.observe(content);
    }
    // 다시 그려도 키보드 초점이 날아가지 않게, 초점이 있던 메모를 기억한다
    const focused = layer?.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).closest<HTMLElement>('.dg-memo')?.dataset.memoId ?? null
      : null;
    layer?.remove();
    layer = null;
    const toContent = pageToContent();
    if (!content || !toContent || !memoBalloonsOn()) { setZone(false); return; }

    let placed: Placed[];
    try {
      placed = collect();
    } catch (error) {
      console.warn('[doogle] 메모를 읽지 못했습니다', error);
      placed = [];
    }
    setZone(placed.length > 0);
    if (placed.length === 0) return;

    const root = el('div', 'dg-memo-layer');
    const lines = document.createElementNS(SVG_NS, 'svg');
    lines.setAttribute('class', 'dg-memo-lines');
    root.append(lines);

    interface Item { box: HTMLElement; wantedTop: number; left: number; fromX: number; fromY: number; edgeX: number }
    const items: Item[] = [];
    for (const { memo, start, end, pageWidth } of placed) {
      const a = toContent(start.pageIndex, start.x, start.y);
      const edge = toContent(start.pageIndex, pageWidth, start.y);
      if (!a || !edge) continue;
      const lineHeight = start.height * a.zoom;
      const tail = end ? toContent(end.pageIndex, end.x, end.y) : null;
      // 걸린 글 표시: 한 줄 범위면 그 범위, 아니면 시작 자리에 짧은 표시
      const mark = el('div', 'dg-memo-mark');
      const markWidth = tail ? Math.max(2, tail.left - a.left) : 3;
      mark.style.cssText = `left:${a.left}px;top:${a.top}px;width:${markWidth}px;height:${lineHeight}px`;
      root.append(mark);
      items.push({
        box: balloon(memo),
        wantedTop: a.top - 2,
        left: edge.left + BALLOON_GAP,
        fromX: a.left + markWidth,
        fromY: a.top + lineHeight,
        edgeX: edge.left,
      });
    }
    items.sort((p, q) => p.wantedTop - q.wantedTop || p.fromX - q.fromX);
    for (const item of items) {
      item.box.style.left = `${item.left}px`;
      item.box.style.width = `${BALLOON_WIDTH}px`;
      root.append(item.box);
    }
    content.append(root);
    layer = root;

    // 높이를 재고 겹치지 않게 쌓은 뒤 선을 긋는다
    const tops = stackTops(items.map((item) => item.wantedTop), items.map((item) => item.box.offsetHeight));
    items.forEach((item, i) => {
      item.box.style.top = `${tops[i]}px`;
      // 종이 위 구간과 종이 밖 구간을 따로 긋는다 — 종이는 어두운 테마에서도 흰색이다
      const y = Math.round(item.fromY) + 0.5;
      const onPaper = document.createElementNS(SVG_NS, 'path');
      onPaper.setAttribute('class', 'dg-memo-line-paper');
      onPaper.setAttribute('d', `M${item.fromX},${y} H${item.edgeX}`);
      const out = document.createElementNS(SVG_NS, 'path');
      out.setAttribute('class', 'dg-memo-line-out');
      out.setAttribute('d', `M${item.edgeX},${y} L${item.left},${tops[i] + 12}`);
      lines.append(onPaper, out);
    });
    if (focused) root.querySelector<HTMLElement>(`.dg-memo[data-memo-id="${focused}"]`)?.focus({ preventScroll: true });
  }

  const offs: Array<() => void> = [
    host.onDocumentSwap(() => { busyId = null; schedule(); }),
    ...['document-changed', 'document-view-changed', 'document-layout-refreshed', 'zoom-changed', 'viewport-resize']
      .map((name) => host.events.on(name, schedule)),
  ];
  window.addEventListener('resize', schedule);
  offs.push(() => window.removeEventListener('resize', schedule));
  // 문서 탭: 초점 문서가 바뀌면 그 문서의 메모로 다시 그린다
  const onDocFocus = () => { busyId = null; schedule(); };
  window.addEventListener('doogle:doc-focus', onDocFocus);
  offs.push(() => window.removeEventListener('doogle:doc-focus', onDocFocus));
  schedule();

  return {
    toggle() {
      setMemoBalloonsOn(!memoBalloonsOn());
      busyId = null;
      render();
    },
    refresh: schedule,
    dispose() {
      disposed = true;
      busyId = null;
      if (timer !== null) window.clearTimeout(timer);
      observer?.disconnect();
      for (const off of offs) off();
      layer?.remove();
      layer = null;
      setZone(false);
    },
  };
}
