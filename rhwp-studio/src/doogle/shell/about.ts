/**
 * 두글 제품 정보 — 파일 › 정보 › 제품 정보.
 *
 * upstream rhwp 의 제품 정보(about-dialog.ts, "HWP/HWPX Compatible Module for Rust")는 두지 않고
 * 두글의 이름·버전·출처를 보인다. HWP 공개 스펙 고지 문구는 upstream 과 같은 문장을 그대로 싣는다(필수).
 * upstream 파일은 고치지 않는다(동기화 충돌을 피한다) — 같은 ModalDialog 를 쓰는 별도 대화상자다.
 */
import { ModalDialog } from '@/ui/dialog';
import { t } from '@/i18n/index.ts';
import { isDesk, openExternal } from '../ui/desk-bridge';
import { currentVersion } from './updater';

const CREDITS: Array<{ what: string; name: string; url: string; license: string }> = [
  { what: '문서 엔진·편집기 화면', name: 'rhwp', url: 'https://github.com/edwardkim/rhwp', license: 'MIT · © 2025-2026 Edward Kim' },
  { what: '에이전트 도구 설계', name: 'rhwp-x', url: 'https://github.com/banatic/rhwp-x', license: 'MIT' },
];

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class DoogleAboutDialog extends ModalDialog {
  constructor() {
    super('제품 정보', 440);
  }

  protected createBody(): HTMLElement {
    const body = div('dg-about');

    const head = div('dg-about-head');
    head.append(div('dg-about-name', '두글'), div('dg-about-tag', 'HWP·HWPX 편집기와 AI 문서 편집 에이전트'));
    body.appendChild(head);

    // 버전 — 데스크탑은 앱 버전, 웹은 편집기 빌드만
    const version = div('dg-about-version');
    const engine = `문서 엔진 rhwp v${__APP_VERSION__}`;
    version.textContent = isDesk() ? `두글 · ${engine}` : `두글 웹 미리보기 · ${engine}`;
    if (isDesk()) {
      void currentVersion().then((v) => { if (v) version.textContent = `두글 v${v} · ${engine}`; }).catch(() => {});
    }
    body.appendChild(version);

    body.appendChild(div('dg-about-desc',
      '문서를 열고 옆 창의 AI에게 말로 부탁하면, 문서를 읽고 고칠 곳을 제안합니다. 승인한 변경만 문서에 반영됩니다.'));

    // 출처
    const credits = div('dg-about-credits');
    credits.appendChild(div('dg-about-label', '바탕이 된 오픈소스'));
    for (const c of CREDITS) {
      const row = div('dg-about-credit');
      const link = document.createElement('a');
      link.href = c.url;
      link.textContent = c.name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      if (isDesk()) {
        link.addEventListener('click', (e) => { e.preventDefault(); void openExternal(c.url); });
      }
      const what = document.createElement('span');
      what.className = 'dg-about-what';
      what.textContent = c.what;
      const lic = document.createElement('span');
      lic.className = 'dg-about-lic';
      lic.textContent = c.license;
      row.append(what, link, lic);
      credits.appendChild(row);
    }
    body.appendChild(credits);

    // HWP 공개 스펙 고지 (필수)
    body.appendChild(div('dg-about-notice', t('dialog.about.notice.text')));

    body.appendChild(div('dg-about-foot', '사용한 오픈소스 라이브러리의 라이선스 전문은 THIRD_PARTY_LICENSES.md에 있습니다.'));
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
