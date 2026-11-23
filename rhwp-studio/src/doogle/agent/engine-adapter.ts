/**
 * 엔진 어댑터 — 원시 HwpDocument(wasm-bindgen) 위의 얇은 층.
 *
 * rhwp-x 실행기는 자기 WasmBridge 사본(객체를 돌려주는 래퍼)을 불렀다. 업스트림 rhwp 의
 * HwpDocument 는 대부분 JSON 문자열을 돌려주고, 셀 편집은 평면(InCell)과 경로(ByPath) 두 갈래가
 * 있다. 이 어댑터가 그 차이를 흡수한다:
 *  - JSON 파싱과 `{ok:false}` → ENGINE_ERROR 변환
 *  - 셀 주소는 언제나 경로 API(*ByPath)로 보낸다 — 평면 셀도 길이 1 경로다
 *  - 메서드 존재를 실행 시점에 확인해 없으면 ENGINE_UNSUPPORTED (docs/doogle/ENGINE_GAPS.md)
 *  - "\n" 이 든 삽입을 문단 나누기로 푼다
 */
import { DoogleToolError, scalarLength, type CellAddr, type CellPathEntry, type EngineDoc, type FormatDiff, type SelectionRect } from './types.ts';

export interface ObjectRef {
  sectionIdx: number;
  paraIdx: number;
  controlIdx: number;
  kind: 'table' | 'picture' | 'shape' | 'equation' | string;
}

export interface TableDims { rowCount: number; colCount: number; cellCount: number }
export interface CellInfo { row: number; col: number; rowSpan: number; colSpan: number }
export interface CharShapeRun { startOffset: number; endOffset: number; charShapeId: number }

/**
 * 머리말·꼬리말 하나. 그 컨트롤은 본문 문단(paraIdx)의 controlIdx 번째에 있다 — 도구는 이것을
 * "셀 0 하나짜리 칸"으로 다룬다: cell {paraIdx, controlIdx, cellIdx:0} 의 문단 = 머리말·꼬리말 문단,
 * 그 안 표는 cellPath [{controlIndex:hf, cellIndex:0, cellParaIndex:머리말 문단}, {표…}] 로 닿는다
 * (엔진 *ByPath API 가 머리말·꼬리말 마디를 안다).
 */
export interface HeaderFooterRef {
  sectionIdx: number;
  isHeader: boolean;
  /** 0 both, 1 even, 2 odd */
  applyTo: number;
  paraIdx: number;
  controlIdx: number;
  paraCount: number;
}

/**
 * 표 주소 — 최상위 표는 (paraIdx, controlIdx), 중첩 표·머리말/꼬리말 안 표는 path 도 있다.
 * path 는 그 표까지의 경로이고 마지막 항목의 controlIndex 가 그 표다(cellIndex 는 셀마다 바꿔 쓴다).
 */
export interface TableRef {
  sectionIdx: number;
  paraIdx: number;
  controlIdx: number;
  path?: CellPathEntry[];
}

/** 서식 diff 를 남기는 최대 곳 수 (한 쓰기당) */
const FORMAT_LOG_LIMIT = 4;

function safeRead(read: () => Record<string, unknown>): Record<string, unknown> | null {
  try {
    const value = read();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 문서를 바꾸지 않는 엔진 메서드 이름 (읽기·질의·그리기·클립보드 복사·스냅샷 관리) */
const READ_ONLY_METHOD_RE = /^(get|search|render|pageCount|logicalTo|textTo|evaluate|measure|export|copy|saveSnapshot|importSnapshot|discardSnapshot|has[A-Z])/;

function isEngineTrap(error: unknown): boolean {
  return typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError;
}

function engineMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export class Engine {
  readonly doc: EngineDoc;
  private objectsMemo: ObjectRef[] | null = null;
  private headerFootersMemo: HeaderFooterRef[] | null = null;
  /**
   * (검토) 켜 두면 applyCharFormat/applyParaFormat 이 바뀐 속성의 전·후를 남긴다 — 스테이징 행이
   * 서식 diff 를 그린다. 읽기에 실패해도 쓰기는 그대로 진행한다.
   */
  formatLog: FormatDiff[] | null = null;
  /** 문서를 바꿀 수 있는 엔진 호출 횟수 — 실패한 쓰기가 되돌릴 것이 있는지 판단한다 */
  mutations = 0;

  constructor(doc: EngineDoc) {
    this.doc = doc;
  }

  has(method: string): boolean {
    return typeof this.doc[method] === 'function';
  }

  /** 메서드 호출 — 없으면 ENGINE_UNSUPPORTED, 엔진 예외는 ENGINE_ERROR. */
  call(method: string, ...args: unknown[]): unknown {
    const fn = this.doc[method];
    if (typeof fn !== 'function') {
      throw new DoogleToolError(
        'ENGINE_UNSUPPORTED',
        `This build of the document engine has no ${method}() — the operation is not available yet (see docs/doogle/ENGINE_GAPS.md).`,
        { method },
      );
    }
    if (!READ_ONLY_METHOD_RE.test(method)) this.mutations++;
    try {
      return fn.apply(this.doc, args);
    } catch (error) {
      // 엔진 트랩(메모리 접근 오류 등)은 도구 오류로 감싸지 않는다 — 엔진 상태를 믿을 수 없으므로
      // studio 의 명령 실패 복구가 문서를 잠그게 그대로 올린다.
      if (isEngineTrap(error)) throw error;
      throw new DoogleToolError('ENGINE_ERROR', `${method} failed: ${engineMessage(error)}`, { method });
    }
  }

  /** JSON 을 돌려주는 메서드 — 파싱하고 `{ok:false}` 를 오류로 바꾼다. */
  json<T = Record<string, unknown>>(method: string, ...args: unknown[]): T {
    const raw = this.call(method, ...args);
    let value: unknown = raw;
    if (typeof raw === 'string') {
      try {
        value = raw.length === 0 ? null : JSON.parse(raw);
      } catch {
        throw new DoogleToolError('ENGINE_ERROR', `${method} returned malformed JSON`, { method });
      }
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && (value as { ok?: unknown }).ok === false) {
      const v = value as { error?: unknown; message?: unknown };
      const msg = typeof v.error === 'string' ? v.error : typeof v.message === 'string' ? v.message : 'operation refused';
      throw new DoogleToolError('ENGINE_ERROR', `${method}: ${msg}`, { method });
    }
    return value as T;
  }

  /** 문서를 바꿨다 — 객체 목록 캐시를 버린다. */
  invalidate(): void {
    this.objectsMemo = null;
    this.headerFootersMemo = null;
  }

  // ─── 머리말·꼬리말 ─────────────────────────────────────

  /** 문서의 머리말·꼬리말 (구역 순). 엔진에 질의가 없으면 빈 배열. */
  headerFooters(): HeaderFooterRef[] {
    if (this.headerFootersMemo) return this.headerFootersMemo;
    const out: HeaderFooterRef[] = [];
    if (this.has('getHeaderFooterList') && this.has('getHeaderFooter')) {
      try {
        const list = this.json<{ items?: Array<{ sectionIdx: number; isHeader: boolean; applyTo: number }> }>('getHeaderFooterList', 0, true, 0);
        const seen = new Set<string>();
        for (const item of list?.items ?? []) {
          try {
            const info = this.json<{ exists?: boolean; paraIndex?: number; controlIndex?: number; paraCount?: number }>(
              'getHeaderFooter', item.sectionIdx, item.isHeader, item.applyTo);
            if (!info?.exists || typeof info.paraIndex !== 'number' || typeof info.controlIndex !== 'number') continue;
            const key = `${item.sectionIdx}:${info.paraIndex}:${info.controlIndex}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              sectionIdx: item.sectionIdx, isHeader: item.isHeader, applyTo: item.applyTo,
              paraIdx: info.paraIndex, controlIdx: info.controlIndex, paraCount: info.paraCount ?? 0,
            });
          } catch { /* 그 항목은 건너뛴다 */ }
        }
      } catch { /* 목록 없음 */ }
    }
    this.headerFootersMemo = out;
    return out;
  }

  /**
   * 셀 주소가 머리말·꼬리말 문단 자체(그 안 표가 아니라)를 가리키면 그 머리말·꼬리말.
   * 그 문단의 쓰기는 머리말·꼬리말 API 로 보낸다 — 엔진의 한 단계 셀 경로 쓰기는 표만 안다.
   */
  headerFooterOf(sectionIdx: number, cell: CellAddr): HeaderFooterRef | null {
    if (cell.path && cell.path.length > 1) return null;
    if (cell.cellIdx !== 0) return null;
    return this.headerFooters().find((h) => h.sectionIdx === sectionIdx && h.paraIdx === cell.paraIdx && h.controlIdx === cell.controlIdx) ?? null;
  }

  /** 이 표 주소가 머리말·꼬리말 안에 있는가 */
  inHeaderFooter(t: TableRef): boolean {
    if (!t.path || t.path.length < 2) return false;
    const top = t.path[0];
    return this.headerFooters().some((h) => h.sectionIdx === t.sectionIdx && h.paraIdx === t.paraIdx && h.controlIdx === top.controlIndex);
  }

  // ─── 문서 골격 ─────────────────────────────────────────

  sectionCount(): number {
    return Number(this.call('getSectionCount')) || 0;
  }

  paragraphCount(sectionIdx: number): number {
    return Number(this.call('getParagraphCount', sectionIdx)) || 0;
  }

  pageCount(): number {
    if (this.has('pageCount')) return Number(this.call('pageCount')) || 0;
    const info = this.json<{ pageCount?: number }>('getDocumentInfo');
    return info?.pageCount ?? 0;
  }

  documentInfo(): Record<string, unknown> {
    return this.json('getDocumentInfo') ?? {};
  }

  // ─── 셀 경로 ───────────────────────────────────────────

  /** 셀 주소 + 셀 안 문단 → 엔진 경로 (마지막 cellParaIndex 를 cellPara 로 바꾼다). */
  cellPath(cell: CellAddr, cellPara: number): CellPathEntry[] {
    const base = cell.path && cell.path.length > 0
      ? cell.path.map((e) => ({ ...e }))
      : [{ controlIndex: cell.controlIdx, cellIndex: cell.cellIdx, cellParaIndex: 0 }];
    base[base.length - 1] = { ...base[base.length - 1], cellParaIndex: cellPara };
    return base;
  }

  private pathJson(cell: CellAddr, cellPara: number): string {
    return JSON.stringify(this.cellPath(cell, cellPara));
  }

  // ─── 텍스트 읽기 ───────────────────────────────────────

  /** 문단(본문 또는 셀 안) 길이 — scalar 단위 */
  length(sectionIdx: number, paraIdx: number, cell?: CellAddr): number {
    if (cell) {
      return Number(this.call('getCellParagraphLengthByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx))) || 0;
    }
    return Number(this.call('getParagraphLength', sectionIdx, paraIdx)) || 0;
  }

  /** 셀 안 문단 수 */
  cellParagraphCount(sectionIdx: number, cell: CellAddr): number {
    return Number(this.call('getCellParagraphCountByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, 0))) || 0;
  }

  /** 문단 수 — cell 이 있으면 그 셀의 문단 수 */
  paragraphCountIn(sectionIdx: number, cell?: CellAddr): number {
    return cell ? this.cellParagraphCount(sectionIdx, cell) : this.paragraphCount(sectionIdx);
  }

  text(sectionIdx: number, paraIdx: number, cell?: CellAddr, offset = 0, count?: number): string {
    const len = this.length(sectionIdx, paraIdx, cell);
    if (offset > len) return '';
    const n = Math.max(0, Math.min(count ?? len - offset, len - offset));
    if (n === 0) return '';
    if (cell) {
      return String(this.call('getTextInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), offset, n) ?? '');
    }
    return String(this.call('getTextRange', sectionIdx, paraIdx, offset, n) ?? '');
  }

  // ─── 텍스트 쓰기 ───────────────────────────────────────

  /**
   * 텍스트 삽입. "\n" 은 문단을 나눈다. 반환: 삽입이 끝난 자리(문단, 오프셋)와 늘어난 문단 수.
   */
  insertText(sectionIdx: number, paraIdx: number, offset: number, text: string, cell?: CellAddr): {
    endPara: number; endOffset: number; newParagraphs: number;
  } {
    const parts = text.replace(/\r\n?/g, '\n').split('\n');
    const hf = cell ? this.headerFooterOf(sectionIdx, cell) : null;
    let para = paraIdx;
    let at = offset;
    parts.forEach((part, index) => {
      if (index > 0) {
        this.splitParagraph(sectionIdx, para, at, cell);
        para += 1;
        at = 0;
      }
      if (part.length > 0) {
        if (hf) {
          this.json('insertTextInHeaderFooter', sectionIdx, hf.isHeader, hf.applyTo, para, at, part);
        } else if (cell) {
          this.json('insertTextInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, para), at, part);
        } else {
          this.json('insertText', sectionIdx, para, at, part);
        }
        at += scalarLength(part);
      }
    });
    return { endPara: para, endOffset: at, newParagraphs: parts.length - 1 };
  }

  splitParagraph(sectionIdx: number, paraIdx: number, offset: number, cell?: CellAddr): void {
    const hf = cell ? this.headerFooterOf(sectionIdx, cell) : null;
    if (hf) {
      this.json('splitParagraphInHeaderFooter', sectionIdx, hf.isHeader, hf.applyTo, paraIdx, offset, undefined);
    } else if (cell) {
      this.json('splitParagraphInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), offset, undefined);
    } else {
      this.json('splitParagraph', sectionIdx, paraIdx, offset, undefined);
    }
  }

  /** 범위 삭제 (여러 문단 가능). 끝 오프셋은 포함하지 않는다. */
  deleteRange(sectionIdx: number, startPara: number, startOffset: number, endPara: number, endOffset: number, cell?: CellAddr): void {
    if (startPara === endPara && startOffset === endOffset) return;
    const hf = cell ? this.headerFooterOf(sectionIdx, cell) : null;
    if (hf) {
      if (startPara === endPara) {
        this.json('deleteTextInHeaderFooter', sectionIdx, hf.isHeader, hf.applyTo, startPara, startOffset, endOffset - startOffset);
      } else {
        this.json('replaceRangeInHeaderFooter', sectionIdx, hf.isHeader, hf.applyTo, startPara, startOffset, endPara, endOffset, '');
      }
      return;
    }
    if (cell) {
      this.json('deleteRangeInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, startPara),
        startPara, startOffset, endPara, endOffset);
      return;
    }
    if (startPara === endPara && this.has('deleteText')) {
      this.json('deleteText', sectionIdx, startPara, startOffset, endOffset - startOffset);
      return;
    }
    this.json('deleteRange', sectionIdx, startPara, startOffset, endPara, endOffset);
  }

  /**
   * 한 문단 안 범위를 바꾼다 — 바뀐 글은 범위 첫 글자의 서식을 잇는다 (본문은 엔진 replaceText 가,
   * 셀은 삭제·삽입 뒤 글자 모양 구간을 되돌려 준다).
   */
  replaceInParagraph(sectionIdx: number, paraIdx: number, offset: number, length: number, text: string, cell?: CellAddr): void {
    if (!cell && this.has('replaceText') && !text.includes('\n')) {
      this.json('replaceText', sectionIdx, paraIdx, offset, length, text);
      return;
    }
    const hf = cell ? this.headerFooterOf(sectionIdx, cell) : null;
    if (hf && !text.includes('\n')) {
      this.json('replaceRangeInHeaderFooter', sectionIdx, hf.isHeader, hf.applyTo, paraIdx, offset, paraIdx, offset + length, text);
      return;
    }
    let shapeId: number | null = null;
    if (length > 0) {
      try {
        const runs = this.charShapeRuns(sectionIdx, paraIdx, offset, offset + 1, cell);
        shapeId = runs[0]?.charShapeId ?? null;
      } catch { shapeId = null; }
    }
    if (length > 0) this.deleteRange(sectionIdx, paraIdx, offset, paraIdx, offset + length, cell);
    if (text.length === 0) return;
    const end = this.insertText(sectionIdx, paraIdx, offset, text, cell);
    if (shapeId !== null && end.newParagraphs === 0) {
      const runs = JSON.stringify([{ startOffset: offset, endOffset: end.endOffset, charShapeId: shapeId }]);
      try {
        if (cell) {
          this.call('setCharShapeRunsInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), offset, end.endOffset, runs);
        } else {
          this.call('setCharShapeRuns', sectionIdx, paraIdx, offset, end.endOffset, runs);
        }
      } catch { /* 서식 복원은 덤이다 — 글은 이미 바뀌었다 */ }
    }
  }

  // ─── 서식 ──────────────────────────────────────────────

  charShapeRuns(sectionIdx: number, paraIdx: number, start: number, end: number, cell?: CellAddr): CharShapeRun[] {
    const raw = cell
      ? this.json<unknown>('getCharShapeRunsInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), start, end)
      : this.json<unknown>('getCharShapeRuns', sectionIdx, paraIdx, start, end);
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { runs?: unknown })?.runs) ? (raw as { runs: unknown[] }).runs : [];
    return list.map((r) => {
      const o = r as Record<string, number>;
      return {
        startOffset: o.startOffset ?? o.start ?? 0,
        endOffset: o.endOffset ?? o.end ?? 0,
        charShapeId: o.charShapeId ?? o.id ?? 0,
      };
    });
  }

  charPropsAt(sectionIdx: number, paraIdx: number, offset: number, cell?: CellAddr): Record<string, unknown> {
    const hf = cell ? this.headerFooterOf(sectionIdx, cell) : null;
    if (hf && this.has('getCharPropertiesInHeaderFooter')) {
      return this.json('getCharPropertiesInHeaderFooter', sectionIdx, hf.isHeader, hf.applyTo, paraIdx, offset);
    }
    if (cell) {
      return this.json('getCellCharPropertiesAtByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), offset);
    }
    return this.json('getCharPropertiesAt', sectionIdx, paraIdx, offset);
  }

  paraPropsAt(sectionIdx: number, paraIdx: number, cell?: CellAddr): Record<string, unknown> {
    if (cell) {
      return this.json('getCellParaPropertiesAtByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx));
    }
    return this.json('getParaPropertiesAt', sectionIdx, paraIdx);
  }

  /**
   * 글자 서식. 빈 문단(글자 0개)은 0..0 으로 부른다 — 엔진은 그 문단 끝 모양(이어 칠 글자의 모양)을
   * 바꾸고 줄 높이를 다시 잰다. 그래야 빈 줄의 글자 크기를 바꾸면 빈 줄 높이가 실제로 바뀐다.
   * 글자가 있는 문단의 빈 범위는 바꿀 것이 없으니 부르지 않는다.
   */
  applyCharFormat(sectionIdx: number, paraIdx: number, start: number, end: number, props: Record<string, unknown>, cell?: CellAddr): void {
    if (end < start) return;
    if (end === start && (start !== 0 || this.length(sectionIdx, paraIdx, cell) !== 0)) return;
    const read = this.formatLog && this.formatLog.length < FORMAT_LOG_LIMIT
      ? () => this.charPropsAt(sectionIdx, paraIdx, start, cell) : null;
    const before = read ? safeRead(read) : null;
    this.applyCharFormatRaw(sectionIdx, paraIdx, start, end, props, cell);
    if (read && before) this.logFormat('char', props, before, safeRead(read));
  }

  private applyCharFormatRaw(sectionIdx: number, paraIdx: number, start: number, end: number, props: Record<string, unknown>, cell?: CellAddr): void {
    const json = JSON.stringify(props);
    const hf = cell ? this.headerFooterOf(sectionIdx, cell) : null;
    if (hf) {
      this.json('applyCharFormatInHeaderFooter', sectionIdx, hf.isHeader, hf.applyTo, paraIdx, start, paraIdx, end, json);
    } else if (cell) {
      this.json('applyCharFormatInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), start, end, json);
    } else {
      this.json('applyCharFormat', sectionIdx, paraIdx, start, end, json);
    }
  }

  applyParaFormat(sectionIdx: number, paraIdx: number, props: Record<string, unknown>, cell?: CellAddr): void {
    const read = this.formatLog && this.formatLog.length < FORMAT_LOG_LIMIT
      ? () => this.paraPropsAt(sectionIdx, paraIdx, cell) : null;
    const before = read ? safeRead(read) : null;
    this.applyParaFormatRaw(sectionIdx, paraIdx, props, cell);
    if (read && before) this.logFormat('para', props, before, safeRead(read));
  }

  private logFormat(kind: 'char' | 'para', props: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown> | null): void {
    const keys = Object.keys(props);
    const pick = (src: Record<string, unknown> | null, fallback: boolean): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (src && key in src) out[key] = src[key];
        else if (fallback) out[key] = props[key];
      }
      // 글꼴은 번호보다 이름이 읽힌다
      if (keys.includes('fontId') && src && typeof src['fontFamily'] === 'string') out['fontFamily'] = src['fontFamily'];
      return out;
    };
    this.formatLog?.push({ kind, keys, before: pick(before, false), after: pick(after, true) });
  }

  private applyParaFormatRaw(sectionIdx: number, paraIdx: number, props: Record<string, unknown>, cell?: CellAddr): void {
    const json = JSON.stringify(props);
    if (cell) {
      this.json('applyParaFormatInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), json);
    } else {
      this.json('applyParaFormat', sectionIdx, paraIdx, json);
    }
  }

  // ─── 개체·표 ───────────────────────────────────────────

  /** 본문 개체(표·그림·도형·수식) 목록 — getObjects 의 전역 문단 번호를 구역 좌표로 옮긴다. */
  objects(): ObjectRef[] {
    if (this.objectsMemo) return this.objectsMemo;
    const out: ObjectRef[] = [];
    if (this.has('getObjects')) {
      const raw = this.json<Array<{ para: number; controlIndex: number; kind: string }>>('getObjects') ?? [];
      const counts: number[] = [];
      for (let s = 0; s < this.sectionCount(); s++) counts.push(this.paragraphCount(s));
      for (const item of raw) {
        let para = item.para;
        let sec = 0;
        while (sec < counts.length - 1 && para >= counts[sec]) { para -= counts[sec]; sec++; }
        out.push({ sectionIdx: sec, paraIdx: para, controlIdx: item.controlIndex, kind: item.kind });
      }
    } else {
      // 개체 목록이 없는 엔진 — 문단 컨트롤을 표 질의로 훑는다.
      for (let s = 0; s < this.sectionCount(); s++) {
        const n = this.paragraphCount(s);
        for (let p = 0; p < n; p++) {
          let positions: unknown[] = [];
          try { positions = this.json<unknown[]>('getControlTextPositions', s, p) ?? []; } catch { positions = []; }
          for (let c = 0; c < positions.length; c++) {
            try {
              this.tableDims(s, p, c);
              out.push({ sectionIdx: s, paraIdx: p, controlIdx: c, kind: 'table' });
            } catch { /* 표가 아니다 */ }
          }
        }
      }
    }
    this.objectsMemo = out;
    return out;
  }

  tables(): ObjectRef[] {
    return this.objects().filter((o) => o.kind === 'table');
  }

  tableDims(sectionIdx: number, paraIdx: number, controlIdx: number): TableDims {
    return this.json<TableDims>('getTableDimensions', sectionIdx, paraIdx, controlIdx);
  }

  /** 중첩 표(경로) 크기 — 표가 아니면 던진다. tablePath 의 마지막 항목이 그 표 컨트롤이다. */
  tableDimsByPath(sectionIdx: number, paraIdx: number, tablePath: CellPathEntry[]): TableDims {
    return this.json<TableDims>('getTableDimensionsByPath', sectionIdx, paraIdx, JSON.stringify(tablePath));
  }

  cellInfo(sectionIdx: number, paraIdx: number, controlIdx: number, cellIdx: number): CellInfo {
    return this.json<CellInfo>('getCellInfo', sectionIdx, paraIdx, controlIdx, cellIdx);
  }

  /** 중첩 셀 정보 — path 의 마지막 항목이 그 셀이다. */
  cellInfoByPath(sectionIdx: number, paraIdx: number, path: CellPathEntry[]): CellInfo {
    return this.json<CellInfo>('getCellInfoByPath', sectionIdx, paraIdx, JSON.stringify(path));
  }

  // ─── 표 주소(최상위·경로) 공통 ───────────────────────────

  /** 표 주소의 셀 경로 — 마지막 항목의 cellIndex 를 cellIdx 로 (셀 문단 0) */
  tableCellPath(t: TableRef, cellIdx: number): CellPathEntry[] {
    const base = t.path && t.path.length > 0
      ? t.path.map((e) => ({ ...e }))
      : [{ controlIndex: t.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
    base[base.length - 1] = { ...base[base.length - 1], cellIndex: cellIdx, cellParaIndex: 0 };
    return base;
  }

  tableDimsOf(t: TableRef): TableDims {
    return t.path && t.path.length > 1
      ? this.tableDimsByPath(t.sectionIdx, t.paraIdx, t.path)
      : this.tableDims(t.sectionIdx, t.paraIdx, t.controlIdx);
  }

  cellInfoOf(t: TableRef, cellIdx: number): CellInfo {
    return t.path && t.path.length > 1
      ? this.cellInfoByPath(t.sectionIdx, t.paraIdx, this.tableCellPath(t, cellIdx))
      : this.cellInfo(t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
  }

  /** 셀 속성(HWPUNIT) — getCellProperties(ByPath) */
  cellPropsOf(t: TableRef, cellIdx: number): Record<string, unknown> {
    return t.path && t.path.length > 1
      ? this.json('getCellPropertiesByPath', t.sectionIdx, t.paraIdx, JSON.stringify(this.tableCellPath(t, cellIdx)), cellIdx)
      : this.json('getCellProperties', t.sectionIdx, t.paraIdx, t.controlIdx, cellIdx);
  }

  /** 경로 표인가 (중첩 표·머리말/꼬리말 안 표) */
  isPathTable(t: TableRef): boolean {
    return !!t.path && t.path.length > 1;
  }

  /**
   * 표 쓰기 — 최상위 표는 평면 메서드 `flat(sec, para, ctrl, ...args)`, 경로 표는
   * `byPath(sec, para, pathJson, ...args)`. 엔진 빌드(pkg/)가 낡아 경로 메서드가 없으면
   * 무엇이 필요한지 알리는 ENGINE_UNSUPPORTED 로 거절한다.
   */
  tableWrite<T = Record<string, unknown>>(t: TableRef, flat: string, byPath: string, ...args: unknown[]): T {
    if (!this.isPathTable(t)) return this.json<T>(flat, t.sectionIdx, t.paraIdx, t.controlIdx, ...args);
    this.requirePathMethod(byPath);
    return this.json<T>(byPath, t.sectionIdx, t.paraIdx, JSON.stringify(this.tableCellPath(t, 0)), ...args);
  }

  /** 경로 표 메서드가 이 엔진 빌드에 있는지 — 없으면 ENGINE_UNSUPPORTED */
  requirePathMethod(method: string): void {
    if (this.has(method)) return;
    throw new DoogleToolError(
      'ENGINE_UNSUPPORTED',
      `This engine build has no ${method}() — this edit on a nested or header/footer table needs the document engine rebuilt from the current source (wasm-pack). `
        + 'Available on such tables in this build: edit_table set_column_widths / set_row_heights / fit_to_page, set_cell_props widthMm/heightMm, get_table_properties, and text/char/para tools with cell + cellPath.',
      { method },
    );
  }

  /** 셀 크기 증감(HWPUNIT) — 경로 표는 resizeTableCellsByPath (중첩 표도 그 표에 적용된다) */
  resizeCells(t: TableRef, updates: Array<{ cellIdx: number; widthDelta?: number; heightDelta?: number }>): void {
    if (updates.length === 0) return;
    const json = JSON.stringify(updates);
    if (t.path && t.path.length > 1) {
      this.json('resizeTableCellsByPath', t.sectionIdx, t.paraIdx, JSON.stringify(this.tableCellPath(t, 0)), json);
    } else {
      this.json('resizeTableCells', t.sectionIdx, t.paraIdx, t.controlIdx, json);
    }
  }

  /**
   * 이 셀(중첩 포함) 안에 놓인 표들 — 각 항목은 그 표의 첫 셀까지의 경로다
   * (마지막 항목의 controlIndex 가 표 컨트롤, cellParaIndex 앞 항목이 표가 놓인 셀 문단).
   * 엔진에 질의가 없으면 빈 배열.
   */
  nestedTables(sectionIdx: number, cell: CellAddr): CellPathEntry[][] {
    if (!this.has('getTableControlsInSelection')) return [];
    try {
      const count = this.cellParagraphCount(sectionIdx, cell);
      if (count < 1) return [];
      // 끝 오프셋은 문단 길이보다 넉넉히 — 표만 든 문단은 길이가 0 이라 [0,0) 으로 물으면 아무것도 안 잡힌다
      const raw = this.json<Array<{ cellPath?: CellPathEntry[] }>>(
        'getTableControlsInSelection', sectionIdx, cell.paraIdx, this.pathJson(cell, 0), 0, 0, count - 1, 1_000_000,
      );
      return (Array.isArray(raw) ? raw : []).map((r) => r.cellPath ?? []).filter((p) => p.length >= 2);
    } catch {
      return [];
    }
  }

  // ─── 문단 단위 ─────────────────────────────────────────

  /** 문단 안 컨트롤들의 글자 위치 (컨트롤 번호 순). */
  controlPositions(sectionIdx: number, paraIdx: number): number[] {
    try {
      const raw = this.json<unknown>('getControlTextPositions', sectionIdx, paraIdx);
      return Array.isArray(raw) ? raw.map((v) => Number(v) || 0) : [];
    } catch {
      return [];
    }
  }

  /** 본문 문단 범위에 놓인 개체(표·그림·도형·수식) — 글자 위치를 함께 준다. */
  objectsIn(sectionIdx: number, paraStart: number, paraEnd: number): Array<ObjectRef & { charOffset: number }> {
    const out: Array<ObjectRef & { charOffset: number }> = [];
    for (const o of this.objects()) {
      if (o.sectionIdx !== sectionIdx || o.paraIdx < paraStart || o.paraIdx > paraEnd) continue;
      const positions = this.controlPositions(sectionIdx, o.paraIdx);
      out.push({ ...o, charOffset: positions[o.controlIdx] ?? 0 });
    }
    return out;
  }

  /** paraIdx 자리에 빈 문단을 넣는다(0..문단 수). 새 문단은 앞 문단의 모양을 잇는다. */
  insertParagraph(sectionIdx: number, paraIdx: number): void {
    this.json('insertParagraph', sectionIdx, paraIdx);
    this.invalidate();
  }

  /** 문단 하나를 통째로 지운다 — 그 문단의 개체도 함께 사라진다. */
  deleteParagraph(sectionIdx: number, paraIdx: number): void {
    this.json('deleteParagraph', sectionIdx, paraIdx);
    this.invalidate();
  }

  /** 문단 모양·글자 모양 번호 (서식 복사용). 못 읽으면 null. */
  shapeIds(sectionIdx: number, paraIdx: number): { paraShapeId: number | null; charShapeId: number | null } {
    let paraShapeId: number | null = null;
    let charShapeId: number | null = null;
    try {
      const v = this.paraPropsAt(sectionIdx, paraIdx)['paraShapeId'];
      if (typeof v === 'number') paraShapeId = v;
    } catch { /* 없음 */ }
    try {
      const len = this.length(sectionIdx, paraIdx);
      const runs = len > 0 ? this.charShapeRuns(sectionIdx, paraIdx, 0, len) : [];
      // 가장 긴 구간의 글자 모양을 그 문단의 대표로 본다
      let best = -1;
      for (const r of runs) {
        const span = r.endOffset - r.startOffset;
        if (span > best) { best = span; charShapeId = r.charShapeId; }
      }
      if (charShapeId === null) {
        const c = this.charPropsAt(sectionIdx, paraIdx, 0)['charShapeId'];
        if (typeof c === 'number') charShapeId = c;
      }
    } catch { /* 없음 */ }
    return { paraShapeId, charShapeId };
  }

  setParaShapeId(sectionIdx: number, paraIdx: number, id: number): void {
    this.json('setParaShapeId', sectionIdx, paraIdx, id);
  }

  /** 글자 모양 번호를 입힌다. 빈 문단(0..0)에도 부른다 — 그 문단에 이어 쓰는 글과 그 자리에 만드는 표가 따른다. */
  setCharShapeId(sectionIdx: number, paraIdx: number, start: number, end: number, id: number): void {
    if (end >= start) this.json('setCharShapeId', sectionIdx, paraIdx, start, end, id);
  }

  /** 본문 범위를 내부 클립보드에 복사한다(개체 포함). */
  copySelection(sectionIdx: number, startPara: number, startOffset: number, endPara: number, endOffset: number): void {
    this.json('copySelection', sectionIdx, startPara, startOffset, endPara, endOffset);
  }

  /** 내부 클립보드를 붙인다 — 끝난 자리를 돌려준다. */
  pasteInternal(sectionIdx: number, paraIdx: number, offset: number): { paraIdx: number; charOffset: number } {
    const r = this.json<{ paraIdx?: number; charOffset?: number }>('pasteInternal', sectionIdx, paraIdx, offset);
    this.invalidate();
    return { paraIdx: r?.paraIdx ?? paraIdx, charOffset: r?.charOffset ?? 0 };
  }

  /** 셀 주소가 가리키는 셀이 실제로 있는지 확인한다. */
  validateCell(sectionIdx: number, cell: CellAddr): void {
    if (cell.path && cell.path.length > 1) {
      // 중첩 표·머리말/꼬리말 안 표 — 경로 끝의 표와 셀까지 확인한다(바깥 셀만 보면 틀린 경로가 엔진 깊숙이 간다)
      let inner: TableDims;
      try {
        inner = this.tableDimsByPath(sectionIdx, cell.paraIdx, cell.path);
      } catch {
        throw new DoogleToolError(
          'INVALID_ARGS',
          `cellPath ${JSON.stringify(cell.path)} from cell {paraIdx:${cell.paraIdx}, controlIdx:${cell.controlIdx}} does not reach a table in section ${sectionIdx} — copy cell + cellPath from a get_structure "nested table" / header-footer table line or a find_text match`,
        );
      }
      const last = cell.path[cell.path.length - 1];
      if (last.cellIndex >= inner.cellCount) {
        throw new DoogleToolError('INVALID_ARGS', `cellPath last cellIndex ${last.cellIndex} is out of range (that table has ${inner.cellCount} cells)`);
      }
      return;
    }
    if (this.headerFooterOf(sectionIdx, cell)) return;
    let dims: TableDims;
    try {
      dims = this.tableDims(sectionIdx, cell.paraIdx, cell.controlIdx);
    } catch {
      throw new DoogleToolError(
        'INVALID_ARGS',
        `cell {paraIdx:${cell.paraIdx}, controlIdx:${cell.controlIdx}} is not a table in section ${sectionIdx} — take the address from a get_structure table line`,
      );
    }
    if (cell.cellIdx < 0 || cell.cellIdx >= dims.cellCount) {
      throw new DoogleToolError('INVALID_ARGS', `cellIdx ${cell.cellIdx} is out of range (table has ${dims.cellCount} cells)`);
    }
  }

  // ─── 쪽·좌표 ───────────────────────────────────────────

  pageInfo(pageIndex: number): Record<string, number> {
    return this.json('getPageInfo', pageIndex);
  }

  pageOfParagraph(sectionIdx: number, paraIdx: number): number | null {
    try {
      const r = this.json<{ page?: number }>('getPageOfPosition', sectionIdx, paraIdx);
      return typeof r?.page === 'number' ? r.page : null;
    } catch {
      return null;
    }
  }

  selectionRects(sectionIdx: number, startPara: number, startOffset: number, endPara: number, endOffset: number): SelectionRect[] {
    try {
      const raw = this.json<unknown>('getSelectionRects', sectionIdx, startPara, startOffset, endPara, endOffset);
      return Array.isArray(raw) ? raw as SelectionRect[] : [];
    } catch {
      return [];
    }
  }

  tableBBox(sectionIdx: number, paraIdx: number, controlIdx: number): SelectionRect | null {
    try {
      const r = this.json<SelectionRect>('getTableBBox', sectionIdx, paraIdx, controlIdx);
      return r && typeof r.pageIndex === 'number' ? r : null;
    } catch {
      return null;
    }
  }

  /** 표 셀들의 쪽별 상자 — 쪽에 걸친 표의 조각을 얻는다. */
  tableCellBoxes(sectionIdx: number, paraIdx: number, controlIdx: number): Array<{ pageIndex: number; x: number; y: number; w: number; h: number; cellIdx: number }> {
    try {
      const raw = this.json<unknown>('getTableCellBboxes', sectionIdx, paraIdx, controlIdx, undefined);
      return Array.isArray(raw) ? raw as Array<{ pageIndex: number; x: number; y: number; w: number; h: number; cellIdx: number }> : [];
    } catch {
      return [];
    }
  }

  // ─── 스냅샷 ────────────────────────────────────────────

  saveSnapshot(): number {
    return Number(this.call('saveSnapshot'));
  }

  restoreSnapshot(id: number): void {
    this.json('restoreSnapshot', id);
    this.invalidate();
  }

  discardSnapshot(id: number): void {
    try { this.call('discardSnapshot', id); } catch { /* 이미 축출됐다 */ }
  }

  /** 문서 바이트(HWP/HWPX)를 스냅샷으로만 넣는다 — 지금 문서는 그대로 (문서 갈래 복원) */
  importSnapshot(bytes: Uint8Array): number {
    return Number(this.call('importSnapshot', bytes));
  }

  /** 지금 문서를 HWP 바이트로 */
  exportHwp(): Uint8Array {
    const out = this.call('exportHwp');
    if (out instanceof Uint8Array) return out;
    throw new DoogleToolError('ENGINE_ERROR', 'exportHwp returned no bytes', { method: 'exportHwp' });
  }
}

/**
 * 에이전트 문서 편집에 쓰는 엔진 메서드 — get_engine_edit_capabilities 가 이 중 실제로 있는 것만
 * 알리고, apply_engine_edits 는 이 목록 밖의 메서드를 거절한다(읽기 전용·내보내기·렌더 메서드 차단).
 */
export const ENGINE_EDIT_METHODS: Readonly<Record<string, 'document' | 'session'>> = Object.freeze({
  insertText: 'document', deleteText: 'document', deleteRange: 'document', replaceText: 'document',
  replaceAll: 'document', replaceOne: 'document', splitParagraph: 'document', mergeParagraph: 'document',
  insertParagraph: 'document', deleteParagraph: 'document',
  insertTextInCellByPath: 'document', deleteTextInCellByPath: 'document', deleteRangeInCellByPath: 'document',
  splitParagraphInCellByPath: 'document', mergeParagraphInCellByPath: 'document',
  applyCharFormat: 'document', applyCharFormatInCellByPath: 'document', applyParaFormat: 'document',
  applyParaFormatInCellByPath: 'document', applyStyle: 'document', setCharShapeRuns: 'document',
  createTable: 'document', createTableEx: 'document', insertTableRow: 'document', insertTableColumn: 'document',
  deleteTableRow: 'document', deleteTableColumn: 'document', mergeTableCells: 'document', splitTableCellInto: 'document',
  resizeTableCells: 'document', setTableProperties: 'document', setCellProperties: 'document',
  setCellZoneProperties: 'document', deleteTableControl: 'document', equalizeTableCellSizes: 'document',
  setTableCellFormula: 'document', evaluateTableFormula: 'document',
  insertPageBreak: 'document', insertColumnBreak: 'document', setPageDef: 'document', setSectionDef: 'document',
  setColumnDef: 'document', createHeaderFooter: 'document', deleteHeaderFooter: 'document',
  insertTextInHeaderFooter: 'document', deleteTextInHeaderFooter: 'document',
  insertFootnote: 'document', insertEndnote: 'document', insertTextInFootnote: 'document', deleteTextInFootnote: 'document',
  addBookmark: 'document', deleteBookmark: 'document', renameBookmark: 'document',
  setFieldValue: 'document', setFieldValueByName: 'document', insertClickHereField: 'document',
  insertEquation: 'document', setEquationProperties: 'document', createShapeControl: 'document',
  setShapeProperties: 'document', setPictureProperties: 'document', deletePictureControl: 'document',
  deleteShapeControl: 'document', changeShapeZOrder: 'document', insertHyperlinkEx: 'document',
  insertNewNumber: 'document', setNumberingRestart: 'document', setPageBorderFill: 'document',
  ensureDefaultBullet: 'document', ensureDefaultNumbering: 'document', createNumbering: 'document',
  createStyle: 'document', updateStyle: 'document', findOrCreateFontId: 'document',
  copySelection: 'session', copySelectionInCellByPath: 'session', copyControl: 'session',
  pasteInternal: 'document', pasteInternalInCellByPath: 'document', pasteControl: 'document', pasteHtml: 'document',
});
