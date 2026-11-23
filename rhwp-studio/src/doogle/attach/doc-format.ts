/**
 * 참고 파일로 붙인 한글 문서의 서식 요약 — "이 양식대로 맞춰 줘" 할 때 에이전트가 볼 모양.
 *
 * 글(doc-text.ts)과 따로 만든다. 싣는 것:
 *  - 쪽 모양: 구역마다 용지·방향·여백·단·머리말/꼬리말 (같은 구역이 이어지면 하나로)
 *  - 문단 서식: 문단 모양 + 그 문단의 주된 글자 모양 + 스타일 이름이 같은 문단끼리 묶어 한 줄,
 *    문단 수와 글자 수, 그 서식을 쓰는 글의 앞머리 몇 개(어느 글이 그 모양인지 알아보게)
 *  - 부분 글자 모양: 문단 안 일부에만 입힌 글자 모양(굵게 강조 등)
 *  - 표: 크기·너비·열 너비·테두리·칸 여백·배경
 * 문단을 하나하나 늘어놓지 않는다 — 서로 다른 모양만, 많이 쓴 순으로 골라 문서 순서로 싣고 글자 수 상한을 둔다.
 * 값의 단위는 에이전트 도구 인자와 같다: 쪽·표는 mm, 글자·문단은 pt (set_page_layout · apply_char_format ·
 * apply_para_format · set_zone_borders 의 type 번호). 열린 문서의 주소(s0 p12)는 싣지 않는다 — 읽기 전용 자료다.
 * 글의 앞머리는 이미 글(text)에 실리는 것의 일부일 뿐이다(새 값이 모델로 나가지 않는다).
 */
import type { Engine } from '../agent/engine-adapter.ts';
import type { CellAddr } from '../agent/types.ts';

/** 서식 요약의 글자 수 상한 (hub ATTACHMENT_LIMITS.formatChars 보다 작게) */
export const FORMAT_SUMMARY_CHARS = 4_000;
/** 훑는 본문 문단 수 · 표 칸 안 문단 수 */
const BODY_PARA_SCAN = 4_000;
const CELL_PARA_SCAN = 3_000;
/** 실는 문단 서식 · 부분 글자 모양 · 표의 수 */
const PARA_STYLE_ROWS = 14;
const CELL_STYLE_ROWS = 8;
const RUN_STYLE_ROWS = 6;
const TABLE_ROWS = 12;
/** 열 너비를 재려고 살피는 표 하나의 칸 수 */
const TABLE_CELL_SCAN = 400;
const SAMPLE_CHARS = 16;
const SAMPLES_PER_ROW = 2;

const HU_PER_MM = 7200 / 25.4;
const mm = (hu: number): number => Math.round((hu / HU_PER_MM) * 10) / 10;
/** getParaPropertiesAt 의 여백·간격은 px — pt 로 (executor get_para_format 과 같은 환산) */
const pxToPt = (px: number): number => Math.round(px * 0.75 * 10) / 10;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (n: number): string => String(Math.round(n * 10) / 10);

const PAPERS: Array<[string, number, number]> = [
  ['A4', 210, 297], ['A3', 297, 420], ['A5', 148, 210], ['B4', 257, 364], ['B5', 182, 257], ['Letter', 215.9, 279.4], ['Legal', 215.9, 355.6],
];
/** HWP 선 종류 (BorderLineType) — 번호는 set_zone_borders 의 type */
const BORDER_TYPES = ['없음', '실선', '파선', '점선', '일점쇄선', '이점쇄선', '긴파선', '원형점선', '이중선', '가는-굵은 이중선', '굵은-가는 이중선', '삼중선', '물결', '이중물결', '두꺼운 3D', '두꺼운 3D(반대)', '3D', '3D(반대)'];
/** HWP 선 굵기 표 (mm) — 인덱스가 엔진 width 코드 */
const BORDER_WIDTHS_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
const ALIGN: Record<string, string> = { justify: '양쪽 정렬', left: '왼쪽 정렬', right: '오른쪽 정렬', center: '가운데 정렬', distribute: '배분 정렬', split: '나눔 정렬' };

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > SAMPLE_CHARS ? `${chars.slice(0, SAMPLE_CHARS).join('')}…` : flat;
}

/** 예시 글 — 두 글자가 안 되는 것(글머리 기호 하나 등)은 알아보는 데 쓸모가 없어 싣지 않는다 */
function addSample(list: string[], sample: string): void {
  if (list.length >= SAMPLES_PER_ROW || sample.replace(/\s/g, '').length < 2 || list.includes(sample)) return;
  list.push(sample);
}

// ─── 쪽 모양 ─────────────────────────────────────────────

function paperName(w: number, h: number): string {
  const a = Math.min(w, h);
  const b = Math.max(w, h);
  const hit = PAPERS.find(([, pw, ph]) => Math.abs(pw - a) <= 1 && Math.abs(ph - b) <= 1);
  return hit ? `${hit[0]} ` : '';
}

function pageLine(engine: Engine, sec: number, headers: Map<number, string[]>): string | null {
  let def: Record<string, unknown>;
  try { def = engine.json<Record<string, unknown>>('getPageDef', sec) ?? {}; } catch { return null; }
  const w = num(def['width']);
  const h = num(def['height']);
  if (w === null || h === null) return null;
  const landscape = def['landscape'] === true;
  const parts = [`${paperName(mm(w), mm(h))}${fmt(mm(w))}×${fmt(mm(h))}mm ${landscape ? '가로' : '세로'}`];
  const m = (k: string) => fmt(mm(num(def[k]) ?? 0));
  parts.push(`여백 위 ${m('marginTop')} · 아래 ${m('marginBottom')} · 왼쪽 ${m('marginLeft')} · 오른쪽 ${m('marginRight')} · 머리말 ${m('marginHeader')} · 꼬리말 ${m('marginFooter')}`
    + `${(num(def['marginGutter']) ?? 0) > 0 ? ` · 제본 ${m('marginGutter')}` : ''}`);
  const bodyW = (landscape ? h : w) - (num(def['marginLeft']) ?? 0) - (num(def['marginRight']) ?? 0) - (num(def['marginGutter']) ?? 0);
  if (bodyW > 0) parts.push(`본문 너비 ${fmt(mm(bodyW))}`);
  try {
    const col = engine.json<Record<string, unknown>>('getColumnDef', sec) ?? {};
    const count = num(col['columnCount']) ?? 1;
    const spacing = num(col['spacing']) ?? 0;
    parts.push(count > 1 ? `${count}단 (단 간격 ${fmt(mm(spacing))})` : '1단');
  } catch { /* 단 정보 없음 */ }
  const hf = headers.get(sec);
  if (hf && hf.length > 0) parts.push(hf.join(' · '));
  return parts.join(' · ');
}

/** 구역 번호 → ["머리말(양 쪽) \"…\"", …] */
function headerFooters(engine: Engine): Map<number, string[]> {
  const out = new Map<number, string[]>();
  if (!engine.has('getHeaderFooterList')) return out;
  let items: Array<{ sectionIdx?: number; isHeader?: boolean; applyTo?: number; label?: string }> = [];
  try { items = engine.json<{ items?: typeof items }>('getHeaderFooterList', 0, true, 0)?.items ?? []; } catch { return out; }
  for (const it of items.slice(0, 12)) {
    const sec = typeof it.sectionIdx === 'number' ? it.sectionIdx : 0;
    let text = '';
    try {
      const hf = engine.json<{ text?: string }>('getHeaderFooter', sec, it.isHeader === true, it.applyTo ?? 0);
      text = typeof hf?.text === 'string' ? snippet(hf.text) : '';
    } catch { /* 글 없음 */ }
    const label = typeof it.label === 'string' && it.label ? it.label : (it.isHeader ? '머리말' : '꼬리말');
    out.set(sec, [...(out.get(sec) ?? []), `${label}${text ? ` "${text}"` : ''}`]);
  }
  return out;
}

// ─── 글자·문단 모양 ──────────────────────────────────────

function charDesc(c: Record<string, unknown>): string {
  const parts: string[] = [];
  const family = typeof c['fontFamily'] === 'string' ? c['fontFamily'] as string : '';
  const size = num(c['fontSize']);
  parts.push([family, size !== null ? `${fmt(size / 100)}pt` : ''].filter(Boolean).join(' ') || '글자');
  if (c['bold'] === true) parts.push('굵게');
  if (c['italic'] === true) parts.push('기울임');
  if (c['underline'] === true) parts.push('밑줄');
  if (c['strikethrough'] === true) parts.push('취소선');
  if (c['superscript'] === true) parts.push('위첨자');
  if (c['subscript'] === true) parts.push('아래첨자');
  const color = typeof c['textColor'] === 'string' ? (c['textColor'] as string).toLowerCase() : '#000000';
  if (color !== '#000000') parts.push(`글자색 ${color}`);
  if (c['shadeColor'] && typeof c['shadeColor'] === 'string' && !/^#ffffff$/i.test(c['shadeColor'] as string)) parts.push(`음영 ${(c['shadeColor'] as string).toLowerCase()}`);
  const first = (v: unknown): number | null => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] as number : null);
  const ratio = first(c['ratios']);
  if (ratio !== null && ratio !== 100) parts.push(`장평 ${ratio}%`);
  const spacing = first(c['spacings']);
  if (spacing !== null && spacing !== 0) parts.push(`자간 ${spacing}%`);
  return parts.join(' ');
}

function paraDesc(p: Record<string, unknown>): string {
  const parts: string[] = [];
  const align = typeof p['alignment'] === 'string' ? p['alignment'] as string : '';
  if (align) parts.push(ALIGN[align] ?? align);
  const ls = num(p['lineSpacing']);
  const lsType = String(p['lineSpacingType'] ?? 'Percent');
  if (ls !== null) {
    if (lsType === 'Percent') parts.push(`줄 간격 ${fmt(ls)}%`);
    else parts.push(`줄 간격 ${({ Fixed: '고정', Minimum: '최소', SpaceOnly: '여백만' } as Record<string, string>)[lsType] ?? lsType} ${fmt(ls / 100)}pt`);
  }
  const pt = (k: string): number => pxToPt(num(p[k]) ?? 0);
  if (pt('marginLeft')) parts.push(`왼쪽 여백 ${fmt(pt('marginLeft'))}pt`);
  if (pt('marginRight')) parts.push(`오른쪽 여백 ${fmt(pt('marginRight'))}pt`);
  const indent = pt('indent');
  if (indent > 0) parts.push(`들여쓰기 ${fmt(indent)}pt`);
  else if (indent < 0) parts.push(`내어쓰기 ${fmt(-indent)}pt`);
  if (pt('spacingBefore')) parts.push(`문단 위 ${fmt(pt('spacingBefore'))}pt`);
  if (pt('spacingAfter')) parts.push(`문단 아래 ${fmt(pt('spacingAfter'))}pt`);
  const level = (num(p['paraLevel']) ?? 0) + 1;
  switch (p['headType']) {
    case 'Outline': parts.push(`개요 ${level}수준`); break;
    case 'Number': parts.push(`문단 번호 ${level}수준`); break;
    case 'Bullet': parts.push(`글머리표 ${level}수준`); break;
    default: break;
  }
  if (p['pageBreakBefore'] === true) parts.push('앞에서 쪽 나눔');
  return parts.join(' · ');
}

interface StyleRow { key: string; where: 'body' | 'cell'; desc: string; paragraphs: number; chars: number; first: number; samples: string[] }
interface RunRow { key: string; desc: string; count: number; chars: number; first: number; samples: string[] }

class ShapeCollector {
  private readonly engine: Engine;
  private readonly charMemo = new Map<number, string>();
  private readonly paraMemo = new Map<number, string>();
  readonly styles = new Map<string, StyleRow>();
  readonly runs = new Map<string, RunRow>();
  /** 문서 순서 — 줄을 문서에 처음 나온 차례로 싣는다 */
  private order = 0;

  constructor(engine: Engine) { this.engine = engine; }

  private charAt(sec: number, para: number, offset: number, id: number, cell?: CellAddr): string {
    const hit = id >= 0 ? this.charMemo.get(id) : undefined;
    if (hit !== undefined) return hit;
    let desc = '';
    try {
      const c = this.engine.charPropsAt(sec, para, offset, cell);
      desc = charDesc(c);
    } catch { desc = ''; }
    if (id >= 0) this.charMemo.set(id, desc);
    return desc;
  }

  private paraOf(sec: number, para: number, cell?: CellAddr): string {
    try {
      const p = this.engine.paraPropsAt(sec, para, cell);
      const id = num(p['paraShapeId']);
      if (id !== null) {
        const hit = this.paraMemo.get(id);
        if (hit !== undefined) return hit;
      }
      const desc = paraDesc(p);
      if (id !== null) this.paraMemo.set(id, desc);
      return desc;
    } catch {
      return '';
    }
  }

  private styleName(sec: number, para: number, cell?: CellAddr): string {
    if (cell || !this.engine.has('getStyleAt')) return '';
    try {
      const s = this.engine.json<{ name?: string }>('getStyleAt', sec, para);
      return typeof s?.name === 'string' ? s.name : '';
    } catch { return ''; }
  }

  /** 문단 하나를 센다. 글이 없는 문단은 세지 않는다 */
  paragraph(sec: number, para: number, cell?: CellAddr): void {
    let len = 0;
    try { len = this.engine.length(sec, para, cell); } catch { len = 0; }
    if (len <= 0) return;
    let text = '';
    try { text = this.engine.text(sec, para, cell); } catch { text = ''; }
    if (!text.trim()) return;
    const chars = [...text];
    let runs: Array<{ startOffset: number; endOffset: number; charShapeId: number }> = [];
    try { runs = this.engine.charShapeRuns(sec, para, 0, len, cell); } catch { runs = []; }
    if (runs.length === 0) runs = [{ startOffset: 0, endOffset: len, charShapeId: -1 }];
    // 글자 모양별 (공백이 아닌) 글자 수 — 가장 많은 것이 그 문단의 주된 글자 모양
    const weight = new Map<string, number>();
    const pieces: Array<{ desc: string; text: string }> = [];
    for (const r of runs) {
      const piece = chars.slice(r.startOffset, Math.min(r.endOffset, len)).join('');
      const n = piece.replace(/\s/g, '').length;
      if (n === 0) continue;
      const desc = this.charAt(sec, para, r.startOffset, r.charShapeId, cell);
      weight.set(desc, (weight.get(desc) ?? 0) + n);
      pieces.push({ desc, text: piece });
    }
    let main = '';
    let most = -1;
    for (const [desc, n] of weight) if (n > most) { most = n; main = desc; }
    const where = cell ? 'cell' : 'body';
    const style = this.styleName(sec, para, cell);
    const pdesc = this.paraOf(sec, para, cell);
    const desc = [style ? `[${style}] ${main}` : main, pdesc].filter(Boolean).join(' · ');
    const key = `${where}\n${desc}`;
    const seq = this.order++;
    const row = this.styles.get(key) ?? { key, where, desc, paragraphs: 0, chars: 0, first: seq, samples: [] };
    row.paragraphs++;
    row.chars += text.replace(/\s/g, '').length;
    addSample(row.samples, snippet(text));
    this.styles.set(key, row);
    // 주된 것과 다른 글자 모양 = 부분 강조
    for (const piece of pieces) {
      if (piece.desc === main) continue;
      const rr = this.runs.get(piece.desc) ?? { key: piece.desc, desc: piece.desc, count: 0, chars: 0, first: seq, samples: [] };
      rr.count++;
      rr.chars += piece.text.replace(/\s/g, '').length;
      addSample(rr.samples, snippet(piece.text));
      this.runs.set(piece.desc, rr);
    }
  }
}

/** 많이 쓴 것부터 limit 개를 골라 문서 순서로 */
function pick<T extends { chars: number; first: number }>(rows: Iterable<T>, limit: number): { shown: T[]; rest: number } {
  const all = [...rows];
  const shown = [...all].sort((a, b) => b.chars - a.chars).slice(0, limit).sort((a, b) => a.first - b.first);
  return { shown, rest: all.length - shown.length };
}

// ─── 표 ──────────────────────────────────────────────────

function borderText(b: unknown): string | null {
  const o = b && typeof b === 'object' ? b as Record<string, unknown> : null;
  const type = num(o?.['type']);
  if (type === null || type === 0) return null;
  const width = num(o?.['width']);
  const color = typeof o?.['color'] === 'string' ? (o['color'] as string).toLowerCase() : '#000000';
  return `${BORDER_TYPES[type] ?? '선'}(${type}) ${width !== null ? `${BORDER_WIDTHS_MM[width] ?? width}mm` : ''}${color !== '#000000' ? ` ${color}` : ''}`.trim();
}

function tableLine(engine: Engine, n: number, sec: number, paraIdx: number, controlIdx: number, collector: ShapeCollector, cellBudget: { left: number }): string | null {
  let dims;
  try { dims = engine.tableDims(sec, paraIdx, controlIdx); } catch { return null; }
  let t: Record<string, unknown> = {};
  try { t = engine.json<Record<string, unknown>>('getTableProperties', sec, paraIdx, controlIdx) ?? {}; } catch { t = {}; }
  const parts = [`${dims.rowCount}행×${dims.colCount}열`];
  const width = num(t['tableWidth']);
  if (width !== null && width > 0) parts.push(`너비 ${fmt(mm(width))}mm`);

  const colWidths: Array<number | null> = Array(Math.min(dims.colCount, 64)).fill(null);
  const rowHeights = new Map<number, number>();
  const borders = new Map<string, number>();
  const fills = new Map<string, Set<number>>();
  const valign = new Map<string, number>();
  const padding = new Map<string, number>();
  let firstText = '';
  let headerCells = 0;
  const scan = Math.min(dims.cellCount, TABLE_CELL_SCAN);
  for (let cellIdx = 0; cellIdx < scan; cellIdx++) {
    let info = { row: 0, col: cellIdx, rowSpan: 1, colSpan: 1 };
    try { info = engine.cellInfo(sec, paraIdx, controlIdx, cellIdx); } catch { /* 자리 모름 */ }
    let c: Record<string, unknown> = {};
    try { c = engine.json<Record<string, unknown>>('getCellProperties', sec, paraIdx, controlIdx, cellIdx) ?? {}; } catch { c = {}; }
    const cw = num(c['width']);
    if (cw !== null && info.colSpan === 1 && info.col < colWidths.length && colWidths[info.col] === null) colWidths[info.col] = cw;
    const ch = num(c['height']);
    if (ch !== null && info.rowSpan === 1 && !rowHeights.has(info.row)) rowHeights.set(info.row, ch);
    for (const side of ['borderLeft', 'borderRight', 'borderTop', 'borderBottom']) {
      const b = borderText(c[side]);
      const k = b ?? '없음';
      borders.set(k, (borders.get(k) ?? 0) + 1);
    }
    if (c['fillType'] === 'solid' && typeof c['fillColor'] === 'string') {
      const color = (c['fillColor'] as string).toLowerCase();
      if (color !== '#ffffff') fills.set(color, (fills.get(color) ?? new Set()).add(info.row + 1));
    }
    const va = ['위', '가운데', '아래'][num(c['verticalAlign']) ?? 0] ?? '위';
    valign.set(va, (valign.get(va) ?? 0) + 1);
    const pad = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'].map((k) => fmt(mm(num(c[k]) ?? 0))).join('/');
    padding.set(pad, (padding.get(pad) ?? 0) + 1);
    if (c['isHeader'] === true) headerCells++;
    // 칸 안 문단의 서식 — 문단 서식 목록에 "표 안"으로 모은다
    const cell: CellAddr = { paraIdx, controlIdx, cellIdx };
    let paras = 0;
    try { paras = engine.cellParagraphCount(sec, cell); } catch { paras = 0; }
    for (let p = 0; p < paras && cellBudget.left > 0; p++, cellBudget.left--) {
      collector.paragraph(sec, p, cell);
      if (!firstText) {
        try { firstText = snippet(engine.text(sec, p, cell)); } catch { /* 없음 */ }
      }
    }
  }
  if (colWidths.length > 0 && colWidths.every((v) => v !== null)) {
    parts.push(`열 너비 ${colWidths.map((v) => fmt(mm(v as number))).join('/')}mm`);
  }
  // 칸 높이가 아주 작으면(글에 맞춰 늘어나는 칸) 쓸모가 없다 — 그런 표는 행 높이를 싣지 않는다
  if (rowHeights.size > 0 && rowHeights.size <= 12 && [...rowHeights.values()].every((v) => mm(v) >= 2)) {
    const hs = [...rowHeights.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => fmt(mm(v)));
    if (new Set(hs).size === 1) parts.push(`행 높이 ${hs[0]}mm`);
    else parts.push(`행 높이 ${hs.join('/')}mm`);
  }
  const top = (m: Map<string, number>): string | null => {
    let best: string | null = null;
    let most = 0;
    for (const [k, v] of m) if (v > most) { most = v; best = k; }
    return best;
  };
  const border = top(borders);
  if (border) parts.push(`칸 테두리 ${border}${borders.size > 1 ? ' (대부분)' : ''}`);
  const tableBorder = borderText(t['borderTop']);
  if (tableBorder && tableBorder !== border) parts.push(`표 테두리 ${tableBorder}`);
  const pad = top(padding);
  if (pad) parts.push(`칸 여백(왼/오/위/아래) ${pad}mm`);
  const va = top(valign);
  if (va && va !== '위') parts.push(`세로 ${va} 정렬`);
  for (const [color, rows] of [...fills.entries()].slice(0, 3)) {
    const list = [...rows].sort((a, b) => a - b);
    parts.push(`배경 ${color} (${list.length > 6 ? `${list.slice(0, 6).join('·')}…` : list.join('·')}행)`);
  }
  if (t['repeatHeader'] === true && headerCells > 0) parts.push('머리 행 반복');
  if (t['treatAsChar'] === false) parts.push(`글자처럼 취급 안 함(배치 ${typeof t['textWrap'] === 'string' ? t['textWrap'] : '?'})`);
  if (dims.cellCount > scan) parts.push(`칸 ${dims.cellCount}개 중 앞 ${scan}개만 살핌`);
  let page = '';
  const pg = engine.pageOfParagraph(sec, paraIdx);
  if (pg !== null) page = `${pg + 1}쪽`;
  const head = [page, firstText ? `첫 칸 "${firstText}"` : ''].filter(Boolean).join(', ');
  return `- 표 ${n}${head ? ` (${head})` : ''}: ${parts.join(' · ')}`;
}

// ─── 모으기 ──────────────────────────────────────────────

/**
 * 문서의 서식 요약. 읽을 것이 없으면 빈 글.
 * @param engine 참고 파일로 연 문서의 엔진 어댑터 (열린 문서의 것이 아니다)
 */
export function engineFormatSummary(engine: Engine, maxChars: number = FORMAT_SUMMARY_CHARS): string {
  let sections = 0;
  try { sections = engine.sectionCount(); } catch { return ''; }

  // 쪽 모양 — 같은 줄이 이어지는 구역은 묶는다
  const hf = headerFooters(engine);
  const pageRows: Array<{ from: number; to: number; line: string }> = [];
  for (let sec = 0; sec < sections; sec++) {
    const line = pageLine(engine, sec, hf);
    if (!line) continue;
    const last = pageRows[pageRows.length - 1];
    if (last && last.line === line && last.to === sec - 1) last.to = sec;
    else pageRows.push({ from: sec, to: sec, line });
  }

  // 문단 서식 — 본문 문단, 그다음 표 칸 안 문단
  const collector = new ShapeCollector(engine);
  let scanned = 0;
  let cutBody = false;
  outer: for (let sec = 0; sec < sections; sec++) {
    let n = 0;
    try { n = engine.paragraphCount(sec); } catch { n = 0; }
    for (let p = 0; p < n; p++) {
      if (scanned++ >= BODY_PARA_SCAN) { cutBody = true; break outer; }
      collector.paragraph(sec, p);
    }
  }
  let tables: ReturnType<Engine['tables']> = [];
  try { tables = engine.tables(); } catch { tables = []; }
  const cellBudget = { left: CELL_PARA_SCAN };
  const tableLines: string[] = [];
  for (const [i, t] of tables.slice(0, TABLE_ROWS).entries()) {
    const line = tableLine(engine, i + 1, t.sectionIdx, t.paraIdx, t.controlIdx, collector, cellBudget);
    if (line) tableLines.push(line);
  }

  const pageLines: string[] = [];
  if (pageRows.length > 0) {
    pageLines.push('쪽 모양 (mm):');
    for (const r of pageRows) {
      const label = sections > 1 ? `구역 ${r.from + 1}${r.to > r.from ? `-${r.to + 1}` : ''}: ` : '';
      pageLines.push(`- ${label}${r.line}`);
    }
  }
  const samples = (list: string[]) => (list.length ? `, 예: ${list.map((s) => `"${s}"`).join(' / ')}` : '');
  const styleLine = (r: StyleRow) => `- ${r.desc} — ${r.paragraphs}문단 ${r.chars}자${samples(r.samples)}`;
  const bodyRows = [...collector.styles.values()].filter((r) => r.where === 'body');
  const cellRows = [...collector.styles.values()].filter((r) => r.where === 'cell');
  const runRows = [...collector.runs.values()];

  // 목록마다 줄 수 한도 — 글자 수 상한을 넘으면 가장 긴 목록부터 한 줄씩 줄인다 (바닥까지)
  const limit = { body: PARA_STYLE_ROWS, cell: CELL_STYLE_ROWS, run: RUN_STYLE_ROWS, table: TABLE_ROWS };
  const floor = { body: 4, cell: 2, run: 0, table: 3 };
  const render = (): string[] => {
    const out = [...pageLines];
    const body = pick(bodyRows, limit.body);
    if (body.shown.length > 0) {
      out.push('문단 서식 (본문 · 문서 순서 · [스타일] 글자 모양 · 문단 모양):');
      for (const r of body.shown) out.push(styleLine(r));
      if (body.rest > 0) out.push(`- 그 밖에 ${body.rest}가지 (적게 쓰임)`);
    }
    const cells = pick(cellRows, limit.cell);
    if (cells.shown.length > 0) {
      out.push('문단 서식 (표 칸 안):');
      for (const r of cells.shown) out.push(styleLine(r));
      if (cells.rest > 0) out.push(`- 그 밖에 ${cells.rest}가지 (적게 쓰임)`);
    }
    const runs = pick(runRows, limit.run);
    if (runs.shown.length > 0) {
      out.push('부분 글자 모양 (문단 안 일부에만):');
      for (const r of runs.shown) out.push(`- ${r.desc} — ${r.count}곳${samples(r.samples)}`);
      if (runs.rest > 0) out.push(`- 그 밖에 ${runs.rest}가지`);
    }
    const shownTables = tableLines.slice(0, limit.table);
    if (shownTables.length > 0) {
      out.push(`표 ${tables.length}개${tables.length > shownTables.length ? ` (앞 ${shownTables.length}개)` : ''} (mm):`);
      out.push(...shownTables);
    }
    if (cutBody) out.push(`(문단이 많아 앞 ${BODY_PARA_SCAN}개 문단만 살핌)`);
    return out;
  };
  const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
  const keys = ['run', 'cell', 'table', 'body'] as const;
  let lines = render();
  while (size(lines) > maxChars) {
    const open = keys.filter((k) => limit[k] > floor[k]);
    if (open.length === 0) break;
    const most = Math.max(...open.map((k) => limit[k]));
    limit[open.find((k) => limit[k] === most)!]--;
    lines = render();
  }
  if (lines.length === 0) return '';
  // 바닥까지 줄여도 길면 줄 단위로 자르고 알린다
  if (size(lines) > maxChars) {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > maxChars - 40) break;
      kept.push(line);
      used += line.length + 1;
    }
    kept.push(`(… 서식 요약이 길어 ${lines.length - kept.length}줄 생략)`);
    lines = kept;
  }
  return lines.join('\n');
}
