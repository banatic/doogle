// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/pending-edits.ts (staging semantics, simplified)
/**
 * 스테이징 검토 — 에이전트 모드의 쓰기는 호출 즉시 문서에 적용되어(라이브 프리뷰, 이어지는 읽기·렌더에
 * 반영) 사용자의 검토를 기다린다. 조용히 롤백하지 않는다.
 *
 * rhwp-x 는 op 마다 역연산을 들고 개별 거절을 지원했다. 두글 v1 은 검토 단위가 "스레드의 모든
 * 편집"(전체 승인/전체 거절)이므로 첫 스테이징 쓰기 직전 문서 스냅샷 하나를 기준점으로 잡는다:
 *  - acceptAll: 기준점을 버린다 (문서는 그대로).
 *  - rejectAll: 기준점으로 복원한다 — transaction 안에서 하므로 거절 자체도 undo 한 단계다.
 *
 * (추가) 행 단위 검토: 스테이징 쓰기마다 직전 스냅샷도 남긴다(첫 쓰기의 것은 기준점과 같다).
 *  - accept(id): 행에 kept 표시. 맨 앞부터 연속된 kept 행은 확정하고 기준점을 다음 행 직전으로 옮긴다.
 *  - rejectFrom(id): 그 행 직전 스냅샷으로 복원 — 그 행과 뒤 행이 함께 되돌아간다(마지막 행이면 그 행만).
 *    중간 행만 빼고 뒤 행을 다시 적용하는 재생(replay)은 하지 않는다 — 기록된 인자는 좌표·앵커가
 *    앞 변경에 기대고 있어(문단 번호 이동, 앞 변경이 만든 글자를 찾는 앵커) 다시 적용하면 검토한 것과
 *    다른 결과가 조용히 나올 수 있다. 대신 검토 UI 가 거절 전에 함께 되돌아갈 행을 본문에 보여 준다.
 *  - 행 사이·뒤의 사용자 편집은 revision 으로 감지해 userEditsBefore / hasUserEditsSince 로 알린다.
 * 한 문서의 편집 스레드는 하나뿐이다: 다른 스레드의 편집이 검토를 기다리는 동안의 쓰기는
 * DOCUMENT_WRITER_BUSY 로 거절한다(rhwp-x claimDocumentWrite 와 같은 규칙).
 */
import { Engine } from './engine-adapter.ts';
import {
  DoogleToolError, type DoogleAgentDeps, type FormatDiff, type PendingApi, type PendingChangeEvent, type PendingChangeSet,
  type PendingChangeTarget,
} from './types.ts';

export interface StagingHooks {
  /** 문서를 바꾼 뒤 revision 을 올리고 새 값을 돌려준다 */
  noteWrite(revBefore: number): number;
  revision(): number;
  /** 거절·승인 결과를 해당 스레드의 다음 도구 결과에 실어 보낸다 */
  noteReview(threadId: string, report: Record<string, unknown>): void;
}

export function documentWriterBusyError(): DoogleToolError {
  return new DoogleToolError(
    'DOCUMENT_WRITER_BUSY',
    'Another chat on this document has edits waiting for the user\'s review. A document has one editing chat at a time. '
      + 'Nothing was changed. Do not retry document-write tools in this turn; reads still work. '
      + 'Finish by telling the user what you would change; they can ask again after the other chat\'s edits are applied or discarded.',
  );
}

export class PendingStaging implements PendingApi {
  private readonly deps: DoogleAgentDeps;
  private readonly hooks: StagingHooks;
  private entries: PendingChangeSet[] = [];
  private baseline: number | null = null;
  private owner: string | null = null;
  /** 마지막 스테이징 쓰기 직후 revision — 그 뒤 revision 이 움직였으면 사용자 편집이 끼었다 */
  private lastStagedRevision = 0;
  private listeners = new Set<(e: PendingChangeEvent) => void>();
  private seq = 0;
  /** 행 id → 그 행 직전 스냅샷 (첫 행은 기준점) */
  private befores = new Map<string, number>();
  /** beginWrite 가 잡고 record 가 행에 붙일 스냅샷 */
  private pendingBefore: number | null = null;
  /** beginWrite 시점 revision — 마지막 스테이징 쓰기 뒤와 다르면 그 사이에 사용자 편집이 끼었다 */
  private writeStartRevision: number | null = null;
  /** 이 대기 묶음이 시작되기 직전 스냅샷 (첫 기준점과 같은 id). 묶음이 끝날 때까지 버리지 않는다. */
  private origin: number | null = null;
  /** 이 묶음에서 적용이 확정된 행 id */
  private settled: string[] = [];
  /** 대기 중 사용자가 직접 고친 적이 있다 — 되돌림 지점으로 돌아가면 그 편집도 사라진다 */
  private batchUserEdits = false;
  /** 방금 적용한 묶음을 한 번에 되돌릴 지점 — 적용 뒤 문서가 그대로일 때만 유효하다 */
  private revertPoint: { snapshot: number; threadId: string; ids: string[]; revision: number; instance: number | undefined } | null = null;

  constructor(deps: DoogleAgentDeps, hooks: StagingHooks) {
    this.deps = deps;
    this.hooks = hooks;
  }

  /** 스테이징 쓰기를 받을 수 있는가 — 다른 스레드가 검토 대기 중이면 던진다. */
  claim(threadId: string): void {
    if (this.entries.length > 0 && this.owner !== null && this.owner !== threadId) {
      throw documentWriterBusyError();
    }
  }

  /** 스테이징 쓰기 직전 — 첫 쓰기면 기준점 스냅샷을 남긴다. */
  beginWrite(threadId: string, engine: Engine): void {
    this.claim(threadId);
    this.writeStartRevision = this.hooks.revision();
    if (this.baseline === null) {
      // 새 묶음이 시작되면 앞 묶음의 되돌림 지점은 더는 "방금 적용한 것"이 아니다
      this.dropRevertPoint();
      this.baseline = engine.saveSnapshot();
      this.origin = this.baseline;
      this.settled = [];
      this.batchUserEdits = false;
      this.owner = threadId;
      this.pendingBefore = this.baseline;
    } else {
      try { this.pendingBefore = engine.saveSnapshot(); } catch { this.pendingBefore = null; }
    }
  }

  /** 쓰기가 실패해 문서가 그대로면 — 대기 중 편집이 없으면 기준점을 버린다. */
  abortWrite(engine: Engine): void {
    this.writeStartRevision = null;
    if (this.pendingBefore !== null && this.pendingBefore !== this.baseline) engine.discardSnapshot(this.pendingBefore);
    this.pendingBefore = null;
    if (this.entries.length === 0 && this.baseline !== null) {
      engine.discardSnapshot(this.baseline);
      this.baseline = null;
      this.origin = null;
      this.owner = null;
    }
  }

  record(
    threadId: string, tool: string, summary: string, pages: number[], revision: number,
    extra?: { targets?: PendingChangeTarget[]; args?: Record<string, unknown>; formats?: FormatDiff[] },
  ): PendingChangeSet {
    const userEditsBefore = this.entries.length > 0 && this.writeStartRevision !== null
      && this.writeStartRevision !== this.lastStagedRevision;
    this.writeStartRevision = null;
    const entry: PendingChangeSet = {
      id: `cs${++this.seq}`,
      threadId,
      tool,
      summary,
      pages: [...new Set(pages)].sort((a, b) => a - b),
      revision,
      createdAt: this.deps.now?.() ?? Date.now(),
      ...(extra?.targets ? { targets: extra.targets } : {}),
      ...(extra?.args ? { args: extra.args } : {}),
      ...(extra?.formats && extra.formats.length > 0 ? { formats: extra.formats } : {}),
      ...(userEditsBefore ? { userEditsBefore: true } : {}),
    };
    const before = this.pendingBefore ?? (this.entries.length === 0 ? this.baseline : null);
    if (before !== null) this.befores.set(entry.id, before);
    if (userEditsBefore) this.batchUserEdits = true;
    this.pendingBefore = null;
    this.entries.push(entry);
    this.lastStagedRevision = revision;
    this.emit({ kind: 'added', threadId, changeSets: [entry] });
    return entry;
  }

  list(threadId?: string): PendingChangeSet[] {
    return this.entries.filter((e) => threadId === undefined || e.threadId === threadId).map((e) => ({
      ...e,
      pages: [...e.pages],
      ...(e.targets ? { targets: e.targets.map((t) => ({ ...t })) } : {}),
      ...(e.formats ? { formats: e.formats.map((f) => ({ ...f, keys: [...f.keys], before: { ...f.before }, after: { ...f.after } })) } : {}),
    }));
  }

  /**
   * 이 행 뒤로 사용자 편집이 끼었는가 — rejectFrom(id) 가 그 편집까지 되돌리는가.
   * 뒤 행의 userEditsBefore 또는 마지막 스테이징 쓰기 뒤의 revision 이동. id 가 없으면 rejectAll 기준
   * (첫 행 앞의 편집은 기준점 스냅샷에 들어 있어 되돌아가지 않는다).
   */
  hasUserEditsSince(id?: string): boolean {
    if (this.entries.length === 0) return false;
    const index = id === undefined ? 0 : this.entries.findIndex((e) => e.id === id);
    if (index < 0) return false;
    if (this.hooks.revision() !== this.lastStagedRevision) return true;
    return this.entries.slice(index + 1).some((e) => e.userEditsBefore === true);
  }

  hasPending(threadId?: string): boolean {
    return this.entries.some((e) => threadId === undefined || e.threadId === threadId);
  }

  /** 대기 중인 모든 편집이 이 스레드 것인가 (threadId 없으면 언제나 참) */
  private covers(threadId?: string): boolean {
    return threadId === undefined || this.entries.every((e) => e.threadId === threadId);
  }

  acceptAll(threadId?: string): { accepted: number } {
    if (!this.hasPending(threadId) || !this.covers(threadId)) return { accepted: 0 };
    const accepted = this.entries;
    this.noteUserEdits();
    this.entries = [];
    this.settled.push(...accepted.map((e) => e.id));
    this.dropBaseline();
    const thread = threadId ?? this.owner ?? accepted[0]?.threadId ?? null;
    this.owner = null;
    this.finishBatch(thread);
    if (thread) this.hooks.noteReview(thread, { decision: 'accepted', changeSets: accepted.length });
    this.emit({ kind: 'accepted', threadId: thread, changeSets: accepted });
    return { accepted: accepted.length };
  }

  rejectAll(threadId?: string): { rejected: number; userEditsReverted: boolean } {
    if (!this.hasPending(threadId) || !this.covers(threadId)) return { rejected: 0, userEditsReverted: false };
    const rejected = this.entries;
    const baseline = this.baseline;
    const userEditsReverted = this.hasUserEditsSince();
    this.noteUserEdits();
    if (baseline === null) {
      throw new DoogleToolError('STAGING_BASELINE_LOST', 'The pre-edit snapshot is missing; use undo to revert the staged edits.');
    }
    const revBefore = this.hooks.revision();
    try {
      this.deps.transaction('doogle:reject-staged-edits', (doc) => {
        new Engine(doc).restoreSnapshot(baseline);
      });
    } catch (error) {
      // 스냅샷이 축출됐거나 편집 모드가 거절했다 — 대기 목록은 그대로 둔다(사용자가 undo 로 되돌릴 수 있다).
      throw new DoogleToolError(
        'STAGING_REJECT_FAILED',
        `Could not restore the document to its state before the staged edits (${error instanceof Error ? error.message : String(error)}). Use undo instead.`,
      );
    }
    this.hooks.noteWrite(revBefore);
    this.entries = [];
    this.dropBaseline();
    const thread = threadId ?? this.owner ?? rejected[0]?.threadId ?? null;
    this.owner = null;
    this.finishBatch(thread);
    if (thread) {
      this.hooks.noteReview(thread, {
        decision: 'rejected',
        changeSets: rejected.length,
        note: 'The user rejected your staged edits; the document was restored to its state before them. Re-read before editing again.',
      });
    }
    this.emit({ kind: 'rejected', threadId: thread, changeSets: rejected });
    return { rejected: rejected.length, userEditsReverted };
  }

  /** 행 하나 적용 (kept 표시 → 앞에서부터 연속된 kept 행 확정) */
  accept(id: string): { accepted: number } {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.kept) return { accepted: 0 };
    entry.kept = true;
    const thread = entry.threadId;
    this.noteUserEdits();
    this.settleKeptPrefix();
    if (this.entries.length === 0) {
      this.hooks.noteReview(thread, { decision: 'accepted', changeSets: 1 });
    }
    this.emit({ kind: 'accepted', threadId: thread, changeSets: [{ ...entry, pages: [...entry.pages] }] });
    return { accepted: 1 };
  }

  /** 이 행과 그 뒤 행을 거절 — 이 행 직전 스냅샷으로 복원한다 */
  rejectFrom(id: string): { rejected: number; userEditsReverted: boolean } {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index < 0) return { rejected: 0, userEditsReverted: false };
    if (index === 0) return this.rejectAll();
    const snapshot = this.befores.get(id);
    if (snapshot === undefined) {
      throw new DoogleToolError('STAGING_BASELINE_LOST', 'The snapshot before this edit is missing; use undo to revert it.');
    }
    const userEditsReverted = this.hasUserEditsSince(id);
    this.noteUserEdits();
    const revBefore = this.hooks.revision();
    try {
      this.deps.transaction('doogle:reject-staged-edit', (doc) => {
        new Engine(doc).restoreSnapshot(snapshot);
      });
    } catch (error) {
      throw new DoogleToolError(
        'STAGING_REJECT_FAILED',
        `Could not restore the document to its state before this edit (${error instanceof Error ? error.message : String(error)}). Use undo instead.`,
      );
    }
    this.lastStagedRevision = this.hooks.noteWrite(revBefore);
    const rejected = this.entries.splice(index);
    const doc = this.deps.getDocument();
    for (const e of rejected) {
      const snap = this.befores.get(e.id);
      this.befores.delete(e.id);
      if (doc && snap !== undefined && snap !== this.baseline && snap !== this.origin) new Engine(doc).discardSnapshot(snap);
    }
    const thread = rejected[0].threadId;
    this.hooks.noteReview(thread, {
      decision: 'partially_rejected',
      changeSets: rejected.length,
      remaining: this.entries.length,
      note: `The user rejected ${rejected.length} of your staged edit(s) (the most recent ones); the document was restored to its state before them. Re-read before editing again.`,
    });
    this.emit({ kind: 'rejected', threadId: thread, changeSets: rejected });
    this.settleKeptPrefix();
    return { rejected: rejected.length, userEditsReverted };
  }

  /** 맨 앞부터 연속된 kept 행을 확정하고 기준점을 그 다음 행 직전 스냅샷으로 옮긴다 */
  private settleKeptPrefix(): void {
    const doc = this.deps.getDocument();
    while (this.entries.length > 0 && this.entries[0].kept) {
      const first = this.entries.shift()!;
      this.befores.delete(first.id);
      this.settled.push(first.id);
      const next = this.entries[0];
      const old = this.baseline;
      this.baseline = next ? this.befores.get(next.id) ?? null : null;
      if (doc && old !== null && old !== this.baseline && old !== this.origin) new Engine(doc).discardSnapshot(old);
    }
    if (this.entries.length === 0 && (this.baseline !== null || this.origin !== null)) {
      const thread = this.owner;
      this.dropBaseline();
      this.owner = null;
      this.finishBatch(thread);
    }
  }

  /** 마지막 스테이징 쓰기 뒤로 revision 이 움직였으면 사용자가 직접 고쳤다 */
  private noteUserEdits(): void {
    if (this.entries.length > 0 && this.hooks.revision() !== this.lastStagedRevision) this.batchUserEdits = true;
  }

  /**
   * 대기 묶음이 비었다 — 적용된 행이 있고 그 사이 직접 편집이 없었으면 묶음 시작 직전 스냅샷을
   * 되돌림 지점으로 남긴다. 아니면 버린다.
   */
  private finishBatch(thread: string | null): void {
    const origin = this.origin;
    const ids = this.settled;
    this.origin = null;
    this.settled = [];
    if (origin === null) return;
    if (ids.length === 0 || !thread || this.batchUserEdits) {
      const doc = this.deps.getDocument();
      if (doc) new Engine(doc).discardSnapshot(origin);
      return;
    }
    this.revertPoint = {
      snapshot: origin, threadId: thread, ids, revision: this.hooks.revision(), instance: this.deps.documentInstance?.(),
    };
  }

  private dropRevertPoint(): void {
    const point = this.revertPoint;
    this.revertPoint = null;
    if (!point) return;
    // 문서가 바뀌었으면 스냅샷 id 는 다른 문서의 것이다 — 건드리지 않는다
    if (this.deps.documentInstance?.() !== point.instance) return;
    const doc = this.deps.getDocument();
    if (doc) new Engine(doc).discardSnapshot(point.snapshot);
  }

  /**
   * 방금 적용한 묶음을 한 번에 되돌릴 수 있는가. 적용 뒤 문서가 한 번이라도 바뀌었으면(직접 편집·
   * 실행 취소·새 쓰기) null — 그때는 실행 취소(Ctrl+Z)가 맞는 길이다.
   */
  revertInfo(): { threadId: string; ids: string[]; count: number } | null {
    const point = this.revertPoint;
    if (!point) return null;
    if (this.entries.length > 0 || this.hooks.revision() !== point.revision || this.deps.documentInstance?.() !== point.instance) {
      this.dropRevertPoint();
      return null;
    }
    return { threadId: point.threadId, ids: [...point.ids], count: point.ids.length };
  }

  /** 방금 적용한 묶음을 그 요청 전 상태로 되돌린다 — transaction 한 번이라 이것도 undo 한 단계다 */
  revertAccepted(): { reverted: number } {
    const info = this.revertInfo();
    const point = this.revertPoint;
    if (!info || !point) return { reverted: 0 };
    const revBefore = this.hooks.revision();
    try {
      this.deps.transaction('doogle:revert-accepted-edits', (doc) => {
        new Engine(doc).restoreSnapshot(point.snapshot);
      });
    } catch (error) {
      throw new DoogleToolError(
        'STAGING_REJECT_FAILED',
        `Could not restore the document to its state before the applied edits (${error instanceof Error ? error.message : String(error)}). Use undo instead.`,
      );
    }
    this.hooks.noteWrite(revBefore);
    this.dropRevertPoint();
    this.hooks.noteReview(info.threadId, {
      decision: 'reverted',
      changeSets: info.count,
      note: `The user reverted ${info.count} edit(s) of yours that they had applied; the document is back to its state before them. Re-read before editing again.`,
    });
    this.emit({ kind: 'reverted', threadId: info.threadId, changeSets: [] });
    return { reverted: info.count };
  }

  onChange(cb: (e: PendingChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private dropBaseline(): void {
    const doc = this.deps.getDocument();
    const ids = new Set<number>(this.befores.values());
    if (this.baseline !== null) ids.add(this.baseline);
    if (this.origin !== null) ids.delete(this.origin);
    if (doc) for (const id of ids) new Engine(doc).discardSnapshot(id);
    this.befores.clear();
    this.baseline = null;
  }

  /** 문서가 교체되면 기준점·대기 목록은 의미가 없다 */
  reset(): void {
    const had = this.entries;
    this.entries = [];
    this.baseline = null;
    this.befores.clear();
    this.pendingBefore = null;
    this.writeStartRevision = null;
    this.owner = null;
    this.origin = null;
    this.settled = [];
    this.batchUserEdits = false;
    this.revertPoint = null;
    if (had.length > 0) this.emit({ kind: 'rejected', threadId: null, changeSets: had });
  }

  dispose(): void {
    const origin = this.origin;
    this.origin = null;
    this.dropBaseline();
    this.dropRevertPoint();
    const doc = this.deps.getDocument();
    if (doc && origin !== null) new Engine(doc).discardSnapshot(origin);
    this.entries = [];
    this.listeners.clear();
  }

  private emit(e: PendingChangeEvent): void {
    for (const cb of [...this.listeners]) {
      try { cb(e); } catch (error) { console.error('[doogle] pending listener failed', error); }
    }
  }
}
