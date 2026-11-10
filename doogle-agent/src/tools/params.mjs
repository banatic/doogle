// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-agent/tools.mjs
// Copyright (c) banatic, Hataewook/Rauhwpx, Edward Kim/rhwp — MIT License.
//
// tool 스키마 조각과 검증 훅 — 프로세스/네트워크 부수효과 없는 순수 모듈.
// zod 4.x 패키지의 v3 호환 API(`zod/v3`)를 쓴다: rhwp-x 와 같은 스키마 의미
// (strict(message), record(enum, …) 부분 키, preprocess)를 그대로 유지하고
// zod-to-json-schema 로 draft-07 JSON Schema 를 만든다.
import { z } from 'zod/v3';

export { z };

/** INVALID_ARGS 에러를 만든다. validateArgs 가 잡아 {ok:false, error} 로 바꾼다. */
export function invalidArgs(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGS';
  return err;
}

// 숫자 범위는 스튜디오가 검증하고 오류에 범위를 담아 돌려주므로 스키마에는 두지 않는다
// (tablePropsParam 과 같은 정책 — 정의 크기를 줄이려는 목적도 있다).
export function cellParam() {
  return z.object({
    paraIdx: z.number().int(),
    controlIdx: z.number().int(),
    cellIdx: z.number().int(),
  }).optional().describe('rhwp tool rules');
}

// 경로 항목의 키/음수·최대 깊이(8) 검사는 스튜디오 executor 가 한다 (여러 tool 에 반복되는
// 스키마라 항목 모양은 레코드로 두고 키 이름은 TOOL_RULES 에 적는다).
export function cellPathParam() {
  return z.array(z.record(z.string(), z.unknown())).min(1).optional()
    .describe('Nested (rhwp tool rules)');
}

/**
 * 스테이징 쓰기의 결과 이미지 — 'crop' 은 바뀐 영역만, 'page' 는 바뀐 쪽 전체를 PNG 한 장으로
 * 쌓아 돌려준다. 모든 쓰기 tool 에 반복되는 스키마라 설명은 TOOL_RULES 에만 둔다.
 */
export function renderParam() {
  return z.enum(['crop', 'page']).optional();
}

export const DOCUMENT_ID_UNSUPPORTED_MESSAGE = 'documentId is not supported — every tool targets the document open in 두글';

/**
 * v1 은 다중 문서를 다루지 않으므로 어떤 tool 도 documentId 를 선언하지 않는다. documentId 가 오면
 * 조용히 지우지 않고(열린 문서에 잘못 적용될 수 있다) 오류 메시지를, 아니면 null 을 돌려준다.
 * read_batch / apply_edits 항목 안의 documentId 도 거절한다.
 * @param {{ name: string, shape: Record<string, unknown> } | undefined} definition
 * @param {unknown} args
 */
export function documentIdArgError(definition, args) {
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (Object.hasOwn(args, 'documentId') && !Object.hasOwn(definition.shape, 'documentId')) {
    return DOCUMENT_ID_UNSUPPORTED_MESSAGE;
  }
  const items = definition.name === 'read_batch' ? args.reads
    : definition.name === 'apply_edits' ? args.edits
      : null;
  if (!Array.isArray(items)) return null;
  const itemHasDocumentId = (item) => item && typeof item === 'object' && (Object.hasOwn(item, 'documentId')
    || (item.args && typeof item.args === 'object' && Object.hasOwn(item.args, 'documentId')));
  if (!items.some(itemHasDocumentId)) return null;
  return definition.name === 'read_batch'
    ? `read_batch items take no documentId — ${DOCUMENT_ID_UNSUPPORTED_MESSAGE}`
    : DOCUMENT_ID_UNSUPPORTED_MESSAGE;
}

/** set_zone_borders 의 테두리 한 변 스펙. 인스턴스를 공유하면 JSON 스키마에 $ref 가 생기므로 매번 새로 만든다. */
export function borderSpec() {
  return z.object({
    type: z.number().int(),
    width: z.number().int(),
    color: z.string(),
  }).optional();
}

/** render_page / get_page_geometry 의 쪽 영역 (mm, 쪽 왼쪽 위 기준). */
export function regionMmParam() {
  return z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }).optional();
}

/** set_zone_borders 의 범위 모서리 좌표. */
export function zoneCorner(description) {
  const schema = z.object({
    row: z.number().int(),
    col: z.number().int(),
  });
  return description ? schema.describe(description) : schema;
}

/**
 * 텍스트 앵커 — 숫자 좌표 대신 받는 위치 지정. 5개 tool 에 반복되는 스키마라 중첩
 * 필드는 레코드 + 검증 훅으로 짧게 두고, 규칙 본문(occurrence/within/position, 해석 시점,
 * 오류 동작)은 TOOL_RULES 에만 둔다.
 */
export function anchorParam() {
  // 문자열 앵커는 {text} 의 줄임 — 스키마 글자 수를 늘리지 않게 파싱 단계에서 객체로 바꾼다.
  return z.preprocess(
    (value) => (typeof value === 'string' ? { text: value } : value),
    z.record(z.string(), z.unknown()).optional(),
  ).describe('Long form of find');
}

/**
 * find 단축 — find:"찾을 텍스트" 는 anchor:{text} 와 같고, 옆의 occurrence/position 은 anchor 안쪽과
 * 같은 뜻이다. 중첩 없는 평평한 인자라 모델이 중괄호를 닫다가 text 를 빠뜨리지 않는다. 검색 범위는
 * 옆의 paraIdx/cell 이 정한다. 값 검증은 validateAnchorTool 과 스튜디오 executor 가 한다.
 */
export function findParams() {
  return {
    find: z.string().optional(),
    occurrence: z.number().int().optional(),
    position: z.string().optional(),
  };
}

const ANCHOR_KEYS = ['text', 'occurrence', 'within', 'position'];
const ANCHOR_WITHIN_KEYS = ['sectionIdx', 'paraRange', 'cell'];
/** delete_range / replace_range 의 좌표 키 전체. */
export const RANGE_COORD_KEYS = ['sectionIdx', 'startParaIdx', 'startCharOffset', 'endParaIdx', 'endCharOffset'];

/**
 * find 와 anchor 를 한 앵커로 모은다 — find 는 {text} 이고, 최상위 occurrence/position 은 앵커가
 * 정하지 않은 값을 채운다. find 와 anchor 를 함께 보내거나 같은 값을 두 곳에서 다르게 주면 거절한다.
 * 둘 다 없으면 undefined (최상위 occurrence/position 만 남아 있으면 거절).
 */
export function anchorFromArgs(args) {
  const present = (v) => v !== undefined && v !== null;
  const refiners = ['occurrence', 'position'].filter((k) => present(args[k]));
  if (present(args.find) && present(args.anchor)) {
    throw invalidArgs('pass find or anchor, not both — find:"text" is the short form of anchor:{text:"text"}');
  }
  if (!present(args.find) && !present(args.anchor)) {
    if (refiners.length > 0) {
      throw invalidArgs(`${refiners.join('/')} refines a text match — add find:"text", or drop ${refiners.join('/')}`);
    }
    return undefined;
  }
  if (present(args.find) && (typeof args.find !== 'string' || args.find.length < 1)) {
    throw invalidArgs('find must be the exact text to locate (a non-empty string)');
  }
  const anchor = present(args.find) ? { text: args.find }
    : typeof args.anchor === 'string' ? { text: args.anchor } : args.anchor;
  if (typeof anchor !== 'object' || Array.isArray(anchor)) return anchor;
  const merged = { ...anchor };
  for (const key of refiners) {
    if (present(anchor[key]) && anchor[key] !== args[key]) {
      throw invalidArgs(`${key} ${JSON.stringify(args[key])} and anchor.${key} ${JSON.stringify(anchor[key])} disagree — send only one`);
    }
    merged[key] = args[key];
  }
  return merged;
}

/**
 * anchor 내부 필드 검증 — 레코드 스키마가 풀어주는 만큼 여기서 모양을 고정한다. 문자열은 {text} 로 본다.
 * prefix 는 오류에 싣는 키 앞머리다 — find 꼴이면 occurrence/position 이 최상위 인자라 비운다.
 */
export function validateAnchorShape(anchor, prefix = 'anchor.') {
  if (typeof anchor === 'string') anchor = { text: anchor };
  if (typeof anchor !== 'object' || anchor === null || Array.isArray(anchor)) {
    throw invalidArgs('anchor must be {text, occurrence?, within?, position?} or the text itself as a string');
  }
  const unknown = Object.keys(anchor).filter((k) => !ANCHOR_KEYS.includes(k));
  if (unknown.length > 0) {
    throw invalidArgs(`unknown anchor key ${unknown.join('/')} — valid keys: ${ANCHOR_KEYS.join(', ')}`);
  }
  if (typeof anchor.text !== 'string' || anchor.text.length < 1) {
    throw invalidArgs('anchor.text must be a non-empty string');
  }
  const occurrence = anchor.occurrence;
  if (occurrence !== undefined && occurrence !== null
    && (typeof occurrence !== 'number' || !Number.isSafeInteger(occurrence) || occurrence < 1)) {
    throw invalidArgs(`${prefix}occurrence must be a 1-based integer (>= 1)`);
  }
  const position = anchor.position;
  if (position !== undefined && position !== null
    && position !== 'before' && position !== 'after' && position !== 'replace') {
    throw invalidArgs(`${prefix}position must be "before" | "after" | "replace" (got ${JSON.stringify(position)})`);
  }
  const within = anchor.within;
  if (within !== undefined && within !== null) {
    if (typeof within !== 'object' || Array.isArray(within)) {
      throw invalidArgs('anchor.within must be an object {sectionIdx?, paraRange?, cell?}');
    }
    const wk = Object.keys(within).filter((k) => !ANCHOR_WITHIN_KEYS.includes(k));
    if (wk.length > 0) {
      throw invalidArgs(`unknown anchor.within key ${wk.join('/')} — valid keys: ${ANCHOR_WITHIN_KEYS.join(', ')}`);
    }
  }
}

/**
 * 여러 문단 대상 (서식 tool 공용) — 항목은 문단 번호 또는 [첫, 끝] 구간이다. 스키마는 느슨한
 * 배열로 두고 모양은 validateParas 가, 범위·중복·개수 한도는 스튜디오 executor 가 본다.
 */
export function parasParam() {
  return z.array(z.unknown()).optional().describe('paraIdx or [first,last]');
}

/**
 * 한 표의 여러 셀 대상 (서식 tool 공용) — {paraIdx, controlIdx, cellIdxs:[cellIdx | [first,last], …]}.
 * 셀 안 문단 전부가 대상이다. 모양·범위는 스튜디오 executor 가 본다.
 */
export function cellsParam() {
  return z.object({
    paraIdx: z.number().int(),
    controlIdx: z.number().int(),
    cellIdxs: z.array(z.unknown()).min(1),
  }).optional().describe('Many cells of one table: cellIdxs = cellIdx or [first,last]');
}

/** cells 와 함께 올 수 없는 주소 인자 — cells 가 대상을 이미 정한다. */
const CELLS_CLASH_KEYS = ['paraIdx', 'paras', 'startOffset', 'endOffset', 'find', 'anchor', 'cell', 'cellPath'];

/** find/anchor 와 함께 올 수 없는 글자 오프셋 — 둘 다 위치를 정한다 (문단 좌표·cell 은 검색 범위라 괜찮다). */
const CHAR_OFFSET_KEYS = ['charOffset', 'startCharOffset', 'endCharOffset', 'startOffset', 'endOffset'];

/** paras 와 함께 올 수 없는 주소 인자 — paras 가 대상 문단을 이미 정한다. */
const PARAS_CLASH_KEYS = ['paraIdx', 'startOffset', 'endOffset', 'find', 'anchor'];

export function validateParas(args) {
  const clash = PARAS_CLASH_KEYS.filter((k) => args[k] !== undefined && args[k] !== null);
  if (clash.length > 0) {
    throw invalidArgs(`paras already names the target paragraphs — drop ${clash.join(', ')}, or send that target as a separate item`);
  }
  const isIndex = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!Array.isArray(args.paras) || args.paras.length < 1 || args.paras.length > 64) {
    throw invalidArgs('paras must list 1..64 entries, each a paragraph index or an inclusive [first, last] range, e.g. [48, [51, 53]]');
  }
  args.paras.forEach((entry, index) => {
    const range = Array.isArray(entry) && entry.length === 2 && isIndex(entry[0]) && isIndex(entry[1]);
    if (range && entry[1] < entry[0]) {
      throw invalidArgs(`paras[${index}] [${entry[0]}, ${entry[1]}] is reversed — send [${entry[1]}, ${entry[0]}]`);
    }
    if (!range && !isIndex(entry)) {
      throw invalidArgs(`paras[${index}] must be a paragraph index or an inclusive [first, last] range (got ${JSON.stringify(entry)})`);
    }
  });
}

/**
 * 대상 주소 검증 — paras 가 있으면 그 모양만, find/anchor 가 있으면 그 모양을 본다 (옆에 온
 * 문단 좌표·cell 은 스튜디오 executor 가 검색 범위로 쓰고, 글자 오프셋은 위치를 둘로 만들어 거절한다).
 * 둘 다 없으면 좌표가 있어야 한다. sectionIdx(구역이 하나뿐인 문서)와 범위 tool 의 endParaIdx 는
 * executor 가 채우므로 요구하지 않고, apply_char_format 은 오프셋이 둘 다 없으면 문단 전체라
 * 오프셋도 요구하지 않는다.
 * @param {string} tool 오류 메시지에 싣는 tool 이름
 * @param {Record<string, unknown>} args
 * @param {string[]} coordKeys 좌표 방식의 전체 키 — 누락 오류가 통째로 알려준다
 * @param {{anchor?: boolean, paras?: boolean, cells?: boolean}} [accepts] 좌표 대신 받는 주소 방식
 */
export function validateAnchorTool(tool, args, coordKeys, { anchor = true, paras = false, cells = false } = {}) {
  const present = (k) => args[k] !== undefined && args[k] !== null;
  if (cells && present('cells')) {
    const clash = CELLS_CLASH_KEYS.filter(present);
    if (clash.length > 0) {
      throw invalidArgs(`cells already names the target cells — drop ${clash.join(', ')}, or send that target as a separate item`);
    }
    return;
  }
  if (paras && present('paras')) {
    validateParas(args);
    return;
  }
  const textAnchor = anchor ? anchorFromArgs(args) : undefined;
  if (textAnchor !== undefined) {
    const via = present('find') ? 'find' : 'anchor';
    const offsets = CHAR_OFFSET_KEYS.filter(present);
    if (offsets.length > 0) {
      throw invalidArgs(`${offsets.join('/')} and ${via} both place the target — send ${via} (with position/occurrence if needed) or ${offsets.join('/')}, not both`);
    }
    validateAnchorShape(textAnchor, via === 'find' ? '' : 'anchor.');
    return;
  }
  const wholePara = tool === 'apply_char_format' && !present('startOffset') && !present('endOffset');
  const keys = wholePara ? coordKeys.filter((k) => k !== 'startOffset' && k !== 'endOffset') : coordKeys;
  // 범위 tool 의 paraIdx 는 startParaIdx 의 별칭이다 (executor 가 옮긴다).
  const missing = keys.filter((k) => k !== 'sectionIdx' && k !== 'endParaIdx' && !present(k)
    && !(k === 'startParaIdx' && present('paraIdx')));
  if (missing.length > 0) {
    const alternatives = [anchor ? 'find' : '', paras ? 'paras' : '', cells ? 'cells' : ''].filter(Boolean).join(' or ');
    throw invalidArgs(`${tool} needs ${keys.join(', ')} — or ${alternatives} (missing ${missing.join(', ')})`);
  }
}

/** 상하좌우 mm 묶음 (셀 안 여백·표 바깥 여백·문단 테두리 여백). */
export function sidesMm() {
  const side = () => z.number().optional();
  return z.object({ left: side(), right: side(), top: side(), bottom: side() }).optional();
}

/** apply_para_format 의 문단 테두리 — side 키당 {type,widthMm,color}, widthMm 은 가장 가까운 HWP 굵기로 맞춘다.
 *  세부 범위 검증은 executor 가 한다. */
export function paraBordersParam() {
  const side = z.object({
    type: z.number().int(),
    widthMm: z.number().optional(),
    color: z.string().optional(),
  });
  return z.record(z.enum(['left', 'right', 'top', 'bottom']), side).optional();
}

/** apply_para_format 의 탭 정지 하나 — 생략 시 type left, fill 0. */
export function tabStopParam() {
  return z.object({
    positionMm: z.number().positive(),
    type: z.enum(['left', 'right', 'center', 'decimal']).optional(),
    fill: z.number().int().optional(),
  });
}

/**
 * 모르는 키를 받으면 올바른 키 목록을 담아 거절하는 strict 객체.
 * zod 의 unrecognized_keys 메시지가 그대로 모델에게 가므로 여기서 복구 안내를 준다.
 */
export function strictKeys(label, shape) {
  return z.object(shape).strict(`Unknown ${label} key. Valid keys: ${Object.keys(shape).join(', ')}`);
}

/**
 * set_table_props 의 tableProps — 스튜디오 parseTableProps 가 받는 키와 일치해야 한다.
 * 숫자 범위는 스튜디오가 검증하고 오류에 범위를 담아 돌려주므로 스키마에는 두지 않는다.
 */
export function tablePropsParam() {
  return strictKeys('tableProps', {
    repeatHeader: z.boolean().optional(),
    pageBreak: z.enum(['none', 'cell', 'row']).optional(),
    cellSpacingMm: z.number().optional(),
    cellPaddingMm: sidesMm(),
    outerMarginMm: sidesMm(),
    positionMode: z.enum(['inline', 'floating']).optional(),
    textWrap: z.enum(['square', 'topAndBottom', 'behindText', 'inFrontOfText']).optional(),
    horizontalRelativeTo: z.enum(['paper', 'page', 'column', 'paragraph']).optional(),
    horizontalAlign: z.enum(['left', 'center', 'right', 'inside', 'outside']).optional(),
    horizontalOffsetMm: z.number().optional(),
    verticalRelativeTo: z.enum(['paper', 'page', 'paragraph']).optional(),
    verticalAlign: z.enum(['top', 'center', 'bottom', 'inside', 'outside']).optional(),
    verticalOffsetMm: z.number().optional(),
    restrictInPage: z.boolean().optional(),
    allowOverlap: z.boolean().optional(),
    keepWithAnchor: z.boolean().optional(),
    captionEnabled: z.boolean().optional(),
    captionDirection: z.enum(['left', 'right', 'top', 'bottom']).optional(),
    captionWidthMm: z.number().optional(),
    captionSpacingMm: z.number().optional(),
    captionVerticalAlign: z.enum(['top', 'center', 'bottom']).optional(),
  });
}

/** set_cell_props 의 cellProps — 스튜디오 parseCellProps 가 받는 키와 일치해야 한다. */
export function cellPropsParam() {
  return strictKeys('cellProps', {
    fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    verticalAlign: z.enum(['top', 'center', 'bottom']).optional(),
    isHeader: z.boolean().optional(),
    widthMm: z.number().optional(),
    heightMm: z.number().optional(),
    paddingMm: sidesMm(),
    applyInnerMargin: z.boolean().optional(),
    textDirection: z.enum(['horizontal', 'vertical']).optional(),
    protected: z.boolean().optional(),
    editableInForm: z.boolean().optional(),
    fieldName: z.string().optional(),
  });
}

/** 스튜디오 파서 허용 키와 맞춰 보는 가드 테스트용. */
export const TABLE_PROPS_KEYS = Object.freeze(Object.keys(tablePropsParam().shape));
export const CELL_PROPS_KEYS = Object.freeze(Object.keys(cellPropsParam().shape));

// cell 을 받는 텍스트·서식 tool. 표 좌표를 cell 없이 최상위에 두면 strict 스키마가 "Unrecognized key" 로만
// 거절한다 — 고친 호출 꼴을 대신 알려 준다 (스튜디오 tool-executor 의 assertCellArgsPlacement 와 같은 문구).
const CELL_ADDRESSED_TOOLS = new Set([
  'insert_text', 'delete_range', 'replace_range', 'apply_char_format', 'apply_para_format', 'get_text_range',
]);

export function assertCellArgsPlacement(tool, args) {
  if (!CELL_ADDRESSED_TOOLS.has(tool) || !args || typeof args !== 'object') return;
  const given = (key) => args[key] !== undefined && args[key] !== null;
  if (given('cell')) return;
  const stray = ['controlIdx', 'cellIdx', 'cellParaIdx'].filter(given);
  if (stray.length === 0) return;
  const show = (key, fallback) => (typeof args[key] === 'number' ? String(args[key]) : fallback);
  const tablePara = given('paraIdx') ? show('paraIdx', 'P') : show('startParaIdx', 'P');
  const cell = `cell:{paraIdx:${tablePara},controlIdx:${show('controlIdx', '0')},cellIdx:${show('cellIdx', 'N')}}`;
  const inner = show('cellParaIdx', '0');
  const paraKeys = tool === 'delete_range' || tool === 'replace_range' ? 'startParaIdx/endParaIdx' : 'paraIdx';
  throw invalidArgs(
    `${tool} got top-level ${stray.join('/')} without cell, which would edit the table's host paragraph instead of the cell. `
      + `Put the cell address in ${cell} (paraIdx = the table's body paragraph from its get_structure line) `
      + `and set ${paraKeys} to the paragraph inside the cell (${inner}), e.g. {${cell}, ${paraKeys.split('/')[0]}:${inner}, …}.`,
  );
}

// create_table: rows+cols 나 cells 그리드 둘 중 하나는 반드시 필요하다 (스키마는 둘 다 optional).
export function validateCreateTable(args) {
  const hasCells = Array.isArray(args.cells) && args.cells.length > 0;
  const hasDims = Number.isInteger(args.rows) && Number.isInteger(args.cols);
  if (!hasCells && !hasDims) {
    throw invalidArgs('create_table requires either rows+cols or a cells grid (rows/cols are inferred from cells)');
  }
}

// insert_image: 원본은 하나만, 떠 있는 배치 인자는 positionMode "floating" 과 함께만.
// (rhwp-x 의 referenceFileId/clipId/cropPx 원본은 v1 범위 밖이라 뺐다.)
export function validateInsertImage(args) {
  const sources = ['imagePath', 'imageBase64'].filter((key) => typeof args[key] === 'string' && args[key].length > 0);
  if (sources.length !== 1) throw invalidArgs('pass exactly one of imagePath or imageBase64 (+ extension)');
  if (sources[0] === 'imageBase64' && !args.extension) throw invalidArgs('imageBase64 needs extension (png/jpg/gif/bmp)');
  if (args.positionMode !== 'floating') {
    const stray = ['xMm', 'yMm', 'relativeTo', 'wrap'].filter((key) => args[key] !== undefined);
    if (stray.length > 0) throw invalidArgs(`${stray.join('/')} need positionMode "floating"`);
  }
}

// edit_table: op 별 필수 파라미터 — 빠뜨리면 뭐가 필요한지 이름 붙여 즉시 실패시킨다.
const EDIT_TABLE_REQUIRED_PARAMS = {
  insert_row: ['rowIdx'],
  insert_col: ['colIdx'],
  delete_row: ['rowIdx'],
  delete_col: ['colIdx'],
  merge_cells: ['startRow', 'startCol', 'endRow', 'endCol'],
  split_cell: ['rowIdx', 'colIdx', 'splitRows', 'splitCols'],
  set_column_widths: ['columnWidthsMm'],
  fit_to_page: [],
  apply_formula: ['row', 'col', 'formula'],
};

export function validateEditTable(args) {
  const required = EDIT_TABLE_REQUIRED_PARAMS[args.op];
  if (!required) return; // op 값 자체는 enum 스키마가 걸러낸다
  const missing = required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length > 0) {
    throw invalidArgs(`edit_table op '${args.op}' requires ${required.join(', ')} — missing: ${missing.join(', ')}`);
  }
}

// set_table_props/set_cell_props: 빈 객체는 아무것도 바꾸지 않으므로 쓸 수 있는 키를 알려 주며 거절한다.
export function requireSomeKeys(label, value, keys) {
  if (!value || Object.keys(value).length === 0) {
    throw invalidArgs(`${label} needs at least one of: ${keys.join(', ')}`);
  }
}

// apply_list: 번호 목록이면 format 필수, bulletChar 가 있으면 글머리표 목록이라 format 불필요.
export function validateApplyList(args) {
  const hasBullet = typeof args.bulletChar === 'string' && args.bulletChar.length > 0;
  if (!hasBullet && (args.format === undefined || args.format === null)) {
    throw invalidArgs('apply_list requires format for a numbered list (or bulletChar for a bullet list)');
  }
  if (Number.isInteger(args.startParaIdx) && Number.isInteger(args.endParaIdx) && args.endParaIdx < args.startParaIdx) {
    throw invalidArgs(`apply_list range ${args.startParaIdx}..${args.endParaIdx} is reversed — send startParaIdx ${args.endParaIdx}, endParaIdx ${args.startParaIdx}`);
  }
}

export function validateSetBookmark(args) {
  if (args.op === 'add') {
    for (const key of ['sectionIdx', 'paraIdx', 'charOffset']) {
      if (typeof args[key] !== 'number') throw invalidArgs(`op "add" requires ${key}`);
    }
  }
  if (args.op === 'rename' && typeof args.newName !== 'string') {
    throw invalidArgs('op "rename" requires newName');
  }
}

export const EQUATION_SYNTAX = 'Syntax: 한컴 수식, NOT LaTeX: {a} over {b} · sqrt {x}, root n of x · x^{2}, y_{i} · int _{0} ^{inf}, sum _{k=1} ^{n}, prod, lim _{x -> 0} · PMATRIX{a & b # c & d} (& column, # row; also MATRIX/BMATRIX/DMATRIX) · cases{...} · greek names (alpha, pi, GAMMA) · ->, <-, <-> · bar/vec/hat/dot x · rm/it · ~ thin space, # line break. Example: "x = {-b +- sqrt {b^2 - 4ac}} over {2a}". INVALID_SCRIPT on syntax errors.';
