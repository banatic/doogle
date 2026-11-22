/**
 * 문서 갈래 저장소 — 지점(agent/checkpoints.ts)을 앱을 다시 열어도 남게 한다.
 *
 * 문서 키(경로, 경로가 없으면 `name:` + 이름 줄기)마다
 *  - 나무 한 벌(StoredTree): 지점 메타데이터(id·parent·kind·label·createdAt…)와 head·seq
 *  - 지점마다 문서 바이트 한 덩이(blob): 그 지점의 문서를 엔진 exportHwp() 로 뜬 HWP 바이트
 * 를 둔다. 바이트가 있으면 엔진 메모리 스냅샷을 잃어도(새로고침·문서 닫기·실행 취소 저장소 축출)
 * 그 지점으로 되돌아갈 수 있다(엔진 importSnapshot → restoreSnapshot).
 *
 * 저장 위치는 IndexedDB `doogle-checkpoints` 하나다. 브라우저는 그 사이트 저장소에, 데스크탑(Tauri,
 * WebView2)은 앱 데이터 폴더(%LOCALAPPDATA%\<앱 식별자>\EBWebView) 안에 남는다 — 따로 파일 명령을
 * 두지 않고 같은 코드로 두 곳을 덮는다.
 *
 * 용량 규칙(아래 상수):
 *  - 바이트 한 덩이가 MAX_BLOB_BYTES 를 넘는 지점은 저장하지 않는다(메모리 스냅샷만 — 세션 한정).
 *  - 문서마다 바이트를 든 지점은 MAX_STORED_PER_DOC 개·MAX_DOC_BYTES 까지. 넘으면 가장 오래된 것부터
 *    바이트를 버린다(뿌리 "처음 상태"·지금 지점은 남긴다). 메타데이터는 남아 나무 모양은 그대로다.
 *  - 문서마다 메타데이터 지점은 MAX_NODES_PER_DOC 개까지 — 넘으면 되돌아갈 수 없는 오래된 잎부터 지운다.
 *  - 앱 전체 바이트가 MAX_TOTAL_BYTES 를 넘거나 STALE_MS 동안 손대지 않은 문서의 갈래는 통째로 지운다
 *    (가장 오래 안 쓴 문서부터, 지금 문서는 빼고).
 */
import type { CheckpointNode } from './types.ts';

export const MAX_BLOB_BYTES = 32 * 1024 * 1024;
export const MAX_STORED_PER_DOC = 40;
export const MAX_DOC_BYTES = 160 * 1024 * 1024;
export const MAX_NODES_PER_DOC = 300;
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const STALE_MS = 90 * 24 * 60 * 60 * 1000;

/** 저장된 지점 하나 — size·hash 는 바이트를 저장했을 때만 */
export interface StoredNode extends Omit<CheckpointNode, 'lost' | 'stored'> {
  size?: number;
  hash?: string;
  /** 본문 글 지문 — 다시 연 HWPX 문서를 맞춰 볼 때 */
  text?: string;
}

export interface StoredTree {
  v: 1;
  docKey: string;
  headId: string | null;
  seq: number;
  nodes: StoredNode[];
  /** 저장된 바이트 합 */
  bytes: number;
  updatedAt: number;
}

export interface StoredTreeInfo {
  docKey: string;
  bytes: number;
  updatedAt: number;
}

export interface CheckpointStore {
  loadTree(docKey: string): Promise<StoredTree | null>;
  saveTree(tree: StoredTree): Promise<void>;
  putBlob(docKey: string, nodeId: string, bytes: Uint8Array): Promise<void>;
  getBlob(docKey: string, nodeId: string): Promise<Uint8Array | null>;
  deleteBlobs(docKey: string, nodeIds: readonly string[]): Promise<void>;
  /** 나무와 그 바이트를 모두 지운다 */
  deleteTree(docKey: string): Promise<void>;
  listTrees(): Promise<StoredTreeInfo[]>;
}

/** 바이트 지문(FNV-1a 32비트 두 벌 + 길이) — 다시 연 문서가 어느 지점과 같은지 맞춰 본다 */
export function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[bytes.length - 1 - i], 0x01000193);
  }
  return `${bytes.length.toString(36)}-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

/**
 * 문서 키 — 경로를 알면 경로(Windows 경로는 역슬래시·소문자로), 아니면 `name:` + 이름 줄기.
 * 저장 안 한 새 문서는 null(세션 한정). 사이드바 대화의 문서 식별(index.ts getDoc)과 같은 규칙이다.
 *
 * byName=false(데스크탑)면 경로가 없을 때 null — 데스크탑은 디스크의 파일이면 경로를 안다. 경로가 늦게
 * 알려질 때 이름 키 → 경로 키로 바뀌며 경로 쪽 기록을 놓치지 않게 한다. 브라우저는 경로가 없어 이름 키를 쓴다.
 */
export function checkpointDocKey(path: string | null | undefined, fileName: string | null | undefined, isNew: boolean, byName = true): string | null {
  if (path) return /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path;
  if (isNew || !fileName || !byName) return null;
  let stem = fileName.trim().toLowerCase().replace(/\.(hwpx|hwp|hml)$/i, '');
  while (/\s*복구본$/.test(stem)) stem = stem.replace(/\s*복구본$/, '');
  stem = stem.trim();
  if (!stem || /^새 문서$/.test(stem)) return null;
  return `name:${stem}`;
}

// ─── 정리 규칙 (순수 함수 — 시험한다) ─────────────────────

export interface PruneInput {
  nodes: ReadonlyArray<{ id: string; parentId: string | null; kind: CheckpointNode['kind']; createdAt: number; size?: number; stored: boolean; live: boolean }>;
  headId: string | null;
}

/**
 * 바이트를 버릴 지점과 메타데이터째 지울 지점을 고른다.
 *  - dropBytes: 저장 바이트 상한(개수·합)을 넘는 만큼 오래된 것부터(뿌리·head 제외)
 *  - dropNodes: 메타데이터 상한을 넘는 만큼, 되돌아갈 수 없게 될(바이트도 스냅샷도 없는) 오래된 잎부터
 */
export function planPrune(input: PruneInput, limits = { maxStored: MAX_STORED_PER_DOC, maxBytes: MAX_DOC_BYTES, maxNodes: MAX_NODES_PER_DOC }): { dropBytes: string[]; dropNodes: string[] } {
  const byAge = [...input.nodes].sort((x, y) => x.createdAt - y.createdAt);
  const stored = byAge.filter((n) => n.stored);
  let count = stored.length;
  let bytes = stored.reduce((s, n) => s + (n.size ?? 0), 0);
  const dropBytes: string[] = [];
  for (const n of stored) {
    if (count <= limits.maxStored && bytes <= limits.maxBytes) break;
    if (n.id === input.headId || n.kind === 'origin') continue;
    dropBytes.push(n.id);
    count--;
    bytes -= n.size ?? 0;
  }
  const dropNodes: string[] = [];
  let total = input.nodes.length;
  if (total > limits.maxNodes) {
    const dropped = new Set(dropBytes);
    const children = new Map<string, number>();
    for (const n of input.nodes) if (n.parentId) children.set(n.parentId, (children.get(n.parentId) ?? 0) + 1);
    // 잎을 지우면 부모가 잎이 될 수 있다 — 상한에 닿을 때까지 몇 번 돈다
    for (let pass = 0; pass < 8 && total > limits.maxNodes; pass++) {
      for (const n of byAge) {
        if (total <= limits.maxNodes) break;
        if (dropNodes.includes(n.id) || n.id === input.headId || n.kind === 'origin') continue;
        if ((children.get(n.id) ?? 0) > 0) continue;
        const reachable = n.live || (n.stored && !dropped.has(n.id));
        if (reachable) continue;
        dropNodes.push(n.id);
        total--;
        if (n.parentId) children.set(n.parentId, (children.get(n.parentId) ?? 1) - 1);
      }
    }
  }
  return { dropBytes, dropNodes };
}

/** 앱 전체 정리 — 오래 안 쓴 문서와 총량을 넘긴 몫을 지운다. 지운 문서 키들. */
export async function sweepStore(store: CheckpointStore, keep: string | null, now = Date.now()): Promise<string[]> {
  const trees = (await store.listTrees()).sort((a, b) => a.updatedAt - b.updatedAt);
  let total = trees.reduce((s, t) => s + t.bytes, 0);
  const removed: string[] = [];
  for (const t of trees) {
    if (t.docKey === keep) continue;
    const stale = now - t.updatedAt > STALE_MS;
    if (!stale && total <= MAX_TOTAL_BYTES) continue;
    await store.deleteTree(t.docKey);
    removed.push(t.docKey);
    total -= t.bytes;
  }
  return removed;
}

// ─── 메모리 저장소 (시험·IndexedDB 가 없는 환경) ─────────────

export class MemoryCheckpointStore implements CheckpointStore {
  readonly trees = new Map<string, StoredTree>();
  readonly blobs = new Map<string, Uint8Array>();

  private static k(docKey: string, nodeId: string): string { return `${docKey}\u0000${nodeId}`; }

  async loadTree(docKey: string): Promise<StoredTree | null> {
    const t = this.trees.get(docKey);
    return t ? structuredClone(t) : null;
  }
  async saveTree(tree: StoredTree): Promise<void> { this.trees.set(tree.docKey, structuredClone(tree)); }
  async putBlob(docKey: string, nodeId: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(MemoryCheckpointStore.k(docKey, nodeId), bytes.slice());
  }
  async getBlob(docKey: string, nodeId: string): Promise<Uint8Array | null> {
    return this.blobs.get(MemoryCheckpointStore.k(docKey, nodeId))?.slice() ?? null;
  }
  async deleteBlobs(docKey: string, nodeIds: readonly string[]): Promise<void> {
    for (const id of nodeIds) this.blobs.delete(MemoryCheckpointStore.k(docKey, id));
  }
  async deleteTree(docKey: string): Promise<void> {
    this.trees.delete(docKey);
    for (const k of [...this.blobs.keys()]) if (k.startsWith(`${docKey}\u0000`)) this.blobs.delete(k);
  }
  async listTrees(): Promise<StoredTreeInfo[]> {
    return [...this.trees.values()].map((t) => ({ docKey: t.docKey, bytes: t.bytes, updatedAt: t.updatedAt }));
  }
}

// ─── IndexedDB 저장소 ────────────────────────────────────

const DB_NAME = 'doogle-checkpoints';
const DB_VERSION = 1;
const TREES = 'trees';
const BLOBS = 'blobs';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IndexedDbCheckpointStore implements CheckpointStore {
  private db: Promise<IDBDatabase> | null = null;
  private readonly factory: IDBFactory;

  constructor(factory: IDBFactory) {
    this.factory = factory;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const r = this.factory.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(TREES)) db.createObjectStore(TREES, { keyPath: 'docKey' });
          // 키 = [docKey, nodeId] — 한 문서의 바이트를 범위로 지운다
          if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      this.db.catch(() => { this.db = null; });
    }
    return this.db;
  }

  async loadTree(docKey: string): Promise<StoredTree | null> {
    const db = await this.open();
    const tree = await req(db.transaction(TREES).objectStore(TREES).get(docKey)) as StoredTree | undefined;
    return tree && tree.v === 1 ? tree : null;
  }

  async saveTree(tree: StoredTree): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(TREES, 'readwrite');
    tx.objectStore(TREES).put(tree);
    await done(tx);
  }

  async putBlob(docKey: string, nodeId: string, bytes: Uint8Array): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(BLOBS, 'readwrite');
    tx.objectStore(BLOBS).put(bytes, [docKey, nodeId]);
    await done(tx);
  }

  async getBlob(docKey: string, nodeId: string): Promise<Uint8Array | null> {
    const db = await this.open();
    const v = await req(db.transaction(BLOBS).objectStore(BLOBS).get([docKey, nodeId])) as unknown;
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  }

  async deleteBlobs(docKey: string, nodeIds: readonly string[]): Promise<void> {
    if (!nodeIds.length) return;
    const db = await this.open();
    const tx = db.transaction(BLOBS, 'readwrite');
    const s = tx.objectStore(BLOBS);
    for (const id of nodeIds) s.delete([docKey, id]);
    await done(tx);
  }

  async deleteTree(docKey: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([TREES, BLOBS], 'readwrite');
    tx.objectStore(TREES).delete(docKey);
    tx.objectStore(BLOBS).delete(IDBKeyRange.bound([docKey, ''], [docKey, '￿']));
    await done(tx);
  }

  async listTrees(): Promise<StoredTreeInfo[]> {
    const db = await this.open();
    const all = await req(db.transaction(TREES).objectStore(TREES).getAll()) as StoredTree[];
    return all.map((t) => ({ docKey: t.docKey, bytes: t.bytes ?? 0, updatedAt: t.updatedAt ?? 0 }));
  }
}

let shared: CheckpointStore | null | undefined;

/** 앱에 하나 — IndexedDB 가 없으면 null(지점은 세션 한정) */
export function defaultCheckpointStore(): CheckpointStore | null {
  if (shared !== undefined) return shared;
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  shared = factory ? new IndexedDbCheckpointStore(factory) : null;
  return shared;
}
