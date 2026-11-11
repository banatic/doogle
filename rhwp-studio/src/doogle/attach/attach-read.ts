/**
 * 참고 파일(첨부) 읽기 — 브라우저에서 파일 하나를 hub 로 보낼 모양(글·그림)으로 바꾼다.
 *
 *  - 글 파일: 인코딩을 풀어 그대로 (attach-core.ts decodeText)
 *  - docx · xlsx · pptx: zip 안의 XML 에서 글만 (attach-core.ts officeText)
 *  - hwp · hwpx · pdf: 문서 엔진(WASM)으로 따로 열어 글만 꺼낸 뒤 바로 닫는다. 편집기에 열린 문서는 건드리지 않는다.
 *    글이 없는 PDF(스캔본)는 앞쪽 몇 쪽을 그림으로 보낸다.
 *  - 그림: 긴 변을 줄여 JPEG/PNG 로 다시 담는다.
 *
 * 원본 바이트는 어디에도 보내지 않는다 — 여기서 만든 글·그림만 hub 로 간다.
 */
import { Engine } from '../agent/engine-adapter.ts';
import {
  ATTACH_LIMITS, AttachError, classifyFile, clipText, decodeText, fitWithin, formatBytes, officeText,
  type AttachImage, type AttachmentPayload, type AttachMeta,
} from './attach-core.ts';
import { engineDocumentText, pagedDocumentText } from './doc-text.ts';

/** 글이 없는 쪽(스캔본)을 그림으로 보내는 수 */
const SCANNED_PDF_PAGES = 8;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

async function canvasImage(canvas: HTMLCanvasElement, mimeType: 'image/jpeg' | 'image/png', label?: string): Promise<AttachImage> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.88));
  if (!blob) throw new AttachError('IMAGE_FAILED', '그림을 담지 못했습니다');
  return {
    mimeType,
    base64: toBase64(new Uint8Array(await blob.arrayBuffer())),
    width: canvas.width,
    height: canvas.height,
    ...(label ? { label } : {}),
  };
}

/** 그림 파일 → 긴 변을 줄인 그림. 투명한 PNG·GIF·WebP 는 PNG 로, 나머지는 JPEG 로 담는다 */
async function readImage(file: File): Promise<AttachImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AttachError('BAD_IMAGE', '그림을 열지 못했습니다');
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new AttachError('IMAGE_FAILED', '그림을 담지 못했습니다');
    const keepAlpha = /png|gif|webp/i.test(file.type) || /\.(png|gif|webp)$/i.test(file.name);
    if (!keepAlpha) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    return await canvasImage(canvas, keepAlpha ? 'image/png' : 'image/jpeg');
  } finally {
    bitmap.close();
  }
}

type WasmDoc = { free(): void; [method: string]: unknown };
type WasmDocClass = { new(data: Uint8Array): WasmDoc; supportsPdfImport?: () => unknown };

/** 문서 엔진 모듈 — 편집기가 이미 올려 둔 것을 함께 쓴다 */
async function engineModule(): Promise<{ HwpDocument: WasmDocClass }> {
  const mod = await import('@wasm/rhwp.js') as unknown as { default: () => Promise<unknown>; HwpDocument: WasmDocClass };
  await mod.default(); // 이미 올라와 있으면 바로 돌아온다
  return mod;
}

/** 한글 문서·PDF 를 엔진으로 따로 열어 글(글이 없으면 쪽 그림)을 꺼낸다 */
async function readWithEngine(bytes: Uint8Array, kind: 'hwp' | 'pdf'): Promise<{ text: string; images: AttachImage[]; meta: AttachMeta }> {
  const { HwpDocument } = await engineModule();
  if (kind === 'pdf' && HwpDocument.supportsPdfImport?.() !== true) {
    throw new AttachError('UNSUPPORTED_TYPE', '이 버전은 PDF 를 읽지 못합니다');
  }
  let doc: WasmDoc;
  try {
    doc = new HwpDocument(bytes);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (/password|암호|encrypt/i.test(why)) throw new AttachError('ENCRYPTED', '암호가 걸린 문서는 읽지 못합니다');
    throw new AttachError('BAD_FILE', kind === 'pdf' ? 'PDF 를 열지 못했습니다' : '한글 문서를 열지 못했습니다');
  }
  try {
    const engine = new Engine(doc);
    if (kind === 'hwp') {
      const read = engineDocumentText(engine, ATTACH_LIMITS.textChars);
      return { text: read.text, images: [], meta: { ...(read.pages > 0 ? { pages: read.pages } : {}), ...(read.truncated ? { truncated: true } : {}) } };
    }
    // PDF: 엔진은 쪽마다 글상자로 연다(본문 문단이 없다) — 쪽 배치에서 글을 읽는다. 쪽 번호가 원본 그대로다
    const read = pagedDocumentText(engine, ATTACH_LIMITS.textChars);
    const meta: AttachMeta = { ...(read.pages > 0 ? { pages: read.pages } : {}), ...(read.truncated ? { truncated: true } : {}) };
    const images: AttachImage[] = [];
    // 글이 없는 쪽(스캔본)은 그림으로 보낸다 — 에이전트가 그림으로 읽는다
    if (read.emptyPages.length > 0 && engine.has('renderPageToCanvas')) {
      for (const page of read.emptyPages.slice(0, SCANNED_PDF_PAGES)) {
        try {
          const info = engine.pageInfo(page);
          const scale = Math.min(2, ATTACH_LIMITS.imageEdge / Math.max(1, info['width'] ?? 800, info['height'] ?? 1100));
          const canvas = document.createElement('canvas');
          engine.call('renderPageToCanvas', page, canvas, scale);
          images.push(await canvasImage(canvas, 'image/jpeg', `${page + 1}쪽`));
        } catch { /* 그 쪽은 건너뛴다 */ }
      }
      if (images.length > 0) {
        meta.note = read.emptyPages.length > images.length
          ? `글이 없는 쪽 ${read.emptyPages.length}쪽 가운데 앞 ${images.length}쪽을 그림으로 담았습니다`
          : `글이 없는 쪽 ${images.length}쪽을 그림으로 담았습니다`;
      }
    }
    return { text: read.text, images, meta };
  } finally {
    try { doc.free(); } catch { /* 이미 풀렸다 */ }
  }
}

/**
 * 파일 하나를 읽어 hub 로 보낼 첨부로 만든다. 읽지 못하면 AttachError(사용자에게 보일 사유).
 */
export async function readAttachment(file: File): Promise<AttachmentPayload> {
  if (file.size > ATTACH_LIMITS.fileBytes) {
    throw new AttachError('TOO_LARGE', `파일이 너무 큽니다 (${formatBytes(file.size)} · ${formatBytes(ATTACH_LIMITS.fileBytes)}까지)`);
  }
  if (file.size === 0) throw new AttachError('EMPTY', '빈 파일입니다');
  const kind = classifyFile(file.name, file.type);
  const base = { name: file.name, kind, mime: file.type || '', size: file.size };
  if (kind === 'image') return { ...base, images: [await readImage(file)] };

  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  let images: AttachImage[] = [];
  let meta: AttachMeta = {};
  if (kind === 'text') {
    const decoded = decodeText(bytes);
    text = decoded.text;
    if (decoded.encoding !== 'utf-8') meta.encoding = decoded.encoding;
  } else if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
    ({ text, meta } = await officeText(kind, bytes));
  } else {
    ({ text, images, meta } = await readWithEngine(bytes, kind));
  }
  const clipped = clipText(text);
  if (clipped.truncated) meta.truncated = true;
  if (!clipped.text.trim() && images.length === 0) {
    throw new AttachError('EMPTY', kind === 'pdf' ? '글을 찾지 못했습니다 (그림으로만 된 PDF)' : '읽을 글이 없습니다');
  }
  return {
    ...base,
    ...(clipped.text.trim() ? { text: clipped.text } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}
