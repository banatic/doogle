// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/ui/agent-sidebar/tool-presentation.ts (v1 tool subset)
/**
 * 사이드바 도구 칩 표시 — 도구 이름·인자를 사람이 읽는 짧은 한국어 문구로 바꾼다.
 *
 * DOM 없이 순수 함수만 둔다. 좌표는 도구 계약대로 0 기반으로 받아 사람에게는 1 기반(“3문단”, “2쪽”)으로 보인다.
 * 모르는 도구는 원래 이름으로 떨어진다. MCP 접두어(`mcp__doogle__`)는 뗀다.
 */

export type ToolCategory = 'edit' | 'read' | 'check' | 'other';

export interface ToolCallView {
  name: string;
  known: boolean;
  category: ToolCategory;
  label: string;
  summary: string;
  /** 묶음 편집(apply_edits)·묶음 읽기(read_batch)의 하위 항목 — 무엇을 하려는지 한 줄씩 */
  items?: Array<{ label: string; summary: string }>;
}

type Args = Record<string, unknown>;

interface ToolSpec {
  category: ToolCategory;
  label: string | ((a: Args) => string);
  summary?: (a: Args) => string;
}

function rec(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function quote(text: string, max = 24): string {
  const flat = clip(text, max);
  return flat ? `“${flat}”` : '';
}

function join(parts: Array<string | null | undefined | false>, sep = ' · '): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(sep);
}

function firstParts(parts: string[], n: number): string {
  return join(parts.filter(Boolean).slice(0, n));
}

function inCell(a: Args): boolean {
  return (a['cell'] !== undefined && a['cell'] !== null)
    || (Array.isArray(a['cellPath']) && a['cellPath'].length > 0);
}

function sectionPrefix(a: Args): string {
  const section = num(a['sectionIdx']);
  return section !== null && section > 0 ? `${section + 1}구역` : '';
}

/** “3문단”, 다른 구역이면 “2구역 3문단”, 셀 안이면 “표 안 3문단”. */
function para(a: Args, key = 'paraIdx'): string {
  const p = num(a[key]);
  if (p === null) return '';
  return join([sectionPrefix(a), inCell(a) ? '표 안' : '', `${p + 1}문단`], ' ');
}

function paraRange(a: Args, startKey: string, endKey: string): string {
  const start = num(a[startKey]);
  const end = num(a[endKey]);
  if (start === null) return '';
  if (end === null || end === start) return para({ ...a, paraIdx: start });
  return join([sectionPrefix(a), inCell(a) ? '표 안' : '', `${start + 1}–${end + 1}문단`], ' ');
}

/** paras 대상 — 구간 하나면 “3–5문단”, 여럿이면 겹침을 합쳐 센 “문단 12개”. */
function paras(a: Args): string {
  const list = a['paras'];
  if (!Array.isArray(list) || list.length === 0) return '';
  const spans: Array<[number, number]> = [];
  for (const entry of list) {
    const first = num(Array.isArray(entry) ? entry[0] : entry);
    const last = num(Array.isArray(entry) ? entry[1] : entry);
    if (first === null || last === null || last < first) return '';
    spans.push([first, last]);
  }
  if (spans.length === 1) return paraRange({ ...a, first: spans[0][0], last: spans[0][1] }, 'first', 'last');
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let covered = -1;
  for (const [first, last] of spans) {
    if (last <= covered) continue;
    total += last - Math.max(first, covered + 1) + 1;
    covered = last;
  }
  return join([sectionPrefix(a), inCell(a) ? '표 안' : '', `문단 ${total}개`], ' ');
}

function anchorText(a: Args, withPosition: boolean): string {
  const anchor = typeof a['find'] === 'string' ? { text: a['find'] }
    : typeof a['anchor'] === 'string' ? { text: a['anchor'] } : rec(a['anchor']);
  const text = str(anchor['text']);
  if (!text) return '';
  const occurrence = num(anchor['occurrence'] ?? a['occurrence']);
  const position = str(anchor['position'] ?? a['position']);
  const where = withPosition
    ? position === 'before' ? ' 앞' : position === 'replace' ? ' 자리' : ' 뒤'
    : '';
  return `${quote(text)}${where}${occurrence !== null && occurrence > 1 ? ` (${occurrence}번째)` : ''}`;
}

function target(a: Args, withPosition = false): string {
  return anchorText(a, withPosition) || paras(a) || para(a);
}

function table(a: Args): string {
  const p = num(a['paraIdx']);
  if (p === null) return '';
  return `${sectionPrefix(a) ? `${sectionPrefix(a)} ` : ''}${p + 1}문단 표`;
}

function page(a: Args, key = 'pageIndex'): string {
  const p = num(a[key]);
  return p === null ? '' : `${p + 1}쪽`;
}

function cellAt(row: unknown, col: unknown): string {
  const r = num(row);
  const c = num(col);
  return r === null || c === null ? '' : `(${r + 1},${c + 1})`;
}

function mm(value: unknown): string {
  const n = num(value);
  return n === null ? '' : `${Math.round(n * 10) / 10}`;
}

function size(a: Args): string {
  const w = mm(a['widthMm']);
  const h = mm(a['heightMm']);
  return w && h ? `${w}×${h}mm` : w ? `너비 ${w}mm` : h ? `높이 ${h}mm` : '';
}

const ALIGN: Record<string, string> = {
  left: '왼쪽 정렬', right: '오른쪽 정렬', center: '가운데 정렬',
  justify: '양쪽 정렬', distribute: '배분 정렬', split: '나눔 정렬',
};

function charProps(a: Args): string {
  const flag = (key: string, on: string) => a[key] === true ? on : a[key] === false ? `${on} 해제` : '';
  const sizePt = num(a['fontSizePt']);
  const width = num(a['widthPercent']);
  const spacing = num(a['letterSpacingPercent']);
  return firstParts([
    flag('bold', '굵게'),
    flag('italic', '기울임'),
    flag('underline', '밑줄'),
    flag('strikethrough', '취소선'),
    sizePt !== null ? `${sizePt}pt` : '',
    str(a['fontFamily']),
    str(a['textColor']),
    width !== null ? `장평 ${width}%` : '',
    spacing !== null ? `자간 ${spacing}%` : '',
  ], 3);
}

function paraProps(a: Args): string {
  const pct = num(a['lineSpacingPercent']);
  const pt = num(a['lineSpacingPt']);
  const before = num(a['spaceBeforePt']);
  const after = num(a['spaceAfterPt']);
  const indent = num(a['indentPt']);
  return firstParts([
    ALIGN[str(a['alignment'])] ?? '',
    pct !== null ? `줄 간격 ${pct}%` : pt !== null ? `줄 간격 ${pt}pt` : '',
    before !== null ? `문단 위 ${before}pt` : '',
    after !== null ? `문단 아래 ${after}pt` : '',
    indent !== null ? indent < 0 ? `내어쓰기 ${-indent}pt` : `들여쓰기 ${indent}pt` : '',
    a['pageBreakBefore'] === true ? '앞에서 쪽 나눔' : '',
    Array.isArray(a['tabStops']) ? `탭 ${a['tabStops'].length}개` : '',
    a['borders'] !== undefined ? '테두리' : '',
  ], 3);
}

const EDIT_TABLE_OPS: Record<string, string> = {
  insert_row: '행 추가', insert_col: '열 추가', delete_row: '행 삭제', delete_col: '열 삭제',
  merge_cells: '셀 합치기', split_cell: '셀 나누기', set_column_widths: '열 너비 변경',
  fit_to_page: '표 폭 맞춤', apply_formula: '계산식 넣기', set_caption: '표 캡션',
};

const HF_SCOPE: Record<string, string> = { both: '모든 쪽', all: '모든 쪽', odd: '홀수 쪽', even: '짝수 쪽' };

const SHAPE_KINDS: Record<string, string> = {
  line: '선 그리기', rectangle: '사각형 삽입', rect: '사각형 삽입', ellipse: '타원 삽입',
  textBox: '글상자 삽입', textbox: '글상자 삽입',
};

function objectAction(a: Args): string {
  const op = str(a['op']);
  if (op === 'delete' || a['delete'] === true) return '삭제';
  if (op === 'zOrder' || a['zOrder'] !== undefined) return '순서 변경';
  if (op === 'crop' || a['crop'] !== undefined || a['cropMm'] !== undefined) return '자르기';
  if (op === 'resize' || ((a['widthMm'] !== undefined || a['heightMm'] !== undefined) && a['xMm'] === undefined && a['yMm'] === undefined)) return '크기 조정';
  if (op === 'move' || a['xMm'] !== undefined || a['yMm'] !== undefined) return '이동';
  return '속성 변경';
}

const SPECS: Record<string, ToolSpec> = {
  // 읽기
  get_structure: {
    category: 'read', label: '문서 구조 읽기',
    summary: (a) => {
      const range = rec(a['range']);
      const since = num(a['sinceRevision']);
      if (num(range['fromPara']) !== null) return paraRange({ ...range }, 'fromPara', 'toPara');
      return since !== null ? `r${since} 이후 변경` : '';
    },
  },
  get_outline: { category: 'read', label: '개요 읽기' },
  get_text_range: {
    category: 'read', label: '텍스트 읽기',
    summary: (a) => join([para(a), num(a['count']) !== null ? `${num(a['count'])}자` : '']),
  },
  get_selection: { category: 'read', label: '선택 영역 읽기' },
  find_text: { category: 'read', label: '텍스트 찾기', summary: (a) => quote(str(a['query'])) },
  get_document_info: { category: 'read', label: '문서 정보 읽기' },
  get_fields: { category: 'read', label: '필드 목록 읽기' },
  get_para_format: { category: 'read', label: '문단 서식 읽기', summary: (a) => para(a) },
  get_char_format: { category: 'read', label: '글자 서식 읽기', summary: (a) => para(a) },
  get_table_properties: { category: 'read', label: '표 속성 읽기', summary: (a) => table(a) },
  get_table_layout: { category: 'read', label: '표 배치 읽기', summary: (a) => table(a) },
  list_styles: { category: 'read', label: '스타일 목록 읽기' },
  list_numberings: { category: 'read', label: '번호 목록 읽기' },
  list_footnotes: { category: 'read', label: '각주 목록 읽기' },
  list_bookmarks: { category: 'read', label: '책갈피 목록 읽기' },
  get_page_geometry: { category: 'read', label: '쪽 배치 읽기', summary: (a) => join([page(a), a['regionMm'] ? '일부' : '']) },
  get_engine_edit_capabilities: { category: 'read', label: '엔진 기능 찾기', summary: (a) => quote(str(a['query'])) },
  read_batch: {
    category: 'read',
    label: (a) => `${Array.isArray(a['reads']) ? a['reads'].length : 0}개 읽기`,
  },

  // 확인
  render_page: { category: 'check', label: '쪽 그림 보기', summary: (a) => join([page(a), a['regionMm'] ? '일부' : '']) },
  verify_changes: { category: 'check', label: '변경 확인', summary: (a) => a['includeImage'] === true ? '그림 포함' : '' },
  preview_equation: { category: 'check', label: '수식 미리보기', summary: (a) => quote(str(a['script']), 32) },

  // 편집
  apply_edits: {
    category: 'edit',
    label: (a) => `${Array.isArray(a['edits']) ? a['edits'].length : 0}곳 편집`,
  },
  insert_text: {
    category: 'edit', label: '텍스트 삽입',
    summary: (a) => join([target(a, true), quote(str(a['text']))]),
  },
  delete_range: {
    category: 'edit', label: '텍스트 삭제',
    summary: (a) => anchorText(a, false) || paraRange(a, 'startParaIdx', 'endParaIdx'),
  },
  replace_range: {
    category: 'edit', label: '텍스트 바꾸기',
    summary: (a) => `${anchorText(a, false) || paraRange(a, 'startParaIdx', 'endParaIdx')} → ${quote(str(a['text'])) || '빈 텍스트'}`,
  },
  replace_all: {
    category: 'edit', label: '모두 바꾸기',
    summary: (a) => `${quote(str(a['query']))} → ${quote(str(a['replacement'])) || '빈 텍스트'}`,
  },
  apply_char_format: { category: 'edit', label: '글자 서식', summary: (a) => join([target(a), charProps(a)]) },
  apply_para_format: { category: 'edit', label: '문단 서식', summary: (a) => join([target(a), paraProps(a)]) },
  apply_style: {
    category: 'edit', label: '스타일 적용',
    summary: (a) => join([paras(a) || para(a), a['styleId'] !== undefined ? `스타일 ${String(a['styleId'])}` : '']),
  },
  apply_list: {
    category: 'edit',
    label: (a) => str(a['bulletChar']) ? '글머리표 적용' : '번호 목록 적용',
    summary: (a) => join([paraRange(a, 'startParaIdx', 'endParaIdx'), str(a['bulletChar']) || str(a['format'])]),
  },
  create_table: {
    category: 'edit', label: '표 만들기',
    summary: (a) => {
      const cells = Array.isArray(a['cells']) ? a['cells'] : null;
      const rows = num(a['rows']) ?? cells?.length ?? null;
      const cols = num(a['cols']) ?? (cells && Array.isArray(cells[0]) ? cells[0].length : null);
      return join([para(a), rows !== null && cols !== null ? `${rows}×${cols}` : '']);
    },
  },
  edit_table: {
    category: 'edit',
    label: (a) => EDIT_TABLE_OPS[str(a['op'])] ?? '표 편집',
    summary: (a) => {
      const row = num(a['rowIdx']);
      const col = num(a['colIdx']);
      return join([
        table(a),
        row !== null ? `${row + 1}행` : '',
        col !== null ? `${col + 1}열` : '',
        str(a['op']) === 'merge_cells' ? `${cellAt(a['startRow'], a['startCol'])}–${cellAt(a['endRow'], a['endCol'])}` : '',
      ]);
    },
  },
  insert_paragraphs: {
    category: 'edit', label: '문단 삽입',
    summary: (a) => join([para(a), Array.isArray(a['paragraphs']) ? quote(str(a['paragraphs'].find((t: unknown) => typeof t === 'string' && t) ?? ''), 32) : '']),
  },
  delete_paragraphs: { category: 'edit', label: '문단 삭제', summary: (a) => paraRange(a, 'startParaIdx', 'endParaIdx') },
  move_paragraphs: {
    category: 'edit', label: '문단 이동',
    summary: (a) => join([paraRange(a, 'startParaIdx', 'endParaIdx'), num(a['toParaIdx']) !== null ? `→ ${para(a, 'toParaIdx')}` : '']),
  },
  set_table_props: { category: 'edit', label: '표 속성 변경', summary: (a) => table(a) },
  set_cell_props: { category: 'edit', label: '셀 속성 변경', summary: (a) => table(a) },
  set_zone_borders: { category: 'edit', label: '셀 테두리 변경', summary: (a) => table(a) },
  delete_table: { category: 'edit', label: '표 삭제', summary: (a) => table(a) },
  set_field_value: {
    category: 'edit', label: '필드 값 입력',
    summary: (a) => `${str(a['name'])} = ${quote(str(a['value'])) || '빈 값'}`,
  },
  insert_page_break: { category: 'edit', label: '쪽 나누기', summary: (a) => para(a) },
  set_page_layout: {
    category: 'edit', label: '쪽 설정 변경',
    summary: (a) => join([
      str(a['paper']),
      a['landscape'] === true ? '가로' : a['landscape'] === false ? '세로' : '',
      a['marginsMm'] !== undefined ? '여백' : '',
      a['columns'] !== undefined ? '단' : '',
    ]),
  },
  edit_header_footer: {
    category: 'edit',
    label: (a) => str(a['which']) === 'footer' ? '꼬리말 편집' : str(a['which']) === 'both' ? '머리말·꼬리말 편집' : '머리말 편집',
    summary: (a) => join([HF_SCOPE[str(a['applyTo'])] ?? '', a['pageNumber'] !== undefined ? '쪽 번호' : '']),
  },
  insert_footnote: {
    category: 'edit',
    label: (a) => str(a['kind']) === 'endnote' ? '미주 삽입' : '각주 삽입',
    summary: (a) => join([para(a), quote(str(a['text']))]),
  },
  edit_footnote: { category: 'edit', label: '각주 수정', summary: (a) => quote(str(a['text'])) },
  set_bookmark: {
    category: 'edit',
    label: (a) => str(a['op']) === 'delete' ? '책갈피 삭제' : str(a['op']) === 'rename' ? '책갈피 이름 변경' : '책갈피 추가',
    summary: (a) => quote(str(a['name'])),
  },
  insert_image: { category: 'edit', label: '그림 삽입', summary: (a) => join([para(a), size(a)]) },
  insert_equation: { category: 'edit', label: '수식 삽입', summary: (a) => join([para(a), quote(str(a['script']), 32)]) },
  insert_shape: {
    category: 'edit',
    label: (a) => SHAPE_KINDS[str(a['shape']) || str(a['kind']) || str(a['type'])] ?? '도형 삽입',
    summary: (a) => join([para(a), size(a)]),
  },
  insert_chart: { category: 'edit', label: '차트 삽입', summary: (a) => join([para(a), str(rec(a['spec'])['type'])]) },
  edit_object: { category: 'edit', label: (a) => `개체 ${objectAction(a)}`, summary: (a) => join([para(a), size(a)]) },
  apply_engine_edits: {
    category: 'edit',
    label: (a) => `엔진 편집 ${Array.isArray(a['operations']) ? a['operations'].length : 0}개`,
  },
  prepare_engine_edit_session: { category: 'edit', label: '엔진 편집 준비', summary: (a) => str(a['method']) },

  // 대화 제어
  ask_user_question: {
    category: 'other', label: '질문하기',
    summary: (a) => {
      const first = Array.isArray(a['questions']) ? rec(a['questions'][0]) : {};
      return quote(str(first['question']) || str(first['header']), 32);
    },
  },
  request_permission: { category: 'other', label: '권한 요청', summary: (a) => clip(str(a['reason']), 64) },
  present_implementation_plan: { category: 'other', label: '계획 제시', summary: (a) => quote(str(a['title']), 32) },
  update_todos: {
    category: 'other', label: '할 일 갱신',
    summary: (a) => Array.isArray(a['todos'])
      ? `${a['todos'].filter((t: { status?: unknown }) => t?.status === 'completed').length}/${a['todos'].length}`
      : '',
  },
};

/** `mcp__doogle__insert_text` → `insert_text` */
export function bareToolName(name: string): string {
  const match = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return match ? match[1] : name;
}

export function describeToolCall(rawName: string, rawArgs: unknown): ToolCallView {
  const name = bareToolName(rawName);
  const spec = SPECS[name];
  const args = rec(rawArgs);
  if (!spec) {
    return { name, known: false, category: 'other', label: name, summary: '' };
  }
  let label: string;
  let summary = '';
  try {
    label = typeof spec.label === 'function' ? spec.label(args) : spec.label;
    summary = spec.summary ? spec.summary(args) : '';
  } catch {
    label = typeof spec.label === 'string' ? spec.label : name;
  }
  const items = batchItems(name, args);
  return { name, known: true, category: spec.category, label, summary, ...(items ? { items } : {}) };
}

/** apply_edits.edits[] / read_batch.reads[] → 하위 항목 설명. 옛 꼴 {tool, args:{…}} 도 받는다. */
function batchItems(name: string, args: Args): Array<{ label: string; summary: string }> | null {
  const key = name === 'apply_edits' ? 'edits' : name === 'read_batch' ? 'reads' : null;
  const list = key ? args[key] : null;
  if (!Array.isArray(list)) return null;
  return list.map((raw) => {
    const r = rec(raw);
    const tool = str(r['tool']);
    const flat = r['args'] && typeof r['args'] === 'object' ? { ...rec(r['args']), ...r } : r;
    const view = tool && SPECS[tool] && tool !== 'apply_edits' && tool !== 'read_batch' ? describeToolCall(tool, flat) : null;
    return view ? { label: view.label, summary: view.summary } : { label: tool || '알 수 없는 항목', summary: '' };
  });
}

/**
 * 묶음 실패 사유 → 항목별 사유. executor 의 BATCH_FAILED 메시지
 * `… edits[2] insert_text: ANCHOR_NOT_FOUND 메시지 | edits[5] …` 를 나눈다.
 */
export function parseBatchFailures(summary: string | undefined): Map<number, { code: string; text: string }> {
  const out = new Map<number, { code: string; text: string }>();
  const re = /(?:edits|reads)\[(\d+)\] [a-z_]+: ([A-Z][A-Z0-9_]+) (.*?)(?= \| (?:edits|reads)\[\d+\]|$)/gs;
  for (const m of (summary ?? '').matchAll(re)) {
    const code = m[2];
    out.set(Number(m[1]), { code, text: FAILURE_TEXT[code] ?? m[3].trim() });
  }
  return out;
}

/** 사용자에게 보일 일이 없는 오류 코드 → 한 문장 (코드는 "자세히"/툴팁에만) */
const FAILURE_TEXT: Record<string, string> = {
  DOCUMENT_WRITER_BUSY: '다른 편집이 진행 중이라 쓰지 못했습니다. 잠시 뒤 다시 시도하세요.',
  REVISION_MISMATCH: '그 사이 문서가 바뀌어 적용하지 못했습니다.',
  STAGING_BASELINE_LOST: '검토 대기 중인 변경의 기준 문서를 잃어 적용하지 못했습니다.',
  ENGINE_UNSUPPORTED: '이 문서 요소는 아직 편집할 수 없습니다.',
  RESULT_TOO_LARGE: '결과가 너무 커서 한 번에 읽지 못했습니다.',
  NOT_IMPLEMENTED: '아직 지원하지 않는 작업입니다.',
  NO_DOCUMENT: '열린 문서가 없습니다.',
  BATCH_FAILED: '일부 항목이 실패해 이 묶음은 하나도 적용하지 않았습니다.',
  EDITOR_BLOCKED: '편집기가 되돌리기를 확인하지 못해 편집을 멈췄습니다. 실행 취소(Ctrl+Z)하거나 문서를 다시 여세요.',
  TIMEOUT: '시간 안에 끝나지 않았습니다.',
};

/**
 * 도구 실패 사유(`tool_result.summary`) → 화면 한 줄 + 코드.
 * "CODE: 메시지" · "[CODE] 메시지" · "CODE" 꼴을 나눈다. 코드는 화면 본문에 쓰지 않는다 (UI_AUDIT §3.12).
 */
export function formatToolFailure(summary: string | undefined): { text: string; code?: string } {
  const raw = (summary ?? '').trim();
  if (!raw) return { text: '실패했습니다.' };
  const match = /^\[?([A-Z][A-Z0-9_]{2,})\]?(?::|\s+-|\s)\s*(.*)$/s.exec(raw) ?? /^([A-Z][A-Z0-9_]{2,})$/.exec(raw);
  if (!match) return { text: raw };
  const code = match[1];
  const rest = (match[2] ?? '').trim();
  return { text: FAILURE_TEXT[code] ?? (rest || '실패했습니다.'), code };
}
