// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/types.ts (subset)
/**
 * 두글 에이전트 실행기 공용 타입.
 *
 * 이 디렉터리는 업스트림 studio 모듈을 import 하지 않는다 — 문서·undo·화면은 전부
 * `DoogleAgentDeps` 로 주입받는다. 그래서 node 단위 테스트가 타입 제거만으로 읽을 수 있다
 * (enum·매개변수 속성을 쓰지 않는다).
 */

/** 모델에게 돌려줄 수 있는 도구 오류. message 는 모델이 읽고 복구한다. */
export class DoogleToolError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'DoogleToolError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function toolError(code: string, message: string, data?: unknown): DoogleToolError {
  return new DoogleToolError(code, message, data);
}

export function invalidArgs(message: string): DoogleToolError {
  return new DoogleToolError('INVALID_ARGS', message);
}

/** 중첩 셀 경로 한 단계 — 엔진 *ByPath API 와 같은 키. */
export interface CellPathEntry {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

/**
 * 표 셀 주소. paraIdx/controlIdx 는 표가 놓인 본문 문단·컨트롤, cellIdx 는 행 우선 셀 번호.
 * path 가 있으면 중첩 셀까지의 전체 경로다(마지막 cellParaIndex 는 도구의 paraIdx 로 바뀐다).
 */
export interface CellAddr {
  paraIdx: number;
  controlIdx: number;
  cellIdx: number;
  path?: CellPathEntry[];
}

export interface SelectionRect {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ToolOrigin = 'agent' | 'mcp';
export type AgentMode = 'agent' | 'full';

export interface ToolContext {
  origin: ToolOrigin;
  threadId?: string;
  mode: AgentMode;
}

export interface ToolErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: ToolErrorPayload };

/** PNG 결과 블록 — hub/MCP 가 image content 로 바꾼다. */
export interface PngImage {
  mimeType: 'image/png';
  base64: string;
  width?: number;
  height?: number;
}

/**
 * 원시 HwpDocument (wasm-bindgen 객체). 업스트림 `pkg/rhwp.d.ts` 는 빌드 산출물이라 여기서는
 * 구조 타입으로만 다룬다 — 메서드 존재는 engine-adapter 가 실행 시점에 확인한다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EngineDoc = Record<string, any>;

/** EventBus 의 부분집합 (`on` 이 해제 함수를 돌려준다). */
export interface EventSourceLike {
  on(event: string, handler: (...args: unknown[]) => void): () => void;
}

/** 사용자 커서·선택 — studio 좌표 그대로 (get_selection 이 도구 주소로 옮긴다). */
export interface SelectionPoint {
  sectionIndex: number;
  /** 본문 문단(셀 안이면 표가 놓인 본문 문단) */
  parentParaIndex: number;
  /** 셀 안이면 비어 있지 않은 경로 */
  cellPath: CellPathEntry[];
  charOffset: number;
}

export interface SelectionInfo {
  caret: SelectionPoint | null;
  selection: { start: SelectionPoint; end: SelectionPoint; text?: string; truncated?: boolean } | null;
}

/** 캔버스로 그릴 수 있는 것 — HTMLCanvasElement 또는 OffscreenCanvas. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): unknown;
}

/**
 * 실행기 의존성. 두글 studio 진입점(agent F)이 WasmBridge·PluginHost·EventBus 로 채운다.
 */
export interface DoogleAgentDeps {
  /** 지금 열린 문서. 없으면 null — 도구는 NO_DOCUMENT 로 거절한다. */
  getDocument(): EngineDoc | null;
  /**
   * 문서를 바꾸는 유일한 통로 — undo 한 단계. fn 이 던지면 문서는 호출 전으로 되돌아가야 한다
   * (업스트림 PluginHost.transaction / SnapshotCommand 가 그렇게 한다).
   */
  transaction<T>(label: string, fn: (doc: EngineDoc) => T): T;
  /** 문서 변경 이벤트 원천 (EventBus). 사용자 편집도 revision 을 올리게 한다. */
  events?: EventSourceLike;
  /** 문서 인스턴스 번호 (문서 교체 시 바뀐다) — WasmBridge.documentGeneration 등. */
  documentInstance?(): number | undefined;
  /** 사용자 커서·선택 */
  getSelection?(): SelectionInfo | null;
  /** 문서 이름 (get_document_info) */
  getDocumentName?(): string | null;
  /** 저장 안 된 변경이 있는가 */
  isDirty?(): boolean;
  /** 사용할 수 있는 글꼴 이름 (get_document_info fontQuery) */
  listFonts?(): string[];
  /**
   * 쪽을 캔버스에 그린다 (WasmBridge.renderPageToCanvas — 글꼴 해석 문맥 포함).
   * 없으면 원시 문서의 renderPageToCanvas, 그것도 없으면 SVG 래스터로 대신한다.
   */
  renderPageToCanvas?(pageIndex: number, canvas: HTMLCanvasElement, scale: number): void;
  /** 화면을 새로 그리게 한다 (transaction 이 이미 하면 생략) */
  refreshView?(): void;
  /** 시각 — 테스트 주입용 */
  now?(): number;
}

export interface PendingChangeSet {
  id: string;
  threadId: string;
  tool: string;
  summary: string;
  /** 바뀐 쪽 (0-based) */
  pages: number[];
  revision: number;
  createdAt: number;
}

export interface PendingChangeEvent {
  kind: 'added' | 'accepted' | 'rejected';
  threadId: string | null;
  changeSets: PendingChangeSet[];
}

export interface PendingApi {
  list(threadId?: string): PendingChangeSet[];
  acceptAll(threadId?: string): { accepted: number };
  rejectAll(threadId?: string): { rejected: number; userEditsReverted: boolean };
  onChange(cb: (e: PendingChangeEvent) => void): () => void;
  hasPending(threadId?: string): boolean;
}

export interface DoogleAgentRuntime {
  executeTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
  pending: PendingApi;
  revision(): number;
  /** 구독 해제·스냅샷 반환 */
  dispose(): void;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Unicode scalar 길이 — 엔진 오프셋 단위 (UTF-16 길이와 다를 수 있다). */
export function scalarLength(text: string): number {
  let n = 0;
  for (const _ch of text) n++;
  return n;
}

/** scalar 단위로 자른다. */
export function scalarSlice(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join('');
}

// ─── 단위 ───────────────────────────────────────────────
export const HU_PER_MM = 7200 / 25.4;
export function mmToHu(mm: number): number { return Math.round(mm * HU_PER_MM); }
export function huToMm(hu: number): number { return Math.round((hu / HU_PER_MM) * 100) / 100; }
export function ptToHu(pt: number): number { return Math.round(pt * 100); }
/** 쪽 px(96dpi) → mm */
export function pxToMm(px: number): number { return Math.round((px * 25.4 / 96) * 100) / 100; }
export function mmToPx(mm: number): number { return (mm * 96) / 25.4; }
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** "#RRGGBB" → HWP COLORREF (0x00BBGGRR) */
export function colorRef(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return (b << 16) | (g << 8) | r;
}
