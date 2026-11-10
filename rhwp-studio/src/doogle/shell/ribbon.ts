/**
 * 두글 리본 — 탭 줄(role=tablist) + 104px 단추 패널.
 *
 * - 단추는 `ribbon-model.ts` 의 실제 커맨드 id 를 `automation.execute` 로 실행한다.
 * - '편집' 탭의 글꼴·크기·B/I/U·정렬·줄 간격 등은 upstream 서식 도구 모음의 실제 요소를 옮겨 와
 *   upstream `Toolbar` 가 선택 상태 반영과 적용을 계속 맡는다(재구현하지 않음).
 * - 폭이 모자라면 ① 작은 단추 글자를 숨기고 큰 단추를 줄이는 compact, ② 우선순위 낮은 묶음부터
 *   '더보기' 메뉴로 접는다.
 */
import { iconSvg } from './icons';
import { openPopupMenu, type PopupEntry } from './popup-menu';
import {
  RIBBON_TABS, SLOT_SELECTORS,
  type ActionItem, type CmdItem, type MenuItem, type RibbonGroup, type RibbonItem, type RibbonTab, type SlotName,
} from './ribbon-model';
import { commandShortcut, context, hasCommand, isEnabled, openCommandPalette, run, toggleAgentPanel } from './studio';
import { menuTitle, upstreamMenuEntries } from './upstream-menu';

export interface RibbonOptions {
  onFileTab: (tabButton: HTMLElement) => void;
  isAgentOpen: () => boolean;
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

  constructor(private readonly options: RibbonOptions) {
    this.tablist = document.createElement('div');
    this.tablist.className = 'dg-tabs';
    this.tablist.setAttribute('role', 'tablist');
    this.tablist.setAttribute('aria-label', '리본');

    this.host = document.createElement('div');
    this.host.className = 'dg-ribbon';

    // 파일: 백스테이지를 여는 탭 모양 단추
    const file = document.createElement('button');
    file.type = 'button';
    file.className = 'dg-tab dg-tab--file';
    file.setAttribute('role', 'tab');
    file.setAttribute('aria-selected', 'false');
    file.setAttribute('aria-haspopup', 'dialog');
    file.id = 'dg-tab-file';
    file.textContent = '파일';
    file.tabIndex = -1;
    file.addEventListener('click', () => this.options.onFileTab(file));
    this.tablist.appendChild(file);

    for (const tab of RIBBON_TABS) this.renderTab(tab);
    this.tablist.addEventListener('keydown', (e) => this.onTabKey(e));
    // 리본을 눌러도 편집 영역의 선택·캐럿이 유지되게 한다(main.ts #780 과 같은 규칙).
    this.host.addEventListener('mousedown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag !== 'INPUT' && tag !== 'SELECT') e.preventDefault();
    });
    this.tablist.addEventListener('mousedown', (e) => e.preventDefault());

    this.select('edit', false);
    new ResizeObserver(() => this.queueFit()).observe(this.host);
    this.watchStyleBar();
  }

  // ── 탭 ────────────────────────────────────────────────
  private renderTab(tab: RibbonTab): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dg-tab';
    if (tab.tone === 'ai') button.classList.add('dg-tab--ai');
    if (tab.contextual) button.classList.add('dg-tab--contextual');
    button.id = `dg-tab-${tab.id}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `dg-rpanel-${tab.id}`);
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
    button.innerHTML = tab.tone === 'ai' ? `${iconSvg('sparkle', 13, 2)}<span>${tab.label}</span>` : `<span>${tab.label}</span>`;
    button.addEventListener('click', () => {
      this.select(tab.id, true);
      if (tab.tone === 'ai' && !this.options.isAgentOpen()) toggleAgentPanel();
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
      this.active.panel.querySelector<HTMLElement>('button:not([aria-disabled="true"]), select, input')?.focus();
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

    if (def.rows) {
      body.classList.add('dg-group-body--rows');
      for (const row of def.rows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'dg-row';
        for (const item of row) {
          const node = this.renderItem(item);
          if (node) { rowEl.appendChild(node); count++; }
        }
        body.appendChild(rowEl);
      }
    } else if (def.items) {
      let stack: HTMLElement | null = null;
      for (const item of def.items) {
        const node = this.renderItem(item);
        if (!node) continue;
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
      b.innerHTML = `${iconSvg(icon, 14, 1.8)}<span class="dg-btn-label">${label}</span>`;
    } else {
      b.innerHTML = text ? `<span class="dg-btn-text">${text}</span>` : iconSvg(icon, 16, 2);
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
    bindActivate(b, () => run(item.id, { ...(item.params ?? {}), anchorEl: b }));
    (b as HTMLButtonElement & { _dgItem?: CmdItem })._dgItem = item;
    return b;
  }

  private actionButton(item: ActionItem): HTMLButtonElement {
    const b = this.baseButton(item.size, item.label, item.icon);
    b.title = item.label;
    if (item.tone === 'ai') b.classList.add('dg-btn--ai');
    if (item.action === 'ai') {
      b.dataset.action = 'ai';
      b.setAttribute('aria-pressed', 'false');
      bindActivate(b, () => { toggleAgentPanel(); this.queueRefresh(); });
    } else {
      bindActivate(b, () => { openCommandPalette(); });
    }
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
        onPick: (anchor) => run(e.id, { ...(e.params ?? {}), anchorEl: anchor }),
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
            onPick: (a) => run(item.id, { ...(item.params ?? {}), anchorEl: a }) });
        } else if (item.kind === 'action') {
          out.push({ label: item.label, onPick: () => (item.action === 'ai' ? toggleAgentPanel() : openCommandPalette()) });
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
        node.innerHTML = iconSvg(name === 'bullet' ? 'bullets' : 'numbering', 16, 2);
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
    if (!this.active) return;
    const agentOpen = this.options.isAgentOpen();
    for (const b of this.active.panel.querySelectorAll<HTMLButtonElement>('.dg-btn')) {
      const id = b.dataset.cmd;
      if (id) {
        const enabled = ctx ? isEnabled(id) : false;
        b.setAttribute('aria-disabled', String(!enabled));
        const item = (b as HTMLButtonElement & { _dgItem?: CmdItem })._dgItem;
        if (item?.pressed && ctx) b.setAttribute('aria-pressed', String(item.pressed(ctx)));
      } else if (b.dataset.action === 'ai') {
        b.setAttribute('aria-pressed', String(agentOpen));
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
