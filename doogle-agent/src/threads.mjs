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
 * }} Thread
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
    return { id, createdAt: now, updatedAt: now, lastProviderId: null, histories: {}, pendingReviews: [] };
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
          t = { ...this.#fresh(id), ...raw, histories: raw.histories ?? {}, pendingReviews: raw.pendingReviews ?? [] };
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
}
