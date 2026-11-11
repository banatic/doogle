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
  /** zip 에서 푸는 것의 합 — 작은 조각 하나를 가리키는 항목 수천 개로 메모리를 채우지 못하게 */
  unzipTotalBytes: 160 * 1024 * 1024,
  /** zip 에서 푸는 항목 수 */
  unzipEntries: 3000,
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

/**
 * 붙여 넣은 것을 첨부로 받을까. 파일이 있고 글이 없을 때만이다.
 * 엑셀 셀·PowerPoint 선택을 복사하면 클립보드에 글과 함께 그 모습의 그림(image/png)이 실린다 —
 * 그때 사용자가 붙이려는 것은 글이다. 그림을 가로채면 글은 들어가지 않고 그림 칩만 생긴다.
 */
export function pasteIsAttachment(fileCount: number, text: string): boolean {
  return fileCount > 0 && text.trim() === '';
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

/**
 * deflate 를 풀되 limit 바이트를 넘으면 그 자리에서 멈춘다 (넘었으면 null).
 * 다 풀고 나서 크기를 재면 늦다 — 몇 KB 짜리 항목이 몇 GB 로 풀리는 압축 폭탄이 메모리를 먼저 채운다.
 */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * zip 에서 want(name) 이 참인 항목만 푼다. 중앙 디렉터리의 크기를 쓰므로 data descriptor 가 붙은
 * 파일(스트리밍으로 만든 zip)도 읽는다. zip64 · 암호 · deflate 밖의 압축은 읽지 못한다.
 * 푸는 양에는 세 겹의 한도가 있다: 항목 하나(unzipEntryBytes), 푼 것의 합(unzipTotalBytes), 항목 수(unzipEntries).
 * 항목이 적어 둔 크기보다 크게 풀리면 깨진 파일로 본다.
 */
export async function unzip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const bad = (why: string) => new AttachError('BAD_ZIP', `파일을 열지 못했습니다 (${why})`);
  const tooLarge = () => new AttachError('TOO_LARGE', '파일 속 내용이 너무 큽니다');
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
  let total = 0;
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
    if (!want(name) || out.has(name)) continue;
    if (flags & 1) throw new AttachError('ENCRYPTED', '암호가 걸린 파일은 읽지 못합니다');
    if (packed === 0xffffffff || size === 0xffffffff) throw bad('너무 큰 파일입니다');
    if (out.size >= ATTACH_LIMITS.unzipEntries) throw tooLarge();
    if (size > ATTACH_LIMITS.unzipEntryBytes || total + size > ATTACH_LIMITS.unzipTotalBytes) throw tooLarge();
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw bad('항목이 깨졌습니다');
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const data = bytes.subarray(start, start + packed);
    if (data.length !== packed) throw bad('항목이 잘렸습니다');
    let body: Uint8Array;
    if (method === 0) {
      if (packed !== size) throw bad('항목 크기가 맞지 않습니다');
      body = data;
    } else if (method === 8) {
      let inflated: Uint8Array | null;
      // 적어 둔 크기까지만 푼다 — 그보다 크게 풀리면 크기를 속인 파일이다
      try { inflated = await inflateRaw(data, size); } catch { throw bad('압축을 풀지 못했습니다'); }
      if (!inflated) throw bad('항목 크기가 맞지 않습니다');
      body = inflated;
    } else throw bad('지원하지 않는 압축 방식입니다');
    total += body.length;
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

/**
 * XML 을 앞에서부터 한 번만 훑는다 — 태그와 그 사이의 글을 차례로 낸다.
 *
 * 정규식으로 "여는 태그 … 닫는 태그" 를 찾으면, 닫는 태그가 없는 입력에서 여는 태그마다 끝까지 다시 훑어
 * 걸리는 시간이 길이의 제곱이 된다(2MB 짜리 조작된 시트 하나로 화면이 한참 멈춘다). 이 훑개는 닫는 태그를
 * 기다리지 않고 지나간 자리로 돌아가지 않으므로, 어떤 입력에서도 길이에 비례하는 시간만 쓴다.
 * 주석·처리 명령은 건너뛰고 CDATA 는 글로 낸다. 속성 값 안의 '>' 는 다루지 않는다(Office 는 &gt; 로 쓴다).
 */
class XmlScan {
  /** 방금 읽은 것: 여는 태그 · 닫는 태그 · 스스로 닫는 태그 · 글 */
  kind: 'open' | 'close' | 'empty' | 'text' = 'text';
  /** 태그 이름 (접두어 포함, 예: w:p) */
  name = '';
  /** 접두어를 뗀 이름 (예: p) */
  local = '';
  /** 글 토큰의 내용 (엔티티를 풀지 않은 것) */
  raw = '';
  /** 이 토큰이 시작한 자리 · 끝난 다음 자리 */
  start = 0;
  end = 0;
  private readonly xml: string;
  private pos = 0;
  private attrFrom = 0;
  private attrTo = 0;
  private attrText: string | null = null;
  private cdata = false;

  constructor(xml: string) {
    this.xml = xml;
  }

  /** 다음 토큰으로. 더 없으면 false */
  next(): boolean {
    const xml = this.xml;
    for (;;) {
      if (this.pos >= xml.length) return false;
      const lt = xml.indexOf('<', this.pos);
      if (lt !== this.pos) {
        // 태그 앞의 글
        const to = lt < 0 ? xml.length : lt;
        this.kind = 'text';
        this.raw = xml.slice(this.pos, to);
        this.cdata = false;
        this.start = this.pos;
        this.end = to;
        this.pos = to;
        return true;
      }
      if (xml.startsWith('<!--', lt)) {
        const close = xml.indexOf('-->', lt + 4);
        if (close < 0) return false;
        this.pos = close + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const close = xml.indexOf(']]>', lt + 9);
        if (close < 0) return false;
        this.kind = 'text';
        this.raw = xml.slice(lt + 9, close);
        this.cdata = true;
        this.start = lt;
        this.end = close + 3;
        this.pos = close + 3;
        return true;
      }
      const gt = xml.indexOf('>', lt + 1);
      if (gt < 0) return false;
      this.pos = gt + 1;
      const first = xml.charCodeAt(lt + 1);
      if (first === 63 || first === 33) continue; // <?…?> · <!…>
      const closing = first === 47;
      let nameEnd = lt + (closing ? 2 : 1);
      const nameStart = nameEnd;
      while (nameEnd < gt) {
        const ch = xml.charCodeAt(nameEnd);
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47) break;
        nameEnd++;
      }
      this.name = xml.slice(nameStart, nameEnd);
      const colon = this.name.indexOf(':');
      this.local = colon < 0 ? this.name : this.name.slice(colon + 1);
      this.kind = closing ? 'close' : xml.charCodeAt(gt - 1) === 47 ? 'empty' : 'open';
      this.start = lt;
      this.end = gt + 1;
      this.attrFrom = nameEnd;
      this.attrTo = gt;
      this.attrText = null;
      return true;
    }
  }

  /** 글 토큰의 글 (엔티티를 푼 것) */
  text(): string {
    return this.cdata ? this.raw : xmlText(this.raw);
  }

  /** 지금 태그의 속성 값. 없으면 null */
  attr(name: string): string | null {
    // 태그 하나의 속성 글만 잘라 그 안에서 찾는다 — 문서 끝까지 훑지 않게
    const head = (this.attrText ??= this.xml.slice(this.attrFrom, this.attrTo));
    let from = 0;
    for (;;) {
      const i = head.indexOf(name, from);
      if (i < 0) return null;
      from = i + name.length;
      const before = i === 0 ? 32 : head.charCodeAt(i - 1);
      if (before !== 32 && before !== 9 && before !== 10 && before !== 13) continue;
      let j = from;
      while (head.charCodeAt(j) === 32) j++;
      if (head.charCodeAt(j) !== 61) continue; // '='
      j++;
      while (head.charCodeAt(j) === 32) j++;
      const quote = head.charCodeAt(j);
      if (quote !== 34 && quote !== 39) continue;
      const close = head.indexOf(String.fromCharCode(quote), j + 1);
      if (close < 0) return null;
      return xmlText(head.slice(j + 1, close));
    }
  }
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

// ─── 문단·표로 된 글 (docx 본문 · pptx 슬라이드) ─────────

/** 문단·글·표를 가리키는 태그 이름 (Word 는 w:, 그림 글은 a:) */
interface MarkupDialect {
  p: string;
  t: string;
  tbl: string;
  tr: string;
  tc: string;
  /** 글자 하나로 치는 빈 태그 → 그 글자 */
  marks: Record<string, string>;
  /** 표를 본문과 빈 줄로 떼어 놓는가 */
  spaceAroundTables: boolean;
}

const WORD: MarkupDialect = {
  p: 'w:p', t: 'w:t', tbl: 'w:tbl', tr: 'w:tr', tc: 'w:tc',
  // 탭 글자는 속성 없는 <w:tab/> 뿐이다 — 문단 속성의 탭 자리(<w:tabs><w:tab w:val=… w:pos=…/>)는 글이 아니다
  marks: { 'w:tab': '\t', 'w:br': '\n', 'w:cr': '\n', 'w:noBreakHyphen': '-' },
  spaceAroundTables: true,
};

const DRAWING: MarkupDialect = {
  p: 'a:p', t: 'a:t', tbl: 'a:tbl', tr: 'a:tr', tc: 'a:tc',
  marks: { 'a:br': '\n' },
  spaceAroundTables: false,
};

/**
 * 문단은 한 줄, 표는 행마다 `| 칸 | 칸 |` 인 글로. 표 안의 표는 바깥 칸의 글로 접는다.
 *  - 글은 글 태그(w:t · a:t) 안의 것만 싣는다 — 지운 글(변경 내용 추적의 w:delText)·필드 코드는 빠진다.
 *  - `mc:Fallback` 안은 건너뛴다. Word 는 글상자를 `mc:Choice` 와 `mc:Fallback` 에 한 번씩 적으므로
 *    그대로 읽으면 같은 글이 두 번 나온다.
 */
function markupText(xml: string, d: MarkupDialect): string {
  const lines: string[] = [];
  /** 표 스택 — 표마다 행들, 지금 행의 칸들, 지금 칸의 문단들 */
  const tables: Array<{ rows: string[][]; row: string[] | null; cell: string[] | null }> = [];
  let para: string[] | null = null;
  let inText = false;
  let fallback = 0;
  const endPara = () => {
    if (para === null) return;
    const text = para.join('');
    para = null;
    const top = tables[tables.length - 1];
    if (top?.cell) top.cell.push(text);
    else lines.push(text);
  };
  const scan = new XmlScan(xml);
  while (scan.next()) {
    if (scan.kind === 'text') {
      if (inText && fallback === 0) (para ??= []).push(scan.text());
      continue;
    }
    const name = scan.name;
    if (name === 'mc:Fallback') {
      if (scan.kind === 'open') fallback++;
      else if (scan.kind === 'close' && fallback > 0) fallback--;
      continue;
    }
    if (fallback > 0) continue;
    if (name === d.t) {
      inText = scan.kind === 'open';
      continue;
    }
    const mark = d.marks[name];
    if (mark !== undefined) {
      // 탭 자리 정의(<w:tab w:val=…/>)는 글자가 아니다
      if (scan.kind !== 'close' && !(name === 'w:tab' && scan.attr('w:val') !== null)) (para ??= []).push(mark);
      continue;
    }
    const top = tables[tables.length - 1];
    if (name === d.p) {
      if (scan.kind === 'close') { para ??= []; endPara(); } else if (scan.kind === 'empty') { endPara(); para = []; endPara(); } else { endPara(); para = []; }
    } else if (name === d.tbl) {
      if (scan.kind === 'open') {
        endPara();
        tables.push({ rows: [], row: null, cell: null });
      } else if (scan.kind === 'close' && top) {
        endPara();
        tables.pop();
        const outer = tables[tables.length - 1];
        // 표 안의 표는 바깥 칸의 글로 접는다
        if (outer?.cell) outer.cell.push(top.rows.map((r) => r.join(' · ')).join(' / '));
        else if (d.spaceAroundTables) lines.push('', ...top.rows.map(rowLine), '');
        else lines.push(...top.rows.map(rowLine));
      }
    } else if (name === d.tr && top) {
      if (scan.kind === 'open') top.row = [];
      else if (scan.kind === 'close' && top.row) { top.rows.push(top.row); top.row = null; }
    } else if (name === d.tc && top) {
      if (scan.kind === 'open') top.cell = [];
      else if (scan.kind === 'close' && top.cell) {
        endPara();
        (top.row ??= []).push(top.cell.filter((t) => t !== '').join('\n'));
        top.cell = null;
      }
    }
  }
  endPara();
  return d.spaceAroundTables ? tidy(lines) : tidy(lines.filter((l) => l.trim() !== ''));
}

// ─── docx ────────────────────────────────────────────────

/** WordprocessingML 본문(document.xml) → 글 */
export function wordXmlText(xml: string): string {
  return markupText(xml, WORD);
}

/** 각주·미주 파일에서 주마다의 글 (구분선 같은 빈 주는 빠진다) */
function wordNotes(xml: string): string[] {
  const notes: string[] = [];
  const scan = new XmlScan(xml);
  let from = -1;
  while (scan.next()) {
    if (scan.kind === 'text' || (scan.name !== 'w:footnote' && scan.name !== 'w:endnote')) continue;
    if (scan.kind === 'open') from = scan.end;
    else if (scan.kind === 'close' && from >= 0) {
      const text = markupText(xml.slice(from, scan.start), WORD);
      if (text) notes.push(text);
      from = -1;
    }
  }
  return notes;
}

export function docxText(files: Map<string, Uint8Array>): string {
  const main = files.get('word/document.xml');
  if (!main) throw new AttachError('BAD_FILE', 'Word 문서의 본문을 찾지 못했습니다');
  const parts = [wordXmlText(utf8Decode(main))];
  // 각주·미주: 본문 뒤에 붙인다
  for (const [file, title] of [['word/footnotes.xml', '각주'], ['word/endnotes.xml', '미주']] as const) {
    const xml = utf8Decode(files.get(file));
    if (!xml) continue;
    const notes = wordNotes(xml);
    if (notes.length > 0) parts.push(`[${title}]\n${notes.map((n, i) => `${i + 1}) ${n}`).join('\n')}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

// ─── xlsx ────────────────────────────────────────────────

/** 날짜·시각을 뜻하는 내장 숫자 서식 번호 (ECMA-376 18.8.30, 동아시아 로캘 포함) */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** 서식 코드에서 따옴표 글·대괄호(색·로캘)·이스케이프를 뗀 것 */
function bareFormatCode(code: string): string {
  return code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
}

function isDateFormatCode(code: string): boolean {
  // 날짜 글자(y m d h s)가 남는지 본다
  const bare = bareFormatCode(code);
  return /[ymdhs]/i.test(bare) && !/^[#0?.,\s%E+\-]*$/i.test(bare);
}

/** 서식 코드가 백분율인가 (따옴표 글·대괄호 밖에 % 가 있다) */
function isPercentFormatCode(code: string): boolean {
  return bareFormatCode(code).includes('%');
}

/** 엑셀 날짜 일련번호 → "YYYY-MM-DD" (시각이 있으면 " HH:MM"). 날짜로 볼 수 없는 값은 숫자 그대로 */
export function excelDate(serial: number, date1904 = false): string {
  const days = Math.floor(serial);
  const ms = Math.round((serial - days) * 86400) * 1000;
  // 1900 체계: 0 = 1899-12-30 (엑셀의 1900-02-29 버그를 품은 기준일)
  const base = Date.UTC(1899, 11, 30) + (date1904 ? 1462 : 0) * 86400000;
  const d = new Date(base + days * 86400000 + ms);
  // 엑셀이 날짜로 다루는 범위(9999-12-31 까지) 밖이면 날짜가 아니다 — 서식만 날짜인 숫자
  if (!Number.isFinite(serial) || serial < 0 || Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9999) return String(serial);
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

/** 관계 파일(.rels) — Id → 대상 경로 (base 폴더 기준으로 푼다) */
function relationships(xml: string, base: string): Map<string, string> {
  const rels = new Map<string, string>();
  const scan = new XmlScan(xml);
  while (scan.next()) {
    if (scan.kind === 'text' || scan.kind === 'close' || scan.local !== 'Relationship') continue;
    const id = scan.attr('Id');
    const target = scan.attr('Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `${base}/${target.replace(/^\.\//, '')}`);
  }
  return rels;
}

/** 공유 문자열 — 순서대로. 빈 항목(<si/>)도 자리를 차지한다. 후리가나(rPh)는 뺀다 */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  const scan = new XmlScan(xml);
  let item: string[] | null = null;
  let inText = false;
  let phonetic = 0;
  while (scan.next()) {
    if (scan.kind === 'text') {
      if (item && inText && phonetic === 0) item.push(scan.text());
      continue;
    }
    const tag = scan.local;
    if (tag === 'si') {
      if (scan.kind === 'empty') out.push('');
      else if (scan.kind === 'open') item = [];
      else if (item) { out.push(item.join('')); item = null; }
    } else if (tag === 'rPh') {
      if (scan.kind === 'open') phonetic++;
      else if (scan.kind === 'close' && phonetic > 0) phonetic--;
    } else if (tag === 't') {
      inText = scan.kind === 'open';
    }
  }
  return out;
}

type CellStyleKind = 'date' | 'percent' | 'plain';

/** 셀 서식 번호(c 의 s 속성) → 값을 어떻게 읽을지 */
function cellStyleKinds(xml: string): CellStyleKind[] {
  const custom = new Map<number, CellStyleKind>();
  const kinds: CellStyleKind[] = [];
  const scan = new XmlScan(xml);
  let inCellXfs = false;
  while (scan.next()) {
    if (scan.kind === 'text') continue;
    const tag = scan.local;
    if (tag === 'cellXfs') inCellXfs = scan.kind === 'open';
    else if (scan.kind === 'close') continue;
    else if (tag === 'numFmt') {
      const code = scan.attr('formatCode') ?? '';
      custom.set(Number(scan.attr('numFmtId')), isDateFormatCode(code) ? 'date' : isPercentFormatCode(code) ? 'percent' : 'plain');
    } else if (tag === 'xf' && inCellXfs) {
      const id = Number(scan.attr('numFmtId') ?? '0');
      kinds.push(custom.get(id) ?? (DATE_FORMATS.has(id) ? 'date' : id === 9 || id === 10 ? 'percent' : 'plain'));
    }
  }
  return kinds;
}

/** 시트 하나의 행들 (`| 칸 | 칸 |`). 행 한도를 넘으면 거기서 멈춘다 */
function sheetRows(xml: string, shared: string[], styles: CellStyleKind[], date1904: boolean): { rows: string[]; truncated: boolean } {
  const rows: string[] = [];
  const scan = new XmlScan(xml);
  let cells: string[] | null = null;
  /** 지금 셀: 자리(r) · 종류(t) · 서식(s) 와 모은 값 */
  let cell: { ref: string; type: string; style: number; v: string | null; inline: string[] } | null = null;
  let inValue = false;
  let inInline = false;
  let inInlineText = false;
  const endCell = () => {
    if (!cell || !cells) { cell = null; return; }
    const { type, v } = cell;
    let value = '';
    if (type === 'inlineStr') value = cell.inline.join('');
    else if (v === null) value = '';
    else if (type === 's') value = shared[Number(v)] ?? '';
    else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
    else if (type === 'str' || type === 'e') value = v;
    else {
      // 숫자: 날짜 서식이면 날짜로, 백분율 서식이면 화면에 보이는 대로(0.25 → 25%), 그 밖에는 값 그대로
      const kind = Number.isFinite(Number(v)) && v.trim() !== '' ? styles[cell.style] : undefined;
      if (kind === 'date') value = excelDate(Number(v), date1904);
      else if (kind === 'percent') value = `${numberText(String(Number(v) * 100))}%`;
      else value = numberText(v);
    }
    const col = Math.max(cells.length, columnOf(cell.ref));
    while (cells.length < col && cells.length < 16_384) cells.push('');
    cells.push(value);
    cell = null;
  };
  const endRow = (): boolean => {
    endCell();
    const done = cells;
    cells = null;
    if (!done) return true;
    while (done.length > 0 && done[done.length - 1] === '') done.pop();
    if (done.length === 0) return true;
    if (rows.length >= ATTACH_LIMITS.sheetRows) return false;
    rows.push(rowLine(done));
    return true;
  };
  while (scan.next()) {
    if (scan.kind === 'text') {
      if (!cell) continue;
      if (inValue) cell.v = (cell.v ?? '') + scan.text();
      else if (inInline && inInlineText) cell.inline.push(scan.text());
      continue;
    }
    const tag = scan.local;
    if (tag === 'row') {
      if (scan.kind === 'close' || scan.kind === 'empty') {
        if (!endRow()) return { rows, truncated: true };
      } else {
        if (!endRow()) return { rows, truncated: true };
        cells = [];
      }
    } else if (tag === 'c') {
      if (scan.kind === 'close') { endCell(); continue; }
      endCell();
      if (!cells) continue;
      cell = { ref: scan.attr('r') ?? '', type: scan.attr('t') ?? 'n', style: Number(scan.attr('s') ?? '-1'), v: null, inline: [] };
      inValue = false;
      inInline = false;
      if (scan.kind === 'empty') endCell();
    } else if (tag === 'v') {
      inValue = scan.kind === 'open';
      if (scan.kind === 'open' && cell && cell.v === null) cell.v = '';
    } else if (tag === 'is') {
      inInline = scan.kind === 'open';
    } else if (tag === 't') {
      inInlineText = scan.kind === 'open';
    }
  }
  if (!endRow()) return { rows, truncated: true };
  return { rows, truncated: false };
}

export function xlsxText(files: Map<string, Uint8Array>): { text: string; sheets: number; truncated: boolean } {
  const workbook = utf8Decode(files.get('xl/workbook.xml'));
  if (!workbook) throw new AttachError('BAD_FILE', '스프레드시트의 시트 목록을 찾지 못했습니다');
  // 태그 이름은 접두어를 떼고 본다 — .NET 계열(Open XML SDK · ClosedXML)은 <x:sheet> 처럼 접두어를 붙여 쓴다
  const sheetList: Array<{ name: string; rid: string }> = [];
  let date1904 = false;
  const wb = new XmlScan(workbook);
  while (wb.next()) {
    if (wb.kind === 'text' || wb.kind === 'close') continue;
    if (wb.local === 'workbookPr') date1904 = /^(1|true)$/.test(wb.attr('date1904') ?? '');
    else if (wb.local === 'sheet') sheetList.push({ name: wb.attr('name') ?? '', rid: wb.attr('r:id') ?? '' });
  }
  const shared = sharedStrings(utf8Decode(files.get('xl/sharedStrings.xml')));
  const styles = cellStyleKinds(utf8Decode(files.get('xl/styles.xml')));
  const rels = relationships(utf8Decode(files.get('xl/_rels/workbook.xml.rels')), 'xl');
  const parts: string[] = [];
  let truncated = false;
  sheetList.forEach((sheet, i) => {
    const name = sheet.name || `시트 ${i + 1}`;
    const xml = utf8Decode(files.get(rels.get(sheet.rid) ?? `xl/worksheets/sheet${i + 1}.xml`));
    if (!xml) return;
    const read = sheetRows(xml, shared, styles, date1904);
    parts.push(`## 시트: ${name}${read.rows.length === 0 ? ' (빈 시트)' : ''}`);
    if (read.rows.length > 0) parts.push(read.rows.join('\n'));
    if (read.truncated) {
      truncated = true;
      parts.push(`(이 시트는 ${ATTACH_LIMITS.sheetRows}행까지만 읽었습니다)`);
    }
  });
  return { text: parts.join('\n\n').trim(), sheets: sheetList.length, truncated };
}

// ─── pptx ────────────────────────────────────────────────

export function pptxText(files: Map<string, Uint8Array>): { text: string; slides: number } {
  // 슬라이드 순서는 presentation.xml 의 sldIdLst — 파일 번호는 만든 순서일 뿐이다
  const rels = relationships(utf8Decode(files.get('ppt/_rels/presentation.xml.rels')), 'ppt');
  let order: string[] = [];
  const pres = new XmlScan(utf8Decode(files.get('ppt/presentation.xml')));
  while (pres.next()) {
    if (pres.kind === 'text' || pres.kind === 'close' || pres.local !== 'sldId') continue;
    const file = rels.get(pres.attr('r:id') ?? '');
    if (file && files.has(file)) order.push(file);
  }
  if (order.length === 0) {
    const num = (f: string) => Number(/slide(\d+)\.xml$/.exec(f)?.[1] ?? 0);
    order = [...files.keys()].filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => num(a) - num(b));
  }
  if (order.length === 0) throw new AttachError('BAD_FILE', '발표 자료의 슬라이드를 찾지 못했습니다');
  const parts = order.map((file, i) => {
    const body = markupText(utf8Decode(files.get(file)), DRAWING);
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
