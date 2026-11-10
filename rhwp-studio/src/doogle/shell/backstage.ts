/**
 * '파일' 백스테이지 — 숨긴 upstream 파일 메뉴(#menu-bar [data-menu=file])를 큰 목록으로 펼친다.
 * 왼쪽: 파일 명령(새로 만들기·열기·저장·내보내기·인쇄…), 오른쪽: 최근 문서.
 * role=dialog(aria-modal) + Esc 닫기 + 포커스 가두기. 항목 실행은 upstream 메뉴와 같은 규칙.
 */
import { iconSvg } from './icons';
import { commandShortcut, hasCommand, isEnabled } from './studio';
import { activateUpstreamItem, menuBody, refreshRecentDocs } from './upstream-menu';
import { isDesk } from '../ui/desk-bridge';
import { checkForUpdates, currentVersion, openUpdatePopover } from './updater';

const ICONS: Record<string, string> = {
  'file:new-doc': 'newDoc',
  'file:open': 'open',
  'ext:doogle.open-native': 'open',
  'file:save': 'save',
  'file:save-as': 'save',
  'file:print-to-pdf': 'export',
  'file:save-as-hwp': 'export',
  'file:save-as-hwpx': 'export',
  'file:export-html': 'export',
  'file:export-doc': 'export',
  'file:page-setup': 'pageSetup',
  'file:print': 'print',
  'file:about': 'info',
};

export class Backstage {
  private root: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;

  get isOpen(): boolean { return !!this.root; }

  open(from: HTMLElement): void {
    if (this.root) return;
    this.returnFocus = from;
    refreshRecentDocs();

    const root = document.createElement('div');
    root.className = 'dg-backstage';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '파일');

    const nav = document.createElement('nav');
    nav.className = 'dg-bs-nav';
    nav.setAttribute('aria-label', '파일 명령');

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'dg-bs-back';
    back.innerHTML = `${iconSvg('back', 16, 2)}<span>돌아가기</span>`;
    back.addEventListener('click', () => this.close());
    nav.appendChild(back);

    const body = menuBody('file');
    const recentSub = body?.querySelector<HTMLElement>('[data-recent]') ?? null;
    if (body) {
      for (const el of Array.from(body.children) as HTMLElement[]) {
        if (el === recentSub || el.hidden) continue;
        if (el.classList.contains('md-sep')) {
          const sep = document.createElement('div');
          sep.className = 'dg-bs-sep';
          nav.appendChild(sep);
          continue;
        }
        if (el.classList.contains('md-sub')) {
          const heading = document.createElement('div');
          heading.className = 'dg-bs-heading';
          heading.textContent = (el.querySelector('.md-label')?.textContent ?? '').trim();
          nav.appendChild(heading);
          for (const item of Array.from(el.querySelectorAll<HTMLElement>('.md-sub-panel > .md-item'))) {
            const b = this.itemButton(item, true);
            if (b) nav.appendChild(b);
          }
          continue;
        }
        if (el.classList.contains('md-item')) {
          const b = this.itemButton(el, false);
          if (b) nav.appendChild(b);
        }
      }
    }

    this.appendUpdateSection(nav);

    const main = document.createElement('section');
    main.className = 'dg-bs-main';
    main.setAttribute('aria-label', '최근 문서');
    const title = document.createElement('h2');
    title.className = 'dg-bs-title';
    title.textContent = '최근 문서';
    const list = document.createElement('div');
    list.className = 'dg-bs-recent';
    list.setAttribute('role', 'list');
    main.append(title, list);
    const renderRecent = () => {
      list.replaceChildren();
      const items = Array.from(document.querySelectorAll<HTMLElement>('#recent-docs-panel > .md-item'));
      for (const item of items) {
        const disabled = item.classList.contains('disabled');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dg-bs-recent-item';
        b.setAttribute('role', 'listitem');
        const label = (item.querySelector('.md-label')?.textContent ?? '').trim();
        const right = (item.querySelector('.md-shortcut')?.textContent ?? '').trim();
        b.innerHTML = `${iconSvg('newDoc', 18, 1.6)}<span class="dg-bs-recent-name"></span><span class="dg-bs-recent-meta"></span>`;
        (b.querySelector('.dg-bs-recent-name') as HTMLElement).textContent = label;
        (b.querySelector('.dg-bs-recent-meta') as HTMLElement).textContent = right;
        if (item.title) b.title = item.title;
        if (disabled) b.setAttribute('aria-disabled', 'true');
        b.addEventListener('click', () => {
          if (disabled) return;
          this.close(false);
          activateUpstreamItem(item, b);
        });
        list.appendChild(b);
      }
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'dg-bs-empty';
        empty.textContent = '최근 문서가 없습니다.';
        list.appendChild(empty);
      }
    };
    renderRecent();
    // 최근 목록은 비동기로 다시 그려진다(IndexedDB 조회).
    const panel = document.getElementById('recent-docs-panel');
    const mo = panel ? new MutationObserver(renderRecent) : null;
    if (panel) mo!.observe(panel, { childList: true });

    root.append(nav, main);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if (e.key === 'Tab') {
        const f = Array.from(root.querySelectorAll<HTMLElement>('button:not([aria-disabled="true"])'));
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const f = Array.from(nav.querySelectorAll<HTMLElement>('button'));
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        e.preventDefault();
        f[(i + (e.key === 'ArrowDown' ? 1 : -1) + f.length) % f.length].focus();
      }
    });
    (root as HTMLElement & { _dgCleanup?: () => void })._dgCleanup = () => mo?.disconnect();
    document.getElementById('studio-root')?.appendChild(root) ?? document.body.appendChild(root);
    this.root = root;
    from.setAttribute('aria-expanded', 'true');
    (nav.querySelector<HTMLElement>('.dg-bs-item:not([aria-disabled="true"])') ?? back).focus();
  }

  close(restoreFocus = true): void {
    const root = this.root;
    if (!root) return;
    (root as HTMLElement & { _dgCleanup?: () => void })._dgCleanup?.();
    root.remove();
    this.root = null;
    this.returnFocus?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.returnFocus?.focus();
  }

  /** 데스크탑: 현재 버전 + '업데이트 확인'. 새 버전이 있으면 백스테이지를 닫고 제목 막대 팝오버를 연다. */
  private appendUpdateSection(nav: HTMLElement): void {
    if (!isDesk()) return;
    const wrap = document.createElement('div');
    wrap.className = 'dg-bs-update';
    const sep = document.createElement('div');
    sep.className = 'dg-bs-sep';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dg-bs-item';
    b.innerHTML = `${iconSvg('info', 18, 1.7)}<span class="dg-bs-item-label">업데이트 확인</span>`;
    const version = document.createElement('div');
    version.className = 'dg-bs-version';
    version.setAttribute('aria-live', 'polite');
    version.textContent = '두글';
    let busy = false;
    void currentVersion().then((v) => { if (v && !busy) version.textContent = `두글 v${v}`; });
    b.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      b.setAttribute('aria-disabled', 'true');
      version.textContent = '확인하는 중…';
      const result = await checkForUpdates();
      busy = false;
      b.removeAttribute('aria-disabled');
      const v = await currentVersion();
      if (result.kind === 'available') {
        version.textContent = `새 버전 v${result.info.version}`;
        this.close(false);
        openUpdatePopover();
      } else if (result.kind === 'latest') {
        version.textContent = `두글 v${v ?? ''} — 최신 버전입니다`;
      } else {
        version.textContent = `확인하지 못했습니다: ${result.message}`;
      }
    });
    wrap.append(sep, b, version);
    nav.appendChild(wrap);
  }

  private itemButton(item: HTMLElement, nested: boolean): HTMLButtonElement | null {
    const cmd = item.dataset.cmd;
    if (cmd && !hasCommand(cmd)) return null;
    const label = (item.querySelector('.md-label')?.textContent ?? item.textContent ?? '').trim();
    if (!label) return null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dg-bs-item';
    if (nested) b.classList.add('dg-bs-item--nested');
    const icon = cmd ? ICONS[cmd] ?? 'more' : 'more';
    b.innerHTML = `${iconSvg(icon, 18, 1.7)}<span class="dg-bs-item-label"></span><span class="dg-bs-item-sc"></span>`;
    (b.querySelector('.dg-bs-item-label') as HTMLElement).textContent = label;
    const sc = cmd ? commandShortcut(cmd) : undefined;
    if (sc) (b.querySelector('.dg-bs-item-sc') as HTMLElement).textContent = sc;
    const enabled = cmd ? isEnabled(cmd) : !item.classList.contains('disabled');
    if (!enabled) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      // 대화상자·파일 선택기가 뜨기 전에 백스테이지를 닫는다.
      this.close(false);
      activateUpstreamItem(item, b);
    });
    return b;
  }
}
