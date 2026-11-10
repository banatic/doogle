/**
 * 자동 업데이트 UX (데스크탑 전용).
 *
 *  - 시작 10초 뒤, 그 뒤 6시간마다 `update_check`(doogle-desk updater.rs)를 부른다.
 *  - 새 버전이 있으면 제목 막대(창 단추 왼쪽)에 "업데이트 v{ver}" 알약을 띄운다.
 *    누르면 팝오버: 릴리스 노트·내려받기 진행·[지금 설치(재시작)] / [나중에].
 *  - 설치 전에 저장 안 한 문서 확인(close-guard)을 거친다. 설치는 `update_install` 이 내려받고
 *    (`doogle://update-progress`) 설치한 뒤 앱을 다시 띄운다.
 *  - 브라우저: 아무것도 하지 않는다.
 */
import { invoke, isDesk, listen } from '../ui/desk-bridge';
import { confirmLeaveDocument } from './close-guard';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const EVENT_PROGRESS = 'doogle://update-progress';

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string | null;
  date?: string | null;
}

type Progress =
  | { phase: 'download'; downloaded: number; total?: number | null }
  | { phase: 'install' };

export type CheckResult =
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'latest' }
  | { kind: 'error'; message: string };

let pill: HTMLButtonElement | null = null;
let popover: HTMLElement | null = null;
let available: UpdateInfo | null = null;
let installing = false;
let checking: Promise<CheckResult> | null = null;
let appVersion: Promise<string> | null = null;

/** 실행 중인 앱 버전(tauri.conf.json `version`). 브라우저에서는 null. */
export function currentVersion(): Promise<string | null> {
  if (!isDesk()) return Promise.resolve(null);
  appVersion ??= invoke<string>('plugin:app|version').catch(() => {
    appVersion = null;
    return '';
  });
  return appVersion.then((v) => v || null);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 업데이트를 확인한다. 동시에 여러 번 불려도 한 번만 묻는다. */
export function checkForUpdates(): Promise<CheckResult> {
  if (!isDesk()) return Promise.resolve({ kind: 'latest' });
  if (installing) return Promise.resolve(available ? { kind: 'available', info: available } : { kind: 'latest' });
  checking ??= invoke<UpdateInfo | null>('update_check')
    .then((info): CheckResult => {
      available = info;
      renderPill();
      return info ? { kind: 'available', info } : { kind: 'latest' };
    })
    .catch((error): CheckResult => ({ kind: 'error', message: errorText(error) }))
    .finally(() => { checking = null; });
  return checking;
}

function renderPill(): void {
  if (!pill) return;
  if (!available) {
    pill.hidden = true;
    closePopover();
    return;
  }
  pill.hidden = false;
  pill.textContent = `업데이트 v${available.version}`;
  pill.title = `두글 v${available.version} 을 설치할 수 있습니다`;
}

function closePopover(): void {
  if (!popover || installing) return;
  popover.remove();
  popover = null;
  pill?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}

function onOutside(e: Event): void {
  const target = e.target as Node | null;
  if (target && (popover?.contains(target) || pill?.contains(target))) return;
  closePopover();
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closePopover();
  pill?.focus();
}

/** 알약 아래에 팝오버를 연다. 업데이트가 없으면 아무것도 하지 않는다. */
export function openUpdatePopover(): void {
  if (!pill || !available || popover) return;
  const info = available;

  const root = document.createElement('div');
  root.className = 'dg-update-pop';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '업데이트');

  const title = document.createElement('div');
  title.className = 'dg-update-title';
  title.textContent = `두글 v${info.version}`;
  const meta = document.createElement('div');
  meta.className = 'dg-update-meta';
  meta.textContent = `지금 v${info.currentVersion}${info.date ? ` · ${info.date.slice(0, 10)}` : ''}`;

  const notes = document.createElement('div');
  notes.className = 'dg-update-notes';
  notes.textContent = info.body?.trim() || '릴리스 노트가 없습니다.';

  const progressWrap = document.createElement('div');
  progressWrap.className = 'dg-update-progress';
  progressWrap.hidden = true;
  const bar = document.createElement('progress');
  bar.max = 1;
  const status = document.createElement('div');
  status.className = 'dg-update-status';
  status.setAttribute('aria-live', 'polite');
  progressWrap.append(bar, status);

  const actions = document.createElement('div');
  actions.className = 'dg-update-actions';
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'dg-update-btn';
  later.textContent = '나중에';
  later.addEventListener('click', () => { closePopover(); pill?.focus(); });
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'dg-update-btn dg-update-btn--primary';
  install.textContent = '지금 설치(재시작)';
  install.addEventListener('click', () => { void runInstall(); });
  actions.append(later, install);

  root.append(title, meta, notes, progressWrap, actions);
  // 제목 막대의 끌기 영역 밖(body)에 띄운다.
  document.body.appendChild(root);
  const r = pill.getBoundingClientRect();
  root.style.top = `${Math.round(r.bottom + 6)}px`;
  root.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  popover = root;
  pill.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  install.focus();

  async function runInstall(): Promise<void> {
    if (installing) return;
    if (!(await confirmLeaveDocument())) return;
    installing = true;
    install.disabled = true;
    later.disabled = true;
    progressWrap.hidden = false;
    bar.removeAttribute('value'); // 크기를 모르는 동안은 진행 중 표시
    status.textContent = '내려받는 중…';
    const unlisten = await listen<Progress>(EVENT_PROGRESS, (p) => {
      if (!p) return;
      if (p.phase === 'install') {
        bar.removeAttribute('value');
        status.textContent = '설치하는 중… 곧 다시 시작합니다.';
        return;
      }
      if (p.total) {
        bar.value = Math.min(1, p.downloaded / p.total);
        status.textContent = `${formatBytes(p.downloaded)} / ${formatBytes(p.total)}`;
      } else {
        status.textContent = `${formatBytes(p.downloaded)} 받음`;
      }
    });
    try {
      // 성공하면 앱이 다시 시작되므로 돌아오지 않는다.
      await invoke<void>('update_install');
    } catch (error) {
      installing = false;
      install.disabled = false;
      later.disabled = false;
      bar.value = 0;
      status.textContent = `설치하지 못했습니다: ${errorText(error)}`;
    } finally {
      unlisten();
    }
  }
}

/** 제목 막대에 알약을 붙이고 주기 확인을 시작한다. 데스크탑이 아니면 아무것도 하지 않는다. */
export function installUpdater(bar: HTMLElement): void {
  if (!isDesk() || pill) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dg-update-pill';
  b.hidden = true;
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-expanded', 'false');
  b.addEventListener('mousedown', (e) => e.preventDefault()); // 문서 캐럿 유지
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  b.addEventListener('click', () => (popover ? closePopover() : openUpdatePopover()));
  const controls = bar.querySelector('.dg-winctl');
  if (controls) bar.insertBefore(b, controls);
  else bar.append(b);
  pill = b;

  const quietCheck = () => {
    void checkForUpdates().then((result) => {
      if (result.kind === 'error') console.info('[doogle] 업데이트 확인 실패', result.message);
    });
  };
  window.setTimeout(quietCheck, FIRST_CHECK_MS);
  window.setInterval(quietCheck, CHECK_EVERY_MS);
}
