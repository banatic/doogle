/**
 * 두글 셸 — 시안 F 의 제목 막대 + 리본 + 상태 표시줄 보강.
 *
 * upstream 화면(#menu-bar·#icon-toolbar·#style-bar)은 지우지 않고 CSS 로 숨긴다(`:root[data-doogle]`).
 * 컨트롤러(MenuBar·Toolbar·단축키)는 그대로 살아 있고, 셸은 그 위에 다른 겉모습을 얹는다.
 *
 *  - `mountShell()`      : 두글 모드 판정 직후(모듈 로드 시) 한 번. DOM 을 짓고 data-doogle 을 찍는다.
 *  - `attachShellHost()` : 플러그인 활성화 때. 캐럿·이벤트·사이드바 상태처럼 host 가 필요한 것을 잇는다.
 */
import '../theme/tokens.css';
import '../theme/overlays.css';
import './shell.css';

import type { PluginHost } from '@/plugin/types';
import { Backstage } from './backstage';
import { iconSvg } from './icons';
import { Ribbon } from './ribbon';
import { StatusAddons } from './status';
import { commandShortcut, context, isEnabled, openCommandPalette, run, toggleAgentPanel } from './studio';

export { getPendingCount, setPendingCount, PENDING_COUNT_EVENT } from './status';

const AGENT_PANEL_ID = 'agent';

interface ShellState {
  ribbon: Ribbon;
  status: StatusAddons | null;
  backstage: Backstage;
  quick: HTMLButtonElement[];
  host: PluginHost | null;
}

let state: ShellState | null = null;

function docName(): string {
  const raw = document.title.replace(/ - rhwp-studio$/, '').trim();
  return !raw || raw === 'rhwp-studio' ? '새 문서' : raw;
}

function quickButton(id: string, label: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dg-qa';
  b.dataset.cmd = id;
  b.setAttribute('aria-label', label);
  const sc = commandShortcut(id);
  b.title = sc ? `${label} (${sc})` : label;
  b.innerHTML = iconSvg(icon, 15, 2);
  b.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); if (b.getAttribute('aria-disabled') !== 'true') run(id, { anchorEl: b }); } });
  b.addEventListener('click', (e) => { if (e.detail === 0 && b.getAttribute('aria-disabled') !== 'true') run(id, { anchorEl: b }); });
  return b;
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
    quickButton('file:save', '저장', 'save'),
    quickButton('edit:undo', '실행 취소', 'undo'),
    quickButton('edit:redo', '다시 실행', 'redo'),
    quickButton('file:print', '인쇄', 'print'),
  ];
  quickWrap.append(...quick);

  const title = document.createElement('div');
  title.className = 'dg-doctitle';
  title.setAttribute('aria-live', 'polite');
  const renderTitle = () => { title.textContent = `${docName()} — 두글`; };
  renderTitle();
  const titleEl = document.querySelector('head > title');
  if (titleEl) new MutationObserver(renderTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });

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

  state = { ribbon, status, backstage, quick, host: null };

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
  host.onDocumentSwap(queueRefreshAll);
  state.status?.attach(host);
  queueRefreshAll();
}
