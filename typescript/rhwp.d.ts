/**
 * RHWP - HWP 파일 뷰어 TypeScript 타입 정의
 *
 * WASM 모듈에서 노출되는 API의 TypeScript 타입.
 * wasm-pack이 자동 생성하는 pkg/rhwp.d.ts를 보완하는 설계 문서.
 */

/** 명시 variable-font instance의 지원 mode. */
export type ExactFontInstanceMode = 'boundedHorizontalLtrV1';

/** variable font axis 좌표. tag는 OpenType 4-byte ASCII axis tag다. */
export interface ExactFontInstanceAxis {
  tag: string;
  value: number;
}

/** setExactFontInstance 입력. font bytes는 registerExactFontSource로 별도 등록한다. */
export interface SetExactFontInstanceOptions {
  charShapeId: number;
  languageIndex: number;
  mode: ExactFontInstanceMode;
  axes: ExactFontInstanceAxis[];
}

/** clearExactFontInstance 입력. */
export interface ClearExactFontInstanceOptions {
  charShapeId: number;
  languageIndex: number;
  mode: ExactFontInstanceMode;
}

/** exact instance command의 JSON 응답. */
export interface ExactFontInstanceResult {
  ok: true;
  status: 'registered' | 'updated' | 'already-registered' | 'cleared' | 'already-cleared';
  mode: ExactFontInstanceMode;
  slot: { charShapeId: number; languageIndex: number };
  axes: ExactFontInstanceAxis[];
  sourceGeneration: number;
  requestGeneration: number;
  requestCount: number;
}

/** HWP 문서 객체 */
export class HwpDocument {
  /** HWP 파일 바이트로부터 문서를 로드한다. */
  constructor(data: Uint8Array);

  /** 빈 문서를 생성한다 (테스트/미리보기용). */
  static createEmpty(): HwpDocument;

  /** 총 페이지 수를 반환한다. */
  pageCount(): number;

  /** 특정 페이지를 SVG 문자열로 렌더링한다. */
  renderPageSvg(pageNum: number): string;

  /** 특정 페이지를 HTML 문자열로 렌더링한다. */
  renderPageHtml(pageNum: number): string;

  /** 특정 페이지를 Canvas 명령 수로 반환한다. */
  renderPageCanvas(pageNum: number): number;

  /** 페이지 정보를 JSON 문자열로 반환한다. */
  getPageInfo(pageNum: number): string;

  /** 문서 정보를 JSON 문자열로 반환한다. */
  getDocumentInfo(): string;

  /** 확정된 font bytes를 exact layout slot에 등록한다. */
  registerExactFontSource(
    charShapeId: number,
    languageIndex: number,
    fontBytes: Uint8Array,
    faceIndex: number,
  ): string;

  /** exact slot에 strict opt-in variable-font instance 요청을 설정한다. */
  setExactFontInstance(optionsJson: string): string;

  /** exact slot 하나의 variable-font instance 요청을 제거한다. */
  clearExactFontInstance(optionsJson: string): string;

  /** DPI를 설정한다. */
  setDpi(dpi: number): void;

  /** 현재 DPI를 반환한다. */
  getDpi(): number;

  // ─── 두글(doogle) 에이전트 API — banatic/rhwp-x (MIT) 에서 이식 ───────────
  // 목록·상태: docs/doogle/ENGINE_GAPS.md. 반환 JSON 은 rhwp-x 와 같다.

  /** 본문 문단 하나를 통째로 보관하고 보관 ID를 반환한다 (대기 편집 역연산). */
  captureParagraph(sec: number, para: number): number;
  /** 보관본으로 지정 위치의 본문 문단을 되돌린다. 보관본은 유지된다. */
  restoreCapturedParagraph(id: number, sec: number, para: number): void;
  /** 보관본을 해제한다. */
  discardParagraphCapture(id: number): void;
  /** 레이아웃을 뺀 본문 문단 내용 지문 (16자리 hex). */
  getParagraphContentDigest(sec: number, para: number): string;

  /** `getPageInfo` 결과의 JSON 배열. */
  getAllPageInfo(): string;
  /** 쪽의 줄 배치 JSON `{"lines":[{x,y,w,h,bl,sec?,para?,cs?,ce?,tx0?,tx1?,area?,cell?:{pp,path},runs:[[x,w,cs,ce]]}]}` (px). */
  getPageLineLayout(pageNum: number): string;
  /**
   * 그림/수식 렌더 경계 JSON `{"pageIndex","x","y","width","height"}`.
   * doogle 제한: 셀 안 그림 미지원, 셀 수식은 깊이 1 경로만, innerControlIdx 무시(셀 문단의 첫 수식).
   */
  getObjectBBox(
    kind: 'image' | 'equation',
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx?: number,
    cellParaIdx?: number,
    innerControlIdx?: number,
    cellPathJson?: string,
  ): string;
  /** 선택 범위에 통째로 든 표 주소 JSON `[{sec,ppi,ci,cellPath}]`. 본문은 containerPathJson = "[]". */
  getTableControlsInSelection(
    sec: number,
    parentPara: number,
    containerPathJson: string,
    startPara: number,
    startOffset: number,
    endPara: number,
    endOffset: number,
  ): string;
  /** 등록 글꼴 목록 JSON `[{lang,id,name}]` (대체 해소 없는 원본 이름). */
  getFontList(): string;

  /** 셀 문단: 캐럿 논리 오프셋 → 텍스트 오프셋. */
  logicalToTextOffsetInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, logicalOffset: number): number;
  /** 중첩 셀 문단: 캐럿 논리 오프셋 → 텍스트 오프셋. */
  logicalToTextOffsetInCellByPath(sec: number, parentPara: number, pathJson: string, logicalOffset: number): number;
  /** 중첩 셀 문단: 텍스트 오프셋 → 캐럿 논리 오프셋. */
  textToLogicalOffsetInCellByPath(sec: number, parentPara: number, pathJson: string, textOffset: number): number;
  /** 중첩 셀 문단의 캐럿 길이 (텍스트 + 인라인 개체 슬롯). */
  getCellLogicalLengthByPath(sec: number, parentPara: number, pathJson: string): number;

  /** 열 폭(HWPUNIT) 지정. 반환 `{"ok":true,"colCount":N,"tableWidth":W}`. */
  setTableColumnWidths(sec: number, parentPara: number, controlIdx: number, widths: Uint32Array | number[]): string;
  /** 표를 본문 폭에 맞춰 비례 축소 (축소 전용). */
  fitTableToPage(sec: number, parentPara: number, controlIdx: number): string;
  /** 최상위 floating 개체 z-order. 반환 `{"ok":true,"zOrder":N}`. */
  changeObjectZOrder(sec: number, parentPara: number, controlIdx: number, operation: 'front' | 'back' | 'forward' | 'backward'): string;

  /** 셀 문단에 수식 삽입 (텍스트 오프셋). `logical=true` 는 오류. 반환 `{"ok":true,"cellParaIdx","controlIdx"}`. */
  insertEquationInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical?: boolean): string;
  /** 중첩 셀 문단에 수식 삽입. */
  insertEquationInCellByPath(sec: number, parentPara: number, cellPathJson: string, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical?: boolean): string;
  /** 셀 문단의 수식 컨트롤 삭제. */
  deleteEquationControlInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, eqControlIdx: number): string;
  /** 중첩 셀 문단의 수식 컨트롤 삭제. */
  deleteEquationControlInCellByPath(sec: number, parentPara: number, cellPathJson: string, eqControlIdx: number): string;
  /** 셀 문단 지정 수식의 스크립트 `{"ok":true,"script"}`. */
  getEquationScriptInCellAt(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, eqControlIdx: number): string;
  /** 수식 속성 (음수 셀 인자 = 본문 수식). */
  getEquationPropertiesAt(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, innerControlIdx: number): string;
  /** 중첩 셀 문단의 정확한 수식 속성. */
  getEquationPropertiesByPath(sec: number, parentPara: number, cellPathJson: string, innerControlIdx: number): string;

  /** 메모리를 해제한다 (WASM). */
  free(): void;
}

/** HWP 뷰어 컨트롤러 (뷰포트 관리 + 렌더링 스케줄링) */
export class HwpViewer {
  /** 뷰어를 생성한다. document 소유권이 이전된다. */
  constructor(document: HwpDocument);

  /** 뷰포트를 업데이트한다 (스크롤/리사이즈 시 호출). */
  updateViewport(scrollX: number, scrollY: number, width: number, height: number): void;

  /** 줌을 설정한다 (1.0 = 100%). */
  setZoom(zoom: number): void;

  /** 현재 보이는 페이지 목록을 반환한다. */
  visiblePages(): Uint32Array;

  /** 대기 중인 렌더링 작업 수를 반환한다. */
  pendingTaskCount(): number;

  /** 총 페이지 수를 반환한다. */
  pageCount(): number;

  /** 특정 페이지를 SVG 문자열로 렌더링한다. */
  renderPageSvg(pageNum: number): string;

  /** 특정 페이지를 HTML 문자열로 렌더링한다. */
  renderPageHtml(pageNum: number): string;

  /** 메모리를 해제한다 (WASM). */
  free(): void;
}

/** 페이지 정보 (getPageInfo 반환값) */
export interface PageInfo {
  pageIndex: number;
  width: number;
  height: number;
  sectionIndex: number;
}

/** 문서 정보 (getDocumentInfo 반환값) */
export interface DocumentInfo {
  version: string;
  sectionCount: number;
  pageCount: number;
  encrypted: boolean;
}

/** WASM 모듈 초기화 */
export default function init(): Promise<void>;

/** 버전 문자열 반환 */
export function version(): string;
