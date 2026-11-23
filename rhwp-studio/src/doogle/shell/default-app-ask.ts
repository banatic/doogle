/**
 * .hwp/.hwpx 기본 앱 — 처음 한 번 사용자에게 묻는다.
 *
 * 설치 프로그램은 더 이상 기본 앱을 바꾸지 않는다(doogle-desk/installer-hooks.nsh). 대신 데스크탑에서
 * 처음 실행할 때, 두글이 아직 기본 앱이 아니면 화면 아래에 작게 묻는다:
 *   「두글로 열기」 → 두글을 등록하고 Windows 기본 앱 설정 화면을 연다(실제 선택은 사용자가 그 화면에서).
 *   「괜찮아요」 / 닫기 → 다시 묻지 않는다. 나중에는 백스테이지의 "HWP·HWPX 기본 앱으로 설정"에서 바꾼다.
 * 답을 하지 않고 앱을 닫으면 다음 실행 때 다시 묻는다.
 */
import { defaultAppStatus, isDesk, setDefaultApp } from '../ui/desk-bridge';

const ANSWERED_KEY = 'doogle.defaultAppAsked';

function answered(): boolean {
  try { return localStorage.getItem(ANSWERED_KEY) !== null; } catch { return true; }
}

function remember(answer: 'yes' | 'no'): void {
  try { localStorage.setItem(ANSWERED_KEY, answer); } catch { /* 저장할 수 없으면 다음에 다시 묻는다 */ }
}

function button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'dg-update-btn dg-update-btn--primary' : 'dg-update-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** 앱이 뜬 뒤 한 번 부른다. 묻지 않아도 되면 아무것도 하지 않는다. */
export async function askDefaultAppOnce(): Promise<void> {
  if (!isDesk() || answered()) return;
  let status;
  try {
    status = await defaultAppStatus();
  } catch {
    return; // 이 명령이 없는 예전 데스크탑 셸
  }
  if (!status.supported || status.exts.every((e) => e.isDefault)) return;

  const current = [...new Set(status.exts.filter((e) => !e.isDefault && e.current).map((e) => e.current!))];
  const box = document.createElement('div');
  box.className = 'dg-toast dg-assoc-ask';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'HWP·HWPX 기본 앱');

  const text = document.createElement('div');
  text.className = 'dg-assoc-ask-text';
  text.textContent = current.length
    ? `.hwp·.hwpx 파일을 두글로 열까요? 지금은 ${current.join(', ')}(으)로 엽니다.`
    : '.hwp·.hwpx 파일을 두글로 열까요?';
  const actions = document.createElement('div');
  actions.className = 'dg-assoc-ask-actions';

  const close = () => box.remove();
  const no = button('괜찮아요', false, () => { remember('no'); close(); });
  const yes = button('두글로 열기', true, async () => {
    remember('yes');
    yes.disabled = true;
    no.disabled = true;
    try {
      await setDefaultApp();
      text.textContent = 'Windows 설정을 열었습니다. .hwp와 .hwpx를 두글로 고르세요.';
      actions.replaceChildren();
      window.setTimeout(close, 6000);
    } catch (error) {
      text.textContent = error instanceof Error ? error.message : String(error);
      actions.replaceChildren(button('닫기', false, close));
    }
  });
  actions.append(no, yes);
  box.append(text, actions);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { remember('no'); close(); }
  });
  document.body.append(box);
}
