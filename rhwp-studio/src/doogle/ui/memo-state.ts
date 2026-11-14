/**
 * 메모 말풍선 보기 상태. 리본(shell)과 말풍선 레이어(ui)가 같이 읽는다 —
 * 레이어 본체를 셸 묶음에 끌어들이지 않도록 상태만 따로 둔다.
 */
export const MEMO_TOGGLE_COMMAND = 'ext:doogle.toggle-memos';

/** 보기 상태가 바뀌면 window 에 난다 — 리본 단추의 눌림 표시가 따라온다 */
export const MEMO_STATE_EVENT = 'doogle:memo-balloons';

const STORE_KEY = 'doogle:memo-balloons';

function load(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) !== '0';
  } catch {
    return true;
  }
}

let on = load();

/** 메모 말풍선을 보이는가. 한글처럼 처음에는 보인다. */
export function memoBalloonsOn(): boolean {
  return on;
}

export function setMemoBalloonsOn(next: boolean): void {
  on = next;
  window.dispatchEvent(new CustomEvent(MEMO_STATE_EVENT));
  try {
    localStorage.setItem(STORE_KEY, next ? '1' : '0');
  } catch {
    // 저장소를 못 쓰면 이번 실행 동안만 유지한다
  }
}
