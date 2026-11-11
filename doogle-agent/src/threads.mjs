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
 * }} Thread
 *
 * transcript: 화면 복원용 기록 — {kind:'user', text, providerId, at} 와 화면에 보낸 agent_event 들.
 * 응답 도중에도 저장한다(hub.mjs scheduleSave) — 새로고침·허브 재시작 뒤에도 대화가 남는다.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function fileNameFor(id) {
  return SAFE_ID.test(id) ? `${id}.json` : `h-${createHash('sha256').update(id).digest('hex').slice(0, 40)}.json`;
}

export class ThreadStore {
  /**
   * @param {{dir?: string|null, backfill?: ((t: Thread) => Promise<any[]|null>)|null}} [opts]
   *   dir가 null이면 메모리 전용. backfill: 화면 기록이 없는 옛 대화의 기록을 다른 곳(SDK 세션)에서 만든다.
   */
  constructor({ dir = null, backfill = null } = {}) {
    this.dir = dir;
    this.backfill = backfill;
    /** backfill 을 이미 해 본 대화 id (없으면 매번 파일을 읽지 않게) */
    this.backfillTried = new Set();
    /** @type {Map<string, Thread>} */
    this.threads = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.writes = new Map();
  }

  /** @param {string} id @returns {Thread} */
  #fresh(id) {
    const now = new Date().toISOString();
    return { id, title: '', createdAt: now, updatedAt: now, lastProviderId: null, histories: {}, pendingReviews: [], transcript: [] };
  }

  /** @param {string} id @returns {Promise<Thread>} */
  async get(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('invalid threadId');
    let t = this.threads.get(id);
    if (t) return t;
    if (this.dir) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dir, fileNameFor(id)), 'utf8'));
        if (raw && raw.id === id) {
          t = {
            ...this.#fresh(id), ...raw,
            histories: raw.histories ?? {}, pendingReviews: raw.pendingReviews ?? [], transcript: Array.isArray(raw.transcript) ? raw.transcript : [],
          };
        }
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

  /** 화면 기록이 없는 옛 대화면 backfill 로 채운다 (대화당 한 번만 시도) */
  async #ensureTranscript(t) {
    if (!this.backfill || (Array.isArray(t.transcript) && t.transcript.length > 0) || this.backfillTried.has(t.id)) return;
    this.backfillTried.add(t.id);
    let got = null;
    try { got = await this.backfill(t); } catch { got = null; }
    // backfill 은 기록 배열 또는 {transcript, doc} 을 준다 (doc: 그 대화의 문서 — 옛 대화는 이름만)
    const tr = Array.isArray(got) ? got : got?.transcript;
    if (!Array.isArray(tr) || tr.length === 0) return;
    t.transcript = tr;
    if (!t.doc && got && !Array.isArray(got) && got.doc) t.doc = got.doc;
    if (!t.title) {
      const first = tr.find((e) => e?.kind === 'user');
      if (first) t.title = String(first.text).replace(/\s+/g, ' ').trim().slice(0, 40);
    }
  }

  /** @param {Thread} t */
  save(t) {
    t.updatedAt = new Date().toISOString();
    if (!this.dir) return Promise.resolve();
    const prev = this.writes.get(t.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const target = path.join(this.dir, fileNameFor(t.id));
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(t), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, target);
    }).catch((err) => {
      process.emitWarning(`thread ${t.id} 저장 실패: ${err?.message}`);
    });
    this.writes.set(t.id, next);
    return next;
  }

  /** 대기 중인 저장 완료 */
  async flush() {
    await Promise.all([...this.writes.values()]);
  }

  /**
   * 화면에 다시 보일 수 있는 대화 목록 (최근 것부터). transcript 가 없는 옛 대화는 뺀다.
   * doc 을 주면 그 문서의 대화만 (대화는 문서에 딸린다 — docMatches).
   * @param {number} [limit]
   * @param {{key?: string, name?: string}|null} [doc]
   * @returns {Promise<Array<{id:string,title:string,createdAt:string,updatedAt:string,turns:number,doc:any}>>}
   */
  async list(limit = 50, doc = null) {
    /** @type {Map<string, Thread>} */
    const found = new Map(this.threads);
    if (this.dir) {
      let names = [];
      try {
        names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json'));
      } catch (err) {
        if (err?.code !== 'ENOENT') process.emitWarning(`대화 목록 읽기 실패: ${err?.message}`);
      }
      const stats = await Promise.all(names.map(async (name) => {
        try { return { name, mtime: (await fs.stat(path.join(this.dir, name))).mtimeMs }; } catch { return null; }
      }));
      // 문서로 거를 때는 그 문서의 옛 대화를 놓치지 않게 모두 본다
      const sorted = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
      const recent = doc ? sorted : sorted.slice(0, limit * 2);
      for (const { name } of recent) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8'));
          if (raw && typeof raw.id === 'string' && !found.has(raw.id)) found.set(raw.id, raw);
        } catch { /* 깨진 파일은 건너뛴다 */ }
      }
    }
    // 옛 대화(화면 기록 없음)는 목록에 올리려고 기록을 만들어 본다. 메모리에 둔 것은 그대로 채워진다
    for (const [id, t] of found) {
      const cached = this.threads.get(id);
      if (cached) { await this.#ensureTranscript(cached); found.set(id, cached); continue; }
      if (Array.isArray(t.transcript) && t.transcript.length > 0) continue;
      this.backfillTried.delete(id);
      await this.#ensureTranscript(t);
    }
    return [...found.values()]
      .filter((t) => Array.isArray(t.transcript) && t.transcript.length > 0)
      .filter((t) => !doc || docMatches(t.doc, doc))
      .map((t) => ({
        id: t.id,
        title: typeof t.title === 'string' && t.title ? t.title : '대화',
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        turns: t.transcript.filter((e) => e?.kind === 'user').length,
        doc: t.doc ?? null,
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
