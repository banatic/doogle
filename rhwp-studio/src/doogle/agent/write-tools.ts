// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/tool-executor.ts (write tools)
/**
 * 쓰기 도구 본문. 각 핸들러는 transaction 안에서 한 번 불리고(전체 모드 = undo 한 단계,
 * 에이전트 모드 = 스테이징 한 묶음), 던지면 문서는 호출 전으로 돌아간다. 좌표 검사·리베이스·앵커
 * 해석은 WriteScope 가 실행기에서 받아 온다.
 */
import { Engine } from './engine-adapter.ts';
import {
  anchorEcho, buildAnchorScope, matchFromSearchHit, parseAnchorArgs, resolveAnchor,
  type MatchSource, type ResolvedAnchor, type SourceParagraph, type TextMatch,
} from './anchor.ts';
import { charFormatProps, paraFormatProps, parseCellProps, parseTableProps } from './format-args.ts';
import {
  DoogleToolError, HEX_COLOR_RE, asRecord, colorRef, invalidArgs, mmToHu, scalarLength,
  type CellAddr, type CellPathEntry,
} from './types.ts';

/** 쓰기가 건드린 자리 — 저널·after 보고·crop 렌더의 재료 */
export interface Touch {
  sectionIdx: number;
  /** 편집 후 본문 문단 범위(포함). 셀 편집은 표가 놓인 본문 문단 */
  paraStart: number;
  paraEnd: number;
  /** paraEnd 뒤 문단이 움직인 양 */
  paraDelta: number;
  /** 셀 안 편집 */
  cell?: CellAddr;
  cellParaStart?: number;
  cellParaEnd?: number;
  /** 보고용 시작 오프셋 */
  charOffset?: number;
  /** 표 전체·개체 전체 */
  table?: { paraIdx: number; controlIdx: number };
  /** 구역 전체 (쪽 설정·머리말 등) — 저널에 정밀 기록하지 않는다 */
  wholeSection?: boolean;
}

export interface WriteScope {
  engine: Engine;
  touches: Touch[];
  /** 좌표 쓰기의 revision 검사 — 뒤처진 revision 은 저널로 리베이스한 이동량을 돌려준다 */
  requireRevision(args: Record<string, unknown>, sectionIdx?: number, paraStart?: number, paraEnd?: number): number;
  /** 앵커 쓰기의 revision 검사 */
  requireRevisionAnchored(args: Record<string, unknown>, anchor: ResolvedAnchor): void;
  /** 이번 배치 앞 항목이 지운 글 (occurrence 오류 설명용) */
  noteRemoval(text: string): void;
  batchNote(text: string, remaining: number): string;
}

export type WriteHandler = (w: WriteScope, args: Record<string, unknown>) => Record<string, unknown>;

// ─── 인자 도우미 ─────────────────────────────────────────

function given(v: unknown): boolean { return v !== undefined && v !== null; }

export function reqInt(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw invalidArgs(`${key} must be a non-negative integer`);
  return v;
}

export function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (!given(v)) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw invalidArgs(`${key} must be a non-negative integer`);
  return v;
}

export function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw invalidArgs(`${key} must be a string`);
  return v;
}

/** cell (+cellPath) 인자 → CellAddr. 최상위에 controlIdx 등을 둔 실수는 고친 꼴로 안내한다. */
export function optCell(args: Record<string, unknown>): CellAddr | undefined {
  const raw = args['cell'];
  if (!given(raw)) {
    const stray = ['controlIdx', 'cellIdx', 'cellParaIdx'].filter((k) => given(args[k]));
    if (stray.length > 0 && !('op' in args) && !('tableProps' in args) && !('cellProps' in args) && !('startCell' in args)) {
      throw invalidArgs(`got top-level ${stray.join('/')} without cell, which would edit the table's host paragraph. `
        + 'Put the cell address in cell:{paraIdx:<table paragraph>, controlIdx, cellIdx} and set paraIdx to the paragraph inside the cell.');
    }
    return undefined;
  }
  const c = asRecord(raw);
  for (const k of ['paraIdx', 'controlIdx', 'cellIdx']) {
    if (typeof c[k] !== 'number' || !Number.isSafeInteger(c[k]) || (c[k] as number) < 0) {
      throw invalidArgs('cell must be {paraIdx, controlIdx, cellIdx} (non-negative integers from a get_structure table line)');
    }
  }
  const cell: CellAddr = { paraIdx: c['paraIdx'] as number, controlIdx: c['controlIdx'] as number, cellIdx: c['cellIdx'] as number };
  const path = args['cellPath'];
  if (given(path)) {
    if (!Array.isArray(path) || path.length < 1 || path.length > 8) throw invalidArgs('cellPath must be 1..8 entries {controlIndex, cellIndex, cellParaIndex}');
    cell.path = path.map((e, i) => {
      const r = asRecord(e);
      const out: CellPathEntry = {
        controlIndex: r['controlIndex'] as number, cellIndex: r['cellIndex'] as number, cellParaIndex: (r['cellParaIndex'] ?? 0) as number,
      };
      if (![out.controlIndex, out.cellIndex, out.cellParaIndex].every((n) => Number.isSafeInteger(n) && n >= 0)) {
        throw invalidArgs(`cellPath[${i}] must be {controlIndex, cellIndex, cellParaIndex} non-negative integers`);
      }
      return out;
    });
    if (cell.path[0].controlIndex !== cell.controlIdx || cell.path[0].cellIndex !== cell.cellIdx) {
      throw invalidArgs('cellPath[0] must match cell.controlIdx / cell.cellIdx (the path starts at the outer table)');
    }
    if (cell.path.length === 1) delete cell.path;
  }
  return cell;
}

/** sectionIdx — 구역이 하나면 생략 가능 */
export function sectionOf(engine: Engine, args: Record<string, unknown>, tool: string): number {
  const s = optInt(args, 'sectionIdx');
  const count = engine.sectionCount();
  if (s === undefined) {
    if (count === 1) return 0;
    throw invalidArgs(`${tool} needs sectionIdx because the document has ${count} sections`);
  }
  if (s >= count) throw invalidArgs(`sectionIdx ${s} is out of range (0..${count - 1})`);
  return s;
}

/** 문단(본문/셀) 주소 검사 — 길이를 돌려준다 */
export function validateAddress(engine: Engine, sectionIdx: number, paraIdx: number, charOffset: number | undefined, cell?: CellAddr): number {
  if (cell) engine.validateCell(sectionIdx, cell);
  const count = engine.paragraphCountIn(sectionIdx, cell);
  if (paraIdx >= count) {
    throw invalidArgs(`paraIdx ${paraIdx} is out of range for ${cell ? `cell ${cell.cellIdx}` : `section ${sectionIdx}`} (0..${count - 1})`);
  }
  const len = engine.length(sectionIdx, paraIdx, cell);
  if (charOffset !== undefined && charOffset > len) {
    throw invalidArgs(`charOffset ${charOffset} is past the end of paragraph ${paraIdx} (length ${len})`);
  }
  return len;
}

function cellHostTouch(sectionIdx: number, cell: CellAddr, cellParaStart: number, cellParaEnd: number, charOffset?: number): Touch {
  return {
    sectionIdx, paraStart: cell.paraIdx, paraEnd: cell.paraIdx, paraDelta: 0, cell,
    cellParaStart, cellParaEnd, ...(charOffset !== undefined ? { charOffset } : {}),
  };
}

function bodyTouch(sectionIdx: number, paraStart: number, paraEnd: number, paraDelta: number, charOffset?: number): Touch {
  return { sectionIdx, paraStart, paraEnd, paraDelta, ...(charOffset !== undefined ? { charOffset } : {}) };
}

function textTouch(sectionIdx: number, paraStart: number, paraEnd: number, paraDelta: number, cell: CellAddr | undefined, charOffset?: number): Touch {
  return cell ? cellHostTouch(sectionIdx, cell, paraStart, paraEnd, charOffset) : bodyTouch(sectionIdx, paraStart, paraEnd, paraDelta, charOffset);
}

// ─── 매치 원천 ─────────────────────────────────────────

/** 엔진 위의 앵커 검색 원천 — 정확 일치는 searchAllText(중첩 셀 포함), 재검색은 본문+최상위 셀 */
export function engineMatchSource(engine: Engine): MatchSource {
  const textOf = (m: TextMatch): string => {
    try { return engine.text(m.sectionIdx, m.paraIdx, m.cell); } catch { return ''; }
  };
  return {
    exact(query, caseSensitive) {
      const hits = engine.json<Array<Parameters<typeof matchFromSearchHit>[0]>>('searchAllText', query, caseSensitive, true) ?? [];
      return hits.map((hit) => {
        const m = matchFromSearchHit(hit, '');
        const text = textOf(m);
        const chars = [...text];
        m.context = chars.slice(Math.max(0, m.charOffset - 30), m.charOffset + m.length + 30).join('');
        return m;
      });
    },
    *paragraphs(): Iterable<SourceParagraph> {
      const sections = engine.sectionCount();
      for (let s = 0; s < sections; s++) {
        const n = engine.paragraphCount(s);
        for (let p = 0; p < n; p++) {
          const text = engine.text(s, p);
          if (text) yield { sectionIdx: s, paraIdx: p, text };
        }
      }
      for (const t of engine.tables()) {
        let dims;
        try { dims = engine.tableDims(t.sectionIdx, t.paraIdx, t.controlIdx); } catch { continue; }
        for (let cellIdx = 0; cellIdx < dims.cellCount; cellIdx++) {
          const cell: CellAddr = { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellIdx };
          let count = 0;
          try { count = engine.cellParagraphCount(t.sectionIdx, cell); } catch { continue; }
          for (let cp = 0; cp < count; cp++) {
            const text = engine.text(t.sectionIdx, cp, cell);
            if (text) yield { sectionIdx: t.sectionIdx, paraIdx: cp, text, cell };
          }
        }
      }
    },
  };
}

/** 앵커 인자가 있으면 해석한다 */
function optAnchor(w: WriteScope, args: Record<string, unknown>): ResolvedAnchor | null {
  const parsed = parseAnchorArgs(args);
  if (!parsed) return null;
  const scope = buildAnchorScope(args, parsed.within);
  const anchor = resolveAnchor(engineMatchSource(w.engine), parsed, scope, (t, r) => w.batchNote(t, r));
  w.requireRevisionAnchored(args, anchor);
  return anchor;
}

function anchorReplaceOnly(m: ResolvedAnchor, tool: string): void {
  if ((m.position ?? 'replace') !== 'replace') {
    throw invalidArgs(`${m.via === 'find' ? 'position' : 'anchor.position'} must be "replace" for ${tool} — the match itself is the range (got ${JSON.stringify(m.position)}); to add text beside the match use insert_text`);
  }
}

function requireText(args: Record<string, unknown>, tool: string, allowEmpty: boolean): string {
  const text = args['text'];
  if (typeof text !== 'string') throw invalidArgs(`${tool} needs text (a string)`);
  if (!allowEmpty && text.length === 0) throw invalidArgs(`${tool} text must not be empty — to delete use delete_range`);
  if (text.length > 10000) throw invalidArgs(`${tool} text is limited to 10000 characters per call`);
  return text;
}

// ─── 텍스트 ───────────────────────────────────────────

const insertText: WriteHandler = (w, args) => {
  const text = requireText(args, 'insert_text', false);
  const anchor = optAnchor(w, args);
  const { engine } = w;
  let sectionIdx: number;
  let paraIdx: number;
  let offset: number;
  let cell: CellAddr | undefined;
  let extra: Record<string, unknown> = {};
  if (anchor) {
    sectionIdx = anchor.sectionIdx;
    paraIdx = anchor.paraIdx;
    cell = anchor.cell;
    const position = anchor.position ?? 'after';
    if (position === 'replace') {
      const removed = engine.text(sectionIdx, paraIdx, cell, anchor.charOffset, anchor.length);
      w.noteRemoval(removed);
      engine.replaceInParagraph(sectionIdx, paraIdx, anchor.charOffset, anchor.length, text, cell);
      const newParas = (text.match(/\n/g) ?? []).length;
      w.touches.push(textTouch(sectionIdx, paraIdx, paraIdx + newParas, newParas, cell, anchor.charOffset));
      return { anchor: anchorEcho(anchor), replaced: removed };
    }
    offset = position === 'before' ? anchor.charOffset : anchor.charOffset + anchor.length;
    extra = { anchor: anchorEcho(anchor) };
  } else {
    sectionIdx = sectionOf(engine, args, 'insert_text');
    cell = optCell(args);
    const rawPara = reqInt(args, 'paraIdx');
    const shift = w.requireRevision(args, sectionIdx, cell ? cell.paraIdx : rawPara, cell ? cell.paraIdx : rawPara);
    if (cell) cell.paraIdx += shift;
    paraIdx = cell ? rawPara : rawPara + shift;
    const given = optInt(args, 'charOffset');
    const len = validateAddress(engine, sectionIdx, paraIdx, given, cell);
    offset = given ?? len;
    if (shift !== 0) extra = { rebasedParaShift: shift };
  }
  const end = engine.insertText(sectionIdx, paraIdx, offset, text, cell);
  w.touches.push(textTouch(sectionIdx, paraIdx, end.endPara, end.newParagraphs, cell, offset));
  return {
    ...extra,
    inserted: {
      sectionIdx, paraIdx, charOffset: offset, endParaIdx: end.endPara, endCharOffset: end.endOffset,
      ...(cell ? { cell: { paraIdx: cell.paraIdx, controlIdx: cell.controlIdx, cellIdx: cell.cellIdx } } : {}),
    },
  };
};

/** delete_range / replace_range 의 대상 범위 */
function rangeTarget(w: WriteScope, args: Record<string, unknown>, tool: string): {
  sectionIdx: number; startPara: number; startOffset: number; endPara: number; endOffset: number;
  cell?: CellAddr; anchor?: ResolvedAnchor; shift: number;
} {
  const anchor = optAnchor(w, args);
  if (anchor) {
    anchorReplaceOnly(anchor, tool);
    return {
      sectionIdx: anchor.sectionIdx, startPara: anchor.paraIdx, startOffset: anchor.charOffset,
      endPara: anchor.paraIdx, endOffset: anchor.charOffset + anchor.length, cell: anchor.cell, anchor, shift: 0,
    };
  }
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, tool);
  const cell = optCell(args);
  if (given(args['paraIdx']) && given(args['startParaIdx']) && args['paraIdx'] !== args['startParaIdx']) {
    throw invalidArgs(`startParaIdx ${String(args['startParaIdx'])} and paraIdx ${String(args['paraIdx'])} disagree — send only startParaIdx`);
  }
  const startRaw = given(args['startParaIdx']) ? reqInt(args, 'startParaIdx') : reqInt(args, 'paraIdx');
  const endRaw = optInt(args, 'endParaIdx') ?? startRaw;
  if (endRaw < startRaw) throw invalidArgs('endParaIdx must be >= startParaIdx');
  const startOffset = optInt(args, 'startCharOffset');
  const endOffset = optInt(args, 'endCharOffset');
  if (startOffset === undefined || endOffset === undefined) {
    throw invalidArgs(`${tool} needs startCharOffset and endCharOffset — or find:"exact text"`);
  }
  const shift = w.requireRevision(args, sectionIdx, cell ? cell.paraIdx : startRaw, cell ? cell.paraIdx : endRaw);
  if (cell) cell.paraIdx += shift;
  const startPara = cell ? startRaw : startRaw + shift;
  const endPara = cell ? endRaw : endRaw + shift;
  validateAddress(engine, sectionIdx, startPara, startOffset, cell);
  validateAddress(engine, sectionIdx, endPara, endOffset, cell);
  if (startPara === endPara && endOffset < startOffset) throw invalidArgs('endCharOffset must be >= startCharOffset');
  return { sectionIdx, startPara, startOffset, endPara, endOffset, cell, shift };
}

function readRange(engine: Engine, t: ReturnType<typeof rangeTarget>): string {
  const parts: string[] = [];
  for (let p = t.startPara; p <= t.endPara; p++) {
    const from = p === t.startPara ? t.startOffset : 0;
    const to = p === t.endPara ? t.endOffset : engine.length(t.sectionIdx, p, t.cell);
    parts.push(engine.text(t.sectionIdx, p, t.cell, from, to - from));
  }
  return parts.join('\n');
}

function clip200(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const deleteRange: WriteHandler = (w, args) => {
  const t = rangeTarget(w, args, 'delete_range');
  const removed = readRange(w.engine, t);
  w.noteRemoval(removed);
  w.engine.deleteRange(t.sectionIdx, t.startPara, t.startOffset, t.endPara, t.endOffset, t.cell);
  w.touches.push(textTouch(t.sectionIdx, t.startPara, t.startPara, -(t.endPara - t.startPara), t.cell, t.startOffset));
  return {
    deleted: clip200(removed),
    ...(t.anchor ? { anchor: anchorEcho(t.anchor) } : {}),
    ...(t.shift ? { rebasedParaShift: t.shift } : {}),
  };
};

const replaceRange: WriteHandler = (w, args) => {
  const text = requireText(args, 'replace_range', true);
  const t = rangeTarget(w, args, 'replace_range');
  const removed = readRange(w.engine, t);
  w.noteRemoval(removed);
  let newParas = 0;
  if (t.startPara === t.endPara) {
    w.engine.replaceInParagraph(t.sectionIdx, t.startPara, t.startOffset, t.endOffset - t.startOffset, text, t.cell);
    newParas = (text.match(/\n/g) ?? []).length;
  } else {
    w.engine.deleteRange(t.sectionIdx, t.startPara, t.startOffset, t.endPara, t.endOffset, t.cell);
    if (text.length > 0) newParas = w.engine.insertText(t.sectionIdx, t.startPara, t.startOffset, text, t.cell).newParagraphs;
  }
  w.touches.push(textTouch(t.sectionIdx, t.startPara, t.startPara + newParas, newParas - (t.endPara - t.startPara), t.cell, t.startOffset));
  return {
    replaced: clip200(removed),
    ...(t.anchor ? { anchor: anchorEcho(t.anchor) } : {}),
    ...(t.shift ? { rebasedParaShift: t.shift } : {}),
  };
};

const replaceAll: WriteHandler = (w, args) => {
  w.requireRevision(args);
  const query = reqString(args, 'query');
  if (query.length < 1) throw invalidArgs('query must be at least 1 character');
  const replacement = reqString(args, 'replacement');
  const caseSensitive = args['caseSensitive'] === true;
  const max = Math.min(Math.max(optInt(args, 'maxMatches') ?? 100, 1), 200);
  const matches = engineMatchSource(w.engine).exact(query, caseSensitive);
  const picked = matches.slice(0, max);
  // 문서 뒤쪽부터 바꿔 앞 매치 좌표가 밀리지 않게 한다 (같은 문단 안에서는 오프셋 역순).
  const ordered = [...picked].reverse();
  const newParas = (replacement.match(/\n/g) ?? []).length;
  for (const m of ordered) {
    w.engine.replaceInParagraph(m.sectionIdx, m.paraIdx, m.charOffset, m.length, replacement, m.cell);
  }
  for (const m of picked) {
    w.touches.push(textTouch(m.sectionIdx, m.paraIdx, m.paraIdx + newParas, newParas, m.cell, m.charOffset));
  }
  return { replaced: picked.length, truncated: matches.length > picked.length, remaining: matches.length - picked.length };
};

// ─── 서식 ─────────────────────────────────────────────

const PARAS_MAX_ENTRIES = 64;
const PARAS_MAX_PARAGRAPHS = 500;

/** paras:[48,[51,53]] → 정렬된 문단 목록 */
function parasTargets(w: WriteScope, args: Record<string, unknown>, tool: string): { sectionIdx: number; paras: number[]; cell?: CellAddr } | null {
  const raw = args['paras'];
  if (!given(raw)) return null;
  const clash = ['paraIdx', 'startOffset', 'endOffset', 'find', 'anchor'].filter((k) => given(args[k]));
  if (clash.length > 0) throw invalidArgs(`paras already names the target paragraphs — drop ${clash.join(', ')}, or send that target as a separate item`);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PARAS_MAX_ENTRIES) {
    throw invalidArgs(`paras must list 1..${PARAS_MAX_ENTRIES} entries, each a paragraph index or an inclusive [first, last] range, e.g. [48, [51, 53]]`);
  }
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, tool);
  const cell = optCell(args);
  const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const spans = raw.map((entry, i): [number, number] => {
    if (isIndex(entry)) return [entry, entry];
    if (Array.isArray(entry) && entry.length === 2 && isIndex(entry[0]) && isIndex(entry[1])) {
      if (entry[1] < entry[0]) throw invalidArgs(`paras[${i}] [${entry[0]}, ${entry[1]}] is reversed — send [${entry[1]}, ${entry[0]}]`);
      return [entry[0], entry[1]];
    }
    throw invalidArgs(`paras[${i}] must be a paragraph index or an inclusive [first, last] range (got ${JSON.stringify(entry)})`);
  });
  let cellShift = 0;
  if (cell) {
    cellShift = w.requireRevision(args, sectionIdx, cell.paraIdx, cell.paraIdx);
    cell.paraIdx += cellShift;
    engine.validateCell(sectionIdx, cell);
  }
  const count = engine.paragraphCountIn(sectionIdx, cell);
  const picked = new Set<number>();
  spans.forEach(([a, b], i) => {
    const shift = cell ? 0 : w.requireRevision(args, sectionIdx, a, b);
    if (b + shift >= count) throw invalidArgs(`paras[${i}] ${JSON.stringify(raw[i])} is out of range (0..${count - 1})`);
    for (let p = a + shift; p <= b + shift; p++) picked.add(p);
    if (picked.size > PARAS_MAX_PARAGRAPHS) throw invalidArgs(`paras covers more than ${PARAS_MAX_PARAGRAPHS} paragraphs — split it into several items`);
  });
  return { sectionIdx, paras: [...picked].sort((x, y) => x - y), cell };
}

function touchParas(w: WriteScope, sectionIdx: number, paras: number[], cell?: CellAddr): void {
  if (cell) {
    w.touches.push(cellHostTouch(sectionIdx, cell, paras[0], paras[paras.length - 1]));
    return;
  }
  let run: [number, number] | null = null;
  for (const p of paras) {
    if (run && run[1] === p - 1) run[1] = p;
    else {
      if (run) w.touches.push(bodyTouch(sectionIdx, run[0], run[1], 0));
      run = [p, p];
    }
  }
  if (run) w.touches.push(bodyTouch(sectionIdx, run[0], run[1], 0));
}

const applyCharFormat: WriteHandler = (w, args) => {
  const { engine } = w;
  const props = charFormatProps(args, (name) => Number(engine.call('findOrCreateFontId', name)));
  const targets = parasTargets(w, args, 'apply_char_format');
  if (targets) {
    let skippedEmpty = 0;
    for (const p of targets.paras) {
      const len = engine.length(targets.sectionIdx, p, targets.cell);
      if (len === 0) { skippedEmpty++; continue; }
      engine.applyCharFormat(targets.sectionIdx, p, 0, len, props, targets.cell);
    }
    touchParas(w, targets.sectionIdx, targets.paras, targets.cell);
    return { paragraphs: targets.paras.length - skippedEmpty, ...(skippedEmpty ? { skippedEmpty } : {}) };
  }
  const anchor = optAnchor(w, args);
  if (anchor) {
    anchorReplaceOnly(anchor, 'apply_char_format');
    engine.applyCharFormat(anchor.sectionIdx, anchor.paraIdx, anchor.charOffset, anchor.charOffset + anchor.length, props, anchor.cell);
    w.touches.push(textTouch(anchor.sectionIdx, anchor.paraIdx, anchor.paraIdx, 0, anchor.cell, anchor.charOffset));
    return { anchor: anchorEcho(anchor) };
  }
  const sectionIdx = sectionOf(engine, args, 'apply_char_format');
  const cell = optCell(args);
  const rawPara = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, cell ? cell.paraIdx : rawPara, cell ? cell.paraIdx : rawPara);
  if (cell) cell.paraIdx += shift;
  const paraIdx = cell ? rawPara : rawPara + shift;
  const len = validateAddress(engine, sectionIdx, paraIdx, undefined, cell);
  const start = optInt(args, 'startOffset');
  const end = optInt(args, 'endOffset');
  if ((start === undefined) !== (end === undefined)) throw invalidArgs('send both startOffset and endOffset, or neither for the whole paragraph');
  const s = start ?? 0;
  const e = end ?? len;
  if (e > len || e < s) throw invalidArgs(`offsets ${s}..${e} are outside paragraph ${paraIdx} (length ${len})`);
  engine.applyCharFormat(sectionIdx, paraIdx, s, e, props, cell);
  w.touches.push(textTouch(sectionIdx, paraIdx, paraIdx, 0, cell, s));
  return shift ? { rebasedParaShift: shift } : {};
};

const applyParaFormat: WriteHandler = (w, args) => {
  const { engine } = w;
  const build = (sec: number, para: number, cell?: CellAddr) => paraFormatProps(args, {
    current: () => engine.paraPropsAt(sec, para, cell),
    ensureBullet: (ch) => Number(engine.call('ensureDefaultBullet', ch)),
  });
  const targets = parasTargets(w, args, 'apply_para_format');
  if (targets) {
    for (const p of targets.paras) engine.applyParaFormat(targets.sectionIdx, p, build(targets.sectionIdx, p, targets.cell), targets.cell);
    touchParas(w, targets.sectionIdx, targets.paras, targets.cell);
    return { paragraphs: targets.paras.length };
  }
  const anchor = optAnchor(w, args);
  if (anchor) {
    let para = anchor.paraIdx;
    if (anchor.position === 'before') para -= 1;
    if (anchor.position === 'after') para += 1;
    const count = engine.paragraphCountIn(anchor.sectionIdx, anchor.cell);
    if (para < 0 || para >= count) throw invalidArgs(`position "${anchor.position}" points past the ${para < 0 ? 'first' : 'last'} paragraph`);
    engine.applyParaFormat(anchor.sectionIdx, para, build(anchor.sectionIdx, para, anchor.cell), anchor.cell);
    w.touches.push(textTouch(anchor.sectionIdx, para, para, 0, anchor.cell));
    return { anchor: anchorEcho(anchor), paraIdx: para };
  }
  const sectionIdx = sectionOf(engine, args, 'apply_para_format');
  const cell = optCell(args);
  const rawPara = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, cell ? cell.paraIdx : rawPara, cell ? cell.paraIdx : rawPara);
  if (cell) cell.paraIdx += shift;
  const paraIdx = cell ? rawPara : rawPara + shift;
  validateAddress(engine, sectionIdx, paraIdx, undefined, cell);
  engine.applyParaFormat(sectionIdx, paraIdx, build(sectionIdx, paraIdx, cell), cell);
  w.touches.push(textTouch(sectionIdx, paraIdx, paraIdx, 0, cell));
  return shift ? { rebasedParaShift: shift } : {};
};

const applyStyle: WriteHandler = (w, args) => {
  const { engine } = w;
  const styleId = reqInt(args, 'styleId');
  const styles = engine.json<Array<{ id: number }>>('getStyleList') ?? [];
  if (!styles.some((s) => s.id === styleId)) throw invalidArgs(`styleId ${styleId} does not exist — see list_styles`);
  if (given(args['cell'])) {
    throw new DoogleToolError('ENGINE_UNSUPPORTED', 'apply_style inside table cells is not available in this engine build; use apply_char_format / apply_para_format on the cell.');
  }
  const targets = parasTargets(w, args, 'apply_style');
  const paras: number[] = [];
  let sectionIdx: number;
  if (targets) {
    sectionIdx = targets.sectionIdx;
    paras.push(...targets.paras);
  } else {
    sectionIdx = sectionOf(engine, args, 'apply_style');
    const raw = reqInt(args, 'paraIdx');
    const shift = w.requireRevision(args, sectionIdx, raw, raw);
    validateAddress(engine, sectionIdx, raw + shift, undefined);
    paras.push(raw + shift);
  }
  for (const p of paras) engine.json('applyStyle', sectionIdx, p, styleId);
  touchParas(w, sectionIdx, paras);
  return { paragraphs: paras.length };
};

const LIST_FORMATS: Record<string, { level: string; numberFormat: number }> = {
  '1.': { level: '^1.', numberFormat: 0 }, '1)': { level: '^1)', numberFormat: 0 }, '(1)': { level: '(^1)', numberFormat: 0 },
  '①': { level: '^1', numberFormat: 1 }, 'a.': { level: '^1.', numberFormat: 5 }, 'a)': { level: '^1)', numberFormat: 5 },
  'A.': { level: '^1.', numberFormat: 4 }, 'A)': { level: '^1)', numberFormat: 4 }, 'I.': { level: '^1.', numberFormat: 2 },
  'i.': { level: '^1.', numberFormat: 3 }, 'i)': { level: '^1)', numberFormat: 3 }, '가.': { level: '^1.', numberFormat: 8 },
  'ㄱ.': { level: '^1.', numberFormat: 10 },
};
const TYPED_MARKER_RE = /^\s*(?:[0-9]{1,3}[.)]|\([0-9]{1,3}\)|[①-⑳]|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)]|[가-힣][.)]|[ㄱ-ㅎ][.)]|[-•·∙○●◦▪■□※*])\s+/u;

const applyList: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'apply_list');
  const startRaw = reqInt(args, 'startParaIdx');
  const endRaw = reqInt(args, 'endParaIdx');
  if (endRaw < startRaw) throw invalidArgs('endParaIdx must be >= startParaIdx');
  const shift = w.requireRevision(args, sectionIdx, startRaw, endRaw);
  const start = startRaw + shift;
  const end = endRaw + shift;
  validateAddress(engine, sectionIdx, end, undefined);
  const level = optInt(args, 'level') ?? 0;
  if (level > 6) throw invalidArgs('level must be 0..6');
  const bullet = typeof args['bulletChar'] === 'string' && (args['bulletChar'] as string).length > 0 ? args['bulletChar'] as string : null;
  let numberingId: number;
  let headType: string;
  if (bullet) {
    numberingId = Number(engine.call('ensureDefaultBullet', bullet));
    headType = 'Bullet';
  } else {
    const format = args['format'];
    if (typeof format !== 'string' || !(format in LIST_FORMATS)) {
      throw invalidArgs(`format must be one of ${Object.keys(LIST_FORMATS).join(' ')} (or pass bulletChar)`);
    }
    headType = 'Number';
    const spec = LIST_FORMATS[format];
    const startNumber = optInt(args, 'startNumber') ?? 1;
    if (format === '1.' && startNumber === 1 && level === 0 && engine.has('ensureDefaultNumbering')) {
      numberingId = Number(engine.call('ensureDefaultNumbering'));
    } else {
      const levelFormats = Array.from({ length: 7 }, (_, i) => (i === level ? spec.level.replace('^1', `^${i + 1}`) : `^${i + 1}.`));
      const numberFormats = Array.from({ length: 7 }, (_, i) => (i === level ? spec.numberFormat : i === 1 ? 8 : 0));
      numberingId = Number(engine.call('createNumbering', JSON.stringify({ levelFormats, numberFormats, startNumber })));
    }
  }
  let stripped = 0;
  for (let p = start; p <= end; p++) {
    if (args['stripMarkers'] === true) {
      const text = engine.text(sectionIdx, p);
      const m = TYPED_MARKER_RE.exec(text);
      if (m) {
        engine.deleteRange(sectionIdx, p, 0, p, scalarLength(m[0]));
        stripped++;
      }
    }
    engine.applyParaFormat(sectionIdx, p, { headType, numberingId, paraLevel: level });
  }
  w.touches.push(bodyTouch(sectionIdx, start, end, 0));
  return { numberingId, paragraphs: end - start + 1, ...(stripped ? { strippedMarkers: stripped } : {}), ...(shift ? { rebasedParaShift: shift } : {}) };
};

const setFieldValue: WriteHandler = (w, args) => {
  w.requireRevision(args);
  const name = reqString(args, 'name');
  const value = reqString(args, 'value');
  const fields = w.engine.json<Array<{ name?: string; location?: Record<string, unknown> }>>('getFieldList') ?? [];
  const field = fields.find((f) => f.name === name);
  if (!field) throw invalidArgs(`no field named ${JSON.stringify(name)} — see get_fields`);
  const r = w.engine.json<{ oldValue?: string; newValue?: string }>('setFieldValueByName', name, value);
  const loc = asRecord(field.location);
  const sec = typeof loc['sectionIdx'] === 'number' ? loc['sectionIdx'] as number : typeof loc['sec'] === 'number' ? loc['sec'] as number : 0;
  const para = typeof loc['paraIdx'] === 'number' ? loc['paraIdx'] as number : typeof loc['para'] === 'number' ? loc['para'] as number : null;
  if (para !== null) w.touches.push(bodyTouch(sec, para, para, 0));
  else w.touches.push({ sectionIdx: sec, paraStart: 0, paraEnd: 0, paraDelta: 0, wholeSection: true });
  return { oldValue: r?.oldValue, newValue: r?.newValue ?? value };
};

const insertPageBreak: WriteHandler = (w, args) => {
  const sectionIdx = sectionOf(w.engine, args, 'insert_page_break');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  validateAddress(w.engine, sectionIdx, raw + shift, undefined);
  w.engine.applyParaFormat(sectionIdx, raw + shift, { pageBreakBefore: true });
  w.touches.push(bodyTouch(sectionIdx, raw + shift, raw + shift, 0));
  return { paraIdx: raw + shift };
};

// ─── 각주·책갈피·머리말 ─────────────────────────────────

const insertFootnote: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'insert_footnote');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const offset = reqInt(args, 'charOffset');
  validateAddress(engine, sectionIdx, paraIdx, offset);
  const text = reqString(args, 'text');
  if (/[\r\n]/.test(text)) throw invalidArgs('footnote text is one paragraph — no newlines');
  const kind = args['kind'] === 'endnote' ? 'endnote' : 'footnote';
  const r = engine.json<{ paraIdx: number; controlIdx: number; footnoteNumber?: number; endnoteNumber?: number }>(
    kind === 'endnote' ? 'insertEndnote' : 'insertFootnote', sectionIdx, paraIdx, offset);
  if (text.length > 0) engine.json('insertTextInFootnote', sectionIdx, r.paraIdx, r.controlIdx, 0, 0, text);
  w.touches.push(bodyTouch(sectionIdx, paraIdx, paraIdx, 0, offset));
  return { kind, anchor: { sectionIdx, paraIdx: r.paraIdx, controlIdx: r.controlIdx }, number: r.footnoteNumber ?? r.endnoteNumber };
};

const editFootnote: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'edit_footnote');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const controlIdx = reqInt(args, 'controlIdx');
  const text = reqString(args, 'text');
  if (/[\r\n]/.test(text)) throw invalidArgs('footnote text is one paragraph — no newlines');
  let info: { paraCount: number; totalTextLen: number; texts?: string[] };
  try {
    info = engine.json('getFootnoteInfo', sectionIdx, paraIdx, controlIdx);
  } catch {
    throw invalidArgs(`no footnote/endnote at s${sectionIdx} p${paraIdx} c${controlIdx} — see list_footnotes`);
  }
  if (info.paraCount > 1) throw new DoogleToolError('NOTE_MULTIPARA', 'This note has several paragraphs; edit_footnote replaces single-paragraph notes only.');
  const old = info.texts?.[0] ?? '';
  const oldLen = scalarLength(old);
  if (oldLen > 0) engine.json('deleteTextInFootnote', sectionIdx, paraIdx, controlIdx, 0, 0, oldLen);
  if (text.length > 0) engine.json('insertTextInFootnote', sectionIdx, paraIdx, controlIdx, 0, 0, text);
  w.touches.push(bodyTouch(sectionIdx, paraIdx, paraIdx, 0));
  return { previous: old };
};

const setBookmark: WriteHandler = (w, args) => {
  const { engine } = w;
  const op = args['op'];
  const name = reqString(args, 'name');
  const marks = engine.json<Array<{ name: string; sec: number; para: number; ctrlIdx: number; charPos: number }>>('getBookmarks') ?? [];
  const existing = marks.find((m) => m.name === name);
  if (op === 'add') {
    if (existing) throw invalidArgs(`a bookmark named ${JSON.stringify(name)} already exists`);
    const sectionIdx = sectionOf(engine, args, 'set_bookmark');
    const raw = reqInt(args, 'paraIdx');
    const shift = w.requireRevision(args, sectionIdx, raw, raw);
    const offset = reqInt(args, 'charOffset');
    validateAddress(engine, sectionIdx, raw + shift, offset);
    engine.json('addBookmark', sectionIdx, raw + shift, offset, name);
    w.touches.push(bodyTouch(sectionIdx, raw + shift, raw + shift, 0, offset));
    return { op, name };
  }
  w.requireRevision(args);
  if (!existing) throw invalidArgs(`no bookmark named ${JSON.stringify(name)} — see list_bookmarks`);
  if (op === 'delete') {
    engine.json('deleteBookmark', existing.sec, existing.para, existing.ctrlIdx);
  } else if (op === 'rename') {
    const newName = reqString(args, 'newName');
    if (marks.some((m) => m.name === newName)) throw invalidArgs(`a bookmark named ${JSON.stringify(newName)} already exists`);
    engine.json('renameBookmark', existing.sec, existing.para, existing.ctrlIdx, newName);
  } else {
    throw invalidArgs('op must be add|delete|rename');
  }
  w.touches.push(bodyTouch(existing.sec, existing.para, existing.para, 0));
  return { op, name };
};

const APPLY_TO: Record<string, number> = { both: 0, even: 1, odd: 2 };

const editHeaderFooter: WriteHandler = (w, args) => {
  const { engine } = w;
  w.requireRevision(args);
  const sectionIdx = sectionOf(engine, args, 'edit_header_footer');
  const isHeader = (args['which'] ?? 'header') !== 'footer';
  const applyToName = (args['applyTo'] ?? 'both') as string;
  if (!(applyToName in APPLY_TO)) throw invalidArgs('applyTo must be both|odd|even');
  const applyTo = APPLY_TO[applyToName];
  const lines = Array.isArray(args['lines']) ? (args['lines'] as unknown[]).map(String) : [];
  const pageNumber = given(args['pageNumber']) ? asRecord(args['pageNumber']) : null;
  const current = engine.json<{ exists?: boolean }>('getHeaderFooter', sectionIdx, isHeader, applyTo);
  if (current?.exists) engine.json('deleteHeaderFooter', sectionIdx, isHeader, applyTo);
  engine.json('createHeaderFooter', sectionIdx, isHeader, applyTo);
  const paragraphs: Array<{ text: string; pageNumber?: { template: string; align: string } }> = lines.map((text) => ({ text }));
  if (pageNumber) {
    const template = typeof pageNumber['template'] === 'string' ? pageNumber['template'] as string : '{n}';
    paragraphs.push({ text: '', pageNumber: { template, align: (pageNumber['align'] as string) ?? 'center' } });
  }
  paragraphs.forEach((p, i) => {
    if (i > 0) {
      const prevLen = scalarLength(paragraphs[i - 1].text);
      engine.json('splitParagraphInHeaderFooter', sectionIdx, isHeader, applyTo, i - 1, prevLen, undefined);
    }
    if (p.pageNumber) {
      // "{n}" 현재 쪽, "{total}" 전체 쪽 — 사이 글은 그대로 넣는다
      const pieces = p.pageNumber.template.split(/(\{n\}|\{total\})/);
      let at = 0;
      for (const piece of pieces) {
        if (piece === '{n}' || piece === '{total}') {
          engine.json('insertFieldInHf', sectionIdx, isHeader, applyTo, i, at, piece === '{n}' ? 1 : 2);
          at += 1;
        } else if (piece.length > 0) {
          engine.json('insertTextInHeaderFooter', sectionIdx, isHeader, applyTo, i, at, piece);
          at += scalarLength(piece);
        }
      }
      const align = p.pageNumber.align === 'outside' ? 'right' : p.pageNumber.align;
      if (['left', 'center', 'right'].includes(align)) {
        engine.json('applyParaFormatInHf', sectionIdx, isHeader, applyTo, i, JSON.stringify({ alignment: align }));
      }
    } else if (p.text.length > 0) {
      engine.json('insertTextInHeaderFooter', sectionIdx, isHeader, applyTo, i, 0, p.text);
    }
  });
  const start = optInt(args, 'startPageNumber');
  if (start !== undefined && start > 0) {
    const def = engine.json<Record<string, unknown>>('getSectionDef', sectionIdx);
    engine.json('setSectionDef', sectionIdx, JSON.stringify({ ...def, pageNum: start }));
  }
  w.touches.push({ sectionIdx, paraStart: 0, paraEnd: 0, paraDelta: 0, wholeSection: true });
  return { which: isHeader ? 'header' : 'footer', applyTo: applyToName, paragraphs: paragraphs.length };
};

const PAPER_MM: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], B5: [182, 257], Letter: [215.9, 279.4] };

const setPageLayout: WriteHandler = (w, args) => {
  const { engine } = w;
  w.requireRevision(args);
  const sectionIdx = sectionOf(engine, args, 'set_page_layout');
  const def = engine.json<Record<string, unknown>>('getPageDef', sectionIdx);
  const next: Record<string, unknown> = { ...def };
  const paper = args['paper'];
  if (given(paper)) {
    let size: [number, number];
    if (typeof paper === 'string') {
      if (!(paper in PAPER_MM)) throw invalidArgs('paper must be A4|A3|B5|Letter or {widthMm, heightMm}');
      size = PAPER_MM[paper];
    } else {
      const p = asRecord(paper);
      if (typeof p['widthMm'] !== 'number' || typeof p['heightMm'] !== 'number') throw invalidArgs('paper must be {widthMm, heightMm}');
      size = [p['widthMm'] as number, p['heightMm'] as number];
    }
    next['width'] = mmToHu(size[0]);
    next['height'] = mmToHu(size[1]);
  }
  if (typeof args['landscape'] === 'boolean') next['landscape'] = args['landscape'];
  const margins = given(args['marginsMm']) ? asRecord(args['marginsMm']) : {};
  for (const [k, key] of [['left', 'marginLeft'], ['right', 'marginRight'], ['top', 'marginTop'], ['bottom', 'marginBottom'],
    ['header', 'marginHeader'], ['footer', 'marginFooter']] as const) {
    const v = margins[k];
    if (!given(v)) continue;
    if (typeof v !== 'number' || v < 0 || v > 200) throw invalidArgs(`marginsMm.${k} must be 0..200`);
    next[key] = mmToHu(v);
  }
  engine.json('setPageDef', sectionIdx, JSON.stringify(next));
  const columns = given(args['columns']) ? asRecord(args['columns']) : null;
  if (columns) {
    const count = columns['count'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 255) throw invalidArgs('columns.count must be 1..255');
    const spacing = typeof columns['spacingMm'] === 'number' ? mmToHu(columns['spacingMm'] as number) : mmToHu(8);
    engine.json('setColumnDef', sectionIdx, count, 0, 1, spacing);
  }
  w.touches.push({ sectionIdx, paraStart: 0, paraEnd: 0, paraDelta: 0, wholeSection: true });
  return { sectionIdx };
};

// ─── 표 ───────────────────────────────────────────────

const createTable: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'create_table');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const offset = reqInt(args, 'charOffset');
  validateAddress(engine, sectionIdx, paraIdx, offset);
  const cells = Array.isArray(args['cells']) ? (args['cells'] as unknown[]).map((r) => (Array.isArray(r) ? r.map(String) : [])) : null;
  const rows = optInt(args, 'rows') ?? cells?.length ?? 0;
  const cols = optInt(args, 'cols') ?? Math.max(0, ...(cells ?? []).map((r) => r.length));
  if (rows < 1 || cols < 1) throw invalidArgs('create_table requires either rows+cols or a non-empty cells grid');
  if (rows * cols > 2000) throw invalidArgs('tables are limited to 2000 cells per call');
  const widths = Array.isArray(args['colWidthsMm']) ? (args['colWidthsMm'] as number[]) : null;
  if (widths && widths.length !== cols) throw invalidArgs(`colWidthsMm has ${widths.length} entries but the table has ${cols} columns`);
  const before = engine.paragraphCount(sectionIdx);
  const options: Record<string, unknown> = { sectionIdx, paraIdx, charOffset: offset, rowCount: rows, colCount: cols };
  if (widths) options['colWidths'] = widths.map(mmToHu);
  const created = engine.has('createTableEx')
    ? engine.json<{ paraIdx: number; controlIdx: number }>('createTableEx', JSON.stringify(options))
    : engine.json<{ paraIdx: number; controlIdx: number }>('createTable', sectionIdx, paraIdx, offset, rows, cols);
  engine.invalidate();
  const table = { paraIdx: created.paraIdx, controlIdx: created.controlIdx };
  if (cells) {
    cells.forEach((row, r) => row.forEach((text, c) => {
      if (!text || c >= cols || r >= rows) return;
      const cell: CellAddr = { paraIdx: table.paraIdx, controlIdx: table.controlIdx, cellIdx: r * cols + c };
      engine.insertText(sectionIdx, 0, 0, text, cell);
    }));
  }
  if (args['headerRow'] === true) {
    try { engine.json('setTableProperties', sectionIdx, table.paraIdx, table.controlIdx, JSON.stringify({ repeatHeader: true })); } catch { /* 선택 사항 */ }
    const fill = args['headerFill'];
    if (given(fill) && (typeof fill !== 'string' || !HEX_COLOR_RE.test(fill))) throw invalidArgs('headerFill must be "#RRGGBB"');
    for (let c = 0; c < cols; c++) {
      const cell: CellAddr = { paraIdx: table.paraIdx, controlIdx: table.controlIdx, cellIdx: c };
      const props: Record<string, unknown> = { isHeader: true };
      if (typeof fill === 'string') { props['fillType'] = 'solid'; props['fillColor'] = fill; }
      engine.json('setCellProperties', sectionIdx, table.paraIdx, table.controlIdx, c, JSON.stringify(props));
      if (args['headerBold'] !== false) {
        const n = engine.cellParagraphCount(sectionIdx, cell);
        for (let cp = 0; cp < n; cp++) {
          const len = engine.length(sectionIdx, cp, cell);
          if (len > 0) engine.applyCharFormat(sectionIdx, cp, 0, len, { bold: true }, cell);
        }
      }
    }
  }
  const delta = engine.paragraphCount(sectionIdx) - before;
  w.touches.push({ sectionIdx, paraStart: paraIdx, paraEnd: Math.max(paraIdx, table.paraIdx), paraDelta: delta, table });
  return { paraIdx: table.paraIdx, controlIdx: table.controlIdx, rowCount: rows, colCount: cols, cellCount: rows * cols };
};

function tableTarget(w: WriteScope, args: Record<string, unknown>, tool: string): { sectionIdx: number; paraIdx: number; controlIdx: number } {
  const sectionIdx = sectionOf(w.engine, args, tool);
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const controlIdx = reqInt(args, 'controlIdx');
  try {
    w.engine.tableDims(sectionIdx, paraIdx, controlIdx);
  } catch {
    throw invalidArgs(`s${sectionIdx} p${paraIdx} c${controlIdx} is not a table — take the address from a get_structure table line`);
  }
  return { sectionIdx, paraIdx, controlIdx };
}

function cellIdxAt(engine: Engine, t: { sectionIdx: number; paraIdx: number; controlIdx: number }, row: number, col: number): number {
  const dims = engine.tableDims(t.sectionIdx, t.paraIdx, t.controlIdx);
  for (let i = 0; i < dims.cellCount; i++) {
    const info = engine.cellInfo(t.sectionIdx, t.paraIdx, t.controlIdx, i);
    if (row >= info.row && row < info.row + info.rowSpan && col >= info.col && col < info.col + info.colSpan) return i;
  }
  throw invalidArgs(`no cell at row ${row}, col ${col} (table is ${dims.rowCount}x${dims.colCount})`);
}

function columnWidthsMm(engine: Engine, t: { sectionIdx: number; paraIdx: number; controlIdx: number }): { widths: number[]; cells: Array<{ cellIdx: number; col: number; colSpan: number; width: number }> } {
  const dims = engine.tableDims(t.sectionIdx, t.paraIdx, t.controlIdx);
  const widths: number[] = Array(dims.colCount).fill(0);
  const cells: Array<{ cellIdx: number; col: number; colSpan: number; width: number }> = [];
  for (let i = 0; i < dims.cellCount; i++) {
    const info = engine.cellInfo(t.sectionIdx, t.paraIdx, t.controlIdx, i);
    const props = engine.json<{ width?: number }>('getCellProperties', t.sectionIdx, t.paraIdx, t.controlIdx, i);
    const width = props?.width ?? 0;
    cells.push({ cellIdx: i, col: info.col, colSpan: info.colSpan, width });
    if (info.colSpan === 1 && widths[info.col] === 0) widths[info.col] = width;
  }
  return { widths, cells };
}

/** 열 너비(HU)를 맞춘다 — 셀마다 차이를 resizeTableCells 로 보낸다 */
function resizeColumns(engine: Engine, t: { sectionIdx: number; paraIdx: number; controlIdx: number }, target: number[]): void {
  const { cells } = columnWidthsMm(engine, t);
  const updates = cells.map((c) => {
    const want = target.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0);
    return { cellIdx: c.cellIdx, widthDelta: Math.round(want - c.width) };
  }).filter((u) => u.widthDelta !== 0);
  if (updates.length > 0) engine.json('resizeTableCells', t.sectionIdx, t.paraIdx, t.controlIdx, JSON.stringify(updates));
}

const editTable: WriteHandler = (w, args) => {
  const { engine } = w;
  const t = tableTarget(w, args, 'edit_table');
  const op = args['op'];
  const { sectionIdx, paraIdx, controlIdx } = t;
  const dims = engine.tableDims(sectionIdx, paraIdx, controlIdx);
  const idx = (key: string, max: number): number => {
    const v = reqInt(args, key);
    if (v >= max) throw invalidArgs(`${key} ${v} is out of range (0..${max - 1})`);
    return v;
  };
  let note: string | undefined;
  switch (op) {
    case 'insert_row': engine.json('insertTableRow', sectionIdx, paraIdx, controlIdx, idx('rowIdx', dims.rowCount), args['below'] !== false); break;
    case 'insert_col': engine.json('insertTableColumn', sectionIdx, paraIdx, controlIdx, idx('colIdx', dims.colCount), args['right'] !== false); break;
    case 'delete_row':
      if (dims.rowCount <= 1) throw invalidArgs('cannot delete the only row — use delete_table');
      engine.json('deleteTableRow', sectionIdx, paraIdx, controlIdx, idx('rowIdx', dims.rowCount)); break;
    case 'delete_col':
      if (dims.colCount <= 1) throw invalidArgs('cannot delete the only column — use delete_table');
      engine.json('deleteTableColumn', sectionIdx, paraIdx, controlIdx, idx('colIdx', dims.colCount)); break;
    case 'merge_cells': {
      const sr = idx('startRow', dims.rowCount); const sc = idx('startCol', dims.colCount);
      const er = idx('endRow', dims.rowCount); const ec = idx('endCol', dims.colCount);
      if (er < sr || ec < sc) throw invalidArgs('endRow/endCol must be >= startRow/startCol');
      engine.json('mergeTableCells', sectionIdx, paraIdx, controlIdx, sr, sc, er, ec);
      break;
    }
    case 'split_cell': {
      const r = idx('rowIdx', dims.rowCount); const c = idx('colIdx', dims.colCount);
      const nr = reqInt(args, 'splitRows'); const nc = reqInt(args, 'splitCols');
      if (nr < 1 || nc < 1 || nr * nc < 2) throw invalidArgs('splitRows and splitCols must be >= 1 and split into at least 2 cells');
      engine.json('splitTableCellInto', sectionIdx, paraIdx, controlIdx, r, c, nr, nc, true, false);
      break;
    }
    case 'set_column_widths': {
      const list = args['columnWidthsMm'];
      if (!Array.isArray(list) || list.length !== dims.colCount || !list.every((v) => typeof v === 'number' && v > 0 && v <= 500)) {
        throw invalidArgs(`columnWidthsMm must list ${dims.colCount} positive widths (mm)`);
      }
      if (engine.has('setTableColumnWidths')) {
        engine.json('setTableColumnWidths', sectionIdx, paraIdx, controlIdx, Uint32Array.from((list as number[]).map(mmToHu)));
      } else {
        resizeColumns(engine, t, (list as number[]).map(mmToHu));
      }
      break;
    }
    case 'fit_to_page': {
      if (engine.has('fitTableToPage')) {
        engine.json('fitTableToPage', sectionIdx, paraIdx, controlIdx);
        break;
      }
      const def = engine.json<Record<string, number>>('getPageDef', sectionIdx);
      const body = (def['width'] ?? 0) - (def['marginLeft'] ?? 0) - (def['marginRight'] ?? 0) - (def['marginGutter'] ?? 0);
      const { widths } = columnWidthsMm(engine, t);
      const total = widths.reduce((a, b) => a + b, 0);
      if (body <= 0 || total <= 0) throw invalidArgs('could not measure the table or the page body');
      if (total <= body) { note = 'table already fits the body width'; break; }
      const scale = body / total;
      resizeColumns(engine, t, widths.map((v) => Math.floor(v * scale)));
      break;
    }
    case 'apply_formula': {
      const formula = reqString(args, 'formula');
      const cellIdx = cellIdxAt(engine, t, reqInt(args, 'row'), reqInt(args, 'col'));
      const fmt = asRecord(args['format']);
      engine.json('setTableCellFormula', sectionIdx, paraIdx, controlIdx, cellIdx, formula, JSON.stringify(fmt));
      break;
    }
    case 'set_caption': {
      // ENGINE_GAPS.md: setTableCaptionText 는 agent A 가 이식 중 — 없으면 engine.json 이 ENGINE_UNSUPPORTED
      const text = reqString(args, 'text');
      const r = engine.json<{ captionText?: string }>('setTableCaptionText', sectionIdx, paraIdx, controlIdx, text, args['withNumber'] !== false);
      if (typeof r?.captionText === 'string') note = `caption: ${r.captionText}`;
      break;
    }
    default:
      throw invalidArgs('op must be insert_row|insert_col|delete_row|delete_col|merge_cells|split_cell|set_column_widths|fit_to_page|apply_formula|set_caption');
  }
  engine.invalidate();
  const after = engine.tableDims(sectionIdx, paraIdx, controlIdx);
  w.touches.push({ sectionIdx, paraStart: paraIdx, paraEnd: paraIdx, paraDelta: 0, table: { paraIdx, controlIdx } });
  return { rowCount: after.rowCount, colCount: after.colCount, cellCount: after.cellCount, ...(note ? { note } : {}) };
};

const setTableProps: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'set_table_props');
  const props = parseTableProps(asRecord(args['tableProps']));
  w.engine.json('setTableProperties', t.sectionIdx, t.paraIdx, t.controlIdx, JSON.stringify(props));
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: 0, table: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } });
  return {};
};

const setCellProps: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'set_cell_props');
  const cellIdx = reqInt(args, 'cellIdx');
  const dims = w.engine.tableDims(t.sectionIdx, t.paraIdx, t.controlIdx);
  if (cellIdx >= dims.cellCount) throw invalidArgs(`cellIdx ${cellIdx} is out of range (0..${dims.cellCount - 1})`);
  const props = parseCellProps(asRecord(args['cellProps']));
  w.engine.json('setCellProperties', t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx, JSON.stringify(props));
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: 0, table: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } });
  return {};
};

const setZoneBorders: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'set_zone_borders');
  const dims = w.engine.tableDims(t.sectionIdx, t.paraIdx, t.controlIdx);
  const corner = (key: string) => {
    const c = asRecord(args[key]);
    const row = c['row']; const col = c['col'];
    if (typeof row !== 'number' || typeof col !== 'number' || row < 0 || col < 0 || row >= dims.rowCount || col >= dims.colCount) {
      throw invalidArgs(`${key} must be {row, col} inside the ${dims.rowCount}x${dims.colCount} table`);
    }
    return { row, col };
  };
  const s = corner('startCell');
  const e = corner('endCell');
  const props: Record<string, unknown> = {};
  for (const key of ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const) {
    if (!given(args[key])) continue;
    const b = asRecord(args[key]);
    if (typeof b['color'] !== 'string' || !HEX_COLOR_RE.test(b['color'] as string)) throw invalidArgs(`${key}.color must be "#RRGGBB"`);
    props[key] = { type: b['type'], width: b['width'], color: b['color'] };
  }
  if (typeof args['fillColor'] === 'string') { props['fillType'] = 'solid'; props['fillColor'] = args['fillColor']; }
  for (const key of ['diagonalLine', 'diagonalSlash', 'diagonalBackSlash', 'diagonalWidth', 'diagonalColor', 'centerLine']) {
    if (given(args[key])) props[key] = args[key];
  }
  if (Object.keys(props).length === 0) throw invalidArgs('set_zone_borders needs at least one border, fillColor, diagonal or centerLine');
  w.engine.json('setCellZoneProperties', t.sectionIdx, t.paraIdx, t.controlIdx,
    Math.min(s.row, e.row), Math.min(s.col, e.col), Math.max(s.row, e.row), Math.max(s.col, e.col), JSON.stringify(props));
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: 0, table: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } });
  return {};
};

const deleteTable: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'delete_table');
  const before = w.engine.paragraphCount(t.sectionIdx);
  w.engine.json('deleteTableControl', t.sectionIdx, t.paraIdx, t.controlIdx);
  w.engine.invalidate();
  const delta = w.engine.paragraphCount(t.sectionIdx) - before;
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: delta });
  return { deleted: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } };
};

// ─── 개체 ─────────────────────────────────────────────

const insertEquation: WriteHandler = (w, args) => {
  const { engine } = w;
  if (given(args['cell'])) throw new DoogleToolError('ENGINE_UNSUPPORTED', 'insert_equation inside table cells is not available in this engine build.');
  const sectionIdx = sectionOf(engine, args, 'insert_equation');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const offset = reqInt(args, 'charOffset');
  validateAddress(engine, sectionIdx, paraIdx, offset);
  const script = reqString(args, 'script');
  let sizePt = typeof args['fontSizePt'] === 'number' ? args['fontSizePt'] as number : NaN;
  if (!Number.isFinite(sizePt)) {
    try { sizePt = ((engine.charPropsAt(sectionIdx, paraIdx, Math.max(0, offset - 1))['fontSize'] as number) ?? 1000) / 100; } catch { sizePt = 10; }
  }
  const color = typeof args['color'] === 'string' ? colorRef(args['color'] as string) : 0;
  const r = engine.json<{ paraIdx?: number; controlIdx?: number }>('insertEquation', sectionIdx, paraIdx, offset, script, Math.round(sizePt * 100), color);
  w.touches.push(bodyTouch(sectionIdx, paraIdx, paraIdx, 0, offset));
  return { paraIdx: r?.paraIdx ?? paraIdx, controlIdx: r?.controlIdx };
};

const RELATIVE_TO: Record<string, string> = { paper: 'Paper', page: 'Page', column: 'Column', paragraph: 'Para' };
const WRAP: Record<string, string> = { square: 'Square', topAndBottom: 'TopAndBottom', behindText: 'BehindText', inFrontOfText: 'InFrontOfText' };

const insertShape: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'insert_shape');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const offset = optInt(args, 'charOffset') ?? 0;
  validateAddress(engine, sectionIdx, paraIdx, offset);
  const shape = args['shape'];
  const width = args['widthMm']; const height = args['heightMm'];
  if (typeof width !== 'number' || typeof height !== 'number' || width < 0 || height < 0) throw invalidArgs('widthMm and heightMm must be non-negative numbers');
  const json: Record<string, unknown> = {
    sectionIdx, paraIdx, charOffset: offset,
    width: mmToHu(Math.max(width, 0.1)), height: mmToHu(Math.max(height, 0.1)),
    horzOffset: mmToHu(typeof args['xMm'] === 'number' ? args['xMm'] as number : 0),
    vertOffset: mmToHu(typeof args['yMm'] === 'number' ? args['yMm'] as number : 0),
    treatAsChar: false,
    textWrap: WRAP[(args['wrap'] as string) ?? 'inFrontOfText'] ?? 'InFrontOfText',
    horzRelTo: RELATIVE_TO[(args['relativeTo'] as string) ?? 'paragraph'] ?? 'Para',
    vertRelTo: RELATIVE_TO[(args['relativeTo'] as string) ?? 'paragraph'] ?? 'Para',
    shapeType: shape === 'textBox' ? 'textbox' : shape,
  };
  if (shape === 'line') {
    // 선은 상자의 모서리에서 모서리로 — 높이 0 이면 수평선
    json['lineFlipY'] = false;
  }
  for (const key of ['strokeColor', 'fillColor'] as const) {
    if (given(args[key])) {
      if (typeof args[key] !== 'string' || !HEX_COLOR_RE.test(args[key] as string)) throw invalidArgs(`${key} must be "#RRGGBB"`);
      json[key === 'strokeColor' ? 'lineColor' : 'fillColor'] = args[key];
    }
  }
  if (!['line', 'rectangle', 'ellipse', 'textBox'].includes(String(shape))) throw invalidArgs('shape must be line|rectangle|ellipse|textBox');
  const r = engine.json<{ paraIdx: number; controlIdx: number }>('createShapeControl', JSON.stringify(json));
  engine.invalidate();
  w.touches.push(bodyTouch(sectionIdx, paraIdx, paraIdx, 0, offset));
  const out: Record<string, unknown> = { paraIdx: r.paraIdx, controlIdx: r.controlIdx };
  if (shape === 'textBox') {
    out['cell'] = { paraIdx: r.paraIdx, controlIdx: r.controlIdx, cellIdx: 0 };
    out['cellPath'] = [{ controlIndex: r.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
  }
  return out;
};

const editObject: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'edit_object');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const controlIdx = reqInt(args, 'controlIdx');
  if (given(args['cell'])) throw new DoogleToolError('ENGINE_UNSUPPORTED', 'edit_object inside table cells is not available in this engine build.');
  const obj = engine.objects().find((o) => o.sectionIdx === sectionIdx && o.paraIdx === paraIdx && o.controlIdx === controlIdx);
  if (!obj || obj.kind === 'table') throw invalidArgs(`s${sectionIdx} p${paraIdx} c${controlIdx} is not a picture or shape — take the address from get_page_geometry objects`);
  const isPicture = obj.kind === 'picture';
  if (args['delete'] === true) {
    engine.json(isPicture ? 'deletePictureControl' : 'deleteShapeControl', sectionIdx, paraIdx, controlIdx);
    engine.invalidate();
    w.touches.push(bodyTouch(sectionIdx, paraIdx, paraIdx, 0));
    return { deleted: true };
  }
  const current = engine.json<Record<string, unknown>>(isPicture ? 'getPictureProperties' : 'getShapeProperties', sectionIdx, paraIdx, controlIdx);
  const props: Record<string, unknown> = {};
  if (given(args['positionMode'])) props['treatAsChar'] = args['positionMode'] === 'inline';
  const floating = ['xMm', 'yMm', 'relativeTo', 'wrap'].some((k) => given(args[k]));
  if (floating && !given(args['positionMode'])) props['treatAsChar'] = false;
  if (typeof args['xMm'] === 'number') props['horzOffset'] = mmToHu(args['xMm'] as number);
  if (typeof args['yMm'] === 'number') props['vertOffset'] = mmToHu(args['yMm'] as number);
  if (typeof args['relativeTo'] === 'string') { props['horzRelTo'] = RELATIVE_TO[args['relativeTo'] as string]; props['vertRelTo'] = RELATIVE_TO[args['relativeTo'] as string]; }
  else if (floating) { props['horzRelTo'] = 'Para'; props['vertRelTo'] = 'Para'; }
  if (typeof args['wrap'] === 'string') props['textWrap'] = WRAP[args['wrap'] as string];
  else if (floating && !given(current['textWrap'])) props['textWrap'] = 'Square';
  const w0 = typeof current['width'] === 'number' ? current['width'] as number : 0;
  const h0 = typeof current['height'] === 'number' ? current['height'] as number : 0;
  const wMm = args['widthMm']; const hMm = args['heightMm'];
  const keep = args['keepAspect'] !== false;
  if (typeof wMm === 'number') props['width'] = mmToHu(wMm);
  if (typeof hMm === 'number') props['height'] = mmToHu(hMm);
  if (keep && w0 > 0 && h0 > 0) {
    if (typeof wMm === 'number' && typeof hMm !== 'number') props['height'] = Math.round((props['width'] as number) * h0 / w0);
    if (typeof hMm === 'number' && typeof wMm !== 'number') props['width'] = Math.round((props['height'] as number) * w0 / h0);
  }
  if (given(args['cropMm'])) {
    if (!isPicture) throw invalidArgs('cropMm applies to pictures only');
    const c = asRecord(args['cropMm']);
    for (const [side, key] of [['left', 'cropLeft'], ['right', 'cropRight'], ['top', 'cropTop'], ['bottom', 'cropBottom']] as const) {
      if (typeof c[side] === 'number') props[key] = ((current[key] as number) ?? 0) + mmToHu(c[side] as number);
    }
  }
  if (Object.keys(props).length > 0) {
    engine.json(isPicture ? 'setPictureProperties' : 'setShapeProperties', sectionIdx, paraIdx, controlIdx, JSON.stringify(props));
  }
  if (typeof args['zOrder'] === 'string') {
    const map: Record<string, string> = { front: 'front', back: 'back', forward: 'forward', backward: 'backward' };
    engine.json('changeShapeZOrder', sectionIdx, paraIdx, controlIdx, map[args['zOrder'] as string]);
  }
  if (Object.keys(props).length === 0 && !given(args['zOrder'])) throw invalidArgs('edit_object needs at least one change (position, size, wrap, crop, zOrder or delete)');
  w.touches.push(bodyTouch(sectionIdx, paraIdx, paraIdx, 0));
  return { kind: obj.kind };
};

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new DoogleToolError('RENDER_UNAVAILABLE', 'base64 decoding is unavailable in this host');
}

const insertImage: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'insert_image');
  const cell = optCell(args);
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, cell ? cell.paraIdx : raw, cell ? cell.paraIdx : raw);
  if (cell) cell.paraIdx += shift;
  const paraIdx = cell ? raw : raw + shift;
  const offset = reqInt(args, 'charOffset');
  validateAddress(engine, sectionIdx, paraIdx, offset, cell);
  const b64 = args['imageBase64'];
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw invalidArgs('insert_image needs imageBase64 (the hub converts imagePath before it reaches the studio)');
  }
  const bytes = decodeBase64(b64);
  if (bytes.length > IMAGE_MAX_BYTES) throw invalidArgs('image is larger than 5MB');
  const ext = String(args['extension'] ?? 'png').toLowerCase();
  const nw = typeof args['naturalWidthPx'] === 'number' ? args['naturalWidthPx'] as number : 0;
  const nh = typeof args['naturalHeightPx'] === 'number' ? args['naturalHeightPx'] as number : 0;
  if (nw <= 0 || nh <= 0) throw invalidArgs('insert_image needs naturalWidthPx and naturalHeightPx (> 0)');
  // 96dpi 원래 크기, 본문 폭으로 제한
  let widthHu = Math.round(nw * 75);
  let heightHu = Math.round(nh * 75);
  const def = engine.json<Record<string, number>>('getPageDef', sectionIdx);
  const bodyHu = (def['width'] ?? 0) - (def['marginLeft'] ?? 0) - (def['marginRight'] ?? 0);
  const wMm = args['widthMm']; const hMm = args['heightMm'];
  if (typeof wMm === 'number' && typeof hMm === 'number') { widthHu = mmToHu(wMm); heightHu = mmToHu(hMm); }
  else if (typeof wMm === 'number') { heightHu = Math.round(mmToHu(wMm) * heightHu / widthHu); widthHu = mmToHu(wMm); }
  else if (typeof hMm === 'number') { widthHu = Math.round(mmToHu(hMm) * widthHu / heightHu); heightHu = mmToHu(hMm); }
  else if (bodyHu > 0 && widthHu > bodyHu) { heightHu = Math.round(heightHu * bodyHu / widthHu); widthHu = bodyHu; }
  const pathJson = cell ? JSON.stringify(engine.cellPath(cell, paraIdx)) : '';
  const r = engine.json<{ paraIdx: number; controlIdx: number }>('insertPicture',
    sectionIdx, cell ? cell.paraIdx : paraIdx, offset, pathJson, bytes, widthHu, heightHu, nw, nh, ext, String(args['description'] ?? ''), undefined, undefined);
  engine.invalidate();
  if (args['positionMode'] === 'floating') {
    const props: Record<string, unknown> = {
      treatAsChar: false,
      textWrap: WRAP[(args['wrap'] as string) ?? 'square'] ?? 'Square',
      horzRelTo: RELATIVE_TO[(args['relativeTo'] as string) ?? 'paragraph'] ?? 'Para',
      vertRelTo: RELATIVE_TO[(args['relativeTo'] as string) ?? 'paragraph'] ?? 'Para',
      horzOffset: mmToHu(typeof args['xMm'] === 'number' ? args['xMm'] as number : 0),
      vertOffset: mmToHu(typeof args['yMm'] === 'number' ? args['yMm'] as number : 0),
    };
    engine.json('setPictureProperties', sectionIdx, r.paraIdx, r.controlIdx, JSON.stringify(props));
  }
  w.touches.push(textTouch(sectionIdx, paraIdx, paraIdx, 0, cell, offset));
  return { paraIdx: r.paraIdx, controlIdx: r.controlIdx, widthMm: Math.round(widthHu / 2.8346) / 100, heightMm: Math.round(heightHu / 2.8346) / 100 };
};

export const WRITE_HANDLERS: Readonly<Record<string, WriteHandler>> = Object.freeze({
  insert_text: insertText,
  delete_range: deleteRange,
  replace_range: replaceRange,
  replace_all: replaceAll,
  apply_char_format: applyCharFormat,
  apply_para_format: applyParaFormat,
  apply_style: applyStyle,
  apply_list: applyList,
  set_field_value: setFieldValue,
  insert_page_break: insertPageBreak,
  insert_footnote: insertFootnote,
  edit_footnote: editFootnote,
  set_bookmark: setBookmark,
  edit_header_footer: editHeaderFooter,
  set_page_layout: setPageLayout,
  create_table: createTable,
  edit_table: editTable,
  set_table_props: setTableProps,
  set_cell_props: setCellProps,
  set_zone_borders: setZoneBorders,
  delete_table: deleteTable,
  insert_equation: insertEquation,
  edit_object: editObject,
  insert_shape: insertShape,
  insert_image: insertImage,
});

/** apply_edits 항목으로 받는 도구 — doogle-agent/src/tools/definitions.mjs BATCHABLE_EDIT_TOOL_NAMES 와 같아야 한다 */
export const BATCHABLE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  'insert_text', 'delete_range', 'replace_range', 'apply_char_format', 'apply_para_format', 'apply_style', 'apply_list',
  'set_field_value', 'insert_page_break', 'insert_footnote', 'edit_footnote', 'set_bookmark', 'edit_header_footer',
  'set_page_layout', 'create_table', 'edit_table', 'set_table_props', 'set_cell_props', 'set_zone_borders', 'delete_table',
  'insert_equation', 'edit_object', 'insert_shape',
]);
