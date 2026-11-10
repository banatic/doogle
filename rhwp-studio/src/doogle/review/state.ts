/**
 * 검토 상태 공유 — 사이드바(검토 목록)와 문서 위 검토 막(팝오버·하단 알약)이 같은 "지금 보는 변경"을 본다.
 *
 * 실행기의 PendingApi 를 감싸 kept(행 단위 적용) 행을 뺀 목록을 내고, 개수가 바뀔 때마다
 * window 이벤트 `doogle:pending-count {detail:{count}}` 를 쏜다(상태 표시줄이 듣는다).
 * 문서 이동(선택)은 막이 등록한 revealer 가 한다 — 이 모듈은 DOM·호스트를 모른다.
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

  /** 실행기 검토 API 를 붙인다 (null 이면 뗀다). */
  attach(api: PendingApi | null): void {
    if (this.api === api) return;
    this.offApi?.();
    this.offApi = null;
    this.api = api;
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
    let report: DecisionReport;
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

  /** 이 거절은 확인을 받아야 하는가 — 뒤 행이나 사용자 편집이 함께 되돌아갈 때 */
  needsConfirm(id?: string): boolean {
    const impact = this.rejectImpact(id);
    return id === undefined ? impact.userEdits : impact.later > 0 || impact.userEdits;
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

  private changed(): void {
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
