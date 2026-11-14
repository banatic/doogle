/**
 * 카드 편집 화면 — 사이드바 안에서 옆으로 밀려 들어오는 시트(설정 시트와 같은 자리·모양).
 *
 * 사용자가 하는 일의 순서대로 한 번에 한 가지만 보인다:
 *  - 새 카드: 먼저 "말로 설명해서 만들기 / 직접 적기" 를 고른다 (AI 연결 `CardEditorHost.ai` 이 없으면 바로 직접 적기).
 *  - 말로 만들기: AI 칸만 보인다. 초안이 오면 양식으로 넘어가 확인하고 저장한다.
 *  - 양식: 카드 이름 → 어떤 카드인가(정보 한 벌 / 명단) → 내용.
 *      정보 한 벌: 항목마다 "이름 : 값" 한 줄. 설명·민감·지우기는 줄 끝 단추로 펼친다.
 *      명단: 표 하나에서 열 이름(머리 칸)과 값을 함께 고친다. 엑셀에서 복사한 줄을 붙여 넣으면
 *            열이 모자라면 늘리고, 첫 줄을 항목 이름으로 쓸지 묻는다.
 *    AI 로 고치기는 양식 위에 접어 둔다 — 강조 단추는 화면마다 하나(초안 만들기 또는 저장).
 *  - 저장은 사람이 누를 때만 한다 (AI 는 초안만 바꾼다).
 */
import type { Card, CardDraft, HubClient } from '../hub-client.ts';
import { icon } from './icons.ts';

/** AI 로 초안을 만들거나 고친다 (sidebar 가 hub 와 이어 준다) */
export interface CardAi {
  /**
   * instruction: 사용자가 적은 말. draft: 지금 화면의 초안(없으면 null). file: 고른 파일.
   * onNote: 진행·답 한 줄. 돌려주는 값: 새 초안 (없으면 null — 답만 하고 초안은 그대로).
   */
  run(input: { instruction: string; draft: CardDraft | null; file: File | null; signal: AbortSignal }, onNote: (text: string, tone?: 'quiet' | 'error') => void): Promise<CardDraft | null>;
  /** 지금 쓸 수 있는가 (모델 연결) — 못 쓰면 이유 */
  readiness(): { ok: true } | { ok: false; reason: string };
  /** 편집 화면을 닫았다 — 이어 오던 AI 대화를 지운다 */
  end(): void;
}

export interface CardEditorHost {
  hub: HubClient;
  ai: CardAi | null;
  saved(card: Card): void;
  deleted(id: string): void;
  announce(text: string): void;
  onClosed(): void;
}

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

/** 서랍의 카드에 적히는 종류 이름과 같은 말을 쓴다 (card-shelf.ts TONE_LABEL) */
const ICON_CHOICES: Array<{ value: Card['icon']; label: string }> = [
  { value: 'person', label: '인적 사항' },
  { value: 'school', label: '기관' },
  { value: 'list', label: '명단' },
  { value: 'card', label: '기타' },
];

const KIND_CHOICES = [
  { kind: 'item', title: '정보 한 벌', sub: '이름·연락처처럼 항목마다 값 하나' },
  { kind: 'table', title: '명단', sub: '학생 명렬처럼 같은 항목이 여러 줄' },
] as const;

/** 항목 이름에 쓸 수 없는 글자 (hub cards.mjs 와 같은 규칙) */
const BAD_KEY = /[.{}[\]\r\n\t]/;

/**
 * 붙여 넣은 표의 첫 줄을 항목 이름으로 — 쓸 수 없는 글자는 빈칸으로, 빈 칸은 지금 이름을 두고, 겹치면 번호를 붙인다.
 */
export function headerKeys(cells: readonly string[], current: readonly string[]): string[] {
  const out: string[] = [];
  current.forEach((old, i) => {
    const base = (cells[i] ?? '').replace(new RegExp(BAD_KEY.source, 'g'), ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || old;
    let key = base;
    for (let n = 2; out.includes(key); n++) key = `${base.slice(0, 36)} ${n}`;
    out.push(key);
  });
  return out;
}

/**
 * 명단 표의 열 폭(em) — 그 열에서 가장 긴 글에 맞춘다. 한글·한자·전각은 1em, 그 밖은 0.6em 으로 어림하고
 * 칸 안쪽 여백 1.4em 을 더한다. 4.5em 보다 좁거나 14em 보다 넓게는 잡지 않는다.
 */
export function columnEm(texts: readonly string[]): number {
  let max = 0;
  for (const text of texts) {
    let w = 0;
    for (const ch of text) w += /[ᄀ-ᇿ⺀-ￜ]/.test(ch) ? 1 : 0.6;
    if (w > max) max = w;
  }
  return Math.min(14, Math.max(4.5, Math.round((max + 1.4) * 10) / 10));
}

/** 빈 새 카드 */
function blankDraft(): CardDraft {
  return { name: '', icon: 'person', kind: 'item', fields: [{ key: '이름', desc: '', sensitive: false }], values: { 이름: '' } };
}

function cloneDraft(card: CardDraft): CardDraft {
  return {
    ...(card.id ? { id: card.id } : {}),
    name: card.name,
    icon: card.icon,
    kind: card.kind,
    fields: card.fields.map((f) => ({ key: f.key, desc: f.desc ?? '', sensitive: !!f.sensitive })),
    ...(card.kind === 'item' ? { values: { ...(card.values ?? {}) } } : { rows: (card.rows ?? []).map((r) => [...r]) }),
  };
}

/**
 * 엑셀·한글 표에서 복사한 글을 줄·칸으로 나눈다 (탭 구분, 끝 빈 줄 무시).
 * 따옴표로 감싼 칸 안의 줄바꿈은 엑셀 형식을 따라 한 칸으로 본다.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  return rows;
}

export class CardEditor {
  readonly root: HTMLElement;
  private readonly host: CardEditorHost;
  private readonly body: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  /** 스크롤 밖 바닥 줄 — 저장 단추가 늘 보인다 */
  private readonly foot: HTMLElement;
  private original: Card | null = null;
  private draft: CardDraft = blankDraft();
  /** 새 카드: 시작(고르기) → AI 칸 또는 양식. 저장된 카드는 늘 양식 */
  private step: 'start' | 'ai' | 'form' = 'form';
  /** 양식 위의 "AI 로 고치기" 를 펼쳤는가 */
  private aiOpen = false;
  /** 설명·민감·지우기를 펼친 항목 */
  private detail: number | null = null;
  /** 방금 붙여 넣은 표의 첫 줄을 항목 이름으로 쓸지 묻는 중 */
  private headerOffer = false;
  /** AI 가 새로 넣은 항목 — 잠깐 표시한다 */
  private fresh = new Set<string>();
  private error = '';
  private saving = false;
  private confirmDelete = false;
  // AI 칸
  private aiLog: Array<{ who: 'user' | 'agent'; text: string; tone?: 'quiet' | 'error' }> = [];
  private aiText = '';
  private aiFile: File | null = null;
  private aiAbort: AbortController | null = null;

  constructor(host: CardEditorHost) {
    this.host = host;
    this.root = el('section', 'dg-sheet dg-card-editor');
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', '카드 편집');
    this.root.hidden = true;
    const head = el('header', 'dg-sheet-head');
    this.backBtn = btn('dg-sheet-back', '', () => this.close());
    this.backBtn.setAttribute('aria-label', '내 카드로 돌아가기');
    this.backBtn.append(icon('chevronLeft', 16, 2), el('span', '', '내 카드'));
    head.append(this.backBtn);
    this.body = el('div', 'dg-sheet-body');
    this.foot = el('footer', 'dg-ce-bar');
    this.foot.hidden = true;
    this.root.append(head, this.body, this.foot);
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

  /** card 가 null 이면 새 카드 — 만드는 방법부터 고른다 */
  open(card: Card | null): void {
    this.original = card;
    this.draft = card ? cloneDraft(card) : blankDraft();
    this.step = card || !this.host.ai ? 'form' : 'start';
    this.aiOpen = false;
    this.detail = null;
    this.headerOffer = false;
    this.fresh.clear();
    this.error = '';
    this.confirmDelete = false;
    this.aiLog = [];
    this.aiText = '';
    this.aiFile = null;
    this.root.hidden = false;
    this.render();
    requestAnimationFrame(() => {
      this.root.classList.add('dg-sheet-in');
      this.focusFirst();
    });
  }

  close(): void {
    if (this.root.hidden) return;
    this.aiAbort?.abort();
    this.aiAbort = null;
    this.host.ai?.end();
    this.root.classList.remove('dg-sheet-in');
    this.root.hidden = true;
    this.host.onClosed();
  }

  /** 지금 초안 (테스트·AI 용) */
  get current(): CardDraft {
    return cloneDraft(this.draft);
  }

  /** AI 가 준 초안으로 바꾼다 — 새로 생긴 항목은 표시하고, 저장된 카드의 id 는 유지한다 */
  applyDraft(next: CardDraft): void {
    const before = new Set(this.draft.fields.map((f) => f.key));
    const id = this.draft.id;
    this.draft = cloneDraft({ ...next, ...(id ? { id } : {}) });
    this.fresh = new Set(this.draft.fields.map((f) => f.key).filter((k) => !before.has(k)));
    this.detail = null;
    this.headerOffer = false;
    this.error = '';
    this.render();
  }

  private focusFirst(): void {
    const selector = this.step === 'start' ? '.dg-ce-choice:not(:disabled)' : this.step === 'ai' ? '.dg-ce-ai textarea' : '.dg-ce-name';
    (this.body.querySelector<HTMLElement>(selector) ?? this.body.querySelector<HTMLElement>('button, input'))?.focus();
  }

  private goTo(step: 'start' | 'ai' | 'form'): void {
    this.step = step;
    this.render();
    this.focusFirst();
  }

  // ─── 그리기 ───────────────────────────────────────────

  private render(): void {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.ceFocus;
    // 화면 제목 — 이 화면에서 가장 큰 글자 (클래스 이름은 빈 화면의 .dg-ce-title 과 겹치지 않게)
    const nodes: HTMLElement[] = [el('h2', 'dg-ced-title', this.original ? '카드 고치기' : '새 카드 만들기')];
    if (this.step === 'start') nodes.push(this.renderStart());
    else if (this.step === 'ai') {
      const wrap = el('div', 'dg-ce-start');
      wrap.append(
        el('p', 'dg-sheet-note', '어떤 카드인지 적어 주세요. 초안이 나오면 확인하고 고친 뒤 저장합니다.'),
        this.renderAi(),
        btn('dg-ce-link', '직접 적을게요', () => this.goTo('form')),
      );
      nodes.push(wrap);
    } else {
      if (this.host.ai) nodes.push(this.renderAiFold());
      nodes.push(this.renderBasics(), this.draft.kind === 'table' ? this.renderTable() : this.renderFields());
    }
    this.body.replaceChildren(...nodes);
    // 바닥 줄: 오류 + 저장 — 양식에서만
    this.foot.hidden = this.step !== 'form';
    if (this.step === 'form') {
      const err = el('p', 'dg-ce-error', this.error);
      err.setAttribute('role', 'alert');
      this.foot.replaceChildren(err, this.renderFoot());
    } else this.foot.replaceChildren();
    if (focusKey) this.root.querySelector<HTMLElement>(`[data-ce-focus="${CSS.escape(focusKey)}"]`)?.focus();
  }

  /** 새 카드의 첫 화면 — 만드는 방법 두 가지 */
  private renderStart(): HTMLElement {
    const ready = this.host.ai?.readiness();
    const choice = (name: 'sparkle' | 'compose', title: string, sub: string, onClick: () => void): HTMLButtonElement => {
      const b = btn('dg-ce-choice', '', onClick);
      const text = el('span', 'dg-ce-choice-text');
      text.append(el('span', 'dg-ce-choice-title', title), el('span', 'dg-ce-choice-sub', sub));
      b.append(icon(name, 18), text, icon('chevronRight', 16, 2));
      return b;
    };
    const byAi = choice(
      'sparkle',
      '말로 설명해서 만들기',
      ready && !ready.ok ? ready.reason : '내 정보를 문장으로 적거나 명단 파일을 고르면 AI 가 초안을 만듭니다.',
      () => this.goTo('ai'),
    );
    byAi.disabled = !!ready && !ready.ok;
    const byHand = choice('compose', '직접 적기', '항목 이름과 값을 하나씩 적습니다. 엑셀 명단은 붙여 넣을 수 있습니다.', () => this.goTo('form'));
    const wrap = el('div', 'dg-ce-start');
    wrap.append(el('p', 'dg-sheet-note', '카드를 어떻게 만들까요? 어느 쪽이든 저장하기 전에 고칠 수 있습니다.'), byAi, byHand);
    return wrap;
  }

  /** 양식 위에 접어 둔 "AI 로 고치기" */
  private renderAiFold(): HTMLElement {
    const toggle = btn('dg-ce-fold', '', () => {
      this.aiOpen = !this.aiOpen;
      this.render();
      if (this.aiOpen) this.body.querySelector<HTMLElement>('.dg-ce-ai textarea')?.focus();
    });
    toggle.dataset.ceFocus = 'ai-fold';
    toggle.setAttribute('aria-expanded', String(this.aiOpen));
    toggle.append(icon('sparkle', 14), el('span', '', 'AI 로 고치기'), icon(this.aiOpen ? 'chevronDown' : 'chevronRight', 14, 2));
    const wrap = el('div', 'dg-ce-stack');
    wrap.append(toggle);
    if (this.aiOpen) wrap.append(this.renderAi());
    return wrap;
  }

  private renderAi(): HTMLElement {
    const making = this.step === 'ai';
    const box = el('div', 'dg-ce-ai');
    const log = el('div', 'dg-ce-ai-log');
    log.setAttribute('aria-live', 'polite');
    for (const line of this.aiLog) {
      const node = el('div', line.who === 'user' ? 'dg-ce-ai-user' : 'dg-ce-ai-agent', line.text);
      if (line.tone) node.dataset.tone = line.tone;
      log.append(node);
    }
    const input = el('textarea', 'dg-ce-textarea');
    input.rows = making ? 5 : 3;
    input.dataset.ceFocus = 'ai';
    input.placeholder = making
      ? '예: 나는 한빛초 3학년 2반 담임 김하늘이고 휴대폰은 010-1234-5678. 서류 낼 때 쓸 카드 만들어 줘.\n명단 파일을 고르면 그 표로 카드를 만듭니다.'
      : '예: 내선 번호 302 도 넣어 줘 / 생년월일은 빼 줘';
    input.value = this.aiText;
    input.setAttribute('aria-label', 'AI 에게 할 말');
    input.addEventListener('input', () => { this.aiText = input.value; });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.runAi();
      }
    });

    const row = el('div', 'dg-ce-row');
    const fileInput = el('input', '');
    fileInput.type = 'file';
    fileInput.accept = '.xlsx,.xls,.csv,.tsv,.txt,.hwp,.hwpx,.docx,.pdf';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      this.aiFile = fileInput.files?.[0] ?? null;
      fileInput.value = '';
      this.render();
    });
    const pick = btn('dg-btn dg-btn-quiet', '', () => fileInput.click());
    pick.append(icon('file', 14), el('span', '', this.aiFile ? this.aiFile.name : '명단 파일 고르기'));
    pick.title = '명렬 엑셀·한글 표 등 — 머리 줄과 앞 3줄만 AI 에게 보냅니다';
    row.append(fileInput, pick);
    if (this.aiFile) {
      const clear = btn('dg-ce-icon-btn', '', () => { this.aiFile = null; this.render(); });
      clear.append(icon('close', 12, 2.2));
      clear.setAttribute('aria-label', '고른 파일 빼기');
      row.append(clear);
    }
    row.append(el('div', 'dg-grow'));
    const busy = this.aiAbort !== null;
    // 강조 단추는 화면마다 하나 — 양식에서는 "저장" 이 강조다
    const go = btn(making ? 'dg-btn dg-btn-primary' : 'dg-btn', busy ? '그만' : making ? '초안 만들기' : '고치기', () => {
      if (this.aiAbort) this.aiAbort.abort();
      else void this.runAi();
    });
    const ready = this.host.ai?.readiness();
    if (ready && !ready.ok && !busy) {
      go.disabled = true;
      go.title = ready.reason;
    }
    row.append(go);
    box.append(log, input, row);
    if (ready && !ready.ok) box.append(el('div', 'dg-ce-ai-agent', ready.reason));
    return box;
  }

  private renderBasics(): HTMLElement {
    const wrap = el('div', 'dg-ce-section');
    const nameLabel = el('label', 'dg-ce-stack');
    const name = el('input', 'dg-ce-input dg-ce-name');
    name.value = this.draft.name;
    name.placeholder = '예: 내 인적 사항, 3학년 2반 명렬';
    name.maxLength = 60;
    name.dataset.ceFocus = 'name';
    name.addEventListener('input', () => { this.draft.name = name.value; });
    nameLabel.append(el('span', 'dg-ce-label', '카드 이름'), name);

    const kindStack = el('div', 'dg-ce-stack');
    const kinds = el('div', 'dg-ce-kinds');
    kinds.setAttribute('role', 'group');
    kinds.setAttribute('aria-label', '어떤 카드인가요?');
    for (const choice of KIND_CHOICES) {
      const b = btn('dg-ce-kind', '', () => this.setKind(choice.kind));
      b.setAttribute('aria-pressed', String(this.draft.kind === choice.kind));
      b.dataset.ceFocus = `kind-${choice.kind}`;
      b.append(el('span', 'dg-ce-kind-title', choice.title), el('span', 'dg-ce-kind-sub', choice.sub));
      kinds.append(b);
    }
    // 서랍 표시는 덜 중요한 설정 — 꼴 고르기 바로 아래에 작게 둔다
    const toneLabel = el('label', 'dg-ce-tone');
    const iconSel = el('select', 'dg-ce-select');
    iconSel.dataset.ceFocus = 'tone';
    for (const choice of ICON_CHOICES) {
      const opt = el('option', '', choice.label);
      opt.value = choice.value;
      opt.selected = this.draft.icon === choice.value;
      iconSel.append(opt);
    }
    iconSel.addEventListener('change', () => { this.draft.icon = iconSel.value as Card['icon']; });
    toneLabel.append(el('span', 'dg-ced-hint', '서랍에 보일 종류'), iconSel);
    kindStack.append(el('span', 'dg-ce-label', '어떤 카드인가요?'), kinds, toneLabel);

    wrap.append(nameLabel, kindStack);
    return wrap;
  }

  /** 항목의 덜 쓰는 것들 — 설명 · 민감 · 지우기 (줄 끝 단추로 펼친다) */
  private renderDetail(index: number): HTMLElement {
    const field = this.draft.fields[index];
    const noun = this.draft.kind === 'table' ? '열' : '항목';
    const box = el('div', 'dg-ce-detail');
    const descLabel = el('label', 'dg-ce-stack');
    const desc = el('input', 'dg-ce-input');
    desc.dataset.ceFocus = `desc-${index}`;
    desc.value = field.desc;
    desc.placeholder = '예: 성명·신청인 칸';
    desc.maxLength = 200;
    desc.addEventListener('input', () => { field.desc = desc.value; });
    const cap = el('span', 'dg-ce-labelrow');
    cap.append(el('span', 'dg-ce-label', '설명'), el('span', 'dg-ced-hint', '안 적어도 됩니다 · AI 가 서식 칸과 맞출 때 참고합니다'));
    descLabel.append(cap, desc);

    const row = el('div', 'dg-ce-row');
    const sens = el('label', 'dg-ce-check');
    const check = el('input', '');
    check.type = 'checkbox';
    check.checked = field.sensitive;
    check.dataset.ceFocus = `sens-${index}`;
    check.addEventListener('change', () => { field.sensitive = check.checked; this.render(); });
    sens.append(check, el('span', 'dg-ce-label', '민감 정보'), el('span', 'dg-ced-hint', 'AI 에게는 가려서 보냅니다'));
    const remove = btn('dg-btn dg-btn-quiet', '', () => this.removeField(index));
    remove.append(icon('trash', 14), el('span', '', `이 ${noun} 지우기`));
    remove.disabled = this.draft.fields.length <= 1;
    remove.dataset.ceFocus = `del-${index}`;
    row.append(sens, el('div', 'dg-grow'), remove);
    box.append(descLabel, row);
    return box;
  }

  /** 민감 항목 표시 — 단추가 아니라 표시일 뿐이다 (설정은 줄 끝 단추에서) */
  private lockMark(): SVGSVGElement {
    const mark = icon('lock', 12);
    mark.classList.add('dg-ce-lock');
    return mark;
  }

  /** 줄(열) 끝의 설정 단추 — 아이콘은 늘 같고, 펼친 상태는 배경으로 보인다 */
  private moreButton(index: number): HTMLButtonElement {
    const field = this.draft.fields[index];
    const open = this.detail === index;
    const more = btn('dg-ce-icon-btn dg-ce-more', '', () => { this.detail = open ? null : index; this.render(); });
    more.append(icon('gear', 14));
    more.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-label', `${field.key} — 설명 · 민감 · 지우기${field.sensitive ? ' (민감 정보)' : ''}`);
    more.title = '설명 · 민감 · 지우기';
    more.dataset.ceFocus = `more-${index}`;
    return more;
  }

  private keyInput(index: number): HTMLInputElement {
    const field = this.draft.fields[index];
    const key = el('input', 'dg-ce-input dg-ce-key');
    key.value = field.key;
    key.placeholder = '항목 이름';
    key.maxLength = 40;
    key.setAttribute('aria-label', `${index + 1}번째 항목 이름`);
    key.dataset.ceFocus = `key-${index}`;
    key.addEventListener('change', () => this.renameField(index, key.value));
    return key;
  }

  /** 정보 한 벌 — 항목마다 "이름 : 값" 한 줄 */
  private renderFields(): HTMLElement {
    const wrap = el('div', 'dg-ce-section');
    const stack = el('div', 'dg-ce-stack');
    const list = el('div', 'dg-ce-rows');
    const cols = el('div', 'dg-ce-cols');
    cols.setAttribute('aria-hidden', 'true');
    cols.append(el('span', 'dg-ced-hint', '이름'), el('span', 'dg-ced-hint', '값'));
    list.append(cols);
    this.draft.fields.forEach((field, index) => {
      const box = el('div', 'dg-ce-field');
      if (this.fresh.has(field.key)) box.dataset.new = '';
      const value = el('input', 'dg-ce-input dg-ce-value');
      value.value = this.draft.values?.[field.key] ?? '';
      value.maxLength = 2000;
      value.setAttribute('aria-label', `${field.key} 값${field.sensitive ? ' (민감 정보)' : ''}`);
      value.dataset.ceFocus = `value-${index}`;
      value.addEventListener('input', () => { (this.draft.values ??= {})[field.key] = value.value; });
      value.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter') return;
        event.preventDefault();
        if (index === this.draft.fields.length - 1) this.addField();
        else this.body.querySelector<HTMLElement>(`[data-ce-focus="value-${index + 1}"]`)?.focus();
      });
      const cell = el('div', 'dg-ce-valuecell');
      cell.append(value);
      if (field.sensitive) {
        cell.dataset.sensitive = '';
        cell.title = '민감 정보 — AI 에게는 가려서 보냅니다';
        cell.append(this.lockMark());
      }
      box.append(this.keyInput(index), cell, this.moreButton(index));
      if (this.detail === index) box.append(this.renderDetail(index));
      list.append(box);
    });
    stack.append(el('span', 'dg-ce-label', '항목'), list);
    wrap.append(stack, btn('dg-ce-link', '+ 항목 추가', () => this.addField()));
    return wrap;
  }

  /** 명단 — 표 하나에서 열 이름과 값을 함께 고친다 */
  private renderTable(): HTMLElement {
    const section = el('div', 'dg-ce-section');
    const wrap = el('div', 'dg-ce-stack');
    const rows = (this.draft.rows ??= []);
    const filled = rows.filter((r) => r.some((v) => v.trim())).length;
    wrap.append(el('span', 'dg-ce-label', filled > 0 ? `명단 ${filled}줄` : '명단'));
    wrap.append(el('p', 'dg-sheet-note', '엑셀에서 복사한 줄을 칸에 붙여 넣으면 한꺼번에 채웁니다. 맨 윗줄 칸은 항목 이름입니다.'));
    if (this.headerOffer && rows.length > 1) {
      const offer = el('div', 'dg-ce-offer');
      offer.setAttribute('role', 'status');
      const sample = rows[0].filter((v) => v.trim()).slice(0, 3).join(', ');
      offer.append(
        el('span', '', `붙여 넣은 첫 줄(${sample})이 항목 이름인가요?`),
        btn('dg-btn', '항목 이름으로 쓰기', () => this.useHeaderRow()),
        btn('dg-btn dg-btn-quiet', '아니요', () => { this.headerOffer = false; this.render(); }),
      );
      wrap.append(offer);
    }
    // 열 폭은 내용에 맞춘다 — 긴 값이 잘리는 것보다 표를 옆으로 미는 편이 낫다
    const widths = this.draft.fields.map((_, c) => columnEm(rows.map((r) => r[c] ?? '')));
    const scroll = el('div', 'dg-ce-grid-wrap');
    const table = el('table', 'dg-ce-grid');
    const head = el('tr', '');
    head.append(el('th', ''));
    this.draft.fields.forEach((field, c) => {
      const th = el('th', '');
      if (this.fresh.has(field.key)) th.dataset.new = '';
      const cell = el('div', 'dg-ce-th');
      const key = this.keyInput(c);
      key.style.minWidth = `${columnEm([field.key])}em`;
      cell.append(key);
      if (field.sensitive) cell.append(this.lockMark());
      cell.append(this.moreButton(c));
      th.append(cell);
      head.append(th);
    });
    head.append(el('th', ''));
    table.append(head);
    rows.forEach((row, r) => {
      const tr = el('tr', '');
      tr.append(el('td', 'dg-ce-rownum', String(r + 1)));
      this.draft.fields.forEach((field, c) => {
        const td = el('td', '');
        const input = el('input', '');
        input.value = row[c] ?? '';
        input.style.minWidth = `${widths[c]}em`;
        input.setAttribute('aria-label', `${r + 1}번째 줄 ${field.key}`);
        input.dataset.ceFocus = `cell-${r}-${c}`;
        input.addEventListener('input', () => { row[c] = input.value; });
        input.addEventListener('paste', (event) => {
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (!/[\t\n]/.test(text)) return;
          event.preventDefault();
          this.pasteGrid(r, c, parseTsv(text));
        });
        td.append(input);
        tr.append(td);
      });
      const del = el('td', '');
      const remove = btn('dg-ce-icon-btn', '', () => { rows.splice(r, 1); this.render(); });
      remove.append(icon('close', 12, 2.2));
      remove.setAttribute('aria-label', `${r + 1}번째 줄 지우기`);
      del.append(remove);
      tr.append(del);
      table.append(tr);
    });
    scroll.append(table);
    wrap.append(scroll);
    if (this.detail !== null && this.draft.fields[this.detail]) {
      wrap.append(el('span', 'dg-ce-label', `「${this.draft.fields[this.detail].key}」 열`), this.renderDetail(this.detail));
    }
    // 줄·열 더하기는 표 아래에 나란히 — 표를 옆으로 밀지 않아도 보인다
    const adds = el('div', 'dg-ce-row');
    adds.append(
      btn('dg-ce-link', '+ 줄 추가', () => {
        rows.push(this.draft.fields.map(() => ''));
        this.render();
        this.body.querySelector<HTMLElement>(`[data-ce-focus="cell-${rows.length - 1}-0"]`)?.focus();
      }),
      btn('dg-ce-link', '+ 열 추가', () => this.addField()),
    );
    section.append(wrap, adds);
    return section;
  }

  private renderFoot(): HTMLElement {
    const foot = el('div', 'dg-ce-foot');
    if (this.original) {
      if (this.confirmDelete) {
        foot.append(
          el('span', 'dg-sheet-note', '이 카드를 지울까요? 되돌릴 수 없습니다.'),
          btn('dg-btn dg-btn-quiet', '취소', () => { this.confirmDelete = false; this.render(); }),
          btn('dg-btn dg-btn-danger', '지우기', () => void this.remove()),
        );
        return foot;
      }
      const del = btn('dg-btn dg-btn-quiet', '', () => { this.confirmDelete = true; this.render(); });
      del.append(icon('trash', 14), el('span', '', '카드 지우기'));
      foot.append(del);
    }
    foot.append(el('div', 'dg-grow'), btn('dg-btn', '취소', () => this.close()));
    const save = btn('dg-btn dg-btn-primary', this.saving ? '저장하는 중…' : '저장', () => void this.save());
    save.disabled = this.saving;
    foot.append(save);
    return foot;
  }

  // ─── 고치기 ───────────────────────────────────────────

  private setKind(kind: 'item' | 'table'): void {
    if (this.draft.kind === kind) return;
    if (kind === 'table') {
      // 빈 표로 시작하지 않는다 — 바로 적거나 붙여 넣을 칸이 보이게
      this.draft.rows = [this.draft.fields.map((f) => this.draft.values?.[f.key] ?? '')];
      delete this.draft.values;
      if (this.draft.icon === 'person') this.draft.icon = 'list';
    } else {
      const first = this.draft.rows?.[0] ?? [];
      this.draft.values = Object.fromEntries(this.draft.fields.map((f, i) => [f.key, first[i] ?? '']));
      delete this.draft.rows;
      if (this.draft.icon === 'list') this.draft.icon = 'person';
    }
    this.draft.kind = kind;
    this.detail = null;
    this.headerOffer = false;
    this.render();
  }

  /** 항목(열) 하나를 끝에 더한다 — 그리지는 않는다 */
  private pushField(): void {
    let n = this.draft.fields.length + 1;
    let key = `항목 ${n}`;
    while (this.draft.fields.some((f) => f.key === key)) key = `항목 ${++n}`;
    this.draft.fields.push({ key, desc: '', sensitive: false });
    if (this.draft.kind === 'item') (this.draft.values ??= {})[key] = '';
    else for (const row of this.draft.rows ?? []) row.push('');
  }

  private addField(): void {
    this.pushField();
    this.render();
    this.body.querySelector<HTMLInputElement>(`[data-ce-focus="key-${this.draft.fields.length - 1}"]`)?.select();
  }

  private removeField(index: number): void {
    if (this.draft.fields.length <= 1) return;
    const [gone] = this.draft.fields.splice(index, 1);
    if (this.draft.kind === 'item') delete this.draft.values?.[gone.key];
    else for (const row of this.draft.rows ?? []) row.splice(index, 1);
    this.detail = null;
    this.render();
  }

  private renameField(index: number, raw: string): void {
    const field = this.draft.fields[index];
    const next = raw.trim();
    if (!next || next === field.key) { this.render(); return; }
    if (BAD_KEY.test(next)) {
      this.error = '항목 이름에는 . { } [ ] 를 쓸 수 없습니다.';
      this.render();
      return;
    }
    if (this.draft.fields.some((f, i) => i !== index && f.key === next)) {
      this.error = `"${next}" 항목이 이미 있습니다.`;
      this.render();
      return;
    }
    if (this.draft.kind === 'item' && this.draft.values) {
      this.draft.values[next] = this.draft.values[field.key] ?? '';
      delete this.draft.values[field.key];
    }
    field.key = next;
    this.error = '';
    // Tab 으로 다음 칸에 간 뒤에 다시 그린다 — 지금 그리면 포커스가 이름 칸으로 돌아온다
    requestAnimationFrame(() => { if (this.isOpen) this.render(); });
  }

  /** 붙여 넣은 표 — 열이 모자라면 늘린다 (넘치는 칸을 말없이 버리지 않는다) */
  private pasteGrid(r0: number, c0: number, grid: string[][]): void {
    const rows = (this.draft.rows ??= []);
    const wasEmpty = rows.every((r) => r.every((v) => !v.trim()));
    const need = c0 + Math.max(0, ...grid.map((cells) => cells.length));
    const before = this.draft.fields.length;
    while (this.draft.fields.length < need) this.pushField();
    const added = this.draft.fields.length - before;
    const width = this.draft.fields.length;
    grid.forEach((cells, dr) => {
      const r = r0 + dr;
      while (rows.length <= r) rows.push(Array.from({ length: width }, () => ''));
      cells.forEach((value, dc) => { rows[r][c0 + dc] = value.trim(); });
    });
    // 빈 표의 첫 칸에 여러 줄을 붙였으면 첫 줄이 머리 줄일 수 있다 — 짐작하지 않고 묻는다
    this.headerOffer = wasEmpty && r0 === 0 && c0 === 0 && grid.length >= 2;
    this.host.announce(`${grid.length}줄을 붙여 넣었습니다${added > 0 ? ` — 열 ${added}개를 더했습니다` : ''}`);
    this.render();
  }

  private useHeaderRow(): void {
    const first = this.draft.rows?.shift();
    if (first) {
      const keys = headerKeys(first, this.draft.fields.map((f) => f.key));
      this.draft.fields.forEach((f, i) => { f.key = keys[i]; });
    }
    this.headerOffer = false;
    this.render();
  }

  // ─── 저장 · 지우기 · AI ───────────────────────────────

  private async save(): Promise<void> {
    if (this.saving) return;
    if (!this.draft.name.trim()) {
      this.error = '카드 이름을 적어 주세요.';
      this.render();
      this.body.querySelector<HTMLElement>('.dg-ce-name')?.focus();
      return;
    }
    this.saving = true;
    this.error = '';
    this.render();
    try {
      // 명단의 빈 줄(적으려고 둔 줄)은 저장하지 않는다
      const payload = cloneDraft(this.draft);
      if (payload.kind === 'table') payload.rows = (payload.rows ?? []).filter((r) => r.some((v) => v.trim()));
      const card = await this.host.hub.saveCard(payload);
      this.saving = false;
      this.host.saved(card);
      this.host.announce(`"${card.name}" 카드를 저장했습니다`);
      this.close();
    } catch (error) {
      this.saving = false;
      this.error = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  private async remove(): Promise<void> {
    if (!this.original) return;
    try {
      await this.host.hub.deleteCard(this.original.id);
      this.host.deleted(this.original.id);
      this.host.announce(`"${this.original.name}" 카드를 지웠습니다`);
      this.close();
    } catch (error) {
      this.confirmDelete = false;
      this.error = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }

  private async runAi(): Promise<void> {
    const ai = this.host.ai;
    if (!ai || this.aiAbort) return;
    const instruction = this.aiText.trim();
    if (!instruction && !this.aiFile) {
      this.body.querySelector<HTMLElement>('.dg-ce-ai textarea')?.focus();
      return;
    }
    const ready = ai.readiness();
    if (!ready.ok) {
      this.aiLog.push({ who: 'agent', text: ready.reason, tone: 'error' });
      this.render();
      return;
    }
    const file = this.aiFile;
    this.aiLog.push({ who: 'user', text: [instruction, file ? `파일: ${file.name}` : ''].filter(Boolean).join('\n') });
    this.aiText = '';
    this.aiFile = null;
    const abort = new AbortController();
    this.aiAbort = abort;
    const pending = { who: 'agent' as const, text: '초안을 만드는 중…', tone: 'quiet' as 'quiet' | 'error' | undefined };
    this.aiLog.push(pending);
    this.render();
    // 사람이 고치던 초안을 넘긴다 — 처음 여는 빈 새 카드는 넘기지 않는다
    const untouched = !this.original && !this.draft.name.trim() && this.draft.fields.length === 1 && !(this.draft.values?.[this.draft.fields[0].key] ?? '').trim();
    try {
      let noted = false;
      const next = await ai.run(
        { instruction, draft: untouched ? null : cloneDraft(this.draft), file, signal: abort.signal },
        (text, tone) => {
          if (tone === 'quiet') {
            // 진행 안내("파일을 읽는 중…")는 답이 오기 전까지 기다림 줄에 보인다
            if (!noted) pending.text = text;
          } else if (tone === 'error') {
            this.aiLog.push({ who: 'agent', text, tone });
          } else {
            if (!noted) { noted = true; pending.text = ''; pending.tone = undefined; }
            pending.text += text;
          }
          if (this.isOpen) this.render();
        },
      );
      if (!noted) pending.text = next ? '초안을 만들었습니다. 아래에서 확인하고 저장하세요.' : '바꿀 것이 없었습니다.';
      if (!pending.text.trim()) this.aiLog.splice(this.aiLog.indexOf(pending), 1);
      if (next && this.isOpen) {
        // 초안이 왔으면 양식으로 — 한 말과 답은 접힌 칸에 펼쳐 둔다
        if (this.step === 'ai') { this.step = 'form'; this.aiOpen = true; }
        this.applyDraft(next);
      }
    } catch (error) {
      pending.text = abort.signal.aborted ? '그만두었습니다.' : `만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      pending.tone = abort.signal.aborted ? 'quiet' : 'error';
    } finally {
      if (this.aiAbort === abort) this.aiAbort = null;
      if (this.isOpen) this.render();
    }
  }
}
