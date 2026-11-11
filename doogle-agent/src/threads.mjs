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
  /** @param {{dir?: string|null}} [opts] dir가 null이면 메모리 전용 */
  constructor({ dir = null } = {}) {
    this.dir = dir;
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
    // 동시 get 경쟁: 먼저 들어간 것을 유지
    const existing = this.threads.get(id);
    if (existing) return existing;
    t ??= this.#fresh(id);
    this.threads.set(id, t);
    return t;
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
   * @param {number} [limit]
   * @returns {Promise<Array<{id:string,title:string,createdAt:string,updatedAt:string,turns:number}>>}
   */
  async list(limit = 50) {
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
      const recent = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit * 2);
      for (const { name } of recent) {
        try {
          const raw = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8'));
          if (raw && typeof raw.id === 'string' && !found.has(raw.id)) found.set(raw.id, raw);
        } catch { /* 깨진 파일은 건너뛴다 */ }
      }
    }
    return [...found.values()]
      .filter((t) => Array.isArray(t.transcript) && t.transcript.length > 0)
      .map((t) => ({
        id: t.id,
        title: typeof t.title === 'string' && t.title ? t.title : '대화',
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        turns: t.transcript.filter((e) => e?.kind === 'user').length,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }
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
