/**
 * '파일' 백스테이지(UI_AUDIT 3.6).
 *
 * 왼쪽: 세 덩이로 나눈 파일 명령 — 주요(새로 만들기·열기·저장·다른 이름으로) / 내보내기 / 인쇄 / 정보.
 *       명령 정본은 여전히 숨긴 upstream 파일 메뉴(#menu-bar [data-menu=file])와 커맨드 레지스트리다.
 *       목록에 없는 upstream 항목(플러그인이 더한 것)은 '기타'로 빠짐없이 붙인다.
 * 오른쪽: '새로 만들기' 줄(빈 문서 + 데스크탑 템플릿) + 최근 문서 카드(형식·폴더·연 시각·고정).
 *
 * role=dialog(aria-modal) + Esc 닫기 + 포커스 가두기. 항목 실행은 upstream 메뉴와 같은 규칙.
 */
import { listRecentDocs, type RecentDoc } from '@/recent/recent-store';
import { iconSvg } from './icons';
import { guardedSave } from './close-guard';
import { rememberedPath } from './doc-state';
import { commandLabel, commandShortcut, hasCommand, isEnabled, run } from './studio';
import { activateUpstreamItem, menuBody, refreshRecentDocs } from './upstream-menu';
import { invoke, isDesk } from '../ui/desk-bridge';
import { checkForUpdates, currentVersion, lastUpdateCheck, openUpdatePopover, type CheckResult } from './updater';

const PINS_KEY = 'doogle.recent.pins';
const OPEN_NATIVE = 'ext:doogle.open-native';

interface NavDef { cmd: string; label: string; icon: string }
interface NavSection { heading?: string; items: NavDef[] }

const SECTIONS: NavSection[] = [
  {
    items: [
      { cmd: 'file:new-doc', label: '새로 만들기', icon: 'newDoc' },
      { cmd: 'file:open', label: '열기', icon: 'open' },
      { cmd: 'file:save', label: '저장', icon: 'save' },
      { cmd: 'file:save-as', label: '다른 이름으로 저장', icon: 'saveAs' },
    ],
  },
  {
    heading: '내보내기',
    items: [
      { cmd: 'file:print-to-pdf', label: 'PDF로 저장', icon: 'pdf' },
      { cmd: 'file:save-as-hwp', label: 'HWP 형식으로 저장', icon: 'fileHwp' },
      { cmd: 'file:save-as-hwpx', label: 'HWPX 형식으로 저장', icon: 'fileHwp' },
      { cmd: 'file:export-html', label: 'HTML로 내보내기', icon: 'html' },
      { cmd: 'file:export-doc', label: 'Word 문서(.doc)로 내보내기', icon: 'word' },
    ],
  },
  {
    heading: '인쇄',
    items: [
      { cmd: 'file:print', label: '인쇄', icon: 'print' },
      { cmd: 'file:page-setup', label: '편집 용지', icon: 'pageSetup' },
    ],
  },
];

/** 다루는 것으로 치는 upstream 항목(나머지는 '기타'로) */
const HANDLED = new Set([...SECTIONS.flatMap((s) => s.items.map((i) => i.cmd)), 'file:about', 'file:open-recent', 'file:clear-recent', OPEN_NATIVE]);

interface TemplateInfo { name: string; path: string }

function readPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writePins(pins: string[]): void {
  try { localStorage.setItem(PINS_KEY, JSON.stringify(pins)); } catch { /* 이번 세션만 */ }
}

/** "방금 전 / 3분 전 / 오늘 17:42 / 어제 17:42 / 3일 전 / 11-04" */
export function relativeTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const diff = now - at;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < 60_000) return '방금 전';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) return `오늘 ${hm}`;
  if (at >= today.getTime() - 86_400_000) return `어제 ${hm}`;
  const days = Math.floor((today.getTime() - at) / 86_400_000) + 1;
  if (days < 7) return `${days}일 전`;
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return d.getFullYear() === today.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i > 0 ? path.slice(0, i + 1) : '';
}

function checkText(result: CheckResult, version: string | null): string {
  if (result.kind === 'available') return `새 버전 v${result.info.version}이 있습니다`;
  if (result.kind === 'latest') return `두글 v${version ?? ''} · 최신 버전입니다`;
  const reason = /network|connect|dns|timed? ?out|request/i.test(result.message) ? '네트워크' : result.message;
  return `마지막 확인: 실패(${reason})`;
}

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
    root.setAttribute('data-dg-floating', '');

    const nav = document.createElement('nav');
    nav.className = 'dg-bs-nav';
    nav.setAttribute('aria-label', '파일 명령');

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'dg-bs-back';
    back.innerHTML = `${iconSvg('back', 16, 2)}<span>돌아가기</span>`;
    back.addEventListener('click', () => this.close());
    nav.appendChild(back);

    this.buildNav(nav);

    const main = document.createElement('section');
    main.className = 'dg-bs-main';
    main.setAttribute('aria-label', '새로 만들기와 최근 문서');
    main.append(this.buildNewRow(), this.buildRecent(root));

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

  // ── 왼쪽 열 ───────────────────────────────────────────
  private buildNav(nav: HTMLElement): void {
    const upstream = new Map<string, HTMLElement>();
    const body = menuBody('file');
    for (const el of Array.from(body?.querySelectorAll<HTMLElement>('.md-item[data-cmd]') ?? [])) {
      if (el.closest('[data-recent]')) continue;
      upstream.set(el.dataset.cmd!, el);
    }

    SECTIONS.forEach((section, si) => {
      if (si > 0) nav.appendChild(this.sep());
      if (section.heading) nav.appendChild(this.heading(section.heading));
      for (const def of section.items) {
        // 데스크탑은 '열기'를 네이티브 대화상자(두글 열기)로
        const cmd = def.cmd === 'file:open' && hasCommand(OPEN_NATIVE) ? OPEN_NATIVE : def.cmd;
        const b = this.navButton(cmd, def.label, def.icon, upstream.get(cmd));
        if (b) nav.appendChild(b);
      }
    });

    // 플러그인 등이 더한 나머지 upstream 항목
    const extra = Array.from(upstream.entries()).filter(([cmd, el]) => !HANDLED.has(cmd) && !el.hidden);
    if (extra.length) {
      nav.appendChild(this.sep());
      nav.appendChild(this.heading('기타'));
      for (const [cmd, el] of extra) {
        const label = (el.querySelector('.md-label')?.textContent ?? commandLabel(cmd) ?? cmd).trim();
        const b = this.navButton(cmd, label, 'more', el);
        if (b) nav.appendChild(b);
      }
    }

    nav.appendChild(this.buildInfo(upstream.get('file:about')));
  }

  private sep(): HTMLElement {
    const s = document.createElement('div');
    s.className = 'dg-bs-sep';
    return s;
  }

  private heading(text: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'dg-bs-heading';
    h.textContent = text;
    return h;
  }

  private navButton(cmd: string, label: string, icon: string, upstreamEl?: HTMLElement): HTMLButtonElement | null {
    if (!hasCommand(cmd)) return null;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dg-bs-item';
    b.innerHTML = `${iconSvg(icon, 18, 1.7)}<span class="dg-bs-item-label"></span><span class="dg-bs-item-sc"></span>`;
    (b.querySelector('.dg-bs-item-label') as HTMLElement).textContent = label;
    const sc = commandShortcut(cmd);
    if (sc) (b.querySelector('.dg-bs-item-sc') as HTMLElement).textContent = sc;
    if (!isEnabled(cmd)) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      // 대화상자·파일 선택기가 뜨기 전에 백스테이지를 닫는다.
      this.close(false);
      if (cmd === 'file:save') void guardedSave(b);
      else if (upstreamEl) activateUpstreamItem(upstreamEl, b);
      else run(cmd, { anchorEl: b });
    });
    return b;
  }

  /** 정보: 제품 정보 · 버전 · 업데이트 확인 · 마지막 확인 결과 */
  private buildInfo(aboutEl?: HTMLElement): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'dg-bs-update';
    wrap.append(this.sep(), this.heading('정보'));
    const about = this.navButton('file:about', '제품 정보', 'info', aboutEl);
    if (about) wrap.appendChild(about);
    if (!isDesk()) return wrap;

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dg-bs-item';
    b.innerHTML = `${iconSvg('refresh', 18, 1.7)}<span class="dg-bs-item-label">업데이트 확인</span>`;
    const version = document.createElement('div');
    version.className = 'dg-bs-version';
    version.setAttribute('aria-live', 'polite');
    version.textContent = '두글';
    let busy = false;
    const show = (v: string | null) => {
      const last = lastUpdateCheck();
      version.textContent = last ? checkText(last.result, v) : `두글 v${v ?? ''}`;
      version.classList.toggle('dg-bs-version--bad', last?.result.kind === 'error');
    };
    void currentVersion().then((v) => { if (!busy) show(v); });
    b.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      b.setAttribute('aria-disabled', 'true');
      version.textContent = '확인하는 중…';
      const result = await checkForUpdates();
      busy = false;
      b.removeAttribute('aria-disabled');
      show(await currentVersion());
      if (result.kind === 'available') {
        this.close(false);
        openUpdatePopover();
      }
    });
    wrap.append(b, version);
    return wrap;
  }

  // ── 오른쪽: 새로 만들기 줄 ────────────────────────────
  private buildNewRow(): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'dg-bs-section';
    const title = document.createElement('h2');
    title.className = 'dg-bs-title';
    title.textContent = '새로 만들기';
    const row = document.createElement('div');
    row.className = 'dg-bs-templates';
    row.setAttribute('role', 'list');
    sec.append(title, row);

    const card = (label: string, icon: string, onPick: () => void, primary = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `dg-bs-tpl${primary ? ' dg-bs-tpl--new' : ''}`;
      b.setAttribute('role', 'listitem');
      b.innerHTML = `<span class="dg-bs-tpl-page">${iconSvg(icon, 22, 1.6)}</span><span class="dg-bs-tpl-name"></span>`;
      (b.querySelector('.dg-bs-tpl-name') as HTMLElement).textContent = label;
      b.addEventListener('click', () => { this.close(false); onPick(); });
      return b;
    };
    const blank = card('빈 문서', 'newDoc', () => run('file:new-doc'), true);
    if (!hasCommand('file:new-doc') || !isEnabled('file:new-doc')) blank.setAttribute('aria-disabled', 'true');
    row.appendChild(blank);

    // 데스크탑 템플릿(doogle-desk resources/templates/*.hwpx). 엔진 변경 없이 '열기' 경로로 연다.
    if (isDesk()) {
      void invoke<TemplateInfo[]>('list_templates').then((list) => {
        for (const t of list ?? []) {
          row.appendChild(card(t.name, 'fileHwp', () => { void openTemplate(t); }));
        }
      }).catch(() => { /* 템플릿 명령이 없는 구버전 */ });
    }
    return sec;
  }

  // ── 오른쪽: 최근 문서 카드 ────────────────────────────
  private buildRecent(root: HTMLElement): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'dg-bs-section';
    const head = document.createElement('div');
    head.className = 'dg-bs-section-head';
    const title = document.createElement('h2');
    title.className = 'dg-bs-title';
    title.textContent = '최근 문서';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'dg-bs-link';
    clear.textContent = '목록 지우기';
    clear.hidden = true;
    clear.addEventListener('click', () => {
      run('file:clear-recent');
      window.setTimeout(render, 150);
    });
    head.append(title, clear);
    const list = document.createElement('div');
    list.className = 'dg-bs-recent';
    list.setAttribute('role', 'list');
    sec.append(head, list);

    let alive = true;
    (root as HTMLElement & { _dgCleanup?: () => void })._dgCleanup = () => { alive = false; };

    const render = async () => {
      let docs: RecentDoc[] = [];
      try { docs = await listRecentDocs(); } catch { /* 조회 실패 = 빈 목록 */ }
      if (!alive) return;
      const pins = readPins();
      docs.sort((a, b) => {
        const pa = pins.includes(a.id) ? 1 : 0;
        const pb = pins.includes(b.id) ? 1 : 0;
        return pb - pa || b.openedAt - a.openedAt;
      });
      list.replaceChildren();
      clear.hidden = docs.length === 0;
      for (const doc of docs) list.appendChild(this.recentCard(doc, pins.includes(doc.id), render));
      if (!docs.length) {
        const empty = document.createElement('div');
        empty.className = 'dg-bs-empty';
        empty.innerHTML = `${iconSvg('open', 28, 1.5)}<div><b>아직 연 문서가 없습니다.</b><span>열기(Ctrl+O)로 HWP·HWPX 문서를 열면 여기에 쌓입니다.</span></div>`;
        list.appendChild(empty);
      }
    };
    void render();
    return sec;
  }

  private recentCard(doc: RecentDoc, pinned: boolean, rerender: () => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'dg-bs-recent-item';
    row.setAttribute('role', 'listitem');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'dg-bs-recent-open';
    const path = isDesk() ? rememberedPath(doc.fileName) : null;
    const folder = path ? folderOf(path) : '';
    const fmt = (doc.sourceFormat || '').toUpperCase();
    open.innerHTML = `<span class="dg-bs-recent-icon">${iconSvg('fileHwp', 20, 1.6)}<b></b></span>`
      + '<span class="dg-bs-recent-name"><b></b><span></span></span><span class="dg-bs-recent-meta"></span>';
    (open.querySelector('.dg-bs-recent-icon b') as HTMLElement).textContent = fmt;
    (open.querySelector('.dg-bs-recent-name b') as HTMLElement).textContent = doc.fileName;
    const sub = open.querySelector('.dg-bs-recent-name span') as HTMLElement;
    sub.textContent = folder || (doc.handle ? '' : '다시 열려면 파일을 골라야 합니다');
    (open.querySelector('.dg-bs-recent-meta') as HTMLElement).textContent = relativeTime(doc.openedAt);
    open.title = path ?? doc.fileName;
    open.addEventListener('click', () => {
      this.close(false);
      run('file:open-recent', { id: doc.id, anchorEl: open });
    });

    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'dg-bs-pin';
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', pinned ? `${doc.fileName} 고정 풀기` : `${doc.fileName} 위에 고정`);
    pin.title = pinned ? '고정 풀기' : '목록 위에 고정';
    pin.innerHTML = iconSvg('pin', 15, 1.8);
    pin.addEventListener('click', () => {
      const pins = readPins().filter((id) => id !== doc.id);
      if (!pinned) pins.unshift(doc.id);
      writePins(pins);
      rerender();
    });

    row.append(open, pin);
    // 폴더가 없어진 파일은 표시만(열기는 upstream 이 판단)
    if (path) {
      void invoke<{ exists: boolean; modifiedMs?: number | null }>('file_stat', { path }).then((st) => {
        if (!st?.exists) {
          row.classList.add('dg-bs-recent-item--missing');
          sub.textContent = `${folder} · 파일을 찾을 수 없습니다`;
        }
      }).catch(() => {});
    }
    return row;
  }
}

type DocLoader = (bytes: Uint8Array, fileName: string) => Promise<void>;
let loader: DocLoader | null = null;

/** 템플릿을 열 때 쓸 문서 로더(플러그인 host.loadDocument). index.ts attachShellHost 가 잇는다. */
export function setBackstageLoader(fn: DocLoader | null): void {
  loader = fn;
}

async function openTemplate(t: TemplateInfo): Promise<void> {
  try {
    if (!loader) throw new Error('문서 로더가 아직 없습니다');
    const { readFile } = await import('../ui/desk-bridge');
    const bytes = await readFile(t.path);
    // 템플릿 원본을 덮어쓰지 않도록 이름만 붙여 새 문서처럼 연다(경로는 알리지 않는다).
    await loader(bytes, `${t.name}.hwpx`);
  } catch (error) {
    console.error('[doogle] 템플릿을 열지 못했습니다', t, error);
  }
}
