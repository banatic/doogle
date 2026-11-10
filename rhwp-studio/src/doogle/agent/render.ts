// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/tool-executor.ts (renderPage / attachWriteReport image path)
/**
 * 쪽 래스터화와 PNG 인코딩 — render_page 와 쓰기 결과의 render:"crop"|"page".
 *
 * 그리는 순서: deps.renderPageToCanvas(studio 의 WasmBridge — 글꼴 해석 문맥 포함) → 원시 문서의
 * renderPageToCanvas → renderPageSvg 를 이미지로 래스터. 브라우저(webview) 밖에서는 PNG 를 만들 수
 * 없으므로 RENDER_UNAVAILABLE 로 거절한다.
 */
import { Engine } from './engine-adapter.ts';
import { planStack, RENDER_STACK_GAP_PX, type CropRegion } from './write-report.ts';
import { DoogleToolError, type DoogleAgentDeps, type PngImage } from './types.ts';

type Canvas2D = {
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string;
};

function createCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined') {
    throw new DoogleToolError('RENDER_UNAVAILABLE', 'Page images need the studio window; this host cannot rasterize pages. Use get_page_geometry or get_structure instead.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  return canvas;
}

async function svgToCanvas(svg: string, scale: number): Promise<HTMLCanvasElement> {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg rasterization failed'));
      img.src = url;
    });
    const canvas = createCanvas(img.naturalWidth * scale, img.naturalHeight * scale);
    const ctx = canvas.getContext('2d') as unknown as Canvas2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 쪽 하나를 scale 배율로 그린 캔버스 (쪽 px 좌표 × scale). */
export async function rasterizePage(deps: DoogleAgentDeps, engine: Engine, pageIndex: number, scale: number): Promise<HTMLCanvasElement> {
  if (typeof document !== 'undefined') {
    if (deps.renderPageToCanvas) {
      const canvas = createCanvas(1, 1);
      deps.renderPageToCanvas(pageIndex, canvas, scale);
      return canvas;
    }
    if (engine.has('renderPageToCanvas')) {
      const canvas = createCanvas(1, 1);
      engine.call('renderPageToCanvas', pageIndex, canvas, scale);
      return canvas;
    }
  }
  if (!engine.has('renderPageSvg')) {
    throw new DoogleToolError('ENGINE_UNSUPPORTED', 'This engine build cannot render pages.');
  }
  const svg = String(engine.call('renderPageSvg', pageIndex));
  if (typeof document === 'undefined') {
    throw new DoogleToolError('RENDER_UNAVAILABLE', 'Page images need the studio window; use format "svg" instead.');
  }
  return svgToCanvas(svg, scale);
}

function canvasToPng(canvas: HTMLCanvasElement): PngImage {
  const url = canvas.toDataURL('image/png');
  const base64 = url.slice(url.indexOf(',') + 1);
  return { mimeType: 'image/png', base64, width: canvas.width, height: canvas.height };
}

/** 쪽 전체 또는 일부(쪽 px 영역)를 PNG 로. */
export async function renderPagePng(
  deps: DoogleAgentDeps, engine: Engine, pageIndex: number, scale: number,
  region?: { x: number; y: number; width: number; height: number },
): Promise<PngImage> {
  const page = await rasterizePage(deps, engine, pageIndex, scale);
  if (!region) return canvasToPng(page);
  const sx = Math.max(0, Math.floor(region.x * scale));
  const sy = Math.max(0, Math.floor(region.y * scale));
  const sw = Math.max(1, Math.min(page.width - sx, Math.ceil(region.width * scale)));
  const sh = Math.max(1, Math.min(page.height - sy, Math.ceil(region.height * scale)));
  const out = createCanvas(sw, sh);
  const ctx = out.getContext('2d') as unknown as Canvas2D;
  ctx.drawImage(page, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvasToPng(out);
}

/**
 * 변경 영역들을 위에서 아래로 쌓은 PNG 한 장 (write-report planStack 의 배율·예산을 따른다).
 * 반환 regions 는 실제로 실은 영역(renderRegions 보고용).
 */
export async function renderStackedRegions(
  deps: DoogleAgentDeps, engine: Engine, regions: readonly CropRegion[],
): Promise<{ image: PngImage; regions: CropRegion[]; omitted: number; clipped: boolean } | null> {
  const plan = planStack(regions);
  if (plan.regions.length === 0 || plan.widthPx <= 0 || plan.heightPx <= 0) return null;
  const out = createCanvas(plan.widthPx, plan.heightPx);
  const ctx = out.getContext('2d') as unknown as Canvas2D;
  ctx.fillStyle = '#9aa0a6';
  ctx.fillRect(0, 0, out.width, out.height);
  const pages = new Map<number, HTMLCanvasElement>();
  let y = 0;
  for (const region of plan.regions) {
    let page = pages.get(region.pageIndex);
    if (!page) {
      page = await rasterizePage(deps, engine, region.pageIndex, plan.scale);
      pages.set(region.pageIndex, page);
    }
    const sx = Math.floor(region.x * plan.scale);
    const sy = Math.floor(region.y * plan.scale);
    const sw = Math.max(1, Math.min(page.width - sx, Math.ceil(region.width * plan.scale)));
    const sh = Math.max(1, Math.min(page.height - sy, Math.ceil(region.height * plan.scale)));
    ctx.drawImage(page, sx, sy, sw, sh, 0, y, sw, sh);
    y += sh + RENDER_STACK_GAP_PX;
  }
  return { image: canvasToPng(out), regions: plan.regions, omitted: plan.omitted, clipped: plan.clipped };
}
