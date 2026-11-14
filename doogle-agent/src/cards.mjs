// 카드 저장소 — 사용자가 만들어 둔 정보 묶음(내 인적 사항, 학급 명렬 등)을 앱 데이터 폴더(`cards/<id>.json`)에 둔다.
//
// 카드는 이 컴퓨터에만 저장한다. 모델에 무엇을 보낼지는 카드를 읽는 쪽(read_card, 자리표시자 치환)이 정한다 —
// 이 파일은 저장·검사만 한다.
//
// 꼴:
//   { id, name, icon, kind: 'item'|'table', fields: [{key, desc, sensitive}], values?, rows?, createdAt, updatedAt }
//   - item  : values = { [key]: string }      (한 사람·한 기관처럼 항목마다 값 하나)
//   - table : rows   = string[][]             (명렬처럼 같은 항목이 여러 줄, 각 줄은 fields 순서)
//   항목 이름(key)은 자리표시자 `{{card:<id>.<key>}}` 에 그대로 쓰이므로 . { } [ ] 와 줄바꿈을 받지 않는다.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CARD_LIMITS = Object.freeze({
  cards: 200,
  nameChars: 60,
  fields: 40,
  keyChars: 40,
  descChars: 200,
  valueChars: 2_000,
  rows: 1_000,
  cellChars: 500,
});

export const CARD_ICONS = Object.freeze(['card', 'person', 'list', 'school']);
export const CARD_KINDS = Object.freeze(['item', 'table']);

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BAD_KEY = /[.{}[\]\r\n\t]/;

export class CardError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'CardError';
  }
}

const invalid = (message) => new CardError('INVALID_CARD', message);

function text(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalid(`${label}이(가) 없습니다`);
    return '';
  }
  if (typeof value !== 'string') throw invalid(`${label}은(는) 글이어야 합니다`);
  const s = value.trim();
  if (required && !s) throw invalid(`${label}이(가) 비어 있습니다`);
  if (s.length > max) throw invalid(`${label}이(가) 너무 깁니다 (${max}자까지)`);
  return s;
}

/** 칸 값 — 앞뒤 공백은 두되(서식에 그대로 들어갈 값) 글자 수만 본다 */
function cell(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') throw invalid(`${label}은(는) 글이어야 합니다`);
  if (value.length > max) throw invalid(`${label}이(가) 너무 깁니다 (${max}자까지)`);
  return value;
}

/**
 * 화면·도구가 보낸 카드를 검사하고 저장할 꼴로 바꾼다. id·시각은 저장소가 정한다.
 * @param {any} input
 * @returns {{name:string, icon:string, kind:'item'|'table', fields:Array<{key:string, desc:string, sensitive:boolean}>, values?:Record<string,string>, rows?:string[][]}}
 */
export function normalizeCard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('카드가 객체가 아닙니다');
  const name = text(input.name, CARD_LIMITS.nameChars, '카드 이름', { required: true });
  const icon = CARD_ICONS.includes(input.icon) ? input.icon : 'card';
  if (!CARD_KINDS.includes(input.kind)) throw invalid('kind 는 item 또는 table 이어야 합니다');
  const kind = input.kind;

  if (!Array.isArray(input.fields) || input.fields.length === 0) throw invalid('항목이 하나도 없습니다');
  if (input.fields.length > CARD_LIMITS.fields) throw invalid(`항목은 ${CARD_LIMITS.fields}개까지입니다`);
  const seen = new Set();
  const fields = input.fields.map((f, i) => {
    if (!f || typeof f !== 'object') throw invalid(`${i + 1}번째 항목이 객체가 아닙니다`);
    const key = text(f.key, CARD_LIMITS.keyChars, `${i + 1}번째 항목 이름`, { required: true });
    if (BAD_KEY.test(key)) throw invalid(`항목 이름 "${key}" 에는 . { } [ ] 와 줄바꿈을 쓸 수 없습니다`);
    if (seen.has(key)) throw invalid(`항목 이름 "${key}" 이(가) 겹칩니다`);
    seen.add(key);
    return { key, desc: text(f.desc, CARD_LIMITS.descChars, `"${key}" 설명`), sensitive: f.sensitive === true };
  });

  if (kind === 'item') {
    const src = input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {};
    for (const k of Object.keys(src)) if (!seen.has(k)) throw invalid(`값의 "${k}" 은(는) 항목에 없습니다`);
    /** @type {Record<string,string>} */
    const values = {};
    for (const { key } of fields) values[key] = cell(src[key], CARD_LIMITS.valueChars, `"${key}" 값`);
    return { name, icon, kind, fields, values };
  }

  const srcRows = input.rows ?? [];
  if (!Array.isArray(srcRows)) throw invalid('rows 는 배열이어야 합니다');
  if (srcRows.length > CARD_LIMITS.rows) throw invalid(`줄은 ${CARD_LIMITS.rows}개까지입니다`);
  const rows = srcRows.map((row, r) => {
    if (!Array.isArray(row)) throw invalid(`${r + 1}번째 줄이 배열이 아닙니다`);
    if (row.length > fields.length) throw invalid(`${r + 1}번째 줄의 칸이 항목보다 많습니다`);
    return fields.map((f, c) => cell(row[c], CARD_LIMITS.cellChars, `${r + 1}번째 줄 "${f.key}"`));
  });
  return { name, icon, kind, fields, values: undefined, rows };
}

export class CardStore {
  /** @param {{dir?: string|null}} [opts] dir 가 null 이면 메모리 전용 */
  constructor({ dir = null } = {}) {
    this.dir = dir;
    /** @type {Map<string, any>} */
    this.cards = new Map();
    /** @type {Promise<void>|null} */
    this.loading = null;
    /** 파일 쓰기를 한 줄로 세운다 (같은 카드를 겹쳐 쓰지 않게) */
    this.chain = Promise.resolve();
  }

  async #load() {
    if (!this.dir) return;
    this.loading ??= (async () => {
      let names = [];
      try {
        names = await fs.readdir(this.dir);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        return;
      }
      for (const file of names) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -5);
        if (!SAFE_ID.test(id)) continue;
        try {
          const raw = JSON.parse(await fs.readFile(path.join(this.dir, file), 'utf8'));
          const card = normalizeCard(raw);
          this.cards.set(id, { id, ...card, createdAt: String(raw.createdAt ?? ''), updatedAt: String(raw.updatedAt ?? '') });
        } catch (err) {
          process.emitWarning(`카드 ${file} 를 읽지 못했습니다: ${err?.message}`);
        }
      }
    })();
    await this.loading;
  }

  /** 최근에 고친 것부터 */
  async list() {
    await this.#load();
    return [...this.cards.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** @param {string} id */
  async get(id) {
    await this.#load();
    return typeof id === 'string' ? this.cards.get(id) ?? null : null;
  }

  /**
   * 새로 만들거나(id 없음·모르는 id) 고친다.
   * @param {any} input
   */
  async save(input) {
    await this.#load();
    const card = normalizeCard(input);
    const known = typeof input?.id === 'string' && this.cards.has(input.id) ? this.cards.get(input.id) : null;
    if (!known && this.cards.size >= CARD_LIMITS.cards) throw new CardError('TOO_MANY_CARDS', `카드는 ${CARD_LIMITS.cards}개까지 만들 수 있습니다`);
    const now = new Date().toISOString();
    const id = known ? known.id : `c-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const saved = { id, ...card, createdAt: known?.createdAt || now, updatedAt: now };
    if (saved.values === undefined) delete saved.values;
    this.cards.set(id, saved);
    try {
      await this.#write(id, saved);
    } catch (err) {
      // 파일에 못 썼으면 메모리도 되돌린다 — 화면에 저장된 것처럼 보이지 않게
      if (known) this.cards.set(id, known);
      else this.cards.delete(id);
      throw new CardError('SAVE_FAILED', `카드를 저장하지 못했습니다: ${err?.message ?? err}`);
    }
    return saved;
  }

  /** @param {string} id @returns {Promise<boolean>} 지웠으면 true */
  async delete(id) {
    await this.#load();
    if (typeof id !== 'string' || !this.cards.has(id)) return false;
    const old = this.cards.get(id);
    this.cards.delete(id);
    try {
      await this.#write(id, null);
    } catch (err) {
      this.cards.set(id, old);
      throw new CardError('DELETE_FAILED', `카드를 지우지 못했습니다: ${err?.message ?? err}`);
    }
    return true;
  }

  /** @param {string} id @param {any|null} card null 이면 파일을 지운다 */
  #write(id, card) {
    if (!this.dir) return Promise.resolve();
    const dir = this.dir;
    const next = this.chain.then(async () => {
      const target = path.join(dir, `${id}.json`);
      if (card === null) {
        await fs.rm(target, { force: true });
        return;
      }
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(card), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, target);
    });
    // 한 번 실패해도 다음 쓰기는 이어 간다
    this.chain = next.catch(() => {});
    return next;
  }
}

// ─── 모델에 보낼 때 ─────────────────────────────────────────
//
// 카드 값은 모델에 되도록 보내지 않는다 (docs/doogle/CONTRACT.md "카드"):
//   - 턴 글의 <doogle_cards> 블록에는 항목 이름·설명·민감 여부만.
//   - 값이 꼭 필요하면(가공) read_card — 민감 항목은 maskValue 로 가린다.
//   - 문서에 넣을 값은 자리표시자 {{card:<id>.<항목>}} / {{card:<id>.rows[N].<항목>}} 로 쓰고 hub 가 바꿔 끼운다.

/** 한 메시지에 붙일 수 있는 카드 수 */
export const CARD_REFS_PER_MESSAGE = 5;
/** read_card 한 번에 주는 줄 수 */
export const READ_CARD_ROWS = Object.freeze({ default: 50, max: 200 });

/**
 * 민감 값 가리기 — 숫자가 4개 이상이면 끝 4자리만 남기고(010-****-5678), 아니면 첫 글자만 남긴다(김**).
 * @param {string} value
 */
export function maskValue(value) {
  const s = String(value ?? '');
  if (!s.trim()) return s;
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits >= 4) {
    let keep = 4;
    let out = '';
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      if (/\d/.test(ch)) {
        out = (keep > 0 ? ch : '*') + out;
        keep--;
      } else out = ch + out;
    }
    return out;
  }
  const chars = [...s.trim()];
  return chars.length <= 1 ? '*' : chars[0] + '*'.repeat(chars.length - 1);
}

/**
 * 턴 글에 붙이는 카드 목록 — 값은 싣지 않는다.
 * @param {any[]} cards 대화에 붙은 카드 (지워진 카드는 빠져 있다)
 * @param {string[]} [added] 이번 메시지에 붙인 카드 id
 */
export function cardsBlock(cards, added = []) {
  if (!cards.length) return '';
  const fresh = new Set(added);
  const lines = cards.map((c) => {
    const fields = c.fields.map((f) => `${f.key}${f.sensitive ? '(민감)' : ''}${f.desc ? ` — ${f.desc}` : ''}`).join('; ');
    const size = c.kind === 'table' ? `표 ${c.rows?.length ?? 0}줄` : '항목형';
    return `- id=${c.id} ${JSON.stringify(c.name)} [${size}${fresh.has(c.id) ? ', 이번에 붙임' : ''}] 항목: ${fields}`;
  });
  return [
    '<doogle_cards note="사용자가 붙인 카드 — 값은 여기 없습니다">',
    ...lines,
    '문서에 값을 넣을 때는 값 대신 자리표시자를 tool 인자 글에 그대로 쓰세요: 항목형 {{card:<id>.<항목>}}, 표형 {{card:<id>.rows[<줄 번호, 1부터>].<항목>}}. hub 가 실제 값으로 바꿔 넣습니다.',
    '값을 바꿔 써야 할 때(날짜 형식, 일부만 쓰기 등)만 read_card 로 읽으세요. 민감 항목은 가린 값만 보이니 민감 항목은 언제나 자리표시자로 넣으세요.',
    '</doogle_cards>',
  ].join('\n');
}

/**
 * read_card — 값을 읽는다 (민감 항목은 가린다).
 * @param {any} card
 * @param {{fromRow?: number, maxRows?: number, fields?: string[]}} args fromRow 는 1부터
 */
export function readCardView(card, args = {}) {
  const want = Array.isArray(args.fields) && args.fields.length > 0 ? new Set(args.fields) : null;
  const fields = card.fields.filter((f) => !want || want.has(f.key));
  const unknown = want ? [...want].filter((k) => !card.fields.some((f) => f.key === k)) : [];
  const shown = (f, v) => (f.sensitive ? maskValue(v) : v);
  const base = {
    id: card.id,
    name: card.name,
    kind: card.kind,
    fields: fields.map((f) => ({ key: f.key, desc: f.desc, sensitive: f.sensitive })),
    ...(unknown.length ? { unknownFields: unknown } : {}),
    note: '민감 항목은 가린 값입니다. 문서에는 자리표시자로 넣으세요.',
  };
  if (card.kind === 'item') {
    return { ...base, values: Object.fromEntries(fields.map((f) => [f.key, shown(f, card.values?.[f.key] ?? '')])) };
  }
  const rows = card.rows ?? [];
  const from = Math.max(1, Math.floor(args.fromRow ?? 1));
  const max = Math.min(READ_CARD_ROWS.max, Math.max(1, Math.floor(args.maxRows ?? READ_CARD_ROWS.default)));
  const index = fields.map((f) => card.fields.indexOf(f));
  const slice = rows.slice(from - 1, from - 1 + max).map((row, i) => ({
    row: from + i,
    ...Object.fromEntries(fields.map((f, j) => [f.key, shown(f, row[index[j]] ?? '')])),
  }));
  const next = from - 1 + max < rows.length ? from + max : null;
  return { ...base, totalRows: rows.length, rows: slice, ...(next ? { nextRow: next } : {}) };
}

const PLACEHOLDER = /\{\{\s*card:([A-Za-z0-9_-]+)\.(?:rows\[(\d+)\]\.)?([^{}]+?)\s*\}\}/g;

/**
 * tool 인자 안의 자리표시자를 실제 값으로 바꾼다 (글자열을 모두 훑는다).
 * @param {any} args
 * @param {(id: string) => any|null} lookup 이 대화에 붙은 카드만 찾는다
 * @returns {{ok: true, args: any, count: number, sensitive: string[]} | {ok: false, error: {code: string, message: string}}}
 */
export function fillPlaceholders(args, lookup) {
  const problems = [];
  let count = 0;
  /** 넣은 민감 값 — 도구 결과에서 다시 가린다 (maskSensitive) */
  const sensitive = new Set();
  const replace = (text) => text.replace(PLACEHOLDER, (whole, id, rowText, rawKey) => {
    const key = rawKey.trim();
    const card = lookup(id);
    if (!card) {
      problems.push(`${whole}: 이 대화에 붙은 카드가 아닙니다`);
      return whole;
    }
    const at = card.fields.findIndex((f) => f.key === key);
    if (at < 0) {
      problems.push(`${whole}: "${card.name}" 카드에 "${key}" 항목이 없습니다 (항목: ${card.fields.map((f) => f.key).join(', ')})`);
      return whole;
    }
    if (card.kind === 'item') {
      if (rowText !== undefined) {
        problems.push(`${whole}: 항목형 카드에는 rows[N] 을 쓰지 않습니다`);
        return whole;
      }
      count++;
      const value = card.values?.[key] ?? '';
      if (card.fields[at].sensitive) sensitive.add(value);
      return value;
    }
    if (rowText === undefined) {
      problems.push(`${whole}: 표형 카드는 {{card:${id}.rows[N].${key}}} 처럼 줄 번호(1부터)를 씁니다`);
      return whole;
    }
    const row = card.rows?.[Number(rowText) - 1];
    if (!row) {
      problems.push(`${whole}: "${card.name}" 카드는 ${card.rows?.length ?? 0}줄입니다`);
      return whole;
    }
    count++;
    const value = row[at] ?? '';
    if (card.fields[at].sensitive) sensitive.add(value);
    return value;
  });
  const walk = (value) => {
    if (typeof value === 'string') return value.includes('{{') ? replace(value) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  const out = walk(args);
  if (problems.length > 0) {
    return { ok: false, error: { code: 'CARD_PLACEHOLDER', message: `카드 자리표시자를 바꾸지 못했습니다 — ${problems.slice(0, 5).join(' / ')}` } };
  }
  return { ok: true, args: out, count, sensitive: [...sensitive].filter((v) => v.trim().length >= 2) };
}

/**
 * 도구 결과에 섞여 돌아온 민감 값을 가린다 — 쓰기 tool 은 바뀐 문단 글을 결과에 싣는다.
 * 긴 값부터 바꿔 겹치는 값(010-1234-5678 과 1234)이 어긋나지 않게 한다.
 * @param {any} result @param {string[]} values
 */
export function maskSensitive(result, values) {
  if (!values.length) return result;
  const list = [...values].sort((a, b) => b.length - a.length);
  const walk = (value) => {
    if (typeof value === 'string') {
      let s = value;
      for (const v of list) if (s.includes(v)) s = s.split(v).join(maskValue(v));
      return s;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(result);
}

/**
 * propose_card 인자 → 화면에 보낼 초안. 파일에서 만들 때는 source(dataStart, columns)를 함께 둔다.
 * rows 가 없어도 된다(화면이 파일·기존 줄에서 채운다).
 * @param {any} args
 */
export function normalizeProposal(args) {
  const card = normalizeCard({ ...args, rows: args?.kind === 'table' ? (args.rows ?? []) : undefined });
  let source;
  if (args?.source != null) {
    const s = args.source;
    if (!Number.isInteger(s.dataStart) || s.dataStart < 0) throw invalid('source.dataStart 는 0 이상의 정수입니다');
    if (!Array.isArray(s.columns) || s.columns.length !== card.fields.length || !s.columns.every((c) => Number.isInteger(c) && c >= -1)) {
      throw invalid('source.columns 는 항목마다 원본 열 번호(0부터, 없으면 -1)입니다');
    }
    if (card.kind !== 'table') throw invalid('source 는 표형 카드에서만 씁니다');
    source = { dataStart: s.dataStart, columns: [...s.columns] };
  }
  const { values, rows, ...rest } = card;
  return {
    card: { ...rest, ...(card.kind === 'item' ? { values } : { rows }) },
    ...(source ? { source } : {}),
  };
}

/**
 * 카드들의 민감 값 (두 글자 이상) — 카드를 붙인 대화의 도구 결과에서 maskSensitive 로 가린다.
 * @param {any[]} cards
 */
export function sensitiveValuesOf(cards) {
  const out = new Set();
  for (const card of cards) {
    card.fields.forEach((f, i) => {
      if (!f.sensitive) return;
      if (card.kind === 'item') out.add(card.values?.[f.key] ?? '');
      else for (const row of card.rows ?? []) out.add(row[i] ?? '');
    });
  }
  return [...out].filter((v) => v.trim().length >= 2);
}
