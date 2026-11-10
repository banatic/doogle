// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/revision.ts
/**
 * 문서 revision 카운터 (도구 좌표의 낙관적 동시성 제어용).
 *
 * 모든 read 도구는 revision 을 반환하고, 모든 write 도구는 expectedRevision 을 검사한다.
 * 사용자 편집·에이전트 편집 모두 EventBus 의 문서 변경 이벤트를 거치므로 여기서 구독해
 * 단조 증가시킨다. 이벤트 원천이 없는 구성(테스트·헤드리스)에서는 실행기가 쓰기 뒤에
 * `noteWrite` 로 직접 올린다 — 같은 틱의 이벤트 bump 와는 중복되지 않는다.
 *
 * 동기 bump + 마이크로태스크 dedupe: 같은 틱의 첫 이벤트가 즉시 rev 를 올리고, 함께
 * 발행되는 동반 이벤트('document-mutated' + 'document-changed')는 흡수한다.
 *
 * 문서 인스턴스: 깨끗한 문서를 닫고 다른 문서를 열면 어떤 이벤트도 revision 을 올리지 않을 수
 * 있다. 그래서 revision 을 읽을 때마다 문서 인스턴스 번호를 확인하고, 바뀌었으면 bump 를 하나
 * 넣는다 — 이전 문서에서 든 expectedRevision 은 모두 거절된다.
 */
import type { EventSourceLike } from './types.ts';

const REVISION_EVENTS = ['document-mutated', 'document-changed', 'document-swapped'] as const;

/** dirty false 전이 중 내용 불변이 보장되는 저장 계열 이유만 bump 를 생략한다. */
const CLEAN_REASONS_WITHOUT_BUMP = new Set(['save', 'save-as', 'host-save', 'save-with-history', 'pinned-save']);

/** revision 시작값 기준 시각 (2026-01-01 UTC). */
const REVISION_SEED_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * 페이지 로드마다 다른 revision 시작값 — 기준 시각 이후 경과한 1/100초.
 * 새로고침한 studio 가 hub 에 남은 턴의 옛 expectedRevision 과 같은 값에서 다시 세지 않게 한다.
 */
export function timeSeededRevision(now = Date.now()): number {
  return 1 + Math.max(0, Math.floor((now - REVISION_SEED_EPOCH_MS) / 10));
}

export interface RevisionTrackerOptions {
  /** 현재 문서 인스턴스 번호. 바뀌면 revision 을 한 번 올린다. */
  documentInstance?: () => number | undefined;
  /** 시작 revision — 기본 1. */
  initialRevision?: number;
}

export class RevisionTracker {
  private rev: number;
  private inWindow = false;
  private unsubscribes: Array<() => void> = [];
  private readonly readInstance: (() => number | undefined) | null;
  private instance: number | undefined;

  constructor(events: EventSourceLike | undefined, options: RevisionTrackerOptions = {}) {
    this.rev = options.initialRevision ?? 1;
    this.readInstance = options.documentInstance ?? null;
    this.instance = this.readInstance?.();
    if (events) {
      const bump = () => this.bumpOnce();
      for (const name of REVISION_EVENTS) {
        this.unsubscribes.push(events.on(name, bump));
      }
      // 저장에 의한 false 전이는 내용 불변 — 저장 직후의 쓰기가 불필요하게 실패하지 않게 한다.
      this.unsubscribes.push(events.on('document-dirty-changed', (change) => {
        const c = change as { dirty?: boolean; reason?: string } | undefined;
        if (c?.dirty === false && typeof c.reason === 'string' && CLEAN_REASONS_WITHOUT_BUMP.has(c.reason)) return;
        this.bumpOnce();
      }));
    }
  }

  private bumpOnce(): void {
    if (this.inWindow) return;
    this.rev++;
    this.inWindow = true;
    queueMicrotask(() => {
      this.inWindow = false;
    });
  }

  get revision(): number {
    this.syncDocumentInstance();
    return this.rev;
  }

  /**
   * 실행기가 문서를 바꾼 직후 부른다. revBefore 이후 이벤트 bump 가 없었으면(이벤트 원천이 없거나
   * 늦게 오는 구성) 직접 올린다. 이미 올랐으면 그대로 둔다.
   */
  noteWrite(revBefore: number): number {
    if (this.revision === revBefore) {
      // 같은 틱의 앞선 bump 창이 열려 있어도 이 쓰기는 새 revision 을 가져야 한다.
      this.rev++;
      if (!this.inWindow) {
        this.inWindow = true;
        queueMicrotask(() => {
          this.inWindow = false;
        });
      }
    }
    return this.revision;
  }

  private syncDocumentInstance(): void {
    if (!this.readInstance) return;
    const current = this.readInstance();
    if (current === undefined || current === this.instance) return;
    this.instance = current;
    this.rev++;
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
  }
}
