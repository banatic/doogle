/**
 * 저장 안 한 문서 확인 — 창 닫기와 업데이트 재시작 앞에서 쓴다(데스크탑 전용).
 *
 *  - doogle-desk 는 `set_close_guard(true)` 를 받은 뒤부터 창 닫기(X·Alt+F4·작업 표시줄)를
 *    막고 `doogle://close-requested` 를 보낸다. 여기서 확인을 마치면 `confirm_close` 로 창을 없앤다.
 *  - 제목 막대의 닫기 단추는 같은 `requestClose()` 를 바로 부른다.
 *  - 검토 대기 중인 에이전트 변경이 있으면 upstream 대화상자 대신 두글 대화상자를 띄운다
 *    ([변경 적용하고 저장] [변경 거절하고 저장] [저장 안 함] [취소]) — UI_AUDIT 3.11.
 *  - 저장(Ctrl+S·빠른 실행·백스테이지)도 검토 대기 변경이 있으면 한 번 묻는다(`guardedSave`).
 *  - 브라우저: 창 닫기는 upstream 의 beforeunload 가 맡는다. 저장 확인은 두 환경 모두 동작한다.
 */
import { showUnsavedChangesDialog } from '@/ui/unsaved-changes-dialog';
import { invoke, isDesk, listen } from '../ui/desk-bridge';
import { getDocState } from './doc-state';
import { getPendingCount } from './status';
import { context, run } from './studio';
import { showReviewSaveDialog } from './unsaved-review-dialog';

const EVENT_CLOSE_REQUESTED = 'doogle://close-requested';
/** 저장 명령을 보낸 뒤 문서가 깨끗해지기를 기다리는 최대 시간 */
const SAVE_WAIT_MS = 120_000;
const SKIP_SAVE_ASK_KEY = 'doogle.save.skipReviewAsk';

let installed = false;
let saveKeysInstalled = false;
let pending: Promise<boolean> | null = null;

export function isDirty(): boolean {
  const ctx = context();
  return !!ctx && ctx.hasDocument && ctx.isDirty;
}

function fileName(): string {
  return getDocState().name;
}

function hasOpenModal(): boolean {
  return !!document.querySelector('.modal-overlay, dialog[open]');
}

/**
 * `file:save` 를 실행하고 문서가 깨끗해질 때까지 기다린다.
 * 저장 커맨드는 결과를 돌려주지 않으므로 dirty 상태를 본다. 사용자가 저장을 그만두고(대화상자 없이)
 * 문서를 다시 만지거나 시간이 다 되면 실패로 본다 — 나중에 저장했다고 창이 저절로 닫히지 않게.
 */
function saveAndWait(): Promise<boolean> {
  if (!run('file:save')) return Promise.resolve(false);
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      document.removeEventListener('pointerdown', onUserInput, true);
      document.removeEventListener('keydown', onUserInput, true);
      resolve(ok);
    };
    const onUserInput = () => {
      // 저장 대화상자(비밀번호·이름 묻기) 안의 입력은 저장 과정의 일부다.
      if (!hasOpenModal() && isDirty()) finish(false);
    };
    const timer = window.setInterval(() => {
      if (!isDirty()) finish(true);
      else if (Date.now() - started > SAVE_WAIT_MS) finish(false);
    }, 200);
    // 커맨드가 막 시작한 입력 이벤트에 걸리지 않게 한 박자 뒤에 붙인다.
    window.setTimeout(() => {
      if (done) return;
      document.addEventListener('pointerdown', onUserInput, true);
      document.addEventListener('keydown', onUserInput, true);
    }, 300);
  });
}

/**
 * 검토 대기 변경을 모두 적용/거절한다(review/state.ts 의 reviewStore — 사이드바·문서 위 막과 같은 길).
 * 결정하지 못하면(에이전트가 작업 중 등) false.
 */
async function decideAll(kind: 'accept' | 'reject'): Promise<boolean> {
  try {
    const { reviewStore } = await import('../review/state.ts');
    if (reviewStore.busy) {
      notify('에이전트가 작업하는 중이라 지금은 변경을 결정할 수 없습니다. 작업이 끝난 뒤 다시 저장해 주세요.');
      return false;
    }
    reviewStore.decide(kind);
    return true;
  } catch (error) {
    console.warn('[doogle] 검토 결정 실패', error);
    notify('검토 대기 중인 변경을 처리하지 못했습니다. 사이드바에서 직접 적용하거나 거절해 주세요.');
    return false;
  }
}

/** 거절 시 사용자 편집이 함께 되돌아가는가(review/state.ts reviewStore.hasUserEdits). */
async function hasUserEdits(): Promise<boolean> {
  try {
    const { reviewStore } = await import('../review/state.ts');
    return typeof reviewStore.hasUserEdits === 'function' ? reviewStore.hasUserEdits() : false;
  } catch {
    return false;
  }
}

function notify(text: string): void {
  const el = document.createElement('div');
  el.className = 'dg-toast';
  el.setAttribute('role', 'alert');
  el.textContent = text;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 7000);
}

/**
 * 문서를 떠나도 되는가. 깨끗하면 바로 true.
 * 저장 안 한 변경이 있으면 확인 대화상자를 띄운다 — 검토 대기 변경이 있으면 두글 대화상자,
 * 없으면 upstream 의 것(저장 / 저장 안 함 / 취소).
 */
export function confirmLeaveDocument(): Promise<boolean> {
  if (pending) return pending;
  pending = (async () => {
    const count = getPendingCount();
    if (!isDirty() && count <= 0) return true;
    if (count > 0) {
      const { choice } = await showReviewSaveDialog({ fileName: fileName(), pendingCount: count, purpose: 'leave', userEdits: await hasUserEdits() });
      if (choice === 'cancel') return false;
      if (choice === 'discard') return true;
      if (choice === 'apply' || choice === 'reject') {
        if (!(await decideAll(choice === 'apply' ? 'accept' : 'reject'))) return false;
      }
      return isDirty() ? saveAndWait() : true;
    }
    const choice = await showUnsavedChangesDialog({ fileName: fileName(), canSave: true });
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    return saveAndWait();
  })().finally(() => { pending = null; });
  return pending;
}

/**
 * 지금 문서를 다른 문서로 바꾼다(열기·서식·탐색기에서 열기). 저장 안 한 변경이나 검토 대기 변경이 있으면
 * 먼저 묻고(취소하면 바꾸지 않는다), 실패는 조용히 넘기지 않는다. 바꿨으면 true.
 * load 가 던진 오류 가운데 `shown` 표시가 있는 것은 이미 화면에 알린 것이다(파싱 실패 — host.loadDocument).
 */
export async function replaceDocument(load: () => Promise<void>, failed = '문서를 열지 못했습니다'): Promise<boolean> {
  if (!(await confirmLeaveDocument())) return false;
  try {
    await load();
    return true;
  } catch (error) {
    console.error(`[doogle] ${failed}`, error);
    if (!(error as { doogleShown?: boolean } | null)?.doogleShown) {
      notify(`${failed}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

function skipSaveAsk(): boolean {
  try { return localStorage.getItem(SKIP_SAVE_ASK_KEY) === '1'; } catch { return false; }
}

/**
 * 저장 — 검토 대기 변경이 있으면 먼저 묻는다(다시 묻지 않음 선택 가능). 셸의 저장 단추·Ctrl+S 가 쓴다.
 * true 면 저장 커맨드를 보냈다.
 */
export async function guardedSave(anchorEl?: HTMLElement): Promise<boolean> {
  const count = getPendingCount();
  if (count > 0 && !skipSaveAsk()) {
    const { choice, dontAskAgain } = await showReviewSaveDialog({ fileName: fileName(), pendingCount: count, purpose: 'save', userEdits: await hasUserEdits() });
    if (choice === 'cancel' || choice === 'discard') return false;
    if (choice === 'keep' && dontAskAgain) {
      try { localStorage.setItem(SKIP_SAVE_ASK_KEY, '1'); } catch { /* 다음에도 묻는다 */ }
    }
    if (choice === 'apply' || choice === 'reject') {
      if (!(await decideAll(choice === 'apply' ? 'accept' : 'reject'))) return false;
    }
  }
  return run('file:save', anchorEl ? { anchorEl } : undefined);
}

/** Ctrl+S 를 upstream 단축키보다 먼저 받아, 검토 대기 변경이 있을 때만 확인을 끼운다. */
function installSaveShortcutGuard(): void {
  if (saveKeysInstalled) return;
  saveKeysInstalled = true;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyS' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (getPendingCount() <= 0 || skipSaveAsk() || hasOpenModal()) return;
    e.preventDefault();
    e.stopPropagation();
    void guardedSave();
  }, true);
}

/** 창 닫기 — 확인 뒤 `confirm_close`. 확인 중 다시 불리면 같은 확인을 기다린다. */
export async function requestClose(): Promise<void> {
  if (!isDesk()) return;
  if (!(await confirmLeaveDocument())) return;
  try {
    await invoke<void>('confirm_close');
  } catch (error) {
    console.warn('[doogle] 창 닫기 실패', error);
  }
}

/** 네이티브 닫기 요청을 받아 확인 경로로 돌린다. 한 번만 설치한다. */
export function installCloseGuard(): void {
  installSaveShortcutGuard();
  if (installed || !isDesk()) return;
  installed = true;
  void (async () => {
    try {
      await listen<unknown>(EVENT_CLOSE_REQUESTED, () => { void requestClose(); });
      await invoke<void>('set_close_guard', { enabled: true });
    } catch (error) {
      // 셸이 이 명령을 모르면(구버전) 닫기를 막지 않는 기존 동작으로 남는다.
      console.warn('[doogle] 닫기 확인을 설치하지 못했습니다', error);
    }
  })();
}
