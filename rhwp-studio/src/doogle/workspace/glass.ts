/**
 * 유리 리본(실험) — 리본을 반투명 유리로 하고, 문서가 리본·탭 줄 뒤까지 올라가 비쳐 보이게 한다.
 *
 * 켜면 `<html data-dg-glass>` 가 붙고 glass.css 가 배치를 바꾼다:
 *  - #studio-header 가 문서 영역 위에 뜬다(문서 영역은 창 맨 위부터 시작한다).
 *  - 맨 위 칸의 스크롤 영역은 위쪽 안쪽 여백(머리 높이 + 탭 줄 + 눈금자)을 둬서, 처음에는 리본 아래에서
 *    시작하고 스크롤하면 리본 뒤로 지나간다.
 *
 * 편집기(엔진)는 스크롤 영역의 `clientHeight` 를 "보이는 높이"로 쓴다(캐럿 따라가기·쪽 맞춤·보이는 쪽 계산).
 * 안쪽 여백만큼은 리본에 가려 보이지 않으므로, 그 영역의 `clientHeight` 가 여백을 뺀 값을 내게 한다
 * (`trimClientHeight`). 엔진은 고치지 않는다.
 *
 * 끄는 법: 명령 입력(Ctrl+/) → "유리 리본(실험)" 또는 localStorage `doogle.glass` = '0'.
 */
import './glass.css';

const STORE_KEY = 'doogle.glass';
/** 문서 탭 줄 32 + 가로 눈금자 20 — glass.css 의 --dg-glass-strip 과 같은 값 */
const STRIP_PX = 52;

/** 떠 있는 사이드바와 문서·창 가장자리 사이 틈(px) — glass.css 의 값과 같다. 오른쪽 틈에는 문서의 세로 스크롤바가 보인다. */
const PANEL_GAP_LEFT = 8;
const PANEL_GAP_RIGHT = 18;
/** 이보다 좁은 창에서는 사이드바가 서랍이 된다(shell.css) — 문서 자리를 비워 두지 않는다 */
const DRAWER_WINDOW_PX = 900;

let headerHeight = 0;
/** 상태 표시줄 높이(px) — 문서가 그 뒤까지 내려간다 */
let footerHeight = 0;
/** 떠 있는 사이드바가 가리는 오른쪽 폭(px). 사이드바가 닫혀 있으면 0. */
let panelInset = 0;
let installed = false;

export function isGlassOn(): boolean {
  return document.documentElement.hasAttribute('data-dg-glass');
}

function stored(): boolean {
  try { return localStorage.getItem(STORE_KEY) !== '0'; } catch { return true; }
}

/**
 * 제목 막대와 리본 탭 줄을 한 줄로 — 유리가 켜져 있으면 탭 줄(.dg-tabs)을 제목 막대 안(빠른 실행 뒤)으로 옮기고,
 * 끄면 제자리(리본 패널 앞)로 되돌린다. 요소를 옮길 뿐이라 리본의 동작(선택·밑줄·접기)은 그대로다.
 */
function mergeTitleRow(on: boolean): void {
  const shell = document.querySelector<HTMLElement>('.dg-shell');
  const bar = shell?.querySelector<HTMLElement>('.dg-titlebar');
  const tabs = shell?.querySelector<HTMLElement>('.dg-tabs');
  const ribbon = shell?.querySelector<HTMLElement>(':scope > .dg-ribbon');
  if (!shell || !bar || !tabs) return;
  // 빠른 실행(저장·실행 취소·다시 실행·인쇄)은 상태 표시줄 오른쪽 끝으로 — 끄면 제목 막대의 제자리로
  const quick = document.querySelector<HTMLElement>('.dg-quick');
  const status = document.getElementById('status-bar');
  const sep = bar.querySelector('.dg-title-sep');
  if (quick && status) {
    if (on && quick.parentElement !== status) status.appendChild(quick);
    else if (!on && quick.parentElement === status) {
      if (sep) sep.after(quick);
      else bar.prepend(quick);
    }
  }
  if (on) {
    if (tabs.parentElement === bar) return;
    const after = bar.querySelector('.dg-quick') ?? sep;
    if (after) after.after(tabs);
    else bar.prepend(tabs);
  } else if (tabs.parentElement === bar) {
    if (ribbon) shell.insertBefore(tabs, ribbon);
    else shell.appendChild(tabs);
  }
}

function apply(on: boolean): void {
  document.documentElement.toggleAttribute('data-dg-glass', on);
  mergeTitleRow(on);
  // 배치가 바뀌었다 — 뷰포트 크기에 기대는 것들(뷰·눈금자·배율 맞춤)이 다시 재게 한다
  window.dispatchEvent(new Event('resize'));
}

export function setGlass(on: boolean): void {
  try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch { /* 이번 실행에만 적용 */ }
  apply(on);
}

export function toggleGlass(): boolean {
  const next = !isGlassOn();
  setGlass(next);
  return next;
}

/** 이 스크롤 영역에서 리본·탭 줄·눈금자에 가려지는 위쪽 높이(px). 유리가 꺼져 있거나 맨 위 칸이 아니면 0. */
export function glassInsetOf(container: Element): number {
  if (!isGlassOn()) return 0;
  const pane = container.closest<HTMLElement>('.dg-docpane');
  if (pane) {
    // 맨 위 칸이 아니어도 가로 눈금자(20px)는 문서 위에 얹혀 있다
    return (pane.dataset.top === 'true' ? headerHeight + STRIP_PX : 20)
      + (pane.dataset.bottom === 'true' ? footerHeight : 0);
  }
  // 문서 없음 자리(시작 화면)
  return container.closest('.dg-ws-empty') ? headerHeight + footerHeight : 0;
}

/** 이 스크롤 영역에서 떠 있는 사이드바에 가려지는 오른쪽 폭(px). 오른쪽 끝 칸이 아니면 0. */
export function glassRightOf(_container: Element): number {
  // 사이드바는 문서 위에 얹히기만 한다 — 열고 닫아도 문서 자리를 바꾸지 않으므로 폭을 줄이지 않는다.
  // (쪽을 비켜 주는 배치로 되돌리려면 여기서 오른쪽 끝 칸에 panelInset 을 돌려주고,
  //  glass.css 에서 그 칸의 스크롤 영역에 --dg-pane-right: var(--dg-glass-right) 를 다시 준다.)
  return 0;
}

/** 눈금자가 제 캔버스 크기를 재는 중 — 그동안은 폭을 줄이지 않는다 */
let rulerMeasuring = 0;

/**
 * 스크롤 영역의 clientHeight·clientWidth 가 가려진 만큼을 뺀 "보이는 크기"를 내게 한다(그 요소에만).
 * 편집기는 이 값으로 캐럿 따라가기·쪽 맞춤·보이는 쪽·가로 가운데 맞춤을 계산한다 — 폭을 줄이지 않으면
 * 사이드바를 열 때 편집기가 가려진 폭까지 보이는 것으로 알고 쪽을 왼쪽으로 밀었다가 되돌린다.
 * 눈금자만은 줄이지 않은 폭을 본다(`rulerUsesFullWidth`) — 눈금자 띠는 창 폭을 다 채운다.
 */
export function trimClientHeight(container: HTMLElement): void {
  const height = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get;
  const width = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')?.get;
  if (!height || !width) return;
  Object.defineProperty(container, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      // 눈금자는 스크롤바 자리까지 채운다 — 스크롤바를 뺀 높이로 그리면 띠 끝에 스크롤바 굵기만큼 빈칸이 남는다
      const full = rulerMeasuring > 0 ? this.offsetHeight : (height.call(this) as number);
      return Math.max(0, full - glassInsetOf(this));
    },
  });
  Object.defineProperty(container, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (rulerMeasuring > 0) return this.offsetWidth;
      return Math.max(0, (width.call(this) as number) - glassRightOf(this));
    },
  });
}

/** 이 눈금자가 캔버스 크기를 잴 때는 스크롤 영역의 줄이지 않은 폭을 보게 한다. */
export function rulerUsesFullWidth(ruler: unknown): void {
  const target = ruler as { syncCanvasSize?: (dpr: number) => void } | null;
  if (!target || typeof target.syncCanvasSize !== 'function') return;
  const sync = target.syncCanvasSize.bind(target);
  target.syncCanvasSize = (dpr: number): void => {
    rulerMeasuring += 1;
    try { sync(dpr); } finally { rulerMeasuring -= 1; }
  };
}

/**
 * 눈금자 캔버스가 바탕을 칠하기 전에 그 자리를 비우게 한다. 눈금자는 바탕을 불투명색으로 덮어 칠하는 것을
 * 전제로 지우지 않고 다시 그린다 — 유리에서는 바탕이 반투명이라 그대로 두면 칠이 겹쳐 점점 불투명해진다.
 */
export function clearBeforeFill(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const fillRect = ctx.fillRect.bind(ctx);
  ctx.fillRect = (x: number, y: number, w: number, h: number): void => {
    // (0,0) 에서 시작하는 칠 = 전체 바탕
    if (x === 0 && y === 0) ctx.clearRect(x, y, w, h);
    fillRect(x, y, w, h);
  };
}

/** 한 번만 설치한다 — 머리(제목 막대 + 리본) 높이를 재서 CSS 변수로 내놓는다. */
export function installGlass(): void {
  if (installed) return;
  installed = true;
  const header = document.getElementById('studio-header');
  if (!header) return;
  const measure = () => {
    const next = Math.round(header.getBoundingClientRect().height);
    if (next === headerHeight) return;
    headerHeight = next;
    document.documentElement.style.setProperty('--dg-glass-top', `${next}px`);
    if (isGlassOn()) window.dispatchEvent(new Event('resize'));
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(header);
  measure();

  // 상태 표시줄도 문서 위에 뜬다 — 높이를 재서 아래쪽 칸의 스크롤 영역이 그만큼 안쪽 여백을 두게 한다
  const footer = document.getElementById('status-bar');
  if (footer) {
    const measureFooter = () => {
      const next = Math.round(footer.getBoundingClientRect().height);
      if (next === footerHeight) return;
      footerHeight = next;
      document.documentElement.style.setProperty('--dg-glass-bottom', `${next}px`);
      if (isGlassOn()) window.dispatchEvent(new Event('resize'));
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureFooter).observe(footer);
    measureFooter();
  }

  // 떠 있는 사이드바: 그 폭만큼 오른쪽 끝 칸의 문서 자리를 비운다(쪽이 보이는 영역 가운데에 오게)
  const panel = document.getElementById('side-panel-host');
  if (panel) {
    const measurePanel = () => {
      const open = !panel.hidden && window.innerWidth >= DRAWER_WINDOW_PX;
      const next = open ? Math.round(panel.getBoundingClientRect().width) + PANEL_GAP_LEFT + PANEL_GAP_RIGHT : 0;
      if (next === panelInset) return;
      panelInset = next;
      document.documentElement.style.setProperty('--dg-glass-right', `${next}px`);
      if (isGlassOn()) window.dispatchEvent(new Event('resize'));
    };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measurePanel).observe(panel);
    new MutationObserver(measurePanel).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    window.addEventListener('resize', measurePanel);
    measurePanel();

    // 안전망: 문서 영역·창이 스크롤되는 일은 없어야 한다(glass.css 의 overflow: clip). 그래도 밀리면 되돌린다.
    const unscroll = (el: Element | null) => {
      if (el && (el.scrollLeft !== 0 || el.scrollTop !== 0)) el.scrollTo(0, 0);
    };
    for (const id of ['editor-area', 'studio-root', 'dg-workspace']) {
      const el = document.getElementById(id);
      el?.addEventListener('scroll', () => { if (isGlassOn()) unscroll(el); });
    }
    window.addEventListener('scroll', () => {
      if (isGlassOn() && (window.scrollX !== 0 || window.scrollY !== 0)) window.scrollTo(0, 0);
    });

    // 사이드바 접기·펴기 단추 — 리본 오른쪽 끝('더보기' 옆)의 패널 아이콘.
    // 문서 위에 따로 떠 있는 단추는 두지 않는다. 열려 있을 때는 사이드바 머리줄의 같은 아이콘으로도 접는다.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dg-panel-toggle';
    toggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg><span>AI 도우미</span>';
    const sync = () => {
      const open = !panel.hidden;
      const label = open ? 'AI 도우미 접기' : 'AI 도우미 펴기';
      toggle.setAttribute('aria-pressed', String(open));
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
    };
    toggle.addEventListener('mousedown', (e) => e.preventDefault());
    toggle.addEventListener('click', () => {
      (window as unknown as { rhwpStudio?: { automation?: { execute(id: string): unknown } } })
        .rhwpStudio?.automation?.execute('ext:doogle.toggle-panel');
    });
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    sync();
    // 리본은 이 뒤에 붙을 수 있다 — 붙으면 그 오른쪽 끝에 단다(리본이 제 폭을 재기 전에)
    const place = (): boolean => {
      const ribbon = document.querySelector<HTMLElement>('.dg-shell > .dg-ribbon');
      if (!ribbon) return false;
      if (toggle.parentElement !== ribbon) ribbon.appendChild(toggle);
      return true;
    };
    if (!place()) {
      const waitRibbon = new MutationObserver(() => { if (place()) waitRibbon.disconnect(); });
      waitRibbon.observe(header, { childList: true, subtree: true });
    }
  }
  apply(stored());
  // 셸(제목 막대·리본)이 이 뒤에 붙는 경우 — 붙으면 한 줄로 합친다
  if (!document.querySelector('.dg-shell .dg-tabs')) {
    const waiter = new MutationObserver(() => {
      if (!document.querySelector('.dg-shell .dg-tabs')) return;
      waiter.disconnect();
      mergeTitleRow(isGlassOn());
    });
    waiter.observe(header, { childList: true, subtree: true });
  }
}
