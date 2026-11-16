/**
 * 문서가 없을 때의 캔버스 빈 상태 (UI_AUDIT §3.5).
 *
 * `#scroll-container` 위에 얹는 안내 막: "새 문서 / 열기…" + 최근 문서 3개 + 끌어다 놓기 안내.
 * 끌어다 놓기는 upstream `main.ts` 의 `#scroll-container` drop 처리기가 그대로 받는다 — 이 막은
 * 그 자식이라 drop 이벤트가 버블링으로 올라간다(열기 경로를 복제하지 않는다).
 * 최근 문서는 upstream 파일 메뉴의 `#recent-docs-panel` 항목을 읽어 그 요소를 click 한다.
 */
import type { PluginHost } from '@/plugin/types';
import { icon } from './icons.ts';
import './empty-canvas.css';

export interface EmptyCanvasOptions {
  /** 열기 (데스크탑이면 기본 파일 대화상자) */
  openDocument(): void;
  /** 최근 문서를 기억해 둔 경로로 연다(데스크탑). 열기를 시작했으면 true — false 면 upstream 의 최근 문서 열기로 간다 */
  openRecent?(fileName: string): boolean;
}

const MAX_RECENT = 3;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** upstream 파일 메뉴가 최근 목록을 다시 그리게 한다(숨긴 메뉴 제목에 열기→닫기). */
function refreshRecent(): void {
  const title = document.querySelector<HTMLElement>('#menu-bar .menu-item[data-menu="file"] .menu-title');
  if (!title) return;
  title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  title.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
}

export function mountEmptyCanvas(host: PluginHost, options: EmptyCanvasOptions): () => void {
  // 문서 탭: 시작 화면은 "문서 없음" 자리(원래의 스크롤 영역)에 붙는다 — 문서마다 있는 스크롤 영역이 아니다
  const container = document.querySelector<HTMLElement>('.dg-ws-empty > .dg-doc-view') ?? document.getElementById('scroll-container');
  if (!container) return () => {};

  const root = el('div', 'dg-canvas-empty');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', '문서 없음');
  const box = el('div', 'dg-ce-box');
  const title = el('h2', 'dg-ce-title', '문서를 열어 시작하세요');
  const sub = el('p', 'dg-ce-sub', 'HWP · HWPX 파일을 열거나 새 문서를 만듭니다.');
  const acts = el('div', 'dg-ce-acts');
  const create = el('button', 'dg-ce-btn dg-ce-primary');
  create.type = 'button';
  create.append(icon('file', 16), el('span', '', '새 문서'));
  create.addEventListener('click', () => { void host.createBlankDocument({ confirmUnsaved: true }); });
  const open = el('button', 'dg-ce-btn');
  open.type = 'button';
  open.append(icon('folder', 16), el('span', '', '열기…'));
  open.addEventListener('click', () => options.openDocument());
  acts.append(create, open);

  const recentHead = el('h3', 'dg-ce-recent-head', '최근 문서');
  const recent = el('ul', 'dg-ce-recent');
  recent.setAttribute('aria-label', '최근 문서');
  const drop = el('p', 'dg-ce-drop', '.hwp · .hwpx 파일을 여기에 끌어다 놓아도 됩니다');
  box.append(title, sub, acts, recentHead, recent, drop);
  root.append(box);

  const renderRecent = () => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('#recent-docs-panel > .md-item'))
      .filter((item) => !item.classList.contains('disabled'))
      .slice(0, MAX_RECENT);
    recent.replaceChildren();
    for (const item of items) {
      const name = (item.querySelector('.md-label')?.textContent ?? '').trim();
      if (!name) continue;
      const meta = (item.querySelector('.md-shortcut')?.textContent ?? '').trim();
      const li = el('li', '');
      const b = el('button', 'dg-ce-recent-item');
      b.type = 'button';
      if (item.title) b.title = item.title;
      b.append(icon('file', 14), el('span', 'dg-ce-recent-name', name), el('span', 'dg-ce-recent-meta', meta));
      // 데스크탑에서 경로를 아는 문서는 그 경로로 바로 연다 — upstream 항목은 파일 손잡이가 없으면 다시 고르게 한다
      b.addEventListener('click', () => { if (!options.openRecent?.(name)) item.click(); });
      li.append(b);
      recent.append(li);
    }
    const none = recent.childElementCount === 0;
    recentHead.hidden = none;
    recent.hidden = none;
  };

  let observer: MutationObserver | null = null;
  const watchRecent = () => {
    if (observer) return;
    const panel = document.getElementById('recent-docs-panel');
    if (!panel) return;
    observer = new MutationObserver(renderRecent);
    observer.observe(panel, { childList: true });
  };

  let shown = false;
  const update = () => {
    const empty = host.borrowDocument() === null;
    if (empty === shown) return;
    shown = empty;
    if (empty) {
      container.classList.add('dg-has-empty');
      container.append(root);
      watchRecent();
      refreshRecent();
      renderRecent();
    } else {
      container.classList.remove('dg-has-empty');
      root.remove();
    }
  };

  const offs = [
    host.onDocumentSwap(() => update()),
    host.events.on('document-changed', () => update()),
  ];
  // 문서 탭: 마지막 탭을 닫으면 문서 교체 없이 문서가 없어진다
  const onDocFocus = () => update();
  window.addEventListener('doogle:doc-focus', onDocFocus);
  offs.push(() => window.removeEventListener('doogle:doc-focus', onDocFocus));
  update();

  return () => {
    for (const off of offs) off();
    observer?.disconnect();
    container.classList.remove('dg-has-empty');
    root.remove();
  };
}
