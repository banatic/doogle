/**
 * 문서 갈래 — 에이전트 요청마다 문서 상태를 git 커밋처럼 남기고, 아무 지점으로나 되돌아간다.
 *
 * 검토(적용/거절) 대신 이 기록이 안전망이다. 편집은 곧바로 문서에 들어가고, 요청이 끝나면 그 상태를
 * 엔진 스냅샷 하나로 남긴다(지점). 지점은 부모를 가리켜 나무를 이룬다:
 *  - 첫 요청 전 문서 → "처음 상태" 뿌리.
 *  - 요청이 문서를 바꾸면 → 요청 시작 때의 지점을 부모로 새 지점.
 *  - 지점 사이에 사용자가 직접 고쳤으면 → 다음 요청·되돌아가기 직전에 "직접 고침" 지점으로 남긴다
 *    (되돌아가도 그 편집이 사라지지 않게).
 *  - 옛 지점으로 돌아간 뒤 새 요청을 하면 → 그 지점에서 갈라지는 새 갈래가 생긴다.
 * 되돌아가기는 transaction 한 번이라 실행 취소 한 단계이기도 하다.
 *
 * 스냅샷은 엔진의 실행 취소 스냅샷과 같은 저장소(상한 MAX_SNAPSHOTS)를 쓴다 — 오래되면 엔진이 먼저
 * 버릴 수 있다.
 *
 * 영속화(agent/checkpoint-store.ts): 문서 키(deps.documentKey)가 있고 저장소(deps.checkpointStore)가
 * 있으면, 지점을 남길 때 그 문서를 HWP 바이트로 떠서 저장소에 같이 둔다. 앱을 다시 열거나 문서를 다시
 * 열면 나무를 불러오고, 지금 문서와 바이트 지문이 같은 지점(없으면 마지막 head)을 지금 자리로 잡는다
 * (다르면 head 뒤로 "직접 고침"이 있는 것으로 본다). 되돌아가기는 메모리 스냅샷이 살아 있으면 그것을,
 * 없으면 저장된 바이트를 엔진 importSnapshot 으로 스냅샷으로 만들어 복원한다 — 둘 다 transaction 한 번.
 * 바이트가 아직 메모리에 없으면 checkout 은 { pending } 을 돌려주고 읽기가 끝나면 되돌아간다.
 * 스냅샷도 바이트도 없는 지점은 lost 로 표시하고 그대로 둔다(나무 모양은 유지).
 * 저장 안 한 새 문서(키 없음)의 지점은 지금처럼 세션 한정이다.
 */
import { Engine } from './engine-adapter.ts';
import {
  MAX_BLOB_BYTES, hashBytes, planPrune, sweepStore,
  type CheckpointStore, type StoredNode, type StoredTree,
} from './checkpoint-store.ts';
import {
  DoogleToolError, type CheckpointEvent, type CheckpointNode, type CheckoutResult, type DoogleAgentDeps, type HistoryApi,
} from './types.ts';

export interface CheckpointHooks {
  revision(): number;
  noteWrite(revBefore: number): number;
  /** 되돌아간 사실을 그 대화의 다음 도구 결과에 실어 보낸다 */
  noteReview(threadId: string, report: Record<string, unknown>): void;
}

interface NodeRecord extends CheckpointNode {
  snapshot: number | null;
  /** 이 지점을 남긴(또는 이 지점으로 돌아온) 직후의 revision. 불러온 지점은 -1(맞춰 보기 전) */
  revision: number;
  /** 저장한(할) 바이트 크기·지문 */
  size?: number;
  hash?: string;
  /** 본문 글 지문 — HWPX 에서 온 문서는 다시 열면 바이트가 조금 달라진다. 그때 같은 문서인지 이것으로 본다 */
  text?: string;
  /** 저장소에 아직 쓰지 않은 바이트 (나무를 불러오기 전에 생긴 지점) */
  unsaved?: Uint8Array;
  /** 저장소에서 미리 읽어 둔 바이트 — 되돌아가기를 기다리지 않게 */
  cache?: Uint8Array;
  /** 저장소의 나무에 들어 있다(불러왔거나 적었다) — 같은 키를 다시 합칠 때 겹치지 않게 */
  inStore?: boolean;
}

/** 스냅샷을 들고 있는 지점 수 상한 — 실행 취소 스냅샷 몫을 너무 많이 먹지 않게 */
const MAX_LIVE = 24;
/** 불러온 나무에서 미리 읽어 둘 바이트 합 */
const PREFETCH_BYTES = 24 * 1024 * 1024;

/** 앱을 연 뒤 한 번만 저장소 전체를 정리한다 */
let swept = false;

export class CheckpointTree implements HistoryApi {
  private readonly deps: DoogleAgentDeps;
  private readonly hooks: CheckpointHooks;
  private readonly store: CheckpointStore | null;
  private records: NodeRecord[] = [];
  private headId: string | null = null;
  private seq = 0;
  private instance: number | undefined;
  private turns = new Map<string, { parent: string; revision: number; threadId: string; label: string }>();
  private listeners = new Set<(e: CheckpointEvent) => void>();
  /** 지금 문서 키 · 저장소의 나무를 이미 합친 키 */
  private docKey: string | null = null;
  private loadedKey: string | null = null;
  private loadToken = 0;
  /** 저장소 읽기·쓰기를 차례로 */
  private io: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(deps: DoogleAgentDeps, hooks: CheckpointHooks) {
    this.deps = deps;
    this.hooks = hooks;
    this.store = deps.checkpointStore ?? null;
    this.instance = deps.documentInstance?.();
    this.syncKey();
  }

  /** 저장소 읽기·쓰기가 모두 끝나면 풀린다 (시험·종료용) */
  async flush(): Promise<void> {
    let last: Promise<void>;
    do {
      last = this.io;
      await last;
    } while (last !== this.io);
  }

  nodes(): CheckpointNode[] {
    this.sync();
    return this.records.map((r) => this.publicOf(r));
  }

  head(): string | null {
    this.sync();
    return this.headId;
  }

  dirty(): boolean {
    this.sync();
    const head = this.find(this.headId);
    return !!head && this.hooks.revision() !== head.revision;
  }

  beginTurn(threadId: string, turnKey: string, label: string): void {
    this.sync();
    this.captureManual();
    if (!this.headId) return;
    this.turns.set(turnKey, { parent: this.headId, revision: this.hooks.revision(), threadId, label });
  }

  endTurn(turnKey: string): CheckpointNode | null {
    this.sync();
    const turn = this.turns.get(turnKey);
    this.turns.delete(turnKey);
    if (!turn || !this.find(turn.parent)) return null;
    if (this.hooks.revision() === turn.revision) return null;
    const node = this.add('agent', turn.label, turn.parent, { threadId: turn.threadId, turnKey });
    return node ? this.publicOf(node) : null;
  }

  turnNode(turnKey: string): CheckpointNode | null {
    const node = this.records.find((r) => r.turnKey === turnKey);
    return node ? this.publicOf(node) : null;
  }

  checkout(id: string): CheckoutResult {
    this.sync();
    const target = this.find(id);
    if (!target) throw new DoogleToolError('CHECKPOINT_NOT_FOUND', '그 지점을 찾지 못했습니다.');
    if (target.snapshot === null && !this.bytesOf(target)) {
      if (this.canFetch(target)) return this.checkoutLater(target);
      throw this.lostError();
    }
    const savedManual = this.captureManual();
    if (this.headId === id && !this.dirty()) return { changed: false, savedManual };
    const revBefore = this.hooks.revision();
    if (this.restoreInto(target) === 'fetch') return { ...this.checkoutLater(target), savedManual };
    this.hooks.noteWrite(revBefore);
    this.deps.refreshView?.();
    this.headId = id;
    target.revision = this.hooks.revision();
    // 복원에 딸린 이벤트가 한 틱 늦게 와 revision 을 올리면 "직접 고침" 으로 잘못 보인다 — 한 번 더 맞춘다
    // (사용자가 같은 매크로태스크 안에 편집할 수는 없다)
    setTimeout(() => { if (this.headId === id) target.revision = this.hooks.revision(); }, 0);
    const label = target.kind === 'origin' ? '처음 상태' : `"${target.label}"`;
    for (const thread of new Set(this.records.map((r) => r.threadId).filter((t): t is string => !!t))) {
      this.hooks.noteReview(thread, {
        decision: 'checkout',
        note: `The user moved the document back to a saved checkpoint (${label}). Earlier edits after that point are no longer in the document. Re-read before editing again.`,
      });
    }
    this.persistTree();
    this.emit({ kind: 'checkout', id });
    return { changed: true, savedManual };
  }

  onChange(cb: (e: CheckpointEvent) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private sync(): void {
    this.syncInstance();
    this.syncKey();
  }

  /** 문서가 바뀌었으면 기록을 버린다 — 스냅샷 번호는 그 문서의 것이다 */
  private syncInstance(): void {
    const now = this.deps.documentInstance?.();
    if (now === this.instance) return;
    this.instance = now;
    this.clear();
    this.emit({ kind: 'reset' });
  }

  reset(): void {
    this.instance = this.deps.documentInstance?.();
    this.clear();
    this.emit({ kind: 'reset' });
    this.syncKey();
  }

  private clear(): void {
    this.records = [];
    this.headId = null;
    this.turns.clear();
    this.docKey = null;
    this.loadedKey = null;
    this.loadToken++;
  }

  // ─── 영속화 ───────────────────────────────────────────

  private persisting(): boolean {
    return !!this.store && !!this.docKey && this.loadedKey === this.docKey && !this.disposed;
  }

  /** 문서 키가 생기거나 바뀌었으면 저장소의 나무를 불러오거나(처음) 새 키로 옮겨 적는다(다른 이름으로 저장) */
  private syncKey(): void {
    if (!this.store || this.disposed) return;
    let key: string | null = null;
    try { key = this.deps.documentKey?.() ?? null; } catch { key = null; }
    if (key === this.docKey) return;
    const prev = this.docKey;
    this.docKey = key;
    if (!key) {
      this.loadedKey = null;
      this.loadToken++;
      return;
    }
    if (prev && this.loadedKey === prev) {
      // 다른 이름으로 저장 — 같은 문서다. 저장된 바이트를 새 키로 옮겨 적고 나무도 새 키로.
      this.loadedKey = key;
      const store = this.store;
      const ids = this.records.filter((r) => r.stored).map((r) => r.id);
      this.fire(async () => {
        for (const id of ids) {
          const bytes = await store.getBlob(prev, id);
          if (bytes) await store.putBlob(key, id, bytes);
        }
      });
      this.persistTree();
      return;
    }
    this.startLoad(key);
  }

  private startLoad(key: string): void {
    const store = this.store!;
    const token = ++this.loadToken;
    this.fire(async () => {
      let stored: StoredTree | null = null;
      try {
        stored = await store.loadTree(key);
      } catch (error) {
        console.warn('[doogle] 문서 갈래를 불러오지 못했습니다', error);
      }
      if (token !== this.loadToken || this.docKey !== key || this.disposed) return;
      this.merge(key, stored);
      if (!swept) {
        swept = true;
        this.fire(() => sweepStore(store, key, this.deps.now?.() ?? Date.now()));
      }
    });
  }

  /** 불러온 나무를 지금 기록과 합친다 — 지금 문서가 그 나무의 어느 지점인지 맞춰 head 를 잡는다 */
  private merge(key: string, stored: StoredTree | null): void {
    this.loadedKey = key;
    const known = new Set(this.records.filter((r) => r.inStore).map((r) => r.id));
    const loaded: NodeRecord[] = (stored?.nodes ?? [])
      .filter((n) => !known.has(n.id))
      .map((n) => ({
        id: n.id,
        parentId: n.parentId,
        kind: n.kind,
        label: n.label,
        createdAt: n.createdAt,
        ...(n.threadId ? { threadId: n.threadId } : {}),
        ...(n.turnKey ? { turnKey: n.turnKey } : {}),
        ...(n.size ? { size: n.size, stored: true } : { lost: true }),
        ...(n.hash ? { hash: n.hash } : {}),
        ...(n.text ? { text: n.text } : {}),
        snapshot: null,
        revision: -1,
        inStore: true,
      }));
    if (stored && loaded.length) {
      this.seq = Math.max(this.seq, stored.seq);
      const ids = new Set(loaded.map((r) => r.id));
      for (const r of this.records) if (ids.has(r.id)) this.rename(r, `cp${++this.seq}`);
      const head = loaded.find((r) => r.id === stored.headId) ?? loaded[loaded.length - 1];
      const match = this.matchCurrent(loaded, head);
      const anchor = match ?? head;
      if (!this.records.length) {
        this.records = loaded;
        this.headId = anchor.id;
        // 같은 문서면 지금 자리, 아니면 head 뒤로 바깥에서 고친 것이 있다 — 다음 요청 때 "직접 고침" 지점
        anchor.revision = match ? this.hooks.revision() : -1;
      } else {
        // 불러오기 전에 생긴 지점들 — 그 뿌리를 불러온 나무의 지금 자리 아래에 붙인다
        const folded = new Set<string>();
        for (const r of this.records) {
          if (r.parentId !== null) continue;
          if (sameState(r, anchor)) {
            for (const c of this.records) if (c.parentId === r.id) c.parentId = anchor.id;
            for (const t of this.turns.values()) if (t.parent === r.id) t.parent = anchor.id;
            if (this.headId === r.id) this.headId = anchor.id;
            anchor.snapshot = r.snapshot;
            anchor.revision = r.revision;
            delete anchor.lost;
            folded.add(r.id);
          } else {
            r.parentId = anchor.id;
            r.kind = 'manual';
            r.label = '직접 고침';
          }
        }
        this.records = [...loaded, ...this.records.filter((r) => !folded.has(r.id))];
      }
    }
    this.flushUnsaved();
    this.prune();
    this.persistTree();
    this.prefetch();
    this.emit({ kind: 'changed' });
  }

  private rename(r: NodeRecord, id: string): void {
    const old = r.id;
    r.id = id;
    for (const c of this.records) if (c.parentId === old) c.parentId = id;
    for (const t of this.turns.values()) if (t.parent === old) t.parent = id;
    if (this.headId === old) this.headId = id;
  }

  /**
   * 지금 문서와 같은 지점 — 바이트 지문이 같은 가장 새 지점, 없으면 본문 글 지문이 같은 지점(head 먼저).
   * HWP 는 내보내기·다시 열기를 거쳐도 바이트가 같지만, HWPX 에서 온 문서는 처음 한 번 바이트가 달라진다.
   */
  private matchCurrent(loaded: NodeRecord[], head: NodeRecord): NodeRecord | undefined {
    const doc = this.deps.getDocument();
    if (!doc) return undefined;
    const engine = new Engine(doc);
    let hash: string | null = null;
    try { hash = hashBytes(engine.exportHwp()); } catch { hash = null; }
    const newest = [...loaded].reverse();
    const byBytes = hash ? newest.find((r) => r.hash === hash) : undefined;
    if (byBytes) return byBytes;
    const text = textFingerprint(engine);
    if (!text) return undefined;
    if (head.text === text) return head;
    return newest.find((r) => r.text === text);
  }

  /** 아직 쓰지 않은 바이트를 저장소에 쓴다 */
  private flushUnsaved(): void {
    if (!this.persisting()) return;
    const store = this.store!;
    const key = this.docKey!;
    for (const r of this.records) {
      const bytes = r.unsaved;
      if (!bytes) continue;
      r.unsaved = undefined;
      r.stored = true;
      const id = r.id;
      this.fire(async () => {
        try {
          await store.putBlob(key, id, bytes);
        } catch (error) {
          const rec = this.find(id);
          if (rec && this.docKey === key) {
            delete rec.stored;
            delete rec.size;
            if (rec.snapshot === null) rec.lost = true;
            this.persistTree();
            this.emit({ kind: 'changed' });
          }
          throw error;
        }
      });
    }
  }

  /** 문서별 상한을 넘은 바이트·지점을 정리한다 */
  private prune(): void {
    if (!this.persisting()) return;
    const plan = planPrune({
      headId: this.headId,
      nodes: this.records.map((r) => ({
        id: r.id, parentId: r.parentId, kind: r.kind, createdAt: r.createdAt, size: r.size,
        stored: !!r.stored, live: r.snapshot !== null,
      })),
    });
    if (!plan.dropBytes.length && !plan.dropNodes.length) return;
    for (const id of plan.dropBytes) {
      const r = this.find(id);
      if (!r) continue;
      delete r.stored;
      delete r.size;
      r.cache = undefined;
      if (r.snapshot === null) r.lost = true;
    }
    const gone = new Set(plan.dropNodes);
    this.records = this.records.filter((r) => !gone.has(r.id));
    const store = this.store!;
    const key = this.docKey!;
    const drop = [...new Set([...plan.dropBytes, ...plan.dropNodes])];
    this.fire(() => store.deleteBlobs(key, drop));
    this.emit({ kind: 'changed' });
  }

  private persistTree(): void {
    if (!this.persisting()) return;
    const store = this.store!;
    for (const r of this.records) r.inStore = true;
    const tree: StoredTree = {
      v: 1,
      docKey: this.docKey!,
      headId: this.headId,
      seq: this.seq,
      nodes: this.records.map((r): StoredNode => ({
        id: r.id,
        parentId: r.parentId,
        kind: r.kind,
        label: r.label,
        createdAt: r.createdAt,
        ...(r.threadId ? { threadId: r.threadId } : {}),
        ...(r.turnKey ? { turnKey: r.turnKey } : {}),
        ...(r.stored && r.size ? { size: r.size } : {}),
        ...(r.hash ? { hash: r.hash } : {}),
        ...(r.text ? { text: r.text } : {}),
      })),
      bytes: this.records.reduce((s, r) => s + (r.stored ? r.size ?? 0 : 0), 0),
      updatedAt: this.deps.now?.() ?? Date.now(),
    };
    this.fire(() => store.saveTree(tree));
  }

  /** 스냅샷이 없는 저장 지점의 바이트를 새것부터 조금 미리 읽어 둔다 */
  private prefetch(): void {
    if (!this.persisting()) return;
    const store = this.store!;
    const key = this.docKey!;
    let budget = PREFETCH_BYTES;
    const want = this.records
      .filter((r) => r.stored && r.snapshot === null && !r.cache)
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const r of want) {
      if ((r.size ?? 0) > budget) continue;
      budget -= r.size ?? 0;
      const id = r.id;
      this.fire(async () => {
        const bytes = await store.getBlob(key, id);
        const rec = this.find(id);
        if (bytes && rec && rec.snapshot === null && this.docKey === key) rec.cache = bytes;
      });
    }
  }

  private bytesOf(r: NodeRecord): Uint8Array | undefined {
    return r.cache ?? r.unsaved;
  }

  private canFetch(r: NodeRecord): boolean {
    return !!r.stored && this.persisting();
  }

  /** 저장소에서 바이트를 읽은 뒤 되돌아간다 */
  private checkoutLater(target: NodeRecord): CheckoutResult {
    const store = this.store!;
    const key = this.docKey!;
    const id = target.id;
    const instance = this.instance;
    type Outcome = { changed: boolean; savedManual: boolean; error?: string };
    const fail = (error: string): Outcome => ({ changed: false, savedManual: false, error });
    const pending = this.enqueue(() => store.getBlob(key, id)).then((bytes): Outcome | Promise<Outcome> => {
      if (this.disposed || instance !== this.instance || this.docKey !== key) return fail('문서가 바뀌어 되돌아가지 않았습니다.');
      const rec = this.find(id);
      if (!rec) return fail('그 지점을 찾지 못했습니다.');
      if (!bytes) {
        delete rec.stored;
        delete rec.size;
        if (rec.snapshot === null) rec.lost = true;
        this.persistTree();
        this.emit({ kind: 'changed' });
        return fail(this.lostError().message);
      }
      rec.cache = bytes;
      try {
        const r = this.checkout(id);
        if (r.pending) return r.pending;
        return { changed: r.changed, savedManual: r.savedManual };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      } finally {
        rec.cache = undefined;
      }
    }, (error: unknown): Outcome => fail(`저장된 지점을 읽지 못했습니다(${error instanceof Error ? error.message : String(error)}).`));
    void pending.then((r) => { if (r.error) console.warn('[doogle] 되돌아가지 못했습니다:', r.error); });
    return { changed: false, savedManual: false, pending };
  }

  /** 스냅샷(없거나 실패하면 저장 바이트)으로 문서를 되돌린다. 바이트를 읽어 와야 하면 'fetch' */
  private restoreInto(target: NodeRecord): 'done' | 'fetch' {
    if (target.snapshot !== null) {
      const snapshot = target.snapshot;
      try {
        this.deps.transaction('doogle:checkout', (doc) => {
          new Engine(doc).restoreSnapshot(snapshot);
        });
        return 'done';
      } catch (error) {
        target.snapshot = null;
        if (!this.bytesOf(target)) {
          if (this.canFetch(target)) return 'fetch';
          target.lost = true;
          this.emit({ kind: 'changed' });
          throw new DoogleToolError(
            'CHECKPOINT_LOST',
            `이 지점으로 되돌아가지 못했습니다(${error instanceof Error ? error.message : String(error)}). 실행 취소(Ctrl+Z)를 쓰세요.`,
          );
        }
      }
    }
    const bytes = this.bytesOf(target)!;
    let restored: number | null = null;
    try {
      this.deps.transaction('doogle:checkout', (doc) => {
        const engine = new Engine(doc);
        const sid = engine.importSnapshot(bytes);
        try {
          engine.restoreSnapshot(sid);
        } catch (error) {
          engine.discardSnapshot(sid);
          throw error;
        }
        restored = sid;
      });
    } catch (error) {
      if (error instanceof DoogleToolError && error.code === 'ENGINE_UNSUPPORTED') {
        throw new DoogleToolError('CHECKPOINT_LOST', '이 문서 엔진은 저장된 지점을 되살리지 못합니다(importSnapshot 없음). 앱을 업데이트하세요.');
      }
      // 바이트가 깨졌다 — 이 지점은 되돌아갈 수 없다
      target.cache = undefined;
      target.unsaved = undefined;
      delete target.stored;
      delete target.size;
      target.lost = true;
      this.persistTree();
      this.emit({ kind: 'changed' });
      throw new DoogleToolError(
        'CHECKPOINT_LOST',
        `저장된 지점을 되살리지 못했습니다(${error instanceof Error ? error.message : String(error)}). 실행 취소(Ctrl+Z)를 쓰세요.`,
      );
    }
    target.snapshot = restored;
    target.cache = undefined;
    delete target.lost;
    this.trim();
    return 'done';
  }

  private lostError(): DoogleToolError {
    return new DoogleToolError('CHECKPOINT_LOST', '이 지점은 너무 오래되어 되돌아갈 수 없습니다. 실행 취소(Ctrl+Z)를 쓰세요.');
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.io.then(job);
    this.io = run.then(() => undefined, (error) => { console.warn('[doogle] 문서 갈래 저장소 작업 실패', error); });
    return run;
  }

  private fire(job: () => Promise<unknown>): void {
    this.enqueue(job).catch(() => { /* enqueue 가 남겼다 */ });
  }

  // ─── 지점 만들기 ─────────────────────────────────────

  /** 뿌리가 없으면 만들고, head 뒤로 직접 고친 것이 있으면 "직접 고침" 지점으로 남긴다. 남겼으면 참 */
  private captureManual(): boolean {
    if (!this.headId) {
      if (!this.deps.getDocument()) return false;
      this.add('origin', '처음 상태', null, {});
      return false;
    }
    const head = this.find(this.headId);
    if (!head || this.hooks.revision() === head.revision) return false;
    return this.add('manual', '직접 고침', this.headId, {}) !== null;
  }

  private add(kind: CheckpointNode['kind'], label: string, parentId: string | null, extra: { threadId?: string; turnKey?: string }): NodeRecord | null {
    const doc = this.deps.getDocument();
    if (!doc) return null;
    let snapshot: number;
    try { snapshot = new Engine(doc).saveSnapshot(); } catch { return null; }
    const record: NodeRecord = {
      id: `cp${++this.seq}`,
      parentId,
      kind,
      label,
      createdAt: this.deps.now?.() ?? Date.now(),
      snapshot,
      revision: this.hooks.revision(),
      ...(extra.threadId ? { threadId: extra.threadId } : {}),
      ...(extra.turnKey ? { turnKey: extra.turnKey } : {}),
    };
    // 문서 키가 있으면 바이트로도 떠 둔다 — 앱을 다시 열어도 이 지점으로 돌아올 수 있게
    if (this.store && this.docKey) {
      try {
        const engine = new Engine(doc);
        const bytes = engine.exportHwp();
        if (bytes.length <= MAX_BLOB_BYTES) {
          record.size = bytes.length;
          record.hash = hashBytes(bytes);
          record.unsaved = bytes;
        }
        const text = textFingerprint(engine);
        if (text) record.text = text;
      } catch (error) {
        console.warn('[doogle] 지점 바이트를 뜨지 못했습니다(세션 한정으로 남깁니다)', error);
      }
    }
    this.records.push(record);
    this.headId = record.id;
    this.trim();
    this.flushUnsaved();
    this.prune();
    this.persistTree();
    this.emit({ kind: 'added', id: record.id });
    return record;
  }

  /** 스냅샷을 든 지점이 상한을 넘으면 가장 오래된 것(head·뿌리 제외)부터 스냅샷을 돌려준다 */
  private trim(): void {
    const live = this.records.filter((r) => r.snapshot !== null);
    let extra = live.length - MAX_LIVE;
    if (extra <= 0) return;
    const doc = this.deps.getDocument();
    for (const r of live) {
      if (extra <= 0) break;
      if (r.id === this.headId || r.kind === 'origin') continue;
      if (doc && r.snapshot !== null) new Engine(doc).discardSnapshot(r.snapshot);
      r.snapshot = null;
      // 저장한 바이트가 있으면 되돌아갈 수 있다
      if (!r.stored && !r.unsaved) r.lost = true;
      extra--;
    }
  }

  private find(id: string | null): NodeRecord | undefined {
    return id ? this.records.find((r) => r.id === id) : undefined;
  }

  private publicOf(r: NodeRecord): CheckpointNode {
    const node: CheckpointNode = { id: r.id, parentId: r.parentId, kind: r.kind, label: r.label, createdAt: r.createdAt };
    if (r.threadId) node.threadId = r.threadId;
    if (r.turnKey) node.turnKey = r.turnKey;
    if (r.lost) node.lost = true;
    if (r.stored) node.stored = true;
    return node;
  }

  dispose(): void {
    const doc = this.deps.getDocument();
    if (doc && this.deps.documentInstance?.() === this.instance) {
      for (const r of this.records) if (r.snapshot !== null) new Engine(doc).discardSnapshot(r.snapshot);
    }
    this.disposed = true;
    this.loadToken++;
    this.records = [];
    this.listeners.clear();
  }

  private emit(e: CheckpointEvent): void {
    for (const cb of [...this.listeners]) {
      try { cb(e); } catch (error) { console.error('[doogle] checkpoint listener failed', error); }
    }
  }
}

/** 같은 문서 상태로 보이는가 — 바이트 지문, 없으면 본문 글 지문 */
function sameState(a: NodeRecord, b: NodeRecord): boolean {
  if (a.hash && b.hash && a.hash === b.hash) return true;
  return !!a.text && a.text === b.text;
}

/** 본문 문단 글을 모두 이어 지문으로 (표 안 글은 빼고 — 문서가 같은지 가늠하는 데 쓴다) */
function textFingerprint(engine: Engine): string | null {
  try {
    const encoder = new TextEncoder();
    const parts: string[] = [];
    const sections = engine.sectionCount();
    for (let s = 0; s < sections; s++) {
      const n = engine.paragraphCount(s);
      parts.push(`§${n}`);
      for (let p = 0; p < n; p++) parts.push(engine.text(s, p));
    }
    return `t${hashBytes(encoder.encode(parts.join('\n')))}`;
  } catch {
    return null;
  }
}

/** 시험용 — 앱 전체 정리를 다시 돌게 한다 */
export function resetCheckpointSweepForTests(): void {
  swept = false;
}
