// 다크테마·도구 상자 FOUC(Flash of Unstyled Content) 방지 — 페이지 렌더 전에 즉시 적용한다.
//
// 브라우저 확장 CSP(`script-src 'self' 'wasm-unsafe-eval'`)는 인라인 스크립트를 금지하므로,
// 이 로직은 인라인이 아니라 외부 파일로 두고 index.html <head> 최상단에서
// `<script src="/theme-init.js">`(동기)로 로드한다 (#1444). module/defer 를 쓰면 번들 이후
// 실행되어 FOUC 방지 효과를 잃으므로 동기 로드를 유지한다.
(() => {
  const root = document.documentElement;
  const isThemeMode = (value) => value === 'system' || value === 'light' || value === 'dark';
  let mode = 'system';
  let skin = 'default';
  try {
    const settings = JSON.parse(localStorage.getItem('rhwp-settings') || '{}');
    const storedMode = settings && settings.theme && settings.theme.mode;
    if (isThemeMode(storedMode)) mode = storedMode;
    var storedSkin = settings && settings.theme && settings.theme.skin;
    // 스킨 목록은 core/user-settings.ts 의 THEME_SKINS 와 함께 갱신한다.
    if (storedSkin === 'flat' || storedSkin === 'oldschool') skin = storedSkin;
  } catch {
    mode = 'system';
  }
  if (skin !== 'default') root.dataset.themeSkin = skin;
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = mode === 'dark' || (mode === 'system' && prefersDark) ? 'dark' : 'light';
  const scheme = `only ${effective}`;
  root.dataset.themeMode = mode;
  root.dataset.themeEffective = effective;
  root.style.colorScheme = scheme;
  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (colorSchemeMeta) colorSchemeMeta.setAttribute('content', scheme);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', effective === 'dark' ? '#2b3037' : '#f5f5f5');

  // 도구 상자(기본/서식) 숨김도 같은 시점에 찍는다 — 숨기기로 저장해 두면 첫 페인트부터
  // 숨긴 상태로 그려져 도구 모음이 잠깐 보였다 사라지지 않는다.
  // 속성·기본값은 src/view/toolbox-visibility.ts, 규칙은 src/style.css 와 함께 갱신한다.
  let toolbarBasic = true;
  let toolbarFormat = true;
  try {
    const settings = JSON.parse(localStorage.getItem('rhwp-settings') || '{}');
    const view = (settings && settings.view) || {};
    if (view.toolbarBasic === false) toolbarBasic = false;
    if (view.toolbarFormat === false) toolbarFormat = false;
  } catch {
    toolbarBasic = true;
    toolbarFormat = true;
  }
  // [doogle] 두글 모드(Tauri 또는 ?doogle=1)는 첫 페인트부터 셸 스타일을 쓴다 — src/doogle/index.ts isDoogleMode 와 같은 판정.
  // [doogle] 셸(제목 막대·리본)과 두글 CSS 는 JS 가 올린다. 그 전에 upstream 메뉴·도구 모음이 잠깐 보이지 않게
  // data-doogle-booting 동안 body 를 감춘다(src/style.css 끝). src/doogle/index.ts 가 셸을 올린 첫 프레임에 지운다.
  if (window.__TAURI_INTERNALS__ || root.hasAttribute('data-doogle-entry') || /[?&]doogle=1(?:&|$)/.test(location.search)) {
    root.setAttribute('data-doogle', '');
    root.setAttribute('data-doogle-booting', '');
    setTimeout(() => root.removeAttribute('data-doogle-booting'), 4000); // 안전장치
  }
  root.dataset.toolboxBasic = toolbarBasic ? 'shown' : 'hidden';
  root.dataset.toolboxFormat = toolbarFormat ? 'shown' : 'hidden';
})();
