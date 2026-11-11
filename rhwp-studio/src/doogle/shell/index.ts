/**
 * 두글 셸 — 시안 F 의 제목 막대 + 리본 + 상태 표시줄 보강.
 *
 * upstream 화면(#menu-bar·#icon-toolbar·#style-bar)은 doogle.html 에서는 숨긴 묶음에 두고, index.html?doogle=1 에서는 CSS 로 숨긴다(`:root[data-doogle]`).
 * 컨트롤러(MenuBar·Toolbar·단축키)는 그대로 살아 있고, 셸은 그 위에 다른 겉모습을 얹는다.
 *
 *  - `mountShell()`      : 두글 모드 판정 직후(모듈 로드 시) 한 번. DOM 을 짓고 data-doogle 을 찍는다.
 *  - `attachShellHost()` : 플러그인 활성화 때. 캐럿·이벤트·사이드바 상태처럼 host 가 필요한 것을 잇는다.
 *
 * 다른 모듈이 쓸 수 있는 상태(window 이벤트로도 나간다):
 *  - `doogle:doc-state`   {dirty, format, path, name, savedAt, hasDocument} — doc-state.ts
 *  - `doogle:agent-state` 를 받아 상태 표시줄 점을 칠한다 — status.ts
 *  - `doogle:doc-path`    {path} 를 받아 제목 막대 경로·폴더에서 보기를 켠다 — doc-state.ts
 */
import '../theme/tokens.css';
import '../theme/overlays.css';
import '../theme/scrollbar.css';
import './shell.css';

import type { PluginHost } from '@/plugin/types';
import { Backstage, setBackstageLoader } from './backstage';
import { iconSvg } from './icons';
import { Ribbon } from './ribbon';
import { StatusAddons } from './status';
import { installWindowControls, markDragRegion } from './window-controls';
import { guardedSave, installCloseGuard } from './close-guard';
import { installNativeSavePicker } from './native-file.ts';
import { installUpdater } from './updater';
import { getDocState, noteDocumentSwap, onDocState, refreshDocState, type DocState } from './doc-state';
import { openPopupMenu, type PopupEntry } from './popup-menu';
import { mountFontNotice } from './font-notice';
import { installNarrowFit } from './narrow-fit';
import { installEquationFallbackFont } from './eq-font';
import { invoke, isDesk } from '../ui/desk-bridge';
import { commandShortcut, context, isEnabled, openCommandPalette, run, toggleAgentPanel } from './studio';

export { getPendingCount, setPendingCount, setAgentState, getAgentState, announceStatus, PENDING_COUNT_EVENT, AGENT_STATE_EVENT } from './status';
export type { AgentConnState } from './status';
export { getDocState, onDocState, noteDocumentPath, DOC_STATE_EVENT, DOC_PATH_EVENT } from './doc-state';
export type { DocState } from './doc-state';
export { confirmLeaveDocument, guardedSave, replaceDocument } from './close-guard';
export { deskFileHandle, installNativeSavePicker } from './native-file.ts';
export { setBackstagePathOpener } from './backstage';

const AGENT_PANEL_ID = 'agent';
/** "저장됨 ✓" 표시 시간 */
const SAVED_FLASH_MS = 1500;

interface ShellState {
  ribbon: Ribbon;
  status: StatusAddons | null;
  backstage: Backstage;
  quick: HTMLButtonElement[];
  host: PluginHost | null;
}

let state: ShellState | null = null;

function quickButton(id: string, label: string, icon: string, act?: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dg-qa';
  b.dataset.cmd = id;
  b.setAttribute('aria-label', label);
  const sc = commandShortcut(id);
  b.title = sc ? `${label} (${sc})` : label;
  b.innerHTML = iconSvg(icon, 15, 2);
  const fire = () => { if (act) act(b); else run(id, { anchorEl: b }); };
  b.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); if (b.getAttribute('aria-disabled') !== 'true') fire(); } });
  b.addEventListener('click', (e) => { if (e.detail === 0 && b.getAttribute('aria-disabled') !== 'true') fire(); });
  return b;
}

/** 제목: [● 이름 HWPX] 단추 + "저장됨 ✓". 누르면 이름 바꾸기·폴더에서 보기·경로 복사 팝업. */
function buildDocTitle(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'dg-doctitle';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dg-doctitle-btn';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  const dot = document.createElement('span');
  dot.className = 'dg-dirty-dot';
  dot.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'dg-doctitle-name';
  const badge = document.createElement('span');
  badge.className = 'dg-format-badge';
  const app = document.createElement('span');
  app.className = 'dg-doctitle-app';
  app.textContent = ' — 두글';
  btn.append(dot, name, badge, app);

  const saved = document.createElement('span');
  saved.className = 'dg-saved';
  saved.setAttribute('aria-hidden', 'true');
  saved.innerHTML = `저장됨 ${iconSvg('check', 12, 2.4)}`;

  wrap.append(btn, saved);

  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('dblclick', (e) => e.stopPropagation());
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-expanded') === 'true') return;
    const s = getDocState();
    if (!s.hasDocument) return;
    const entries: PopupEntry[] = [
      { label: '이름 바꾸기(다른 이름으로 저장)…', shortcut: commandShortcut('file:save-as'), disabled: !isEnabled('file:save-as'),
        onPick: (a) => run('file:save-as', { anchorEl: a }) },
    ];
    if (isDesk()) {
      entries.push({ label: '폴더에서 보기', disabled: !s.path, onPick: () => {
        if (s.path) void invoke<void>('reveal_in_folder', { path: s.path }).catch((error) => console.warn('[doogle] 폴더 열기 실패', error));
      } });
    }
    entries.push({ label: '경로 복사', disabled: !s.path, onPick: () => {
      if (s.path) void navigator.clipboard?.writeText(s.path).catch(() => {});
    } });
    if (!s.path) entries.push({ label: '', separator: true }, { label: '이 문서의 폴더 위치를 알 수 없습니다', heading: true });
    openPopupMenu(btn, entries, '문서', false);
  });

  let flashTimer: number | undefined;
  let lastSavedAt: number | null = null;
  const render = (s: DocState) => {
    const display = s.hasDocument ? s.name.replace(/\.(hwpx|hwp|hml|pdf)$/i, '') : '새 문서';
    name.textContent = display;
    dot.hidden = !s.dirty;
    badge.hidden = !s.format;
    badge.textContent = s.format ? s.format.toUpperCase() : '';
    btn.classList.toggle('dg-doctitle-btn--static', !s.hasDocument);
    const status = s.dirty ? '저장 안 한 변경 있음' : '저장됨';
    btn.title = s.hasDocument ? `${s.path ?? s.name}\n${status}` : '';
    btn.setAttribute('aria-label', s.hasDocument ? `${display}${s.format ? ` ${s.format.toUpperCase()}` : ''}, ${status}. 문서 메뉴` : '새 문서');
    if (s.savedAt && s.savedAt !== lastSavedAt) {
      lastSavedAt = s.savedAt;
      saved.classList.add('dg-saved--on');
      window.clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => saved.classList.remove('dg-saved--on'), SAVED_FLASH_MS);
    }
  };
  render(getDocState());
  onDocState(render);
  const titleEl = document.querySelector('head > title');
  if (titleEl) new MutationObserver(() => refreshDocState()).observe(titleEl, { childList: true, characterData: true, subtree: true });
  return wrap;
}

function buildTitleBar(): { bar: HTMLElement; quick: HTMLButtonElement[] } {
  const bar = document.createElement('div');
  bar.className = 'dg-titlebar';

  const app = document.createElement('span');
  app.className = 'dg-appname';
  app.textContent = '두글';
  const sep = document.createElement('span');
  sep.className = 'dg-title-sep';
  sep.setAttribute('aria-hidden', 'true');

  const quickWrap = document.createElement('div');
  quickWrap.className = 'dg-quick';
  quickWrap.setAttribute('role', 'toolbar');
  quickWrap.setAttribute('aria-label', '빠른 실행');
  const quick = [
    quickButton('file:save', '저장', 'save', (b) => { void guardedSave(b); }),
    quickButton('edit:undo', '실행 취소', 'undo'),
    quickButton('edit:redo', '다시 실행', 'redo'),
    quickButton('file:print', '인쇄', 'print'),
  ];
  quickWrap.append(...quick);

  const title = buildDocTitle();

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'dg-command-chip';
  chip.innerHTML = `${iconSvg('find', 13, 2)}<span>찾기 · 명령 입력</span><kbd>Ctrl+/</kbd>`;
  chip.setAttribute('aria-label', '찾기 · 명령 입력 (Ctrl+/)');
  chip.addEventListener('mousedown', (e) => e.preventDefault());
  chip.addEventListener('click', () => {
    if (!openCommandPalette()) run('edit:find');
  });

  bar.append(app, sep, quickWrap, title, chip);
  // 테두리 없는 창의 끌기 영역(단추·입력에는 달지 않는다). 브라우저에서는 무해하다.
  markDragRegion(bar, app, sep, quickWrap, title);
  installWindowControls(bar);
  // 업데이트 아이콘은 창 단추 왼쪽에 들어간다(데스크탑 전용).
  installUpdater(bar);
  return { bar, quick };
}

function isAgentOpen(): boolean {
  const host = state?.host;
  if (host) {
    try { return host.ui.isSidePanelOpen(AGENT_PANEL_ID); } catch { /* fallthrough */ }
  }
  const panel = document.getElementById('side-panel-host');
  return !!panel && !panel.hidden;
}

function refreshAll(): void {
  if (!state) return;
  const ctx = context();
  for (const b of state.quick) {
    const id = b.dataset.cmd!;
    b.setAttribute('aria-disabled', String(!ctx || !isEnabled(id)));
  }
  refreshDocState();
  state.ribbon.queueRefresh();
}

let refreshQueued = false;
function queueRefreshAll(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; refreshAll(); });
}

/** 두글 모드 겉모습을 짓는다. 여러 번 불러도 한 번만 짓는다. */
export function mountShell(): void {
  if (state) return;
  document.documentElement.setAttribute('data-doogle', '');
  const header = document.getElementById('studio-header');
  if (!header) return;

  const backstage = new Backstage();
  const ribbon = new Ribbon({
    onFileTab: (btn) => (backstage.isOpen ? backstage.close() : backstage.open(btn)),
    isAgentOpen,
  });
  const { bar, quick } = buildTitleBar();

  const shell = document.createElement('div');
  shell.className = 'dg-shell';
  shell.append(bar, ribbon.tablist, ribbon.host);
  header.prepend(shell);

  const statusBar = document.getElementById('status-bar');
  const status = statusBar ? new StatusAddons(statusBar, () => { if (!isAgentOpen()) toggleAgentPanel(); }) : null;

  // 한컴 수식 글꼴이 없는 컴퓨터에서 수식 글자가 깨지지 않게 대체 글꼴을 건다.
  installEquationFallbackFont();
  // 글꼴 알림 띠 — 문서 영역 바로 위. main.ts 가 문서를 열 때 `doogle:fonts-missing` 으로 알린다.
  const editorArea = document.getElementById('editor-area');
  if (editorArea) mountFontNotice(editorArea);

  state = { ribbon, status, backstage, quick, host: null };
  // 창 닫기 → 저장 안 한 문서 확인(데스크탑 전용) + 저장 앞 검토 확인
  installCloseGuard();
  // 「다른 이름으로 저장」의 대화상자를 OS 것으로 — 고른 경로에 직접 쓴다(데스크탑 전용)
  installNativeSavePicker();

  // host 가 붙기 전에도 사용자의 조작 뒤에는 단추 상태를 다시 본다.
  document.addEventListener('pointerup', queueRefreshAll, true);
  document.addEventListener('keyup', queueRefreshAll, true);
  // 사이드바 열림·닫힘 → AI 단추 눌림 상태
  const sidePanel = document.getElementById('side-panel-host');
  if (sidePanel) new MutationObserver(queueRefreshAll).observe(sidePanel, { attributes: true, attributeFilter: ['hidden'] });
  queueRefreshAll();
}

/** 플러그인 host 를 잇는다(index.ts initDoogle). */
export function attachShellHost(host: PluginHost): void {
  if (!state) mountShell();
  if (!state) return;
  state.host = host;
  for (const name of ['command-state-changed', 'cursor-format-changed', 'cursor-para-changed', 'document-changed',
    'cell-selection-phase-changed', 'table-object-selection-changed', 'picture-object-selection-changed',
    'edit-mode-changed', 'side-panel-changed']) {
    host.events.on(name, queueRefreshAll);
  }
  host.onDocumentSwap(() => { noteDocumentSwap(); queueRefreshAll(); });
  // 서식으로 새 문서 열기도 지금 문서를 바꾼다 — 열기와 같은 확인을 거친다
  setBackstageLoader((bytes, fileName) => host.loadDocument(bytes, fileName).catch((error: unknown) => {
    // 파싱 실패는 host.loadDocument 가 이미 화면에 알렸다
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { doogleShown: true });
  }));
  state.status?.attach(host);
  installNarrowFit(host, { context, run });
  queueRefreshAll();
}
