/**
 * 글꼴 알림 — 문서의 글꼴이 이 컴퓨터에 없을 때 상태 표시줄에 작게 알린다.
 *
 * upstream 은 이때 화면 한가운데 「로컬 글꼴 감지」 창을 띄우고 답을 기다리는 동안 쪽을 그리지 않는다.
 * 두글에서는 비슷한 글꼴로 바로 그리고(main.ts promptLocalFontsIfNeeded 의 두글 분기),
 * 상태 표시줄 오른쪽의 「● 글꼴 8개 대체」 표시가 사실만 알린다. 문서 영역의 자리는 쓰지 않는다
 * (문서 위 띠였을 때 급하지 않은 알림이 매번 문서 자리를 차지했다).
 *
 *  - main.ts 가 문서를 열 때마다 window 이벤트 `doogle:fonts-missing` 을 쏜다
 *    ({detail: FontNoticeDetail}; 없는 글꼴이 없으면 fonts 가 빈 배열 → 표시를 내린다).
 *  - 표시를 누르면 그 위로 작은 창이 떠서 글꼴 이름을 보여 주고, 이 컴퓨터에서 찾아볼 수 있으면 찾기 단추를 준다.
 *  - 바깥을 누르거나 Esc 로 닫는다.
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

/** 상태 표시줄 표시 문구 — 자리를 적게 쓰도록 짧게 */
export function fontChipText(fonts: readonly FontNoticeItem[]): string {
  return fonts.length === 0 ? '' : `글꼴 ${fonts.length}개 대체`;
}

/** 표시를 상태 표시줄(`statusBar`) 오른쪽에 세운다. 이벤트가 오기 전에는 숨어 있다. */
export function mountFontNotice(statusBar: HTMLElement): void {
  const chip = button('stb-item dg-sb-fonts', '', () => { open = !open; render(); });
  chip.setAttribute('aria-haspopup', 'dialog');
  chip.hidden = true;
  statusBar.append(chip);

  const pop = el('div', 'dg-fontpop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '문서 글꼴');
  pop.hidden = true;
  document.body.append(pop);

  let detail: FontNoticeDetail | null = null;
  let open = false;
  let busy = false;

  function close(): void {
    if (!open) return;
    open = false;
    render();
  }
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node | null;
    if (target && (pop.contains(target) || chip.contains(target))) return;
    close();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !open) return;
    close();
    chip.focus();
  });
  window.addEventListener('resize', close);

  function render(): void {
    const fonts = detail?.fonts ?? [];
    chip.hidden = fonts.length === 0;
    chip.replaceChildren();
    pop.replaceChildren();
    if (!detail || fonts.length === 0) open = false;
    pop.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
    if (!detail || fonts.length === 0) return;

    const dot = el('span', 'dg-sb-dot dg-sb-dot--warn');
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot, el('span', '', fontChipText(fonts)));
    chip.title = fontNoticeText(fonts);
    if (!open) return;

    // 표시 바로 위에 띄운다 (상태 표시줄은 창 맨 아래)
    const rect = chip.getBoundingClientRect();
    pop.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;

    const panel = el('div', 'dg-banner-detail');
    panel.append(el('div', 'dg-banner-text', fontNoticeText(fonts)));
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
    pop.append(panel);
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
