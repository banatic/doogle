// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/tool-executor.ts (write tools)
/**
 * 쓰기 도구 본문. 각 핸들러는 transaction 안에서 한 번 불리고(전체 모드 = undo 한 단계,
 * 에이전트 모드 = 스테이징 한 묶음), 던지면 문서는 호출 전으로 돌아간다. 좌표 검사·리베이스·앵커
 * 해석은 WriteScope 가 실행기에서 받아 온다.
 */
import { Engine, type TableRef } from './engine-adapter.ts';
import {
  anchorEcho, buildAnchorScope, matchFromSearchHit, parseAnchorArgs, resolveAnchor,
  type MatchSource, type ResolvedAnchor, type SourceParagraph, type TextMatch,
} from './anchor.ts';
import { charFormatProps, paraFormatProps, parseCellProps, parseTableProps } from './format-args.ts';
import {
  DoogleToolError, HEX_COLOR_RE, asRecord, colorRef, huToMm, invalidArgs, mmToHu, scalarLength,
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
  /** 한 표의 여러 셀 (서식을 한꺼번에 바꾼 경우) — after 보고·crop 은 이 셀들만 본다 */
  tableCells?: CellAddr[];
  /** 구역 전체 (쪽 설정·머리말 등) — 저널에 정밀 기록하지 않는다 */
  wholeSection?: boolean;
  /** 문단 수는 그대로지만 [paraStart, paraEnd] 안의 문단 순서가 바뀌었다 (move_paragraphs) */
  reorders?: boolean;
  /** (after.indexShift) 번호가 바뀐 첫 문단 — 없으면 paraEnd + 1. 문단을 통째로 지우면 그 자리(paraStart)부터다 */
  shiftFrom?: number;
  /** apply_edits 묶음에서 이 자리를 만든 항목 번호 (검토 목록이 항목별로 묶어 보인다) */
  item?: number;
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
  /** 표를 바꾸기 직전에 부른다 — 쓰기 뒤 넘침 경고를 "새로 생긴 넘침"으로만 좁히는 기준점 */
  noteTableBefore?(sectionIdx: number, paraIdx: number, controlIdx: number): void;
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

/** 머리말·꼬리말 안을 살필 표 깊이·셀 수 한도 */
const HF_TABLE_MAX_DEPTH = 3;
const HF_CELL_LIMIT = 400;

/**
 * 머리말·꼬리말의 글 문단 — 그 문단 자체(cell = 머리말·꼬리말, 경로 없음)와 그 안 표 셀(cell + 경로).
 * 엔진 searchAllText 는 머리말·꼬리말을 찾지 않으므로 앵커·find_text 가 여기서 따로 찾는다.
 */
export function headerFooterParagraphs(engine: Engine): SourceParagraph[] {
  const out: SourceParagraph[] = [];
  let budget = HF_CELL_LIMIT;
  const walkCell = (sectionIdx: number, cell: CellAddr, depth: number): void => {
    if (budget-- <= 0) return;
    let count = 0;
    try { count = engine.cellParagraphCount(sectionIdx, cell); } catch { return; }
    for (let p = 0; p < count; p++) {
      let text = '';
      try { text = engine.text(sectionIdx, p, cell); } catch { text = ''; }
      if (text) out.push({ sectionIdx, paraIdx: p, text, cell });
    }
    if (depth >= HF_TABLE_MAX_DEPTH) return;
    for (const tablePath of engine.nestedTables(sectionIdx, cell)) {
      let dims;
      try { dims = engine.tableDimsByPath(sectionIdx, cell.paraIdx, tablePath); } catch { continue; }
      for (let c = 0; c < dims.cellCount; c++) {
        const path = tablePath.map((e) => ({ ...e }));
        path[path.length - 1] = { ...path[path.length - 1], cellIndex: c, cellParaIndex: 0 };
        walkCell(sectionIdx, { paraIdx: cell.paraIdx, controlIdx: path[0].controlIndex, cellIdx: path[0].cellIndex, path }, depth + 1);
      }
    }
  };
  for (const hf of engine.headerFooters()) {
    walkCell(hf.sectionIdx, { paraIdx: hf.paraIdx, controlIdx: hf.controlIdx, cellIdx: 0 }, 0);
  }
  return out;
}

/** 엔진 위의 앵커 검색 원천 — 정확 일치는 searchAllText(중첩 셀 포함) + 머리말·꼬리말, 재검색은 본문+최상위 셀+머리말·꼬리말 */
export function engineMatchSource(engine: Engine): MatchSource {
  const textOf = (m: TextMatch): string => {
    try { return engine.text(m.sectionIdx, m.paraIdx, m.cell); } catch { return ''; }
  };
  let hfMemo: SourceParagraph[] | null = null;
  const hfParagraphs = (): SourceParagraph[] => (hfMemo ??= headerFooterParagraphs(engine));
  return {
    exact(query, caseSensitive) {
      const hits = engine.json<Array<Parameters<typeof matchFromSearchHit>[0]>>('searchAllText', query, caseSensitive, true) ?? [];
      const out = hits.map((hit) => {
        const m = matchFromSearchHit(hit, '');
        const text = textOf(m);
        const chars = [...text];
        m.context = chars.slice(Math.max(0, m.charOffset - 30), m.charOffset + m.length + 30).join('');
        return m;
      });
      const needle = caseSensitive ? query : query.toLowerCase();
      for (const p of hfParagraphs()) {
        const hay = caseSensitive ? p.text : p.text.toLowerCase();
        for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + Math.max(1, needle.length))) {
          const charOffset = scalarLength(p.text.slice(0, i));
          const length = scalarLength(query);
          const chars = [...p.text];
          out.push({
            sectionIdx: p.sectionIdx, paraIdx: p.paraIdx, charOffset, length,
            context: chars.slice(Math.max(0, charOffset - 30), charOffset + length + 30).join(''),
            ...(p.cell ? { cell: p.cell, ...(p.cell.path ? { cellPath: p.cell.path } : {}) } : {}),
          });
        }
      }
      return out;
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
      yield* hfParagraphs();
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
    if (given === undefined && !cell) {
      // 오프셋 없이 "문단 끝"에 덧붙일 때, 끝자리에 놓인 표·그림·도형이 있으면 글은 그 개체 앞에 들어간다.
      const trailing = engine.objectsIn(sectionIdx, paraIdx, paraIdx).filter((o) => o.kind !== 'equation' && o.charOffset >= len);
      if (trailing.length > 0) {
        throw new DoogleToolError(
          'OBJECT_AT_PARAGRAPH_END',
          `paragraph p${paraIdx} ends with ${describeObjects(trailing)}; text appended here would land BEFORE it. `
            + `To add paragraphs after it use insert_paragraphs {paraIdx:${paraIdx}, paragraphs:[…]}; to type before it pass charOffset:${len} explicitly.`,
        );
      }
    }
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
    if (!anchor.cell) {
      refuseObjectsInRange(w.engine, tool, anchor.sectionIdx, anchor.paraIdx, anchor.charOffset, anchor.paraIdx, anchor.charOffset + anchor.length);
    }
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
  if (!cell) refuseObjectsInRange(engine, tool, sectionIdx, startPara, startOffset, endPara, endOffset);
  return { sectionIdx, startPara, startOffset, endPara, endOffset, cell, shift };
}

function describeObjects(objects: Array<{ kind: string; sectionIdx: number; paraIdx: number; controlIdx: number }>): string {
  return objects.slice(0, 4).map((o) => `${o.kind} s${o.sectionIdx} p${o.paraIdx} c${o.controlIdx}`).join(', ')
    + (objects.length > 4 ? ` (+${objects.length - 4} more)` : '');
}

/**
 * 본문 범위 안에 놓인 개체(표·그림·도형·수식)를 찾는다. 개체는 글자 오프셋을 차지하지 않아 범위의 양 끝이
 * 모호하다 — 여러 문단을 잇는 삭제는 끝 문단의 오프셋 0 에 걸린 표까지 지운다. 그래서 여러 문단 범위는 양 끝을
 * 포함으로, 한 문단 범위는 [start, end) 로 본다.
 */
function objectsInRange(engine: Engine, sectionIdx: number, startPara: number, startOffset: number, endPara: number, endOffset: number) {
  if (startPara === endPara && startOffset === endOffset) return [];
  return engine.objectsIn(sectionIdx, startPara, endPara).filter((o) => {
    if (startPara === endPara) return o.charOffset >= startOffset && o.charOffset < endOffset;
    if (o.paraIdx === startPara) return o.charOffset >= startOffset;
    if (o.paraIdx === endPara) return o.charOffset <= endOffset;
    return true;
  });
}

/** 글 범위 도구는 개체를 지우지 않는다 — 걸리면 고칠 방법과 함께 거절한다. */
function refuseObjectsInRange(engine: Engine, tool: string, sectionIdx: number, startPara: number, startOffset: number, endPara: number, endOffset: number): void {
  const hit = objectsInRange(engine, sectionIdx, startPara, startOffset, endPara, endOffset);
  if (hit.length === 0) return;
  const atEnd = hit.every((o) => o.paraIdx === endPara) && endOffset === 0 && endPara > startPara;
  const prevLen = atEnd ? engine.length(sectionIdx, endPara - 1) : 0;
  throw new DoogleToolError(
    'RANGE_HAS_OBJECTS',
    `${tool} range s${sectionIdx} p${startPara}@${startOffset}..p${endPara}@${endOffset} would also delete ${describeObjects(hit)} — text ranges never remove objects. `
      + (atEnd
        ? `The range ends at offset 0 of p${endPara}, which holds that object: to remove whole paragraphs use delete_paragraphs {startParaIdx:${startPara}, endParaIdx:${endPara - 1}}`
          + ` (or end the range at p${endPara - 1}@${prevLen}).`
        : 'Narrow the range to the text itself, or remove the object explicitly (delete_table, edit_object delete:true, or delete_paragraphs with includeObjects:true).'),
    { objects: hit.map((o) => ({ kind: o.kind, sectionIdx: o.sectionIdx, paraIdx: o.paraIdx, controlIdx: o.controlIdx })) },
  );
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

const CELLS_MAX = 400;

/** [8, [9, 13]] → 정렬된 셀 번호 목록 */
function cellIndexList(raw: unknown, name: string, cellCount: number): number[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 128) {
    throw invalidArgs(`${name} must list 1..128 entries, each a cellIdx or an inclusive [first, last] range, e.g. [8, [9, 13]]`);
  }
  const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const picked = new Set<number>();
  raw.forEach((entry, i) => {
    let a: number;
    let b: number;
    if (isIndex(entry)) { a = entry; b = entry; }
    else if (Array.isArray(entry) && entry.length === 2 && isIndex(entry[0]) && isIndex(entry[1]) && entry[1] >= entry[0]) { a = entry[0]; b = entry[1]; }
    else throw invalidArgs(`${name}[${i}] must be a cellIdx or an inclusive [first, last] range (got ${JSON.stringify(entry)})`);
    if (b >= cellCount) throw invalidArgs(`${name}[${i}] ${JSON.stringify(entry)} is out of range (cellIdx 0..${cellCount - 1})`);
    for (let c = a; c <= b; c++) picked.add(c);
    if (picked.size > CELLS_MAX) throw invalidArgs(`${name} covers more than ${CELLS_MAX} cells — split it into several items`);
  });
  return [...picked].sort((x, y) => x - y);
}

/** cells:{paraIdx, controlIdx, cellIdxs:[8,[9,13]]} → 그 셀들 (셀 안 문단 전부가 대상) */
function cellsTargets(w: WriteScope, args: Record<string, unknown>, tool: string): { sectionIdx: number; cells: CellAddr[] } | null {
  const raw = args['cells'];
  if (!given(raw)) return null;
  const clash = ['paraIdx', 'paras', 'startOffset', 'endOffset', 'find', 'anchor', 'cell', 'cellPath'].filter((k) => given(args[k]));
  if (clash.length > 0) throw invalidArgs(`cells already names the target cells — drop ${clash.join(', ')}, or send that target as a separate item`);
  const c = asRecord(raw);
  for (const k of ['paraIdx', 'controlIdx']) {
    if (typeof c[k] !== 'number' || !Number.isSafeInteger(c[k]) || (c[k] as number) < 0) {
      throw invalidArgs('cells must be {paraIdx, controlIdx, cellIdxs:[cellIdx | [first,last], …]} with the table address from its get_structure line');
    }
  }
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, tool);
  const shift = w.requireRevision(args, sectionIdx, c['paraIdx'] as number, c['paraIdx'] as number);
  const paraIdx = (c['paraIdx'] as number) + shift;
  const controlIdx = c['controlIdx'] as number;
  let dims;
  try { dims = engine.tableDims(sectionIdx, paraIdx, controlIdx); } catch {
    throw invalidArgs(`cells {paraIdx:${paraIdx}, controlIdx:${controlIdx}} is not a table — take the address from a get_structure table line`);
  }
  const list = cellIndexList(c['cellIdxs'], 'cells.cellIdxs', dims.cellCount);
  return { sectionIdx, cells: list.map((cellIdx) => ({ paraIdx, controlIdx, cellIdx })) };
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
  const many = cellsTargets(w, args, 'apply_char_format');
  if (many) {
    let paragraphs = 0;
    for (const cell of many.cells) {
      const n = engine.cellParagraphCount(many.sectionIdx, cell);
      for (let p = 0; p < n; p++) {
        // 빈 셀 문단도 — 그 문단 끝 모양이 빈 줄의 높이와 이어 칠 글자의 모양이다
        engine.applyCharFormat(many.sectionIdx, p, 0, engine.length(many.sectionIdx, p, cell), props, cell);
        paragraphs++;
      }
    }
    w.touches.push({ sectionIdx: many.sectionIdx, paraStart: many.cells[0].paraIdx, paraEnd: many.cells[0].paraIdx, paraDelta: 0, tableCells: many.cells });
    return { cells: many.cells.length, paragraphs };
  }
  const targets = parasTargets(w, args, 'apply_char_format');
  if (targets) {
    let empty = 0;
    for (const p of targets.paras) {
      const len = engine.length(targets.sectionIdx, p, targets.cell);
      // 빈 문단(빈 줄)은 문단 끝 모양을 바꾼다 — 글자 크기를 바꾸면 빈 줄 높이도 따라 바뀐다
      if (len === 0) empty++;
      engine.applyCharFormat(targets.sectionIdx, p, 0, len, props, targets.cell);
    }
    touchParas(w, targets.sectionIdx, targets.paras, targets.cell);
    return { paragraphs: targets.paras.length, ...(empty ? { emptyParagraphs: empty } : {}) };
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
  const many = cellsTargets(w, args, 'apply_para_format');
  if (many) {
    let paragraphs = 0;
    for (const cell of many.cells) {
      const n = engine.cellParagraphCount(many.sectionIdx, cell);
      for (let p = 0; p < n; p++) {
        engine.applyParaFormat(many.sectionIdx, p, build(many.sectionIdx, p, cell), cell);
        paragraphs++;
      }
    }
    w.touches.push({ sectionIdx: many.sectionIdx, paraStart: many.cells[0].paraIdx, paraEnd: many.cells[0].paraIdx, paraDelta: 0, tableCells: many.cells });
    return { cells: many.cells.length, paragraphs };
  }
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
  const current = engine.json<{ exists?: boolean; paraIndex?: number; controlIndex?: number }>('getHeaderFooter', sectionIdx, isHeader, applyTo);
  if (current?.exists && args['discardObjects'] !== true && typeof current.paraIndex === 'number' && typeof current.controlIndex === 'number') {
    // 이 도구는 머리말·꼬리말을 지우고 새로 만든다 — 안에 든 표(쪽 번호 옆 칸 등)까지 사라진다.
    const hfCell: CellAddr = { paraIdx: current.paraIndex, controlIdx: current.controlIndex, cellIdx: 0 };
    const tables = engine.nestedTables(sectionIdx, hfCell);
    if (tables.length > 0) {
      const which = isHeader ? 'header' : 'footer';
      throw new DoogleToolError(
        'RANGE_HAS_OBJECTS',
        `This ${which} holds ${tables.length} table(s); edit_header_footer rebuilds the whole ${which} from lines and would delete them. `
          + `Edit the text in place instead: get_structure lists the ${which} and each table in it with a cell + cellPath you pass to replace_range / insert_text / apply_char_format `
          + `(e.g. cell {paraIdx:${hfCell.paraIdx}, controlIdx:${hfCell.controlIdx}, cellIdx:0} + cellPath ${JSON.stringify(tables[0])} with the last cellIndex set to the cell). `
          + 'Resend with discardObjects:true only if the user wants the tables gone.',
      );
    }
  }
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

const COLUMN_SCOPES = { zone: 0, from_here: 1, section: 2, document: 3 } as const;
const COLUMN_TYPES = ['normal', 'distribute', 'parallel'] as const;

interface ColumnDefAt { columnCount: number; columnType: number; sameWidth: boolean; spacing: number; zoneStart: number; zoneCount: number }

/**
 * 다단 — 엔진 applyColumnDef 의 적용 범위(현재 다단 / 여기부터 새 다단 / 구역 / 문서).
 * "표지는 1단, 본문은 2단" 은 본문 첫 문단에서 from_here 로 만든다.
 */
const setColumns: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'set_columns');
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const scopeName = (args['scope'] ?? 'zone') as string;
  if (!Object.prototype.hasOwnProperty.call(COLUMN_SCOPES, scopeName)) throw invalidArgs('scope must be zone|from_here|section|document');
  const scope = COLUMN_SCOPES[scopeName as keyof typeof COLUMN_SCOPES];
  const charOffset = optInt(args, 'charOffset') ?? 0;
  if (charOffset !== 0 && scopeName !== 'from_here') throw invalidArgs('charOffset only applies to scope "from_here" (where the new column zone starts)');
  validateAddress(engine, sectionIdx, paraIdx, charOffset);
  const count = reqInt(args, 'count');
  if (count < 1 || count > 255) throw invalidArgs('count must be 1..255');
  const typeArg = args['type'];
  if (given(typeArg) && !(COLUMN_TYPES as readonly unknown[]).includes(typeArg)) throw invalidArgs('type must be normal|distribute|parallel');
  const sameWidth = args['sameWidth'];
  if (given(sameWidth) && typeof sameWidth !== 'boolean') throw invalidArgs('sameWidth must be a boolean');
  const gap = args['gapMm'];
  if (given(gap) && (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0 || gap > 100)) throw invalidArgs('gapMm must be 0..100');
  if (!engine.has('applyColumnDef') || !engine.has('getColumnDefAt')) {
    throw new DoogleToolError(
      'ENGINE_UNSUPPORTED',
      'This engine build has no applyColumnDef()/getColumnDefAt() — set_columns needs the document engine rebuilt from the current source (wasm-pack). '
        + 'Until then set_page_layout columns changes only the first column zone of a section.',
      { method: 'applyColumnDef' },
    );
  }
  // 종류·간격은 지금 다단을 잇는다. 1단 다단은 간격이 0 일 수 있어 단을 늘릴 때는 8mm 로 둔다.
  const current = engine.json<ColumnDefAt>('getColumnDefAt', sectionIdx, paraIdx);
  const type = given(typeArg) ? COLUMN_TYPES.indexOf(typeArg as typeof COLUMN_TYPES[number]) : (current.columnType ?? 0);
  const spacing = typeof gap === 'number' ? mmToHu(gap) : current.spacing > 0 ? current.spacing : mmToHu(8);
  const before = engine.paragraphCount(sectionIdx);
  const r = engine.json<{ section: number; para: number; charOffset: number }>(
    'applyColumnDef', sectionIdx, paraIdx, charOffset, scope, count, type, sameWidth === false ? 0 : 1, spacing,
  );
  engine.invalidate();
  const delta = engine.paragraphCount(sectionIdx) - before;
  if (scopeName === 'document') {
    for (let s = 0; s < engine.sectionCount(); s++) w.touches.push({ sectionIdx: s, paraStart: 0, paraEnd: 0, paraDelta: 0, wholeSection: true });
  } else if (scopeName === 'section') {
    w.touches.push({ sectionIdx, paraStart: 0, paraEnd: 0, paraDelta: 0, wholeSection: true });
  } else {
    // from_here 가 문단 가운데면 문단을 나눈다 — 뒤 문단 번호가 하나씩 밀린다
    w.touches.push(bodyTouch(sectionIdx, paraIdx, paraIdx + delta, delta, charOffset));
  }
  const now = engine.json<ColumnDefAt>('getColumnDefAt', sectionIdx, r.para);
  return {
    scope: scopeName,
    zoneStartParaIdx: now.zoneStart >= 0 ? now.zoneStart : 0,
    columns: { count: now.columnCount, type: COLUMN_TYPES[now.columnType] ?? 'normal', sameWidth: now.sameWidth, gapMm: huToMm(now.spacing) },
    zonesInSection: now.zoneCount,
    ...(delta !== 0 ? { splitParagraph: { paraIdx, charOffset, newParaIdx: r.para } } : {}),
    ...(shift ? { rebasedParaShift: shift } : {}),
  };
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
  // 본문 표는 글자처럼 취급(문단 흐름을 따른다)이 한글의 기본이다 — 떠 있는 표가 필요하면 set_table_props 로 바꾼다.
  const options: Record<string, unknown> = { sectionIdx, paraIdx, charOffset: offset, rowCount: rows, colCount: cols, treatAsChar: true };
  if (widths) options['colWidths'] = widths.map(mmToHu);
  const created = engine.has('createTableEx')
    ? engine.json<{ paraIdx: number; controlIdx: number }>('createTableEx', JSON.stringify(options))
    : engine.json<{ paraIdx: number; controlIdx: number }>('createTable', sectionIdx, paraIdx, offset, rows, cols);
  engine.invalidate();
  const table = { paraIdx: created.paraIdx, controlIdx: created.controlIdx };
  let fitted: string | undefined;
  if (!widths) {
    // 표는 놓인 문단의 왼쪽 여백만큼 밀려 본문 오른쪽 끝을 넘을 수 있다(앞 문단 모양을 이은 빈 문단).
    // 표만 있는 문단이면 그 여백을 0 으로 하고, 그래도 넘으면 본문 폭에 맞춘다.
    if (tableOverflow(engine, sectionIdx, table) > 2 && engine.length(sectionIdx, table.paraIdx) === 0) {
      engine.applyParaFormat(sectionIdx, table.paraIdx, { marginLeft: 0, marginRight: 0, indent: 0 });
      fitted = 'host paragraph margins reset';
    }
    if (tableOverflow(engine, sectionIdx, table) > 2 && engine.has('fitTableToPage')) {
      engine.json('fitTableToPage', sectionIdx, table.paraIdx, table.controlIdx);
      fitted = 'fit to body width';
    }
  }
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
    if (args['headerBold'] !== false) {
      // 머리행만 굵게 — 표가 굵은 문단(제목 서식을 이은 빈 문단) 자리에 놓이면 셀 글이 모두 굵게 들어온다
      for (let i = cols; i < rows * cols; i++) {
        const cell: CellAddr = { paraIdx: table.paraIdx, controlIdx: table.controlIdx, cellIdx: i };
        const n = engine.cellParagraphCount(sectionIdx, cell);
        for (let cp = 0; cp < n; cp++) {
          const len = engine.length(sectionIdx, cp, cell);
          if (len > 0 && engine.charPropsAt(sectionIdx, cp, 0, cell)['bold'] === true) {
            engine.applyCharFormat(sectionIdx, cp, 0, len, { bold: false }, cell);
          }
        }
      }
    }
  }
  const delta = engine.paragraphCount(sectionIdx) - before;
  w.touches.push({ sectionIdx, paraStart: paraIdx, paraEnd: Math.max(paraIdx, table.paraIdx), paraDelta: delta, table });
  return {
    paraIdx: table.paraIdx, controlIdx: table.controlIdx, rowCount: rows, colCount: cols, cellCount: rows * cols,
    ...(fitted ? { fitted } : {}),
  };
};

/** 표가 본문 오른쪽 끝을 넘은 양(px) — 잴 수 없으면 0 */
function tableOverflow(engine: Engine, sectionIdx: number, table: { paraIdx: number; controlIdx: number }): number {
  const boxes = engine.tableCellBoxes(sectionIdx, table.paraIdx, table.controlIdx);
  if (boxes.length === 0) return 0;
  try {
    const frame = engine.pageInfo(boxes[0].pageIndex);
    if (typeof frame['bodyRight'] !== 'number') return 0;
    return Math.max(0, Math.max(...boxes.map((b) => b.x + b.w)) - frame['bodyRight']);
  } catch {
    return 0;
  }
}

/**
 * 표 도구의 대상 표. 최상위 표는 (paraIdx, controlIdx), 중첩 표·머리말/꼬리말 안 표는 그 위에
 * cellPath — get_structure 의 "nested table …"/머리말·꼬리말 표 줄이 주는 경로(마지막 cellIndex 는 아무 값).
 */
function tableTarget(w: WriteScope, args: Record<string, unknown>, tool: string): TableRef {
  const sectionIdx = sectionOf(w.engine, args, tool);
  const raw = reqInt(args, 'paraIdx');
  const shift = w.requireRevision(args, sectionIdx, raw, raw);
  const paraIdx = raw + shift;
  const controlIdx = reqInt(args, 'controlIdx');
  const path = tablePathArg(args);
  if (path) {
    if (path[0].controlIndex !== controlIdx) {
      throw invalidArgs(`cellPath[0].controlIndex ${path[0].controlIndex} must equal controlIdx ${controlIdx} — the path starts at the outer table (or header/footer) named by paraIdx/controlIdx`);
    }
    const t: TableRef = { sectionIdx, paraIdx, controlIdx, path };
    try {
      w.engine.tableDimsOf(t);
    } catch {
      throw invalidArgs(`cellPath ${JSON.stringify(path)} from s${sectionIdx} p${paraIdx} c${controlIdx} does not reach a table — copy it from a get_structure "nested table" or header/footer table line`);
    }
    return t;
  }
  try {
    w.engine.tableDims(sectionIdx, paraIdx, controlIdx);
  } catch {
    const hf = w.engine.headerFooters().find((h) => h.sectionIdx === sectionIdx && h.paraIdx === paraIdx && h.controlIdx === controlIdx);
    throw invalidArgs(hf
      ? `s${sectionIdx} p${paraIdx} c${controlIdx} is the ${hf.isHeader ? 'header' : 'footer'}, not a table — a table inside it needs cellPath from its get_structure line`
      : `s${sectionIdx} p${paraIdx} c${controlIdx} is not a table — take the address from a get_structure table line`);
  }
  w.noteTableBefore?.(sectionIdx, paraIdx, controlIdx);
  return { sectionIdx, paraIdx, controlIdx };
}

/** 표 도구의 cellPath — 길이 2 이상(중첩 표·머리말/꼬리말 안 표). 길이 1 이면 최상위 표와 같으니 무시한다. */
function tablePathArg(args: Record<string, unknown>): CellPathEntry[] | undefined {
  const raw = args['cellPath'];
  if (!given(raw)) return undefined;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw invalidArgs('cellPath must be 1..8 entries {controlIndex, cellIndex, cellParaIndex}');
  const path = raw.map((e, i) => {
    const r = asRecord(e);
    // 구조 줄의 마지막 cellIndex 자리 "n" 을 그대로 보내도 받는다 — 표 도구에는 표만 필요하다
    const cellIndex = r['cellIndex'] === 'n' ? 0 : r['cellIndex'];
    const out = { controlIndex: r['controlIndex'] as number, cellIndex: (cellIndex ?? 0) as number, cellParaIndex: (r['cellParaIndex'] ?? 0) as number };
    if (![out.controlIndex, out.cellIndex, out.cellParaIndex].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw invalidArgs(`cellPath[${i}] must be {controlIndex, cellIndex, cellParaIndex} non-negative integers`);
    }
    return out;
  });
  return path.length > 1 ? path : undefined;
}

/** 경로 표에 엔진 경로가 없는 연산(표 계산식·캡션) — 무엇이 되는지 함께 알린다 */
function nestedUnsupported(what: string): DoogleToolError {
  return new DoogleToolError(
    'ENGINE_UNSUPPORTED',
    `${what} is not available for nested or header/footer tables (the engine has no path API for it). `
      + 'Everything else in edit_table, set_table_props, set_cell_props, set_zone_borders and delete_table works there with cellPath.',
  );
}

/** 표의 한 행·열에 놓인 셀 번호 (병합 셀은 시작 칸 기준) */
function cellsOfLine(engine: Engine, t: TableRef, axis: 'row' | 'col', index: number): number[] {
  const dims = engine.tableDimsOf(t);
  const out: number[] = [];
  for (let i = 0; i < dims.cellCount; i++) {
    try {
      const info = engine.cellInfoOf(t, i);
      if ((axis === 'row' ? info.row : info.col) === index) out.push(i);
    } catch { /* 건너뛴다 */ }
  }
  return out;
}

function cellIdxAt(engine: Engine, t: TableRef, row: number, col: number): number {
  const dims = engine.tableDimsOf(t);
  for (let i = 0; i < dims.cellCount; i++) {
    const info = engine.cellInfoOf(t, i);
    if (row >= info.row && row < info.row + info.rowSpan && col >= info.col && col < info.col + info.colSpan) return i;
  }
  throw invalidArgs(`no cell at row ${row}, col ${col} (table is ${dims.rowCount}x${dims.colCount})`);
}

interface CellGeometry { cellIdx: number; row: number; col: number; rowSpan: number; colSpan: number; width: number; height: number }

function cellGeometry(engine: Engine, t: TableRef): CellGeometry[] {
  const dims = engine.tableDimsOf(t);
  const cells: CellGeometry[] = [];
  for (let i = 0; i < dims.cellCount; i++) {
    const info = engine.cellInfoOf(t, i);
    const props = engine.cellPropsOf(t, i);
    cells.push({
      cellIdx: i, row: info.row, col: info.col, rowSpan: info.rowSpan, colSpan: info.colSpan,
      width: typeof props['width'] === 'number' ? props['width'] as number : 0,
      height: typeof props['height'] === 'number' ? props['height'] as number : 0,
    });
  }
  return cells;
}

function columnWidthsMm(engine: Engine, t: TableRef): { widths: number[]; cells: CellGeometry[] } {
  const dims = engine.tableDimsOf(t);
  const widths: number[] = Array(dims.colCount).fill(0);
  const cells = cellGeometry(engine, t);
  for (const c of cells) if (c.colSpan === 1 && widths[c.col] === 0) widths[c.col] = c.width;
  return { widths, cells };
}

/** 열 너비(HU)를 맞춘다 — 셀마다 차이를 resizeTableCells(ByPath) 로 보낸다 */
function resizeColumns(engine: Engine, t: TableRef, target: number[]): void {
  const { cells } = columnWidthsMm(engine, t);
  const updates = cells.map((c) => {
    const want = target.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0);
    return { cellIdx: c.cellIdx, widthDelta: Math.round(want - c.width) };
  }).filter((u) => u.widthDelta !== 0);
  engine.resizeCells(t, updates);
}

/** 행 높이(HU)를 맞춘다 — null 인 행은 그대로. 여러 행에 걸친 셀은 그 행들 합으로 맞춘다 */
function resizeRows(engine: Engine, t: TableRef, target: Array<number | null>): void {
  const cells = cellGeometry(engine, t);
  // 지금 행 높이 — 한 행짜리 셀의 높이(가장 큰 값)를 그 행 높이로 본다
  const current: number[] = Array(target.length).fill(0);
  for (const c of cells) if (c.rowSpan === 1 && c.row < current.length) current[c.row] = Math.max(current[c.row], c.height);
  const want = target.map((v, r) => (v === null ? current[r] : v));
  const updates = cells.map((c) => {
    if (target.slice(c.row, c.row + c.rowSpan).every((v) => v === null)) return { cellIdx: c.cellIdx, heightDelta: 0 };
    const sum = want.slice(c.row, c.row + c.rowSpan).reduce((a, b) => a + b, 0);
    return { cellIdx: c.cellIdx, heightDelta: Math.round(sum - c.height) };
  }).filter((u) => u.heightDelta !== 0);
  engine.resizeCells(t, updates);
}

/** 경로 표가 들어갈 수 있는 폭(HU) — 중첩 표는 그 표를 품은 셀의 안쪽 폭, 머리말·꼬리말 안 표는 본문 폭 */
function containerWidthHu(engine: Engine, t: TableRef): number {
  const path = t.path!;
  if (engine.inHeaderFooter(t) && path.length === 2) {
    const def = engine.json<Record<string, number>>('getPageDef', t.sectionIdx);
    return (def['width'] ?? 0) - (def['marginLeft'] ?? 0) - (def['marginRight'] ?? 0) - (def['marginGutter'] ?? 0);
  }
  // 바깥 표 = 경로에서 이 표 바로 앞 항목. 그 항목의 cellIndex 가 이 표를 품은 셀이다
  const outerPath = path.slice(0, -1);
  const outer: TableRef = { sectionIdx: t.sectionIdx, paraIdx: t.paraIdx, controlIdx: t.controlIdx, ...(outerPath.length > 1 ? { path: outerPath } : {}) };
  const hostCell = outerPath[outerPath.length - 1].cellIndex;
  const p = engine.cellPropsOf(outer, hostCell);
  const num = (k: string) => (typeof p[k] === 'number' ? p[k] as number : 0);
  return num('width') - num('paddingLeft') - num('paddingRight');
}

const editTable: WriteHandler = (w, args) => {
  const { engine } = w;
  const t = tableTarget(w, args, 'edit_table');
  const op = args['op'];
  const { sectionIdx, paraIdx, controlIdx } = t;
  const nested = t.path !== undefined;
  const dims = engine.tableDimsOf(t);
  const idx = (key: string, max: number): number => {
    const v = reqInt(args, key);
    if (v >= max) throw invalidArgs(`${key} ${v} is out of range (0..${max - 1})`);
    return v;
  };
  let note: string | undefined;
  let added: { axis: 'row' | 'col'; index: number } | undefined;
  switch (op) {
    case 'insert_row': {
      const at = idx('rowIdx', dims.rowCount);
      engine.tableWrite(t, 'insertTableRow', 'insertTableRowByPath', at, args['below'] !== false);
      added = { axis: 'row', index: args['below'] !== false ? at + 1 : at };
      break;
    }
    case 'insert_col': {
      const at = idx('colIdx', dims.colCount);
      engine.tableWrite(t, 'insertTableColumn', 'insertTableColumnByPath', at, args['right'] !== false);
      added = { axis: 'col', index: args['right'] !== false ? at + 1 : at };
      break;
    }
    case 'delete_row':
      if (dims.rowCount <= 1) throw invalidArgs('cannot delete the only row — use delete_table');
      engine.tableWrite(t, 'deleteTableRow', 'deleteTableRowByPath', idx('rowIdx', dims.rowCount)); break;
    case 'delete_col':
      if (dims.colCount <= 1) throw invalidArgs('cannot delete the only column — use delete_table');
      engine.tableWrite(t, 'deleteTableColumn', 'deleteTableColumnByPath', idx('colIdx', dims.colCount)); break;
    case 'merge_cells': {
      const sr = idx('startRow', dims.rowCount); const sc = idx('startCol', dims.colCount);
      const er = idx('endRow', dims.rowCount); const ec = idx('endCol', dims.colCount);
      if (er < sr || ec < sc) throw invalidArgs('endRow/endCol must be >= startRow/startCol');
      engine.tableWrite(t, 'mergeTableCells', 'mergeTableCellsByPath', sr, sc, er, ec);
      break;
    }
    case 'split_cell': {
      const r = idx('rowIdx', dims.rowCount); const c = idx('colIdx', dims.colCount);
      const nr = reqInt(args, 'splitRows'); const nc = reqInt(args, 'splitCols');
      if (nr < 1 || nc < 1 || nr * nc < 2) throw invalidArgs('splitRows and splitCols must be >= 1 and split into at least 2 cells');
      engine.tableWrite(t, 'splitTableCellInto', 'splitTableCellIntoByPath', r, c, nr, nc, true, false);
      break;
    }
    case 'set_column_widths': {
      const list = args['columnWidthsMm'];
      if (!Array.isArray(list) || list.length !== dims.colCount || !list.every((v) => typeof v === 'number' && v > 0 && v <= 500)) {
        throw invalidArgs(`columnWidthsMm must list ${dims.colCount} positive widths (mm)`);
      }
      if (!nested && engine.has('setTableColumnWidths')) {
        engine.json('setTableColumnWidths', sectionIdx, paraIdx, controlIdx, Uint32Array.from((list as number[]).map(mmToHu)));
      } else if (nested && engine.has('setTableColumnWidthsByPath')) {
        engine.tableWrite(t, 'setTableColumnWidths', 'setTableColumnWidthsByPath', Uint32Array.from((list as number[]).map(mmToHu)));
      } else {
        resizeColumns(engine, t, (list as number[]).map(mmToHu));
      }
      break;
    }
    case 'set_row_heights': {
      const list = args['rowHeightsMm'];
      if (!Array.isArray(list) || list.length !== dims.rowCount
        || !list.every((v) => v === null || (typeof v === 'number' && v > 0 && v <= 500))) {
        throw invalidArgs(`rowHeightsMm must list ${dims.rowCount} row heights (mm, > 0; null keeps that row) — a row still grows to fit its text`);
      }
      resizeRows(engine, t, (list as Array<number | null>).map((v) => (v === null ? null : mmToHu(v))));
      break;
    }
    case 'fit_to_page': {
      if (nested) {
        // 중첩 표는 품은 셀 안쪽 폭에, 머리말·꼬리말 안 표는 본문 폭에 맞춘다(줄이기만)
        const room = containerWidthHu(engine, t);
        const { widths } = columnWidthsMm(engine, t);
        const total = widths.reduce((a, b) => a + b, 0);
        if (room <= 0 || total <= 0) throw invalidArgs('could not measure the nested table or the cell that holds it');
        if (total <= room) { note = 'table already fits the space that holds it'; break; }
        resizeColumns(engine, t, widths.map((v) => Math.floor(v * room / total)));
        break;
      }
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
      if (nested) throw nestedUnsupported('edit_table apply_formula');
      const formula = reqString(args, 'formula');
      const cellIdx = cellIdxAt(engine, t, reqInt(args, 'row'), reqInt(args, 'col'));
      const fmt = asRecord(args['format']);
      engine.json('setTableCellFormula', sectionIdx, paraIdx, controlIdx, cellIdx, formula, JSON.stringify(fmt));
      break;
    }
    case 'set_caption':
      // 엔진에 표 캡션 생성 경로가 없다(ENGINE_GAPS.md §2) — 도구 정의에서도 뺐다.
      throw new DoogleToolError('ENGINE_UNSUPPORTED', 'Table captions cannot be edited in this build — type the caption as an ordinary paragraph above or below the table.');
    default:
      throw invalidArgs('op must be insert_row|insert_col|delete_row|delete_col|merge_cells|split_cell|set_column_widths|set_row_heights|fit_to_page|apply_formula');
  }
  engine.invalidate();
  const after = engine.tableDimsOf(t);
  w.touches.push({ sectionIdx, paraStart: paraIdx, paraEnd: paraIdx, paraDelta: 0, table: { paraIdx, controlIdx } });
  // 새 행·열의 셀 번호를 바로 돌려준다 — 값을 채우려고 구조를 다시 읽지 않아도 된다.
  const newCells = added ? cellsOfLine(engine, t, added.axis, added.index) : null;
  return {
    rowCount: after.rowCount, colCount: after.colCount, cellCount: after.cellCount,
    ...(added && newCells ? { [added.axis === 'row' ? 'newRow' : 'newCol']: { [added.axis === 'row' ? 'rowIdx' : 'colIdx']: added.index, cellIdxs: newCells } } : {}),
    ...(note ? { note } : {}),
    ...(nested ? { columnWidthsMm: columnWidthsMm(engine, t).widths.map(huToMm) } : {}),
  };
};

const setTableProps: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'set_table_props');
  const raw = asRecord(args['tableProps']);
  const caption = Object.keys(raw).filter((k) => k.startsWith('caption'));
  if (t.path && caption.length > 0) throw nestedUnsupported(`set_table_props ${caption.join('/')}`);
  const props = parseTableProps(raw);
  w.engine.tableWrite(t, 'setTableProperties', 'setTablePropertiesByPath', JSON.stringify(props));
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: 0, table: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } });
  return {};
};

const setCellProps: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'set_cell_props');
  const dims = w.engine.tableDimsOf(t);
  let cells: number[];
  if (given(args['cellIdxs'])) {
    if (given(args['cellIdx'])) throw invalidArgs('send cellIdx (one cell) or cellIdxs (several), not both');
    cells = cellIndexList(args['cellIdxs'], 'cellIdxs', dims.cellCount);
  } else {
    const cellIdx = reqInt(args, 'cellIdx');
    if (cellIdx >= dims.cellCount) throw invalidArgs(`cellIdx ${cellIdx} is out of range (0..${dims.cellCount - 1})`);
    cells = [cellIdx];
  }
  const parsed = parseCellProps(asRecord(args['cellProps']));
  if (t.path && !w.engine.has('setCellPropertiesByPath')) {
    // 낡은 엔진 빌드: 경로 셀 속성 쓰기가 없어 크기만 증감(resizeTableCellsByPath)으로 맞춘다
    const other = Object.keys(asRecord(args['cellProps'])).filter((k) => k !== 'widthMm' && k !== 'heightMm');
    if (other.length > 0) w.engine.requirePathMethod('setCellPropertiesByPath');
    const updates = cells.map((cellIdx) => {
      const cur = w.engine.cellPropsOf(t, cellIdx);
      const delta = (key: 'width' | 'height') => (typeof parsed[key] === 'number' && typeof cur[key] === 'number' ? (parsed[key] as number) - (cur[key] as number) : 0);
      return { cellIdx, widthDelta: delta('width'), heightDelta: delta('height') };
    }).filter((u) => u.widthDelta !== 0 || u.heightDelta !== 0);
    w.engine.resizeCells(t, updates);
  } else {
    const props = JSON.stringify(parsed);
    for (const cellIdx of cells) w.engine.tableWrite(t, 'setCellProperties', 'setCellPropertiesByPath', cellIdx, props);
  }
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: 0, table: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } });
  return cells.length > 1 ? { cells: cells.length } : {};
};

const setZoneBorders: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'set_zone_borders');
  const dims = w.engine.tableDimsOf(t);
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
  const fill = args['fillColor'];
  if (given(fill) && (typeof fill !== 'string' || !HEX_COLOR_RE.test(fill))) throw invalidArgs('fillColor must be "#RRGGBB"');
  for (const key of ['diagonalLine', 'diagonalSlash', 'diagonalBackSlash', 'diagonalWidth', 'diagonalColor', 'centerLine']) {
    if (given(args[key])) props[key] = args[key];
  }
  if (Object.keys(props).length === 0 && !given(fill)) throw invalidArgs('set_zone_borders needs at least one border, fillColor, diagonal or centerLine');
  const r0 = Math.min(s.row, e.row); const c0 = Math.min(s.col, e.col);
  const r1 = Math.max(s.row, e.row); const c1 = Math.max(s.col, e.col);
  if (t.path) {
    // 경로 표: 하나라도 없으면 아무것도 바꾸기 전에 거절한다
    if (Object.keys(props).length > 0) w.engine.requirePathMethod('setCellZonePropertiesByPath');
    if (given(fill)) w.engine.requirePathMethod('setCellPropertiesByPath');
  }
  if (Object.keys(props).length > 0) {
    w.engine.tableWrite(t, 'setCellZoneProperties', 'setCellZonePropertiesByPath', r0, c0, r1, c1, JSON.stringify(props));
  }
  let filled = 0;
  if (typeof fill === 'string') {
    // 영역 채움은 셀이 자기 채움을 갖고 있으면 그 아래에 깔려 보이지 않는다(값은 바뀐 것처럼 읽힌다).
    // 그래서 채움은 영역 안 셀마다 직접 넣는다 — 결과가 화면과 같다.
    const cellFill = JSON.stringify({ fillType: 'solid', fillColor: fill });
    for (let i = 0; i < dims.cellCount; i++) {
      const info = w.engine.cellInfoOf(t, i);
      if (info.row < r0 || info.row > r1 || info.col < c0 || info.col > c1) continue;
      w.engine.tableWrite(t, 'setCellProperties', 'setCellPropertiesByPath', i, cellFill);
      filled++;
    }
  }
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: 0, table: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } });
  return filled > 0 ? { filledCells: filled } : {};
};

const deleteTable: WriteHandler = (w, args) => {
  const t = tableTarget(w, args, 'delete_table');
  if (t.path) {
    // 중첩·머리말/꼬리말 안 표: 표를 품은 문단에서 컨트롤만 걷어낸다(문단 수는 그대로)
    const path = t.path;
    if (w.engine.has('deleteTableByPath')) {
      w.engine.json('deleteTableByPath', t.sectionIdx, t.paraIdx, JSON.stringify(path));
    } else {
      // 낡은 엔진 빌드에도 있는 셀 안 표 지우기 — 경로는 표를 품은 칸까지, 컨트롤 번호는 따로
      w.engine.requirePathMethod('deleteCellTableControlByPath');
      w.engine.json('deleteCellTableControlByPath', t.sectionIdx, t.paraIdx, JSON.stringify(path.slice(0, -1)), path[path.length - 1].controlIndex);
    }
    w.engine.invalidate();
    w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: 0, table: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } });
    return { deleted: { paraIdx: t.paraIdx, controlIdx: t.controlIdx, cellPath: path } };
  }
  const before = w.engine.paragraphCount(t.sectionIdx);
  w.engine.json('deleteTableControl', t.sectionIdx, t.paraIdx, t.controlIdx);
  w.engine.invalidate();
  const delta = w.engine.paragraphCount(t.sectionIdx) - before;
  w.touches.push({ sectionIdx: t.sectionIdx, paraStart: t.paraIdx, paraEnd: t.paraIdx, paraDelta: delta });
  return { deleted: { paraIdx: t.paraIdx, controlIdx: t.controlIdx } };
};

// ─── 문단 단위 ─────────────────────────────────────────

const PARAGRAPHS_MAX = 100;

/** 문단 목록 인자 — "\n" 이 든 항목은 여러 문단으로 푼다 */
function paragraphTexts(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1) throw invalidArgs('paragraphs must be a non-empty array of strings (one item = one paragraph; "" = an empty paragraph)');
  const out: string[] = [];
  raw.forEach((item, i) => {
    if (typeof item !== 'string') throw invalidArgs(`paragraphs[${i}] must be a string`);
    for (const part of item.replace(/\r\n?/g, '\n').split('\n')) out.push(part);
  });
  if (out.length > PARAGRAPHS_MAX) throw invalidArgs(`insert_paragraphs is limited to ${PARAGRAPHS_MAX} paragraphs per call`);
  if (out.reduce((n, t) => n + t.length, 0) > 20000) throw invalidArgs('insert_paragraphs is limited to 20000 characters per call');
  return out;
}

/**
 * 새 문단을 기준 문단의 앞·뒤에 넣는다. 기준 문단에 표·그림이 있어도 그 개체를 건드리지 않고 문단째로 넣으므로
 * "표 뒤에 줄 추가"·"문서 맨 끝에 추가"에 쓴다. 새 문단은 앞 문단의 모양을 잇고, formatFrom 을 주면 그 문단의
 * 문단 모양·글자 모양을 그대로 따른다.
 */
const insertParagraphs: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'insert_paragraphs');
  const rawRef = reqInt(args, 'paraIdx');
  const where = args['where'] ?? 'after';
  if (where !== 'after' && where !== 'before') throw invalidArgs('where must be "after" or "before"');
  const texts = paragraphTexts(args['paragraphs']);
  const shift = w.requireRevision(args, sectionIdx, rawRef, rawRef);
  const ref = rawRef + shift;
  const count = engine.paragraphCount(sectionIdx);
  if (ref >= count) throw invalidArgs(`paraIdx ${ref} is out of range for section ${sectionIdx} (0..${count - 1})`);
  let shapes: { paraShapeId: number | null; charShapeId: number | null } | null = null;
  const formatFrom = optInt(args, 'formatFrom');
  if (formatFrom !== undefined) {
    const src = formatFrom + shift;
    if (src >= count) throw invalidArgs(`formatFrom ${src} is out of range for section ${sectionIdx} (0..${count - 1})`);
    shapes = engine.shapeIds(sectionIdx, src);
  }
  const at = where === 'before' ? ref : ref + 1;
  texts.forEach((text, i) => {
    const p = at + i;
    engine.insertParagraph(sectionIdx, p);
    if (text.length > 0) engine.json('insertText', sectionIdx, p, 0, text);
    if (shapes) {
      if (shapes.paraShapeId !== null) engine.setParaShapeId(sectionIdx, p, shapes.paraShapeId);
      if (shapes.charShapeId !== null) engine.setCharShapeId(sectionIdx, p, 0, scalarLength(text), shapes.charShapeId);
    }
  });
  w.touches.push(bodyTouch(sectionIdx, at, at + texts.length - 1, texts.length));
  return {
    inserted: { sectionIdx, firstParaIdx: at, lastParaIdx: at + texts.length - 1 },
    ...(shift ? { rebasedParaShift: shift } : {}),
  };
};

/** 문단을 통째로 지운다 (앞뒤 문단과 합치지 않는다). 개체가 든 문단은 includeObjects:true 일 때만. */
const deleteParagraphs: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'delete_paragraphs');
  const startRaw = reqInt(args, 'startParaIdx');
  const endRaw = optInt(args, 'endParaIdx') ?? startRaw;
  if (endRaw < startRaw) throw invalidArgs('endParaIdx must be >= startParaIdx');
  const shift = w.requireRevision(args, sectionIdx, startRaw, endRaw);
  const start = startRaw + shift;
  const end = endRaw + shift;
  const count = engine.paragraphCount(sectionIdx);
  if (end >= count) throw invalidArgs(`endParaIdx ${end} is out of range for section ${sectionIdx} (0..${count - 1})`);
  const n = end - start + 1;
  if (n >= count) {
    throw invalidArgs(`a section keeps at least one paragraph — to empty it, delete paragraphs ${start}..${end - 1} and clear the last one with delete_range`);
  }
  const objects = engine.objectsIn(sectionIdx, start, end);
  if (objects.length > 0 && args['includeObjects'] !== true) {
    throw new DoogleToolError(
      'RANGE_HAS_OBJECTS',
      `paragraphs ${start}..${end} hold ${describeObjects(objects)}. Deleting them removes those objects too — resend with includeObjects:true if that is intended, or narrow the range.`,
      { objects: objects.map((o) => ({ kind: o.kind, sectionIdx: o.sectionIdx, paraIdx: o.paraIdx, controlIdx: o.controlIdx })) },
    );
  }
  const parts: string[] = [];
  for (let p = start; p <= end && parts.join('\n').length < 240; p++) parts.push(engine.text(sectionIdx, p, undefined, 0, 200));
  const removed = parts.join('\n');
  w.noteRemoval(removed);
  for (let p = end; p >= start; p--) engine.deleteParagraph(sectionIdx, p);
  const at = Math.min(start, engine.paragraphCount(sectionIdx) - 1);
  w.touches.push({ ...bodyTouch(sectionIdx, at, at, -n), shiftFrom: at });
  return {
    deletedParagraphs: n, deleted: clip200(removed),
    ...(objects.length > 0 ? { deletedObjects: objects.length } : {}),
    ...(shift ? { rebasedParaShift: shift } : {}),
  };
};

/**
 * 문단을 다른 자리로 옮긴다 — 글자·문단 모양과 문단 안 개체(표·그림)를 그대로 가져간다.
 * 내부 클립보드를 쓴다(복사 → 빈 문단에 붙이기 → 원래 문단 지우기).
 */
const moveParagraphs: WriteHandler = (w, args) => {
  const { engine } = w;
  const sectionIdx = sectionOf(engine, args, 'move_paragraphs');
  const startRaw = reqInt(args, 'startParaIdx');
  const endRaw = optInt(args, 'endParaIdx') ?? startRaw;
  if (endRaw < startRaw) throw invalidArgs('endParaIdx must be >= startParaIdx');
  const toRaw = reqInt(args, 'toParaIdx');
  const where = args['where'] ?? 'before';
  if (where !== 'after' && where !== 'before') throw invalidArgs('where must be "before" or "after"');
  // 옮기는 범위와 목적지 사이 전체가 움직인다 — 그 구간으로 revision 을 검사한다
  const shift = w.requireRevision(args, sectionIdx, Math.min(startRaw, toRaw), Math.max(endRaw, toRaw));
  const start = startRaw + shift;
  const end = endRaw + shift;
  const to = toRaw + shift;
  const count = engine.paragraphCount(sectionIdx);
  if (end >= count) throw invalidArgs(`endParaIdx ${end} is out of range for section ${sectionIdx} (0..${count - 1})`);
  if (to >= count) throw invalidArgs(`toParaIdx ${to} is out of range for section ${sectionIdx} (0..${count - 1})`);
  const n = end - start + 1;
  const dest = where === 'after' ? to + 1 : to;
  if (dest >= start && dest <= end + 1) {
    throw invalidArgs(`the destination (${where} p${to}) is inside or next to the moved paragraphs ${start}..${end} — nothing would move`);
  }
  const firstShape = engine.shapeIds(sectionIdx, start).paraShapeId;
  engine.copySelection(sectionIdx, start, 0, end, engine.length(sectionIdx, end));
  engine.insertParagraph(sectionIdx, dest);
  engine.pasteInternal(sectionIdx, dest, 0);
  const grown = engine.paragraphCount(sectionIdx) - count;
  if (grown === n + 1 && engine.length(sectionIdx, dest + n) === 0 && engine.objectsIn(sectionIdx, dest + n, dest + n).length === 0) {
    // 붙여넣기가 빈 문단 하나를 남겼다
    engine.deleteParagraph(sectionIdx, dest + n);
  } else if (grown !== n) {
    throw new DoogleToolError('ENGINE_ERROR', `move_paragraphs: paste produced ${grown} paragraph(s) for ${n} copied — nothing was changed`);
  }
  // 붙여넣은 첫 문단은 받아 준 빈 문단의 모양을 따른다 — 원래 모양으로 되돌린다
  if (firstShape !== null) engine.setParaShapeId(sectionIdx, dest, firstShape);
  const srcStart = dest <= start ? start + n : start;
  for (let p = srcStart + n - 1; p >= srcStart; p--) engine.deleteParagraph(sectionIdx, p);
  const newStart = dest <= start ? dest : dest - n;
  // 옮긴 범위와 목적지 사이의 문단 번호가 모두 바뀐다 — 그 구간을 통째로 건드린 것으로 적는다(밖은 그대로)
  const lo = Math.min(start, newStart);
  const hi = Math.max(end, newStart + n - 1);
  w.touches.push({ ...bodyTouch(sectionIdx, lo, hi, 0), reorders: true });
  return {
    moved: { paragraphs: n, from: [start, end], to: [newStart, newStart + n - 1] },
    ...(shift ? { rebasedParaShift: shift } : {}),
  };
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
  insert_paragraphs: insertParagraphs,
  delete_paragraphs: deleteParagraphs,
  move_paragraphs: moveParagraphs,
  set_field_value: setFieldValue,
  insert_page_break: insertPageBreak,
  insert_footnote: insertFootnote,
  edit_footnote: editFootnote,
  set_bookmark: setBookmark,
  edit_header_footer: editHeaderFooter,
  set_page_layout: setPageLayout,
  set_columns: setColumns,
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
  'insert_paragraphs', 'delete_paragraphs', 'move_paragraphs', 'set_field_value', 'insert_page_break', 'insert_footnote', 'edit_footnote', 'set_bookmark', 'edit_header_footer',
  'set_page_layout', 'set_columns', 'create_table', 'edit_table', 'set_table_props', 'set_cell_props', 'set_zone_borders', 'delete_table',
  'insert_equation', 'edit_object', 'insert_shape',
]);
