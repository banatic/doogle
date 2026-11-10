/**
 * 문서 상태 저장소 — dirty·저장 시각·형식·경로를 한 곳에서 들고 여러 표면(제목 막대·상태 표시줄·
 * 사이드바)이 함께 본다(UI_AUDIT §2 "상태는 한 곳에서 여러 표면으로").
 *
 *  - 값이 바뀔 때마다 window 이벤트 `doogle:doc-state {detail: DocState}` 를 쏜다.
 *  - 원천은 upstream `automation.getContext()`(isDirty·sourceFormat)와 `document.title`(파일명)이다.
 *    셸은 상태를 읽기만 하고 고치지 않는다.
 *  - 데스크탑에서 연 파일의 전체 경로는 webview 가 모르므로 연 쪽이 알려 준다:
 *    `noteDocumentPath(path)` 또는 window 이벤트 `doogle:doc-path {detail:{path}}`.
 */
import { context } from './studio';

export const DOC_STATE_EVENT = 'doogle:doc-state';
export const DOC_PATH_EVENT = 'doogle:doc-path';

export type DocFormat = 'hwp' | 'hwpx' | 'hml' | 'pdf';

export interface DocState {
  /** 문서가 열려 있는가 */
  hasDocument: boolean;
  /** 저장 안 한 변경이 있는가 */
  dirty: boolean;
  /** 원본 형식(저장 시 유지되는 형식) */
  format: DocFormat | null;
  /** 전체 경로 — 데스크탑에서 경로를 아는 경우만 */
  path: string | null;
  /** 파일 이름(확장자 포함). 문서가 없으면 '' */
  name: string;
  /** 이 세션에서 마지막으로 저장을 마친 시각(epoch ms) */
  savedAt: number | null;
}

const PATHS_KEY = 'doogle.recent.paths';
const MAX_REMEMBERED = 40;

let state: DocState = { hasDocument: false, dirty: false, format: null, path: null, name: '', savedAt: null };
const listeners = new Set<(s: DocState) => void>();
let swapped = false;
/** 이름이 맞기를 기다리는 경로(제목보다 먼저 알려 온 경우) */
let pending: string | null = null;

function titleName(): string {
  const raw = document.title.replace(/ - rhwp-studio$/, '').trim();
  return !raw || raw === 'rhwp-studio' ? '' : raw;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function formatOf(name: string, fallback?: string): DocFormat | null {
  const f = (fallback ?? '').toLowerCase();
  if (f === 'hwp' || f === 'hwpx' || f === 'hml' || f === 'pdf') return f;
  const m = /\.(hwpx|hwp|hml|pdf)$/i.exec(name);
  return m ? (m[1].toLowerCase() as DocFormat) : null;
}

function readPaths(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PATHS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function rememberPath(path: string): void {
  try {
    const map = readPaths();
    const name = baseName(path);
    delete map[name];
    const entries = [[name, path], ...Object.entries(map)].slice(0, MAX_REMEMBERED);
    localStorage.setItem(PATHS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* 저장소를 못 쓰면 기억만 못 한다 */ }
}

/** 최근 문서 카드용 — 파일 이름으로 마지막에 알던 전체 경로(데스크탑에서 연 적이 있을 때). */
export function rememberedPath(fileName: string): string | null {
  return readPaths()[fileName] ?? null;
}

export function getDocState(): DocState {
  return state;
}

export function onDocState(cb: (s: DocState) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function publish(next: DocState): void {
  const prev = state;
  if (prev.hasDocument === next.hasDocument && prev.dirty === next.dirty && prev.format === next.format
    && prev.path === next.path && prev.name === next.name && prev.savedAt === next.savedAt) return;
  state = next;
  for (const fn of listeners) {
    try { fn(next); } catch (error) { console.error('[doogle] doc-state listener', error); }
  }
  window.dispatchEvent(new CustomEvent(DOC_STATE_EVENT, { detail: { ...next } }));
}

/** 컨텍스트·제목을 다시 읽는다. 셸이 편집 이벤트마다 부른다(가볍다). */
export function refreshDocState(): void {
  const ctx = context();
  const name = titleName();
  const hasDocument = !!ctx?.hasDocument && !!name;
  const dirty = hasDocument && !!ctx?.isDirty;
  let { savedAt, path } = state;
  // dirty → clean 이 문서 교체 없이 일어났으면 저장을 마친 것이다.
  if (state.dirty && !dirty && hasDocument && !swapped) savedAt = Date.now();
  if (state.name !== name) {
    if (swapped || !hasDocument) savedAt = null;
    // 다른 이름이 되면(다른 이름으로 저장·다른 문서) 알던 경로는 더 이상 맞지 않는다.
    if (path && baseName(path) !== name) path = null;
  }
  if (!path && name) {
    const known = pending && baseName(pending) === name ? pending : null;
    if (known) { path = known; pending = null; }
  }
  swapped = false;
  publish({ hasDocument, dirty, format: hasDocument ? formatOf(name, ctx?.sourceFormat) : null, path, name, savedAt });
}

/** 문서 교체(새 문서·열기) — 이어지는 clean 전환을 저장으로 오인하지 않게 한다. */
export function noteDocumentSwap(): void {
  swapped = true;
}

/**
 * 지금(또는 곧) 열린 문서의 전체 경로를 알린다. 데스크탑 열기 경로(index.ts openPath)가 부른다.
 * 제목이 아직 바뀌기 전이면 이름이 맞을 때 붙인다.
 */
export function noteDocumentPath(path: string | null): void {
  if (!path) return;
  rememberPath(path);
  if (state.name && baseName(path) === state.name) {
    publish({ ...state, path });
  } else {
    pending = path;
  }
}

window.addEventListener(DOC_PATH_EVENT, (e) => {
  const path = (e as CustomEvent<{ path?: unknown }>).detail?.path;
  if (typeof path === 'string') noteDocumentPath(path);
});
