/**
 * 문서 영역 — 탭 줄과 화면 나누기(칸). 두글 전용.
 *
 * 화면 구조(#editor-area 안, 원래 눈금자·스크롤 영역 자리 전체):
 *
 *   #dg-workspace
 *     .dg-ws-empty      문서가 하나도 없을 때 — 원래의 #scroll-container(시작 화면이 여기 붙는다)
 *     .dg-docpane          칸. 하나 또는 둘(좌우 / 상하)
 *       .dg-doctabs        탭 줄
 *       .dg-docstack       그 칸의 문서 틀이 겹쳐 있다 — 활성 탭의 틀만 보인다
 *         .dg-docframe     문서 하나의 틀: 눈금자 + 스크롤 영역(.dg-doc-view)
 *     .dg-docsplit      칸 사이 경계(끌어서 폭 조절)
 *
 * 세션(문서)과 "지금 문서"는 doc-hub.ts 가 쥔다. 이 파일은 칸·탭의 배치와 조작만 맡는다:
 *  - 초점 세션의 스크롤 영역만 id="scroll-container" 를 갖는다 — 그 id 를 찾는 기존 코드
 *    (두글 문서 위 표시·보기 명령)가 고치지 않아도 초점 문서를 대상으로 한다.
 *  - 같은 문서를 두 칸에 여는 것은 지원하지 않는다(편집기 묶음이 문서와 1:1 이다) — 나누기는 탭을 옮긴다.
 */
import './workspace.css';
import type { DocHub, DocSession, SessionFrame, WorkspaceUi } from './doc-hub.ts';

const TAB_MIME = 'application/x-doogle-tab';
const MIN_PANE_RATIO = 0.2;

type Orientation = 'row' | 'column';
type DropSide = 'here' | 'right' | 'down';

interface Tab {
  key: number;
  frame: SessionFrame;
  session: DocSession | null;
  pane: Pane;
}

interface Pane {
  el: HTMLElement;
  tabsEl: HTMLElement;
  stackEl: HTMLElement;
  dropEl: HTMLElement;
  tabs: Tab[];
  active: Tab | null;
}

export interface Workspace {
  /** 초점 탭 닫기(저장 안 한 변경이 있으면 묻는다) */
  closeFocused(): Promise<boolean>;
  /** 열린 문서를 모두 닫아도 되는지 차례로 묻는다 — 창 닫기용. 하나라도 취소하면 false */
  confirmCloseAll(): Promise<boolean>;
  /** 초점 탭을 다른 칸으로(없으면 새 칸을 만들어) 옮긴다 */
  splitFocused(side: 'right' | 'down'): boolean;
  /** 다음/이전 탭 */
  cycle(delta: number): void;
  /** 경로가 같은 열린 문서로 간다. 있으면 true */
  focusPath(path: string): boolean;
}

let workspace: Workspace | null = null;

export function getWorkspace(): Workspace | null {
  return workspace;
}

const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_SPLIT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

function normPath(path: string): string {
  return /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path;
}

export function mountWorkspace(hub: DocHub): Workspace | null {
  if (workspace) return workspace;
  const area = document.getElementById('editor-area');
  const found = document.getElementById('scroll-container');
  if (!area || !found) return null;
  const original: HTMLElement = found;

  const root = document.createElement('div');
  root.id = 'dg-workspace';
  root.className = 'dg-ws';
  const empty = document.createElement('div');
  empty.className = 'dg-ws-empty';
  area.classList.add('dg-ws-on');
  area.insertBefore(root, original);
  // 원래의 스크롤 영역은 "문서 없음" 자리로 남긴다 — 시작 화면(empty-canvas)이 여기에 붙는다
  original.classList.add('dg-doc-view');
  empty.appendChild(original);
  root.appendChild(empty);

  const panes: Pane[] = [];
  let orientation: Orientation = 'row';
  let ratio = 0.5;
  let focusedPane: Pane | null = null;
  let nextKey = 1;
  let splitter: HTMLElement | null = null;
  let dragging: Tab | null = null;

  const allTabs = (): Tab[] => panes.flatMap((p) => p.tabs);
  const tabOf = (session: DocSession | null): Tab | null =>
    (session ? allTabs().find((t) => t.session === session) ?? null : null);

  // ── 칸 ─────────────────────────────────────────────

  function createPane(): Pane {
    const el = document.createElement('div');
    el.className = 'dg-docpane';
    const tabsEl = document.createElement('div');
    tabsEl.className = 'dg-doctabs';
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.setAttribute('aria-label', '열린 문서');
    const stackEl = document.createElement('div');
    stackEl.className = 'dg-docstack';
    const dropEl = document.createElement('div');
    dropEl.className = 'dg-tabdrop';
    dropEl.setAttribute('aria-hidden', 'true');
    stackEl.appendChild(dropEl);
    el.append(tabsEl, stackEl);
    const pane: Pane = { el, tabsEl, stackEl, dropEl, tabs: [], active: null };

    // 칸을 누르면 그 칸의 활성 문서가 초점 문서가 된다(편집기의 mousedown 보다 먼저)
    // 탭 줄은 탭이 스스로 처리한다 — 여기서 먼저 초점을 옮기면 탭 줄이 다시 그려져 누른 탭이 눌림을 못 받는다
    el.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement | null)?.closest('.dg-doctabs')) focusPane(pane);
    }, true);
    // 끌어 놓기(파일·카드)도 놓은 칸의 문서가 대상이어야 한다
    el.addEventListener('drop', () => { focusPane(pane); }, true);

    // 탭 줄: 가로 휠로 넘기기, 탭 끌어 놓기(순서 바꾸기·칸 옮기기)
    tabsEl.addEventListener('wheel', (e) => {
      if (e.deltaY !== 0 && tabsEl.scrollWidth > tabsEl.clientWidth) {
        tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    tabsEl.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    tabsEl.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const tab = dragging;
      const before = (e.target as HTMLElement | null)?.closest<HTMLElement>('.dg-doctab');
      const index = before ? pane.tabs.findIndex((t) => String(t.key) === before.dataset.key) : pane.tabs.length;
      moveTab(tab, pane, index < 0 ? pane.tabs.length : index);
    });

    // 문서 자리: 탭을 끌어다 놓으면 이 칸으로 옮기거나(둘로 나뉜 상태) 나눈다(한 칸 상태)
    const sideAt = (e: DragEvent): DropSide => {
      if (panes.length > 1) return 'here';
      const r = stackEl.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      if (x > 0.6) return 'right';
      if (y > 0.6) return 'down';
      return 'here';
    };
    dropEl.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      dropEl.dataset.side = sideAt(e);
    });
    dropEl.addEventListener('dragleave', () => { delete dropEl.dataset.side; });
    dropEl.addEventListener('drop', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const tab = dragging;
      const side = sideAt(e);
      delete dropEl.dataset.side;
      if (side === 'here') moveTab(tab, pane, pane.tabs.length);
      else splitTab(tab, side);
    });
    return pane;
  }

  function layoutPanes(): void {
    root.dataset.orientation = orientation;
    root.dataset.split = panes.length > 1 ? 'true' : 'false';
    splitter?.remove();
    splitter = null;
    for (const pane of panes) {
      if (pane.el.parentElement !== root) root.appendChild(pane.el);
      pane.el.style.flex = '';
    }
    if (panes.length === 2) {
      panes[0].el.style.flex = `${ratio} 1 0`;
      panes[1].el.style.flex = `${1 - ratio} 1 0`;
      splitter = document.createElement('div');
      splitter.className = 'dg-docsplit';
      splitter.setAttribute('role', 'separator');
      splitter.setAttribute('aria-orientation', orientation === 'row' ? 'vertical' : 'horizontal');
      splitter.setAttribute('aria-label', '칸 경계 — 끌어서 크기 조절, 두 번 누르면 반반');
      splitter.tabIndex = -1;
      root.insertBefore(splitter, panes[1].el);
      const bar = splitter;
      bar.addEventListener('pointerdown', (down) => {
        if (down.button !== 0) return;
        down.preventDefault();
        bar.setPointerCapture(down.pointerId);
        root.dataset.resizing = 'true';
        const move = (e: PointerEvent) => {
          const r = root.getBoundingClientRect();
          const next = orientation === 'row' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
          ratio = Math.min(1 - MIN_PANE_RATIO, Math.max(MIN_PANE_RATIO, next));
          panes[0].el.style.flex = `${ratio} 1 0`;
          panes[1].el.style.flex = `${1 - ratio} 1 0`;
        };
        const up = () => {
          delete root.dataset.resizing;
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.removeEventListener('pointercancel', up);
        };
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
      });
      bar.addEventListener('dblclick', () => { ratio = 0.5; layoutPanes(); });
    }
  }

  function ensurePane(): Pane {
    if (focusedPane && panes.includes(focusedPane)) return focusedPane;
    if (panes.length === 0) {
      panes.push(createPane());
      layoutPanes();
    }
    focusedPane = panes[0];
    return focusedPane;
  }

  function removePane(pane: Pane): void {
    const index = panes.indexOf(pane);
    if (index < 0) return;
    panes.splice(index, 1);
    pane.el.remove();
    if (focusedPane === pane) focusedPane = panes[0] ?? null;
    layoutPanes();
  }

  function focusPane(pane: Pane): void {
    const session = pane.active?.session;
    if (!session || hub.focused === session) return;
    hub.focus(session);
  }

  // ── 탭 ─────────────────────────────────────────────

  function createFrame(): SessionFrame {
    const frameRoot = document.createElement('div');
    frameRoot.className = 'dg-docframe';
    const corner = document.createElement('div');
    corner.className = 'dg-ruler-corner';
    const hRuler = document.createElement('canvas');
    hRuler.className = 'dg-hruler';
    const vRuler = document.createElement('canvas');
    vRuler.className = 'dg-vruler';
    const container = document.createElement('div');
    container.className = 'dg-doc-view';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', original.getAttribute('aria-label') ?? '문서 페이지');
    container.tabIndex = 0;
    const content = document.createElement('div');
    content.id = 'scroll-content';
    container.appendChild(content);
    frameRoot.append(corner, hRuler, vRuler, container);
    return { root: frameRoot, hRuler, vRuler, container };
  }

  function activateTab(tab: Tab, focusEditor = true): boolean {
    if (!tab.session) return false;
    if (!hub.focus(tab.session)) return false;
    if (focusEditor) tab.session.engine.inputHandler.focus();
    return true;
  }

  function moveTab(tab: Tab, target: Pane, index: number): void {
    const source = tab.pane;
    const from = source.tabs.indexOf(tab);
    if (source === target) {
      if (from === index || from + 1 === index) return;
      source.tabs.splice(from, 1);
      source.tabs.splice(index > from ? index - 1 : index, 0, tab);
      render();
      return;
    }
    // 틀을 다른 칸으로 옮기면 스크롤 위치가 풀린다 — 기억했다가 되돌린다
    const { scrollTop, scrollLeft } = tab.frame.container;
    source.tabs.splice(from, 1);
    if (source.active === tab) source.active = source.tabs[Math.min(from, source.tabs.length - 1)] ?? null;
    target.tabs.splice(Math.min(index, target.tabs.length), 0, tab);
    tab.pane = target;
    target.stackEl.appendChild(tab.frame.root);
    target.active = tab;
    focusedPane = target;
    if (source.tabs.length === 0) removePane(source);
    render();
    tab.frame.container.scrollTop = scrollTop;
    tab.frame.container.scrollLeft = scrollLeft;
    if (tab.session) {
      if (hub.focused === tab.session) tab.session.engine.inputHandler.focus();
      else activateTab(tab);
    }
  }

  /** 탭을 옆(아래) 칸으로 보낸다. 칸이 하나면 새 칸을 만든다 — 그 칸에 탭이 하나뿐이면 나눌 것이 없다. */
  function splitTab(tab: Tab, side: 'right' | 'down'): boolean {
    if (panes.length >= 2) {
      const other = panes.find((p) => p !== tab.pane);
      if (!other) return false;
      moveTab(tab, other, other.tabs.length);
      return true;
    }
    if (tab.pane.tabs.length < 2) return false;
    orientation = side === 'right' ? 'row' : 'column';
    ratio = 0.5;
    const pane = createPane();
    panes.push(pane);
    layoutPanes();
    moveTab(tab, pane, 0);
    return true;
  }

  async function closeTab(tab: Tab): Promise<boolean> {
    const session = tab.session;
    if (!session || session.disposed) return false;
    if (!hub.canSwitch()) return false;
    // 확인 대화상자(저장 안 한 변경·검토 대기 변경)가 이 문서를 가리키게 먼저 초점을 옮긴다
    if (!hub.focus(session)) return false;
    const { confirmLeaveDocument } = await import('../shell/close-guard');
    if (!(await confirmLeaveDocument())) return false;
    if (session.disposed) return true;
    const pane = tab.pane;
    const at = pane.tabs.indexOf(tab);
    const neighbor = pane.tabs[at + 1] ?? pane.tabs[at - 1] ?? panes.find((p) => p !== pane)?.active ?? null;
    hub.dispose(session, neighbor?.session ?? null);
    const next = hub.focused;
    if (next) next.engine.inputHandler.focus();
    return true;
  }

  async function closeOthers(keep: Tab): Promise<void> {
    for (const tab of [...keep.pane.tabs]) {
      if (tab === keep) continue;
      if (!(await closeTab(tab))) break;
    }
    activateTab(keep);
  }

  async function openTabMenu(tab: Tab, anchor: HTMLElement): Promise<void> {
    const { openPopupMenu } = await import('../shell/popup-menu');
    const split = panes.length >= 2;
    const canSplit = split || tab.pane.tabs.length >= 2;
    const path = tab.session?.path ?? null;
    openPopupMenu(anchor, [
      { label: '닫기', shortcut: 'Ctrl+W', onPick: () => { void closeTab(tab); } },
      { label: '다른 탭 닫기', disabled: tab.pane.tabs.length < 2, onPick: () => { void closeOthers(tab); } },
      { label: '', separator: true },
      ...(split
        ? [{ label: '다른 칸으로 옮기기', shortcut: 'Ctrl+\\', onPick: () => { splitTab(tab, 'right'); } }]
        : [
          { label: '오른쪽으로 나누기', shortcut: 'Ctrl+\\', disabled: !canSplit, onPick: () => { splitTab(tab, 'right'); } },
          { label: '아래로 나누기', disabled: !canSplit, onPick: () => { splitTab(tab, 'down'); } },
        ]),
      ...(canSplit ? [] : [{ label: '문서를 둘 이상 열면 나눌 수 있습니다', heading: true }]),
      { label: '', separator: true },
      { label: '경로 복사', disabled: !path, onPick: () => { if (path) void navigator.clipboard?.writeText(path).catch(() => {}); } },
    ], '탭', false);
  }

  function tabLabel(tab: Tab): string {
    const name = tab.session?.wasm.fileName ?? '';
    return name || (tab.session?.ready ? '문서' : '여는 중…');
  }

  function renderTabs(pane: Pane): void {
    const paneFocused = pane === focusedPane && hub.focused !== null;
    pane.el.dataset.focused = String(paneFocused);
    const existing = new Map<string, HTMLElement>();
    for (const el of pane.tabsEl.querySelectorAll<HTMLElement>('.dg-doctab')) existing.set(el.dataset.key ?? '', el);
    const order: HTMLElement[] = [];
    for (const tab of pane.tabs) {
      const key = String(tab.key);
      let el = existing.get(key);
      existing.delete(key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'dg-doctab';
        el.dataset.key = key;
        el.setAttribute('role', 'tab');
        el.draggable = true;
        const dot = document.createElement('span');
        dot.className = 'dg-doctab-dot';
        dot.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'dg-doctab-label';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'dg-doctab-close';
        close.tabIndex = -1;
        close.innerHTML = ICON_CLOSE;
        el.append(dot, label, close);
        const self = el;
        const current = () => allTabs().find((t) => String(t.key) === self.dataset.key) ?? null;
        el.addEventListener('mousedown', (e) => {
          if (e.button === 1) { e.preventDefault(); return; }
          if (e.button !== 0 || (e.target as HTMLElement).closest('.dg-doctab-close')) return;
          const t = current();
          if (t) activateTab(t);
        });
        el.addEventListener('auxclick', (e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          const t = current();
          if (t) void closeTab(t);
        });
        el.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          const t = current();
          if (t) activateTab(t);
        });
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const t = current();
          if (t) void openTabMenu(t, self);
        });
        close.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          const t = current();
          if (t) void closeTab(t);
        });
        el.addEventListener('dragstart', (e) => {
          const t = current();
          if (!t || !t.session || !hub.canSwitch()) { e.preventDefault(); return; }
          dragging = t;
          e.dataTransfer?.setData(TAB_MIME, self.dataset.key ?? '');
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
          root.dataset.tabDrag = 'true';
        });
        el.addEventListener('dragend', () => {
          dragging = null;
          delete root.dataset.tabDrag;
          for (const p of panes) delete p.dropEl.dataset.side;
        });
      }
      const selected = pane.active === tab;
      const dirty = !!tab.session && tab.session.ready && tab.session.documentState.isDirty();
      const name = tabLabel(tab);
      el.setAttribute('aria-selected', String(selected));
      el.tabIndex = selected ? 0 : -1;
      el.dataset.dirty = String(dirty);
      el.title = `${tab.session?.path ?? name}${dirty ? '\n저장 안 한 변경 있음' : ''}`;
      const label = el.querySelector<HTMLElement>('.dg-doctab-label')!;
      if (label.textContent !== name) label.textContent = name;
      const close = el.querySelector<HTMLElement>('.dg-doctab-close')!;
      close.setAttribute('aria-label', `${name} 닫기`);
      close.title = '닫기 (Ctrl+W)';
      order.push(el);
    }
    for (const el of existing.values()) el.remove();
    // 줄 끝: 새 문서 · 나누기
    let actions = pane.tabsEl.querySelector<HTMLElement>('.dg-doctab-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'dg-doctab-actions';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'dg-doctab-action';
      add.innerHTML = ICON_PLUS;
      add.title = '새 문서 (Alt+N)';
      add.setAttribute('aria-label', '새 문서');
      add.addEventListener('mousedown', (e) => e.preventDefault());
      add.addEventListener('click', () => {
        focusPane(pane);
        (window as unknown as { rhwpStudio?: { automation?: { execute(id: string): unknown } } })
          .rhwpStudio?.automation?.execute('file:new-doc');
      });
      const split = document.createElement('button');
      split.type = 'button';
      split.className = 'dg-doctab-action dg-doctab-split';
      split.innerHTML = ICON_SPLIT;
      split.setAttribute('aria-label', '화면 나누기');
      split.addEventListener('mousedown', (e) => e.preventDefault());
      split.addEventListener('click', () => { if (pane.active) void openTabMenu(pane.active, split); });
      actions.append(add, split);
    }
    actions.querySelector<HTMLElement>('.dg-doctab-split')!.title = panes.length >= 2
      ? '이 문서를 다른 칸으로 옮기기 (Ctrl+\\)' : '화면 나누기 (Ctrl+\\)';
    order.push(actions);
    // 순서가 그대로면 DOM 을 건드리지 않는다 — 누르는 도중에 요소를 뗐다 붙이면 눌림·끌기가 끊긴다
    const now = Array.from(pane.tabsEl.children);
    if (now.length !== order.length || now.some((child, i) => child !== order[i])) pane.tabsEl.replaceChildren(...order);
    pane.tabsEl.querySelector<HTMLElement>('.dg-doctab[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function render(): void {
    // 초점 세션에 맞춰 칸의 활성 탭을 정한다
    const focusedTab = tabOf(hub.focused);
    if (focusedTab) {
      focusedTab.pane.active = focusedTab;
      focusedPane = focusedTab.pane;
    }
    for (const pane of panes) {
      if (!pane.active || !pane.tabs.includes(pane.active)) pane.active = pane.tabs[0] ?? null;
    }
    const any = allTabs().length > 0;
    empty.hidden = any;
    root.dataset.empty = String(!any);
    // id="scroll-container" 는 지금 문서의 스크롤 영역 하나만 갖는다
    const target = hub.focused?.frame.container ?? (any ? null : original);
    for (const el of root.querySelectorAll<HTMLElement>('.dg-doc-view')) {
      if (el === target) el.id = 'scroll-container';
      else el.removeAttribute('id');
    }
    for (const pane of panes) {
      for (const tab of pane.tabs) {
        const shown = pane.active === tab;
        tab.frame.root.dataset.active = String(shown);
        tab.frame.root.setAttribute('aria-hidden', String(!shown));
      }
      renderTabs(pane);
    }
  }

  const ui: WorkspaceUi = {
    addFrame() {
      const pane = ensurePane();
      const frame = createFrame();
      const tab: Tab = { key: nextKey++, frame, session: null, pane };
      const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length;
      pane.tabs.splice(at, 0, tab);
      pane.stackEl.appendChild(frame.root);
      pane.active = tab;
      render();
      return frame;
    },
    attach(frame, session) {
      const tab = allTabs().find((t) => t.frame === frame);
      if (tab) tab.session = session;
      render();
    },
    removeFrame(frame) {
      const tab = allTabs().find((t) => t.frame === frame);
      if (!tab) return;
      const pane = tab.pane;
      const at = pane.tabs.indexOf(tab);
      pane.tabs.splice(at, 1);
      if (pane.active === tab) pane.active = pane.tabs[Math.min(at, pane.tabs.length - 1)] ?? null;
      frame.root.remove();
      if (pane.tabs.length === 0) removePane(pane);
      render();
    },
    refresh: render,
  };
  hub.setUi(ui);

  // ── 단축키 ─────────────────────────────────────────
  function cycle(delta: number): void {
    const pane = focusedPane;
    if (!pane || !pane.active) return;
    const order = pane.tabs.length > 1 ? pane.tabs : allTabs();
    if (order.length < 2) return;
    const at = order.indexOf(pane.active);
    const next = order[(at + delta + order.length) % order.length];
    activateTab(next);
  }

  window.addEventListener('keydown', (e) => {
    // F11(개체 선택): 편집기마다 document 에 건 가로채기가 모두 돌지 않게 초점 문서의 것만 부른다
    if (e.key === 'F11' && hub.sessions.length > 0) {
      e.stopPropagation();
      const handler = (hub.focused?.engine.inputHandler as unknown as { onF11InterceptBound?: (e: KeyboardEvent) => void } | undefined)
        ?.onF11InterceptBound;
      if (handler) handler(e);
      else e.preventDefault();
      return;
    }
    if (hub.sessions.length === 0) return;
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (!ctrl) return;
    let handled = true;
    if (e.key === 'Tab') cycle(e.shiftKey ? -1 : 1);
    else if (e.key === 'PageDown' && !e.shiftKey) cycle(1);
    else if (e.key === 'PageUp' && !e.shiftKey) cycle(-1);
    else if ((e.code === 'KeyW' || e.key === 'F4') && !e.shiftKey) {
      const tab = tabOf(hub.focused);
      if (tab) void closeTab(tab);
    } else if (e.code === 'Backslash' && !e.shiftKey) {
      const tab = tabOf(hub.focused);
      if (tab) splitTab(tab, 'right');
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  render();

  workspace = {
    closeFocused: async () => {
      const tab = tabOf(hub.focused);
      return tab ? closeTab(tab) : false;
    },
    confirmCloseAll: async () => {
      if (!hub.canSwitch()) return false;
      const { confirmLeaveDocument } = await import('../shell/close-guard');
      const before = hub.focused;
      // 지금 문서부터, 손댄 문서만 차례로 묻는다
      const order = [...hub.sessions].sort((a, b) => Number(b === before) - Number(a === before));
      for (const session of order) {
        if (session.disposed) continue;
        if (!session.documentState.isDirty() && hub.pendingOf(session) <= 0) continue;
        if (!hub.focus(session)) return false;
        if (!(await confirmLeaveDocument())) return false;
      }
      return true;
    },
    splitFocused: (side) => {
      const tab = tabOf(hub.focused);
      return tab ? splitTab(tab, side) : false;
    },
    cycle,
    focusPath: (path) => {
      const want = normPath(path);
      const session = hub.sessions.find((s) => s.path && normPath(s.path) === want);
      if (!session) return false;
      const tab = tabOf(session);
      return tab ? activateTab(tab) : false;
    },
  };
  return workspace;
}
