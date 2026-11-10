/**
 * 저장 안 한 문서 확인 — 창 닫기와 업데이트 재시작 앞에서 쓴다(데스크탑 전용).
 *
 *  - doogle-desk 는 `set_close_guard(true)` 를 받은 뒤부터 창 닫기(X·Alt+F4·작업 표시줄)를
 *    막고 `doogle://close-requested` 를 보낸다. 여기서 확인을 마치면 `confirm_close` 로 창을 없앤다.
 *  - 제목 막대의 닫기 단추는 같은 `requestClose()` 를 바로 부른다.
 *  - 브라우저: 아무것도 하지 않는다(upstream 의 beforeunload 가 맡는다).
 */
import { showUnsavedChangesDialog } from '@/ui/unsaved-changes-dialog';
import { invoke, isDesk, listen } from '../ui/desk-bridge';
import { context, run } from './studio';

const EVENT_CLOSE_REQUESTED = 'doogle://close-requested';
/** 저장 명령을 보낸 뒤 문서가 깨끗해지기를 기다리는 최대 시간 */
const SAVE_WAIT_MS = 120_000;

let installed = false;
let pending: Promise<boolean> | null = null;

function isDirty(): boolean {
  const ctx = context();
  return !!ctx && ctx.hasDocument && ctx.isDirty;
}

function fileName(): string {
  const raw = document.title.replace(/ - rhwp-studio$/, '').trim();
  return !raw || raw === 'rhwp-studio' ? '' : raw;
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
 * 문서를 떠나도 되는가. 깨끗하면 바로 true.
 * 저장 안 한 변경이 있으면 upstream 의 확인 대화상자(저장 / 저장 안 함 / 취소)를 띄운다.
 */
export function confirmLeaveDocument(): Promise<boolean> {
  if (pending) return pending;
  pending = (async () => {
    if (!isDirty()) return true;
    const choice = await showUnsavedChangesDialog({ fileName: fileName(), canSave: true });
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    return saveAndWait();
  })().finally(() => { pending = null; });
  return pending;
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
