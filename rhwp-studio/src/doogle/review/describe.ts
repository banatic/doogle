/**
 * 검토 행 문구 — 변경 한 건(PendingChangeSet)을 사람이 읽는 줄로 바꾼다.
 *
 *  - 위치는 쪽과 그 문단의 첫머리 글로 부른다: `3쪽 “사업명” 외 5곳`. 문단 번호(¶48)는 쓰지 않는다.
 *  - 묶음(apply_edits)은 종류별로 한 줄씩 낸다: 같은 서식을 여러 곳에 준 것은 한 줄로 합치고,
 *    글 바꾸기는 지운 글/넣은 글을 따로 보인다.
 *  - 색은 코드(#1f4e79) 대신 견본과 이름("파랑")으로 낸다.
 * DOM 없는 순수 함수.
 */
import type { FormatDiff, PendingChangeSet, PendingChangeTarget } from '../agent/types.ts';
import { bareToolName, describeToolCall } from '../ui/tool-presentation.ts';

/** 서식 값 하나. swatch 가 있으면 글자 앞에 색 견본을 그린다. */
export interface Chip {
  text: string;
  swatch?: string;
}

/** 검토 행 안의 한 줄 — 같은 종류의 편집 묶음 */
export interface ChangeLine {
  /** `3쪽 “사업명” 외 5곳` */
  where: string;
  /** 이 줄이 가리키는 자리 수 */
  count: number;
  /** 서식·표 편집처럼 글 diff 가 없는 줄의 종류 이름 ("글자 서식") */
  label: string;
  del: string;
  ins: string;
  /** 펼쳐 볼 때의 전체 글 (기록된 인자 기준 — 아주 긴 글은 실행기가 400자에서 자른다) */
  delFull: string;
  insFull: string;
  chips: Chip[];
  /** 덧붙일 짧은 말 ("모두 바꾸기", "필드 이름") */
  note: string;
}

export interface ChangeView {
  /** 첫 줄의 위치 (aria·거터 툴팁용) */
  location: string;
  /** del/ins 가 있으면 인라인 diff, 없으면 summary (한 줄로 접은 짧은 글) — 첫 줄 기준 */
  del: string;
  ins: string;
  delFull: string;
  insFull: string;
  summary: string;
  /** 서식 변경 속성. 전·후를 알면 "10pt → 12pt" — 첫 줄 기준 */
  chips: Chip[];
  /** 종류별 줄 (적어도 하나) */
  lines: ChangeLine[];
}

type Args = Record<string, unknown>;

/** 한 행에 보일 줄 수 — 넘치면 마지막 줄이 "외 N가지" */
const MAX_LINES = 5;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function flat(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function rec(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
}

function anchorFind(a: Args): string {
  if (typeof a['find'] === 'string') return a['find'];
  if (typeof a['anchor'] === 'string') return a['anchor'];
  return str(rec(a['anchor'])['text']);
}

// ─── 위치 ────────────────────────────────────────────────

const FORMAT_TOOLS = new Set(['apply_char_format', 'apply_para_format']);

/**
 * 변경 자리의 이름. 쪽 + 문단 첫머리 글로 부르고, 둘 다 모를 때만 문단 순서로 물러선다.
 * count 는 같은 줄이 가리키는 자리 수 — 2 이상이면 "외 N곳".
 */
export function locationOf(
  tool: string, target: PendingChangeTarget | undefined, count = 1, page?: number, args: Args = {},
): string {
  const more = count > 1 ? ` 외 ${count - 1}곳` : '';
  const pageNo = typeof target?.page === 'number' ? target.page : page;
  const pg = typeof pageNo === 'number' ? `${pageNo + 1}쪽` : '';
  if (!target) return pg ? `${pg}${more}` : '';
  const sec = target.sectionIdx > 0 ? `${target.sectionIdx + 1}구역` : '';
  if (target.wholeSection) {
    if (tool === 'set_page_layout') return '쪽 설정';
    if (tool === 'edit_header_footer') return '머리말·꼬리말';
    return sec || '문서 전체';
  }
  // 서식은 찾은 글이 곧 바뀐 자리다. 글을 바꾼 편집은 찾은 글이 사라졌으므로 문단 첫머리로 부른다.
  const found = FORMAT_TOOLS.has(tool) ? flat(anchorFind(args), 18) : '';
  const lead = found || str(target.lead);
  const quoted = lead ? `“${lead}”` : '';
  const parts = [pg, sec];
  if (target.table) parts.push('표');
  else if (target.cell) parts.push(quoted ? `표 안 ${quoted}` : '표 칸');
  else parts.push(quoted || (pg ? '' : `${target.paraIdx + 1}번째 문단`));
  return `${parts.filter(Boolean).join(' ')}${more}`;
}

function textDiff(tool: string, a: Args): { del: string; ins: string } | null {
  switch (tool) {
    case 'replace_range': return { del: anchorFind(a), ins: str(a['text']) };
    case 'insert_text': return { del: '', ins: str(a['text']) };
    case 'insert_paragraphs':
      return { del: '', ins: Array.isArray(a['paragraphs']) ? a['paragraphs'].filter((t) => typeof t === 'string').join('\n') : '' };
    case 'delete_range': {
      const find = anchorFind(a);
      return find ? { del: find, ins: '' } : null;
    }
    case 'replace_all': return { del: str(a['query']), ins: str(a['replacement']) };
    case 'set_field_value': return { del: '', ins: str(a['value']) };
    default: return null;
  }
}

// ─── 색 이름 ─────────────────────────────────────────────

const HEX_RE = /^#?([0-9a-f]{6})$/i;

/** `#1f4e79` → "진한 파랑". 색 코드가 아니면 빈 문자열. */
export function colorName(value: string): string {
  const m = HEX_RE.exec(value.trim());
  if (!m) return '';
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l <= 0.08) return '검정';
  if (l >= 0.95) return '흰색';
  if (s < 0.14) return l < 0.35 ? '진한 회색' : l > 0.7 ? '연한 회색' : '회색';
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const base = h < 15 || h >= 345 ? '빨강'
    : h < 42 ? (l < 0.38 ? '갈색' : '주황')
      : h < 68 ? '노랑'
        : h < 165 ? '초록'
          : h < 195 ? '청록'
            : h < 255 ? '파랑'
              : h < 290 ? '보라'
                : '분홍';
  if (base === '갈색') return base;
  return l < 0.32 ? `진한 ${base}` : l > 0.75 ? `연한 ${base}` : base;
}

function swatchOf(value: string): string {
  const m = HEX_RE.exec(value.trim());
  return m ? `#${m[1].toLowerCase()}` : '';
}

function colorChip(value: string, label = ''): Chip {
  const swatch = swatchOf(value);
  const name = colorName(value) || value;
  return { text: label ? `${label} ${name}` : name, ...(swatch ? { swatch } : {}) };
}

// ─── 서식 값 ─────────────────────────────────────────────

const ALIGN: Record<string, string> = {
  left: '왼쪽', center: '가운데', right: '오른쪽', justify: '양쪽', distribute: '배분', split: '나눔',
};
const FLAG: Record<string, string> = { bold: '굵게', italic: '기울임', underline: '밑줄', strikethrough: '취소선' };

function pt(hu: unknown): string | null {
  const n = num(hu);
  return n === null ? null : `${Math.round(n) / 100}pt`;
}

/** 엔진 문단 여백(px, 96dpi) → pt */
function pxPt(px: unknown): string | null {
  const n = num(px);
  return n === null ? null : `${Math.round(n * 0.75 * 10) / 10}pt`;
}

function arrow(before: string | null, after: string | null, label = ''): string {
  const lead = label ? `${label} ` : '';
  if (before !== null && after !== null && before !== after) return `${lead}${before} → ${after}`;
  return after !== null ? `${lead}${after}` : '';
}

function lineSpacing(v: Args): string | null {
  const n = num(v['lineSpacing']);
  if (n === null) return null;
  const type = str(v['lineSpacingType']);
  return !type || type === 'Percent' ? `${n}%` : `${Math.round(n) / 100}pt`;
}

function firstOf(value: unknown): string | null {
  const n = Array.isArray(value) ? num(value[0]) : num(value);
  return n === null ? null : `${n}%`;
}

/** 엔진 단위 전·후 스냅샷 하나 → 서식 값 목록 */
export function formatChipList(diff: FormatDiff): Chip[] {
  const { before: b, after: a } = diff;
  const out: Chip[] = [];
  const push = (text: string) => { if (text) out.push({ text }); };
  const keys = new Set(diff.keys);
  for (const [key, label] of Object.entries(FLAG)) {
    if (!keys.has(key)) continue;
    push(a[key] === false ? `${label} 해제` : label);
  }
  if (keys.has('fontSize')) push(arrow(pt(b['fontSize']), pt(a['fontSize'])));
  if (keys.has('fontId')) push(arrow(str(b['fontFamily']) || null, str(a['fontFamily']) || null, '글꼴') || '글꼴');
  if (keys.has('textColor')) out.push(str(a['textColor']) ? colorChip(str(a['textColor'])) : { text: '글자색' });
  if (keys.has('ratios')) push(arrow(firstOf(b['ratios']), firstOf(a['ratios']), '장평'));
  if (keys.has('spacings')) push(arrow(firstOf(b['spacings']), firstOf(a['spacings']), '자간'));
  if (keys.has('alignment')) push(arrow(ALIGN[str(b['alignment'])] ?? null, ALIGN[str(a['alignment'])] ?? (str(a['alignment']) || null)));
  if (keys.has('lineSpacing')) push(arrow(lineSpacing(b), lineSpacing(a), '줄간격'));
  if (keys.has('indent')) push(arrow(pxPt(b['indent']), pxPt(a['indent']), '들여쓰기'));
  if (keys.has('marginLeft')) push(arrow(pxPt(b['marginLeft']), pxPt(a['marginLeft']), '왼쪽 여백'));
  if (keys.has('marginRight')) push(arrow(pxPt(b['marginRight']), pxPt(a['marginRight']), '오른쪽 여백'));
  if (keys.has('spacingBefore')) push(arrow(pxPt(b['spacingBefore']), pxPt(a['spacingBefore']), '문단 위'));
  if (keys.has('spacingAfter')) push(arrow(pxPt(b['spacingAfter']), pxPt(a['spacingAfter']), '문단 아래'));
  if (keys.has('pageBreakBefore')) push(a['pageBreakBefore'] === false ? '앞 쪽 나눔 해제' : '앞에서 쪽 나눔');
  if (keys.has('headType')) push('문단 번호·글머리표');
  if (keys.has('tabStops')) push('탭');
  if ([...keys].some((k) => k.startsWith('border'))) push('테두리');
  return out;
}

/** 글자만 필요한 곳(테스트·aria)용 */
export function formatChips(diff: FormatDiff): string[] {
  return formatChipList(diff).map((chip) => chip.text);
}

/** 인자만으로 만든 서식 값 (스냅샷이 없을 때) */
function argChips(tool: string, a: Args): Chip[] {
  const out: Chip[] = [];
  const push = (text: string) => out.push({ text });
  if (tool === 'apply_char_format') {
    for (const [key, label] of Object.entries(FLAG)) {
      if (a[key] === true) push(label);
      else if (a[key] === false) push(`${label} 해제`);
    }
    const size = num(a['fontSizePt']);
    if (size !== null) push(`${size}pt`);
    if (str(a['fontFamily'])) push(str(a['fontFamily']));
    if (str(a['textColor'])) out.push(colorChip(str(a['textColor'])));
    const w = num(a['widthPercent']);
    if (w !== null) push(`장평 ${w}%`);
    const s = num(a['letterSpacingPercent']);
    if (s !== null) push(`자간 ${s}%`);
  } else if (tool === 'apply_para_format') {
    if (ALIGN[str(a['alignment'])]) push(ALIGN[str(a['alignment'])]);
    const pct = num(a['lineSpacingPercent']);
    const lpt = num(a['lineSpacingPt']);
    if (pct !== null) push(`줄간격 ${pct}%`);
    else if (lpt !== null) push(`줄간격 ${lpt}pt`);
    const indent = num(a['indentPt']);
    if (indent !== null) push(indent < 0 ? `내어쓰기 ${-indent}pt` : `들여쓰기 ${indent}pt`);
    const before = num(a['spaceBeforePt']);
    if (before !== null) push(`문단 위 ${before}pt`);
    const after = num(a['spaceAfterPt']);
    if (after !== null) push(`문단 아래 ${after}pt`);
    if (a['pageBreakBefore'] === true) push('앞에서 쪽 나눔');
  }
  return out;
}

function chipsFor(tool: string, a: Args, formats: FormatDiff[]): Chip[] {
  if (formats.length > 0) {
    const chips = formatChipList(formats[0]);
    if (chips.length > 0) return chips;
  }
  return argChips(tool, a);
}

// ─── 줄 만들기 ───────────────────────────────────────────

function places(targets: PendingChangeTarget[]): number {
  if (targets.length === 0) return 1;
  return new Set(targets.map((t) => `${t.sectionIdx}:${t.table ? `t${t.table.paraIdx}.${t.table.controlIdx}` : `${t.cell ? `c${t.cell.paraIdx}.${t.cell.controlIdx}.${t.cell.cellIdx}:` : ''}${t.paraIdx}`}`)).size;
}

/** 편집 한 건(도구 하나) → 줄 하나 */
function lineOf(tool: string, args: Args, targets: PendingChangeTarget[], formats: FormatDiff[], page?: number): ChangeLine {
  const count = places(targets);
  const where = locationOf(tool, targets[0], count, page, args);
  const base: ChangeLine = { where, count, label: '', del: '', ins: '', delFull: '', insFull: '', chips: [], note: '' };
  const diff = textDiff(tool, args);
  if (diff && (diff.del || diff.ins)) {
    const note = tool === 'replace_all' ? '모두 바꾸기' : tool === 'set_field_value' ? `필드 ${str(args['name'])}` : '';
    return { ...base, del: flat(diff.del), ins: flat(diff.ins), delFull: diff.del, insFull: diff.ins, note };
  }
  const view = describeToolCall(tool, args);
  if (FORMAT_TOOLS.has(tool)) {
    const chips = chipsFor(tool, args, formats);
    if (chips.length > 0) return { ...base, label: view.label, chips };
  }
  // 위치는 where 가 말한다 — 도구 요약(문단 번호가 든 말)은 위치를 모를 때만 붙인다
  return { ...base, label: where || !view.summary ? view.label : `${view.label} · ${view.summary}` };
}

function mergeKey(line: ChangeLine): string {
  return [line.label, line.del, line.ins, line.note, line.chips.map((c) => `${c.swatch ?? ''}${c.text}`).join('|')].join('\u0001');
}

/** 같은 종류의 줄을 합친다 — 자리 수를 더하고 위치는 첫 줄 것을 쓴다 */
function mergeLines(lines: Array<{ line: ChangeLine; tool: string; args: Args; targets: PendingChangeTarget[] }>, page?: number): ChangeLine[] {
  const groups = new Map<string, { line: ChangeLine; tool: string; args: Args; first: PendingChangeTarget | undefined; count: number }>();
  for (const entry of lines) {
    const key = mergeKey(entry.line);
    const group = groups.get(key);
    if (group) group.count += entry.line.count;
    else groups.set(key, { line: entry.line, tool: entry.tool, args: entry.args, first: entry.targets[0], count: entry.line.count });
  }
  return [...groups.values()].map((g) => g.count === g.line.count
    ? g.line
    : { ...g.line, count: g.count, where: locationOf(g.tool, g.first, g.count, page, g.args) });
}

function capLines(lines: ChangeLine[]): ChangeLine[] {
  if (lines.length <= MAX_LINES) return lines;
  const rest = lines.length - (MAX_LINES - 1);
  return [
    ...lines.slice(0, MAX_LINES - 1),
    { where: '', count: 0, label: `그 밖에 ${rest}가지 변경`, del: '', ins: '', delFull: '', insFull: '', chips: [], note: '' },
  ];
}

/**
 * 변경 하나의 한 항목만 — 문서 위 강조에 마우스를 올렸을 때 그 자리의 전·후를 보인다.
 * 묶음 편집(apply_edits)은 item 번호의 항목, 아니면 변경 전체를 한 줄로.
 */
export function describeItem(change: PendingChangeSet, item?: number): ChangeLine {
  const tool = bareToolName(change.tool);
  const args = change.args ?? {};
  const targets = change.targets ?? [];
  const formats = change.formats ?? [];
  const page = change.pages[0];
  if (tool === 'apply_edits' && Array.isArray(args['edits']) && typeof item === 'number') {
    const edit = rec(args['edits'][item]);
    const itemTool = str(edit['tool']);
    if (itemTool) {
      return lineOf(itemTool, edit, targets.filter((t) => t.item === item), formats.filter((f) => f.item === item), page);
    }
  }
  return describeChange(change).lines[0];
}

export function describeChange(change: PendingChangeSet): ChangeView {
  const tool = bareToolName(change.tool);
  const args = change.args ?? {};
  const targets = change.targets ?? [];
  const formats = change.formats ?? [];
  const page = change.pages[0];
  let lines: ChangeLine[];

  if (tool === 'apply_edits' && Array.isArray(args['edits'])) {
    const edits = args['edits'].map(rec);
    const tagged = targets.some((t) => typeof t.item === 'number');
    const formatTagged = formats.some((f) => typeof f.item === 'number');
    const formatEdits = edits.filter((e) => FORMAT_TOOLS.has(str(e['tool']))).length;
    const raw = edits.map((edit, index) => {
      const itemTool = str(edit['tool']);
      // 옛 기록(항목 번호 없음)은 항목 수와 자리 수가 같을 때만 순서로 짝짓는다
      const itemTargets = tagged ? targets.filter((t) => t.item === index)
        : targets.length === edits.length ? [targets[index]] : index === 0 ? targets.slice(0, 1) : [];
      const itemFormats = formatTagged ? formats.filter((f) => f.item === index)
        : formatEdits === 1 && FORMAT_TOOLS.has(itemTool) ? formats : [];
      return { line: lineOf(itemTool, edit, itemTargets, itemFormats, page), tool: itemTool, args: edit, targets: itemTargets };
    });
    lines = capLines(mergeLines(raw, page));
  } else {
    lines = [lineOf(tool, args, targets, formats, page)];
  }
  if (lines.length === 0) {
    lines = [{ where: '', count: 1, label: describeToolCall(tool, args).label, del: '', ins: '', delFull: '', insFull: '', chips: [], note: '' }];
  }

  const first = lines[0];
  const more = lines.length > 1 ? `외 ${lines.length - 1}가지` : '';
  const summary = first.del || first.ins
    ? [first.note, more].filter(Boolean).join(' ')
    : [first.label, more].filter(Boolean).join(' ');
  return {
    location: first.where || '변경',
    del: first.del,
    ins: first.ins,
    delFull: first.delFull,
    insFull: first.insFull,
    summary,
    chips: first.chips,
    lines,
  };
}
