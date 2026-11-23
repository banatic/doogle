/**
 * 검토 상태 공유 — 사이드바(검토 목록)와 문서 위 검토 막(팝오버·하단 알약)이 같은 "지금 보는 변경"을 본다.
 *
 * 실행기의 PendingApi 를 감싸 kept(행 단위 적용) 행을 뺀 목록을 내고, 개수가 바뀔 때마다
 * window 이벤트 `doogle:pending-count {detail:{count}}` 를 쏜다(상태 표시줄이 듣는다).
 * 문서 이동(선택)은 막이 등록한 revealer 가 한다 — 이 모듈은 DOM·호스트를 모른다.
 *
 * 일부만 적용·거절하면 처리한 행은 목록에서 빠진다(적용 표시 행은 kept, 거절 행은 사라짐).
 * 무엇이 남았는지 보이도록 한 묶음(대기 목록이 빌 때까지) 안에서 처리한 행을 따로 기억해
 * `handled()`·`total` 로 낸다 — 표면은 "남은 변경 3 / 7" 과 처리한 행 접힘 목록을 그린다.
 */
import type { PendingApi, PendingChangeSet } from '../agent/types.ts';

export type ReviewListener = () => void;
export type ExplainListener = (changeId: string) => void;

/** 거절의 파급 — 검토 UI 가 거절 전에 본문에 보여 준다 */
export interface RejectImpact {
  /** 함께 되돌아가는 행 수 (자신 포함, 적용 표시한 뒤 행 포함) */
  count: number;
  /** 자신을 뺀 뒤 행 수 */
  later: number;
  /** later 중 이미 적용 표시(kept)한 행 수 */
  kept: number;
  /** 그 사이 사용자가 직접 고친 내용도 함께 되돌아가는가 */
  userEdits: boolean;
}

export interface DecisionReport {
  kind: 'accept' | 'reject';
  /** one = 행 하나(거절은 뒤 행 포함일 수 있다), all = 전체 */
  scope: 'one' | 'all';
  count: number;
  threads: string[];
  userEditsReverted: boolean;
}

/** 이번 묶음에서 처리한 변경 (적용 표시·확정 = accept, 거절·함께 되돌아감 = reject) */
export interface HandledChange {
  change: PendingChangeSet;
  kind: 'accept' | 'reject';
}

export class ReviewStore {
  private api: PendingApi | null = null;
  private offApi: (() => void) | null = null;
  private current: string | null = null;
  private busyValue = false;
  private lastCount = -1;
  private readonly listeners = new Set<ReviewListener>();
  private readonly explainListeners = new Set<ExplainListener>();
  private readonly decisionListeners = new Set<(report: DecisionReport) => void>();
  private revealer: ((change: PendingChangeSet) => void) | null = null;
  /** 이번 묶음에서 처리한 행 (처리 순서) — 대기 목록이 비면 비운다 */
  private readonly handledLog = new Map<string, HandledChange>();
  /** 직전에 본 대기 목록 (id → 행·kept) — 빠지거나 kept 가 된 행을 처리로 기록한다 */
  private known = new Map<string, { change: PendingChangeSet; kept: boolean }>();
  /** decide() 가 도는 동안의 결정 — 그 사이 빠진 행을 이 결정으로 기록한다 */
  private deciding: 'accept' | 'reject' | null = null;

  /** 실행기 검토 API 를 붙인다 (null 이면 뗀다). */
  attach(api: PendingApi | null): void {
    if (this.api === api) return;
    this.offApi?.();
    this.offApi = null;
    this.api = api;
    this.handledLog.clear();
    this.known = new Map();
    if (api) this.offApi = api.onChange(() => this.changed());
    this.changed();
  }

  get pending(): PendingApi | null {
    return this.api;
  }

  /** 에이전트 턴이 도는 중이면 검토 결정을 막는다 (사이드바가 알린다) */
  get busy(): boolean {
    return this.busyValue;
  }

  setBusy(busy: boolean): void {
    if (this.busyValue === busy) return;
    this.busyValue = busy;
    this.notify();
  }

  /** 검토할 변경 (적용 표시한 행 제외, 기록 순서) */
  rows(): PendingChangeSet[] {
    return this.api ? this.api.list().filter((c) => !c.kept) : [];
  }

  get count(): number {
    return this.rows().length;
  }

  /** 이번 묶음에서 처리한 변경 (처리 순서) */
  handled(): HandledChange[] {
    return [...this.handledLog.values()];
  }

  /** 이번 묶음 전체 = 남은 변경 + 처리한 변경 */
  get total(): number {
    return this.count + this.handledLog.size;
  }

  get currentId(): string | null {
    const rows = this.rows();
    if (this.current && rows.some((r) => r.id === this.current)) return this.current;
    return rows[0]?.id ?? null;
  }

  currentIndex(): number {
    const id = this.currentId;
    return id ? this.rows().findIndex((r) => r.id === id) : -1;
  }

  /** 지금 볼 변경을 바꾼다. reveal 이면 문서에서 그 자리를 선택해 보여 준다. */
  focus(id: string | null, reveal = false): void {
    this.current = id;
    this.notify();
    if (reveal && id) {
      const change = this.rows().find((r) => r.id === id);
      if (change) this.revealer?.(change);
    }
  }

  step(delta: number): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const index = Math.max(0, this.currentIndex());
    const next = (index + delta + rows.length) % rows.length;
    this.focus(rows[next].id, true);
  }

  setRevealer(fn: ((change: PendingChangeSet) => void) | null): void {
    this.revealer = fn;
  }

  /**
   * 검토 결정 실행 — 사이드바·문서 위 막이 같은 길을 쓴다. id 가 없으면 전체.
   * 행 단위 API(accept/rejectFrom)가 없는 실행기면 전체 결정으로 떨어진다.
   * 실패하면 던진다(호출자가 알린다).
   */
  decide(kind: 'accept' | 'reject', id?: string): DecisionReport | null {
    const api = this.api;
    if (!api) return null;
    const rows = this.rows();
    const target = id ? rows.find((r) => r.id === id) : undefined;
    const threads = [...new Set(api.list().map((c) => c.threadId).filter(Boolean))];
    if (target) {
      // 결정한 행 다음의 남은 행으로 넘어간다 — 적용이면 아래 행(없으면 맨 위로), 거절이면 아래 행이 함께
      // 되돌아가므로 바로 위 행. 결정 전에 정해 두어야 목록이 바뀌는 순간에도 맨 위로 튀지 않는다.
      const index = rows.indexOf(target);
      const below = rows.slice(index + 1);
      const above = rows.slice(0, index);
      const next = kind === 'accept' ? below[0] ?? above[0] : api.rejectFrom ? above[above.length - 1] : undefined;
      this.current = next?.id ?? null;
    }
    let report: DecisionReport;
    this.deciding = kind;
    try {
      if (kind === 'accept') {
        if (target && api.accept) {
          report = { kind, scope: 'one', count: api.accept(target.id).accepted, threads: [target.threadId], userEditsReverted: false };
        } else {
          report = { kind, scope: 'all', count: api.acceptAll().accepted, threads, userEditsReverted: false };
        }
      } else if (target && api.rejectFrom) {
        // 스냅샷 모델: 그 행 직전으로 복원 — 뒤 행도 함께 되돌아간다 (마지막 행이면 그 행만)
        const r = api.rejectFrom(target.id);
        report = { kind, scope: 'one', count: r.rejected, threads: [target.threadId], userEditsReverted: r.userEditsReverted };
      } else {
        const r = api.rejectAll();
        report = { kind, scope: 'all', count: r.rejected, threads, userEditsReverted: r.userEditsReverted };
      }
    } finally {
      // 실행기가 알리지 않은 확정(앞 kept 행 정리)까지 이 결정으로 기록한다
      this.changed();
      this.deciding = null;
    }
    for (const cb of [...this.decisionListeners]) {
      try { cb(report); } catch (error) { console.error('[doogle] decision listener failed', error); }
    }
    return report;
  }

  /** 이 행을 거절하면 함께 되돌아가는 행 수 (자신 포함, 적용 표시한 뒤 행 포함) */
  rejectSpan(id: string): number {
    const all = this.api?.list() ?? [];
    const index = all.findIndex((c) => c.id === id);
    if (index < 0) return 0;
    return this.api?.rejectFrom ? all.length - index : all.length;
  }

  /**
   * 거절의 파급. id 가 없으면 모두 거절. 스냅샷 모델이라 중간 행 거절은 뒤 행을 함께 되돌린다
   * (행 단위 API 가 없는 실행기면 행 거절도 전체 거절이다).
   */
  rejectImpact(id?: string): RejectImpact {
    const all = this.api?.list() ?? [];
    if (all.length === 0) return { count: 0, later: 0, kept: 0, userEdits: false };
    let index = id === undefined || !this.api?.rejectFrom ? 0 : all.findIndex((c) => c.id === id);
    if (index < 0) index = 0;
    const span = all.slice(index);
    const self = id !== undefined ? span.find((c) => c.id === id) : undefined;
    const others = self ? span.filter((c) => c !== self) : span.slice(1);
    const userEdits = this.api?.hasUserEditsSince?.(index === 0 ? undefined : all[index].id) ?? false;
    return {
      count: span.length,
      later: others.length,
      kept: others.filter((c) => c.kept).length,
      userEdits,
    };
  }

  /**
   * 이 거절은 확인을 받아야 하는가 — 뒤 행이나 사용자 편집이 함께 되돌아갈 때.
   * 남은 변경 모두 거절은 적용 표시한 행이 함께 되돌아갈 때도 묻는다.
   */
  needsConfirm(id?: string): boolean {
    const impact = this.rejectImpact(id);
    return id === undefined ? impact.userEdits || impact.kept > 0 : impact.later > 0 || impact.userEdits;
  }

  /** 대기 중 사용자 편집이 끼었는가 (알약의 "직접 편집 포함") */
  hasUserEdits(): boolean {
    return this.api?.hasUserEditsSince?.() ?? false;
  }

  /** 이 행 바로 앞(앞 행과의 사이)에 사용자 편집이 있었는가 */
  userEditsBefore(id: string): boolean {
    return this.api?.list().find((c) => c.id === id)?.userEditsBefore === true;
  }

  /** 마지막 변경 뒤에 사용자 편집이 있는가 */
  trailingUserEdits(): boolean {
    const all = this.api?.list() ?? [];
    const last = all[all.length - 1];
    return last ? this.api?.hasUserEditsSince?.(last.id) ?? false : false;
  }

  /** 문서 쪽 수 (실행기가 알려 주면) */
  pageCount(): number {
    try { return this.api?.pageCount?.() ?? 0; } catch { return 0; }
  }

  /** 문서가 실행기 밖에서 바뀌었다(사용자 편집) — 표면들이 다시 그린다 */
  refresh(): void {
    this.changed();
  }

  onDecision(cb: (report: DecisionReport) => void): () => void {
    this.decisionListeners.add(cb);
    return () => { this.decisionListeners.delete(cb); };
  }

  /** "왜 바꿨나요?" — 사이드바가 그 변경을 만든 턴의 설명으로 스크롤한다. */
  explain(id: string): void {
    for (const cb of [...this.explainListeners]) cb(id);
  }

  onExplain(cb: ExplainListener): () => void {
    this.explainListeners.add(cb);
    return () => { this.explainListeners.delete(cb); };
  }

  onChange(cb: ReviewListener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** 직전 목록과 비교해 처리한 행을 기록한다. 대기 목록이 비면 묶음이 끝난 것이다. */
  private track(): void {
    const all = this.api?.list() ?? [];
    if (all.length === 0) {
      this.handledLog.clear();
      this.known = new Map();
      return;
    }
    const now = new Map(all.map((c) => [c.id, c] as const));
    for (const [id, prev] of this.known) {
      const cur = now.get(id);
      if (!prev.kept) {
        if (cur?.kept) this.handledLog.set(id, { change: cur, kind: 'accept' });
        else if (!cur) this.handledLog.set(id, { change: prev.change, kind: this.deciding ?? 'reject' });
      } else if (!cur && this.deciding === 'reject') {
        // 적용 표시했지만 앞 행 거절에 함께 되돌아갔다
        this.handledLog.set(id, { change: prev.change, kind: 'reject' });
      }
    }
    // 처음 보는 적용 표시 행(목록을 붙이기 전에 적용한 것)도 처리한 것으로 센다
    for (const c of all) if (c.kept && !this.handledLog.has(c.id)) this.handledLog.set(c.id, { change: c, kind: 'accept' });
    this.known = new Map(all.map((c) => [c.id, { change: c, kept: c.kept === true }] as const));
  }

  private changed(): void {
    this.track();
    const count = this.count;
    if (count !== this.lastCount) {
      this.lastCount = count;
      try {
        window.dispatchEvent(new CustomEvent('doogle:pending-count', { detail: { count } }));
      } catch { /* window 없는 환경 */ }
    }
    this.notify();
  }

  private notify(): void {
    for (const cb of [...this.listeners]) {
      try { cb(); } catch (error) { console.error('[doogle] review listener failed', error); }
    }
  }
}

export const reviewStore = new ReviewStore();
