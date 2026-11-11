// 대화 스레드 저장소: 메모리 + JSON 파일(앱 데이터 디렉터리/threads/<id>.json).
// 히스토리는 provider별로 따로 둔다(형식이 provider마다 다르기 때문).
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{
 *   id: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   lastProviderId: string|null,
 *   histories: Record<string, any[]>,
 *   pendingReviews: Array<{decision:string, note?:string, at:string}>,
 *   title?: string,
 *   transcript?: any[],
 *   doc?: {key: string, name: string}|null,
 *   attachments?: Array<{id:string, name:string, kind:string, mime:string, size:number, chars:number, images:number, addedAt:string}>,
 * }} Thread
 *
 * transcript: 화면 복원용 기록 — {kind:'user', text, providerId, at} 와 화면에 보낸 agent_event 들.
 * 응답 도중에도 저장한다(hub.mjs scheduleSave) — 새로고침·허브 재시작 뒤에도 대화가 남는다.
 *
 * @typedef {{id:string, title:string, createdAt:string, updatedAt:string, turns:number, events:number, doc:any}} ThreadSummary
 *   목록에 쓰는 요약. events = 화면 기록 줄 수(0 이면 화면에 다시 보일 것이 없는 대화).
 * @typedef {{file:string, mtimeMs:number, size:number, summary:ThreadSummary|null, noBackfill?:boolean}} IndexEntry
 *   파일 하나의 색인 줄. summary 가 null 이면 읽을 수 없는 파일. noBackfill: 화면 기록을 만들어 보았으나 못 만든 옛 대화.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * 목록 색인 파일. 대화 파일(`*.json`)과 겹치지 않게 다른 확장자를 쓴다(대화 id 가 "index" 여도 안전).
 * 색인은 캐시일 뿐이다 — 파일의 수정 시각·크기가 색인과 다르면 그 파일만 다시 읽는다.
 */
const INDEX_FILE = 'threads.index';
const INDEX_VERSION = 1;
const INDEX_SAVE_DELAY_MS = 400;

/** 보관하는 대화 수의 기본 한도 — 넘치면 오래 쓰지 않은 것부터 지운다 (prune) */
export const DEFAULT_MAX_THREADS = 500;

/** 대화 id → 파일 이름 줄기 (확장자 없음). 대화에 딸린 폴더(`<줄기>.files` — 첨부 내용)도 이 이름을 쓴다 */
export function threadFileStem(id) {
  return SAFE_ID.test(id) ? id : `h-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

function fileNameFor(id) {
  return `${threadFileStem(id)}.json`;
}

/** @param {Thread} t @returns {ThreadSummary} */
function summaryOf(t) {
  const tr = Array.isArray(t.transcript) ? t.transcript : [];
  return {
    id: t.id,
    title: typeof t.title === 'string' ? t.title : '',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    turns: tr.filter((e) => e?.kind === 'user').length,
    events: tr.length,
    doc: t.doc ?? null,
  };
}

export class ThreadStore {
  /**
   * @param {{dir?: string|null, backfill?: ((t: Thread) => Promise<any>)|null, maxThreads?: number}} [opts]
   *   dir가 null이면 메모리 전용. backfill: 화면 기록이 없는 옛 대화의 기록을 다른 곳(SDK 세션)에서 만든다.
   *   maxThreads: 보관할 대화 수 한도 (0 이면 한도 없음).
   */
  constructor({ dir = null, backfill = null, maxThreads = DEFAULT_MAX_THREADS } = {}) {
    this.dir = dir;
    this.backfill = backfill;
    this.maxThreads = Number.isFinite(maxThreads) && maxThreads > 0 ? Math.floor(maxThreads) : 0;
    /** backfill 을 이미 해 본 대화 id (없으면 매번 파일을 읽지 않게) */
    this.backfillTried = new Set();
    /** @type {Map<string, Thread>} */
    this.threads = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.writes = new Map();
    /** 지운 대화 id — 뒤늦게 온 저장이 파일을 되살리지 않게 한다 */
    this.deleted = new Set();
    /** 파일 이름 → 색인 줄 @type {Map<string, IndexEntry>} */
    this.index = new Map();
    /** @type {Promise<void>|null} */
    this.indexLoaded = null;
    /** @type {Promise<void>} */
    this.syncing = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.indexTimer = null;
    this.indexDirty = false;
    /** @type {Promise<void>} */
    this.indexWrite = Promise.resolve();
    /** 폴더를 끝까지 훑어 색인이 폴더와 맞는 적이 있는가 */
    this.synced = false;
    /** 시험·진단용: 대화 파일을 통째로 읽은 횟수 */
    this.fileReads = 0;
  }

  /** @param {string} id @returns {Thread} */
  #fresh(id) {
    const now = new Date().toISOString();
    return { id, title: '', createdAt: now, updatedAt: now, lastProviderId: null, histories: {}, pendingReviews: [], transcript: [] };
  }

  /** 파일에서 읽은 값을 대화 모양으로 */
  #hydrate(id, raw) {
    return {
      ...this.#fresh(id), ...raw,
      histories: raw.histories ?? {}, pendingReviews: raw.pendingReviews ?? [], transcript: Array.isArray(raw.transcript) ? raw.transcript : [],
    };
  }

  /** @param {string} id @returns {Promise<Thread>} */
  async get(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('invalid threadId');
    let t = this.threads.get(id);
    if (t) return t;
    if (this.dir && !this.deleted.has(id)) {
      try {
        this.fileReads++;
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, fileNameFor(id)), 'utf8'));
        if (raw && raw.id === id) t = this.#hydrate(id, raw);
      } catch (err) {
        if (err?.code !== 'ENOENT') process.emitWarning(`thread ${id} 로드 실패: ${err?.message}`);
      }
    }
    if (t) {
      // 디스크에서 처음 올린 대화다 — 목록 만들 때 해 본 시도와 상관없이 채운다
      this.backfillTried.delete(id);
      await this.#ensureTranscript(t);
    }
    // 동시 get 경쟁: 먼저 들어간 것을 유지
    const existing = this.threads.get(id);
    if (existing) return existing;
    t ??= this.#fresh(id);
    this.threads.set(id, t);
    return t;
  }

  /** 화면 기록이 없는 옛 대화면 backfill 로 채운다 (대화당 한 번만 시도). 채웠으면 true */
  async #ensureTranscript(t) {
    if (!this.backfill || (Array.isArray(t.transcript) && t.transcript.length > 0) || this.backfillTried.has(t.id)) return false;
    this.backfillTried.add(t.id);
    let got = null;
    try { got = await this.backfill(t); } catch { got = null; }
    // backfill 은 기록 배열 또는 {transcript, doc} 을 준다 (doc: 그 대화의 문서 — 옛 대화는 이름만)
    const tr = Array.isArray(got) ? got : got?.transcript;
    if (!Array.isArray(tr) || tr.length === 0) return false;
    t.transcript = tr;
    if (!t.doc && got && !Array.isArray(got) && got.doc) t.doc = got.doc;
    if (!t.title) {
      const first = tr.find((e) => e?.kind === 'user');
      if (first) t.title = String(first.text).replace(/\s+/g, ' ').trim().slice(0, 40);
    }
    return true;
  }

  /**
   * @param {Thread} t
   * @param {{touch?: boolean}} [o] touch=false 면 updatedAt 을 그대로 둔다 (옛 대화의 기록만 채워 넣을 때 — 순서가 바뀌지 않게)
   */
  save(t, { touch = true } = {}) {
    if (this.deleted.has(t.id)) return Promise.resolve();
    if (touch) t.updatedAt = new Date().toISOString();
    if (!this.dir) return Promise.resolve();
    const prev = this.writes.get(t.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleted.has(t.id)) return;
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.#loadIndex();
      const name = fileNameFor(t.id);
      const target = path.join(this.dir, name);
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const summary = summaryOf(t);
      await fs.writeFile(tmp, JSON.stringify(t), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, target);
      const st = await fs.stat(target);
      this.index.set(name, { file: name, mtimeMs: st.mtimeMs, size: st.size, summary });
      this.#touchIndex();
    }).catch((err) => {
      process.emitWarning(`thread ${t.id} 저장 실패: ${err?.message}`);
    }).finally(() => {
      if (this.writes.get(t.id) === next) this.writes.delete(t.id);
    });
    this.writes.set(t.id, next);
    return next;
  }

  /** 대기 중인 저장 완료 (색인 포함) */
  async flush() {
    await Promise.all([...this.writes.values()]);
    await this.syncing.catch(() => {});
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    await this.#writeIndex();
  }

  /**
   * 대화를 지운다 — 메모리와 파일 모두. 진행 중인 응답이 있는지는 부르는 쪽(hub)이 본다.
   * 지운 id 로 뒤늦게 오는 저장은 버린다. 파일이 있었으면 true.
   * @param {string} id
   */
  async delete(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('invalid threadId');
    this.deleted.add(id);
    const had = this.threads.delete(id);
    this.backfillTried.delete(id);
    await (this.writes.get(id) ?? Promise.resolve());
    if (!this.dir) return had;
    const name = fileNameFor(id);
    let removed = false;
    try {
      await fs.unlink(path.join(this.dir, name));
      removed = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    // 대화에 딸린 폴더(첨부한 참고 파일의 내용)도 함께 지운다
    await fs.rm(path.join(this.dir, `${threadFileStem(id)}.files`), { recursive: true, force: true }).catch(() => {});
    await this.#loadIndex();
    if (this.index.delete(name)) this.#touchIndex();
    return removed || had;
  }

  /**
   * 보관 한도(maxThreads)를 넘으면 오래 쓰지 않은 대화부터 지운다. 이번 실행에서 연 대화와
   * keep(id) 가 참인 대화(응답 중 등)는 남긴다. 읽을 수 없는 파일은 건드리지 않는다.
   * @param {(id: string) => boolean} [keep]
   * @returns {Promise<string[]>} 지운 대화 id
   */
  async prune(keep = () => false) {
    if (!this.dir || !this.maxThreads) return [];
    await this.#loadIndex();
    // 색인이 폴더와 맞춰진 뒤에는 수만 보고 넘어간다 (저장·삭제가 색인을 따라 고친다)
    if (this.synced && this.index.size <= this.maxThreads) return [];
    await this.#sync();
    const all = [...this.index.values()].filter((e) => e.summary).map((e) => e.summary);
    if (all.length <= this.maxThreads) return [];
    all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const gone = [];
    for (const s of all.slice(this.maxThreads)) {
      if (this.threads.has(s.id) || keep(s.id)) continue;
      try {
        await this.delete(s.id);
        gone.push(s.id);
      } catch (err) {
        process.emitWarning(`thread ${s.id} 정리 실패: ${err?.message}`);
      }
    }
    return gone;
  }

  // ── 목록 색인 ─────────────────────────────────────────────

  /** 색인 파일을 한 번 읽는다 (없거나 깨졌으면 빈 색인 — 파일에서 다시 만든다) */
  #loadIndex() {
    this.indexLoaded ??= (async () => {
      if (!this.dir) return;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, INDEX_FILE), 'utf8'));
        if (raw?.version !== INDEX_VERSION || !Array.isArray(raw.entries)) return;
        for (const e of raw.entries) {
          if (!e || typeof e.file !== 'string' || !e.file.endsWith('.json') || this.index.has(e.file)) continue;
          if (!Number.isFinite(e.mtimeMs) || !Number.isFinite(e.size)) continue;
          const s = e.summary && typeof e.summary.id === 'string' ? e.summary : null;
          this.index.set(e.file, { file: e.file, mtimeMs: e.mtimeMs, size: e.size, summary: s, ...(e.noBackfill ? { noBackfill: true } : {}) });
        }
      } catch { /* 없음·깨짐 */ }
    })();
    return this.indexLoaded;
  }

  #touchIndex() {
    this.indexDirty = true;
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.#writeIndex();
    }, INDEX_SAVE_DELAY_MS);
    this.indexTimer.unref?.();
  }

  #writeIndex() {
    if (!this.dir || !this.indexDirty) return this.indexWrite;
    this.indexDirty = false;
    this.indexWrite = this.indexWrite.then(async () => {
      const target = path.join(this.dir, INDEX_FILE);
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, entries: [...this.index.values()] }), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, target);
    }).catch((err) => {
      process.emitWarning(`대화 색인 저장 실패: ${err?.message}`);
    });
    return this.indexWrite;
  }

  /**
   * 색인을 폴더와 맞춘다 — 파일마다 수정 시각·크기만 보고(stat), 색인과 다른 파일만 읽는다.
   * 대화가 많아도 목록을 열 때 모든 파일을 통째로 읽지 않는다.
   */
  #sync() {
    const run = async () => {
      if (!this.dir) return;
      await this.#loadIndex();
      let names;
      try {
        names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json'));
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          process.emitWarning(`대화 목록 읽기 실패: ${err?.message}`);
          return;
        }
        names = [];
      }
      const seen = new Set(names);
      for (const file of [...this.index.keys()]) {
        if (!seen.has(file)) {
          this.index.delete(file);
          this.#touchIndex();
        }
      }
      await Promise.all(names.map(async (name) => {
        let st;
        try { st = await fs.stat(path.join(this.dir, name)); } catch { return; }
        const have = this.index.get(name);
        if (have && have.mtimeMs === st.mtimeMs && have.size === st.size) return;
        let summary = null;
        try {
          this.fileReads++;
          const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8'));
          if (raw && typeof raw.id === 'string' && fileNameFor(raw.id) === name) summary = summaryOf(this.#hydrate(raw.id, raw));
        } catch { /* 깨진 파일은 요약 없이 적어 둔다 — 바뀌기 전에는 다시 읽지 않는다 */ }
        // 읽는 사이 저장이 끝나 더 새 줄이 들어왔으면 그대로 둔다
        const now = this.index.get(name);
        if (now && now !== have) return;
        this.index.set(name, { file: name, mtimeMs: st.mtimeMs, size: st.size, summary });
        this.#touchIndex();
      }));
      this.synced = true;
    };
    this.syncing = this.syncing.then(run, run);
    return this.syncing;
  }

  /**
   * 화면 기록이 없는 옛 대화의 기록을 만들어 파일에 적어 둔다 — 한 번 만들면 다음부터는 색인만 본다.
   * 만들지 못한 대화는 색인에 표시해 다시 시도하지 않는다(파일이 바뀌면 표시도 사라진다).
   */
  async #backfillIndexed() {
    if (!this.backfill) return;
    for (const e of [...this.index.values()]) {
      const s = e.summary;
      if (!s || s.events > 0 || e.noBackfill || this.threads.has(s.id) || this.deleted.has(s.id)) continue;
      let t = null;
      try {
        this.fileReads++;
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, e.file), 'utf8'));
        if (raw && raw.id === s.id) t = this.#hydrate(s.id, raw);
      } catch { /* 그새 지워졌거나 깨짐 */ }
      if (!t) continue;
      this.backfillTried.delete(t.id);
      if (await this.#ensureTranscript(t)) {
        await this.save(t, { touch: false });
      } else if (this.index.get(e.file) === e) {
        e.noBackfill = true;
        this.#touchIndex();
      }
    }
  }

  /**
   * 화면에 다시 보일 수 있는 대화 목록 (최근 것부터). transcript 가 없는 옛 대화는 뺀다.
   * doc 을 주면 그 문서의 대화만 (대화는 문서에 딸린다 — docMatches).
   * @param {number} [limit]
   * @param {{key?: string, name?: string}|null} [doc]
   * @returns {Promise<Array<{id:string,title:string,createdAt:string,updatedAt:string,turns:number,doc:any}>>}
   */
  async list(limit = 50, doc = null) {
    /** @type {Map<string, ThreadSummary>} */
    const found = new Map();
    if (this.dir) {
      await this.#sync();
      await this.#backfillIndexed();
      for (const e of this.index.values()) if (e.summary) found.set(e.summary.id, e.summary);
    }
    // 메모리에 올라온 대화가 파일보다 새것이다 (저장을 기다리는 글이 있을 수 있다)
    for (const [id, t] of this.threads) {
      await this.#ensureTranscript(t);
      found.set(id, summaryOf(t));
    }
    for (const id of this.deleted) found.delete(id);
    return [...found.values()]
      .filter((s) => s.events > 0)
      .filter((s) => !doc || docMatches(s.doc, doc))
      .map((s) => ({
        id: s.id,
        title: s.title || '대화',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        turns: s.turns,
        doc: s.doc ?? null,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }
}

/**
 * 대화가 이 문서의 것인가. key 는 정규화한 전체 경로(데스크탑), name 은 파일 이름.
 * 둘 다 경로를 알면 경로로, 한쪽이라도 경로를 모르면(브라우저·옛 대화) 파일 이름으로 맞춘다.
 * @param {{key?: string, name?: string}|null|undefined} threadDoc
 * @param {{key?: string, name?: string}} doc
 */
export function docMatches(threadDoc, doc) {
  if (!threadDoc || !doc) return false;
  const tk = String(threadDoc.key ?? '');
  const dk = String(doc.key ?? '');
  if (tk && dk) return tk === dk;
  const tn = docStem(threadDoc.name);
  return !!tn && tn === docStem(doc.name);
}

/**
 * 이름으로 맞출 때의 문서 줄기 — 확장자(.hwp/.hwpx/.hml)와 끝의 " 복구본" 을 뗀다.
 * 자동 저장에서 복구한 문서는 "X 복구본.hwp"(경로 없음)로 열리므로 원래 "X.hwpx" 의 대화와 이어져야 한다.
 * (rhwp-studio hub-client.ts docStem 과 같은 규칙)
 */
export function docStem(name) {
  let s = String(name ?? '').trim().toLowerCase().replace(/\.(hwpx|hwp|hml)$/i, '');
  while (/\s*복구본$/.test(s)) s = s.replace(/\s*복구본$/, '');
  return s.trim();
}

/** 문서 식별자를 받아 쓸 모양으로 (이상한 값은 버린다) */
export function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const key = typeof doc.key === 'string' ? doc.key.slice(0, 1000) : '';
  const name = typeof doc.name === 'string' ? doc.name.slice(0, 300) : '';
  return key || name ? { key, name } : null;
}

/** transcript 에 남길 때 긴 문자열(이미지 base64 등)은 자른다 — 화면 복원에는 앞부분이면 된다 */
export function compactForTranscript(value, depth = 0) {
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => compactForTranscript(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = compactForTranscript(v, depth + 1);
  return out;
}

/**
 * 화면 사건 하나를 대화 기록(transcript)에 더한다. 글 조각(text_delta)은 앞 조각에 이어 붙이고,
 * 진행 문구(status)·토큰(usage)은 남기지 않는다. 기록했으면 true.
 * @param {Thread & {transcript?: any[]}} thread
 * @param {any} event
 */
export function recordTranscript(thread, event) {
  if (!event || typeof event !== 'object' || event.kind === 'status' || event.kind === 'usage') return false;
  const tr = (thread.transcript ??= []);
  if (event.kind === 'text_delta') {
    const last = tr[tr.length - 1];
    if (last?.kind === 'text_delta') last.text += String(event.text ?? '');
    else tr.push({ kind: 'text_delta', text: String(event.text ?? '') });
  } else if (event.kind === 'turn_end') {
    // 걸린 시간을 다시 보이려고 끝난 시각을 남긴다
    tr.push({ ...compactForTranscript(event), at: new Date().toISOString() });
  } else {
    tr.push(compactForTranscript(event));
  }
  if (tr.length > TRANSCRIPT_MAX) tr.splice(0, tr.length - TRANSCRIPT_MAX);
  return true;
}

const TRANSCRIPT_MAX = 4000;

/**
 * 마지막 요청이 turn_end 없이 끝난 기록(허브가 죽었거나 화면이 사라짐)을 "중단됨" 으로 닫는다.
 * 고쳤으면 true.
 */
export function closeDanglingTurn(thread) {
  const tr = thread.transcript;
  if (!Array.isArray(tr) || tr.length === 0) return false;
  for (let i = tr.length - 1; i >= 0; i--) {
    if (tr[i]?.kind === 'turn_end') return false;
    if (tr[i]?.kind === 'user') {
      tr.push({ kind: 'turn_end', reason: 'interrupted' });
      return true;
    }
  }
  return false;
}
