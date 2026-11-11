/**
 * [doogle] 두글 데스크탑 진입 페이지(doogle.html) 조립.
 *
 * doogle.html 은 upstream 화면 가운데 두글 셸이 실제로 쓰는 조각만 담는다. 그 조각(메뉴 정의,
 * 서식 도구 모음, 상태 표시줄, 편집 영역 …)의 정본은 여전히 upstream index.html 이므로, 마크업을
 * 베껴 두지 않고 빌드·개발 서버에서 index.html 에서 그대로 떼어 온다 — upstream 을 병합해
 * 메뉴 항목이 늘거나 바뀌어도 doogle.html 이 어긋나지 않는다.
 *
 *   <!-- @upstream id="menu-bar" -->
 *
 * 표시는 index.html 에서 그 글자열을 여는 태그 안에 가진 첫 요소로 바뀐다(닫는 태그까지 통째로).
 * 찾지 못하거나 짝이 맞지 않으면 빌드를 멈춘다 — 조용히 빠진 조각이 런타임 null 로 번지지 않게.
 */
import { cpSync, existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { extname, join, resolve } from 'path';
import type { Plugin } from 'vite';

const MARKER = /<!--\s*@upstream\s+([\s\S]+?)\s*-->/g;
const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'col', 'area', 'base', 'wbr', 'embed', 'track']);

/** `html` 에서 여는 태그 안에 `needle` 을 가진 첫 요소의 바깥 HTML. */
export function extractElement(html: string, needle: string): string {
  const at = html.indexOf(needle);
  if (at < 0) throw new Error(`[doogle-html] index.html 에서 '${needle}' 를 찾지 못했습니다`);
  const start = html.lastIndexOf('<', at);
  const openEnd = html.indexOf('>', at);
  const tag = /^<([a-zA-Z][\w-]*)/.exec(html.slice(start))?.[1]?.toLowerCase();
  if (start < 0 || openEnd < 0 || !tag || html.slice(start, at).includes('>')) {
    throw new Error(`[doogle-html] '${needle}' 가 여는 태그 안에 있지 않습니다`);
  }
  if (VOID_TAGS.has(tag) || html[openEnd - 1] === '/') return html.slice(start, openEnd + 1);

  // 같은 이름의 태그만 세어 짝을 맞춘다. 주석 안의 태그는 건너뛴다.
  const re = new RegExp(`<!--[\\s\\S]*?-->|<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = openEnd + 1;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].startsWith('<!--')) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`[doogle-html] '${needle}' 의 <${tag}> 닫는 태그를 찾지 못했습니다`);
}

/**
 * [doogle] 웹 글꼴(public/fonts → ../../assets/fonts 심볼릭 링크) 보정.
 *
 * Windows 에서 git 은 심볼릭 링크를 경로 글자가 든 보통 파일로 checkout 한다(core.symlinks=false 기본값 —
 * GitHub Actions windows 러너도 같다). 그러면 빌드에 글꼴이 하나도 들어가지 않아 문서가
 * "폰트 로딩 중" 에서 멈춘다. public/fonts 가 폴더가 아니면 개발 서버는 /fonts/* 를 assets/fonts 에서
 * 내주고, 빌드는 dist/fonts 에 assets/fonts 를 복사한다. 링크가 제대로 풀린 checkout 에서는 아무것도 안 한다.
 */
export function doogleFonts(root: string): Plugin {
  const linked = resolve(root, 'public', 'fonts');
  const source = resolve(root, '..', 'assets', 'fonts');
  const broken = () => {
    try { return !statSync(linked).isDirectory(); } catch { return true; }
  };
  const MIME: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
  let outDir = resolve(root, 'dist');
  return {
    name: 'doogle-fonts',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      if (!broken() || !existsSync(source)) return;
      server.middlewares.use('/fonts', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        if (!name || name.includes('..')) return next();
        try {
          const data = readFileSync(join(source, name));
          res.setHeader('Content-Type', MIME[extname(name).toLowerCase()] ?? 'application/octet-stream');
          res.end(data);
        } catch {
          next();
        }
      });
    },
    writeBundle() {
      if (!broken() || !existsSync(source)) return;
      const dest = join(outDir, 'fonts');
      // 링크 글자 파일이 dist 에 그대로 복사돼 있다 — 지우고 진짜 글꼴로 바꾼다
      if (existsSync(dest) && !statSync(dest).isDirectory()) unlinkSync(dest);
      // filter 를 주면 Node 24 의 네이티브 cpSync(비 ASCII 경로에서 0xC0000409 로 죽는다) 대신 JS 구현을 쓴다
      cpSync(source, dest, { recursive: true, filter: () => true });
    },
  };
}

export function doogleHtml(root: string): Plugin {
  return {
    name: 'doogle-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!/(^|[\\/])doogle\.html$/.test(ctx.filename) && ctx.path !== '/doogle.html') return html;
        // 개발 서버에서도 매번 다시 읽는다 — index.html 을 고치면 새로 고침만으로 반영된다.
        const upstream = readFileSync(resolve(root, 'index.html'), 'utf-8');
        return html.replace(MARKER, (_, needle: string) => extractElement(upstream, needle.trim()));
      },
    },
  };
}
