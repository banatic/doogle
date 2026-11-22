/**
 * 에이전트 편집 표시 — 두글이 문서를 고치면 커서 무리가 화면 네 변에서 날아와 바뀐 줄을 토막 내 나눠 맡고,
 * 옛 글을 지우고 새 글을 치는 것처럼 보인 뒤 사방으로 흩어진다(시안 G "나눠 쓰기").
 *
 *  - 신호: 실행기가 쓰기마다 내는 window 이벤트 `doogle:agent-edit {rects, tool}` (쪽 px, 배율 1, 줄마다 사각형).
 *  - 위치: `window.rhwpStudio.view.pageToContent` (main.ts — 캐럿과 같은 계산) 로 #scroll-content 좌표.
 *    표시는 #scroll-content 안에 얹어 문서와 함께 스크롤된다. 입력은 받지 않는다(pointer-events: none).
 *  - 글은 캔버스에 그려지므로 실제로 지우고 치지 않는다. 편집은 이미 문서에 들어가 있고, 토막마다 덮개가
 *    옛 글을 오른쪽부터 걷어 내고(지우기) 다시 왼쪽부터 걷히는(치기) 동안 커서가 그 가장자리를 따라간다.
 *  - 정말 바뀐 곳만 친다: 고치기 전·후 화면을 견줘 그대로인 줄은 빼고, 바뀐 줄도 달라진 데서부터만 덮는다
 *    (낱말 하나를 바꿨는데 문단을 통째로 다시 치지 않게).
 *  - 위 줄부터 0.28초씩 늦게 시작하되 줄끼리 기다리지 않는다(폭포). 치는 빠르기는 토막 폭과 무관하게 비슷하고
 *    (폭에 비례한 시간), 커서와 덮개는 한 번에 예약한 합성 애니메이션이라 편집이 겹쳐 들어와도 어긋나지 않는다.
 *  - 카메라(스크롤)는 주인이 하나다: 가장 최근 편집만 화면을 옮긴다. 첫 줄이 화면 밖이면 화면 3분의 1 지점으로
 *    미끄러져 가고, 폭포가 내려가면 치는 줄이 띠(화면 18~62%) 안에 머물게 한 줄씩 따라 내려간다. 줄들이 멀리
 *    떨어져 있으면(쪽을 건너뛰는 편집) 한 묶음을 다 친 뒤 다음 묶음으로 간다. 가로로 넘치는 쪽은 가로도 따라간다.
 *    사용자가 문서를 만지는 동안과 그 뒤 4초는 따라가지 않고, 가던 중이면 바로 멈춘다.
 *    캐럿·키보드 초점은 건드리지 않는다(사이드바에 치던 글이 끊기지 않게).
 *  - 편집이 빨리 이어지면 앞 무리를 기다리지 않고 겹쳐 시작한다(뒤처지지 않게). 커서가 너무 많으면 강조만.
 *  - prefers-reduced-motion 이면 강조만 옅게 보이고 스크롤은 미끄러지지 않고 바로 옮긴다.
 *
 * swarm-cursors(DhvanilPatel)의 "커서 무리가 화면을 만든다" 는 발상에서 영감을 받았고, 코드는 가져오지 않았다.
 */
import { isAgentEditOnFocusedDocument } from './runtime-wiring.ts';
import './edit-swarm.css';
import { bandTop, changedSpan, clusterLines, eraseMs, flightMs, panLeft, revealTop, springStep, typeMs, type Pixels } from './swarm-motion.ts';
import { commonColor, paperSamplePoints, type Rgba } from './swarm-paper.ts';

interface PageRect { pageIndex: number; x: number; y: number; width: number; height: number }
/** 실행기가 보내는 자리 — from 은 쓰기 직전 그 자리의 옛 위치 (새로 생긴 자리면 null) */
interface EditRect extends PageRect { from?: PageRect | null }
interface Box { left: number; top: number; width: number; height: number }
/** 바뀐 자리 하나와 그 옛 위치 (#scroll-content 좌표) */
interface Part { box: Box; from: Box | null }
/** 한 줄 — 같은 높이의 자리들을 합친 상자 */
interface Line extends Box { parts: Part[] }
interface Pt { x: number; y: number }

type PageToContent = (pageIndex: number, x: number, y: number) => { left: number; top: number; zoom: number } | null;

const MIN_CURSORS = 4;
const MAX_CURSORS = 8;
/** 동시에 떠 있을 수 있는 커서 — 넘치면 새 편집은 강조만 */
const MAX_LIVE = 16;
const MAX_LINES = 8;
/** 커서 없이 쓸어 주기만 하는 줄 수 — 넘는 줄은 표시하지 않는다 */
const MAX_SWEEPS = 120;
const STAGGER_MS = 280;
const LABEL = '두글';
const PALETTE = ['var(--dg-accent, #1f5fbf)', '#0f9488', '#6d4fd8', '#e0802f'];
/** 카메라 스프링의 빠르기 — 어떤 거리든 0.6초쯤이면 닿는다 */
const CAMERA_OMEGA = 11;
/** 카메라가 이만큼(px) 가까워지면 커서를 띄운다 — 다 멈출 때까지 기다리지 않는다 */
const CAMERA_NEAR_PX = 16;
/** 카메라를 기다리는 한도 — 화면이 가려져 프레임이 돌지 않아도 편집 표시는 이어 간다 */
const CAMERA_WAIT_MS = 800;
/** 사용자가 문서를 만진 뒤 이만큼은 따라가지 않는다 */
const USER_SCROLL_GRACE_MS = 4000;
/** 고치기 전·후 화면을 견줄 자리 수 — 넘는 자리는 견주지 않고 그대로 친다 */
const MAX_COMPARES = 48;
/** 쓰기 뒤 화면이 다시 그려지기를 기다리는 한도 — 넘으면 견주지 않고 예전처럼 줄을 통째로 친다 */
const REDRAW_WAIT_MS = 250;

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
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const at = (p: Pt) => `translate(${p.x}px, ${p.y}px)`;
const shiftX = (px: number) => `translateX(${px}px)`;

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

/** 휘어진 길로 (2차 베지어 — 조절점을 옆으로 비켜 무리가 갈라져 보이게). 끝나면 to 에 머문다 */
function fly(el: HTMLElement, from: Pt, to: Pt, bend: number, duration: number, easing: string): Animation {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // 가까운 길을 크게 휘면 커서가 맴도는 것처럼 보인다 — 길이에 맞춰 줄인다
  const curve = bend * Math.min(1, len / 240);
  const ctrl = { x: mid.x - (dy / len) * curve, y: mid.y + (dx / len) * curve };
  const frames: Keyframe[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * ctrl.x + t * t * to.x;
    const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * ctrl.y + t * t * to.y;
    frames.push({ transform: at({ x, y }), offset: t });
  }
  return el.animate(frames, { duration, easing, fill: 'forwards' });
}

/** 자리들을 위에서 아래로, 같은 줄(겹치는 높이)은 하나로 — 줄은 제 자리들(옛 위치 포함)을 지닌다 */
export function orderLines(parts: Part[]): Line[] {
  const sorted = [...parts].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  const out: Line[] = [];
  for (const part of sorted) {
    const b = part.box;
    const last = out[out.length - 1];
    if (last && Math.abs(last.top - b.top) < Math.min(last.height, b.height) * 0.5) {
      const right = Math.max(last.left + last.width, b.left + b.width);
      const bottom = Math.max(last.top + last.height, b.top + b.height);
      last.left = Math.min(last.left, b.left);
      last.top = Math.min(last.top, b.top);
      last.width = right - last.left;
      last.height = bottom - last.top;
      last.parts.push(part);
    } else {
      out.push({ ...b, parts: [part] });
    }
  }
  return out;
}

export interface EditSwarmHandle {
  /** 문서가 바뀌었을 때 등 — 표시를 모두 거둔다 */
  clear(): void;
  dispose(): void;
}

/** 스크롤 영역 — 문서 탭에서는 초점 문서의 것만 이 id 를 갖는다 */
function container(): HTMLElement | null {
  return document.getElementById('scroll-container');
}

/** 유리 화면은 이 요소의 clientHeight·clientWidth 를 "보이는 크기"로 바꿔 둔다(glass.ts) — 스크롤 한계는 원래 값으로 잰다 */
const nativeClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get;
const nativeClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')?.get;

function scrollLimits(sc: HTMLElement): { top: number; left: number } {
  const h = nativeClientHeight ? (nativeClientHeight.call(sc) as number) : sc.clientHeight;
  const w = nativeClientWidth ? (nativeClientWidth.call(sc) as number) : sc.clientWidth;
  return { top: Math.max(0, sc.scrollHeight - h), left: Math.max(0, sc.scrollWidth - w) };
}

/** 문서 위에 떠 있는 사이드바가 가리는 오른쪽 폭(px). 옆에 나란히 놓였거나 닫혀 있으면 0 */
function coveredRight(sc: HTMLElement): number {
  const panel = document.getElementById('side-panel-host');
  if (!panel || panel.hidden) return 0;
  const p = panel.getBoundingClientRect();
  const c = sc.getBoundingClientRect();
  if (p.width < 1 || p.bottom <= c.top || p.top >= c.bottom) return 0;
  const covered = c.right - (p.left - 8);
  // 문서를 거의 다 덮는 서랍(좁은 창)은 잠깐 열어 두는 것이다 — 그 밑으로 문서를 밀지 않는다
  return covered > 0 && covered < c.width * 0.6 ? covered : 0;
}

/**
 * 카메라 — 문서 스크롤을 옮기는 단 하나의 주인. 편집마다 번호를 받아 `claim` 하고, 주인만 `go` 할 수 있다.
 * 프레임마다 스프링으로 목표에 다가가므로 목표가 도중에 바뀌어도 속도가 이어진다. 다른 누군가(사용자·편집기의
 * 캐럿 따라가기)가 스크롤을 옮기면 물러난다.
 */
function createCamera() {
  let owner = 0;
  let frame = 0;
  let last = 0;
  // 축마다 — 목표, 내가 마지막으로 놓은 위치, 속도(px/초)
  const y = { to: null as number | null, at: 0, v: 0 };
  const x = { to: null as number | null, at: 0, v: 0 };
  let waiters: Array<() => void> = [];

  const release = () => {
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  };

  function stop(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    y.to = x.to = null;
    y.v = x.v = 0;
    release();
  }

  function tick(now: number): void {
    frame = 0;
    const sc = container();
    if (!sc) { stop(); return; }
    if ((y.to !== null && Math.abs(sc.scrollTop - y.at) > 2) || (x.to !== null && Math.abs(sc.scrollLeft - x.at) > 2)) { stop(); return; }
    // 첫 프레임은 한 프레임만큼만 간다 — 편집 직후에는 화면을 다시 그리느라 첫 프레임이 늦게 오는데,
    // 그 시간을 다 치면 출발하자마자 수백 px 를 건너뛴다
    const dt = last ? clamp((now - last) / 1000, 0.001, 0.064) : 1 / 60;
    last = now;
    const max = scrollLimits(sc);
    let near = true;
    const step = (axis: typeof y, limit: number, set: (v: number) => void): void => {
      if (axis.to === null) return;
      axis.to = clamp(axis.to, 0, limit);
      const s = springStep(axis.at - axis.to, axis.v, dt, CAMERA_OMEGA);
      if (Math.abs(s.x) < 0.5 && Math.abs(s.v) < 8) {
        set(axis.to);
        axis.to = null;
        axis.v = 0;
        return;
      }
      axis.at = axis.to + s.x;
      axis.v = s.v;
      set(axis.at);
      if (Math.abs(s.x) > CAMERA_NEAR_PX) near = false;
    };
    step(y, max.top, (v) => { sc.scrollTop = v; });
    step(x, max.left, (v) => { sc.scrollLeft = v; });
    if (near) release();
    if (y.to !== null || x.to !== null) frame = requestAnimationFrame(tick);
  }

  return {
    /** 이 편집이 이제 카메라의 주인이다 — 앞 편집은 더 옮기지 못한다. 먼저 온 편집이 늦게 불러도 주인을 뺏지 못한다 */
    claim(id: number): void { if (id > owner) owner = id; },
    owns(id: number): boolean { return owner === id; },
    /** 카메라가 향하는 곳(가는 중이면 목표, 아니면 지금 위치) */
    aim(): { top: number; left: number } | null {
      const sc = container();
      return sc ? { top: y.to ?? sc.scrollTop, left: x.to ?? sc.scrollLeft } : null;
    },
    /** 목표로 옮긴다. 가까이 닿으면(또는 한도가 지나면) 끝나는 약속 — 주인이 아니면 아무 일도 하지 않는다 */
    go(id: number, to: { top?: number | null; left?: number | null }): Promise<void> {
      const sc = container();
      if (id !== owner || !sc) return Promise.resolve();
      const max = scrollLimits(sc);
      const top = to.top == null ? null : clamp(to.top, 0, max.top);
      const left = to.left == null ? null : clamp(to.left, 0, max.left);
      if (reducedMotion() || document.visibilityState === 'hidden') {
        stop();
        if (top !== null) sc.scrollTop = top;
        if (left !== null) sc.scrollLeft = left;
        return Promise.resolve();
      }
      const aim = (axis: typeof y, value: number | null, now: number): void => {
        if (value === null) return;
        if (axis.to === null) {
          if (Math.abs(value - now) < 2) return;
          axis.at = now;
          axis.v = 0;
        }
        axis.to = value;
      };
      aim(y, top, sc.scrollTop);
      aim(x, left, sc.scrollLeft);
      if (y.to === null && x.to === null) return Promise.resolve();
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
      return Promise.race([new Promise<void>((resolve) => { waiters.push(resolve); }), wait(CAMERA_WAIT_MS)]);
    },
    stop,
  };
}

export function mountEditSwarm(): EditSwarmHandle {
  let layer: HTMLDivElement | null = null;
  let live = 0;
  let generation = 0;
  let editSeq = 0;
  const camera = createCamera();

  // ─── 사용자가 문서를 만지는 중인가 ──────────────────────
  // 휠·터치·스크롤 키·누르기(스크롤바 끌기 포함). 만지는 동안과 그 뒤 잠깐은 카메라가 끼어들지 않는다.
  let userScrollAt = 0;
  let pointerHeld = false;
  const userBusy = () => pointerHeld || Date.now() - userScrollAt < USER_SCROLL_GRACE_MS;
  const onUserScroll = (event: Event) => {
    const target = event.target as Element | null;
    if (event.type === 'keydown') {
      const key = (event as KeyboardEvent).key;
      if (!['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(key)) return;
    }
    if (!target?.closest?.('#scroll-container')) return;
    userScrollAt = Date.now();
    if (event.type === 'pointerdown') pointerHeld = true;
    camera.stop();
  };
  const onPointerEnd = (event: Event) => {
    // blur 는 창이 초점을 잃을 때만 본다(요소의 blur 는 누르는 도중에도 온다)
    if (!pointerHeld || (event.type === 'blur' && event.target !== window)) return;
    pointerHeld = false;
    userScrollAt = Date.now();
  };
  const USER_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
  const END_EVENTS = ['pointerup', 'pointercancel', 'blur'];
  for (const type of USER_EVENTS) window.addEventListener(type, onUserScroll, { capture: true, passive: true });
  for (const type of END_EVENTS) window.addEventListener(type, onPointerEnd, { capture: true, passive: true });

  /** 가로로 넘치는 쪽이면 상자가 보이는 폭 안에 들 가로 위치. 옮길 필요가 없으면 null */
  function panFor(sc: HTMLElement, box: Box): number | null {
    if (scrollLimits(sc).left < 1) return null;
    const left = camera.aim()?.left ?? sc.scrollLeft;
    return panLeft(left, sc.clientWidth - coveredRight(sc), box);
  }

  /** 편집(묶음)의 첫 줄이 보이게 — 화면 밖이면 화면 높이의 place 지점으로. 가까이 닿을 때까지 기다린다 */
  async function reveal(id: number, box: Box, place: number): Promise<void> {
    const sc = container();
    if (!sc || !camera.owns(id) || userBusy()) return;
    const top = revealTop(camera.aim()?.top ?? sc.scrollTop, sc.clientHeight, box, place);
    const left = panFor(sc, box);
    if (top === null && left === null) return;
    await camera.go(id, { top, left });
  }

  /** 치고 있는 줄이 띠 안에 머물게 — 벗어난 만큼만 미끄러진다. 기다리지 않는다 */
  function keep(id: number, box: Box): void {
    const sc = container();
    if (!sc || !camera.owns(id) || userBusy()) return;
    const top = bandTop(camera.aim()?.top ?? sc.scrollTop, sc.clientHeight, box);
    const left = panFor(sc, box);
    if (top !== null || left !== null) void camera.go(id, { top, left });
  }

  function ensureLayer(): HTMLDivElement | null {
    const content = document.querySelector<HTMLElement>('#scroll-container > #scroll-content');
    if (!content) return null;
    if (layer && layer.parentElement === content) return layer;
    layer?.remove();
    layer = document.createElement('div');
    layer.className = 'dg-swarm';
    layer.setAttribute('aria-hidden', 'true');
    content.appendChild(layer);
    return layer;
  }

  function toParts(rects: EditRect[]): Part[] {
    const map = pageToContent();
    if (!map) return [];
    const box = (r: PageRect): Box | null => {
      const a = map(r.pageIndex, r.x, r.y);
      return a ? { left: a.left, top: a.top, width: Math.max(4, r.width * a.zoom), height: Math.max(4, r.height * a.zoom) } : null;
    };
    const parts: Part[] = [];
    for (const r of rects) {
      const b = box(r);
      if (b) parts.push({ box: b, from: r.from ? box(r.from) : null });
    }
    return parts;
  }

  /** 보이는 문서 영역 (#scroll-content 좌표) — 카메라가 가는 중이면 닿을 곳 기준 */
  function viewport(): Box | null {
    const sc = container();
    const aim = camera.aim();
    if (!sc || !aim) return null;
    return { left: aim.left, top: aim.top, width: sc.clientWidth, height: sc.clientHeight };
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

  /** 커서가 맡지 않는 줄들 — 차례로 쓸어 주되 다 합쳐 2초 안에 끝낸다 */
  function sweepRest(target: HTMLDivElement, lines: Line[], start: number, calm: boolean): void {
    const rest = lines.slice(0, MAX_SWEEPS);
    const gap = Math.min(45, 2000 / Math.max(1, rest.length));
    rest.forEach((b, i) => sweep(target, b, start + i * gap, calm));
  }

  // ─── 고치기 전 화면 ──────────────────────────────────
  // 실행기가 쓰기 직전에 `doogle:agent-edit-before` 를 낸다. 그때 보이는 쪽 캔버스(옛 글)를 복사해 두고,
  // 쓰기 뒤 바뀐 토막을 그 옛 그림으로 덮어 둔다 — 커서가 도착할 때까지 옛 글이 보이고, 커서가 지우고
  // 새 글을 치는 것처럼 보인다(이미 채운 글을 또 채우지 않게). 화면 밖이라 찍지 못한 자리는 종이색으로 덮는다.
  interface Shot { image: HTMLCanvasElement; box: Box }
  let snapshot: { at: number; shots: Shot[] } | null = null;
  const SNAPSHOT_TTL_MS = 4000;

  function captureBefore(): void {
    const content = document.querySelector<HTMLElement>('#scroll-container > #scroll-content');
    const sc = container();
    if (!content || !sc || reducedMotion()) { snapshot = null; return; }
    const base = content.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    const shots: Shot[] = [];
    for (const canvas of content.querySelectorAll<HTMLCanvasElement>('canvas')) {
      if (canvas.width < 100 || canvas.height < 100 || canvas.closest('.dg-swarm')) continue;
      const r = canvas.getBoundingClientRect();
      if (r.width < 50 || r.bottom < view.top || r.top > view.bottom) continue;
      try {
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d')?.drawImage(canvas, 0, 0);
        shots.push({ image: copy, box: { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height } });
      } catch { /* 그릴 수 없는 캔버스는 건너뛴다 */ }
    }
    snapshot = { at: Date.now(), shots };
  }

  const holds = (outer: Box, r: Box) => r.left >= outer.left - 1 && r.top >= outer.top - 1
    && r.left + r.width <= outer.left + outer.width + 1 && r.top + r.height <= outer.top + outer.height + 1;

  function shotOf(shots: Shot[] | null, r: Box): Shot | undefined {
    return shots?.find((s) => holds(s.box, r));
  }

  // ─── 종이색 ──────────────────────────────────────────
  // 덮개는 그 자리의 바탕색으로 깐다. 쪽이 늘 흰 것은 아니다 — 음영을 넣은 표 칸이나 배경색이 있는 쪽에서
  // 흰 덮개를 깔면 편집하는 동안 흰 조각이 번쩍인다. 화면 그림에서 바탕 픽셀을 읽고, 못 읽으면 흰색.
  let probe: CanvasRenderingContext2D | null | undefined;

  /** 그림의 한 조각을 읽는다(RGBA). 읽을 수 없으면 null */
  function readPixels(image: HTMLCanvasElement, x: number, y: number, w: number, h: number): Uint8ClampedArray | null {
    if (probe === undefined) probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!probe || w < 1 || h < 1) return null;
    try {
      const c = probe.canvas;
      if (c.width < w) c.width = w;
      if (c.height < h) c.height = h;
      probe.clearRect(0, 0, w, h);
      probe.drawImage(image, x, y, w, h, 0, 0, w, h);
      return probe.getImageData(0, 0, w, h).data;
    } catch {
      return null; // 읽을 수 없는 캔버스
    }
  }

  /** r 자리의 바탕색을 shot(화면 그림)에서 읽는다 — 그 자리를 한 번에 읽어 표본 점들을 본다 */
  function paperColor(shot: Shot | undefined, r: Box): string {
    if (!shot) return '#ffffff';
    const k = shot.image.width / shot.box.width;
    const x = clamp(Math.floor((r.left - shot.box.left) * k), 0, shot.image.width - 1);
    const y = clamp(Math.floor((r.top - shot.box.top) * k), 0, shot.image.height - 1);
    const w = clamp(Math.ceil(r.width * k), 1, shot.image.width - x);
    const h = clamp(Math.ceil(r.height * k), 1, shot.image.height - y);
    const data = readPixels(shot.image, x, y, w, h);
    if (!data) return '#ffffff';
    return commonColor(paperSamplePoints(r).map((p): Rgba => {
      const sx = clamp(Math.floor((p.x - shot.box.left) * k) - x, 0, w - 1);
      const sy = clamp(Math.floor((p.y - shot.box.top) * k) - y, 0, h - 1);
      const i = (sy * w + sx) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    }));
  }

  /** 지금 화면에 그려진 쪽 캔버스들 — 고친 뒤의 화면 */
  function liveShots(): Shot[] {
    const content = document.querySelector<HTMLElement>('#scroll-container > #scroll-content');
    if (!content) return [];
    const base = content.getBoundingClientRect();
    const out: Shot[] = [];
    for (const canvas of content.querySelectorAll<HTMLCanvasElement>('canvas')) {
      if (canvas.width < 100 || canvas.height < 100 || canvas.closest('.dg-swarm')) continue;
      const c = canvas.getBoundingClientRect();
      if (c.width < 50) continue;
      out.push({ image: canvas, box: { left: c.left - base.left, top: c.top - base.top, width: c.width, height: c.height } });
    }
    return out;
  }

  /** 지금 화면에 그려진 쪽 캔버스 중 r 을 품은 것 */
  function liveShot(r: Box): Shot | undefined {
    return shotOf(liveShots(), r);
  }

  // ─── 정말 바뀐 곳 ──────────────────────────────────────
  // 고치기 전 화면(옛 위치)과 고친 뒤 화면(새 위치)의 픽셀을 견준다. 화면은 쓰기 뒤 조금 있다가 다시
  // 그려지므로(canvas-view 가 비동기로 그린다) 그려진 것을 확인한 뒤에 견준다.
  interface Raster extends Pixels { x: number; y: number }
  interface Verdict { span: { start: number; end: number } | null; k: number; w: number }

  /** 그림에서 상자들을 모두 품는 조각을 한 번에 읽는다 (x, y 는 그 조각이 시작하는 그림 픽셀) */
  function raster(shot: Shot, boxes: Box[]): Raster | null {
    const k = shot.image.width / shot.box.width;
    const l = Math.min(...boxes.map((b) => b.left)) - shot.box.left;
    const t = Math.min(...boxes.map((b) => b.top)) - shot.box.top;
    const r = Math.max(...boxes.map((b) => b.left + b.width)) - shot.box.left;
    const b = Math.max(...boxes.map((b) => b.top + b.height)) - shot.box.top;
    const x = clamp(Math.floor(l * k) - 1, 0, shot.image.width - 1);
    const y = clamp(Math.floor(t * k) - 1, 0, shot.image.height - 1);
    const width = clamp(Math.ceil(r * k) + 1, x + 1, shot.image.width) - x;
    const height = clamp(Math.ceil(b * k) + 1, y + 1, shot.image.height) - y;
    const data = readPixels(shot.image, x, y, width, height);
    return data ? { data, width, height, x, y } : null;
  }

  /** 자리마다 옛 화면(shots 의 옛 위치)과 지금 화면(새 위치)을 견준다. 견줄 그림이 없는 자리는 결과에 없다 */
  function compare(parts: Part[], shots: Shot[]): Map<Part, Verdict> {
    const live = liveShots();
    const pairs: Array<{ part: Part; src: Box; was: Shot; now: Shot }> = [];
    const need = new Map<HTMLCanvasElement, { shot: Shot; boxes: Box[] }>();
    const want = (shot: Shot, box: Box) => {
      const entry = need.get(shot.image) ?? { shot, boxes: [] };
      entry.boxes.push(box);
      need.set(shot.image, entry);
    };
    for (const part of parts) {
      const src = part.from ?? part.box;
      const was = shotOf(shots, src);
      const now = shotOf(live, part.box);
      if (!was || !now || Math.abs(now.image.width / now.box.width - was.image.width / was.box.width) > 0.01) continue;
      pairs.push({ part, src, was, now });
      want(was, src);
      want(now, part.box);
    }
    // 쪽마다 한 번씩만 읽는다 — 자리마다 읽으면 GPU 캔버스에서 그때마다 픽셀을 되읽어 온다
    const rasters = new Map([...need].map(([image, entry]) => [image, raster(entry.shot, entry.boxes)] as const));
    const out = new Map<Part, Verdict>();
    for (const { part, src, was, now } of pairs) {
      const a = rasters.get(was.image);
      const b = rasters.get(now.image);
      if (!a || !b) continue;
      const k = now.image.width / now.box.width;
      const w = Math.round(Math.min(part.box.width, src.width) * k);
      const h = Math.round(Math.min(part.box.height, src.height) * k);
      const span = changedSpan(
        a, Math.round((src.left - was.box.left) * k) - a.x, Math.round((src.top - was.box.top) * k) - a.y,
        b, Math.round((part.box.left - now.box.left) * k) - b.x, Math.round((part.box.top - now.box.top) * k) - b.y, w, h,
      );
      if (span !== undefined) out.set(part, { span, k, w });
    }
    return out;
  }

  /**
   * 쓰기 뒤 화면이 다시 그려질 때까지 기다린다 — 찍어 둔 옛 화면과 지금 화면의 "같은 자리"가 달라졌으면 그려진 것.
   * 한도 안에 달라지지 않으면 false (그리기가 늦거나, 보이는 데서는 바뀐 것이 없다).
   */
  async function untilRedrawn(parts: Part[], shots: Shot[]): Promise<boolean> {
    const same = parts.map((p) => ({ box: p.box, from: p.box }));
    const deadline = performance.now() + REDRAW_WAIT_MS;
    for (;;) {
      for (const v of compare(same, shots).values()) if (v.span) return true;
      if (performance.now() >= deadline) return false;
      await Promise.race([new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }), wait(50)]);
    }
  }

  /**
   * 정말 바뀐 곳만 남긴다 — 고치기 전 화면(옛 위치)과 지금 화면(새 위치)을 견줘, 그대로인 자리는 빼고
   * 바뀐 자리는 달라진 열부터 달라진 열까지로 좁힌다. 견줄 그림이 없는 자리(화면 밖)는 그대로 둔다.
   */
  function onlyChanged(parts: Part[], candidates: Part[], shots: Shot[]): Part[] {
    const verdicts = compare(candidates, shots);
    const out: Part[] = [];
    for (const part of parts) {
      const verdict = verdicts.get(part);
      if (!verdict) { out.push(part); continue; }
      const { span, k, w } = verdict;
      const src = part.from ?? part.box;
      // 새 자리가 옛 자리보다 크면 넘치는 만큼은 새 글이다
      const wider = part.box.width - src.width > 1.5;
      const taller = part.box.height - src.height > 1.5;
      if (!span && !wider && !taller) continue;
      if (taller) { out.push(part); continue; }
      const pad = 3;
      const l = Math.max(0, (span ? span.start : w) / k - pad);
      const r = wider || !span ? part.box.width : Math.min(part.box.width, span.end / k + pad);
      if (r - l < 1) continue;
      const fromWidth = part.from ? Math.min(part.from.width - l, r - l) : 0;
      out.push({
        box: { ...part.box, left: part.box.left + l, width: r - l },
        from: part.from && fromWidth >= 1 ? { ...part.from, left: part.from.left + l, width: fromWidth } : null,
      });
    }
    return out;
  }

  /**
   * 화면이 다시 그려질 때까지 옛 화면 그대로 덮어 두는 조각 — 옛 위치(src)의 픽셀을 새 위치(box)에 놓는다.
   * 쪽 캔버스의 픽셀 격자에 맞춰 놓아, 자리가 그대로인 줄은 얹어도 화면이 한 픽셀도 달라지지 않는다.
   */
  function holdCover(target: HTMLDivElement, box: Box, src: Box, shots: Shot[]): HTMLElement | null {
    const shot = shotOf(shots, src);
    if (!shot) return null;
    const k = shot.image.width / shot.box.width;
    const w = Math.max(1, Math.round(Math.min(box.width, src.width) * k));
    const h = Math.max(1, Math.round(Math.min(box.height, src.height) * k));
    const el = document.createElement('canvas');
    el.className = 'dg-swarm-hold';
    el.width = w;
    el.height = h;
    const snap = (v: number, origin: number) => origin + Math.round((v - origin) * k) / k;
    Object.assign(el.style, { left: `${snap(box.left, shot.box.left)}px`, top: `${snap(box.top, shot.box.top)}px`, width: `${w / k}px`, height: `${h / k}px` });
    try {
      el.getContext('2d')?.drawImage(shot.image, Math.round((src.left - shot.box.left) * k), Math.round((src.top - shot.box.top) * k), w, h, 0, 0, w, h);
    } catch {
      return null; // 그릴 수 없는 캔버스
    }
    target.append(el);
    return el;
  }

  /**
   * 토막 덮개. el 은 토막을 덮는 상자, hasOld 면 옛 글이 그려져 있어 지우기부터 한다.
   *  - 옛 화면이 있는 토막: el(잘라 내는 창) > inner > [blank 종이색, clip(잘라 내는 창) > old 옛 글].
   *    바뀐 자리마다 종이색을 깔고 그 위에 옛 글을 옛 위치에서 잘라 새 위치에 그린다. 줄이 늘었거나 칸이
   *    커져 옛 글보다 넓은 곳은 빈 종이 — 거기엔 새 글을 친다. 바뀐 자리 밖(표 괘선·칸 사이)은 덮지 않는다.
   *  - 옛 화면이 없는 토막(화면 밖이었다): 종이색 상자 하나. 색은 커서가 올 때 그려진 쪽에서 다시 읽는다(late).
   */
  interface Cover { el: HTMLDivElement; inner: HTMLElement | null; clip: HTMLElement | null; old: HTMLElement | null; hasOld: boolean; late: boolean }

  function plainCover(target: HTMLDivElement, seg: Box): Cover {
    const el = document.createElement('div');
    el.className = 'dg-swarm-cover';
    Object.assign(el.style, { left: `${seg.left}px`, top: `${seg.top}px`, width: `${seg.width}px`, height: `${seg.height}px` });
    const shot = liveShot(seg);
    el.style.background = paperColor(shot, seg);
    target.append(el);
    return { el, inner: null, clip: null, old: null, hasOld: false, late: !shot };
  }

  function makeCover(target: HTMLDivElement, seg: Box, parts: Part[], shots: Shot[] | null): Cover {
    const home = shotOf(shots, seg);
    if (!home) return plainCover(target, seg);
    const scale = home.image.width / home.box.width;
    const make = (cls: string) => {
      const c = document.createElement('canvas');
      c.className = cls;
      c.width = Math.max(1, Math.round(seg.width * scale));
      c.height = Math.max(1, Math.round(seg.height * scale));
      return c;
    };
    const blank = make('dg-swarm-blank');
    const old = make('dg-swarm-old');
    const bg = blank.getContext('2d');
    const og = old.getContext('2d');
    if (!bg || !og) return plainCover(target, seg);
    let hasOld = false;
    for (const { box, from } of parts) {
      const a = Math.max(seg.left, box.left);
      const b = Math.min(seg.left + seg.width, box.left + box.width);
      if (b - a < 0.5) continue;
      // 그 자리의 바탕색 — 고치기 전 화면의 같은 자리에서 읽는다 (음영 칸·색 있는 쪽)
      bg.fillStyle = og.fillStyle = paperColor(shotOf(shots, box), box);
      const dx = (a - seg.left) * scale;
      const dy = (box.top - seg.top) * scale;
      bg.fillRect(dx, dy, (b - a) * scale, box.height * scale);
      og.fillRect(dx, dy, (b - a) * scale, box.height * scale);
      if (!from) continue;
      // 옛 위치에서 같은 몫을 잘라 온다 — 옛 자리가 더 좁거나 낮으면 그만큼만
      const sx = from.left + (a - box.left);
      const w = Math.min(b - a, from.left + from.width - sx);
      const h = Math.min(box.height, from.height);
      if (w < 0.5 || h < 0.5) continue;
      const src = { left: sx, top: from.top, width: w, height: h };
      const shot = shotOf(shots, src);
      if (!shot) continue;
      const k = shot.image.width / shot.box.width;
      // 옛 화면 픽셀을 그대로 옮긴다(늘이지 않게 정수 픽셀로) — 번지면 글이 굵어 보인다
      const r = Math.round;
      og.drawImage(shot.image, r((src.left - shot.box.left) * k), r((src.top - shot.box.top) * k), r(w * k), r(h * k), r(dx), r(dy), r(w * k), r(h * k));
      hasOld = true;
    }
    const el = document.createElement('div');
    el.className = 'dg-swarm-cover dg-swarm-cover--old';
    Object.assign(el.style, { left: `${seg.left}px`, top: `${seg.top}px`, width: `${seg.width}px`, height: `${seg.height}px` });
    const inner = document.createElement('div');
    inner.className = 'dg-swarm-inner';
    const clip = document.createElement('div');
    clip.className = 'dg-swarm-clip';
    clip.append(old);
    inner.append(blank, clip);
    el.append(inner);
    target.append(el);
    return { el, inner, clip, old, hasOld, late: false };
  }

  /**
   * 토막 하나: 날아와서 → 지우기(옛 글이 오른쪽부터 사라진다. 옛 글이 없으면 건너뛴다) → 치기(덮개가 왼쪽부터
   * 걷히며 새 글이 드러나고 커서가 그 끝을 따라간다) → 흩어진다.
   * 날기·지우기·치기는 시작할 때 한꺼번에 예약한다(지연을 둔 합성 애니메이션) — 커서와 덮개가 같은 시계를 써서
   * 다음 편집이 들어와 화면을 다시 그리는 동안에도 서로 어긋나지 않는다.
   */
  async function runSegment(target: HTMLDivElement, seg: Box, index: number, delay: number, gen: number, cover: Cover): Promise<void> {
    await wait(delay);
    if (gen !== generation) return;
    const v = viewport();
    if (!v) { cover.el.remove(); return; }
    // 화면 밖이라 색을 못 읽었던 덮개 — 이제 그려진 쪽에서 바탕색을 읽어 맞춘다
    if (cover.late) cover.el.style.background = paperColor(liveShot(seg), seg);
    const side = (index + Math.floor(Math.random() * 4)) % 4;
    const cursor = makeCursor(PALETTE[index % PALETTE.length], index === 0);
    target.append(cursor);
    const w = seg.width;
    const y = seg.top + seg.height * 0.45;
    const right = { x: seg.left + w, y };
    const left = { x: seg.left, y };
    const from = edgePoint(v, side);
    // 지울 옛 글이 있으면 오른쪽 끝으로 와서 지우며 물러나고, 없으면 곧장 왼쪽 끝에서 친다
    const start = cover.hasOld ? right : left;
    const flying = flightMs(Math.hypot(start.x - from.x, start.y - from.y));
    const erasing = cover.hasOld ? eraseMs(w) : 0;
    const typing = typeMs(w);
    const typeAt = flying + erasing + (cover.hasOld ? 60 : 30);

    cursor.style.transform = at(from);
    cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
    fly(cursor, from, start, [50, -60, 70, -40][index % 4], flying, 'cubic-bezier(0.22, 0.8, 0.25, 1)');
    if (cover.hasOld && cover.clip && cover.old) {
      // 지우기: 잘라 내는 창이 왼쪽으로 가고 옛 글은 그만큼 되돌아와 제자리 — 오른쪽부터 사라진다
      const timing = { delay: flying, duration: erasing, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' as const };
      cover.clip.animate([{ transform: shiftX(0) }, { transform: shiftX(-w) }], timing);
      cover.old.animate([{ transform: shiftX(0) }, { transform: shiftX(w) }], timing);
      cursor.animate([{ transform: at(right) }, { transform: at(left) }], timing);
    }
    // 치기: 덮개가 왼쪽부터 걷히며 새 글이 드러나고 커서가 그 끝을 따라간다
    const reveal = { delay: typeAt, duration: typing, easing: 'linear', fill: 'forwards' as const };
    if (cover.inner) {
      cover.el.animate([{ transform: shiftX(0) }, { transform: shiftX(w) }], reveal);
      cover.inner.animate([{ transform: shiftX(0) }, { transform: shiftX(-w) }], reveal);
    } else {
      cover.el.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], reveal);
    }
    // 치는 손의 잔떨림 — 글자 두어 자마다 살짝 들썩인다
    const beats = clamp(Math.round(w / 36), 2, 16);
    const typed = cursor.animate(
      Array.from({ length: beats + 1 }, (_, k) => ({ transform: at({ x: left.x + (w * k) / beats, y: y + (k % 2 && k < beats ? -1.2 : 0) }) })),
      reveal,
    );
    await done(typed);
    cover.el.remove();
    if (gen !== generation) return;
    await wait(160);
    if (gen !== generation) return;
    // 흩어지기: 들어온 쪽 반대편으로 — 그사이 화면이 따라 내려갔을 수 있으니 지금 보이는 영역 기준
    const exit = edgePoint(viewport() ?? v, (side + 2) % 4);
    const leaving = flightMs(Math.hypot(exit.x - right.x, exit.y - right.y));
    cursor.animate([{ opacity: 1 }, { opacity: 0 }], { duration: leaving * 0.6, delay: leaving * 0.4, fill: 'forwards' });
    await done(fly(cursor, right, exit, [30, -40, 40, -30][index % 4], leaving, 'cubic-bezier(0.5, 0, 0.75, 0.4)'));
    cursor.remove();
  }

  async function onEdit(event: Event): Promise<void> {
    // 문서 탭: 에이전트가 초점이 아닌 문서를 고치는 중이면 그리지 않는다(자리가 이 문서의 것이 아니다)
    if (!isAgentEditOnFocusedDocument()) return;
    const detail = (event as CustomEvent<{ rects?: EditRect[] }>).detail;
    const rects = Array.isArray(detail?.rects) ? detail.rects : [];
    const target = ensureLayer();
    if (!target || rects.length === 0) return;
    const calm = reducedMotion();
    const gen = generation;
    // 편집의 차례 — 들어온 순서대로 매긴다(아래에서 화면을 기다리는 동안 다음 편집이 먼저 지나갈 수 있다)
    const id = ++editSeq;
    // 찍어 둔 옛 화면은 이 편집 한 번에만 쓴다 — 기다리는 사이 다음 편집이 제 화면을 찍어도 섞이지 않게 여기서 가져간다
    const shots = snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS ? snapshot.shots : null;
    snapshot = null;
    const dpr = window.devicePixelRatio || 1;
    // 덮개 경계를 화면 픽셀에 맞춘다 — 반 픽셀에 걸리면 옛 글이 번져 굵어 보인다
    const px = (v: number) => Math.round(v * dpr) / dpr;
    let parts = toParts(rects);
    if (shots && !calm) {
      // 화면은 조금 뒤에 다시 그려진다. 그때까지 옛 글로 덮어 두고(새 글이 먼저 비치지 않게), 그려지면
      // 옛 화면과 견줘 정말 바뀐 곳만 남긴다
      const candidates = [...parts].sort((a, b) => a.box.top - b.box.top)
        .filter((p) => shotOf(shots, p.box) && shotOf(shots, p.from ?? p.box)).slice(0, MAX_COMPARES);
      const held = candidates.map((p) => holdCover(target, p.box, p.from ?? p.box, shots));
      const redrawn = candidates.length > 0 && await untilRedrawn(candidates, shots);
      if (gen !== generation) return;
      if (redrawn) parts = onlyChanged(parts, candidates, shots);
      // 새 덮개를 깔 때까지(같은 작업 안) 옛 글 덮개를 둔다 — 아래에서 걷는다
      queueMicrotask(() => { for (const el of held) el?.remove(); });
    }
    const lines = orderLines(parts);
    if (lines.length === 0) return;
    // 가장 최근 편집이 카메라의 주인이다 — 앞 편집의 무리는 제자리에서 마저 치고, 화면은 더 옮기지 못한다
    camera.claim(id);
    // 커서는 위에서부터 MAX_LINES 줄까지 맡는다 (나머지는 강조만)
    const animated = lines.slice(0, MAX_LINES);
    const total = Math.min(MAX_CURSORS, Math.max(MIN_CURSORS, animated.length));
    if (calm || live + total > MAX_LIVE) {
      await reveal(id, lines[0], 0.3);
      sweepRest(target, lines, 0, calm);
      return;
    }
    // 토막을 나누고 곧바로(스크롤·비행 전에) 덮는다 — 새 글이 먼저 보이지 않게
    const counts = allocateCursors(animated.map((b) => b.width), total);
    const plan = new Map(animated.map((line, li) => {
      const k = Math.max(1, Math.min(counts[li], Math.floor(line.width / 24)));
      const w = line.width / k;
      return [line, Array.from({ length: k }, (_, j) => {
        const l = px(line.left + w * j);
        const seg = { left: l, top: px(line.top), width: px(line.left + w * (j + 1)) - l, height: px(line.height) };
        return { seg, cover: makeCover(target, seg, line.parts, shots) };
      })] as const;
    }));
    sweepRest(target, lines.slice(MAX_LINES), 600, false);

    const count = [...plan.values()].reduce((n, segs) => n + segs.length, 0);
    live += count;
    // 가까운 줄끼리 묶음 — 카메라는 한 묶음을 다 보여 준 뒤 다음 묶음으로 간다
    const groups = clusterLines(animated, (container()?.clientHeight ?? 600) * 0.5);
    const running: Promise<unknown>[] = [];
    let index = 0;
    for (let g = 0; g < groups.length && gen === generation; g++) {
      await reveal(id, groups[g][0], 0.3);
      if (gen !== generation) break;
      const jobs = groups[g].map((line, i) => {
        const first = index;
        const segs = plan.get(line) ?? [];
        index += segs.length;
        // 이 줄 차례가 오면 화면이 따라 내려간다(띠를 벗어난 만큼만)
        const turn = wait(i * STAGGER_MS).then(() => { if (gen === generation) keep(id, line); });
        // 그 줄의 토막이 모두 쳐지면 줄을 한 번 쓸어 준다
        return Promise.all(segs.map(({ seg, cover }, j) => turn.then(() => runSegment(target, seg, first + j, j * 45, gen, cover))))
          .then(() => { if (gen === generation) sweep(target, line, 0, false); });
      });
      const all = Promise.all(jobs);
      running.push(all);
      // 카메라를 쥐고 있는 동안만 이 묶음이 끝나기를 기다린다 — 주인이 바뀌었으면 남은 묶음은 곧바로 시작한다
      if (g < groups.length - 1 && camera.owns(id) && !userBusy()) await all;
    }
    await Promise.all(running);
    // 그사이 clear() 가 집계를 0 으로 되돌렸으면(문서가 바뀜) 빼지 않는다 — 음수가 되면 상한이 풀린다
    if (gen === generation) live -= count;
  }

  const listener = (event: Event) => { void onEdit(event); };
  const beforeListener = () => { if (isAgentEditOnFocusedDocument()) captureBefore(); };

  function clear(): void {
    generation++;
    live = 0;
    camera.stop();
    layer?.remove();
    layer = null;
  }

  window.addEventListener('doogle:agent-edit', listener);
  window.addEventListener('doogle:agent-edit-before', beforeListener);
  return {
    clear,
    dispose(): void {
      window.removeEventListener('doogle:agent-edit', listener);
      window.removeEventListener('doogle:agent-edit-before', beforeListener);
      for (const type of USER_EVENTS) window.removeEventListener(type, onUserScroll, { capture: true });
      for (const type of END_EVENTS) window.removeEventListener(type, onPointerEnd, { capture: true });
      clear();
    },
  };
}
