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
 *    중간 행만 빼고 뒤 행을 다시 적용하는 재생(replay)은 하지 않는다.
 * 한 문서의 편집 스레드는 하나뿐이다: 다른 스레드의 편집이 검토를 기다리는 동안의 쓰기는
 * DOCUMENT_WRITER_BUSY 로 거절한다(rhwp-x claimDocumentWrite 와 같은 규칙).
 */
import { Engine } from './engine-adapter.ts';
import {
  DoogleToolError, type DoogleAgentDeps, type PendingApi, type PendingChangeEvent, type PendingChangeSet,
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
    if (this.baseline === null) {
      this.baseline = engine.saveSnapshot();
      this.owner = threadId;
      this.pendingBefore = this.baseline;
    } else {
      try { this.pendingBefore = engine.saveSnapshot(); } catch { this.pendingBefore = null; }
    }
  }

  /** 쓰기가 실패해 문서가 그대로면 — 대기 중 편집이 없으면 기준점을 버린다. */
  abortWrite(engine: Engine): void {
    if (this.pendingBefore !== null && this.pendingBefore !== this.baseline) engine.discardSnapshot(this.pendingBefore);
    this.pendingBefore = null;
    if (this.entries.length === 0 && this.baseline !== null) {
      engine.discardSnapshot(this.baseline);
      this.baseline = null;
      this.owner = null;
    }
  }

  record(
    threadId: string, tool: string, summary: string, pages: number[], revision: number,
    extra?: { targets?: PendingChangeTarget[]; args?: Record<string, unknown> },
  ): PendingChangeSet {
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
    };
    const before = this.pendingBefore ?? (this.entries.length === 0 ? this.baseline : null);
    if (before !== null) this.befores.set(entry.id, before);
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
    }));
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
    this.entries = [];
    this.dropBaseline();
    const thread = threadId ?? this.owner ?? accepted[0]?.threadId ?? null;
    this.owner = null;
    if (thread) this.hooks.noteReview(thread, { decision: 'accepted', changeSets: accepted.length });
    this.emit({ kind: 'accepted', threadId: thread, changeSets: accepted });
    return { accepted: accepted.length };
  }

  rejectAll(threadId?: string): { rejected: number; userEditsReverted: boolean } {
    if (!this.hasPending(threadId) || !this.covers(threadId)) return { rejected: 0, userEditsReverted: false };
    const rejected = this.entries;
    const baseline = this.baseline;
    const userEditsReverted = this.hooks.revision() !== this.lastStagedRevision;
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
    const userEditsReverted = this.hooks.revision() !== this.lastStagedRevision;
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
      if (doc && snap !== undefined && snap !== this.baseline) new Engine(doc).discardSnapshot(snap);
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
      const next = this.entries[0];
      const old = this.baseline;
      this.baseline = next ? this.befores.get(next.id) ?? null : null;
      if (doc && old !== null && old !== this.baseline) new Engine(doc).discardSnapshot(old);
    }
    if (this.entries.length === 0) {
      this.dropBaseline();
      this.owner = null;
    }
  }

  onChange(cb: (e: PendingChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private dropBaseline(): void {
    const doc = this.deps.getDocument();
    const ids = new Set<number>(this.befores.values());
    if (this.baseline !== null) ids.add(this.baseline);
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
    this.owner = null;
    if (had.length > 0) this.emit({ kind: 'rejected', threadId: null, changeSets: had });
  }

  dispose(): void {
    this.dropBaseline();
    this.entries = [];
    this.listeners.clear();
  }

  private emit(e: PendingChangeEvent): void {
    for (const cb of [...this.listeners]) {
      try { cb(e); } catch (error) { console.error('[doogle] pending listener failed', error); }
    }
  }
}
