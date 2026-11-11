/**
 * 사이드바 설정 시트 (UI_AUDIT §3.4) — 톱니로 열고, 패널 안에서 옆으로 밀려 들어온다(모달 아님).
 *
 * 구성: AI 계정 카드(Claude Code · Codex · ChatGPT · API 키) · 기본 적용 방식 · 에이전트 서비스 상태 ·
 * 데이터 안내. 모델 메뉴는 이제 모델 고르기만 하고, 계정 연결·키·로그아웃은 모두 여기서 한다.
 *
 * 정책: Claude 로그인 UI 를 만들지 않는다(CONTRACT §0). Claude Code 는 상태만 보여 주고,
 * 터미널에서 `claude` → `/login` 하라는 안내와 "터미널 명령 복사" 단추만 둔다.
 */
import type { AgentMode, HubClient, ProviderInfo } from '../hub-client.ts';
import { brandIcon, brandOf } from './brand.ts';
import { icon } from './icons.ts';

export interface SettingsHost {
  hub: HubClient;
  providers(): readonly ProviderInfo[];
  mode(): AgentMode;
  setMode(mode: AgentMode): void;
  busy(): boolean;
  loginPending(): string | null;
  startLogin(providerId: string): void;
  cancelLogin(providerId: string): void;
  refreshProviders(): Promise<void>;
  /** 사이드바 aria-live 로 읽어 준다 */
  announce(text: string): void;
  /** 에이전트 서비스 한 줄 상태 */
  connection(): { ok: boolean; text: string };
  retryConnection(): void;
  /** 시트가 닫혔다 (포커스 복귀는 사이드바가) */
  onClosed(): void;
}

/** API 키로 쓰는 provider → keyring 키 */
export const SECRET_KEY_OF: Record<string, { key: string; placeholder: string; label: string }> = {
  'anthropic-api': { key: 'anthropic-api-key', placeholder: 'sk-ant-…', label: 'Anthropic API 키' },
  'openai-api': { key: 'openai-api-key', placeholder: 'sk-…', label: 'OpenAI API 키' },
};

/** 터미널 로그인이 필요한 provider → 복사할 명령과 안내 */
const TERMINAL_LOGIN: Record<string, { command: string; steps: string; okNote: string }> = {
  'claude-sdk': {
    command: 'claude',
    steps: '터미널에서 claude 를 실행한 뒤 /login 으로 로그인하세요. 로그인한 뒤 "다시 확인"을 누르세요.',
    okNote: '터미널의 claude 로그인을 그대로 씁니다. 두글은 Claude 로그인 정보를 읽지 않습니다.',
  },
  'codex-app-server': {
    command: 'codex login',
    steps: '터미널에서 codex login 을 실행해 ChatGPT 로 로그인하세요. 로그인한 뒤 "다시 확인"을 누르세요.',
    okNote: '터미널의 Codex 로그인을 그대로 씁니다.',
  },
};

/** 카드 순서 — 구독 계정 먼저, API 키는 뒤 */
const ORDER = ['claude-sdk', 'codex-app-server', 'openai-siwc', 'anthropic-api', 'openai-api'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export class SettingsSheet {
  readonly root: HTMLElement;
  private readonly host: SettingsHost;
  private readonly body: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  /** 펼친 키 입력 (provider id) */
  private keyFormFor: string | null = null;
  private keyNote = new Map<string, string>();
  private checking = false;

  constructor(host: SettingsHost) {
    this.host = host;
    this.root = el('section', 'dg-sheet');
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', '설정');
    this.root.hidden = true;
    const head = el('header', 'dg-sheet-head');
    this.backBtn = btn('dg-sheet-back', '', () => this.close());
    this.backBtn.setAttribute('aria-label', '설정 닫기');
    this.backBtn.append(icon('chevronLeft', 16, 2), el('span', '', '설정'));
    head.append(this.backBtn);
    this.body = el('div', 'dg-sheet-body');
    this.root.append(head, this.body);
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(focus?: 'accounts' | 'api'): void {
    this.root.hidden = false;
    this.render();
    requestAnimationFrame(() => {
      this.root.classList.add('dg-sheet-in');
      const target = focus === 'api'
        ? this.body.querySelector<HTMLElement>('[data-provider="anthropic-api"] button, [data-provider="openai-api"] button')
        : null;
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.focus();
      } else {
        this.backBtn.focus();
      }
    });
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.classList.remove('dg-sheet-in');
    this.root.hidden = true;
    this.keyFormFor = null;
    this.host.onClosed();
  }

  /** providers·로그인·모드가 바뀌면 사이드바가 부른다 */
  render(): void {
    if (!this.isOpen) return;
    const active = document.activeElement as HTMLElement | null;
    const activeKey = active && this.body.contains(active) ? active.dataset.key ?? '' : '';

    const parts: HTMLElement[] = [];
    parts.push(el('h3', 'dg-sheet-heading', 'AI 계정'));
    const providers = [...this.host.providers()].sort((a, b) => rank(a.id) - rank(b.id));
    if (providers.length === 0) {
      const conn = this.host.connection();
      parts.push(el('p', 'dg-sheet-note', conn.ok ? 'AI 계정 목록을 받는 중…' : '에이전트 서비스에 연결되면 AI 계정을 연결할 수 있습니다.'));
    }
    for (const provider of providers) parts.push(this.providerCard(provider));

    parts.push(el('h3', 'dg-sheet-heading', '기본 적용 방식'));
    parts.push(this.modeGroup());

    parts.push(el('h3', 'dg-sheet-heading', '에이전트 서비스'));
    parts.push(this.serviceCard());

    const data = el('p', 'dg-sheet-note dg-sheet-data');
    data.textContent = '문서 본문과 선택한 내용은 요청할 때 선택한 AI 계정의 서버로 전송됩니다. 두글은 로그인 정보를 저장하지 않으며, API 키는 OS 보안 저장소(keyring)에만 둡니다.';
    parts.push(data);

    this.body.replaceChildren(...parts);
    if (activeKey) this.body.querySelector<HTMLElement>(`[data-key="${CSS.escape(activeKey)}"]`)?.focus();
  }

  // ─── 계정 카드 ────────────────────────────────────────

  private providerCard(provider: ProviderInfo): HTMLElement {
    const card = el('div', 'dg-card dg-account');
    card.dataset.provider = provider.id;
    const title = el('div', 'dg-card-title');
    const dot = el('span', `dg-dot ${provider.available ? 'dg-dot-ok' : 'dg-dot-warn'}`);
    dot.setAttribute('aria-hidden', 'true');
    const status = provider.available ? statusOk(provider.id) : '연결 필요';
    const brand = brandOf(provider.id);
    title.append(dot, ...(brand ? [brandIcon(brand, 15)] : []), el('span', 'dg-card-name', provider.label), el('span', 'dg-card-status', `· ${status}`));
    card.append(title);

    const terminal = TERMINAL_LOGIN[provider.id];
    const secret = SECRET_KEY_OF[provider.id];
    if (terminal) {
      if (provider.available) {
        card.append(el('p', 'dg-card-sub', terminal.okNote));
      } else {
        if (provider.reason) card.append(el('p', 'dg-card-sub', provider.reason));
        card.append(el('p', 'dg-card-sub', terminal.steps));
        const acts = el('div', 'dg-card-acts');
        const copy = btn('dg-btn', '', () => this.copyCommand(terminal.command));
        copy.dataset.key = `${provider.id}:copy`;
        copy.append(icon('terminal', 13, 2), el('span', '', '터미널 명령 복사'));
        copy.title = `"${terminal.command}" 복사`;
        acts.append(copy, this.recheckButton(provider.id));
        card.append(acts);
      }
    } else if (provider.id === 'openai-siwc') {
      const acts = el('div', 'dg-card-acts');
      if (provider.available) {
        card.append(el('p', 'dg-card-sub', 'ChatGPT Plus/Pro 구독으로 사용합니다.'));
        const logout = btn('dg-btn dg-btn-quiet', '로그아웃', () => {
          if (!this.host.hub.logout(provider.id)) this.host.announce('에이전트 서비스에 연결되어 있지 않습니다');
        });
        logout.dataset.key = `${provider.id}:logout`;
        acts.append(logout);
      } else {
        card.append(el('p', 'dg-card-sub', provider.authHint || 'ChatGPT Plus/Pro 구독으로 바로 사용할 수 있습니다.'));
        const pending = this.host.loginPending() === provider.id;
        const login = btn(pending ? 'dg-btn' : 'dg-btn dg-btn-primary', pending ? '로그인 취소' : 'ChatGPT로 로그인', () => {
          if (pending) this.host.cancelLogin(provider.id);
          else this.host.startLogin(provider.id);
        });
        login.dataset.key = `${provider.id}:login`;
        acts.append(login);
        if (pending) card.append(el('p', 'dg-card-sub dg-card-pending', '브라우저에서 로그인을 마치세요…'));
      }
      card.append(acts);
    } else if (secret) {
      card.append(el('p', 'dg-card-sub', provider.available ? 'API 키가 저장되어 있습니다. 사용량만큼 요금이 청구됩니다.' : '사용량만큼 요금이 청구되는 API 키로 연결합니다.'));
      if (this.keyFormFor === provider.id) {
        card.append(this.keyForm(provider.id));
      } else {
        const acts = el('div', 'dg-card-acts');
        const add = btn('dg-btn', provider.available ? '키 바꾸기' : '키 추가…', () => {
          this.keyFormFor = provider.id;
          this.render();
          this.body.querySelector<HTMLInputElement>(`#dg-key-${provider.id}`)?.focus();
        });
        add.dataset.key = `${provider.id}:add`;
        acts.append(add);
        if (provider.available) {
          const remove = btn('dg-btn dg-btn-quiet', '키 삭제', () => {
            this.host.hub.setSecret(secret.key, null).then(
              () => { this.host.announce('API 키를 삭제했습니다'); void this.host.refreshProviders(); },
              (error: unknown) => this.setKeyNote(provider.id, `삭제하지 못했습니다: ${messageOf(error)}`),
            );
          });
          remove.dataset.key = `${provider.id}:remove`;
          acts.append(remove);
        }
        card.append(acts);
        const note = this.keyNote.get(provider.id);
        if (note) card.append(el('p', 'dg-card-sub', note));
      }
    } else {
      const hint = provider.available ? '' : provider.authHint || provider.reason || '';
      if (hint) card.append(el('p', 'dg-card-sub', hint));
      if (!provider.available) {
        const acts = el('div', 'dg-card-acts');
        acts.append(this.recheckButton(provider.id));
        card.append(acts);
      }
    }
    return card;
  }

  private recheckButton(providerId: string): HTMLButtonElement {
    const recheck = btn('dg-btn dg-btn-quiet', this.checking ? '확인하는 중…' : '다시 확인', () => {
      if (this.checking) return;
      this.checking = true;
      this.render();
      this.host.refreshProviders().finally(() => {
        this.checking = false;
        this.render();
      });
    });
    recheck.dataset.key = `${providerId}:recheck`;
    recheck.disabled = this.checking;
    return recheck;
  }

  private copyCommand(command: string): void {
    const done = () => this.host.announce(`터미널 명령 "${command}"을 복사했습니다`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(command).then(done, () => this.host.announce('복사하지 못했습니다'));
    }
  }

  private setKeyNote(providerId: string, text: string): void {
    this.keyNote.set(providerId, text);
    this.render();
  }

  private keyForm(providerId: string): HTMLElement {
    const spec = SECRET_KEY_OF[providerId];
    const form = el('form', 'dg-key-form');
    const id = `dg-key-${providerId}`;
    const label = el('label', 'dg-sr-only', spec.label);
    label.htmlFor = id;
    const input = el('input', 'dg-key-input');
    input.id = id;
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = spec.placeholder;
    const save = el('button', 'dg-btn dg-btn-primary', '저장');
    save.type = 'submit';
    const cancel = btn('dg-btn dg-btn-quiet', '취소', () => {
      this.keyFormFor = null;
      this.render();
    });
    const note = el('p', 'dg-card-sub', this.keyNote.get(providerId) || 'OS 보안 저장소(keyring)에 저장되며 다시 표시되지 않습니다.');
    note.setAttribute('aria-live', 'polite');
    form.append(label, input, save, cancel, note);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        note.textContent = '키를 입력하세요.';
        input.focus();
        return;
      }
      note.textContent = '저장하는 중…';
      save.disabled = true;
      this.host.hub.setSecret(spec.key, value).then(() => {
        input.value = '';
        this.keyFormFor = null;
        this.keyNote.set(providerId, '저장했습니다.');
        this.host.announce('API 키를 저장했습니다');
        void this.host.refreshProviders();
        this.render();
      }).catch((error: unknown) => {
        save.disabled = false;
        note.textContent = `저장하지 못했습니다: ${messageOf(error)}`;
      });
    });
    return form;
  }

  // ─── 적용 방식 ────────────────────────────────────────

  private modeGroup(): HTMLElement {
    const group = el('div', 'dg-mode-group');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '기본 적용 방식');
    const current = this.host.mode();
    const options: Array<{ mode: AgentMode; title: string; tag?: string; sub: string }> = [
      { mode: 'agent', title: '검토 후 적용', tag: '권장', sub: '편집을 문서에 먼저 보여 주고, 적용할지 묻습니다.' },
      { mode: 'full', title: '바로 적용', sub: '편집을 곧바로 문서에 반영합니다. 편집 1회 = 되돌리기 1단계.' },
    ];
    for (const option of options) {
      const on = option.mode === current;
      const card = btn(`dg-card dg-mode-option${on ? ' dg-on' : ''}`, '', () => this.host.setMode(option.mode));
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(on));
      card.dataset.key = `mode:${option.mode}`;
      card.disabled = this.host.busy();
      const title = el('span', 'dg-card-title');
      title.append(el('span', 'dg-radio'), el('span', 'dg-card-name', option.title));
      if (option.tag) title.append(el('span', 'dg-card-status', `(${option.tag})`));
      card.append(title, el('span', 'dg-card-sub', option.sub));
      group.append(card);
    }
    return group;
  }

  private serviceCard(): HTMLElement {
    const conn = this.host.connection();
    const card = el('div', 'dg-card');
    const title = el('div', 'dg-card-title');
    const dot = el('span', `dg-dot ${conn.ok ? 'dg-dot-ok' : 'dg-dot-bad'}`);
    dot.setAttribute('aria-hidden', 'true');
    title.append(dot, el('span', 'dg-card-name', conn.text));
    card.append(title);
    if (!conn.ok) {
      const acts = el('div', 'dg-card-acts');
      const retry = btn('dg-btn', '다시 연결', () => this.host.retryConnection());
      retry.dataset.key = 'service:retry';
      acts.append(retry);
      card.append(acts);
    }
    return card;
  }
}

function rank(id: string): number {
  const index = ORDER.indexOf(id);
  return index === -1 ? ORDER.length : index;
}

function statusOk(providerId: string): string {
  if (SECRET_KEY_OF[providerId]) return '키 저장됨';
  return '로그인됨';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
