/**
 * 카드 서랍 — 사이드바 머리 아래에 열리는 "내 카드" 목록.
 *
 *  - 카드는 hub 가 이 컴퓨터(`<앱 데이터>/cards/`)에 둔다. 서랍은 열 때마다 목록을 다시 받는다.
 *  - 카드를 끌어 문서에 놓으면 채우고(4단계), 입력 상자에 놓으면 대화에 붙는다(3단계).
 *    끌기 형식은 `CARD_DRAG_TYPE` — 파일 끌기('Files')와 섞이지 않는다.
 *  - 끌 수 없는 경우를 위해 카드마다 "문서" · "대화" 단추를 둔다. 카드를 누르면 편집 화면이 열린다.
 */
import './card-shelf.css';
import type { Card, HubClient } from '../hub-client.ts';

/** 카드 끌기의 dataTransfer 형식 (값 = 카드 id) */
export const CARD_DRAG_TYPE = 'application/x-doogle-card';

/** 끌고 있는 카드 — dragover 동안에는 dataTransfer 값을 읽을 수 없어 여기에 둔다 */
let draggingCard: Card | null = null;
export function currentDraggedCard(): Card | null {
  return draggingCard;
}

/** 끌기 이벤트가 카드를 싣고 있는가 */
export function isCardDrag(event: DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes(CARD_DRAG_TYPE);
}

/** 서랍 한 줄에 보일 요약 — "항목 5개 · 민감 1" / "표 · 26줄 · 번호, 성명, …" */
export function cardSummary(card: Card): string {
  const sensitive = card.fields.filter((f) => f.sensitive).length;
  const lock = sensitive > 0 ? ` · 민감 ${sensitive}` : '';
  if (card.kind === 'table') {
    const keys = card.fields.slice(0, 3).map((f) => f.key).join(', ');
    return `표 · ${card.rows?.length ?? 0}줄 · ${keys}${card.fields.length > 3 ? ', …' : ''}${lock}`;
  }
  return `항목 ${card.fields.length}개${lock}`;
}

export interface CardShelfHost {
  hub: HubClient;
  /** 대화에 붙이기 */
  attach(card: Card): void;
  /** 문서에 넣기 (지금 커서 자리) */
  insert(card: Card): void;
  /** 편집 화면 열기 — card 가 null 이면 새 카드 */
  edit(card: Card | null): void;
  /** 서랍이 열리고 닫힐 때 (머리 단추 상태) */
  onToggle(open: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 카드 종류 이름 (아이콘으로 고른다) */
const TONE_LABEL: Record<string, string> = { person: '인적 사항', list: '명단', school: '기관', card: '카드' };

export class CardShelf {
  readonly root: HTMLElement;
  private readonly host: CardShelfHost;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;
  private readonly note: HTMLElement;
  private cards: Card[] = [];
  private loading = false;

  constructor(host: CardShelfHost) {
    this.host = host;
    this.root = el('section', 'dg-shelf');
    this.root.setAttribute('aria-label', '내 카드');
    this.root.hidden = true;

    const head = el('div', 'dg-shelf-head');
    this.count = el('span', 'dg-shelf-count', '내 카드');
    // 새 카드는 머리에 둔다 — 목록 끝에 두면 카드가 늘수록 옆으로 밀어야 보인다
    const add = el('button', 'dg-shelf-new', '+ 새 카드');
    add.type = 'button';
    add.addEventListener('click', () => this.host.edit(null));
    head.append(this.count, add);

    this.list = el('div', 'dg-shelf-list');
    this.list.setAttribute('role', 'list');
    this.list.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (this.list.scrollWidth <= this.list.clientWidth) return;
      event.preventDefault();
      this.list.scrollBy({ left: event.deltaY });
    }, { passive: false });
    this.note = el('p', 'dg-shelf-note');
    this.root.append(head, this.list, this.note);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  get items(): readonly Card[] {
    return this.cards;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(): void {
    this.root.hidden = false;
    this.host.onToggle(true);
    void this.refresh();
  }

  close(): void {
    this.root.hidden = true;
    this.host.onToggle(false);
  }

  /** 카드 하나가 저장·삭제되었다 — 다시 받지 않고 목록만 고친다 */
  noteSaved(card: Card): void {
    this.cards = [card, ...this.cards.filter((c) => c.id !== card.id)];
    this.render();
  }

  noteDeleted(id: string): void {
    this.cards = this.cards.filter((c) => c.id !== id);
    this.render();
  }

  find(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    if (this.cards.length === 0) this.note.textContent = '불러오는 중…';
    try {
      this.cards = await this.host.hub.listCards();
      this.render();
    } catch (error) {
      this.note.textContent = this.host.hub.state === 'open'
        ? `카드를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`
        : '에이전트 서비스에 연결되면 카드를 볼 수 있습니다.';
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    this.count.textContent = this.cards.length > 0 ? `내 카드 ${this.cards.length}` : '내 카드';
    this.note.textContent = this.cards.length === 0
      ? '내 인적 사항, 우리 반 명렬처럼 자주 쓰는 정보를 카드로 만들어 두세요.'
      : '문서에 끌어 놓으면 그 자리를 채우고, 입력 상자에 놓으면 대화에 붙습니다.';
    if (this.cards.length > 0) {
      this.list.replaceChildren(...this.cards.map((card) => this.renderCard(card)));
      return;
    }
    // 카드가 없을 때만 빈 자리에 큰 "첫 카드 만들기" 장을 둔다
    const first = el('button', 'dg-kc dg-kc-new');
    first.type = 'button';
    first.setAttribute('role', 'listitem');
    first.append(el('span', '', '+ 첫 카드 만들기'));
    first.addEventListener('click', () => this.host.edit(null));
    this.list.replaceChildren(first);
  }

  /**
   * 카드 한 장 — 서류 카드처럼: 위에 종류·아이콘, 가운데 이름, 아래 미리보기(값은 보이지 않는다).
   * 명단(표형)은 종이가 겹친 모양에 머리 칸과 줄 선, 항목형은 항목 이름을 늘어놓는다.
   */
  private renderCard(card: Card): HTMLElement {
    const tile = el('div', 'dg-kc');
    tile.setAttribute('role', 'listitem');
    tile.dataset.tone = card.icon;
    tile.dataset.kind = card.kind;
    tile.draggable = true;
    tile.dataset.cardId = card.id;
    tile.addEventListener('dragstart', (event) => {
      draggingCard = card;
      tile.classList.add('dg-kc-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData(CARD_DRAG_TYPE, card.id);
        event.dataTransfer.setData('text/plain', card.name);
      }
    });
    tile.addEventListener('dragend', () => {
      draggingCard = null;
      tile.classList.remove('dg-kc-dragging');
    });

    const face = el('button', 'dg-kc-face');
    face.type = 'button';
    face.setAttribute('aria-label', `${card.name} 카드 — ${cardSummary(card)}. 눌러서 편집, 끌어서 문서나 입력 상자에 놓기`);
    face.title = '눌러서 편집 · 끌어서 문서나 입력 상자에 놓기';
    face.addEventListener('click', () => this.host.edit(card));

    const top = el('span', 'dg-kc-top');
    const rows = card.rows?.length ?? 0;
    top.append(el('span', 'dg-kc-type', card.kind === 'table' ? `명단 · ${rows}줄` : `${TONE_LABEL[card.icon] ?? '카드'} · 항목 ${card.fields.length}`));
    if (card.fields.some((f) => f.sensitive)) {
      const lock = el('span', 'dg-kc-lock', '민감');
      lock.title = '민감 항목이 있습니다 — 에이전트에게는 가려서 보냅니다';
      top.append(lock);
    }

    const preview = el('span', 'dg-kc-preview');
    preview.setAttribute('aria-hidden', 'true');
    if (card.kind === 'table') {
      const head = el('span', 'dg-kc-sheet-head');
      for (const f of card.fields.slice(0, 3)) head.append(el('span', '', f.key));
      preview.append(head, el('span', 'dg-kc-rule'), el('span', 'dg-kc-rule'));
    } else {
      const keys = card.fields.slice(0, 4).map((f) => f.key);
      preview.append(el('span', 'dg-kc-keys', keys.join(' · ') + (card.fields.length > 4 ? ' …' : '')));
    }
    face.append(top, el('span', 'dg-kc-name', card.name), preview);

    const acts = el('span', 'dg-kc-acts');
    const toDoc = el('button', 'dg-kc-act');
    toDoc.type = 'button';
    toDoc.textContent = '문서에';
    toDoc.title = '지금 커서 자리를 이 카드로 채우기';
    toDoc.setAttribute('aria-label', `${card.name} 카드로 문서 채우기`);
    toDoc.addEventListener('click', () => this.host.insert(card));
    const toChat = el('button', 'dg-kc-act');
    toChat.type = 'button';
    toChat.textContent = '대화에';
    toChat.title = '대화에 붙이기';
    toChat.setAttribute('aria-label', `${card.name} 카드를 대화에 붙이기`);
    toChat.addEventListener('click', () => this.host.attach(card));
    acts.append(toDoc, toChat);

    tile.append(face, acts);
    return tile;
  }
}
