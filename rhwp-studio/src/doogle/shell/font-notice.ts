/**
 * 글꼴 알림 띠 — 문서의 글꼴이 이 컴퓨터에 없을 때 문서 위에 한 줄로 알린다.
 *
 * upstream 은 이때 화면 한가운데 「로컬 글꼴 감지」 창을 띄우고 답을 기다리는 동안 쪽을 그리지 않는다.
 * 두글에서는 비슷한 글꼴로 바로 그리고(main.ts promptLocalFontsIfNeeded 의 두글 분기),
 * 이 띠가 사실만 알린다: 「이 문서의 글꼴 8개가 이 컴퓨터에 없어 비슷한 글꼴로 보입니다. [글꼴 확인] [닫기]」.
 *
 *  - main.ts 가 문서를 열 때마다 window 이벤트 `doogle:fonts-missing` 을 쏜다
 *    ({detail: FontNoticeDetail}; 없는 글꼴이 없으면 fonts 가 빈 배열 → 띠를 내린다).
 *  - "글꼴 확인" 은 띠 아래에 글꼴 이름을 펼치고, 이 컴퓨터에서 찾아볼 수 있으면 찾기 단추를 준다.
 *  - "닫기" 는 이 문서에서만 닫는다(다음 문서를 열면 다시 판단한다).
 */

export const FONTS_MISSING_EVENT = 'doogle:fonts-missing';

export type FontNoticeStatus = 'needs-local-check' | 'web-substitute' | 'missing';

export interface FontNoticeItem {
  name: string;
  status: FontNoticeStatus;
  /** 대신 그리는 글꼴 (알면) */
  substitute: string | null;
}

export interface FontNoticeDetail {
  fonts: FontNoticeItem[];
  /** 이 컴퓨터에 설치된 글꼴을 찾아볼 수 있는가 (권한을 물을 수 있다) */
  canDetect: boolean;
  /** 이 컴퓨터에서 글꼴을 찾는다 — 끝나면 main.ts 가 새 상태로 이벤트를 다시 쏜다 */
  detect(): Promise<void>;
}

/** 띠 한 줄 문구 — 아직 찾아보지 않은 글꼴이 있으면 "없다"고 단정하지 않는다 */
export function fontNoticeText(fonts: readonly FontNoticeItem[]): string {
  const n = fonts.length;
  if (n === 0) return '';
  return fonts.some((f) => f.status === 'needs-local-check')
    ? `이 문서의 글꼴 ${n}개를 이 컴퓨터에서 아직 확인하지 않아 비슷한 글꼴로 보입니다.`
    : `이 문서의 글꼴 ${n}개가 이 컴퓨터에 없어 비슷한 글꼴로 보입니다.`;
}

const STATUS_TEXT: Record<FontNoticeStatus, string> = {
  'needs-local-check': '확인 전',
  'web-substitute': '비슷한 글꼴로 대체',
  missing: '없음',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** 띠를 `anchor` 바로 앞(문서 영역 위)에 세운다. 이벤트가 오기 전에는 숨어 있다. */
export function mountFontNotice(anchor: HTMLElement): void {
  const root = el('div', 'dg-banner');
  root.setAttribute('role', 'status');
  root.hidden = true;
  anchor.before(root);

  let detail: FontNoticeDetail | null = null;
  let open = false;
  let busy = false;

  function render(): void {
    const fonts = detail?.fonts ?? [];
    root.hidden = fonts.length === 0;
    root.replaceChildren();
    if (!detail || fonts.length === 0) return;

    const row = el('div', 'dg-banner-row');
    const dot = el('span', 'dg-sb-dot dg-sb-dot--warn');
    dot.setAttribute('aria-hidden', 'true');
    const toggle = button('dg-banner-link', open ? '접기' : '글꼴 확인', () => { open = !open; render(); toggle.focus(); });
    toggle.setAttribute('aria-expanded', String(open));
    const close = button('dg-banner-link dg-banner-close', '닫기', () => { detail = null; open = false; render(); });
    close.setAttribute('aria-label', '글꼴 알림 닫기');
    row.append(dot, el('span', 'dg-banner-text', fontNoticeText(fonts)), el('span', 'dg-banner-grow'), toggle, close);
    root.append(row);
    if (!open) return;

    const panel = el('div', 'dg-banner-detail');
    const list = el('ul', 'dg-banner-fonts');
    for (const font of fonts.slice(0, 40)) {
      const li = el('li', 'dg-banner-font');
      li.append(el('span', 'dg-banner-font-name', font.name));
      const note = font.substitute && font.status !== 'missing' ? `${STATUS_TEXT[font.status]} → ${font.substitute}` : STATUS_TEXT[font.status];
      li.append(el('span', 'dg-banner-font-note', note));
      list.append(li);
    }
    if (fonts.length > 40) list.append(el('li', 'dg-banner-font dg-banner-font-note', `그 밖에 ${fonts.length - 40}개`));
    panel.append(list);
    const acts = el('div', 'dg-banner-acts');
    if (detail.canDetect) {
      const current = detail;
      const find = button('dg-banner-btn', busy ? '찾는 중…' : '이 컴퓨터에서 글꼴 찾기', () => {
        if (busy) return;
        busy = true;
        render();
        current.detect()
          .catch((error) => console.warn('[doogle] 글꼴을 찾지 못했습니다', error))
          .finally(() => { busy = false; render(); });
      });
      find.disabled = busy;
      acts.append(find, el('span', 'dg-banner-hint', '설치된 글꼴 목록은 이 컴퓨터 안에서만 쓰입니다.'));
    } else {
      acts.append(el('span', 'dg-banner-hint', '글꼴을 설치한 뒤 문서를 다시 열면 원래 모양으로 보입니다.'));
    }
    panel.append(acts);
    root.append(panel);
  }

  window.addEventListener(FONTS_MISSING_EVENT, (event) => {
    const next = (event as CustomEvent<FontNoticeDetail | undefined>).detail;
    const fonts = Array.isArray(next?.fonts) ? next.fonts : [];
    // 같은 문서에서 찾기를 마친 갱신이면 펼친 상태를 지킨다. 새 문서(전혀 다른 목록)면 접는다.
    const same = !!detail && fonts.some((f) => detail!.fonts.some((d) => d.name === f.name));
    detail = next && fonts.length > 0 ? { ...next, fonts } : null;
    if (!same) open = false;
    render();
  });
}
