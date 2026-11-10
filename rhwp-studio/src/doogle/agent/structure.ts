// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/tool-executor.ts (getStructure / renderCompactStructure / structure tags)
/**
 * get_structure — 에이전트의 진입점 읽기.
 *
 * compact 텍스트: 문단 한 줄 "s0 p12 (40 h1 B) text…", 빈 문단 연속은 "s0 p13-p17 empty",
 * 표는 앵커 문단 바로 뒤에 "table s0 p5 c0 3x4" + 행마다 "r0 [cellIdx] text | …",
 * 쪽이 바뀌는 자리에 "-- page N (pageIndex N-1) --". 태그(B/I/U/크기/개요)는 짧은 문단에만 붙고
 * 그 문단에 대해서는 빠짐없다(태그가 없으면 굵게도 없다).
 */
import { Engine } from './engine-adapter.ts';
import { scalarLength, scalarSlice, type CellAddr } from './types.ts';

export const STRUCTURE_FULL_TEXT_CHARS = 16_000;
const STRUCTURE_TAG_MAX_CHARS = 60;
const STRUCTURE_TAG_MAX_RANGES = 3;
const STRUCTURE_CELL_TAG_LIMIT = 200;
const STRUCTURE_BODY_SIZE_SAMPLES = 64;
const CELL_PREVIEW_CHARS = 80;
export const PAGE_START_SCAN_LIMIT = 600;

export const STRUCTURE_LEGEND = 'Lines: "s<sec> p<paraIdx> (<length>) <text>"; … = text cut, ⇥ = tab, "pA-pB empty" = empty paragraphs. '
  + 'Text is verbatim, usable in anchors as is; "quoted" = exact text as a JSON string, used when it starts or ends with a space. '
  + '"-- page N (pageIndex N-1) --" = lines below are on the page the user calls page N; tools take the 0-based pageIndex ("pX continues" = it starts inside pX). '
  + `Paragraphs up to ${STRUCTURE_TAG_MAX_CHARS} chars carry tags after the length, e.g. "(12 h1 B 14pt)": h/#/• + level`
  + ' = outline heading / numbered / bulleted paragraph (its number or bullet is generated, not text); '
  + 'B/I/U = bold/italic/underline throughout, B0-7,12-15 = only those charOffsets (end exclusive), B~ = scattered parts, no B = no bold at all; Npt = size when not the body size, ~pt = mixed sizes. '
  + 'Each table follows its anchor paragraph as "table s<sec> p<paraIdx> c<controlIdx> <rows>x<cols>" plus "r<row> [cellIdx] text | …" lines; '
  + 'after the cellIdx: rsN/csN = span when not 1, then its B/I/U/Npt tags. '
  + '⏎ = next cell paragraph (cellParaIdx 0,1,…). '
  + 'cell = {paraIdx: table p, controlIdx: table c, cellIdx}. format:"json" gives JSON.';

export interface StructureEmphasis { marks: string[]; size: number | null; mixedSize: boolean }

export interface StructureParagraph {
  paraIdx: number;
  length: number;
  text: string;
  tag?: string;
}

export interface StructureCellParagraph { cellParaIdx: number; length: number; text: string; tag?: string }
export interface StructureCell { cellIdx: number; row: number; col: number; rowSpan: number; colSpan: number; paragraphs: StructureCellParagraph[] }
export interface StructureTable {
  paraIdx: number;
  controlIdx: number;
  rowCount: number;
  colCount: number;
  cells: StructureCell[];
  untaggedFromCellIdx?: number;
}

export interface StructurePageMark { page: number; sectionIdx: number; paraIdx: number; continued: boolean }
export interface PageStart { sec: number; para: number; continued: boolean }

export interface StructureSection {
  sectionIdx: number;
  paragraphCount: number;
  paragraphs: StructureParagraph[];
  tables: StructureTable[];
}

export interface StructureData {
  pageCount: number;
  sectionCount: number;
  sections: StructureSection[];
  pageMarks: StructurePageMark[];
  pages?: { first: number; last: number };
  range?: { sectionIdx: number; fromPara: number; toPara: number };
  fullText: boolean;
  truncated: boolean;
  continueFrom?: { sectionIdx: number; fromPara: number; toPara: number };
}

export interface StructureOptions {
  maxPreviewChars: number;
  maxParagraphs: number;
  fullText: boolean;
  pages?: [number, number];
  range?: { sectionIdx: number; fromPara: number; toPara: number };
  /** 이 문단들만 (sinceRevision 델타) — 섹션별 [first,last] 구간 */
  only?: Map<number, Array<[number, number]>>;
}

function cleanText(text: string): string {
  return text.replace(/\t/g, '⇥').replace(/[\r\n\u2028\u2029]/g, ' ');
}

export function structureLineText(text: string): string {
  const shown = cleanText(text);
  return /^[\s"]|\s$/.test(shown) ? JSON.stringify(shown) : shown;
}

export function structureSizeText(size: number): string {
  return `${Math.round(size) / 100}pt`;
}

/** 문단 한 줄 렌더 */
export function structureParagraphLine(sec: number, para: StructureParagraph): string {
  const head = `s${sec} p${para.paraIdx} (${para.length}${para.tag ? ` ${para.tag}` : ''})`;
  if (para.length === 0) return head;
  return `${head} ${structureLineText(para.text)}${scalarLength(para.text) < para.length ? '…' : ''}`;
}

/**
 * 강조 구간 → 태그. runs 는 [start,end) 글자 구간과 그 속성이다.
 */
export function emphasisFromRuns(
  length: number,
  runs: Array<{ start: number; end: number; bold: boolean; italic: boolean; underline: boolean; size: number | null }>,
): StructureEmphasis {
  const marks: string[] = [];
  for (const [mark, key] of [['B', 'bold'], ['I', 'italic'], ['U', 'underline']] as const) {
    const ranges: Array<[number, number]> = [];
    for (const r of runs) {
      if (!r[key] || r.end <= r.start) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[1] >= r.start) last[1] = Math.max(last[1], r.end);
      else ranges.push([r.start, r.end]);
    }
    if (ranges.length === 0) continue;
    if (ranges.length === 1 && ranges[0][0] <= 0 && ranges[0][1] >= length) marks.push(mark);
    else if (ranges.length <= STRUCTURE_TAG_MAX_RANGES) marks.push(`${mark}${ranges.map(([a, b]) => `${a}-${b}`).join(',')}`);
    else marks.push(`${mark}~`);
  }
  const sizes = new Set(runs.filter((r) => r.end > r.start && r.size !== null).map((r) => r.size as number));
  return { marks, size: sizes.size === 1 ? [...sizes][0] : null, mixedSize: sizes.size > 1 };
}

export function structureTagText(emphasis: StructureEmphasis | undefined, baseSize: number | null, lead: string[] = []): string {
  if (!emphasis) return lead.join(' ');
  const sized = emphasis.size !== null && baseSize !== null && emphasis.size !== baseSize;
  const size = emphasis.mixedSize ? ['~pt'] : sized ? [structureSizeText(emphasis.size!)] : [];
  return [...lead, ...emphasis.marks, ...size].join(' ');
}

/** 쪽마다 첫 본문 문단 — getPageTextLayout 의 첫 run 으로 정한다. */
export function collectPageStarts(engine: Engine, pageCount: number): PageStart[] | null {
  if (pageCount > PAGE_START_SCAN_LIMIT || !engine.has('getPageTextLayout')) return null;
  const starts: PageStart[] = [];
  let prev: PageStart = { sec: 0, para: 0, continued: false };
  for (let page = 0; page < pageCount; page++) {
    let start: PageStart | null = null;
    try {
      const layout = engine.json<{ runs?: Array<Record<string, unknown>> }>('getPageTextLayout', page);
      for (const run of layout?.runs ?? []) {
        const sec = run['secIdx'];
        if (typeof sec !== 'number') continue;
        if (typeof run['parentParaIdx'] === 'number') {
          start = { sec, para: run['parentParaIdx'] as number, continued: false };
          break;
        }
        if (typeof run['paraIdx'] === 'number') {
          start = { sec, para: run['paraIdx'] as number, continued: ((run['charStart'] as number) ?? 0) > 0 };
          break;
        }
      }
    } catch { start = null; }
    // 글 없는 쪽(그림만)은 앞 쪽의 문단이 이어지는 것으로 본다.
    const resolved = start ?? { ...prev, continued: true };
    if (start && starts.length > 0) {
      const last = starts[starts.length - 1];
      if (start.sec === last.sec && start.para === last.para) start.continued = true;
    }
    starts.push(resolved);
    prev = resolved;
  }
  return starts;
}

export class StructureReader {
  private readonly engine: Engine;
  private bodySizeMemo: number | null | undefined;
  private shapeMemo = new Map<number, { bold: boolean; italic: boolean; underline: boolean; size: number | null }>();
  private cellTagBudget = STRUCTURE_CELL_TAG_LIMIT;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  /** 본문 기준 글자 크기 — 앞쪽 문단 표본의 가장 흔한 크기 */
  bodySize(): number | null {
    if (this.bodySizeMemo !== undefined) return this.bodySizeMemo;
    const counts = new Map<number, number>();
    let seen = 0;
    const sections = this.engine.sectionCount();
    outer: for (let s = 0; s < sections; s++) {
      const n = this.engine.paragraphCount(s);
      for (let p = 0; p < n; p++) {
        const len = this.engine.length(s, p);
        if (len === 0) continue;
        try {
          const props = this.engine.charPropsAt(s, p, 0);
          const size = typeof props['fontSize'] === 'number' ? props['fontSize'] as number : null;
          if (size !== null) counts.set(size, (counts.get(size) ?? 0) + len);
        } catch { /* skip */ }
        if (++seen >= STRUCTURE_BODY_SIZE_SAMPLES) break outer;
      }
    }
    let best: number | null = null;
    let most = 0;
    for (const [size, n] of counts) if (n > most) { most = n; best = size; }
    this.bodySizeMemo = best;
    return best;
  }

  /** 짧은 문단의 강조 (본문 또는 셀) */
  emphasis(sectionIdx: number, paraIdx: number, length: number, cell?: CellAddr): StructureEmphasis | undefined {
    if (length === 0 || length > STRUCTURE_TAG_MAX_CHARS) return undefined;
    try {
      const runs = this.engine.charShapeRuns(sectionIdx, paraIdx, 0, length, cell);
      const list = (runs.length > 0 ? runs : [{ startOffset: 0, endOffset: length, charShapeId: -1 }]).map((r) => {
        const shape = this.shapeAt(sectionIdx, paraIdx, r.startOffset, r.charShapeId, cell);
        return { start: r.startOffset, end: Math.min(r.endOffset, length), ...shape };
      });
      return emphasisFromRuns(length, list);
    } catch {
      return undefined;
    }
  }

  private shapeAt(sec: number, para: number, offset: number, id: number, cell?: CellAddr) {
    const memo = id >= 0 ? this.shapeMemo.get(id) : undefined;
    if (memo) return memo;
    const props = this.engine.charPropsAt(sec, para, offset, cell);
    const shape = {
      bold: props['bold'] === true,
      italic: props['italic'] === true,
      underline: props['underline'] === true,
      size: typeof props['fontSize'] === 'number' ? props['fontSize'] as number : null,
    };
    if (id >= 0) this.shapeMemo.set(id, shape);
    return shape;
  }

  /** 개요·번호·글머리 머리 태그 */
  headTag(sectionIdx: number, paraIdx: number, cell?: CellAddr): string[] {
    try {
      const props = this.engine.paraPropsAt(sectionIdx, paraIdx, cell);
      const level = (typeof props['paraLevel'] === 'number' ? props['paraLevel'] as number : 0) + 1;
      switch (props['headType']) {
        case 'Outline': return [`h${level}`];
        case 'Number': return [`#${level}`];
        case 'Bullet': return [`•${level}`];
        default: return [];
      }
    } catch {
      return [];
    }
  }

  paragraph(sectionIdx: number, paraIdx: number, maxChars: number): StructureParagraph {
    const length = this.engine.length(sectionIdx, paraIdx);
    const text = length === 0 ? '' : this.engine.text(sectionIdx, paraIdx, undefined, 0, Math.min(length, maxChars));
    const out: StructureParagraph = { paraIdx, length, text };
    if (length <= STRUCTURE_TAG_MAX_CHARS) {
      const tag = structureTagText(this.emphasis(sectionIdx, paraIdx, length), this.bodySize(), this.headTag(sectionIdx, paraIdx));
      if (tag) out.tag = tag;
    }
    return out;
  }

  table(sectionIdx: number, paraIdx: number, controlIdx: number, maxChars: number): StructureTable | null {
    let dims;
    try { dims = this.engine.tableDims(sectionIdx, paraIdx, controlIdx); } catch { return null; }
    const table: StructureTable = { paraIdx, controlIdx, rowCount: dims.rowCount, colCount: dims.colCount, cells: [] };
    for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
      let info = { row: 0, col: cellIdx, rowSpan: 1, colSpan: 1 };
      try { info = this.engine.cellInfo(sectionIdx, paraIdx, controlIdx, cellIdx); } catch { /* keep */ }
      const cell: CellAddr = { paraIdx, controlIdx, cellIdx };
      const paragraphs: StructureCellParagraph[] = [];
      let n = 0;
      try { n = this.engine.cellParagraphCount(sectionIdx, cell); } catch { n = 0; }
      for (let cp = 0; cp < n; cp++) {
        const length = this.engine.length(sectionIdx, cp, cell);
        const text = length === 0 ? '' : this.engine.text(sectionIdx, cp, cell, 0, Math.min(length, maxChars));
        const para: StructureCellParagraph = { cellParaIdx: cp, length, text };
        if (length > 0 && length <= STRUCTURE_TAG_MAX_CHARS) {
          if (this.cellTagBudget > 0) {
            this.cellTagBudget--;
            const tag = structureTagText(this.emphasis(sectionIdx, cp, length, cell), this.bodySize());
            if (tag) para.tag = tag;
          } else if (table.untaggedFromCellIdx === undefined) {
            table.untaggedFromCellIdx = cellIdx;
          }
        }
        paragraphs.push(para);
      }
      table.cells.push({ cellIdx, row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan, paragraphs });
    }
    return table;
  }

  collect(opts: StructureOptions, pageStarts: PageStart[] | null): StructureData {
    const engine = this.engine;
    const pageCount = engine.pageCount();
    const sectionCount = engine.sectionCount();
    const data: StructureData = {
      pageCount, sectionCount, sections: [], pageMarks: [], fullText: opts.fullText, truncated: false,
    };
    // 섹션별 대상 문단 구간
    const spans = new Map<number, [number, number]>();
    if (opts.range) {
      const n = engine.paragraphCount(opts.range.sectionIdx);
      spans.set(opts.range.sectionIdx, [opts.range.fromPara, Math.min(opts.range.toPara, n - 1)]);
      data.range = opts.range;
    } else if (opts.pages && pageStarts) {
      const [first, last] = opts.pages;
      data.pages = { first, last };
      const from = pageStarts[first];
      const next = pageStarts[last + 1];
      for (let s = from.sec; s < sectionCount; s++) {
        if (next && s > next.sec) break;
        const n = engine.paragraphCount(s);
        const lo = s === from.sec ? from.para : 0;
        let hi = n - 1;
        if (next && s === next.sec) hi = next.continued ? next.para : next.para - 1;
        if (hi >= lo) spans.set(s, [lo, hi]);
      }
    } else {
      for (let s = 0; s < sectionCount; s++) {
        const n = engine.paragraphCount(s);
        if (n > 0) spans.set(s, [0, n - 1]);
      }
    }
    if (pageStarts) {
      pageStarts.forEach((st, page) => {
        if (opts.pages && (page < opts.pages[0] || page > opts.pages[1])) return;
        data.pageMarks.push({ page, sectionIdx: st.sec, paraIdx: st.para, continued: st.continued });
      });
    }
    const tablesBySection = new Map<number, Array<{ paraIdx: number; controlIdx: number }>>();
    for (const t of engine.tables()) {
      const list = tablesBySection.get(t.sectionIdx) ?? [];
      list.push({ paraIdx: t.paraIdx, controlIdx: t.controlIdx });
      tablesBySection.set(t.sectionIdx, list);
    }
    let budget = opts.fullText ? STRUCTURE_FULL_TEXT_CHARS : Number.POSITIVE_INFINITY;
    let paragraphsLeft = opts.maxParagraphs;
    for (const [sec, [lo, hi]] of [...spans.entries()].sort((a, b) => a[0] - b[0])) {
      const section: StructureSection = { sectionIdx: sec, paragraphCount: engine.paragraphCount(sec), paragraphs: [], tables: [] };
      data.sections.push(section);
      const only = opts.only?.get(sec);
      for (let p = lo; p <= hi; p++) {
        if (only && !only.some(([a, b]) => p >= a && p <= b)) continue;
        if (data.truncated) break;
        if (paragraphsLeft <= 0 || budget <= 0) {
          data.truncated = true;
          if (budget <= 0) data.continueFrom = { sectionIdx: sec, fromPara: p, toPara: hi };
          break;
        }
        const maxChars = opts.fullText ? Math.max(1, budget) : opts.maxPreviewChars;
        const para = this.paragraph(sec, p, maxChars);
        section.paragraphs.push(para);
        paragraphsLeft--;
        if (opts.fullText) budget -= scalarLength(para.text);
        for (const t of tablesBySection.get(sec) ?? []) {
          if (t.paraIdx !== p) continue;
          const cellChars = opts.fullText ? Math.max(1, Math.min(budget, 2000)) : Math.min(opts.maxPreviewChars, CELL_PREVIEW_CHARS);
          const table = this.table(sec, t.paraIdx, t.controlIdx, cellChars);
          if (!table) continue;
          section.tables.push(table);
          if (opts.fullText) {
            for (const c of table.cells) for (const cp of c.paragraphs) budget -= scalarLength(cp.text);
          }
        }
      }
    }
    return data;
  }
}

function cellTags(paragraphs: StructureCellParagraph[]): string {
  const inked = paragraphs.filter((p) => p.length > 0);
  if (!inked.some((p) => p.tag)) return '';
  const tags = inked.map((p) => p.tag ?? '');
  const shared = tags[0] !== '' && tags.every((t) => t === tags[0]) && (paragraphs.length === 1 || !/\d-/.test(tags[0]));
  if (shared) return ` ${tags[0]}`;
  return paragraphs.filter((p) => p.tag).map((p) => ` p${p.cellParaIdx} ${p.tag}`).join('');
}

function emitTable(lines: string[], sec: number, table: StructureTable): void {
  const untagged = table.untaggedFromCellIdx;
  lines.push(`  table s${sec} p${table.paraIdx} c${table.controlIdx} ${table.rowCount}x${table.colCount}`
    + (untagged === undefined ? '' : untagged === 0 ? ' (no cell tags)' : ` (no cell tags from [${untagged}])`));
  const rows = new Map<number, string[]>();
  for (const cell of table.cells) {
    const spans = `${cell.rowSpan !== 1 ? ` rs${cell.rowSpan}` : ''}${cell.colSpan !== 1 ? ` cs${cell.colSpan}` : ''}`;
    const body = cell.paragraphs.map((p) => {
      if (p.length === 0) return '';
      const cut = scalarLength(p.text) < p.length;
      return structureLineText(p.text) + (cut ? `…(${p.length})` : '');
    }).join('⏎');
    const row = rows.get(cell.row) ?? [];
    row.push(`[${cell.cellIdx}${spans}${cellTags(cell.paragraphs)}]${body ? ` ${body}` : ''}`);
    rows.set(cell.row, row);
  }
  for (const [row, cells] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`  r${row} ${cells.join(' | ')}`);
  }
}

/** compact 구조 텍스트 */
export function renderCompactStructure(data: StructureData, revisionLabel: string): string {
  const lines: string[] = [];
  const sectionWord = data.sectionCount === 1 ? 'section' : 'sections';
  const scope = data.pages
    ? ` · pageIndex ${data.pages.first}-${data.pages.last}`
    : data.range ? ` · range s${data.range.sectionIdx} p${data.range.fromPara}-p${data.range.toPara}` : '';
  const cont = data.continueFrom;
  const truncation = !data.truncated
    ? ''
    : cont
      ? ` · TRUNCATED — continue with range {sectionIdx:${cont.sectionIdx}, fromPara:${cont.fromPara}, toPara:${cont.toPara}} text:"full"`
      : ' · TRUNCATED by maxParagraphs (raise it, pass pages/range, or use find_text)';
  lines.push(`${revisionLabel} · ${data.pageCount} pages · ${data.sectionCount} ${sectionWord}${scope}`
    + (data.fullText ? ' · full text' : '') + truncation);
  lines.push(STRUCTURE_LEGEND);
  for (const section of data.sections) {
    const sec = section.sectionIdx;
    lines.push(`s${sec} · ${section.paragraphCount} paragraphs`);
    const tables = [...section.tables];
    const marks = data.pageMarks.filter((m) => m.sectionIdx === sec);
    let markAt = 0;
    let emptyStart = -1;
    let emptyEnd = -1;
    const flushEmpty = (): void => {
      if (emptyStart < 0) return;
      lines.push(emptyStart === emptyEnd ? `s${sec} p${emptyStart} empty` : `s${sec} p${emptyStart}-p${emptyEnd} empty`);
      emptyStart = -1;
    };
    const pushMark = (m: StructurePageMark, showContinues: boolean): void => {
      flushEmpty();
      lines.push(`-- page ${m.page + 1} (pageIndex ${m.page}${showContinues && m.continued ? `, p${m.paraIdx} continues` : ''}) --`);
    };
    const firstPara = section.paragraphs[0]?.paraIdx;
    if (firstPara !== undefined) {
      let context: StructurePageMark | null = null;
      while (markAt < marks.length && marks[markAt].paraIdx < firstPara) context = marks[markAt++];
      const startsHere = markAt < marks.length && marks[markAt].paraIdx === firstPara;
      if (context && !(startsHere && !marks[markAt].continued)) pushMark(context, false);
      if (!context && startsHere && marks[markAt].continued) pushMark(marks[markAt++], true);
    }
    for (const para of section.paragraphs) {
      while (markAt < marks.length && (marks[markAt].paraIdx < para.paraIdx
        || (marks[markAt].paraIdx === para.paraIdx && !marks[markAt].continued))) {
        pushMark(marks[markAt], marks[markAt].paraIdx < para.paraIdx);
        markAt++;
      }
      const anchored = tables.filter((t) => t.paraIdx === para.paraIdx);
      if (para.length === 0 && anchored.length === 0) {
        if (emptyStart < 0) emptyStart = para.paraIdx;
        emptyEnd = para.paraIdx;
        continue;
      }
      flushEmpty();
      lines.push(structureParagraphLine(sec, para));
      for (const table of anchored) {
        emitTable(lines, sec, table);
        tables.splice(tables.indexOf(table), 1);
      }
    }
    const lastPara = section.paragraphs.at(-1)?.paraIdx;
    while (lastPara !== undefined && markAt < marks.length && marks[markAt].paraIdx <= lastPara) {
      if (marks[markAt].continued) pushMark(marks[markAt], true);
      markAt++;
    }
    flushEmpty();
    for (const table of tables) emitTable(lines, sec, table);
  }
  return lines.join('\n');
}

/** 앞에서 maxChars 글자만 (scalar) */
export function clipScalar(text: string, maxChars: number): string {
  return scalarLength(text) <= maxChars ? text : scalarSlice(text, 0, maxChars);
}
