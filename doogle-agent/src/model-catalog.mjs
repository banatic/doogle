// provider별 모델 목록 캐시 (메모리 + appDataDir()/models-cache.json, 0600).
// - TTL 12시간. stale-while-revalidate: 캐시가 있으면 즉시 돌려주고(source 'cache') 뒤에서 갱신한다.
// - 캐시도 실시간 조회도 실패하면 provider의 정적 목록(source 'fallback')을 쓴다.
// - provider마다 진행 중인 조회는 하나만 둔다(중복 요청은 같은 Promise를 공유).
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MODEL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
export const MODELS_CACHE_FILE = 'models-cache.json';
const CACHE_VERSION = 1;

/**
 * @typedef {'live'|'cache'|'fallback'} ModelSource
 * @typedef {{
 *   id: string, label: string, description?: string, default?: boolean,
 *   aliasOf?: string, resolvedModel?: string, supportsEffort?: boolean, effortLevels?: string[],
 *   source: ModelSource,
 * }} Model
 * @typedef {{models: Model[], updatedAt: number, source: ModelSource, error?: string}} CatalogEntry
 */

/**
 * 모델 배열을 공통 형태로 맞춘다. id 없는 항목·중복 id는 버린다.
 * @param {any[]} list
 * @param {ModelSource} source 항목에 source가 없을 때(또는 force일 때) 쓸 값
 * @param {{force?: boolean}} [opts]
 * @returns {Model[]}
 */
export function normalizeModels(list, source, { force = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || typeof m.id !== 'string' || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    /** @type {Model} */
    const row = { id: m.id, label: typeof m.label === 'string' && m.label ? m.label : m.id };
    if (typeof m.description === 'string' && m.description) row.description = m.description;
    if (m.default === true) row.default = true;
    if (typeof m.aliasOf === 'string' && m.aliasOf) row.aliasOf = m.aliasOf;
    if (typeof m.resolvedModel === 'string' && m.resolvedModel) row.resolvedModel = m.resolvedModel;
    if (typeof m.supportsEffort === 'boolean') row.supportsEffort = m.supportsEffort;
    if (Array.isArray(m.effortLevels) && m.effortLevels.length) row.effortLevels = m.effortLevels.filter((x) => typeof x === 'string');
    row.source = !force && ['live', 'cache', 'fallback'].includes(m.source) ? m.source : source;
    out.push(row);
  }
  return out;
}

/** 기본 모델 id: default 표시된 항목 → 첫 항목 → null */
export function defaultModelId(models) {
  if (!Array.isArray(models) || !models.length) return null;
  return (models.find((m) => m?.default === true) ?? models[0]).id ?? null;
}

/** 모델 목록이 바뀌었는지 (source 제외) */
function sameModels(a, b) {
  const strip = (l) => JSON.stringify((l ?? []).map(({ source, ...rest }) => rest));
  return strip(a) === strip(b);
}

export class ModelCatalog {
  /**
   * @param {{file?: string|null, dataDir?: string, ttlMs?: number, now?: () => number, log?: (m:string)=>void}} [opts]
   *   file=null이면 디스크에 저장하지 않는다.
   */
  constructor(opts = {}) {
    this.file = opts.file !== undefined ? opts.file : (opts.dataDir ? path.join(opts.dataDir, MODELS_CACHE_FILE) : null);
    this.ttlMs = opts.ttlMs ?? MODEL_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    /** @type {Map<string, CatalogEntry>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<CatalogEntry>>} */
    this.inflight = new Map();
    /** @type {Map<string, string>} 마지막 실시간 조회 실패 메시지 */
    this.errors = new Map();
    /** @type {Promise<void>|null} */
    this.loading = null;
    /** @type {Promise<void>} 저장 직렬화 */
    this.saving = Promise.resolve();
  }

  /** 디스크 캐시를 한 번만 읽는다. 손상·없음은 빈 캐시. */
  load() {
    if (!this.loading) {
      this.loading = (async () => {
        if (!this.file) return;
        try {
          const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
          if (raw?.version !== CACHE_VERSION || !raw.providers || typeof raw.providers !== 'object') return;
          for (const [id, e] of Object.entries(raw.providers)) {
            const updatedAt = Number(e?.updatedAt);
            const models = normalizeModels(e?.models, 'cache', { force: true });
            if (!Number.isFinite(updatedAt) || !models.length || this.entries.has(id)) continue;
            this.entries.set(id, { models, updatedAt, source: 'cache' });
          }
        } catch (err) {
          if (err?.code !== 'ENOENT') this.log(`models-cache 읽기 실패: ${err?.message ?? err}`);
        }
      })();
    }
    return this.loading;
  }

  /** @returns {CatalogEntry|null} */
  peek(providerId) {
    return this.entries.get(providerId) ?? null;
  }

  isFresh(entry) {
    return !!entry && this.now() - entry.updatedAt < this.ttlMs;
  }

  lastError(providerId) {
    return this.errors.get(providerId) ?? null;
  }

  /**
   * 실시간 조회. provider당 하나만 진행한다. 성공하면 캐시에 저장, 실패하면 reject.
   * @param {string} providerId
   * @param {() => Promise<any[]>} fetcher
   * @returns {Promise<CatalogEntry>}
   */
  refresh(providerId, fetcher) {
    const running = this.inflight.get(providerId);
    if (running) return running;
    const p = (async () => {
      await this.load();
      const models = normalizeModels(await fetcher(), 'live', { force: true });
      if (!models.length) throw new Error('모델 목록이 비어 있습니다');
      /** @type {CatalogEntry} */
      const entry = { models, updatedAt: this.now(), source: 'live' };
      this.entries.set(providerId, entry);
      this.errors.delete(providerId);
      await this.persist();
      return entry;
    })();
    const tracked = p.catch((err) => {
      this.errors.set(providerId, String(err?.message ?? err));
      throw err;
    }).finally(() => {
      if (this.inflight.get(providerId) === tracked) this.inflight.delete(providerId);
    });
    this.inflight.set(providerId, tracked);
    return tracked;
  }

  /**
   * 목록을 돌려준다(stale-while-revalidate).
   * - 신선한 캐시 → 그대로
   * - 오래된 캐시 → 즉시 돌려주고 뒤에서 갱신, 바뀌면 onUpdate()
   * - 캐시 없음 → 실시간 조회를 waitMs까지 기다림. 넘기면 fallback을 돌려주고 끝나면 onUpdate()
   * - 실패 → fallback
   * @param {string} providerId
   * @param {{fetch?: (() => Promise<any[]>)|null, fallback?: any[], waitMs?: number, onUpdate?: (id:string)=>void}} opts
   *   fetch가 없으면 조회하지 않고 캐시/fallback만 본다.
   * @returns {Promise<{models: Model[], updatedAt: number|null, source: ModelSource, error?: string}>}
   */
  async resolve(providerId, { fetch: fetcher = null, fallback = [], waitMs = 4000, onUpdate } = {}) {
    await this.load();
    const fb = () => {
      const error = this.lastError(providerId);
      return { models: normalizeModels(fallback, 'fallback', { force: true }), updatedAt: null, source: /** @type {const} */ ('fallback'), ...(error ? { error } : {}) };
    };
    const entry = this.peek(providerId);
    const background = (before) => {
      this.refresh(providerId, fetcher).then((next) => {
        if (!before || !sameModels(before.models, next.models) || before.source !== next.source) onUpdate?.(providerId);
      }, (err) => this.log(`모델 목록 갱신 실패 (${providerId}): ${err?.message ?? err}`));
    };
    if (entry) {
      if (fetcher && !this.isFresh(entry)) background(entry);
      return view(entry);
    }
    if (!fetcher) return fb();
    const p = this.refresh(providerId, fetcher);
    let timer;
    const timedOut = Symbol('timeout');
    try {
      const r = await Promise.race([p, new Promise((res) => { timer = setTimeout(() => res(timedOut), waitMs); })]);
      if (r === timedOut) {
        p.then(() => onUpdate?.(providerId), () => {});
        return fb();
      }
      return view(/** @type {CatalogEntry} */ (r));
    } catch {
      return fb();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 디스크에 기록 (0600, 원자적 교체). 실패는 로그만. */
  persist() {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const snapshot = {
      version: CACHE_VERSION,
      providers: Object.fromEntries([...this.entries].map(([id, e]) => [id, {
        updatedAt: e.updatedAt,
        models: e.models.map(({ source, ...rest }) => rest),
      }])),
    };
    this.saving = this.saving.then(async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(tmp, 0o600).catch(() => {});
        await fs.rename(tmp, file);
      } catch (err) {
        this.log(`models-cache 저장 실패: ${err?.message ?? err}`);
      }
    });
    return this.saving;
  }

  /** 진행 중인 조회·저장이 끝날 때까지 (테스트·종료용) */
  async idle() {
    await Promise.allSettled([...this.inflight.values()]);
    await this.saving;
  }
}

/** @param {CatalogEntry} e */
function view(e) {
  return { models: e.models.map((m) => ({ ...m, source: e.source })), updatedAt: e.updatedAt, source: e.source };
}
