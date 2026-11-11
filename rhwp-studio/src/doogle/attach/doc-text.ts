/**
 * 참고 파일로 붙인 한글 문서·PDF 를 문서 엔진으로 읽어 글로 바꾼다 (본문 문단과 표).
 *
 * get_structure 의 글과 일부러 다르게 쓴다 — 저쪽은 열린 문서를 고치기 위한 주소(s0 p12 …)가 붙지만,
 * 참고 파일은 읽기만 하는 자료라 주소가 있으면 에이전트가 열린 문서의 주소와 헷갈린다.
 * 문단은 한 줄, 표는 행마다 `| 칸 | 칸 |`, 쪽이 여럿이면 쪽이 바뀌는 자리에 `[N쪽]`.
 * 머리말·꼬리말·각주·글상자 속 글은 싣지 않는다.
 */
import type { Engine } from '../agent/engine-adapter.ts';
import { collectPageStarts } from '../agent/structure.ts';
import type { CellAddr, CellPathEntry } from '../agent/types.ts';
import { rowLine } from './attach-core.ts';

/** 표 하나에서 읽는 칸 수 — 넘으면 그 표는 거기까지 */
const TABLE_CELL_LIMIT = 4000;
const NESTED_DEPTH_LIMIT = 3;

export interface DocumentText { text: string; pages: number; truncated: boolean }

/** 칸 하나의 글 — 문단은 줄바꿈으로 잇고, 칸 안의 표는 한 줄로 접는다 */
function cellText(engine: Engine, sec: number, cell: CellAddr, depth: number): string {
  const parts: string[] = [];
  let n = 0;
  try { n = engine.cellParagraphCount(sec, cell); } catch { n = 0; }
  for (let p = 0; p < n; p++) {
    let text = '';
    try { text = engine.length(sec, p, cell) > 0 ? engine.text(sec, p, cell) : ''; } catch { text = ''; }
    if (text.trim()) parts.push(text);
  }
  if (depth < NESTED_DEPTH_LIMIT) {
    let nested: CellPathEntry[][] = [];
    try { nested = engine.nestedTables(sec, cell); } catch { nested = []; }
    for (const path of nested) {
      const rows = tableRows(engine, sec, cell.paraIdx, cell.controlIdx, depth + 1, path);
      if (rows.length > 0) parts.push(`[표: ${rows.map((r) => r.join(' · ')).join(' / ')}]`);
    }
  }
  return parts.join('\n');
}

/** 표의 행들 (행마다 칸의 글). path 가 있으면 그 경로의 중첩 표 */
function tableRows(engine: Engine, sec: number, paraIdx: number, controlIdx: number, depth: number, path?: CellPathEntry[]): string[][] {
  let dims;
  try { dims = path ? engine.tableDimsByPath(sec, paraIdx, path) : engine.tableDims(sec, paraIdx, controlIdx); } catch { return []; }
  const rows = new Map<number, Array<{ col: number; text: string }>>();
  const count = Math.min(dims.cellCount, TABLE_CELL_LIMIT);
  for (let cellIdx = 0; cellIdx < count; cellIdx++) {
    let info = { row: 0, col: cellIdx, rowSpan: 1, colSpan: 1 };
    let cell: CellAddr;
    if (path) {
      const full = path.map((e) => ({ ...e }));
      full[full.length - 1] = { ...full[full.length - 1], cellIndex: cellIdx, cellParaIndex: 0 };
      cell = { paraIdx, controlIdx: full[0].controlIndex, cellIdx: full[0].cellIndex, path: full };
      try { info = engine.cellInfoByPath(sec, paraIdx, full); } catch { /* 자리만 모른다 */ }
    } else {
      cell = { paraIdx, controlIdx, cellIdx };
      try { info = engine.cellInfo(sec, paraIdx, controlIdx, cellIdx); } catch { /* 자리만 모른다 */ }
    }
    const row = rows.get(info.row) ?? [];
    row.push({ col: info.col, text: cellText(engine, sec, cell, depth) });
    rows.set(info.row, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells.sort((a, b) => a.col - b.col).map((c) => c.text));
}

/**
 * 문서 전체의 글. maxChars 를 넘으면 거기서 멈추고 truncated.
 * @param engine 참고 파일로 연 문서의 엔진 어댑터 (열린 문서의 것이 아니다)
 */
export function engineDocumentText(engine: Engine, maxChars: number): DocumentText {
  let pages = 0;
  try { pages = engine.pageCount(); } catch { pages = 0; }
  let starts: ReturnType<typeof collectPageStarts> = null;
  if (pages > 1) {
    try { starts = collectPageStarts(engine, pages); } catch { starts = null; }
  }
  /** `${sec}:${para}` → 그 문단에서 시작하는 쪽 번호(1부터) */
  const pageAt = new Map<string, number>();
  starts?.forEach((s, page) => {
    const key = `${s.sec}:${s.para}`;
    if (!s.continued && !pageAt.has(key)) pageAt.set(key, page + 1);
  });
  const tablesAt = new Map<string, number[]>();
  let tables: ReturnType<Engine['tables']> = [];
  try { tables = engine.tables(); } catch { tables = []; }
  for (const t of tables) {
    const key = `${t.sectionIdx}:${t.paraIdx}`;
    tablesAt.set(key, [...(tablesAt.get(key) ?? []), t.controlIdx]);
  }

  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  const push = (line: string): boolean => {
    if (used + line.length > maxChars) {
      const room = maxChars - used;
      if (room > 0) lines.push(line.slice(0, room));
      used = maxChars;
      truncated = true;
      return false;
    }
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  const sections = engine.sectionCount();
  outer: for (let sec = 0; sec < sections; sec++) {
    const n = engine.paragraphCount(sec);
    for (let p = 0; p < n; p++) {
      const key = `${sec}:${p}`;
      const page = pageAt.get(key);
      if (page !== undefined && (page > 1 || lines.length > 0)) {
        if (!push(`\n[${page}쪽]`)) break outer;
      } else if (page === 1 && pages > 1) {
        if (!push('[1쪽]')) break outer;
      }
      let text = '';
      try { text = engine.length(sec, p) > 0 ? engine.text(sec, p) : ''; } catch { text = ''; }
      // 표·그림만 든 문단은 글이 없다 — 빈 줄로 두지 않는다
      const anchored = tablesAt.get(key);
      if (text.trim() || !anchored) {
        if (!push(text.replace(/[\r\n\u2028\u2029]+/g, ' '))) break outer;
      }
      for (const controlIdx of anchored ?? []) {
        const rows = tableRows(engine, sec, p, controlIdx, 0);
        if (rows.length === 0) continue;
        if (!push('')) break outer;
        for (const row of rows) if (!push(rowLine(row))) break outer;
        if (!push('')) break outer;
      }
    }
  }
  const text = lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, pages, truncated };
}

// ─── PDF: 쪽 배치에서 글 읽기 ────────────────────────────

/** 쪽에 그려진 글 조각 (엔진 getPageTextLayout 의 run) */
export interface LayoutRun { text: string; x: number; y: number; w: number; h: number }

/**
 * 쪽에 놓인 글 조각들을 읽는 순서의 글로 — 같은 높이의 조각을 한 줄로 모아 왼쪽부터 잇는다.
 * PDF 는 글이 좌표로만 놓여 있어(엔진은 쪽마다 글상자로 연다) 본문 문단이 없다. 줄 사이가 넓으면 빈 줄,
 * 조각 사이가 넓으면 칸 사이로 보고 탭을 넣는다(표의 열).
 */
export function linesFromRuns(runs: ReadonlyArray<LayoutRun>): string {
  const inked = runs.filter((r) => typeof r?.text === 'string' && r.text !== '' && Number.isFinite(r.x) && Number.isFinite(r.y));
  if (inked.length === 0) return '';
  const sorted = [...inked].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<{ y: number; h: number; runs: LayoutRun[] }> = [];
  for (const run of sorted) {
    const h = run.h > 0 ? run.h : 10;
    const last = lines[lines.length - 1];
    if (last && Math.abs(run.y - last.y) <= Math.max(h, last.h) * 0.55) {
      last.runs.push(run);
      last.h = Math.max(last.h, h);
    } else {
      lines.push({ y: run.y, h, runs: [run] });
    }
  }
  const out: string[] = [];
  let prev: { y: number; h: number } | null = null;
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x);
    let text = '';
    let end = Number.NaN;
    for (const run of line.runs) {
      if (Number.isFinite(end)) {
        const gap = run.x - end;
        const edge = /\s$/.test(text) || /^\s/.test(run.text);
        if (gap > line.h * 2.5) text = `${text.trimEnd()}\t`;
        else if (gap > line.h * 0.3 && !edge) text += ' ';
      }
      text += run.text;
      end = run.x + (run.w > 0 ? run.w : 0);
    }
    text = text.replace(/[ \u00a0]+/g, ' ').trim();
    if (!text) continue;
    if (prev && line.y - prev.y > Math.max(prev.h, line.h) * 2.2) out.push('');
    out.push(text);
    prev = line;
  }
  return out.join('\n');
}

export interface PagedText extends DocumentText {
  /** 글이 (거의) 없는 쪽 — 스캔본. 0 부터 센다 */
  emptyPages: number[];
}

/** 쪽마다 이보다 글이 적으면 글이 없는 쪽으로 본다 */
const EMPTY_PAGE_CHARS = 12;

/**
 * 쪽 배치에서 문서의 글을 읽는다 (PDF). 쪽마다 `[N쪽]` 을 붙인다 — 원본의 쪽 번호 그대로다.
 * @param engine PDF 를 기본 배치로 연 문서의 엔진 어댑터
 */
export function pagedDocumentText(engine: Engine, maxChars: number): PagedText {
  let pages = 0;
  try { pages = engine.pageCount(); } catch { pages = 0; }
  const parts: string[] = [];
  const emptyPages: number[] = [];
  let used = 0;
  let truncated = false;
  for (let page = 0; page < pages; page++) {
    let text = '';
    try {
      const layout = engine.json<{ runs?: LayoutRun[] }>('getPageTextLayout', page);
      text = linesFromRuns(layout?.runs ?? []);
    } catch { text = ''; }
    if (text.replace(/\s/g, '').length < EMPTY_PAGE_CHARS) emptyPages.push(page);
    if (!text) continue;
    const block = `${pages > 1 ? `[${page + 1}쪽]\n` : ''}${text}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used;
      if (room > 0) parts.push(block.slice(0, room));
      truncated = true;
      // 남은 쪽이 글이 없는 쪽인지는 더 보지 않는다
      break;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return { text: parts.join('\n\n'), pages, truncated, emptyPages };
}
