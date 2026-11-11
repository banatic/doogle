/**
 * 두글 제품 정보 — 파일 › 정보 › 제품 정보.
 *
 * 아이콘 · 이름 · 버전 · 출처 한 줄 · HWP 공개 스펙 고지(필수, upstream 과 같은 문장).
 * upstream rhwp 의 제품 정보(about-dialog.ts)는 고치지 않는다 — 같은 ModalDialog 를 쓰는 별도 대화상자다.
 */
import { ModalDialog } from '@/ui/dialog';
import { t } from '@/i18n/index.ts';
import { isDesk, openExternal } from '../ui/desk-bridge';
import { currentVersion } from './updater';

const RHWP_URL = 'https://github.com/edwardkim/rhwp';

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class DoogleAboutDialog extends ModalDialog {
  constructor() {
    super('제품 정보', 400);
  }

  protected createBody(): HTMLElement {
    const body = div('dg-about');

    const logo = document.createElement('img');
    logo.className = 'dg-about-logo';
    logo.src = '/doogle/icon-256.png';
    logo.alt = '';
    logo.width = 72;
    logo.height = 72;

    const name = div('dg-about-name', '두글');
    const version = div('dg-about-version');
    const engine = `rhwp v${__APP_VERSION__}`;
    version.textContent = isDesk() ? `엔진 ${engine}` : `웹 미리보기 · 엔진 ${engine}`;
    if (isDesk()) {
      void currentVersion().then((v) => { if (v) version.textContent = `v${v} · 엔진 ${engine}`; }).catch(() => {});
    }
    body.append(logo, name, version);

    // 출처 — rhwp(MIT) 의 저작권 표시
    const credit = div('dg-about-credit');
    const link = document.createElement('a');
    link.href = RHWP_URL;
    link.textContent = 'rhwp';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (isDesk()) link.addEventListener('click', (e) => { e.preventDefault(); void openExternal(RHWP_URL); });
    credit.append('문서 엔진 ', link, ' · MIT · © 2025-2026 Edward Kim');
    body.appendChild(credit);

    // HWP 공개 스펙 고지 (필수)
    body.appendChild(div('dg-about-notice', t('dialog.about.notice.text')));
    return body;
  }

  protected onConfirm(): void {
    // 정보 표시 전용
  }

  override show(): void {
    super.show();
    const footer = this.dialog.querySelector('.dialog-footer');
    if (footer) {
      footer.replaceChildren();
      const close = document.createElement('button');
      close.className = 'dialog-btn dialog-btn-primary';
      close.textContent = '닫기';
      close.addEventListener('click', () => this.hide());
      footer.appendChild(close);
    }
  }
}

export function openDoogleAbout(): void {
  new DoogleAboutDialog().show();
}
