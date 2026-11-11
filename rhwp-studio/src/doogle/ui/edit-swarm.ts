/**
 * 에이전트 편집 표시 — 두글이 문서를 고치면 커서 무리가 화면 네 변에서 날아와 바뀐 줄을 토막 내 나눠 맡고,
 * 옛 글을 지우고 새 글을 치는 것처럼 보인 뒤 사방으로 흩어진다(시안 G "나눠 쓰기").
 *
 *  - 신호: 실행기가 쓰기마다 내는 window 이벤트 `doogle:agent-edit {rects, tool}` (쪽 px, 배율 1, 줄마다 사각형).
 *  - 위치: `window.rhwpStudio.view.pageToContent` (main.ts — 캐럿과 같은 계산) 로 #scroll-content 좌표.
 *    표시는 #scroll-content 안에 얹어 문서와 함께 스크롤된다. 입력은 받지 않는다(pointer-events: none).
 *  - 글은 캔버스에 그려지므로 실제로 지우고 치지 않는다. 편집은 이미 문서에 들어가 있고, 토막마다 종이색 덮개가
 *    오른쪽에서 자라며(지우기) 다시 왼쪽부터 걷히는(치기) 동안 커서가 그 가장자리를 따라간다.
 *  - 위 줄부터 0.28초씩 늦게 시작하되 줄끼리 기다리지 않는다(폭포). 치는 속도는 시간 예산에 맞춰
 *    한 번의 편집이 3초 남짓이면 끝난다. 커서는 최소 넷, 바뀐 줄 폭에 비례해 나눠 맡는다.
 *  - 스크롤이 편집을 따라간다: 첫 줄이 화면 밖이면 화면 3분의 1 지점으로 부드럽게 옮기고, 폭포가 내려가며
 *    아래 줄 차례가 오면 그 줄이 보이도록 따라 내려간다. 사용자가 방금(1.5초 안) 직접 스크롤했으면 따라가지
 *    않는다. 캐럿·키보드 초점은 건드리지 않는다(사이드바에 치던 글이 끊기지 않게).
 *  - 편집이 빨리 이어지면 앞 무리를 기다리지 않고 겹쳐 시작한다(뒤처지지 않게). 커서가 너무 많으면 강조만.
 *  - prefers-reduced-motion 이면 강조만 옅게 보인다.
 *
 * swarm-cursors(DhvanilPatel)의 "커서 무리가 화면을 만든다" 는 발상에서 영감을 받았고, 코드는 가져오지 않았다.
 */
import './edit-swarm.css';

interface PageRect { pageIndex: number; x: number; y: number; width: number; height: number }
interface Box { left: number; top: number; width: number; height: number }
interface Pt { x: number; y: number }

type PageToContent = (pageIndex: number, x: number, y: number) => { left: number; top: number; zoom: number } | null;

const MIN_CURSORS = 4;
const MAX_CURSORS = 8;
/** 동시에 떠 있을 수 있는 커서 — 넘치면 새 편집은 강조만 */
const MAX_LIVE = 16;
const MAX_LINES = 8;
const STAGGER_MS = 280;
const FLY_MS = 620;
const ERASE_MS = 280;
const TYPE_MS = 1000;
const LABEL = '두글';
const PALETTE = ['var(--dg-accent, #1f5fbf)', '#0f9488', '#6d4fd8', '#e0802f'];

function pageToContent(): PageToContent | null {
  const view = (window as unknown as { rhwpStudio?: { view?: { pageToContent?: PageToContent } } }).rhwpStudio?.view;
  return typeof view?.pageToContent === 'function' ? view.pageToContent : null;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const POINTER_SVG = '<svg viewBox="0 0 16 20" width="16" height="20" aria-hidden="true">'
  + '<path d="M1.5 1.5 L1.5 16.2 L5.4 12.6 L8.2 18.6 L10.9 17.4 L8.2 11.5 L13.6 11.3 Z" /></svg>';

/** 바뀐 줄 폭에 비례해 커서 수를 나눈다 (줄마다 최소 하나) */
export function allocateCursors(widths: readonly number[], total: number): number[] {
  const out = widths.map(() => 1);
  let left = Math.max(0, total - widths.length);
  const sum = widths.reduce((a, b) => a + b, 0) || 1;
  const want = widths.map((w) => (w / sum) * total);
  while (left > 0) {
    let best = 0;
    want.forEach((w, i) => { if (w - out[i] > want[best] - out[best]) best = i; });
    out[best]++;
    left--;
  }
  return out;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const done = (a: Animation) => a.finished.then(() => undefined, () => undefined);

function makeCursor(color: string, label: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dg-swarm-cursor';
  el.style.setProperty('--dg-swarm-color', color);
  el.innerHTML = POINTER_SVG;
  if (label) {
    const tag = document.createElement('span');
    tag.className = 'dg-swarm-tag';
    tag.textContent = LABEL;
    el.appendChild(tag);
  }
  return el;
}

function moveTo(el: HTMLElement, p: Pt): void {
  el.style.transform = `translate(${p.x}px, ${p.y}px)`;
}

/** 휘어진 길로 (2차 베지어 — 조절점을 옆으로 비켜 무리가 갈라져 보이게) */
function fly(el: HTMLElement, from: Pt, to: Pt, bend: number, duration = FLY_MS): Promise<void> {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ctrl = { x: mid.x - (dy / len) * bend, y: mid.y + (dx / len) * bend };
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * ctrl.x + t * t * to.x;
    const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * ctrl.y + t * t * to.y;
    frames.push({ transform: `translate(${x}px, ${y}px)`, offset: t });
  }
  moveTo(el, to);
  return done(el.animate(frames, { duration, easing: 'cubic-bezier(0.22, 0.8, 0.25, 1)', fill: 'backwards' }));
}

/** 줄 사각형들을 위에서 아래로, 같은 줄(겹치는 높이)은 하나로 */
export function orderLines(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: Box[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.top - b.top) < Math.min(last.height, b.height) * 0.5) {
      const right = Math.max(last.left + last.width, b.left + b.width);
      last.left = Math.min(last.left, b.left);
      last.width = right - last.left;
      last.height = Math.max(last.height, b.height);
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

export interface EditSwarmHandle {
  /** 문서가 바뀌었을 때 등 — 표시를 모두 거둔다 */
  clear(): void;
  dispose(): void;
}

export function mountEditSwarm(): EditSwarmHandle {
  let layer: HTMLDivElement | null = null;
  let live = 0;
  let generation = 0;
  /** 사용자가 마지막으로 직접 스크롤한 때 — 그 직후에는 편집을 따라 스크롤하지 않는다 */
  let userScrollAt = 0;
  const USER_SCROLL_GRACE_MS = 1500;
  const onUserScroll = (event: Event) => {
    const target = event.target as Element | null;
    if (event.type === 'keydown') {
      const key = (event as KeyboardEvent).key;
      if (!['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(key)) return;
    }
    if (target?.closest?.('#scroll-container')) userScrollAt = Date.now();
  };
  for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
    window.addEventListener(type, onUserScroll, { capture: true, passive: true });
  }

  /**
   * 줄이 보이도록 스크롤을 옮긴다. 이미 편히 보이면 그대로 둔다. at = 줄을 둘 높이(화면 비율).
   * 옮겼으면 스크롤이 가라앉을 때까지 기다린다.
   */
  async function follow(box: Box, at: number): Promise<void> {
    const sc = document.getElementById('scroll-container');
    if (!sc || Date.now() - userScrollAt < USER_SCROLL_GRACE_MS) return;
    const top = sc.scrollTop;
    const bottom = top + sc.clientHeight;
    const margin = Math.min(80, sc.clientHeight * 0.12);
    if (box.top >= top + margin && box.top + box.height <= bottom - margin) return;
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const next = Math.max(0, Math.min(max, box.top - sc.clientHeight * at));
    if (Math.abs(next - top) < 2) return;
    const calm = reducedMotion();
    sc.scrollTo({ top: next, behavior: calm ? 'auto' : 'smooth' });
    if (!calm) await wait(Math.min(520, 180 + Math.abs(next - top) * 0.25));
  }

  function ensureLayer(): HTMLDivElement | null {
    const content = document.getElementById('scroll-content');
    if (!content) return null;
    if (layer && layer.parentElement === content) return layer;
    layer?.remove();
    layer = document.createElement('div');
    layer.className = 'dg-swarm';
    layer.setAttribute('aria-hidden', 'true');
    content.appendChild(layer);
    return layer;
  }

  function toBoxes(rects: PageRect[]): Box[] {
    const map = pageToContent();
    if (!map) return [];
    const boxes: Box[] = [];
    for (const r of rects) {
      const a = map(r.pageIndex, r.x, r.y);
      if (!a) continue;
      boxes.push({ left: a.left, top: a.top, width: Math.max(4, r.width * a.zoom), height: Math.max(4, r.height * a.zoom) });
    }
    return boxes;
  }

  /** 지금 보이는 문서 영역 (#scroll-content 좌표) */
  function viewport(): Box | null {
    const sc = document.getElementById('scroll-container');
    if (!sc) return null;
    return { left: sc.scrollLeft, top: sc.scrollTop, width: sc.clientWidth, height: sc.clientHeight };
  }

  /** 보이는 영역 네 변 바깥의 한 점 — side 0 위, 1 오른쪽, 2 아래, 3 왼쪽 */
  function edgePoint(v: Box, side: number): Pt {
    const t = 0.15 + Math.random() * 0.7;
    const m = 28;
    if (side === 0) return { x: v.left + v.width * t, y: v.top - m };
    if (side === 1) return { x: v.left + v.width + m, y: v.top + v.height * t };
    if (side === 2) return { x: v.left + v.width * t, y: v.top + v.height + m };
    return { x: v.left - m, y: v.top + v.height * t };
  }

  function sweep(target: HTMLDivElement, box: Box, delay: number, calm: boolean): void {
    const mark = document.createElement('div');
    mark.className = calm ? 'dg-swarm-mark dg-swarm-mark--calm' : 'dg-swarm-mark';
    Object.assign(mark.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, animationDelay: `${delay}ms` });
    target.appendChild(mark);
    mark.addEventListener('animationend', () => mark.remove(), { once: true });
  }

  /** 토막 하나: 날아와서 → 덮개가 오른쪽부터 자라고(지우기) → 왼쪽부터 걷히며(치기) 커서가 따라간다 → 흩어진다 */
  async function runSegment(target: HTMLDivElement, seg: Box, index: number, delay: number, gen: number): Promise<void> {
    await wait(delay);
    if (gen !== generation) return;
    // 스크롤이 따라 내려갔을 수 있다 — 들어올 변은 지금 보이는 영역 기준
    const v = viewport();
    if (!v) return;
    const side = (index + Math.floor(Math.random() * 4)) % 4;
    const cursor = makeCursor(PALETTE[index % PALETTE.length], index === 0);
    const cover = document.createElement('div');
    cover.className = 'dg-swarm-cover';
    Object.assign(cover.style, { left: `${seg.left}px`, top: `${seg.top}px`, width: `${seg.width}px`, height: `${seg.height}px` });
    target.append(cover, cursor);
    const y = seg.top + seg.height * 0.45;
    const from = edgePoint(v, side);
    moveTo(cursor, from);
    cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
    const right = { x: seg.left + seg.width, y };
    const left = { x: seg.left, y };
    await fly(cursor, from, right, [50, -60, 70, -40][index % 4]);
    // 지우기: 덮개가 오른쪽에서 왼쪽으로 자라고 커서가 함께 물러난다
    // (덮개는 오른쪽 끝이 기준 — 지울 때 왼쪽으로 자라고, 칠 때 왼쪽부터 걷힌다. edit-swarm.css)
    const steps = Math.max(3, Math.min(12, Math.round(seg.width / 12)));
    const erasing = { duration: ERASE_MS, easing: `steps(${steps}, end)`, fill: 'forwards' as const };
    cover.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], erasing);
    await done(cursor.animate([{ transform: `translate(${right.x}px, ${right.y}px)` }, { transform: `translate(${left.x}px, ${left.y}px)` }], erasing));
    await wait(60);
    // 치기: 덮개가 왼쪽부터 걷히며 새 글이 드러나고 커서가 그 끝을 따라간다
    const typing = { duration: TYPE_MS, easing: `steps(${steps * 2}, end)`, fill: 'forwards' as const };
    cover.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], typing);
    await done(cursor.animate(
      Array.from({ length: 6 }, (_, k) => ({ transform: `translate(${left.x + (seg.width * k) / 5}px, ${y + (k % 2 ? -1.2 : 0)}px)` })),
      typing,
    ));
    cover.remove();
    moveTo(cursor, right);
    await wait(160);
    // 흩어지기: 들어온 쪽 반대편으로
    const exit = edgePoint(v, (side + 2) % 4);
    cursor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, delay: 220, fill: 'forwards' });
    await fly(cursor, right, exit, [30, -40, 40, -30][index % 4], 600);
    cursor.remove();
  }

  async function onEdit(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ rects?: PageRect[] }>).detail;
    const rects = Array.isArray(detail?.rects) ? detail.rects : [];
    const target = ensureLayer();
    if (!target || rects.length === 0) return;
    const lines = orderLines(toBoxes(rects));
    if (lines.length === 0) return;
    const calm = reducedMotion();
    // 스크롤이 편집을 따라간다 — 첫 줄을 화면 3분의 1 지점으로
    await follow(lines[0], 0.3);
    // 커서는 위에서부터 MAX_LINES 줄까지 맡는다 (나머지는 강조만)
    const animated = lines.slice(0, MAX_LINES);
    const total = Math.min(MAX_CURSORS, Math.max(MIN_CURSORS, animated.length));
    if (calm || live + total > MAX_LIVE) {
      lines.slice(0, 24).forEach((b, i) => sweep(target, b, i * 45, calm));
      return;
    }
    lines.slice(MAX_LINES, MAX_LINES + 16).forEach((b, i) => sweep(target, b, 600 + i * 45, false));

    const counts = allocateCursors(animated.map((b) => b.width), total);
    const gen = generation;
    const jobs: Promise<void>[] = [];
    let index = 0;
    animated.forEach((line, li) => {
      const k = Math.max(1, Math.min(counts[li], Math.floor(line.width / 24)));
      const w = line.width / k;
      const first = index;
      // 이 줄 차례가 오면, 화면 아래로 벗어나 있을 때 스크롤이 따라 내려간다
      const turn = wait(li * STAGGER_MS).then(() => (gen === generation ? follow(line, 0.6) : undefined));
      const segs: Promise<void>[] = [];
      for (let j = 0; j < k; j++) {
        const seg = { left: line.left + w * j, top: line.top, width: w, height: line.height };
        const at = first + j;
        segs.push(turn.then(() => runSegment(target, seg, at, j * 45, gen)));
        index++;
      }
      // 그 줄의 토막이 모두 쳐지면 줄을 한 번 쓸어 준다
      jobs.push(Promise.all(segs).then(() => { if (gen === generation) sweep(target, line, 0, false); }));
    });
    live += index;
    await Promise.all(jobs);
    live -= index;
  }

  const listener = (event: Event) => { void onEdit(event); };

  function clear(): void {
    generation++;
    live = 0;
    layer?.remove();
    layer = null;
  }

  window.addEventListener('doogle:agent-edit', listener);
  return {
    clear,
    dispose(): void {
      window.removeEventListener('doogle:agent-edit', listener);
      for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
        window.removeEventListener(type, onUserScroll, { capture: true });
      }
      clear();
    },
  };
}
