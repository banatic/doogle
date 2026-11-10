/**
 * 두글 리본 — 탭 줄(role=tablist) + 단추 패널.
 *
 * - 단추는 `ribbon-model.ts` 의 실제 커맨드 id 를 `automation.execute` 로 실행한다.
 * - '편집' 탭의 글꼴·크기·B/I/U·정렬·줄 간격 등은 upstream 서식 도구 모음의 실제 요소를 옮겨 와
 *   upstream `Toolbar` 가 선택 상태 반영과 적용을 계속 맡는다(재구현하지 않음).
 * - 폭이 모자라면 ① 작은 단추 글자를 숨기고 큰 단추를 줄이는 compact, ② 우선순위 낮은 묶음부터
 *   '더보기' 메뉴로 접는다.
 * - 표시 방식(UI_AUDIT 3.1): 펼침(104px) / 접힘(탭 줄만, 탭을 누르면 문서 위 플라이아웃) /
 *   간소화(한 줄 48px, `simple` 표시한 단추만). Ctrl+F1·활성 탭 두 번 누르기·탭 줄 오른쪽 ⌃ 로 접고 편다.
 *   상태는 `localStorage['doogle.ribbon']`.
 * - AI 도우미 토글은 탭 줄 오른쪽 고정석 하나뿐이다(사이드바 열림 = 눌림).
 * - 키팁(3.10): Alt(왼쪽)·F10 → 탭마다 한 글자 배지, 두 번째 키로 탭을 열고 포커스. Esc 는 문서로.
 */
import { iconSvg } from './icons';
import { openPopupMenu, type PopupEntry } from './popup-menu';
import {
  RIBBON_TABS, SLOT_SELECTORS,
  type ActionItem, type CmdItem, type MenuItem, type RibbonGroup, type RibbonItem, type RibbonTab, type ShellAction, type SlotName,
} from './ribbon-model';
import { getPendingCount, onPendingCount } from './status';
import { commandShortcut, context, hasCommand, isEnabled, openCommandPalette, run, toggleAgentPanel } from './studio';
import { menuTitle, upstreamMenuEntries } from './upstream-menu';

export interface RibbonOptions {
  onFileTab: (tabButton: HTMLElement) => void;
  isAgentOpen: () => boolean;
}

export type RibbonMode = 'expanded' | 'collapsed' | 'simple';

const MODE_KEY = 'doogle.ribbon';
const FILE_KEY = 'ㅍ';
const AI_KEY = 'A';

/** 두벌식 자판: 글자 → 같은 자리의 물리 키(e.code). 영문 자판·IME 상태와 무관하게 맞춘다. */
const JAMO_CODE: Record<string, string> = {
  ㅂ: 'KeyQ', ㅈ: 'KeyW', ㄷ: 'KeyE', ㄱ: 'KeyR', ㅅ: 'KeyT', ㅛ: 'KeyY', ㅕ: 'KeyU', ㅑ: 'KeyI', ㅐ: 'KeyO', ㅔ: 'KeyP',
  ㅁ: 'KeyA', ㄴ: 'KeyS', ㅇ: 'KeyD', ㄹ: 'KeyF', ㅎ: 'KeyG', ㅗ: 'KeyH', ㅓ: 'KeyJ', ㅏ: 'KeyK', ㅣ: 'KeyL',
  ㅋ: 'KeyZ', ㅌ: 'KeyX', ㅊ: 'KeyC', ㅍ: 'KeyV', ㅠ: 'KeyB', ㅜ: 'KeyN', ㅡ: 'KeyM',
  ㅃ: 'KeyQ', ㅉ: 'KeyW', ㄸ: 'KeyE', ㄲ: 'KeyR', ㅆ: 'KeyT',
};

function keyCode(key: string): string | undefined {
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  return JAMO_CODE[key];
}

interface Rendered {
  tab: RibbonTab;
  button: HTMLButtonElement;
  panel: HTMLElement;
  groupsEl: HTMLElement;
  more: HTMLButtonElement;
  groups: Array<{ def: RibbonGroup; el: HTMLElement }>;
}

/** 마우스 누름에서 실행하고(편집 선택 보존), 키보드 click(detail 0)도 받는다. */
function bindActivate(el: HTMLElement, act: () => void): void {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (el.getAttribute('aria-disabled') === 'true') return;
    act();
  });
  el.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    if (el.getAttribute('aria-disabled') === 'true') return;
    act();
  });
}

function tooltip(label: string, id?: string): string {
  const sc = id ? commandShortcut(id) : undefined;
  return sc ? `${label} (${sc})` : label;
}

function readMode(): RibbonMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'collapsed' || v === 'simple' ? v : 'expanded';
  } catch {
    return 'expanded';
  }
}

function hasModal(): boolean {
  return !!document.querySelector('.modal-overlay, dialog[open], .dg-backstage');
}

function focusDocument(): void {
  document.querySelector<HTMLElement>('[aria-label="문서 편집 입력"]')?.focus();
}

/** 검토 대기 변경 탐색·결정 — review/state.ts 의 reviewStore(사이드바·문서 위 막과 같은 길). */
async function reviewAction(action: ShellAction): Promise<void> {
  try {
    const { reviewStore } = await import('../review/state.ts');
    if (action === 'review-next') reviewStore.step(1);
    else if (action === 'review-prev') reviewStore.step(-1);
    else if (!reviewStore.busy) reviewStore.decide(action === 'review-accept-all' ? 'accept' : 'reject');
  } catch (error) {
    console.warn('[doogle shell] 검토 동작 실패', action, error);
  }
}

export class Ribbon {
  readonly tablist: HTMLElement;
  readonly host: HTMLElement;
  private rendered: Rendered[] = [];
  private active: Rendered | null = null;
  private lastNonContextual = 'edit';
  private slotEls = new Map<SlotName, HTMLElement>();
  private slotsFilled = false;
  private refreshQueued = false;
  private fitQueued = false;
  private mode: RibbonMode = readMode();
  private lastOpenMode: Exclude<RibbonMode, 'collapsed'> = 'expanded';
  private flyout = false;
  private keytips = false;
  private altArmed = false;
  private readonly fileTab: HTMLButtonElement;
  private readonly aiButton: HTMLButtonElement;
  private readonly collapseButton: HTMLButtonElement;

  constructor(private readonly options: RibbonOptions) {
    this.tablist = document.createElement('div');
    this.tablist.className = 'dg-tabs';
    this.tablist.setAttribute('role', 'tablist');
    this.tablist.setAttribute('aria-label', '리본');

    this.host = document.createElement('div');
    this.host.className = 'dg-ribbon';
    this.host.setAttribute('data-dg-floating', '');

    // 파일: 백스테이지를 여는 탭 모양 단추
    const file = document.createElement('button');
    file.type = 'button';
    file.className = 'dg-tab dg-tab--file';
    file.setAttribute('role', 'tab');
    file.setAttribute('aria-selected', 'false');
    file.setAttribute('aria-haspopup', 'dialog');
    file.setAttribute('aria-keyshortcuts', 'Alt+V');
    file.id = 'dg-tab-file';
    file.innerHTML = `<span>파일</span>${this.keytipHtml(FILE_KEY)}`;
    file.tabIndex = -1;
    file.addEventListener('click', () => { this.closeFlyout(); this.options.onFileTab(file); });
    this.tablist.appendChild(file);
    this.fileTab = file;

    for (const tab of RIBBON_TABS) this.renderTab(tab);

    // 탭 줄 오른쪽 고정석: AI 도우미 토글 + 리본 접기/펴기
    const end = document.createElement('div');
    end.className = 'dg-tabs-end';
    end.setAttribute('role', 'presentation');
    this.aiButton = document.createElement('button');
    this.aiButton.type = 'button';
    this.aiButton.className = 'dg-tab-ai';
    this.aiButton.setAttribute('aria-pressed', 'false');
    this.aiButton.setAttribute('aria-label', 'AI 도우미 사이드바');
    this.aiButton.title = 'AI 도우미 — 오른쪽 사이드바를 열고 닫습니다';
    this.aiButton.innerHTML = `${iconSvg('sparkle', 14, 2)}<span>AI 도우미</span>${this.keytipHtml(AI_KEY)}`;
    bindActivate(this.aiButton, () => { toggleAgentPanel(); this.queueRefresh(); });
    this.collapseButton = document.createElement('button');
    this.collapseButton.type = 'button';
    this.collapseButton.className = 'dg-tab-collapse';
    this.collapseButton.setAttribute('aria-keyshortcuts', 'Control+F1');
    bindActivate(this.collapseButton, () => this.toggleCollapsed());
    end.append(this.aiButton, this.collapseButton);
    this.tablist.appendChild(end);

    this.tablist.addEventListener('keydown', (e) => this.onTabKey(e));
    // 리본을 눌러도 편집 영역의 선택·캐럿이 유지되게 한다(main.ts #780 과 같은 규칙).
    this.host.addEventListener('mousedown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag !== 'INPUT' && tag !== 'SELECT') e.preventDefault();
    });
    this.host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.flyout) {
        e.preventDefault();
        this.closeFlyout();
        this.active?.button.focus();
      }
    });
    this.tablist.addEventListener('mousedown', (e) => e.preventDefault());

    if (this.mode !== 'collapsed') this.lastOpenMode = this.mode;
    this.select('edit', false);
    this.applyMode();
    new ResizeObserver(() => this.queueFit()).observe(this.host);
    this.watchStyleBar();
    this.installKeys();
    onPendingCount(() => this.queueRefresh());

    // 접힌 리본의 플라이아웃은 바깥을 누르면 닫는다(리본·탭 줄·리본이 띄운 메뉴 제외).
    document.addEventListener('pointerdown', (e) => {
      if (!this.flyout) return;
      const t = e.target as Element | null;
      if (!t || this.host.contains(t) || this.tablist.contains(t) || t.closest('.dg-popup')) return;
      this.closeFlyout();
    }, true);
  }

  private keytipHtml(key: string | undefined): string {
    return key ? `<span class="dg-keytip" aria-hidden="true">${key}</span>` : '';
  }

  // ── 표시 방식 ─────────────────────────────────────────
  get currentMode(): RibbonMode {
    return this.mode;
  }

  setMode(mode: RibbonMode): void {
    if (mode !== 'collapsed') this.lastOpenMode = mode;
    this.mode = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* 이번 세션만 */ }
    this.flyout = false;
    this.applyMode();
  }

  toggleCollapsed(): void {
    this.setMode(this.mode === 'collapsed' ? this.lastOpenMode : 'collapsed');
  }

  private applyMode(): void {
    const collapsed = this.mode === 'collapsed';
    this.host.classList.toggle('dg-ribbon--collapsed', collapsed && !this.flyout);
    this.host.classList.toggle('dg-ribbon--flyout', collapsed && this.flyout);
    this.host.classList.toggle('dg-ribbon--simple', this.mode === 'simple');
    this.tablist.classList.toggle('dg-tabs--collapsed', collapsed);
    const label = collapsed ? '리본 펼치기' : '리본 접기';
    this.collapseButton.innerHTML = iconSvg(collapsed ? 'chevronDown' : 'chevronUp', 14, 2);
    this.collapseButton.setAttribute('aria-label', label);
    this.collapseButton.title = `${label} (Ctrl+F1)`;
    this.collapseButton.setAttribute('aria-expanded', String(!collapsed || this.flyout));
    // 접힘 상태에서는 선택 표시도 플라이아웃이 열렸을 때만
    for (const r of this.rendered) {
      r.button.setAttribute('aria-expanded', String(!collapsed || (this.flyout && r === this.active)));
    }
    this.refresh();
    this.queueFit();
  }

  private openFlyout(): void {
    if (this.mode !== 'collapsed' || this.flyout) return;
    this.flyout = true;
    this.applyMode();
  }

  closeFlyout(): void {
    if (!this.flyout) return;
    this.flyout = false;
    this.applyMode();
  }

  /** 리본 단추를 실행한 뒤 — 플라이아웃이면 닫는다. */
  private afterActivate(): void {
    if (this.flyout) this.closeFlyout();
  }

  // ── 키보드(Ctrl+F1 · 키팁) ────────────────────────────
  private installKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (this.keytips) { this.onKeytipKey(e); return; }
      if (e.key === 'Alt' && e.code === 'AltLeft' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        this.altArmed = true;
        return;
      }
      this.altArmed = false;
      if (e.key === 'F1' && e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleCollapsed();
        return;
      }
      if (e.key === 'F10' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !hasModal()) {
        e.preventDefault();
        e.stopPropagation();
        this.showKeytips();
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (e.key !== 'Alt' || e.code !== 'AltLeft') return;
      const armed = this.altArmed;
      this.altArmed = false;
      if (!armed || hasModal()) return;
      e.preventDefault();
      if (this.keytips) this.hideKeytips();
      else this.showKeytips();
    }, true);
    window.addEventListener('blur', () => { this.altArmed = false; this.hideKeytips(); });
    document.addEventListener('pointerdown', () => { this.altArmed = false; this.hideKeytips(); }, true);
  }

  private showKeytips(): void {
    this.keytips = true;
    this.tablist.classList.add('dg-tabs--keytips');
  }

  private hideKeytips(): void {
    if (!this.keytips) return;
    this.keytips = false;
    this.tablist.classList.remove('dg-tabs--keytips');
  }

  private onKeytipKey(e: KeyboardEvent): void {
    if (['Shift', 'Control', 'Meta', 'CapsLock', 'HangulMode', 'Process'].includes(e.key) && e.code !== 'AltLeft') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Alt') { this.altArmed = true; return; } // 다시 Alt 를 떼면 닫힌다
    this.hideKeytips();
    if (e.key === 'Escape' || e.key === 'F10') { focusDocument(); return; }
    const code = e.code;
    if (code === keyCode(FILE_KEY)) { this.fileTab.click(); return; }
    if (code === keyCode(AI_KEY)) { toggleAgentPanel(); this.queueRefresh(); return; }
    const r = this.rendered.find((x) => !x.button.hidden && x.tab.key && keyCode(x.tab.key) === code);
    if (!r) return;
    this.select(r.tab.id, false);
    this.openFlyout();
    requestAnimationFrame(() => {
      const first = r.panel.querySelector<HTMLElement>('button:not([aria-disabled="true"]):not([hidden]), select, input');
      (first ?? r.button).focus();
    });
  }

  // ── 탭 ────────────────────────────────────────────────
  private renderTab(tab: RibbonTab): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dg-tab';
    if (tab.contextual) button.classList.add('dg-tab--contextual');
    button.id = `dg-tab-${tab.id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `dg-rpanel-${tab.id}`);
    button.setAttribute('aria-selected', 'false');
    const code = tab.key ? keyCode(tab.key) : undefined;
    if (code) button.setAttribute('aria-keyshortcuts', `Alt+${code.replace(/^Key/, '')}`);
    button.tabIndex = -1;
    button.innerHTML = `<span>${tab.label}</span>${this.keytipHtml(tab.key)}`;
    button.addEventListener('click', () => {
      if (this.mode === 'collapsed') {
        // 접힌 리본: 같은 탭을 다시 누르면 플라이아웃을 닫는다.
        if (this.flyout && this.active?.tab.id === tab.id) { this.closeFlyout(); return; }
        this.select(tab.id, true);
        this.openFlyout();
        return;
      }
      this.select(tab.id, true);
    });
    button.addEventListener('dblclick', () => {
      if (this.active?.tab.id === tab.id) this.toggleCollapsed();
    });
    if (tab.contextual) button.hidden = true;
    this.tablist.appendChild(button);

    const panel = document.createElement('div');
    panel.className = 'dg-rpanel';
    panel.id = `dg-rpanel-${tab.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.hidden = true;

    const groupsEl = document.createElement('div');
    groupsEl.className = 'dg-groups';
    panel.appendChild(groupsEl);

    const groups: Rendered['groups'] = [];
    for (const def of tab.groups) {
      const el = this.renderGroup(def);
      if (!el) continue;
      groupsEl.appendChild(el);
      groups.push({ def, el });
    }
    if (groups.some((g) => g.el.hasAttribute('data-has-simple'))) panel.setAttribute('data-has-simple', '');

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'dg-more';
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = `${iconSvg('more', 18, 2)}<span>더보기</span>`;
    more.title = '더보기';
    const openMore = (focusFirst: boolean) => {
      if (more.getAttribute('aria-expanded') === 'true') return;
      openPopupMenu(more, this.moreEntries(tab, groups), `${tab.label} 더보기`, focusFirst);
    };
    more.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); openMore(false); } });
    more.addEventListener('click', (e) => { if (e.detail === 0) openMore(true); });
    panel.appendChild(more);

    this.host.appendChild(panel);
    this.rendered.push({ tab, button, panel, groupsEl, more, groups });
  }

  private onTabKey(e: KeyboardEvent): void {
    const tabs = Array.from(this.tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter((t) => !t.hidden);
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'ArrowDown' && this.active) {
      e.preventDefault();
      this.openFlyout();
      requestAnimationFrame(() => {
        this.active?.panel.querySelector<HTMLElement>('button:not([aria-disabled="true"]), select, input')?.focus();
      });
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.closeFlyout();
      focusDocument();
      return;
    } else return;
    e.preventDefault();
    const target = tabs[next];
    target.focus();
    const id = target.id.replace(/^dg-tab-/, '');
    if (id !== 'file') this.select(id, true);
  }

  select(id: string, focusTab: boolean): void {
    const r = this.rendered.find((x) => x.tab.id === id);
    if (!r || r.button.hidden) return;
    for (const x of this.rendered) {
      const on = x === r;
      x.button.setAttribute('aria-selected', String(on));
      x.button.tabIndex = on ? 0 : -1;
      x.panel.hidden = !on;
    }
    this.active = r;
    if (!r.tab.contextual) this.lastNonContextual = id;
    if (focusTab && document.activeElement && this.tablist.contains(document.activeElement)) r.button.focus();
    this.refresh();
    this.queueFit();
  }

  // ── 묶음·단추 ─────────────────────────────────────────
  private renderGroup(def: RibbonGroup): HTMLElement | null {
    const el = document.createElement('div');
    el.className = 'dg-group';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', def.caption);
    el.dataset.group = def.id;

    const body = document.createElement('div');
    body.className = 'dg-group-body';
    let count = 0;
    let simpleCount = 0;
    const mark = (node: HTMLElement, item: RibbonItem) => {
      node.setAttribute('data-dg-item', '');
      if (item.simple) { node.setAttribute('data-simple', ''); simpleCount++; }
    };

    if (def.rows) {
      body.classList.add('dg-group-body--rows');
      for (const row of def.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'dg-row';
        for (const item of row) {
          const node = this.renderItem(item);
          if (node) { mark(node, item); rowEl.appendChild(node); count++; }
        }
        body.appendChild(rowEl);
      }
    } else if (def.items) {
      let stack: HTMLElement | null = null;
      for (const item of def.items) {
        const node = this.renderItem(item);
        if (!node) continue;
        mark(node, item);
        count++;
        if (item.kind !== 'slot' && item.size === 'sm') {
          if (!stack || stack.childElementCount >= 3) {
            stack = document.createElement('div');
            stack.className = 'dg-stack';
            body.appendChild(stack);
          }
          stack.appendChild(node);
        } else {
          stack = null;
          body.appendChild(node);
        }
      }
    }
    if (count === 0) return null;
    if (simpleCount > 0) el.setAttribute('data-has-simple', '');

    const caption = document.createElement('div');
    caption.className = 'dg-group-caption';
    caption.textContent = def.caption;
    caption.setAttribute('aria-hidden', 'true');
    el.append(body, caption);
    return el;
  }

  private renderItem(item: RibbonItem): HTMLElement | null {
    switch (item.kind) {
      case 'cmd': return hasCommand(item.id) ? this.cmdButton(item) : null;
      case 'action': return this.actionButton(item);
      case 'menu': return this.menuButton(item);
      case 'slot': {
        const holder = document.createElement('span');
        holder.className = 'dg-slot';
        holder.dataset.slot = item.slot;
        this.slotEls.set(item.slot, holder);
        return holder;
      }
    }
  }

  private baseButton(size: CmdItem['size'], label: string, icon: string, iconColor?: string, text?: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `dg-btn dg-btn--${size}`;
    if (size === 'lg') {
      b.innerHTML = `${iconSvg(icon, 28, 1.5, iconColor)}<span class="dg-btn-label">${label}</span>`;
    } else if (size === 'sm') {
      b.innerHTML = `${iconSvg(icon, 18, 1.8)}<span class="dg-btn-label">${label}</span>`;
    } else {
      b.innerHTML = text ? `<span class="dg-btn-text">${text}</span>` : iconSvg(icon, 18, 1.8);
      b.setAttribute('aria-label', label);
    }
    return b;
  }

  private cmdButton(item: CmdItem): HTMLButtonElement {
    const b = this.baseButton(item.size, item.label, item.icon, item.iconColor, item.text);
    b.dataset.cmd = item.id;
    b.title = tooltip(item.label, item.id);
    if (item.pressed) b.setAttribute('aria-pressed', 'false');
    if (item.textClass) b.classList.add(item.textClass);
    bindActivate(b, () => {
      this.afterActivate();
      run(item.id, { ...(item.params ?? {}), anchorEl: b });
    });
    (b as HTMLButtonElement & { _dgItem?: CmdItem })._dgItem = item;
    return b;
  }

  private runAction(action: ShellAction): void {
    switch (action) {
      case 'palette': this.afterActivate(); openCommandPalette(); break;
      case 'ribbon-collapse': this.toggleCollapsed(); break;
      case 'ribbon-simple': this.setMode(this.mode === 'simple' ? 'expanded' : 'simple'); break;
      default: this.afterActivate(); void reviewAction(action).then(() => this.queueRefresh());
    }
  }

  private actionButton(item: ActionItem): HTMLButtonElement {
    const b = this.baseButton(item.size, item.label, item.icon);
    b.title = item.action === 'ribbon-collapse' ? `${item.label} (Ctrl+F1)` : item.label;
    b.dataset.action = item.action;
    if (item.tone === 'ai') b.classList.add('dg-btn--ai');
    if (item.action === 'ribbon-collapse' || item.action === 'ribbon-simple') b.setAttribute('aria-pressed', 'false');
    bindActivate(b, () => this.runAction(item.action));
    return b;
  }

  private menuButton(item: MenuItem): HTMLButtonElement {
    const b = this.baseButton(item.size, item.label, item.icon, undefined, item.text);
    b.title = item.label;
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    const open = (focusFirst: boolean) => {
      if (b.getAttribute('aria-expanded') === 'true') return;
      const entries: PopupEntry[] = item.entries.filter((e) => hasCommand(e.id)).map((e) => ({
        label: e.label,
        shortcut: commandShortcut(e.id),
        disabled: !isEnabled(e.id),
        onPick: (anchor) => { this.afterActivate(); run(e.id, { ...(e.params ?? {}), anchorEl: anchor }); },
      }));
      openPopupMenu(b, entries, item.label, focusFirst);
    };
    b.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); open(false); } });
    b.addEventListener('click', (e) => { if (e.detail === 0) open(true); });
    return b;
  }

  /** '더보기' — 접힌 묶음의 단추 + upstream 메뉴 전체. */
  private moreEntries(tab: RibbonTab, groups: Rendered['groups']): PopupEntry[] {
    const out: PopupEntry[] = [];
    for (const { def, el } of groups) {
      if (!el.hidden) continue;
      out.push({ label: def.caption, heading: true });
      for (const item of def.items ?? def.rows?.flat() ?? []) {
        if (item.kind === 'cmd' && hasCommand(item.id)) {
          out.push({ label: item.label, shortcut: commandShortcut(item.id), disabled: !isEnabled(item.id),
            onPick: (a) => { this.afterActivate(); run(item.id, { ...(item.params ?? {}), anchorEl: a }); } });
        } else if (item.kind === 'action') {
          out.push({ label: item.label, disabled: this.actionDisabled(item.action), onPick: () => this.runAction(item.action) });
        } else if (item.kind === 'menu') {
          for (const e of item.entries) {
            if (hasCommand(e.id)) out.push({ label: e.label, disabled: !isEnabled(e.id), onPick: (a) => run(e.id, { anchorEl: a }) });
          }
        }
      }
    }
    if (tab.menuId) {
      const entries = upstreamMenuEntries(tab.menuId);
      if (entries.length) {
        if (out.length) out.push({ label: '', separator: true });
        out.push({ label: `${menuTitle(tab.menuId)} 메뉴 전체`, heading: true });
        out.push(...entries);
      }
    }
    if (!out.length) out.push({ label: '더 표시할 항목이 없습니다', disabled: true });
    return out;
  }

  private actionDisabled(action: ShellAction): boolean {
    return action.startsWith('review-') && getPendingCount() <= 0;
  }

  // ── upstream 서식 요소 옮겨 오기 ───────────────────────
  /**
   * upstream `Toolbar` 는 생성자에서 `#style-bar` 안의 요소를 찾아 참조를 쥔다. 그 전에 옮기면
   * 찾지 못하므로, 생성 직후 `toolbar.setEnabled(false)` 가 `#style-bar` 에 찍는 aria-disabled 를
   * 신호로 삼아 옮긴다. 이후 enabled 상태도 같은 속성에서 비춰 온다.
   */
  private watchStyleBar(): void {
    const bar = document.getElementById('style-bar');
    if (!bar) return;
    const sync = () => {
      if (!bar.hasAttribute('aria-disabled')) return;
      if (!this.slotsFilled) this.fillSlots();
      const disabled = bar.getAttribute('aria-disabled') === 'true';
      for (const holder of this.slotEls.values()) {
        holder.inert = disabled;
        holder.classList.toggle('dg-slot--disabled', disabled);
      }
    };
    new MutationObserver(sync).observe(bar, { attributes: true, attributeFilter: ['aria-disabled'] });
    sync();
  }

  private fillSlots(): void {
    for (const [name, holder] of this.slotEls) {
      const sel = SLOT_SELECTORS[name] as { find: string; move?: string };
      const found = document.querySelector<HTMLElement>(sel.find);
      if (!found) continue;
      const node = sel.move ? (found.closest<HTMLElement>(sel.move) ?? found) : found;
      holder.appendChild(node);
      if (name === 'bullet' || name === 'numbering') {
        const label = name === 'bullet' ? '글머리표' : '문단 번호';
        node.innerHTML = iconSvg(name === 'bullet' ? 'bullets' : 'numbering', 18, 1.8);
        node.setAttribute('aria-label', label);
        node.title = label;
        node.classList.add('dg-slot-btn');
      }
      if (name === 'font-name') node.setAttribute('aria-label', '글꼴');
      if (name === 'style-name') node.setAttribute('aria-label', '스타일');
      for (const btn of node.querySelectorAll<HTMLElement>('button[title]:not([aria-label])')) {
        btn.setAttribute('aria-label', btn.title);
      }
      if (node instanceof HTMLButtonElement && !node.hasAttribute('aria-label') && node.title) {
        node.setAttribute('aria-label', node.title);
      }
    }
    this.slotsFilled = true;
    this.queueFit();
  }

  // ── 상태 갱신 ─────────────────────────────────────────
  queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => { this.refreshQueued = false; this.refresh(); });
  }

  refresh(): void {
    const ctx = context();
    // 상황 탭(표)
    const inTable = !!ctx && (ctx.inTable || ctx.inCellSelectionMode || ctx.inTableObjectSelection);
    for (const r of this.rendered) {
      if (r.tab.contextual !== 'table') continue;
      if (r.button.hidden === inTable) {
        r.button.hidden = !inTable;
        if (!inTable && this.active === r) this.select(this.lastNonContextual, false);
      }
    }
    this.aiButton.setAttribute('aria-pressed', String(this.options.isAgentOpen()));
    if (!this.active) return;
    for (const b of this.active.panel.querySelectorAll<HTMLButtonElement>('.dg-btn')) {
      const id = b.dataset.cmd;
      const action = b.dataset.action as ShellAction | undefined;
      if (id) {
        const enabled = ctx ? isEnabled(id) : false;
        b.setAttribute('aria-disabled', String(!enabled));
        const item = (b as HTMLButtonElement & { _dgItem?: CmdItem })._dgItem;
        if (item?.pressed && ctx) b.setAttribute('aria-pressed', String(item.pressed(ctx)));
      } else if (action === 'ribbon-collapse') {
        b.setAttribute('aria-pressed', String(this.mode === 'collapsed'));
      } else if (action === 'ribbon-simple') {
        b.setAttribute('aria-pressed', String(this.mode === 'simple'));
      } else if (action) {
        b.setAttribute('aria-disabled', String(this.actionDisabled(action)));
      }
    }
  }

  // ── 폭 맞추기 ─────────────────────────────────────────
  queueFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => { this.fitQueued = false; this.fit(); });
  }

  private fit(): void {
    const r = this.active;
    if (!r) return;
    const panel = r.panel;
    if (panel.clientWidth === 0) return; // 접혀 있어 잴 수 없다 — 펼칠 때 다시 잰다
    panel.classList.remove('dg-rpanel--compact');
    for (const g of r.groups) g.el.hidden = false;
    const avail = () => panel.clientWidth - r.more.offsetWidth - 8;
    // 묶음 폭의 합으로 잰다 — 패널을 overflow:hidden 으로 두면 글자 효과·형광펜 드롭다운이 잘린다.
    const over = () => r.groups.reduce((sum, g) => sum + (g.el.hidden ? 0 : g.el.offsetWidth), 0) > avail();
    if (!over()) return;
    panel.classList.add('dg-rpanel--compact');
    const order = r.groups.filter((g) => Number.isFinite(g.def.priority)).sort((a, b) => a.def.priority - b.def.priority);
    for (const g of order) {
      if (!over()) break;
      g.el.hidden = true;
    }
  }
}
