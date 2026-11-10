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
import { DoogleToolError, scalarLength, type CellAddr, type CellPathEntry, type EngineDoc, type SelectionRect } from './types.ts';

export interface ObjectRef {
  sectionIdx: number;
  paraIdx: number;
  controlIdx: number;
  kind: 'table' | 'picture' | 'shape' | 'equation' | string;
}

export interface TableDims { rowCount: number; colCount: number; cellCount: number }
export interface CellInfo { row: number; col: number; rowSpan: number; colSpan: number }
export interface CharShapeRun { startOffset: number; endOffset: number; charShapeId: number }

function engineMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export class Engine {
  readonly doc: EngineDoc;
  private objectsMemo: ObjectRef[] | null = null;

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
    try {
      return fn.apply(this.doc, args);
    } catch (error) {
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
    let para = paraIdx;
    let at = offset;
    parts.forEach((part, index) => {
      if (index > 0) {
        this.splitParagraph(sectionIdx, para, at, cell);
        para += 1;
        at = 0;
      }
      if (part.length > 0) {
        if (cell) {
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
    if (cell) {
      this.json('splitParagraphInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), offset, undefined);
    } else {
      this.json('splitParagraph', sectionIdx, paraIdx, offset, undefined);
    }
  }

  /** 범위 삭제 (여러 문단 가능). 끝 오프셋은 포함하지 않는다. */
  deleteRange(sectionIdx: number, startPara: number, startOffset: number, endPara: number, endOffset: number, cell?: CellAddr): void {
    if (startPara === endPara && startOffset === endOffset) return;
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

  applyCharFormat(sectionIdx: number, paraIdx: number, start: number, end: number, props: Record<string, unknown>, cell?: CellAddr): void {
    if (end <= start) return;
    const json = JSON.stringify(props);
    if (cell) {
      this.json('applyCharFormatInCellByPath', sectionIdx, cell.paraIdx, this.pathJson(cell, paraIdx), start, end, json);
    } else {
      this.json('applyCharFormat', sectionIdx, paraIdx, start, end, json);
    }
  }

  applyParaFormat(sectionIdx: number, paraIdx: number, props: Record<string, unknown>, cell?: CellAddr): void {
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

  /** 셀 주소가 가리키는 셀이 실제로 있는지 확인한다. */
  validateCell(sectionIdx: number, cell: CellAddr): void {
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
