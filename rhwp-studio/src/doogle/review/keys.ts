/**
 * 검토 단축키와 파급 문구 — 문서 위 막(overlay)과 사이드바 목록(list)이 같은 표기를 쓴다. 순수 모듈.
 *
 * 업스트림 단축키(command/shortcut-map.ts, engine/input-handler-keyboard.ts)와 겹치지 않게 골랐다:
 *  - Alt+Enter 는 표 줄·칸 추가, Alt+Backspace/Delete 는 단어 지우기라 쓰지 않는다.
 *  - Alt+↑/↓ 는 업스트림에 없다(Windows 에서 막는 것은 Alt+←/→ 뿐, macOS 는 Option+←/→ 만 단어 이동).
 *  - Alt+Shift+Enter / X / G 는 shortcut-map 에 없다 (Alt+G 는 찾아가기, Alt+Shift+G 는 비어 있다).
 * 한글 자판에서도 되도록 물리 키(code)로 맞춘다.
 */
import type { PendingChangeSet } from '../agent/types.ts';
import type { RejectImpact } from './state.ts';

export type ReviewKeyAction = 'next' | 'prev' | 'accept' | 'reject' | 'reveal';

export interface ReviewKeySpec {
  label: string;
  /** aria-keyshortcuts 값 */
  aria: string;
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const ALT = MAC ? '⌥' : 'Alt+';
const SHIFT = MAC ? '⇧' : 'Shift+';

export const REVIEW_KEYS: Record<ReviewKeyAction, ReviewKeySpec> = {
  next: { label: `${ALT}↓`, aria: 'Alt+ArrowDown' },
  prev: { label: `${ALT}↑`, aria: 'Alt+ArrowUp' },
  accept: { label: `${ALT}${SHIFT}↵`, aria: 'Alt+Shift+Enter' },
  reject: { label: `${ALT}${SHIFT}X`, aria: 'Alt+Shift+X' },
  reveal: { label: `${ALT}${SHIFT}G`, aria: 'Alt+Shift+G' },
};

export interface KeyLike {
  key: string;
  code?: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

/** 키 입력 → 검토 동작 (해당 없으면 null) */
export function matchReviewKey(e: KeyLike): ReviewKeyAction | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return null;
  if (!e.shiftKey) {
    if (e.key === 'ArrowDown') return 'next';
    if (e.key === 'ArrowUp') return 'prev';
    return null;
  }
  if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') return 'accept';
  if (e.code === 'KeyX' || e.key === 'x' || e.key === 'X' || e.key === 'ㅌ') return 'reject';
  if (e.code === 'KeyG' || e.key === 'g' || e.key === 'G' || e.key === 'ㅎ') return 'reveal';
  return null;
}

/** 거절 확인 문구 — 무엇이 함께 되돌아가는지 한 문장으로 */
export function impactSentence(impact: RejectImpact, all = false): string {
  const parts: string[] = [];
  if (!all && impact.later > 0) {
    const kept = impact.kept > 0 ? `(적용 표시한 ${impact.kept}건 포함)` : '';
    parts.push(`뒤 변경 ${impact.later}건${kept}`);
  }
  if (impact.userEdits) parts.push('그 사이 직접 고친 내용');
  if (parts.length === 0) return all ? `변경 ${impact.count}건을 모두 되돌립니다.` : '이 변경만 되돌립니다.';
  const lead = all ? `변경 ${impact.count}건과 함께 ` : '이 변경과 함께 ';
  return `${lead}${parts.join('과 ')}도 되돌아갑니다.`;
}

/** 목록 행 아래 파급 배지 문구 (뒤 행이 없으면 빈 문자열) */
export function chainSentence(impact: RejectImpact): string {
  const parts: string[] = [];
  if (impact.later > 0) {
    parts.push(`아래 ${impact.later}건${impact.kept > 0 ? `(적용 표시한 ${impact.kept}건 포함)` : ''}`);
  }
  if (impact.userEdits) parts.push('직접 고친 내용');
  return parts.length > 0 ? `거절하면 ${parts.join('과 ')}도 함께 되돌아갑니다` : '';
}

/**
 * 거터 점의 세로 비율 (0..1) — 쪽 번호와 같은 쪽 안의 순서로 어림한다. 순수 함수 (테스트용 export).
 * 쪽 수를 모르면 기록 순서로 고르게 편다.
 */
export function gutterPositions(rows: PendingChangeSet[], pageCount: number): number[] {
  if (rows.length === 0) return [];
  if (!(pageCount > 0)) return rows.map((_, i) => (i + 0.5) / rows.length);
  const page = (r: PendingChangeSet) => Math.min(pageCount - 1, Math.max(0, r.pages[0] ?? 0));
  const order = (r: PendingChangeSet) => {
    const t = r.targets?.[0];
    return t ? t.sectionIdx * 1e6 + (t.table?.paraIdx ?? t.cell?.paraIdx ?? t.paraIdx) : 0;
  };
  return rows.map((r) => {
    const same = rows.filter((x) => page(x) === page(r)).sort((a, b) => order(a) - order(b));
    const rank = same.indexOf(r);
    return (page(r) + (rank + 1) / (same.length + 1)) / pageCount;
  });
}
