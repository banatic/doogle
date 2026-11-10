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
import { readFileSync } from 'fs';
import { resolve } from 'path';
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
