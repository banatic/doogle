/**
 * 참고 파일(첨부) 읽기 — 계산만 하는 부분. DOM·WASM 을 쓰지 않아 node 시험에서 바로 돈다.
 *
 * 사이드바에 올린 파일은 화면에서 글(과 그림)로 바꿔 hub 로 보낸다 — 원본 바이트는 보내지 않는다
 * (doogle-agent/src/attachments.mjs). 여기는 형식 판별, 글 파일의 인코딩 풀기, 그리고 Office 문서
 * (docx · xlsx · pptx = zip 안의 XML)에서 글을 꺼내는 일을 맡는다. 한글 문서(hwp · hwpx)와 PDF 는
 * 문서 엔진이 읽는다(attach-read.ts).
 */

export type AttachKind = 'text' | 'hwp' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'image';

export interface AttachImage { mimeType: string; base64: string; width?: number; height?: number; label?: string }

export interface AttachMeta {
  pages?: number;
  sheets?: number;
  slides?: number;
  encoding?: string;
  note?: string;
  truncated?: boolean;
}

/** hub 로 보내는 첨부 하나 (`chat_send.attachments[]`) */
export interface AttachmentPayload {
  name: string;
  kind: AttachKind;
  mime: string;
  size: number;
  text?: string;
  images?: AttachImage[];
  meta?: AttachMeta;
}

export const ATTACH_LIMITS = Object.freeze({
  /** 메시지 하나에 붙이는 파일 수 (hub ATTACHMENT_LIMITS.perMessage 와 같다) */
  files: 10,
  /** 파일 하나의 크기 */
  fileBytes: 30 * 1024 * 1024,
  /** 파일 하나에서 꺼내는 글자 수 (hub ATTACHMENT_LIMITS.textChars 와 같다) */
  textChars: 600_000,
  /** 그림의 긴 변 — 넘으면 줄인다 */
  imageEdge: 1568,
  /** zip 에서 푸는 항목 하나의 크기 */
  unzipEntryBytes: 64 * 1024 * 1024,
  /** 시트 하나에서 읽는 행 수 */
  sheetRows: 5000,
  /** 메시지 하나에 실어 보내는 첨부의 총량 — hub 가 받는 메시지 크기(64MB)보다 넉넉히 작게 */
  messageBytes: 40 * 1024 * 1024,
});

/** 사용자에게 그대로 보일 수 있는 읽기 실패 */
export class AttachError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachError';
    this.code = code;
  }
}

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'yaml', 'yml', 'log', 'ini', 'toml', 'tex', 'srt',
  'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'sql', 'sh', 'bat', 'ps1', 'css',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
/** 옛 Office 형식 — 읽지 못한다. 새 형식으로 저장하라고 알려 준다 */
const LEGACY_HINT: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** 파일 이름·MIME 으로 종류를 정한다. 읽지 못하는 형식이면 AttachError */
export function classifyFile(name: string, mime = ''): AttachKind {
  const ext = extensionOf(name);
  if (ext === 'hwp' || ext === 'hwpx') return 'hwp';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (IMAGE_EXT.has(ext) || /^image\/(png|jpeg|webp|gif|bmp)$/.test(mime)) return 'image';
  if (TEXT_EXT.has(ext) || mime.startsWith('text/') || mime === 'application/json') return 'text';
  if (LEGACY_HINT[ext]) {
    throw new AttachError('UNSUPPORTED_TYPE', `.${ext} 파일은 읽지 못합니다. .${LEGACY_HINT[ext]} 로 저장해서 붙여 주세요`);
  }
  throw new AttachError('UNSUPPORTED_TYPE', ext ? `.${ext} 파일은 읽지 못합니다` : '이 파일 형식은 읽지 못합니다');
}

/** 파일 고르기 창의 accept 값 */
export const ATTACH_ACCEPT = ['.hwp', '.hwpx', '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', ...[...IMAGE_EXT].map((e) => `.${e}`),
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.log'].join(',');

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

/** 보낼 첨부들의 크기 어림 (JSON 으로 실릴 때의 바이트 — 한글은 글자당 3바이트로 본다) */
export function payloadBytes(list: ReadonlyArray<AttachmentPayload>): number {
  let n = 0;
  for (const a of list) {
    n += (a.text?.length ?? 0) * 3 + 400;
    for (const img of a.images ?? []) n += img.base64.length + 120;
  }
  return n;
}

/** 글자 수 한도에 맞춘다 — 넘으면 자르고 알린다 */
export function clipText(text: string, max: number = ATTACH_LIMITS.textChars): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** 긴 변이 maxEdge 를 넘지 않게 줄인 크기 (비율 유지, 키우지는 않는다) */
export function fitWithin(width: number, height: number, maxEdge: number = ATTACH_LIMITS.imageEdge): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest <= 0) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const k = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// ─── 글 파일 ─────────────────────────────────────────────

/**
 * 글 파일의 바이트를 글로 — BOM(UTF-8 · UTF-16) → UTF-8 → EUC-KR(CP949) 순으로 본다.
 * 한국 관공서·엑셀이 내보낸 csv 는 아직 EUC-KR 인 일이 많다.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  const strip = (s: string) => s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: strip(new TextDecoder('utf-16le').decode(bytes)), encoding: 'utf-16le' };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: strip(new TextDecoder('utf-16be').decode(bytes)), encoding: 'utf-16be' };
  // 글 파일이 아닌 것(NUL 이 섞인 바이너리)을 글로 읽지 않는다
  const probe = bytes.subarray(0, 4096);
  let nul = 0;
  for (const b of probe) if (b === 0) nul++;
  if (nul > 0 && nul > probe.length / 100) throw new AttachError('NOT_TEXT', '글 파일이 아닙니다');
  try {
    return { text: strip(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), encoding: 'utf-8' };
  } catch { /* UTF-8 이 아니다 */ }
  try {
    return { text: strip(new TextDecoder('euc-kr', { fatal: true }).decode(bytes)), encoding: 'euc-kr' };
  } catch { /* EUC-KR 도 아니다 */ }
  return { text: strip(new TextDecoder('utf-8').decode(bytes)), encoding: 'utf-8' };
}

// ─── zip ─────────────────────────────────────────────────

function u16(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number): number { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * zip 에서 want(name) 이 참인 항목만 푼다. 중앙 디렉터리의 크기를 쓰므로 data descriptor 가 붙은
 * 파일(스트리밍으로 만든 zip)도 읽는다. zip64 · 암호 · deflate 밖의 압축은 읽지 못한다.
 */
export async function unzip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const bad = (why: string) => new AttachError('BAD_ZIP', `파일을 열지 못했습니다 (${why})`);
  // 끝에서 EOCD(0x06054b50) 찾기 — 뒤에 주석이 최대 65535 바이트 올 수 있다
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('zip 형식이 아닙니다');
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw bad('너무 큰 파일입니다');
  const out = new Map<string, Uint8Array>();
  const utf8 = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw bad('목록이 깨졌습니다');
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const packed = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (flags & 1) throw new AttachError('ENCRYPTED', '암호가 걸린 파일은 읽지 못합니다');
    if (packed === 0xffffffff || size === 0xffffffff) throw bad('너무 큰 파일입니다');
    if (size > ATTACH_LIMITS.unzipEntryBytes) throw new AttachError('TOO_LARGE', '파일 속 내용이 너무 큽니다');
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw bad('항목이 깨졌습니다');
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + packed);
    if (data.length !== packed) throw bad('항목이 잘렸습니다');
    let body: Uint8Array;
    if (method === 0) body = data;
    else if (method === 8) {
      try { body = await inflateRaw(data); } catch { throw bad('압축을 풀지 못했습니다'); }
    } else throw bad('지원하지 않는 압축 방식입니다');
    if (body.length > ATTACH_LIMITS.unzipEntryBytes) throw new AttachError('TOO_LARGE', '파일 속 내용이 너무 큽니다');
    out.set(name, body);
  }
  return out;
}

// ─── XML ─────────────────────────────────────────────────

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML 글의 엔티티를 푼다 */
export function xmlText(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITY[body] ?? whole;
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`).exec(tag);
  return m ? xmlText(m[1]) : null;
}

const utf8Decode = (bytes: Uint8Array | undefined): string => (bytes ? new TextDecoder('utf-8').decode(bytes) : '');

/** 빈 줄이 셋 넘게 이어지면 둘로 줄이고 앞뒤 빈 줄을 뗀다 */
function tidy(lines: string[]): string {
  return lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 표의 한 행을 한 줄로 */
export function rowLine(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\s*\n\s*/g, ' / ').replace(/\|/g, '¦').trim()).join(' | ')} |`;
}

// ─── docx ────────────────────────────────────────────────

/**
 * WordprocessingML 본문(document.xml) → 글. 문단은 한 줄, 표는 행마다 `| 칸 | 칸 |`.
 * 지운 글(변경 내용 추적의 w:delText)은 뺀다. ns = 태그 접두(w).
 */
export function wordXmlText(xml: string): string {
  const lines: string[] = [];
  /** 표 스택 — 표마다 행들, 지금 행의 칸들, 지금 칸의 문단들 */
  const tables: Array<{ rows: string[][]; row: string[] | null; cell: string[] | null }> = [];
  let para: string[] | null = null;
  const endPara = () => {
    if (para === null) return;
    const text = para.join('');
    para = null;
    const top = tables[tables.length - 1];
    if (top?.cell) top.cell.push(text);
    else lines.push(text);
  };
  // 탭 글자는 속성 없는 <w:tab/> 뿐이다 — 문단 속성의 탭 자리(<w:tabs><w:tab w:val=… w:pos=…/>)는 글이 아니다
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab(?=\s*\/>)|br\b|cr\b|noBreakHyphen\b)[^>]*\/?>|<(\/?)w:(tbl|tr|tc|p)(?:\s[^>]*?)?(\/?)>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[1] !== undefined) {
      (para ??= []).push(xmlText(m[1]));
    } else if (m[2]) {
      (para ??= []).push(m[2] === 'tab' ? '\t' : m[2] === 'noBreakHyphen' ? '-' : '\n');
    } else {
      const closing = m[3] === '/';
      const selfClosing = m[5] === '/';
      const tag = m[4];
      const top = tables[tables.length - 1];
      if (tag === 'p') {
        if (closing) { para ??= []; endPara(); } else if (selfClosing) { para = []; endPara(); } else { endPara(); para = []; }
      } else if (tag === 'tbl') {
        if (!closing && !selfClosing) { endPara(); tables.push({ rows: [], row: null, cell: null }); } else if (closing && top) {
          tables.pop();
          const text = top.rows.map(rowLine).join('\n');
          const outer = tables[tables.length - 1];
          // 표 안의 표는 바깥 칸의 글로 접는다
          if (outer?.cell) outer.cell.push(top.rows.map((r) => r.join(' · ')).join(' / '));
          else lines.push('', text, '');
        }
      } else if (tag === 'tr' && top) {
        if (!closing && !selfClosing) top.row = [];
        else if (closing && top.row) { top.rows.push(top.row); top.row = null; }
      } else if (tag === 'tc' && top) {
        if (!closing && !selfClosing) top.cell = [];
        else if (closing && top.cell) { endPara(); (top.row ??= []).push(top.cell.filter((t) => t !== '').join('\n')); top.cell = null; }
      }
    }
  }
  endPara();
  return tidy(lines);
}

export function docxText(files: Map<string, Uint8Array>): string {
  const main = files.get('word/document.xml');
  if (!main) throw new AttachError('BAD_FILE', 'Word 문서의 본문을 찾지 못했습니다');
  const parts = [wordXmlText(utf8Decode(main))];
  // 각주·미주: 본문 뒤에 붙인다 (구분선 같은 빈 각주는 빠진다)
  for (const [file, title] of [['word/footnotes.xml', '각주'], ['word/endnotes.xml', '미주']] as const) {
    const xml = utf8Decode(files.get(file));
    if (!xml) continue;
    const notes = [...xml.matchAll(/<w:(?:footnote|endnote)\b[^>]*>([\s\S]*?)<\/w:(?:footnote|endnote)>/g)]
      .map((m) => wordXmlText(m[1])).filter(Boolean);
    if (notes.length > 0) parts.push(`[${title}]\n${notes.map((n, i) => `${i + 1}) ${n}`).join('\n')}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

// ─── xlsx ────────────────────────────────────────────────

/** 날짜·시각을 뜻하는 내장 숫자 서식 번호 (ECMA-376 18.8.30, 동아시아 로캘 포함) */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code: string): boolean {
  // 따옴표 글·대괄호(색·로캘)·이스케이프를 떼고 날짜 글자(y m d h s)가 남는지 본다
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[ymdhs]/i.test(bare) && !/^[#0?.,\s%E+\-]*$/i.test(bare);
}

/** 서식 코드가 백분율인가 (따옴표 글·대괄호 밖에 % 가 있다) */
function isPercentFormatCode(code: string): boolean {
  return code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').includes('%');
}

/** 엑셀 날짜 일련번호 → "YYYY-MM-DD" (시각이 있으면 " HH:MM") */
export function excelDate(serial: number, date1904 = false): string {
  const days = Math.floor(serial);
  const ms = Math.round((serial - days) * 86400) * 1000;
  // 1900 체계: 0 = 1899-12-30 (엑셀의 1900-02-29 버그를 품은 기준일)
  const base = Date.UTC(1899, 11, 30) + (date1904 ? 1462 : 0) * 86400000;
  const d = new Date(base + days * 86400000 + ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  if (days === 0 && ms > 0) return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return ms > 0 ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}

/** "BC12" → 0 부터 세는 열 번호 */
function columnOf(ref: string): number {
  let col = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    col = col * 26 + (c - 64);
  }
  return col - 1;
}

/** 숫자를 사람이 읽는 꼴로 — 부동소수점 꼬리(0.30000000000000004)를 떼어 낸다 */
function numberText(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Number(n.toPrecision(15)));
}

export function xlsxText(files: Map<string, Uint8Array>): { text: string; sheets: number; truncated: boolean } {
  const workbook = utf8Decode(files.get('xl/workbook.xml'));
  if (!workbook) throw new AttachError('BAD_FILE', '스프레드시트의 시트 목록을 찾지 못했습니다');
  const date1904 = /<workbookPr\b[^>]*\sdate1904="(1|true)"/.test(workbook);
  // 공유 문자열 — 후리가나(rPh)는 뺀다
  const shared = [...utf8Decode(files.get('xl/sharedStrings.xml')).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)]
    .map((m) => [...(m[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => xmlText(t[1])).join(''));
  // 셀 서식 번호 → 날짜인가
  const styles = utf8Decode(files.get('xl/styles.xml'));
  const custom = new Map<number, 'date' | 'percent' | 'plain'>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') ?? '';
    custom.set(id, isDateFormatCode(code) ? 'date' : isPercentFormatCode(code) ? 'percent' : 'plain');
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  /** 셀 서식 번호 → 값을 어떻게 읽을지 (날짜 · 백분율 · 그대로) */
  const styleKind = [...cellXfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    return custom.get(id) ?? (DATE_FORMATS.has(id) ? 'date' : id === 9 || id === 10 ? 'percent' : 'plain');
  });
  // 시트 이름 → 파일
  const rels = new Map<string, string>();
  for (const m of utf8Decode(files.get('xl/_rels/workbook.xml.rels')).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const parts: string[] = [];
  let sheets = 0;
  let truncated = false;
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `시트 ${sheets + 1}`;
    const file = rels.get(attr(m[0], 'r:id') ?? '') ?? `xl/worksheets/sheet${sheets + 1}.xml`;
    const xml = utf8Decode(files.get(file));
    sheets++;
    if (!xml) continue;
    const rows: string[] = [];
    let seen = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = ` ${c[1]}`;
        const body = c[2] ?? '';
        const type = attr(head, 't') ?? 'n';
        const v = /<v(?:\s[^>]*)?>([^<]*)<\/v>/.exec(body)?.[1];
        let value = '';
        if (type === 'inlineStr') value = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => xmlText(t[1])).join('');
        else if (v === undefined) value = '';
        else if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'str' || type === 'e') value = xmlText(v);
        else {
          // 숫자: 날짜 서식이면 날짜로, 백분율 서식이면 화면에 보이는 대로(0.25 → 25%), 그 밖에는 값 그대로
          const kind = Number.isFinite(Number(v)) ? styleKind[Number(attr(head, 's') ?? '-1')] : undefined;
          if (kind === 'date') value = excelDate(Number(v), date1904);
          else if (kind === 'percent') value = `${numberText(String(Number(v) * 100))}%`;
          else value = numberText(v);
        }
        const col = Math.max(cells.length, columnOf(attr(head, 'r') ?? ''));
        while (cells.length < col) cells.push('');
        cells.push(value);
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.length === 0) continue;
      if (++seen > ATTACH_LIMITS.sheetRows) { truncated = true; break; }
      rows.push(rowLine(cells));
    }
    parts.push(`## 시트: ${name}${rows.length === 0 ? ' (빈 시트)' : ''}`);
    if (rows.length > 0) parts.push(rows.join('\n'));
    if (seen > ATTACH_LIMITS.sheetRows) parts.push(`(이 시트는 ${ATTACH_LIMITS.sheetRows}행까지만 읽었습니다)`);
  }
  return { text: parts.join('\n\n').trim(), sheets, truncated };
}

// ─── pptx ────────────────────────────────────────────────

/** DrawingML 글 — 문단(a:p)마다 한 줄, 표(a:tbl)는 행마다 한 줄 */
function drawingText(xml: string): string {
  const lines: string[] = [];
  const paragraphs = (chunk: string): string[] => [...chunk.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
    .map((p) => [...p[1].matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/?>/g)].map((t) => (t[1] !== undefined ? xmlText(t[1]) : '\n')).join(''));
  let at = 0;
  for (const table of xml.matchAll(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g)) {
    lines.push(...paragraphs(xml.slice(at, table.index)));
    for (const tr of table[1].matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
      lines.push(rowLine([...tr[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((tc) => paragraphs(tc[1]).filter(Boolean).join('\n'))));
    }
    at = (table.index ?? 0) + table[0].length;
  }
  lines.push(...paragraphs(xml.slice(at)));
  return tidy(lines.filter((l) => l.trim() !== ''));
}

export function pptxText(files: Map<string, Uint8Array>): { text: string; slides: number } {
  // 슬라이드 순서는 presentation.xml 의 sldIdLst — 파일 번호는 만든 순서일 뿐이다
  const rels = new Map<string, string>();
  for (const m of utf8Decode(files.get('ppt/_rels/presentation.xml.rels')).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\//, '')}`);
  }
  let order = [...utf8Decode(files.get('ppt/presentation.xml')).matchAll(/<p:sldId\b[^>]*>/g)]
    .map((m) => rels.get(attr(m[0], 'r:id') ?? '')).filter((f): f is string => !!f && files.has(f));
  if (order.length === 0) {
    const num = (f: string) => Number(/slide(\d+)\.xml$/.exec(f)?.[1] ?? 0);
    order = [...files.keys()].filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => num(a) - num(b));
  }
  if (order.length === 0) throw new AttachError('BAD_FILE', '발표 자료의 슬라이드를 찾지 못했습니다');
  const parts = order.map((file, i) => {
    const body = drawingText(utf8Decode(files.get(file)));
    return `## 슬라이드 ${i + 1}${body ? `\n${body}` : ' (글 없음)'}`;
  });
  return { text: parts.join('\n\n'), slides: order.length };
}

/** Office 문서(zip) 에서 읽을 항목 */
export function officeEntryWanted(kind: 'docx' | 'xlsx' | 'pptx'): (name: string) => boolean {
  if (kind === 'docx') return (n) => n === 'word/document.xml' || n === 'word/footnotes.xml' || n === 'word/endnotes.xml';
  if (kind === 'xlsx') return (n) => n === 'xl/workbook.xml' || n === 'xl/sharedStrings.xml' || n === 'xl/styles.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/[^/]+\.xml$/.test(n);
  return (n) => n === 'ppt/presentation.xml' || n === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/slide\d+\.xml$/.test(n);
}

/** Office 문서의 바이트 → 글 */
export async function officeText(kind: 'docx' | 'xlsx' | 'pptx', bytes: Uint8Array): Promise<{ text: string; meta: AttachMeta }> {
  const files = await unzip(bytes, officeEntryWanted(kind));
  if (kind === 'docx') return { text: docxText(files), meta: {} };
  if (kind === 'xlsx') {
    const r = xlsxText(files);
    return { text: r.text, meta: { sheets: r.sheets, ...(r.truncated ? { truncated: true } : {}) } };
  }
  const r = pptxText(files);
  return { text: r.text, meta: { slides: r.slides } };
}
