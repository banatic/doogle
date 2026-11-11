/**
 * 에이전트 편집 표시 — 두글이 문서를 고치면 작은 커서 무리가 그 자리로 날아가 머물고,
 * 바뀐 영역 위로 강조가 한 번 쓸고 지나간다. 무엇이 바뀌는지 눈으로 따라갈 수 있게 하는 장식이다.
 *
 *  - 신호: 실행기가 쓰기마다 내는 window 이벤트 `doogle:agent-edit {rects, tool}` (쪽 px, 배율 1).
 *  - 위치: `window.rhwpStudio.view.pageToContent` (main.ts — 캐럿과 같은 계산) 로 #scroll-content 좌표.
 *    표시는 #scroll-content 안에 얹어 문서와 함께 스크롤된다. 입력은 받지 않는다(pointer-events: none).
 *  - 화면 밖 편집은 강조만 남기고 커서는 보내지 않는다 — 사용자의 스크롤을 빼앗지 않는다.
 *  - 편집이 멎고 2.5초가 지나면 커서는 흩어져 사라진다. prefers-reduced-motion 이면 강조만 옅게 보인다.
 *
 * swarm-cursors(DhvanilPatel)의 "커서 무리가 화면을 만든다" 는 발상에서 영감을 받았고, 코드는 가져오지 않았다.
 */
import './edit-swarm.css';

interface PageRect { pageIndex: number; x: number; y: number; width: number; height: number }
interface Box { left: number; top: number; width: number; height: number }
interface Pt { x: number; y: number }

type PageToContent = (pageIndex: number, x: number, y: number) => { left: number; top: number; zoom: number } | null;

const SWARM = 3;
const LINGER_MS = 2500;
const FLY_MS = 620;
const LABEL = '두글';

function pageToContent(): PageToContent | null {
  const view = (window as unknown as { rhwpStudio?: { view?: { pageToContent?: PageToContent } } }).rhwpStudio?.view;
  return typeof view?.pageToContent === 'function' ? view.pageToContent : null;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const POINTER_SVG = '<svg viewBox="0 0 16 20" width="16" height="20" aria-hidden="true">'
  + '<path d="M1.5 1.5 L1.5 16.2 L5.4 12.6 L8.2 18.6 L10.9 17.4 L8.2 11.5 L13.6 11.3 Z" /></svg>';

class Cursor {
  readonly el: HTMLDivElement;
  pos: Pt | null = null;
  private anim: Animation | null = null;

  constructor(index: number) {
    this.el = document.createElement('div');
    this.el.className = `dg-swarm-cursor dg-swarm-c${index}`;
    this.el.innerHTML = POINTER_SVG;
    if (index === 0) {
      const tag = document.createElement('span');
      tag.className = 'dg-swarm-tag';
      tag.textContent = LABEL;
      this.el.appendChild(tag);
    }
  }

  place(p: Pt): void {
    this.anim?.cancel();
    this.pos = p;
    this.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  /** 휘어진 길로 날아간다 (2차 베지어 — 조절점은 옆으로 비껴 무리가 갈라져 보이게) */
  fly(to: Pt, delay: number, bend: number): Promise<void> {
    const from = this.pos ?? to;
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ctrl = { x: mid.x - (dy / len) * bend, y: mid.y + (dx / len) * bend };
    const frames: Keyframe[] = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * ctrl.x + t * t * to.x;
      const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * ctrl.y + t * t * to.y;
      frames.push({ transform: `translate(${x}px, ${y}px)`, offset: t });
    }
    this.anim?.cancel();
    this.pos = to;
    this.el.style.transform = `translate(${to.x}px, ${to.y}px)`;
    const duration = Math.min(FLY_MS + len * 0.15, 1000);
    this.anim = this.el.animate(frames, { duration, delay, easing: 'cubic-bezier(0.22, 0.8, 0.25, 1)', fill: 'backwards' });
    return this.anim.finished.then(() => undefined, () => undefined);
  }

  /** 글을 치는 듯 한 줄을 따라 조금씩 나아간다 */
  type(along: Box): void {
    const start = this.pos ?? { x: along.left, y: along.top };
    const reach = Math.min(along.width, 140);
    const frames: Keyframe[] = [];
    const ticks = 7;
    for (let i = 0; i <= ticks; i++) {
      const x = start.x + (reach * i) / ticks;
      const jitter = i % 2 === 0 ? 0 : -1.5;
      frames.push({ transform: `translate(${x}px, ${start.y + jitter}px)`, offset: i / ticks });
    }
    this.anim?.cancel();
    this.pos = { x: start.x + reach, y: start.y };
    this.el.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;
    this.anim = this.el.animate(frames, { duration: 520, easing: 'steps(7, end)' });
  }
}

export interface EditSwarmHandle {
  /** 문서가 바뀌었을 때 등 — 표시를 모두 거둔다 */
  clear(): void;
  dispose(): void;
}

export function mountEditSwarm(): EditSwarmHandle {
  let layer: HTMLDivElement | null = null;
  const cursors: Cursor[] = [];
  let lingerTimer = 0;
  let live = false;

  function ensureLayer(): HTMLDivElement | null {
    const content = document.getElementById('scroll-content');
    if (!content) return null;
    if (layer && layer.parentElement === content) return layer;
    layer?.remove();
    layer = document.createElement('div');
    layer.className = 'dg-swarm';
    layer.setAttribute('aria-hidden', 'true');
    content.appendChild(layer);
    cursors.length = 0;
    for (let i = 0; i < SWARM; i++) {
      const c = new Cursor(i);
      cursors.push(c);
      layer.appendChild(c.el);
    }
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

  function viewport(): Box | null {
    const sc = document.getElementById('scroll-container');
    if (!sc) return null;
    return { left: sc.scrollLeft, top: sc.scrollTop, width: sc.clientWidth, height: sc.clientHeight };
  }

  function sweep(target: HTMLDivElement, boxes: Box[]): void {
    const calm = reducedMotion();
    boxes.slice(0, 24).forEach((b, i) => {
      const mark = document.createElement('div');
      mark.className = calm ? 'dg-swarm-mark dg-swarm-mark--calm' : 'dg-swarm-mark';
      mark.style.left = `${b.left}px`;
      mark.style.top = `${b.top}px`;
      mark.style.width = `${b.width}px`;
      mark.style.height = `${b.height}px`;
      mark.style.animationDelay = `${calm ? 0 : 180 + i * 45}ms`;
      target.appendChild(mark);
      mark.addEventListener('animationend', () => mark.remove(), { once: true });
    });
  }

  function retreat(): void {
    live = false;
    const v = viewport();
    cursors.forEach((c, i) => {
      if (!c.pos) return;
      const exit = v ? { x: v.left + v.width + 30, y: c.pos.y - 30 + i * 30 } : { x: c.pos.x + 200, y: c.pos.y };
      c.el.classList.add('dg-swarm-cursor--leaving');
      void c.fly(exit, i * 70, 40).then(() => {
        if (live) return;
        c.el.classList.remove('dg-swarm-cursor--on', 'dg-swarm-cursor--leaving');
        c.pos = null;
      });
    });
  }

  function onEdit(event: Event): void {
    const detail = (event as CustomEvent<{ rects?: PageRect[] }>).detail;
    const rects = Array.isArray(detail?.rects) ? detail.rects : [];
    const target = ensureLayer();
    if (!target || rects.length === 0) return;
    const boxes = toBoxes(rects);
    if (boxes.length === 0) return;
    sweep(target, boxes);

    const v = viewport();
    const first = boxes[0];
    const onScreen = !!v && first.top + first.height > v.top && first.top < v.top + v.height;
    if (!onScreen || reducedMotion()) return;

    // 무리가 갈 자리: 첫 사각형의 앞머리(대장) + 바뀐 범위 안 다른 두 곳
    const union = boxes.reduce((u, b) => ({
      left: Math.min(u.left, b.left),
      top: Math.min(u.top, b.top),
      right: Math.max(u.right, b.left + b.width),
      bottom: Math.max(u.bottom, b.top + b.height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const spots: Pt[] = [
      { x: first.left, y: first.top + first.height * 0.55 },
      { x: union.left + (union.right - union.left) * 0.62, y: union.top + (union.bottom - union.top) * 0.3 + 6 },
      { x: union.left + (union.right - union.left) * 0.85, y: Math.min(union.bottom, union.top + 90) - 4 },
    ];
    live = true;
    cursors.forEach((c, i) => {
      if (!c.pos && v) {
        // 사이드바 쪽(오른쪽)에서 들어온다
        c.place({ x: v.left + v.width + 24, y: spots[i].y - 40 + i * 36 });
      }
      c.el.classList.remove('dg-swarm-cursor--leaving');
      c.el.classList.add('dg-swarm-cursor--on');
      const arrived = c.fly(spots[i], i * 70, i === 0 ? 30 : (i % 2 ? 70 : -60));
      if (i === 0) void arrived.then(() => { if (live) c.type(first); });
    });
    window.clearTimeout(lingerTimer);
    lingerTimer = window.setTimeout(retreat, LINGER_MS);
  }

  function clear(): void {
    window.clearTimeout(lingerTimer);
    live = false;
    layer?.remove();
    layer = null;
    cursors.length = 0;
  }

  window.addEventListener('doogle:agent-edit', onEdit);
  return {
    clear,
    dispose(): void {
      window.removeEventListener('doogle:agent-edit', onEdit);
      clear();
    },
  };
}
