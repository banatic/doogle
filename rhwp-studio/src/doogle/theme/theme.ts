/**
 * 두글 테마 도우미 — upstream `core/theme.ts` 를 *따라가기만* 한다.
 *
 * 테마 상태의 주인은 upstream 이다. `initThemeSync()`(main.ts)가 사용자 설정
 * (시스템/밝게/어둡게)을 읽어 `<html data-theme-mode>`·`data-theme-effective` 와
 * 인라인 `color-scheme` 을 찍고, 두글 CSS(tokens.css)는 `data-theme-effective="dark"` 에
 * 반응한다. 여기서는 설정을 따로 저장하지 않는다.
 *
 * - 전환 UI 는 upstream 명령을 재사용한다: `automation.execute('view:theme-dark')` 등.
 * - TS 에서 색을 읽어야 하는 곳(캔버스에 직접 그리는 오버레이 등)은 `readToken()` 과
 *   `observeEffectiveTheme()` 로 다시 읽는다.
 */

export type DoogleEffectiveTheme = 'light' | 'dark';

/** 보기 › 테마 메뉴와 같은 upstream 명령 ID (리본·백스테이지에서 재사용). */
export const THEME_COMMANDS = {
  system: 'view:theme-system',
  light: 'view:theme-light',
  dark: 'view:theme-dark',
} as const;

export function getEffectiveTheme(root: HTMLElement = document.documentElement): DoogleEffectiveTheme {
  return root.dataset.themeEffective === 'dark' ? 'dark' : 'light';
}

/** `--dg-*` 토큰의 현재 계산값. 테마가 바뀌면 다시 읽어야 한다. */
export function readToken(name: `--dg-${string}`, root: HTMLElement = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/** 실제 적용 테마가 바뀔 때마다 콜백. 해제 함수를 돌려준다. */
export function observeEffectiveTheme(
  cb: (theme: DoogleEffectiveTheme) => void,
  root: HTMLElement = document.documentElement,
): () => void {
  let last = getEffectiveTheme(root);
  const mo = new MutationObserver(() => {
    const next = getEffectiveTheme(root);
    if (next !== last) {
      last = next;
      cb(next);
    }
  });
  mo.observe(root, { attributes: true, attributeFilter: ['data-theme-effective'] });
  return () => mo.disconnect();
}
