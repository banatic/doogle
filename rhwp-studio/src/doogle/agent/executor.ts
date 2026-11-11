// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/tool-executor.ts
/**
 * 두글 도구 실행기 — hub(또는 MCP 중계)가 보낸 tool_call 을 문서 호출로 바꾼다.
 *
 * - 모든 read 결과에 revision, 모든 write 는 expectedRevision 을 먼저 검사한다 (REVISION_MISMATCH).
 *   서로 다른 문단의 형제 편집은 편집 저널로 자동 리베이스한다(rebasedParaShift).
 * - write 는 deps.transaction 한 번 = undo 한 단계. apply_edits 는 항목 전부를 한 transaction 에서
 *   돌리고 하나라도 실패하면 던져 전체를 되돌린다(실패 항목을 모두 보고).
 * - 에이전트 모드: 쓰기는 즉시 적용되고 검토 대기(PendingStaging)로 남는다. 전체 모드: 바로 적용.
 * - 쓰기 결과에 after {paragraphs, pageCountBefore, pageCount, pages, warnings} 와
 *   render:"crop"|"page" 의 PNG(image {mimeType, base64})를 붙인다.
 */
import { EditJournal, type EditJournalEntry } from './edit-journal.ts';
import { Engine, ENGINE_EDIT_METHODS } from './engine-adapter.ts';
import { ENGINE_METHOD_SIGNATURES, checkEngineArgs, engineSignatureText } from './engine-signatures.ts';
import { RevisionTracker, timeSeededRevision } from './revision.ts';
import { PendingStaging } from './pending.ts';
import { renderPagePng, renderStackedRegions } from './render.ts';
import {
  StructureReader, collectPageStarts, renderCompactStructure, structureParagraphLine,
  type PageStart, type StructureData,
} from './structure.ts';
import {
  AFTER_MAX_PAGES, AFTER_MAX_PARAGRAPHS, AFTER_TEXT_CHARS, AFTER_WINDOW_LEAD, RENDER_MAX_PAGES,
  movedParagraphRuns, movedRunWarnings, planCropRegions, type CropRegion, type PageFrame, type SectionEdit,
} from './write-report.ts';
import {
  BATCHABLE_EDIT_TOOLS, WRITE_HANDLERS, engineMatchSource, optCell, optInt, reqInt, reqString, sectionOf, validateAddress,
  type Touch, type WriteScope,
} from './write-tools.ts';
import type { ResolvedAnchor } from './anchor.ts';
import {
  DoogleToolError, asRecord, colorRef, huToMm, invalidArgs, mmToPx, pxToMm, scalarLength, scalarSlice,
  type CellAddr, type DoogleAgentDeps, type FormatDiff, type PendingChangeTarget, type PngImage, type SelectionPoint, type SelectionRect, type ToolContext, type ToolResult,
} from './types.ts';

/** read_batch 항목 — definitions.mjs BATCHABLE_READ_TOOL_NAMES 와 같아야 한다 */
export const BATCHABLE_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_structure', 'get_text_range', 'get_selection', 'get_fields', 'get_document_info', 'find_text', 'get_page_geometry',
  'get_para_format', 'get_char_format', 'get_table_properties', 'get_table_layout', 'get_engine_edit_capabilities',
  'list_styles', 'list_numberings', 'get_outline', 'list_footnotes', 'list_bookmarks', 'preview_equation', 'verify_changes',
]);

/** hub 가 직접 처리하는 대화 제어 도구 — studio 에 오면 안 된다 */
const CONTROL_TOOLS = new Set(['ask_user_question', 'request_permission', 'present_implementation_plan', 'update_todos']);

const APPLY_EDITS_MAX = 32;
const READ_BATCH_MAX = 16;
const PAGE_STARTS_FOR_REPORT_LIMIT = 200;
/** SVG 는 글로 모델에 들어간다 — 한 쪽이 보통 30만 자를 넘으므로 작은 쪽·작은 영역이 아니면 거절한다 */
const MAX_SVG_BYTES = 100_000;

type ReadHandler = (args: Record<string, unknown>, ctx: ToolContext, engine: Engine) => unknown | Promise<unknown>;

interface BatchState {
  index: number;
  tool: string;
  removals: Array<{ index: number; tool: string; text: string }>;
  journal: EditJournalEntry[];
}

interface WriteBaseline {
  pageCount: number;
  paragraphCounts: number[];
  pageStarts: PageStart[] | null;
}

function cellJson(cell?: CellAddr): Record<string, unknown> {
  if (!cell) return {};
  return {
    cell: { paraIdx: cell.paraIdx, controlIdx: cell.controlIdx, cellIdx: cell.cellIdx },
    ...(cell.path ? { cellPath: cell.path } : {}),
  };
}

/**
 * studio 명령 경계(`StudioCommandError`)는 진짜 원인을 `cause` 에 감추고 롤백 확인을 비동기 `report` 로 낸다.
 * 1) 보고가 끝나기 전에 다음 쓰기를 하면 '복구 중' 세션이 같은 오류로 거절하므로 기다리고,
 * 2) 모델·화면에는 감춰진 원인(예: BATCH_FAILED 항목별 사유)을 그대로 돌려준다.
 * upstream 클래스를 import 하지 않고 모양으로 판별한다(실행기는 node 테스트에서도 돈다).
 */
async function settleCommandError(error: unknown): Promise<unknown> {
  const e = error as { name?: unknown; cause?: unknown; report?: unknown } | null;
  if (!e || e.name !== 'StudioCommandError') return error;
  let recovery: unknown = 'unknown';
  if (e.report && typeof (e.report as Promise<unknown>).then === 'function') {
    try { recovery = ((await e.report) as { recovery?: unknown } | null)?.recovery; } catch { /* 보고 실패 = 확인 못 함 */ }
  }
  if (recovery !== 'succeeded') {
    const why = e.cause instanceof Error ? e.cause.message : typeof e.cause === 'string' ? e.cause : '';
    return new DoogleToolError(
      'EDITOR_BLOCKED',
      `The edit failed and the editor could not confirm the rollback, so further edits are blocked for this document. `
        + `Stop editing and tell the user to undo (Ctrl+Z) or reopen the document.${why ? ` Cause: ${why}` : ''}`,
    );
  }
  return e.cause ?? error;
}

function errorPayload(error: unknown): ToolResult {
  if (error instanceof DoogleToolError) {
    return { ok: false, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: 'INTERNAL_ERROR', message } };
}

export class DoogleToolExecutor {
  private readonly deps: DoogleAgentDeps;
  readonly tracker: RevisionTracker;
  readonly journal = new EditJournal();
  readonly staging: PendingStaging;
  private batch: BatchState | null = null;
  private reviewNotes = new Map<string, Record<string, unknown>>();
  /** verify_changes 증분 커서 — 스레드별 마지막으로 보고한 change set 수 */
  private verifiedUpTo = new Map<string, number>();
  private lastInstance: number | undefined;
  private readonly reads: Record<string, ReadHandler>;

  constructor(deps: DoogleAgentDeps) {
    this.deps = deps;
    this.tracker = new RevisionTracker(deps.events, {
      documentInstance: deps.documentInstance ? () => deps.documentInstance!() : undefined,
      initialRevision: timeSeededRevision(deps.now?.() ?? Date.now()),
    });
    this.lastInstance = deps.documentInstance?.();
    this.staging = new PendingStaging(deps, {
      noteWrite: (revBefore) => this.tracker.noteWrite(revBefore),
      revision: () => this.tracker.revision,
      noteReview: (threadId, report) => this.reviewNotes.set(threadId, report),
    });
    this.reads = {
      get_structure: (a, _c, e) => this.getStructure(a, e),
      get_outline: (a, _c, e) => this.getOutline(a, e),
      get_text_range: (a, _c, e) => this.getTextRange(a, e),
      get_selection: (_a, _c, e) => this.getSelection(e),
      find_text: (a, _c, e) => this.findText(a, e),
      get_document_info: (a, _c, e) => this.getDocumentInfo(a, e),
      get_fields: (_a, _c, e) => this.getFields(e),
      get_para_format: (a, _c, e) => this.getParaFormat(a, e),
      get_char_format: (a, _c, e) => this.getCharFormat(a, e),
      get_table_properties: (a, _c, e) => this.getTableProperties(a, e),
      get_table_layout: (a, _c, e) => this.getTableLayout(a, e),
      list_styles: (_a, _c, e) => ({ revision: this.revision, styles: e.json('getStyleList') ?? [] }),
      list_numberings: (_a, _c, e) => ({ revision: this.revision, numberings: e.json('getNumberingList') ?? [] }),
      list_footnotes: (_a, _c, e) => this.listFootnotes(e),
      list_bookmarks: (_a, _c, e) => this.listBookmarks(e),
      render_page: (a, _c, e) => this.renderPage(a, e),
      get_page_geometry: (a, _c, e) => this.getPageGeometry(a, e),
      preview_equation: (a, _c, e) => this.previewEquation(a, e),
      verify_changes: (a, c, e) => this.verifyChanges(a, c, e),
      get_engine_edit_capabilities: (a, _c, e) => this.getEngineEditCapabilities(a, e),
    };
  }

  get revision(): number {
    return this.tracker.revision;
  }

  dispose(): void {
    this.tracker.dispose();
    this.staging.dispose();
  }

  // ─── 진입점 ─────────────────────────────────────────────

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await this.dispatch(name, asRecord(rawArgs), ctx);
      const thread = this.threadOf(ctx);
      const note = this.reviewNotes.get(thread);
      if (note && result && typeof result === 'object' && !Array.isArray(result)) {
        this.reviewNotes.delete(thread);
        return { ok: true, result: { ...(result as Record<string, unknown>), editReport: note } };
      }
      return { ok: true, result };
    } catch (error) {
      return errorPayload(error);
    }
  }

  private threadOf(ctx: ToolContext): string {
    return ctx.threadId ?? (ctx.origin === 'mcp' ? 'mcp' : 'agent');
  }

  private engine(): Engine {
    const doc = this.deps.getDocument();
    if (!doc) throw new DoogleToolError('NO_DOCUMENT', '두글에서 문서를 열어주세요 — no document is open in the studio.');
    // 문서가 바뀌었으면 이전 문서의 스테이징은 의미가 없다
    const instance = this.deps.documentInstance?.();
    if (instance !== this.lastInstance) {
      this.lastInstance = instance;
      this.staging.reset();
      this.journal.clear();
    }
    const engine = new Engine(doc);
    if (engine.sectionCount() === 0) throw new DoogleToolError('NO_DOCUMENT', 'No document is loaded in the studio; ask the user to open one.');
    return engine;
  }

  private async dispatch(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    if (CONTROL_TOOLS.has(name)) {
      throw new DoogleToolError('NOT_HANDLED_IN_STUDIO', `${name} is a conversation-control tool handled by the hub, not the document executor.`);
    }
    if ('documentId' in args) throw invalidArgs('documentId is not supported — tools always target the open document');
    if (name === 'read_batch') return this.readBatch(args, ctx);
    if (name === 'apply_edits') return this.applyEdits(args, ctx);
    if (name === 'apply_engine_edits') return this.applyEngineEdits(args, ctx);
    if (name === 'prepare_engine_edit_session') return this.prepareEngineEditSession(args);
    if (name === 'insert_chart') {
      throw new DoogleToolError('ENGINE_UNSUPPORTED', 'insert_chart is not available in 두글 v1 — build the data as a table with create_table instead.');
    }
    const read = this.reads[name];
    if (read) return read(args, ctx, this.engine());
    if (WRITE_HANDLERS[name]) return this.runWrite(name, args, ctx);
    throw new DoogleToolError('UNKNOWN_TOOL', `unknown tool ${JSON.stringify(name)}`);
  }

  // ─── revision 검사 ───────────────────────────────────────

  private expectedOf(args: Record<string, unknown>): number {
    const expected = args['expectedRevision'];
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
      throw invalidArgs('expectedRevision (integer) is required for write tools — use the revision from your most recent read');
    }
    return expected;
  }

  private mismatch(current: number, expected: number, detail: string): DoogleToolError {
    return new DoogleToolError('REVISION_MISMATCH', `Document is now at revision ${current}; you expected ${expected}. ${detail}`, { currentRevision: current });
  }

  private batchSlack(): number {
    return this.batch?.journal.reduce((sum, e) => sum + Math.abs(e.paraDelta), 0) ?? 0;
  }

  requireRevision(args: Record<string, unknown>, sectionIdx?: number, paraStart?: number, paraEnd?: number): number {
    const expected = this.expectedOf(args);
    const current = this.revision;
    if (expected === current || this.journal.contentUnchanged(expected, current)) return 0;
    if (expected < current && sectionIdx !== undefined && paraStart !== undefined && paraEnd !== undefined) {
      const slack = this.batchSlack();
      const r = this.journal.rebase(expected, current, sectionIdx, paraStart - slack, paraEnd + slack);
      if (r.ok) return r.shift;
      if (r.reason === 'overlap') {
        throw this.mismatch(current, expected, 'A concurrent edit touched your target paragraphs. Re-read with get_structure or get_text_range and retry with fresh coordinates.');
      }
    }
    throw this.mismatch(current, expected,
      `Retry directly with expectedRevision=${current} ONLY if you know what changed the document AND it cannot have shifted this call's coordinates `
      + '(e.g. your own preceding edit was at a later position). Otherwise — including any chance the user edited — re-read the affected range and retry with fresh coordinates.');
  }

  requireRevisionAnchored(args: Record<string, unknown>, anchor: ResolvedAnchor): void {
    const expected = this.expectedOf(args);
    const current = this.revision;
    if (expected === current) return;
    if (expected < current && this.journal.covers(expected, current)) return;
    throw this.mismatch(current, expected, anchor.scoped
      ? `The paragraph indexes scoping this text match may have moved — re-read with get_structure, then resend with expectedRevision=${current} and fresh indexes.`
      : `The text match re-resolves on retry — resend the same call with expectedRevision=${current}; no re-read needed.`);
  }

  private batchNote(text: string, remaining: number): string {
    const b = this.batch;
    if (!b || b.index === 0) return '';
    const consumers = [...new Set(b.removals.filter((r) => r.index < b.index && r.text.includes(text)).map((r) => `edits[${r.index}] (${r.tool})`))];
    return '. Earlier items in this apply_edits batch already changed the text, and occurrence counts matches in the text they left'
      + ` (${remaining} remain${consumers.length > 0 ? `; ${consumers.join(', ')} already rewrote a match` : ''})`
      + ' — number occurrences against the text after those items, or match a longer unique phrase';
  }

  /** 이번 쓰기에서 건드리기 직전 표의 본문 폭 넘침(px) — 키 "sec:para:ctrl" */
  private tableOverflowBefore = new Map<string, number>();

  private scope(engine: Engine): WriteScope {
    return {
      engine,
      touches: [],
      noteTableBefore: (s, p, c) => {
        const key = `${s}:${p}:${c}`;
        if (!this.tableOverflowBefore.has(key)) this.tableOverflowBefore.set(key, this.tableOverflowPx(engine, s, p, c));
      },
      requireRevision: (a, s, p0, p1) => this.requireRevision(a, s, p0, p1),
      requireRevisionAnchored: (a, m) => this.requireRevisionAnchored(a, m),
      noteRemoval: (text) => {
        const b = this.batch;
        if (b && text) b.removals.push({ index: b.index, tool: b.tool, text });
      },
      batchNote: (t, r) => this.batchNote(t, r),
    };
  }

  // ─── 쓰기 공통 ───────────────────────────────────────────

  private captureBaseline(engine: Engine): WriteBaseline {
    const pageCount = engine.pageCount();
    const paragraphCounts: number[] = [];
    for (let s = 0; s < engine.sectionCount(); s++) paragraphCounts.push(engine.paragraphCount(s));
    const pageStarts = pageCount <= PAGE_STARTS_FOR_REPORT_LIMIT ? collectPageStarts(engine, pageCount) : null;
    return { pageCount, paragraphCounts, pageStarts };
  }

  /**
   * 쓰기 실행 틀 — 스테이징 확보 → transaction → revision·저널 → after 보고 → 스테이징 기록 → 이미지.
   * body 는 transaction 안에서 Engine 하나로 돈다.
   */
  private async writeFrame(
    tool: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    body: (w: WriteScope) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const thread = this.threadOf(ctx);
    const staged = ctx.mode === 'agent';
    const render = args['render'];
    if (render !== undefined && render !== null && render !== 'crop' && render !== 'page') throw invalidArgs('render must be "crop" or "page"');
    const pre = this.engine();
    // revision 은 쓰기 전에 검사한다 — 스냅샷을 잡기 전에 거절해야 문서를 건드리지 않는다
    this.expectedOf(args);
    if (staged) this.staging.claim(thread);
    const baseline = this.captureBaseline(pre);
    const revBefore = this.revision;
    this.tableOverflowBefore.clear();
    if (staged) this.staging.beginWrite(thread, pre);
    let touches: Touch[] = [];
    let result: Record<string, unknown>;
    const formatLog: FormatDiff[] = [];
    let failure: DoogleToolError | null = null;
    // 화면 편집 표시(ui/edit-swarm.ts)가 고치기 전 화면(옛 글)을 찍어 두게 알린다 — 쓰기 뒤 그 자리를
    // 옛 글로 덮어 두었다가 커서가 지우고 새 글을 치는 것처럼 보인다. 표시일 뿐이라 실패해도 넘어간다.
    try {
      const target = (globalThis as { window?: Window }).window;
      if (target && typeof CustomEvent !== 'undefined') target.dispatchEvent(new CustomEvent('doogle:agent-edit-before', { detail: { tool } }));
    } catch { /* 표시용 신호 */ }
    try {
      result = this.deps.transaction(`doogle:${tool}`, (doc, tx) => {
        const scoped = new Engine(doc);
        if (staged) scoped.formatLog = formatLog;
        const w = this.scope(scoped);
        // 예상된 도구 실패(대상 없음·검증 실패·엔진 거절)는 여기서 받아 문서를 스스로 되돌리고
        // "무변경"으로 끝낸다. 던지면 studio 가 명령 실패 복구를 돌리는데, 그 확인(화면·커서·기록 대조)이
        // 어긋나면 문서 편집이 통째로 잠긴다 — 에이전트에게 도구 실패는 흔한 일이다.
        // 호스트가 noChange 를 모르면(테스트·옛 호스트) 종전처럼 던져 호스트의 롤백에 맡긴다.
        const restorePoint = tx ? scoped.saveSnapshot() : null;
        try {
          const r = body(w);
          touches = w.touches;
          return r;
        } catch (error) {
          if (!tx || restorePoint === null || !(error instanceof DoogleToolError)) throw error;
          if (scoped.mutations > 0) scoped.restoreSnapshot(restorePoint);
          tx.noChange();
          failure = error;
          return {};
        } finally {
          if (restorePoint !== null) scoped.discardSnapshot(restorePoint);
        }
      });
    } catch (error) {
      if (staged) this.staging.abortWrite(pre);
      throw await settleCommandError(error);
    }
    if (failure) {
      if (staged) this.staging.abortWrite(pre);
      throw failure;
    }
    const revAfter = this.tracker.noteWrite(revBefore);
    const precise = touches.length > 0 && touches.every((t) => !t.wholeSection);
    if (precise) {
      const entries = this.batch ? this.batch.journal : touches.map((t) => ({ sectionIdx: t.sectionIdx, paraStart: t.paraStart, paraEnd: t.paraEnd, paraDelta: t.paraDelta }));
      for (const entry of entries) this.journal.record(revBefore, revAfter, entry);
    }
    this.deps.refreshView?.();
    const engine = this.engine();
    this.announceEdit(engine, tool, touches);
    const after = this.buildAfter(engine, baseline, touches);
    const out: Record<string, unknown> = { revision: revAfter, ...result, after };
    if (staged) {
      const cs = this.staging.record(thread, tool, summarize(tool, args), after.pages as number[], revAfter, {
        targets: reviewTargets(engine, tool, args, touches, (t) => this.pageOfTouch(engine, t)[0]),
        args: clipArgs(args),
        formats: formatLog,
      });
      out['changeSetId'] = cs.id;
      out['staged'] = true;
    }
    if (render === 'crop' || render === 'page') {
      try {
        const image = await this.renderTouched(engine, touches, after.pages as number[], render);
        if (image) Object.assign(out, image);
      } catch (error) {
        out['renderError'] = error instanceof Error ? error.message : String(error);
      }
    }
    return out;
  }

  private runWrite(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
    const handler = WRITE_HANDLERS[tool];
    return this.writeFrame(tool, args, ctx, (w) => handler(w, args));
  }

  // ─── after 보고 ──────────────────────────────────────────

  private pageOfTouch(engine: Engine, t: Touch): number[] {
    if (t.wholeSection) {
      const pages: number[] = [];
      const n = engine.pageCount();
      for (let p = 0; p < n && pages.length < AFTER_MAX_PAGES; p++) {
        try { if (engine.pageInfo(p)['sectionIndex'] === t.sectionIdx) pages.push(p); } catch { /* skip */ }
      }
      return pages;
    }
    const first = t.tableCells?.[0];
    const table = t.table ?? (t.cell ? { paraIdx: t.cell.paraIdx, controlIdx: t.cell.controlIdx } : first ? { paraIdx: first.paraIdx, controlIdx: first.controlIdx } : null);
    if (table) {
      const only = t.tableCells ? new Set(t.tableCells.map((c) => c.cellIdx)) : t.cell && !t.table ? new Set([t.cell.cellIdx]) : null;
      const boxes = engine.tableCellBoxes(t.sectionIdx, table.paraIdx, table.controlIdx).filter((b) => !only || only.has(b.cellIdx));
      const pages = [...new Set(boxes.map((b) => b.pageIndex))];
      if (pages.length > 0) return pages;
      const bbox = engine.tableBBox(t.sectionIdx, table.paraIdx, table.controlIdx);
      if (bbox) return [bbox.pageIndex];
    }
    const pages: number[] = [];
    const count = engine.paragraphCount(t.sectionIdx);
    for (let p = t.paraStart; p <= Math.min(t.paraEnd, count - 1); p++) {
      const page = engine.pageOfParagraph(t.sectionIdx, p);
      if (page !== null && !pages.includes(page)) pages.push(page);
      if (pages.length >= AFTER_MAX_PAGES) break;
    }
    return pages;
  }

  private buildAfter(engine: Engine, baseline: WriteBaseline, touches: Touch[]): Record<string, unknown> {
    const paragraphs: Array<Record<string, unknown>> = [];
    const pages = new Set<number>();
    const seen = new Set<string>();
    for (const t of touches) {
      for (const page of this.pageOfTouch(engine, t)) pages.add(page);
      if (t.wholeSection || t.table || t.tableCells) continue;
      const lo = t.cell ? t.cellParaStart ?? 0 : t.paraStart;
      const hi = t.cell ? t.cellParaEnd ?? lo : t.paraEnd;
      for (let p = lo; p <= hi && paragraphs.length < AFTER_MAX_PARAGRAPHS; p++) {
        const key = `${t.sectionIdx}:${t.cell ? `${t.cell.paraIdx}.${t.cell.controlIdx}.${t.cell.cellIdx}:` : ''}${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let len = 0;
        try { len = engine.length(t.sectionIdx, p, t.cell); } catch { continue; }
        // 편집 지점이 문단 뒤쪽이면 그 조금 앞부터 — 다만 문단이 그 뒤로 짧아졌으면(문단 나눔) 처음부터 보인다
        const lead = p === lo && (t.charOffset ?? 0) > AFTER_WINDOW_LEAD ? (t.charOffset ?? 0) - AFTER_WINDOW_LEAD : 0;
        const from = lead < len ? lead : 0;
        const text = engine.text(t.sectionIdx, p, t.cell, from, Math.min(AFTER_TEXT_CHARS, len - from));
        paragraphs.push({
          sectionIdx: t.sectionIdx, paraIdx: p, ...cellJson(t.cell), length: len,
          ...(from > 0 ? { from } : {}), text: text + (from + scalarLength(text) < len ? '…' : ''),
        });
      }
    }
    const pageCount = engine.pageCount();
    const pageList = [...pages].sort((a, b) => a - b);
    const out: Record<string, unknown> = {
      paragraphs,
      pageCountBefore: baseline.pageCount,
      pageCount,
      pages: pageList.slice(0, AFTER_MAX_PAGES),
      ...(pageList.length > AFTER_MAX_PAGES ? { morePages: pageList.length - AFTER_MAX_PAGES } : {}),
    };
    const warnings: string[] = [];
    const reflow: string[] = [];
    if (baseline.pageStarts) {
      const afterStarts = pageCount <= PAGE_STARTS_FOR_REPORT_LIMIT ? collectPageStarts(engine, pageCount) : null;
      if (afterStarts) {
        const edits = new Map<number, SectionEdit>();
        for (const t of touches) {
          if (t.wholeSection) { edits.set(t.sectionIdx, 'all'); continue; }
          const prev = edits.get(t.sectionIdx);
          if (prev === 'all') continue;
          edits.set(t.sectionIdx, prev
            ? { lo: Math.min(prev.lo, t.paraStart), hi: Math.max(prev.hi, t.paraEnd), delta: prev.delta + t.paraDelta }
            : { lo: t.paraStart, hi: t.paraEnd, delta: t.paraDelta });
        }
        const counts: number[] = [];
        for (let s = 0; s < engine.sectionCount(); s++) counts.push(engine.paragraphCount(s));
        const runs = movedParagraphRuns(baseline.pageStarts, afterStarts, counts, edits);
        // 뒤 문단이 쪽을 옮겨 가는 것은 글을 고치면 으레 생기는 일이다 — 문제(warnings)가 아니라 참고(reflow)로 알린다.
        reflow.push(...movedRunWarnings(runs));
      }
    }
    const seenTables = new Set<string>();
    for (const t of touches) {
      if (!t.table) continue;
      const key = `${t.sectionIdx}:${t.table.paraIdx}:${t.table.controlIdx}`;
      if (seenTables.has(key)) continue;
      seenTables.add(key);
      // 이번 쓰기가 만든(또는 키운) 넘침만 알린다 — 원래 넘쳐 있던 표는 모델이 고칠 일이 아니다.
      const now = this.tableOverflowPx(engine, t.sectionIdx, t.table.paraIdx, t.table.controlIdx);
      const before = this.tableOverflowBefore.get(key) ?? 0;
      if (now > 2 && now > before + 2) {
        warnings.push(`table s${t.sectionIdx} p${t.table.paraIdx} c${t.table.controlIdx} now runs ${pxToMm(now)}mm past the body width — fix with edit_table fit_to_page or set_column_widths`);
      }
    }
    if (warnings.length > 0) out['warnings'] = warnings;
    if (reflow.length > 0) out['reflow'] = reflow;
    return out;
  }

  /** 표가 본문 오른쪽 끝을 넘은 양(px). 넘지 않거나 잴 수 없으면 0. */
  private tableOverflowPx(engine: Engine, sectionIdx: number, paraIdx: number, controlIdx: number): number {
    const boxes = engine.tableCellBoxes(sectionIdx, paraIdx, controlIdx);
    if (boxes.length === 0) return 0;
    let frame: Record<string, number>;
    try { frame = engine.pageInfo(boxes[0].pageIndex); } catch { return 0; }
    if (typeof frame['bodyRight'] !== 'number') return 0;
    const right = Math.max(...boxes.map((b) => b.x + b.w));
    return Math.max(0, right - frame['bodyRight']);
  }

  private pageFrame(engine: Engine, pageIndex: number): PageFrame | null {
    try {
      const info = engine.pageInfo(pageIndex);
      return { width: info['width'], height: info['height'], bodyLeft: info['bodyLeft'] ?? info['marginLeft'], bodyRight: info['bodyRight'] ?? info['width'] - info['marginRight'] };
    } catch {
      return null;
    }
  }

  /** 바뀐 곳의 쪽 사각형(쪽 px, 배율 1) — 표는 셀 상자, 글은 문단 범위 선택 사각형 */
  private touchedRects(engine: Engine, touches: Touch[]): SelectionRect[] {
    const rects: SelectionRect[] = [];
    for (const t of touches) {
      const first = t.tableCells?.[0];
      const table = t.table ?? (t.cell ? { paraIdx: t.cell.paraIdx, controlIdx: t.cell.controlIdx } : first ? { paraIdx: first.paraIdx, controlIdx: first.controlIdx } : null);
      if (table) {
        const only = t.table ? null : t.tableCells ? new Set(t.tableCells.map((c) => c.cellIdx)) : t.cell ? new Set([t.cell.cellIdx]) : null;
        for (const b of engine.tableCellBoxes(t.sectionIdx, table.paraIdx, table.controlIdx)) {
          if (!only || only.has(b.cellIdx)) rects.push({ pageIndex: b.pageIndex, x: b.x, y: b.y, width: b.w, height: b.h });
        }
        continue;
      }
      if (t.wholeSection) continue;
      const count = engine.paragraphCount(t.sectionIdx);
      const end = Math.min(t.paraEnd, count - 1);
      if (end < t.paraStart) continue;
      rects.push(...engine.selectionRects(t.sectionIdx, t.paraStart, 0, end, engine.length(t.sectionIdx, end)));
    }
    return rects;
  }

  /**
   * 화면에 "여기를 고쳤다" 를 알린다 — 문서 위 편집 표시(ui/edit-swarm.ts)가 window 이벤트
   * `doogle:agent-edit {rects, tool}` 를 받아 커서 무리를 그 자리로 보낸다. 표시일 뿐이라 실패해도 조용히 넘어간다.
   */
  private announceEdit(engine: Engine, tool: string, touches: Touch[]): void {
    const target = (globalThis as { window?: Window }).window;
    if (!target || typeof CustomEvent === 'undefined') return;
    try {
      const rects = this.touchedRects(engine, touches).slice(0, 40);
      if (rects.length > 0) target.dispatchEvent(new CustomEvent('doogle:agent-edit', { detail: { rects, tool } }));
    } catch { /* 위치를 못 얻으면 표시를 건너뛴다 */ }
  }

  private async renderTouched(engine: Engine, touches: Touch[], pages: number[], mode: 'crop' | 'page'): Promise<Record<string, unknown> | null> {
    let regions: CropRegion[];
    if (mode === 'page') {
      regions = pages.slice(0, RENDER_MAX_PAGES).flatMap((p) => {
        const f = this.pageFrame(engine, p);
        return f ? [{ pageIndex: p, x: 0, y: 0, width: f.width, height: f.height }] : [];
      });
    } else {
      const rects = this.touchedRects(engine, touches);
      if (rects.length === 0) {
        // 위치를 못 얻으면(빈 문단·구역 설정) 바뀐 쪽 전체
        return this.renderTouched(engine, touches, pages, 'page');
      }
      regions = planCropRegions(rects, (p) => this.pageFrame(engine, p));
    }
    const stacked = await renderStackedRegions(this.deps, engine, regions);
    if (!stacked) return null;
    return {
      image: stacked.image,
      renderRegions: stacked.regions.map((r) => ({ pageIndex: r.pageIndex })),
      ...(stacked.omitted ? { renderOmitted: stacked.omitted } : {}),
      ...(stacked.clipped ? { renderClipped: true } : {}),
    };
  }

  // ─── apply_edits / read_batch ──────────────────────────────

  private async applyEdits(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const edits = args['edits'];
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > APPLY_EDITS_MAX) {
      throw invalidArgs(`edits must list 1..${APPLY_EDITS_MAX} items, each {tool, …that tool's arguments}`);
    }
    const items = edits.map((raw, i) => {
      const r = asRecord(raw);
      const tool = r['tool'];
      if (typeof tool !== 'string' || !BATCHABLE_EDIT_TOOLS.has(tool)) {
        throw invalidArgs(`edits[${i}].tool must be one of ${[...BATCHABLE_EDIT_TOOLS].join(', ')}`);
      }
      // 옛 꼴 {tool, args:{…}} 도 받는다
      const flat = r['args'] && typeof r['args'] === 'object' ? { ...asRecord(r['args']), ...r } : { ...r };
      delete flat['tool'];
      delete flat['args'];
      for (const k of ['expectedRevision', 'render']) {
        if (k in flat) throw invalidArgs(`edits[${i}] must not carry ${k} — it belongs to apply_edits itself`);
      }
      flat['expectedRevision'] = args['expectedRevision'];
      return { tool, args: flat };
    });
    const results: unknown[] = [];
    const failures: Array<{ index: number; tool: string; code: string; message: string }> = [];
    this.batch = { index: 0, tool: '', removals: [], journal: [] };
    try {
      return await this.writeFrame('apply_edits', args, ctx, (w) => {
        const batch = this.batch!;
        items.forEach((item, index) => {
          batch.index = index;
          batch.tool = item.tool;
          const before = w.touches.length;
          const formatsBefore = w.engine.formatLog?.length ?? 0;
          try {
            results.push(WRITE_HANDLERS[item.tool](w, item.args));
            for (const f of w.engine.formatLog?.slice(formatsBefore) ?? []) f.item = index;
            for (const t of w.touches.slice(before)) {
              t.item = index;
              batch.journal.push({ sectionIdx: t.sectionIdx, paraStart: t.paraStart, paraEnd: t.paraEnd, paraDelta: t.paraDelta });
              // 이 항목이 문단 수를 바꿨으면, 앞 항목들이 적어 둔 자리(그 뒤쪽 문단)를 같은 만큼 민다 —
              // 그래야 after 보고와 검토 위치가 배치가 끝난 문서의 문단 번호를 가리킨다.
              if (t.paraDelta !== 0 && !t.wholeSection) shiftEarlierTouches(w.touches.slice(0, before), t);
            }
          } catch (error) {
            w.touches.length = before;
            const p = errorPayload(error);
            if (!p.ok) failures.push({ index, tool: item.tool, code: p.error.code, message: p.error.message });
            results.push(null);
          }
        });
        if (failures.length > 0) {
          throw new DoogleToolError(
            failures.some((f) => f.code === 'REVISION_MISMATCH') ? 'REVISION_MISMATCH' : 'BATCH_FAILED',
            `apply_edits applied nothing: ${failures.length} of ${items.length} item(s) failed — fix them all and resend the whole batch. `
              + failures.map((f) => `edits[${f.index}] ${f.tool}: ${f.code} ${f.message}`).join(' | '),
            { failures, currentRevision: this.revision },
          );
        }
        return { applied: items.length, results };
      });
    } finally {
      this.batch = null;
    }
  }

  private async readBatch(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const reads = args['reads'];
    if (!Array.isArray(reads) || reads.length < 1 || reads.length > READ_BATCH_MAX) throw invalidArgs(`reads must list 1..${READ_BATCH_MAX} items {tool, args}`);
    const engine = this.engine();
    const revision = this.revision;
    const results: unknown[] = [];
    for (const [i, raw] of reads.entries()) {
      const r = asRecord(raw);
      const tool = r['tool'];
      if (typeof tool !== 'string' || !BATCHABLE_READ_TOOLS.has(tool)) {
        results.push({ ok: false, error: { code: 'INVALID_ARGS', message: `reads[${i}].tool must be one of ${[...BATCHABLE_READ_TOOLS].join(', ')}` } });
        continue;
      }
      const itemArgs = r['args'] && typeof r['args'] === 'object' ? asRecord(r['args']) : (() => { const o = { ...r }; delete o['tool']; return o; })();
      try {
        const value = await this.reads[tool](itemArgs, ctx, engine);
        const v = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : value;
        if (v && typeof v === 'object' && !Array.isArray(v)) delete (v as Record<string, unknown>)['revision'];
        results.push({ tool, ok: true, result: v });
      } catch (error) {
        const p = errorPayload(error);
        results.push({ tool, ok: false, error: p.ok ? undefined : p.error });
      }
    }
    return { revision, results };
  }

  // ─── 엔진 탈출구 ─────────────────────────────────────────

  private getEngineEditCapabilities(args: Record<string, unknown>, engine: Engine): unknown {
    const query = typeof args['query'] === 'string' ? (args['query'] as string).toLowerCase() : '';
    const available = Object.entries(ENGINE_EDIT_METHODS).filter(([m]) => engine.has(m) && ENGINE_METHOD_SIGNATURES[m]
      && (!query || m.toLowerCase().includes(query)));
    const byKind: Record<string, string[]> = {};
    for (const [m, kind] of available) (byKind[kind] ??= []).push(m);
    const detailed = args['detail'] === true || query.length > 0;
    return {
      revision: this.revision,
      methods: byKind,
      // 시그니처 없이 인자를 짐작해 부르면 엔진이 죽는다 — query 나 detail:true 면 정확한 시그니처를 함께 준다.
      ...(detailed ? { signatures: Object.fromEntries(available.slice(0, 40).map(([m]) => [m, engineSignatureText(m)])) } : {}),
      ...(detailed && available.length > 40 ? { signaturesOmitted: available.length - 40 } : {}),
      argumentGuide: 'apply_engine_edits operations are {method, args:[positional]} matching the signature exactly (count and types are checked before the call) — '
        + '*_json arguments are JSON strings, Uint8Array is {$base64}. Coordinates are 0-based (section, paragraph, charOffset in characters); sizes in HWPUNIT (1mm ≈ 283.46). '
        + (detailed ? '' : 'Pass query (a name fragment) or detail:true to get signatures. ')
        + 'Prefer the semantic tools; this is for operations they do not cover.',
    };
  }

  private async applyEngineEdits(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const ops = args['operations'];
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 32) throw invalidArgs('operations must list 1..32 {method, args}');
    const parsed = ops.map((raw, i) => {
      const r = asRecord(raw);
      const method = r['method'];
      if (typeof method !== 'string' || ENGINE_EDIT_METHODS[method] !== 'document') {
        throw invalidArgs(`operations[${i}].method ${JSON.stringify(method)} is not an agent-editable document method — see get_engine_edit_capabilities`);
      }
      if (!Array.isArray(r['args'])) throw invalidArgs(`operations[${i}].args must be an array`);
      const bad = checkEngineArgs(method, r['args'] as unknown[]);
      if (bad) throw invalidArgs(`operations[${i}] ${bad}`);
      const callArgs = (r['args'] as unknown[]).map((a) => {
        const o = asRecord(a);
        if (typeof o['$base64'] === 'string') {
          const bin = atob(o['$base64'] as string);
          const out = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
          return out;
        }
        return a;
      });
      return { method, args: callArgs };
    });
    return this.writeFrame('apply_engine_edits', args, ctx, (w) => {
      this.requireRevision(args);
      const results = parsed.map((op, i) => {
        try {
          const value = w.engine.call(op.method, ...op.args);
          if (typeof value === 'string') {
            try {
              const j = JSON.parse(value);
              if (j && typeof j === 'object' && (j as { ok?: unknown }).ok === false) throw new Error(String((j as { error?: unknown }).error ?? 'refused'));
              return j;
            } catch (e) {
              if (e instanceof SyntaxError) return value;
              throw e;
            }
          }
          return value instanceof Uint8Array ? `<${value.length} bytes>` : value;
        } catch (error) {
          throw new DoogleToolError('BATCH_FAILED', `apply_engine_edits applied nothing: operations[${i}] ${op.method} failed — ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      w.engine.invalidate();
      // 엔진 직접 편집은 좌표를 정밀 기록하지 않는다 — 구역 전체로 보고, 저널에는 남기지 않는다
      for (let s = 0; s < w.engine.sectionCount(); s++) w.touches.push({ sectionIdx: s, paraStart: 0, paraEnd: 0, paraDelta: 0, wholeSection: true });
      return { results };
    });
  }

  private prepareEngineEditSession(args: Record<string, unknown>): unknown {
    const engine = this.engine();
    this.requireRevision(args);
    const method = args['method'];
    if (typeof method !== 'string' || ENGINE_EDIT_METHODS[method] !== 'session') {
      throw invalidArgs(`${JSON.stringify(method)} is not a session method — see get_engine_edit_capabilities (kind "session")`);
    }
    const callArgs = Array.isArray(args['args']) ? args['args'] as unknown[] : [];
    const bad = checkEngineArgs(method, callArgs);
    if (bad) throw invalidArgs(bad);
    const value = engine.call(method, ...callArgs);
    return { revision: this.revision, result: typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return value; } })() : value };
  }

  // ─── 읽기 ────────────────────────────────────────────────

  private getStructure(args: Record<string, unknown>, engine: Engine): unknown {
    const format = args['format'] === 'json' ? 'json' : 'text';
    const fullText = args['text'] === 'full';
    const maxPreviewChars = optInt(args, 'maxPreviewChars') ?? 120;
    const maxParagraphs = Math.max(1, optInt(args, 'maxParagraphs') ?? 500);
    const current = this.revision;
    const reader = new StructureReader(engine);
    const label = `revision ${current}`;
    const since = args['sinceRevision'];
    let only: Map<number, Array<[number, number]>> | undefined;
    let delta: Record<string, unknown> | undefined;
    if (typeof since === 'number') {
      if (since === current || this.journal.contentUnchanged(since, current)) {
        return format === 'json' ? { revision: current, unchanged: true } : { revision: current, text: `${label} · unchanged since revision ${since}` };
      }
      const diff = since < current ? this.journal.diff(since, current, (s) => engine.paragraphCount(s)) : null;
      if (!diff) {
        throw new DoogleToolError('FULL_REFRESH_REQUIRED', `Changes since revision ${since} are no longer tracked (user edits or untracked writes happened). Re-read without sinceRevision and keep the new revision ${current}.`, { currentRevision: current });
      }
      only = new Map();
      const sections: unknown[] = [];
      for (const [sec, d] of diff) {
        only.set(sec, d.changes.map((c) => [c.paraStart, c.paraEnd] as [number, number]));
        sections.push({ sectionIdx: sec, changes: d.changes, indexShifts: d.indexShifts });
      }
      delta = { sinceRevision: since, sections };
    }
    const pages = Array.isArray(args['pages']) ? args['pages'] as number[] : undefined;
    const pageCount = engine.pageCount();
    if (pages) {
      if (pages.length !== 2 || pages.some((p) => !Number.isSafeInteger(p) || p < 0) || pages[1] < pages[0]) {
        throw invalidArgs('pages must be [first, last] 0-based page indexes with first <= last');
      }
      if (pages[0] >= pageCount) throw invalidArgs(`pages starts past the last page (pageIndex 0..${pageCount - 1})`);
      pages[1] = Math.min(pages[1], pageCount - 1);
    }
    let range: { sectionIdx: number; fromPara: number; toPara: number } | undefined;
    if (args['range'] !== undefined && args['range'] !== null) {
      const r = asRecord(args['range']);
      range = { sectionIdx: reqInt(r, 'sectionIdx'), fromPara: reqInt(r, 'fromPara'), toPara: reqInt(r, 'toPara') };
      if (range.sectionIdx >= engine.sectionCount()) throw invalidArgs(`range.sectionIdx is out of range (0..${engine.sectionCount() - 1})`);
      if (range.toPara < range.fromPara) throw invalidArgs('range.toPara must be >= range.fromPara');
    }
    const pageStarts = collectPageStarts(engine, pageCount);
    if (pages && !pageStarts) {
      throw invalidArgs('this document is too long for page-scoped reads; use range {sectionIdx, fromPara, toPara} or find_text');
    }
    const data: StructureData = reader.collect({ maxPreviewChars, maxParagraphs, fullText, pages: pages as [number, number] | undefined, range, only }, pageStarts);
    if (format === 'json') {
      return { revision: current, ...data, bodyFontSizePt: (reader.bodySize() ?? 0) / 100, ...(delta ? { delta } : {}) };
    }
    let text = renderCompactStructure(data, label);
    if (delta) text = `changed since revision ${String(since)} (indexShifts map older indexes: ${JSON.stringify((delta['sections'] as unknown[]).map((s) => asRecord(s)['indexShifts']))})\n${text}`;
    return { revision: current, text };
  }

  private getOutline(args: Record<string, unknown>, engine: Engine): unknown {
    const mode = typeof args['mode'] === 'string' ? args['mode'] as string : 'auto';
    if (engine.has('getStructure')) return { revision: this.revision, outline: engine.json('getStructure', mode) };
    return { revision: this.revision, outline: engine.json('getOutlineNavigation') };
  }

  private getTextRange(args: Record<string, unknown>, engine: Engine): unknown {
    const sectionIdx = sectionOf(engine, args, 'get_text_range');
    const paraIdx = reqInt(args, 'paraIdx');
    const cell = optCell(args);
    const offset = optInt(args, 'charOffset') ?? 0;
    const len = validateAddress(engine, sectionIdx, paraIdx, offset, cell);
    const count = optInt(args, 'count') ?? len - offset;
    const text = engine.text(sectionIdx, paraIdx, cell, offset, count);
    return { revision: this.revision, sectionIdx, paraIdx, ...cellJson(cell), charOffset: offset, length: len, text };
  }

  private pointJson(p: SelectionPoint): Record<string, unknown> {
    if (p.cellPath.length > 0) {
      const top = p.cellPath[0];
      return {
        sectionIdx: p.sectionIndex,
        paraIdx: p.cellPath[p.cellPath.length - 1].cellParaIndex,
        charOffset: p.charOffset,
        cell: { paraIdx: p.parentParaIndex, controlIdx: top.controlIndex, cellIdx: top.cellIndex },
        ...(p.cellPath.length > 1 ? { cellPath: p.cellPath } : {}),
      };
    }
    return { sectionIdx: p.sectionIndex, paraIdx: p.parentParaIndex, charOffset: p.charOffset };
  }

  private getSelection(_engine: Engine): unknown {
    const info = this.deps.getSelection?.() ?? null;
    if (!info) return { revision: this.revision, caret: null, selection: null };
    return {
      revision: this.revision,
      caret: info.caret ? this.pointJson(info.caret) : null,
      selection: info.selection ? {
        start: this.pointJson(info.selection.start),
        end: this.pointJson(info.selection.end),
        ...(info.selection.text !== undefined ? { text: info.selection.text } : {}),
        ...(info.selection.truncated ? { truncated: true } : {}),
      } : null,
    };
  }

  private findText(args: Record<string, unknown>, engine: Engine): unknown {
    const query = reqString(args, 'query');
    if (query.length < 1) throw invalidArgs('query must be at least 1 character');
    const caseSensitive = args['caseSensitive'] === true;
    const maxResults = Math.min(Math.max(optInt(args, 'maxResults') ?? 50, 1), 200);
    const all = engineMatchSource(engine).exact(query, caseSensitive);
    return {
      revision: this.revision,
      matches: all.slice(0, maxResults).map((m) => ({
        sectionIdx: m.sectionIdx, paraIdx: m.paraIdx, charOffset: m.charOffset, length: m.length, context: m.context, ...cellJson(m.cell),
      })),
      truncated: all.length > maxResults,
    };
  }

  private getDocumentInfo(args: Record<string, unknown>, engine: Engine): unknown {
    const info = engine.documentInfo();
    const out: Record<string, unknown> = {
      revision: this.revision,
      name: this.deps.getDocumentName?.() ?? null,
      dirty: this.deps.isDirty?.() ?? null,
      documentInstance: this.deps.documentInstance?.() ?? null,
      sectionCount: engine.sectionCount(),
      pageCount: engine.pageCount(),
      format: engine.has('getSourceFormat') ? String(engine.call('getSourceFormat')) : info['version'] ?? null,
      info,
      pendingReview: this.staging.list().length,
    };
    const fontQuery = args['fontQuery'];
    if (Array.isArray(fontQuery)) {
      const fonts = this.deps.listFonts?.() ?? [];
      const qs = fontQuery.map((q) => String(q).toLowerCase());
      out['fonts'] = fonts.filter((f) => qs.some((q) => f.toLowerCase().includes(q))).slice(0, 50);
    }
    return out;
  }

  /** 누름틀 목록 — 모델에게 필요한 것만 (엔진의 내부 명령 문자열·바이트 위치는 뺀다) */
  private getFields(engine: Engine): unknown {
    const raw = engine.json<Array<Record<string, unknown>>>('getFieldList') ?? [];
    const names = new Map<string, number>();
    for (const f of raw) names.set(String(f['name'] ?? ''), (names.get(String(f['name'] ?? '')) ?? 0) + 1);
    const fields = raw.map((f) => {
      const loc = asRecord(f['location']);
      const name = String(f['name'] ?? '');
      const cell = loc['cellIndex'] !== undefined || loc['cellIdx'] !== undefined;
      return {
        name,
        ...(f['guide'] && f['guide'] !== name ? { guide: f['guide'] } : {}),
        value: f['value'] ?? '',
        fieldType: f['fieldType'],
        sectionIdx: loc['sectionIndex'] ?? loc['sectionIdx'] ?? 0,
        paraIdx: loc['paraIndex'] ?? loc['paraIdx'],
        ...(typeof f['startCharIdx'] === 'number' ? { charOffset: f['startCharIdx'], length: Math.max(0, (f['endCharIdx'] as number) - (f['startCharIdx'] as number)) } : {}),
        ...(cell ? { inCell: true } : {}),
        // 이름이 같은 누름틀은 set_field_value 로 구별할 수 없다 — 글 자리(문단·오프셋)로 고친다
        ...((names.get(name) ?? 0) > 1 ? { duplicateName: true } : {}),
      };
    });
    const dup = fields.some((f) => 'duplicateName' in f);
    return {
      revision: this.revision,
      fields,
      ...(dup ? { note: 'Fields marked duplicateName share a name, so set_field_value cannot tell them apart — edit those by position with replace_range {paraIdx, startCharOffset, endCharOffset} (charOffset..charOffset+length), or insert_text when length is 0.' } : {}),
    };
  }

  private getParaFormat(args: Record<string, unknown>, engine: Engine): unknown {
    const sectionIdx = sectionOf(engine, args, 'get_para_format');
    const paraIdx = reqInt(args, 'paraIdx');
    const cell = optCell(args);
    validateAddress(engine, sectionIdx, paraIdx, undefined, cell);
    const p = engine.paraPropsAt(sectionIdx, paraIdx, cell);
    const pxToPt = (px: unknown) => (typeof px === 'number' ? Math.round(px * 0.75 * 100) / 100 : undefined);
    const lsType = String(p['lineSpacingType'] ?? 'Percent');
    const out: Record<string, unknown> = {
      revision: this.revision,
      alignment: p['alignment'],
      ...(lsType === 'Percent'
        ? { lineSpacingPercent: p['lineSpacing'] }
        : { lineSpacingType: { Fixed: 'fixed', Minimum: 'atLeast', SpaceOnly: 'spaceOnly' }[lsType] ?? lsType, lineSpacingPt: typeof p['lineSpacing'] === 'number' ? (p['lineSpacing'] as number) / 100 : undefined }),
      spaceBeforePt: pxToPt(p['spacingBefore']),
      spaceAfterPt: pxToPt(p['spacingAfter']),
      indentPt: pxToPt(p['indent']),
      marginLeftPt: pxToPt(p['marginLeft']),
      marginRightPt: pxToPt(p['marginRight']),
      headType: String(p['headType'] ?? 'None').toLowerCase(),
      numberingId: p['numberingId'],
      paraLevel: p['paraLevel'],
      pageBreakBefore: p['pageBreakBefore'],
      koreanBreakUnit: p['koreanBreakUnit'] === 1 ? 'char' : 'word',
      tabStops: Array.isArray(p['tabStops'])
        ? (p['tabStops'] as Array<{ position: number; type: number; fill: number }>).map((t) => ({ positionMm: huToMm(t.position / 2), type: ['left', 'right', 'center', 'decimal'][t.type] ?? t.type, fill: t.fill }))
        : undefined,
      borders: Object.fromEntries((['Left', 'Right', 'Top', 'Bottom'] as const)
        .filter((s) => asRecord(p[`border${s}`])['type'])
        .map((s) => [s.toLowerCase(), p[`border${s}`]])),
    };
    if (args['full'] === true) out['raw'] = p;
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && !(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)));
  }

  private getCharFormat(args: Record<string, unknown>, engine: Engine): unknown {
    const sectionIdx = sectionOf(engine, args, 'get_char_format');
    const paraIdx = reqInt(args, 'paraIdx');
    const cell = optCell(args);
    const offset = reqInt(args, 'charOffset');
    validateAddress(engine, sectionIdx, paraIdx, offset, cell);
    const c = engine.charPropsAt(sectionIdx, paraIdx, offset, cell);
    const sameAll = (v: unknown) => (Array.isArray(v) && v.every((x) => x === v[0]) ? v[0] : v);
    const out: Record<string, unknown> = {
      revision: this.revision,
      fontFamily: c['fontFamily'],
      fontSizePt: typeof c['fontSize'] === 'number' ? (c['fontSize'] as number) / 100 : undefined,
      fontId: c['fontId'],
      charShapeId: c['charShapeId'],
      bold: c['bold'], italic: c['italic'], underline: c['underline'], strikethrough: c['strikethrough'],
      textColor: c['textColor'],
      widthPercent: sameAll(c['ratios']),
      letterSpacingPercent: sameAll(c['spacings']),
      note: 'Inserted text inherits the character BEFORE the insertion point (replace_range: the range\'s first character).',
    };
    if (args['full'] === true) out['raw'] = c;
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  }

  private getTableProperties(args: Record<string, unknown>, engine: Engine): unknown {
    const sectionIdx = sectionOf(engine, args, 'get_table_properties');
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    const dims = engine.tableDims(sectionIdx, paraIdx, controlIdx);
    const t = engine.json<Record<string, unknown>>('getTableProperties', sectionIdx, paraIdx, controlIdx);
    const mm = (v: unknown) => (typeof v === 'number' ? huToMm(v) : undefined);
    const out: Record<string, unknown> = {
      revision: this.revision,
      rowCount: dims.rowCount, colCount: dims.colCount, cellCount: dims.cellCount,
      widthMm: mm(t['tableWidth']), heightMm: mm(t['tableHeight']),
      cellSpacingMm: mm(t['cellSpacing']),
      cellPaddingMm: { left: mm(t['paddingLeft']), right: mm(t['paddingRight']), top: mm(t['paddingTop']), bottom: mm(t['paddingBottom']) },
      pageBreak: ['none', 'cell', 'row'][t['pageBreak'] as number] ?? t['pageBreak'],
      repeatHeader: t['repeatHeader'],
      positionMode: t['treatAsChar'] === false ? 'floating' : 'inline',
      textWrap: t['textWrap'], horzRelTo: t['horzRelTo'], horzAlign: t['horzAlign'], horizontalOffsetMm: mm(t['horzOffset']),
      vertRelTo: t['vertRelTo'], vertAlign: t['vertAlign'], verticalOffsetMm: mm(t['vertOffset']),
      allowOverlap: t['allowOverlap'], restrictInPage: t['restrictInPage'],
      outerMarginMm: { left: mm(t['outerLeft']), right: mm(t['outerRight']), top: mm(t['outerTop']), bottom: mm(t['outerBottom']) },
      captionEnabled: t['hasCaption'],
    };
    const cellIdx = optInt(args, 'cellIdx');
    if (cellIdx !== undefined) {
      if (cellIdx >= dims.cellCount) throw invalidArgs(`cellIdx ${cellIdx} is out of range (0..${dims.cellCount - 1})`);
      const c = engine.json<Record<string, unknown>>('getCellProperties', sectionIdx, paraIdx, controlIdx, cellIdx);
      const info = engine.cellInfo(sectionIdx, paraIdx, controlIdx, cellIdx);
      out['cell'] = {
        cellIdx, ...info, widthMm: mm(c['width']), heightMm: mm(c['height']),
        verticalAlign: ['top', 'center', 'bottom'][c['verticalAlign'] as number] ?? c['verticalAlign'],
        isHeader: c['isHeader'], fillColor: c['fillType'] === 'solid' ? c['fillColor'] : undefined,
        textDirection: c['textDirection'] === 1 ? 'vertical' : 'horizontal',
        paddingMm: { left: mm(c['paddingLeft']), right: mm(c['paddingRight']), top: mm(c['paddingTop']), bottom: mm(c['paddingBottom']) },
        ...(args['full'] === true ? { raw: c } : {}),
      };
    }
    if (args['full'] === true) out['raw'] = t;
    return out;
  }

  private getTableLayout(args: Record<string, unknown>, engine: Engine): unknown {
    const sectionIdx = optInt(args, 'sectionIdx') ?? 0;
    const paraIdx = reqInt(args, 'paraIdx');
    const controlIdx = reqInt(args, 'controlIdx');
    engine.tableDims(sectionIdx, paraIdx, controlIdx);
    const boxes = engine.tableCellBoxes(sectionIdx, paraIdx, controlIdx);
    const byPage = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (const b of boxes) {
      const f = byPage.get(b.pageIndex);
      if (f) { f.x0 = Math.min(f.x0, b.x); f.y0 = Math.min(f.y0, b.y); f.x1 = Math.max(f.x1, b.x + b.w); f.y1 = Math.max(f.y1, b.y + b.h); }
      else byPage.set(b.pageIndex, { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
    }
    const fragments = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([pageIndex, f]) => ({
      pageIndex, xMm: pxToMm(f.x0), yMm: pxToMm(f.y0), widthMm: pxToMm(f.x1 - f.x0), heightMm: pxToMm(f.y1 - f.y0),
    }));
    let overflowsBody = false;
    let overflowsBodyWidth = false;
    let bodyAreaMm: Record<string, number> | null = null;
    if (fragments.length > 0) {
      try {
        const info = engine.pageInfo(fragments[0].pageIndex);
        const top = info['marginTop'] + (info['marginHeader'] ?? 0);
        const bottom = info['height'] - info['marginBottom'] - (info['marginFooter'] ?? 0);
        bodyAreaMm = { xMm: pxToMm(info['bodyLeft']), yMm: pxToMm(top), widthMm: pxToMm(info['bodyRight'] - info['bodyLeft']), heightMm: pxToMm(bottom - top) };
        for (const [, f] of byPage) {
          if (f.y1 > bottom + 2) overflowsBody = true;
          if (f.x1 > info['bodyRight'] + 2) overflowsBodyWidth = true;
        }
      } catch { /* 쪽 정보 없음 */ }
    }
    const props = engine.json<Record<string, unknown>>('getTableProperties', sectionIdx, paraIdx, controlIdx);
    return {
      revision: this.revision, fragments, bodyAreaMm, overflowsBody, overflowsBodyWidth,
      pageBreak: props['pageBreak'], repeatHeader: props['repeatHeader'],
      ...(overflowsBody && (props['pageBreak'] === 0 || props['pageBreak'] === 1) ? { fix: 'set_table_props {pageBreak:"row", repeatHeader:true}' } : {}),
      ...(overflowsBodyWidth ? { fixWidth: 'edit_table fit_to_page or set_column_widths' } : {}),
    };
  }

  private listFootnotes(engine: Engine): unknown {
    const notes: unknown[] = [];
    const sections = engine.sectionCount();
    for (let s = 0; s < sections; s++) {
      const n = engine.paragraphCount(s);
      for (let p = 0; p < n; p++) {
        let positions: unknown[] = [];
        try { positions = engine.json<unknown[]>('getControlTextPositions', s, p) ?? []; } catch { continue; }
        for (let c = 0; c < positions.length; c++) {
          try {
            const info = engine.json<{ number?: number; texts?: string[]; paraCount?: number; kind?: string }>('getFootnoteInfo', s, p, c);
            notes.push({ kind: info.kind ?? 'footnote', where: 'body', sectionIdx: s, paraIdx: p, controlIdx: c, charOffset: positions[c], number: info.number, text: (info.texts ?? []).join('\n') });
          } catch { /* 각주 아님 */ }
        }
      }
    }
    return { revision: this.revision, notes };
  }

  private listBookmarks(engine: Engine): unknown {
    const marks = engine.json<Array<{ name: string; sec: number; para: number; ctrlIdx: number; charPos: number }>>('getBookmarks') ?? [];
    return { revision: this.revision, bookmarks: marks.map((m) => ({ name: m.name, sectionIdx: m.sec, paraIdx: m.para, charOffset: m.charPos })) };
  }

  private regionPx(args: Record<string, unknown>): { x: number; y: number; width: number; height: number } | undefined {
    if (args['regionMm'] === undefined || args['regionMm'] === null) return undefined;
    const r = asRecord(args['regionMm']);
    for (const k of ['x', 'y', 'width', 'height']) if (typeof r[k] !== 'number') throw invalidArgs('regionMm must be {x, y, width, height} in mm');
    return { x: mmToPx(r['x'] as number), y: mmToPx(r['y'] as number), width: mmToPx(r['width'] as number), height: mmToPx(r['height'] as number) };
  }

  private async renderPage(args: Record<string, unknown>, engine: Engine): Promise<unknown> {
    const pageIndex = reqInt(args, 'pageIndex');
    const pageCount = engine.pageCount();
    if (pageIndex >= pageCount) throw invalidArgs(`pageIndex ${pageIndex} is out of range (0..${pageCount - 1})`);
    if (args['format'] === 'svg') {
      const svg = String(engine.call('renderPageSvg', pageIndex));
      if (svg.length > MAX_SVG_BYTES) throw new DoogleToolError('RESULT_TOO_LARGE', `This page's SVG is ${svg.length} characters (cap ${MAX_SVG_BYTES}) — too large to read as text. Use the default PNG (with regionMm to zoom in) or get_page_geometry for positions.`);
      return { revision: this.revision, pageIndex, svg };
    }
    const scale = typeof args['scale'] === 'number' ? Math.min(3, Math.max(0.5, args['scale'] as number)) : 1.25;
    const image: PngImage = await renderPagePng(this.deps, engine, pageIndex, scale, this.regionPx(args));
    return { revision: this.revision, pageIndex, pageCount, image };
  }

  private getPageGeometry(args: Record<string, unknown>, engine: Engine): unknown {
    const pageIndex = reqInt(args, 'pageIndex');
    const pageCount = engine.pageCount();
    if (pageIndex >= pageCount) throw invalidArgs(`pageIndex ${pageIndex} is out of range (0..${pageCount - 1})`);
    const include = new Set(Array.isArray(args['include']) ? args['include'] as string[] : ['lines', 'objects']);
    const region = this.regionPx(args);
    const overlaps = (x: number, y: number, w: number, h: number) => !region
      || (x < region.x + region.width && x + w > region.x && y < region.y + region.height && y + h > region.y);
    const info = engine.pageInfo(pageIndex);
    const out: Record<string, unknown> = {
      revision: this.revision, pageIndex,
      pageMm: { width: pxToMm(info['width']), height: pxToMm(info['height']) },
      bodyMm: { left: pxToMm(info['bodyLeft'] ?? info['marginLeft']), right: pxToMm(info['bodyRight'] ?? info['width'] - info['marginRight']), top: pxToMm(info['marginTop']), bottom: pxToMm(info['height'] - info['marginBottom']) },
    };
    if (include.has('lines') || include.has('runs')) {
      const layout = engine.json<{ runs?: Array<Record<string, unknown>> }>('getPageTextLayout', pageIndex);
      const lines: Array<Record<string, unknown>> = [];
      for (const run of layout?.runs ?? []) {
        const x = run['x'] as number; const y = run['y'] as number; const w = run['w'] as number; const h = run['h'] as number;
        if (!overlaps(x, y, w, h)) continue;
        const addr: Record<string, unknown> = typeof run['parentParaIdx'] === 'number'
          ? {
            sectionIdx: run['secIdx'], paraIdx: run['cellParaIdx'],
            cell: { paraIdx: run['parentParaIdx'], controlIdx: run['controlIdx'], cellIdx: run['cellIdx'] },
            ...(Array.isArray(run['cellPath']) && (run['cellPath'] as unknown[]).length > 1 ? { cellPath: run['cellPath'] } : {}),
          }
          : { sectionIdx: run['secIdx'], paraIdx: run['paraIdx'] };
        const text = String(run['text'] ?? '');
        const charStart = (run['charStart'] as number) ?? 0;
        const key = JSON.stringify(addr) + Math.round(y);
        const last = lines[lines.length - 1];
        if (last && last['_key'] === key) {
          const box = last['boxMm'] as Record<string, number>;
          const x1 = Math.max(box['x'] + box['width'], pxToMm(x + w));
          box['width'] = Math.round((x1 - box['x']) * 100) / 100;
          last['charEnd'] = charStart + scalarLength(text);
          last['text'] = String(last['text']) + text;
          if (include.has('runs')) (last['runs'] as unknown[]).push({ xMm: pxToMm(x), widthMm: pxToMm(w), charStart, text });
          continue;
        }
        lines.push({
          _key: key, ...addr, charStart, charEnd: charStart + scalarLength(text), text,
          boxMm: { x: pxToMm(x), y: pxToMm(y), width: pxToMm(w), height: pxToMm(h) },
          ...(include.has('runs') ? { runs: [{ xMm: pxToMm(x), widthMm: pxToMm(w), charStart, text }] } : {}),
        });
      }
      out['lines'] = lines.map(({ _key, ...rest }) => rest);
    }
    if (include.has('objects')) {
      const ctrl = engine.json<unknown>('getPageControlLayout', pageIndex);
      const list = Array.isArray(ctrl) ? ctrl : asRecord(ctrl)['controls'] as unknown[] ?? [];
      out['objects'] = (list as Array<Record<string, unknown>>)
        .filter((o) => overlaps(o['x'] as number, o['y'] as number, o['w'] as number, o['h'] as number))
        .map((o) => ({
          type: o['type'], sectionIdx: o['secIdx'], paraIdx: o['paraIdx'], controlIdx: o['controlIdx'],
          boxMm: { x: pxToMm(o['x'] as number), y: pxToMm(o['y'] as number), width: pxToMm(o['w'] as number), height: pxToMm(o['h'] as number) },
          ...(o['wrap'] ? { wrap: o['wrap'] } : {}), ...(o['zOrder'] !== undefined ? { zOrder: o['zOrder'] } : {}),
          ...(o['type'] === 'table' ? { rowCount: o['rowCount'], colCount: o['colCount'] } : {}),
        }));
    }
    return out;
  }

  private previewEquation(args: Record<string, unknown>, engine: Engine): unknown {
    const script = reqString(args, 'script');
    const sizePt = typeof args['fontSizePt'] === 'number' ? args['fontSizePt'] as number : 10;
    const raw = engine.call('renderEquationPreview', script, Math.round(sizePt * 100), colorRef('#000000'));
    let parsed: unknown = raw;
    if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { parsed = { svg: raw }; } }
    const p = asRecord(parsed);
    return {
      revision: this.revision,
      // SVG 마크업은 길다(수천 자) — 달라고 할 때만 싣는다. 판단에는 warnings 와 크기면 충분하다.
      ...(args['includeSvg'] === true ? { svg: p['svg'] ?? p['markup'] ?? null } : {}),
      ...(typeof p['width'] === 'number' ? { widthMm: huToMm(p['width'] as number) } : {}),
      ...(typeof p['height'] === 'number' ? { heightMm: huToMm(p['height'] as number) } : {}),
      warnings: Array.isArray(p['warnings']) ? p['warnings'] : Array.isArray(p['diagnostics']) ? p['diagnostics'] : [],
    };
  }

  private async verifyChanges(args: Record<string, unknown>, ctx: ToolContext, engine: Engine): Promise<unknown> {
    const thread = this.threadOf(ctx);
    const all = this.staging.list(thread);
    const id = typeof args['changeSetId'] === 'string' ? args['changeSetId'] as string : null;
    const from = args['full'] === true || id ? 0 : this.verifiedUpTo.get(thread) ?? 0;
    const sets = id ? all.filter((c) => c.id === id) : all.slice(from);
    if (!id) this.verifiedUpTo.set(thread, all.length);
    const pages = [...new Set(sets.flatMap((c) => c.pages))].sort((a, b) => a - b);
    const out: Record<string, unknown> = {
      revision: this.revision,
      mode: ctx.mode,
      pendingReview: all.length,
      changeSets: sets.map((c) => ({ id: c.id, tool: c.tool, summary: c.summary, pages: c.pages })),
      pages,
      note: ctx.mode === 'full' ? 'In 전체 mode edits are applied directly; only staged (에이전트 mode) edits are listed.' : 'Deleted text is gone; do NOT re-insert it.',
    };
    if (args['includeImage'] === true && pages.length > 0) {
      try { out['image'] = await renderPagePng(this.deps, engine, pages[0], 1); } catch (e) { out['renderError'] = e instanceof Error ? e.message : String(e); }
    }
    return out;
  }

  /** get_structure 와 같은 글 (턴 스냅샷 용) — 실패는 null */
  structureSnapshot(args: { text?: 'full'; pages?: [number, number] }): { revision: number; text: string } | null {
    try {
      const r = asRecord(this.getStructure({ ...args }, this.engine()));
      return typeof r['text'] === 'string' ? { revision: r['revision'] as number, text: r['text'] as string } : null;
    } catch {
      return null;
    }
  }
}

/** change set 요약 한 줄 */
/** (검토 UI) 도구가 넣은 글 — 선택 길이 계산용 */
function insertedText(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'insert_paragraphs' && Array.isArray(args['paragraphs'])) {
    return (args['paragraphs'] as unknown[]).filter((t) => typeof t === 'string').join('\n');
  }
  const t = tool === 'replace_all' ? args['replacement'] : tool === 'insert_text' || tool === 'replace_range' ? args['text'] : undefined;
  return typeof t === 'string' ? t : null;
}

/** 검토 행 하나가 기억하는 자리 수 (apply_edits 한 묶음은 32 항목까지) */
const REVIEW_TARGETS_MAX = 48;
/** 검토 목록에 보일 문단 첫머리 글 길이 */
const REVIEW_LEAD_CHARS = 18;

/**
 * (검토 UI) 터치 → 검토 행 위치. 글을 넣은 편집은 넣은 글을, 그 밖은 문단 전체를 가리킨다.
 * 기록 시점 좌표이며 실패해도 쓰기에는 영향이 없다.
 */
function reviewTargets(
  engine: Engine, tool: string, args: Record<string, unknown>, touches: Touch[],
  pageOf?: (t: Touch) => number | undefined,
): PendingChangeTarget[] {
  const out: PendingChangeTarget[] = [];
  const edits = tool === 'apply_edits' && Array.isArray(args['edits']) ? args['edits'] as unknown[] : null;
  for (let i = 0; i < touches.length && out.length < REVIEW_TARGETS_MAX; i++) {
    const t = touches[i];
    // 쪽·항목 번호 — 못 구해도 위치 자체는 남긴다
    const extra: { page?: number; item?: number } = {};
    try {
      const page = pageOf?.(t);
      if (typeof page === 'number') extra.page = page;
    } catch { /* 쪽을 모르면 행은 쪽 없이 보인다 */ }
    if (typeof t.item === 'number') extra.item = t.item;
    try {
      if (t.wholeSection) {
        out.push({ sectionIdx: t.sectionIdx, paraIdx: 0, charOffset: 0, length: 0, wholeSection: true, ...extra });
        continue;
      }
      if (t.table || t.tableCells) {
        const table = t.table ?? { paraIdx: t.tableCells![0].paraIdx, controlIdx: t.tableCells![0].controlIdx };
        out.push({ sectionIdx: t.sectionIdx, paraIdx: table.paraIdx, charOffset: 0, length: 0, table: { ...table }, ...extra });
        continue;
      }
      const para = t.cell ? t.cellParaStart ?? 0 : t.paraStart;
      const mapped = edits && typeof t.item === 'number' ? edits[t.item] : edits && edits.length === touches.length ? edits[i] : null;
      const itemArgs = mapped ? asRecord(mapped) : args;
      const itemTool = mapped ? String(itemArgs['tool'] ?? '') : tool;
      const text = insertedText(itemTool, itemArgs);
      const paraLen = engine.length(t.sectionIdx, para, t.cell);
      let charOffset = 0;
      let length = paraLen;
      if (text !== null && t.charOffset !== undefined && !text.includes('\n')) {
        charOffset = Math.min(t.charOffset, paraLen);
        length = Math.max(0, Math.min(scalarLength(text), paraLen - charOffset));
      }
      let lead = '';
      try {
        lead = engine.text(t.sectionIdx, para, t.cell, 0, REVIEW_LEAD_CHARS + 8).replace(/\s+/g, ' ').trim();
        if (lead.length > REVIEW_LEAD_CHARS) lead = `${lead.slice(0, REVIEW_LEAD_CHARS - 1)}…`;
      } catch { /* 글을 못 읽으면 쪽만 보인다 */ }
      out.push({
        sectionIdx: t.sectionIdx, paraIdx: para, charOffset, length,
        ...(t.cell ? { cell: { paraIdx: t.cell.paraIdx, controlIdx: t.cell.controlIdx, cellIdx: t.cell.cellIdx } } : {}),
        ...extra,
        ...(lead ? { lead } : {}),
      });
    } catch { /* 위치를 못 구하면 행은 위치 없이 보인다 */ }
  }
  return out;
}

/**
 * 배치의 뒤 항목(later)이 문단 수를 바꿨을 때, 앞 항목들이 적어 둔 자리를 같은 만큼 옮긴다.
 * later 는 편집 뒤 좌표다: 편집 전 영역의 끝은 paraEnd - paraDelta 이고 그 뒤 문단이 paraDelta 만큼 움직였다.
 */
function shiftEarlierTouches(earlier: Touch[], later: Touch): void {
  const regionEndBefore = later.paraEnd - later.paraDelta;
  for (const t of earlier) {
    if (t.sectionIdx !== later.sectionIdx || t.wholeSection) continue;
    if (t.paraStart <= regionEndBefore) continue;
    t.paraStart += later.paraDelta;
    t.paraEnd += later.paraDelta;
    if (t.cell) t.cell = { ...t.cell, paraIdx: t.cell.paraIdx + later.paraDelta };
    if (t.table) t.table = { ...t.table, paraIdx: t.table.paraIdx + later.paraDelta };
    if (t.tableCells) t.tableCells = t.tableCells.map((c) => ({ ...c, paraIdx: c.paraIdx + later.paraDelta }));
  }
}

/** (검토 UI) 인자 사본 — 긴 문자열·배열은 자른다 */
function clipArgs(value: unknown, depth = 0): Record<string, unknown> {
  const clip = (v: unknown, d: number): unknown => {
    if (typeof v === 'string') return v.length > 400 ? `${v.slice(0, 400)}…` : v;
    if (Array.isArray(v)) return d > 2 ? [] : v.slice(0, 32).map((x) => clip(x, d + 1));
    if (v && typeof v === 'object') {
      if (d > 2) return {};
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'base64' || k === 'imageBase64' || k === 'data') continue;
        out[k] = clip(x, d + 1);
      }
      return out;
    }
    return v;
  };
  return clip(asRecord(value), depth) as Record<string, unknown>;
}

function summarize(tool: string, args: Record<string, unknown>): string {
  const clip = (v: unknown) => {
    const s = String(v ?? '');
    return s.length > 40 ? `${scalarSlice(s, 0, 40)}…` : s;
  };
  switch (tool) {
    case 'insert_text': return `insert "${clip(args['text'])}"`;
    case 'replace_range': return `replace ${args['find'] ? `"${clip(args['find'])}" ` : ''}with "${clip(args['text'])}"`;
    case 'delete_range': return `delete ${args['find'] ? `"${clip(args['find'])}"` : 'range'}`;
    case 'replace_all': return `replace all "${clip(args['query'])}" → "${clip(args['replacement'])}"`;
    case 'apply_edits': return `${Array.isArray(args['edits']) ? (args['edits'] as unknown[]).length : 0} edits`;
    case 'insert_paragraphs': return `insert ${Array.isArray(args['paragraphs']) ? (args['paragraphs'] as unknown[]).length : 0} paragraph(s) "${clip(Array.isArray(args['paragraphs']) ? (args['paragraphs'] as unknown[]).find((t) => typeof t === 'string' && t) : '')}"`;
    case 'delete_paragraphs': return `delete paragraphs ${String(args['startParaIdx'])}${args['endParaIdx'] !== undefined && args['endParaIdx'] !== args['startParaIdx'] ? `–${String(args['endParaIdx'])}` : ''}`;
    case 'move_paragraphs': return `move paragraphs ${String(args['startParaIdx'])}${args['endParaIdx'] !== undefined && args['endParaIdx'] !== args['startParaIdx'] ? `–${String(args['endParaIdx'])}` : ''} → ${String(args['where'] ?? 'before')} ${String(args['toParaIdx'])}`;
    default: return tool.replace(/_/g, ' ');
  }
}

export { structureParagraphLine };
