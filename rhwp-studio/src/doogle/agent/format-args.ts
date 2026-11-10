// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/tool-executor.ts (charFormatProps / paraFormatOp / parseCellProps / parseTableProps)
/**
 * 도구 인자(mm·pt·#RRGGBB·enum) → 업스트림 엔진 JSON 속성. 순수 함수다.
 *
 * 업스트림 단위 (rhwp-studio ui/para-shape-dialog.ts, ai/tools/write-tools.ts 와 같음):
 *  - 글자 크기 fontSize = pt × 100
 *  - 문단 여백·들여쓰기 = pt × 200 (HWPUNIT 2배 저장값), 문단 위·아래 간격 = pt × 100
 *  - 줄 간격: Percent 는 %, 그 외는 pt × 100
 *  - 탭 위치 = HWPUNIT × 2
 */
import { HEX_COLOR_RE, asRecord, invalidArgs, mmToHu, ptToHu } from './types.ts';

function langSlotArray(name: string, value: unknown, min: number, max: number): number[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < min || value > max) throw invalidArgs(`${name} must be ${min}..${max}`);
    return Array(7).fill(Math.round(value));
  }
  if (Array.isArray(value) && value.length === 7 && value.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max)) {
    return value.map((v) => Math.round(v as number));
  }
  throw invalidArgs(`${name} must be a number ${min}..${max} or an array of 7 such numbers (one per script slot)`);
}

/** apply_char_format 인자 → applyCharFormat props. fontFamily 는 resolveFont 로 fontId 를 얻는다. */
export function charFormatProps(args: Record<string, unknown>, resolveFont: (name: string) => number): Record<string, unknown> {
  const format: Record<string, unknown> = {};
  for (const key of ['bold', 'italic', 'underline', 'strikethrough'] as const) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') throw invalidArgs(`${key} must be a boolean`);
    format[key] = v;
  }
  const fontSizePt = args['fontSizePt'];
  if (fontSizePt !== undefined && fontSizePt !== null) {
    if (typeof fontSizePt !== 'number' || !Number.isFinite(fontSizePt) || fontSizePt <= 0 || fontSizePt > 4096) {
      throw invalidArgs('fontSizePt must be a positive number');
    }
    format['fontSize'] = Math.round(fontSizePt * 100);
  }
  const textColor = args['textColor'];
  if (textColor !== undefined && textColor !== null) {
    if (typeof textColor !== 'string' || !HEX_COLOR_RE.test(textColor)) throw invalidArgs('textColor must be "#RRGGBB"');
    format['textColor'] = textColor;
  }
  const fontFamily = args['fontFamily'];
  if (fontFamily !== undefined && fontFamily !== null) {
    if (typeof fontFamily !== 'string' || fontFamily.length < 1 || fontFamily.length > 64) {
      throw invalidArgs('fontFamily must be a font name (1..64 chars)');
    }
    const fontId = resolveFont(fontFamily);
    if (!Number.isInteger(fontId) || fontId < 0) throw invalidArgs(`font "${fontFamily}" could not be registered`);
    format['fontId'] = fontId;
  }
  const widthPercent = args['widthPercent'];
  if (widthPercent !== undefined && widthPercent !== null) format['ratios'] = langSlotArray('widthPercent', widthPercent, 50, 200);
  const letterSpacing = args['letterSpacingPercent'];
  if (letterSpacing !== undefined && letterSpacing !== null) format['spacings'] = langSlotArray('letterSpacingPercent', letterSpacing, -50, 50);
  if (Object.keys(format).length === 0) {
    throw invalidArgs('At least one format key is required (bold/italic/underline/strikethrough/fontSizePt/textColor/fontFamily/widthPercent/letterSpacingPercent)');
  }
  return format;
}

const LINE_SPACING_TYPE_IN: Record<string, string> = { percent: 'Percent', fixed: 'Fixed', atLeast: 'Minimum', spaceOnly: 'SpaceOnly' };
const TAB_TYPE_IN: Record<string, number> = { left: 0, right: 1, center: 2, decimal: 3 };
/** HWP 선 굵기 표 (mm) — 인덱스가 엔진 width 코드 */
const BORDER_WIDTHS_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0];

export function borderWidthIndex(widthMm: number): number {
  let best = 0;
  for (let i = 1; i < BORDER_WIDTHS_MM.length; i++) {
    if (Math.abs(BORDER_WIDTHS_MM[i] - widthMm) < Math.abs(BORDER_WIDTHS_MM[best] - widthMm)) best = i;
  }
  return best;
}

export interface ParaFormatHelpers {
  /** 현재 문단 속성 (테두리 보존용) — 필요할 때만 부른다 */
  current(): Record<string, unknown>;
  ensureBullet(char: string): number;
}

/** apply_para_format 인자 → applyParaFormat props */
export function paraFormatProps(args: Record<string, unknown>, helpers: ParaFormatHelpers): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const alignment = args['alignment'];
  if (alignment !== undefined && alignment !== null) {
    const allowed = ['left', 'center', 'right', 'justify', 'distribute'];
    if (typeof alignment !== 'string' || !allowed.includes(alignment)) throw invalidArgs(`alignment must be one of ${allowed.join('|')}`);
    props['alignment'] = alignment;
  }
  const lsp = args['lineSpacingPercent'];
  const lsTypeRaw = args['lineSpacingType'];
  const lsInternal = lsTypeRaw === undefined || lsTypeRaw === null ? undefined : LINE_SPACING_TYPE_IN[lsTypeRaw as string];
  if (lsTypeRaw !== undefined && lsTypeRaw !== null && lsInternal === undefined) {
    throw invalidArgs('lineSpacingType must be one of percent|fixed|atLeast|spaceOnly');
  }
  const lsPt = args['lineSpacingPt'];
  if (lsp !== undefined && lsp !== null && lsPt !== undefined && lsPt !== null) {
    throw invalidArgs('send either lineSpacingPercent or lineSpacingType+lineSpacingPt, not both');
  }
  if (lsp !== undefined && lsp !== null) {
    if (typeof lsp !== 'number' || lsp < 50 || lsp > 500) throw invalidArgs('lineSpacingPercent must be 50..500');
    props['lineSpacing'] = Math.round(lsp);
    props['lineSpacingType'] = 'Percent';
  }
  if (lsPt !== undefined && lsPt !== null) {
    if (typeof lsPt !== 'number' || !Number.isFinite(lsPt) || lsPt <= 0 || lsPt > 1000) throw invalidArgs('lineSpacingPt must be a number in 0..1000');
    if (lsInternal === undefined || lsInternal === 'Percent') throw invalidArgs('lineSpacingPt pairs with lineSpacingType fixed|atLeast|spaceOnly');
    props['lineSpacing'] = ptToHu(lsPt);
    props['lineSpacingType'] = lsInternal;
  } else if (lsInternal !== undefined) {
    if (lsInternal === 'Percent') {
      if (lsp === undefined || lsp === null) throw invalidArgs('lineSpacingType "percent" requires lineSpacingPercent');
    } else {
      throw invalidArgs(`lineSpacingType "${String(lsTypeRaw)}" requires lineSpacingPt`);
    }
  }
  const tabStops = args['tabStops'];
  if (tabStops !== undefined && tabStops !== null) {
    if (!Array.isArray(tabStops) || tabStops.length > 40) throw invalidArgs('tabStops must be an array of up to 40 stops');
    props['tabStops'] = tabStops.map((entry, i) => {
      const t = asRecord(entry);
      const pos = t['positionMm'];
      if (typeof pos !== 'number' || !Number.isFinite(pos) || pos <= 0 || pos > 300) throw invalidArgs(`tabStops[${i}].positionMm must be a number in 0..300`);
      const typeCode = TAB_TYPE_IN[(t['type'] ?? 'left') as string];
      if (typeCode === undefined) throw invalidArgs(`tabStops[${i}].type must be one of left|right|center|decimal`);
      const fill = t['fill'] ?? 0;
      if (typeof fill !== 'number' || !Number.isSafeInteger(fill) || fill < 0 || fill > 5) throw invalidArgs(`tabStops[${i}].fill must be an integer 0..5`);
      return { position: Math.round(mmToHu(pos) * 2), type: typeCode, fill };
    });
  }
  const borderKeys = ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const;
  const sideKey: Record<string, (typeof borderKeys)[number]> = { left: 'borderLeft', right: 'borderRight', top: 'borderTop', bottom: 'borderBottom' };
  const specs: Partial<Record<(typeof borderKeys)[number], { type: number; width: number; color: string }>> = {};
  let anyBorder = false;
  const bordersArg = args['borders'];
  if (bordersArg !== undefined && bordersArg !== null) {
    for (const [side, v] of Object.entries(asRecord(bordersArg))) {
      const key = sideKey[side];
      if (!key) throw invalidArgs(`borders.${side}: side must be left|right|top|bottom`);
      const b = asRecord(v);
      const type = b['type'];
      if (typeof type !== 'number' || !Number.isSafeInteger(type) || type < 0 || type > 17) {
        throw invalidArgs(`borders.${side}.type must be an integer 0..17 (0 none, 1 solid, 2 dashed, 3 dotted)`);
      }
      anyBorder = true;
      if (type === 0) { specs[key] = { type: 0, width: 0, color: '#000000' }; continue; }
      const widthMm = b['widthMm'];
      if (typeof widthMm !== 'number' || !Number.isFinite(widthMm) || widthMm < 0.05 || widthMm > 5) {
        throw invalidArgs(`borders.${side}.widthMm is required (0.1..5.0 mm, snapped to the nearest HWP width)`);
      }
      const color = b['color'] ?? '#000000';
      if (typeof color !== 'string' || !HEX_COLOR_RE.test(color)) throw invalidArgs(`borders.${side}.color must be "#RRGGBB"`);
      specs[key] = { type, width: borderWidthIndex(widthMm), color };
    }
  }
  const spacingArg = args['borderSpacingMm'];
  let current: Record<string, unknown> | undefined;
  if (anyBorder || (spacingArg !== undefined && spacingArg !== null)) current = helpers.current();
  if (anyBorder) {
    if (current?.['borderFillId']) props['borderFillId'] = current['borderFillId'];
    for (const key of borderKeys) {
      const spec = specs[key] ?? current?.[key];
      if (spec) props[key] = spec;
    }
  }
  if (spacingArg !== undefined && spacingArg !== null) {
    const s = asRecord(spacingArg);
    const cur = Array.isArray(current?.['borderSpacing']) ? current!['borderSpacing'] as number[] : [0, 0, 0, 0];
    const out = [cur[0] ?? 0, cur[1] ?? 0, cur[2] ?? 0, cur[3] ?? 0];
    const idx = { left: 0, right: 1, top: 2, bottom: 3 } as const;
    for (const [side, i] of Object.entries(idx)) {
      const v = s[side];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 100) throw invalidArgs(`borderSpacingMm.${side} must be a number within ±100`);
      out[i] = mmToHu(v);
    }
    props['borderSpacing'] = out;
  }
  const kbu = args['koreanBreakUnit'];
  if (kbu !== undefined && kbu !== null) {
    const v = ({ word: 0, char: 1 } as Record<string, number>)[kbu as string];
    if (v === undefined) throw invalidArgs('koreanBreakUnit must be word|char');
    props['koreanBreakUnit'] = v;
  }
  for (const [ptKey, huKey, scale] of [
    ['spaceBeforePt', 'spacingBefore', 1], ['spaceAfterPt', 'spacingAfter', 1],
    ['indentPt', 'indent', 2], ['marginLeftPt', 'marginLeft', 2], ['marginRightPt', 'marginRight', 2],
  ] as const) {
    const v = args[ptKey];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 500) throw invalidArgs(`${ptKey} must be a number within ±500`);
    props[huKey] = ptToHu(v) * scale;
  }
  if (args['pageBreakBefore'] !== undefined && args['pageBreakBefore'] !== null) {
    if (typeof args['pageBreakBefore'] !== 'boolean') throw invalidArgs('pageBreakBefore must be a boolean');
    props['pageBreakBefore'] = args['pageBreakBefore'];
  }
  const headType = args['headType'];
  if (headType !== undefined && headType !== null) {
    const map: Record<string, string> = { none: 'None', number: 'Number', bullet: 'Bullet', outline: 'Outline' };
    if (typeof headType !== 'string' || !(headType in map)) throw invalidArgs('headType must be one of none|number|bullet|outline');
    props['headType'] = map[headType];
    if (headType === 'none' && args['numberingId'] === undefined) props['numberingId'] = 0;
  }
  const numberingId = args['numberingId'];
  if (numberingId !== undefined && numberingId !== null) {
    if (typeof numberingId !== 'number' || !Number.isSafeInteger(numberingId) || numberingId < 0) {
      throw invalidArgs('numberingId must be a non-negative integer (see list_numberings)');
    }
    props['numberingId'] = numberingId;
  }
  const paraLevel = args['paraLevel'];
  if (paraLevel !== undefined && paraLevel !== null) {
    if (typeof paraLevel !== 'number' || !Number.isSafeInteger(paraLevel) || paraLevel < 0 || paraLevel > 6) {
      throw invalidArgs('paraLevel must be an integer 0..6');
    }
    props['paraLevel'] = paraLevel;
  }
  const bulletChar = args['bulletChar'];
  if (bulletChar !== undefined && bulletChar !== null) {
    if (typeof bulletChar !== 'string' || bulletChar.length < 1) throw invalidArgs('bulletChar must be a non-empty string');
    props['numberingId'] = helpers.ensureBullet(bulletChar);
    if (props['headType'] === undefined) props['headType'] = 'Bullet';
  }
  if (Object.keys(props).length === 0) {
    throw invalidArgs('At least one paragraph format key is required (alignment/lineSpacingPercent/lineSpacingType+lineSpacingPt/spaceBeforePt/spaceAfterPt/indentPt/marginLeftPt/marginRightPt/pageBreakBefore/tabStops/borders/borderSpacingMm/koreanBreakUnit/headType/numberingId/paraLevel/bulletChar)');
  }
  return props;
}

/** set_cell_props 의 cellProps → setCellProperties JSON */
export function parseCellProps(raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['fillColor', 'verticalAlign', 'isHeader', 'widthMm', 'heightMm', 'paddingMm',
    'applyInnerMargin', 'textDirection', 'protected', 'editableInForm', 'fieldName']);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw invalidArgs(`Unsupported cellProps keys: ${unknown.join(', ')}. Valid keys: ${[...allowed].join(', ')}`);
  const out: Record<string, unknown> = {};
  const fill = raw['fillColor'];
  if (fill !== undefined && fill !== null) {
    if (typeof fill !== 'string' || !HEX_COLOR_RE.test(fill)) throw invalidArgs('cellProps.fillColor must be "#RRGGBB"');
    out['fillType'] = 'solid';
    out['fillColor'] = fill;
  }
  const va = raw['verticalAlign'];
  if (va !== undefined && va !== null) {
    const map: Record<string, number> = { top: 0, center: 1, bottom: 2 };
    if (typeof va !== 'string' || !(va in map)) throw invalidArgs('cellProps.verticalAlign must be "top"|"center"|"bottom"');
    out['verticalAlign'] = map[va];
  }
  for (const [pub, internal] of [['isHeader', 'isHeader'], ['applyInnerMargin', 'applyInnerMargin'],
    ['protected', 'cellProtect'], ['editableInForm', 'editableInForm']] as const) {
    const v = raw[pub];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') throw invalidArgs(`cellProps.${pub} must be a boolean`);
    out[internal] = v;
  }
  const dir = raw['textDirection'];
  if (dir !== undefined && dir !== null) {
    if (dir !== 'horizontal' && dir !== 'vertical') throw invalidArgs('cellProps.textDirection must be "horizontal"|"vertical"');
    out['textDirection'] = dir === 'vertical' ? 1 : 0;
  }
  const fieldName = raw['fieldName'];
  if (fieldName !== undefined && fieldName !== null) {
    if (typeof fieldName !== 'string' || fieldName.length > 255) throw invalidArgs('cellProps.fieldName must be a string up to 255 chars (empty clears it)');
    out['fieldName'] = fieldName;
  }
  for (const [mmKey, huKey] of [['widthMm', 'width'], ['heightMm', 'height']] as const) {
    const v = raw[mmKey];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 500) throw invalidArgs(`cellProps.${mmKey} must be a positive number up to 500mm`);
    out[huKey] = mmToHu(v);
  }
  const padding = raw['paddingMm'];
  if (padding !== undefined && padding !== null) {
    const sides = asRecord(padding);
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const v = sides[side];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw invalidArgs(`cellProps.paddingMm.${side} must be 0..100mm`);
      out[`padding${side[0].toUpperCase()}${side.slice(1)}`] = mmToHu(v);
    }
    if (out['applyInnerMargin'] === undefined) out['applyInnerMargin'] = true;
  }
  if (Object.keys(out).length === 0) throw invalidArgs(`cellProps needs at least one of: ${[...allowed].join(', ')}`);
  return out;
}

/** set_table_props 의 tableProps → setTableProperties JSON */
export function parseTableProps(raw: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['repeatHeader', 'pageBreak', 'cellSpacingMm', 'cellPaddingMm', 'outerMarginMm',
    'positionMode', 'textWrap', 'horizontalRelativeTo', 'horizontalAlign', 'horizontalOffsetMm', 'verticalRelativeTo',
    'verticalAlign', 'verticalOffsetMm', 'restrictInPage', 'allowOverlap', 'keepWithAnchor', 'captionEnabled',
    'captionDirection', 'captionWidthMm', 'captionSpacingMm', 'captionVerticalAlign']);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw invalidArgs(`Unsupported tableProps keys: ${unknown.join(', ')}. Valid keys: ${[...allowed].join(', ')}`);
  const out: Record<string, unknown> = {};
  for (const [pub, internal] of [['repeatHeader', 'repeatHeader'], ['restrictInPage', 'restrictInPage'],
    ['allowOverlap', 'allowOverlap'], ['keepWithAnchor', 'keepWithAnchor'], ['captionEnabled', 'hasCaption']] as const) {
    const v = raw[pub];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') throw invalidArgs(`tableProps.${pub} must be a boolean`);
    out[internal] = v;
  }
  const enumProp = (pub: string, internal: string, map: Record<string, string | number>): void => {
    const v = raw[pub];
    if (v === undefined || v === null) return;
    if (typeof v !== 'string' || !(v in map)) throw invalidArgs(`tableProps.${pub} must be one of ${Object.keys(map).join('|')}`);
    out[internal] = map[v];
  };
  enumProp('pageBreak', 'pageBreak', { none: 0, cell: 1, row: 2 });
  enumProp('textWrap', 'textWrap', { square: 'Square', topAndBottom: 'TopAndBottom', behindText: 'BehindText', inFrontOfText: 'InFrontOfText' });
  enumProp('horizontalRelativeTo', 'horzRelTo', { paper: 'Paper', page: 'Page', column: 'Column', paragraph: 'Para' });
  enumProp('horizontalAlign', 'horzAlign', { left: 'Left', center: 'Center', right: 'Right', inside: 'Inside', outside: 'Outside' });
  enumProp('verticalRelativeTo', 'vertRelTo', { paper: 'Paper', page: 'Page', paragraph: 'Para' });
  enumProp('verticalAlign', 'vertAlign', { top: 'Top', center: 'Center', bottom: 'Bottom', inside: 'Inside', outside: 'Outside' });
  enumProp('captionDirection', 'captionDirection', { left: 0, right: 1, top: 2, bottom: 3 });
  enumProp('captionVerticalAlign', 'captionVertAlign', { top: 0, center: 1, bottom: 2 });
  const mode = raw['positionMode'];
  if (mode !== undefined && mode !== null) {
    if (mode !== 'inline' && mode !== 'floating') throw invalidArgs('tableProps.positionMode must be "inline"|"floating"');
    out['treatAsChar'] = mode === 'inline';
  }
  const floatingKeys = ['textWrap', 'horizontalRelativeTo', 'horizontalAlign', 'horizontalOffsetMm', 'verticalRelativeTo',
    'verticalAlign', 'verticalOffsetMm', 'restrictInPage', 'allowOverlap', 'keepWithAnchor', 'outerMarginMm'];
  if ((mode === undefined || mode === null) && floatingKeys.some((k) => raw[k] !== undefined && raw[k] !== null)) out['treatAsChar'] = false;
  const ha = raw['horizontalAlign'];
  if (ha !== undefined && ha !== null) {
    if (raw['horizontalRelativeTo'] === undefined || raw['horizontalRelativeTo'] === null) {
      out['horzRelTo'] = ['inside', 'outside'].includes(String(ha)) ? 'Page' : 'Column';
    }
    if (raw['horizontalOffsetMm'] === undefined || raw['horizontalOffsetMm'] === null) out['horzOffset'] = 0;
  }
  const boundedMm = (pub: string, internal: string, min: number, max: number): void => {
    const v = raw[pub];
    if (v === undefined || v === null) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw invalidArgs(`tableProps.${pub} must be ${min}..${max}mm`);
    out[internal] = mmToHu(v);
  };
  boundedMm('cellSpacingMm', 'cellSpacing', 0, 100);
  boundedMm('horizontalOffsetMm', 'horzOffset', -1000, 1000);
  boundedMm('verticalOffsetMm', 'vertOffset', -1000, 1000);
  boundedMm('captionWidthMm', 'captionWidth', 0, 500);
  boundedMm('captionSpacingMm', 'captionSpacing', 0, 100);
  for (const [groupKey, prefix] of [['cellPaddingMm', 'padding'], ['outerMarginMm', 'outer']] as const) {
    const group = raw[groupKey];
    if (group === undefined || group === null) continue;
    const sides = asRecord(group);
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const v = sides[side];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw invalidArgs(`tableProps.${groupKey}.${side} must be 0..100mm`);
      out[`${prefix}${side[0].toUpperCase()}${side.slice(1)}`] = mmToHu(v);
    }
  }
  if (Object.keys(out).length === 0) throw invalidArgs(`tableProps needs at least one of: ${[...allowed].join(', ')}`);
  return out;
}
