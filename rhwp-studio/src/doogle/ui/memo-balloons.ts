/**
 * 메모 말풍선 — 한글처럼 쪽 오른쪽에 메모를 띄우고, 메모가 걸린 글과 선으로 잇는다.
 *
 *  - 자료: 엔진의 `getMemoList()`(작성자·날짜·내용·걸린 자리)와 `getCursorRect*()`(그 자리의 쪽 좌표).
 *  - 자리: `#scroll-content` 안 장식 레이어. 쪽 좌표 → 화면 좌표는 `rhwpStudio.view.pageToContent`.
 *  - 쪽 오른쪽에 자리가 있도록 메모가 있는 동안 `#scroll-container` 에 오른쪽 안쪽 여백을 둔다
 *    (쪽은 남은 폭 가운데로 온다).
 *  - 화면 전용이다. 문서·인쇄·내보내기에는 아무것도 넣지 않는다.
 *  - 말풍선을 누르면 메모가 걸린 글을 선택한다(본문과 표 한 겹까지).
 */
import type { PluginHost, PluginTextRange } from '@/plugin/types';
import { memoBalloonsOn, setMemoBalloonsOn } from './memo-state.ts';
import './memo-balloons.css';

/** 쪽 오른쪽에 비워 두는 폭(px) = 틈 + 말풍선 + 바깥 여유 */
const ZONE_WIDTH = 252;
const BALLOON_GAP = 16;
const BALLOON_WIDTH = 216;
const STACK_GAP = 6;
const SVG_NS = 'http://www.w3.org/2000/svg';

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

  const schedule = () => {
    if (disposed || timer !== null) return;
    timer = window.setTimeout(() => { timer = null; render(); }, 60);
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);

  function setZone(active: boolean): void {
    const sc = document.getElementById('scroll-container');
    if (!sc) return;
    const want = active ? `${ZONE_WIDTH}px` : '';
    if (sc.style.paddingRight !== want) sc.style.paddingRight = want;
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

  function balloon(memo: MemoEntry): HTMLElement {
    const box = el('article', 'dg-memo');
    box.setAttribute('aria-label', `메모 ${memo.index}`);
    const head = el('header', 'dg-memo-head');
    head.append(el('span', 'dg-memo-author', memo.author || '메모'));
    const date = formatMemoDate(memo.date);
    if (date) head.append(el('time', 'dg-memo-date', date));
    box.append(head, el('p', 'dg-memo-text', memo.text));
    const range = rangeOf(memo);
    if (range) {
      box.classList.add('dg-memo-jump');
      box.title = '누르면 메모가 걸린 글을 선택합니다';
      box.addEventListener('click', () => { host.selectTextRange(range); });
    }
    return box;
  }

  function render(): void {
    if (disposed) return;
    const content = document.getElementById('scroll-content');
    if (content !== observed) {
      if (observed) observer?.unobserve(observed);
      observed = content;
      if (content) observer?.observe(content);
    }
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
      const box = balloon(memo);
      items.push({
        box,
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
      const path = document.createElementNS(SVG_NS, 'path');
      const y = Math.round(item.fromY) + 0.5;
      path.setAttribute('d', `M${item.fromX},${y} H${item.edgeX + 2} L${item.left},${tops[i] + 12}`);
      lines.append(path);
    });
  }

  const offs: Array<() => void> = [
    host.onDocumentSwap(schedule),
    ...['document-changed', 'document-view-changed', 'document-layout-refreshed', 'zoom-changed', 'viewport-resize']
      .map((name) => host.events.on(name, schedule)),
  ];
  window.addEventListener('resize', schedule);
  offs.push(() => window.removeEventListener('resize', schedule));
  schedule();

  return {
    toggle() {
      setMemoBalloonsOn(!memoBalloonsOn());
      render();
    },
    refresh: schedule,
    dispose() {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      observer?.disconnect();
      for (const off of offs) off();
      layer?.remove();
      layer = null;
      setZone(false);
    },
  };
}
