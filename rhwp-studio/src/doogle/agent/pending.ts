// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/pending-edits.ts (staging semantics, simplified)
/**
 * 스테이징 검토 — 에이전트 모드의 쓰기는 호출 즉시 문서에 적용되어(라이브 프리뷰, 이어지는 읽기·렌더에
 * 반영) 사용자의 검토를 기다린다. 조용히 롤백하지 않는다.
 *
 * rhwp-x 는 op 마다 역연산을 들고 개별 거절을 지원했다. 두글 v1 은 검토 단위가 "스레드의 모든
 * 편집"(전체 승인/전체 거절)이므로 첫 스테이징 쓰기 직전 문서 스냅샷 하나를 기준점으로 잡는다:
 *  - acceptAll: 기준점을 버린다 (문서는 그대로).
 *  - rejectAll: 기준점으로 복원한다 — transaction 안에서 하므로 거절 자체도 undo 한 단계다.
 * 한 문서의 편집 스레드는 하나뿐이다: 다른 스레드의 편집이 검토를 기다리는 동안의 쓰기는
 * DOCUMENT_WRITER_BUSY 로 거절한다(rhwp-x claimDocumentWrite 와 같은 규칙).
 */
import { Engine } from './engine-adapter.ts';
import {
  DoogleToolError, type DoogleAgentDeps, type PendingApi, type PendingChangeEvent, type PendingChangeSet,
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
    }
  }

  /** 쓰기가 실패해 문서가 그대로면 — 대기 중 편집이 없으면 기준점을 버린다. */
  abortWrite(engine: Engine): void {
    if (this.entries.length === 0 && this.baseline !== null) {
      engine.discardSnapshot(this.baseline);
      this.baseline = null;
      this.owner = null;
    }
  }

  record(threadId: string, tool: string, summary: string, pages: number[], revision: number): PendingChangeSet {
    const entry: PendingChangeSet = {
      id: `cs${++this.seq}`,
      threadId,
      tool,
      summary,
      pages: [...new Set(pages)].sort((a, b) => a - b),
      revision,
      createdAt: this.deps.now?.() ?? Date.now(),
    };
    this.entries.push(entry);
    this.lastStagedRevision = revision;
    this.emit({ kind: 'added', threadId, changeSets: [entry] });
    return entry;
  }

  list(threadId?: string): PendingChangeSet[] {
    return this.entries.filter((e) => threadId === undefined || e.threadId === threadId).map((e) => ({ ...e, pages: [...e.pages] }));
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

  onChange(cb: (e: PendingChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private dropBaseline(): void {
    if (this.baseline === null) return;
    const doc = this.deps.getDocument();
    if (doc) new Engine(doc).discardSnapshot(this.baseline);
    this.baseline = null;
  }

  /** 문서가 교체되면 기준점·대기 목록은 의미가 없다 */
  reset(): void {
    const had = this.entries;
    this.entries = [];
    this.baseline = null;
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
