/**
 * 검토 행 문구 — 변경 한 건(PendingChangeSet)을 위치 이름("2쪽 ¶4", "표", "쪽 설정")과
 * 지운 글/넣은 글, 서식 속성 칩(굵게 · 10pt → 12pt · 왼쪽 → 양쪽) 또는 짧은 요약으로 바꾼다.
 * DOM 없는 순수 함수.
 */
import type { FormatDiff, PendingChangeSet, PendingChangeTarget } from '../agent/types.ts';
import { bareToolName, describeToolCall } from '../ui/tool-presentation.ts';

export interface ChangeView {
  location: string;
  /** del/ins 가 있으면 인라인 diff, 없으면 summary (한 줄로 접은 짧은 글) */
  del: string;
  ins: string;
  /** 펼쳐 볼 때의 전체 글 (기록된 인자 기준 — 아주 긴 글은 실행기가 400자에서 자른다) */
  delFull: string;
  insFull: string;
  summary: string;
  /** 서식 변경 속성 칩. 전·후를 알면 "10pt → 12pt" */
  chips: string[];
}

type Args = Record<string, unknown>;

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

export function locationOf(tool: string, target: PendingChangeTarget | undefined, count = 1, page?: number): string {
  if (!target) return typeof page === 'number' ? `${page + 1}쪽` : '';
  const sec = target.sectionIdx > 0 ? `${target.sectionIdx + 1}구역 ` : '';
  const pg = typeof page === 'number' ? `${page + 1}쪽 ` : '';
  if (target.wholeSection) {
    if (tool === 'set_page_layout') return '쪽 설정';
    if (tool === 'edit_header_footer') return '머리말';
    return `${sec}구역`.trim();
  }
  if (target.table) return `${pg}${sec}표`.trim();
  if (target.cell) return `${pg}${sec}표 칸`.trim();
  const base = `${pg}${sec}¶${target.paraIdx + 1}`;
  return count > 1 ? `${base} 외` : base;
}

function textDiff(tool: string, a: Args): { del: string; ins: string } | null {
  switch (tool) {
    case 'replace_range': return { del: anchorFind(a), ins: str(a['text']) };
    case 'insert_text': return { del: '', ins: str(a['text']) };
    case 'delete_range': {
      const find = anchorFind(a);
      return find ? { del: find, ins: '' } : null;
    }
    case 'replace_all': return { del: str(a['query']), ins: str(a['replacement']) };
    case 'set_field_value': return { del: '', ins: str(a['value']) };
    default: return null;
  }
}

// ─── 서식 칩 ─────────────────────────────────────────────

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

/** 엔진 단위 전·후 스냅샷 하나 → 칩 */
export function formatChips(diff: FormatDiff): string[] {
  const { before: b, after: a } = diff;
  const out: string[] = [];
  const keys = new Set(diff.keys);
  for (const [key, label] of Object.entries(FLAG)) {
    if (!keys.has(key)) continue;
    out.push(a[key] === false ? `${label} 해제` : label);
  }
  if (keys.has('fontSize')) out.push(arrow(pt(b['fontSize']), pt(a['fontSize'])));
  if (keys.has('fontId')) out.push(arrow(str(b['fontFamily']) || null, str(a['fontFamily']) || null, '글꼴') || '글꼴');
  if (keys.has('textColor')) out.push(arrow(str(b['textColor']) || null, str(a['textColor']) || null, '글자색') || '글자색');
  if (keys.has('ratios')) out.push(arrow(firstOf(b['ratios']), firstOf(a['ratios']), '장평'));
  if (keys.has('spacings')) out.push(arrow(firstOf(b['spacings']), firstOf(a['spacings']), '자간'));
  if (keys.has('alignment')) out.push(arrow(ALIGN[str(b['alignment'])] ?? null, ALIGN[str(a['alignment'])] ?? (str(a['alignment']) || null)));
  if (keys.has('lineSpacing')) out.push(arrow(lineSpacing(b), lineSpacing(a), '줄간격'));
  if (keys.has('indent')) out.push(arrow(pxPt(b['indent']), pxPt(a['indent']), '들여쓰기'));
  if (keys.has('marginLeft')) out.push(arrow(pxPt(b['marginLeft']), pxPt(a['marginLeft']), '왼쪽 여백'));
  if (keys.has('marginRight')) out.push(arrow(pxPt(b['marginRight']), pxPt(a['marginRight']), '오른쪽 여백'));
  if (keys.has('spacingBefore')) out.push(arrow(pxPt(b['spacingBefore']), pxPt(a['spacingBefore']), '문단 위'));
  if (keys.has('spacingAfter')) out.push(arrow(pxPt(b['spacingAfter']), pxPt(a['spacingAfter']), '문단 아래'));
  if (keys.has('pageBreakBefore')) out.push(a['pageBreakBefore'] === false ? '앞 쪽 나눔 해제' : '앞에서 쪽 나눔');
  if (keys.has('headType')) out.push('문단 번호·글머리표');
  if (keys.has('tabStops')) out.push('탭');
  if ([...keys].some((k) => k.startsWith('border'))) out.push('테두리');
  return out.filter(Boolean);
}

function firstOf(value: unknown): string | null {
  const n = Array.isArray(value) ? num(value[0]) : num(value);
  return n === null ? null : `${n}%`;
}

/** 인자만으로 만든 칩 (스냅샷이 없을 때) */
function argChips(tool: string, a: Args): string[] {
  const out: string[] = [];
  if (tool === 'apply_char_format') {
    for (const [key, label] of Object.entries(FLAG)) {
      if (a[key] === true) out.push(label);
      else if (a[key] === false) out.push(`${label} 해제`);
    }
    const size = num(a['fontSizePt']);
    if (size !== null) out.push(`${size}pt`);
    if (str(a['fontFamily'])) out.push(str(a['fontFamily']));
    if (str(a['textColor'])) out.push(`글자색 ${str(a['textColor'])}`);
    const w = num(a['widthPercent']);
    if (w !== null) out.push(`장평 ${w}%`);
    const s = num(a['letterSpacingPercent']);
    if (s !== null) out.push(`자간 ${s}%`);
  } else if (tool === 'apply_para_format') {
    if (ALIGN[str(a['alignment'])]) out.push(ALIGN[str(a['alignment'])]);
    const pct = num(a['lineSpacingPercent']);
    const lpt = num(a['lineSpacingPt']);
    if (pct !== null) out.push(`줄간격 ${pct}%`);
    else if (lpt !== null) out.push(`줄간격 ${lpt}pt`);
    const indent = num(a['indentPt']);
    if (indent !== null) out.push(indent < 0 ? `내어쓰기 ${-indent}pt` : `들여쓰기 ${indent}pt`);
    const before = num(a['spaceBeforePt']);
    if (before !== null) out.push(`문단 위 ${before}pt`);
    const after = num(a['spaceAfterPt']);
    if (after !== null) out.push(`문단 아래 ${after}pt`);
    if (a['pageBreakBefore'] === true) out.push('앞에서 쪽 나눔');
  }
  return out;
}

const FORMAT_TOOLS = new Set(['apply_char_format', 'apply_para_format']);

function chipsFor(tool: string, a: Args, formats: FormatDiff[] | undefined): string[] {
  if (formats && formats.length > 0) {
    const chips = formatChips(formats[0]);
    if (chips.length > 0) return formats.length > 1 ? [...chips, `외 ${formats.length - 1}곳`] : chips;
  }
  return argChips(tool, a);
}

export function describeChange(change: PendingChangeSet): ChangeView {
  const tool = bareToolName(change.tool);
  const args = change.args ?? {};
  const targets = change.targets ?? [];
  const paras = new Set(targets.map((t) => `${t.sectionIdx}:${t.paraIdx}:${t.cell?.cellIdx ?? ''}`));
  const location = locationOf(tool, targets[0], paras.size, change.pages[0]) || '변경';
  const empty = { location, del: '', ins: '', delFull: '', insFull: '', summary: '', chips: [] as string[] };

  if (tool === 'apply_edits' && Array.isArray(args['edits'])) {
    const edits = args['edits'].map(rec);
    const first = edits[0] ?? {};
    const firstTool = str(first['tool']);
    const diff = textDiff(firstTool, first);
    const more = edits.length > 1 ? `외 ${edits.length - 1}곳` : '';
    if (diff && (diff.del || diff.ins)) {
      return { ...empty, del: flat(diff.del), ins: flat(diff.ins), delFull: diff.del, insFull: diff.ins, summary: more };
    }
    const view = describeToolCall(firstTool, first);
    if (FORMAT_TOOLS.has(firstTool)) {
      const chips = chipsFor(firstTool, first, change.formats);
      if (chips.length > 0) return { ...empty, summary: view.label, chips: more ? [...chips, more] : chips };
    }
    return { ...empty, summary: `${view.label}${view.summary ? ` · ${view.summary}` : ''}${more ? ` ${more}` : ''}` };
  }

  const diff = textDiff(tool, args);
  if (diff && (diff.del || diff.ins)) {
    const summary = tool === 'replace_all' ? '모두 바꾸기' : tool === 'set_field_value' ? `필드 ${str(args['name'])}` : '';
    return { ...empty, del: flat(diff.del), ins: flat(diff.ins), delFull: diff.del, insFull: diff.ins, summary };
  }
  const view = describeToolCall(tool, args);
  if (FORMAT_TOOLS.has(tool)) {
    const chips = chipsFor(tool, args, change.formats);
    if (chips.length > 0) return { ...empty, summary: view.label, chips };
  }
  return { ...empty, summary: view.summary ? `${view.label} · ${view.summary}` : view.label };
}
