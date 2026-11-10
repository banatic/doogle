/**
 * 수식 대체 글꼴 — 한컴 수식 글꼴(HYhwpEQ · HancomEQN)이 없는 컴퓨터에서 수식 글자가 깨지지 않게 한다.
 *
 * 한글 수식은 한컴 수식 글꼴의 사설 영역(PUA) 코드로 글자를 그린다. 그 글꼴이 없으면 브라우저가
 * PUA 코드를 아무 글꼴로나 그려 x · b · 숫자가 한글 비슷한 글자나 네모로 보인다(편집 화면도,
 * 에이전트가 보는 쪽 그림도). 그래서 같은 PUA 코드에 Latin Modern Math 글리프를 묶은 작은 글꼴
 * (`theme/fonts/DoogleEqFallback.woff2`, scripts/doogle/build-eq-fallback-font.py 가 만든다)을
 * 그 글꼴 이름으로 건다.
 *
 *  - upstream 의 캔버스 글꼴 대체(wasm-bridge.ts substituteCssFontFamily)는 "등록된 글꼴"이 아닌 이름을
 *    맑은 고딕 같은 대체 사슬로 바꿔치기한다 — 그래서 두 이름을 `REGISTERED_FONTS` 에 올려야
 *    우리 글꼴이 실제로 쓰인다.
 *  - 진짜 글꼴이 설치돼 있고 사용자가 글꼴 찾기를 승인했으면 upstream 이 그 글꼴을 먼저 쓴다
 *    (대체 사슬 맨 앞에 설치 글꼴 별칭이 온다). 승인 전에는 이 대체 글꼴로 그린다.
 *  - 글자 자리(전진 폭)는 엔진이 한컴 메트릭으로 정하므로 조판은 그대로다. 윤곽만 바뀐다.
 *  - 글꼴이 로드되면 upstream(main.ts)의 `document.fonts` 'loadingdone' 처리기가 화면을 다시 그린다.
 * 고지: docs/doogle/FONTS.md
 */

import { REGISTERED_FONTS } from '@/core/font-loader';

/** 엔진이 수식 글자를 그릴 때 부르는 글꼴 이름 */
const EQUATION_FAMILIES = ['HyhwpEQ', 'HancomEQN'];
/** 문서가 수식 글꼴로 적어 두는 이름 (글꼴 상태 판정용 — 대소문자가 다르다) */
const DOCUMENT_NAMES = ['HYhwpEQ'];

let installed = false;

export function installEquationFallbackFont(): void {
  if (installed || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return;
  installed = true;
  const url = new URL('../theme/fonts/DoogleEqFallback.woff2', import.meta.url).href;
  for (const family of EQUATION_FAMILIES) {
    try {
      const face = new FontFace(family, `url("${url}") format("woff2")`, { display: 'block' });
      document.fonts.add(face);
      // 캔버스는 아직 로드되지 않은 글꼴을 기다리지 않는다 — 미리 불러 둔다.
      face.load().catch((error) => console.warn(`[doogle] 수식 대체 글꼴(${family})을 불러오지 못했습니다`, error));
    } catch (error) {
      console.warn(`[doogle] 수식 대체 글꼴(${family})을 걸지 못했습니다`, error);
    }
  }
  for (const name of [...EQUATION_FAMILIES, ...DOCUMENT_NAMES]) REGISTERED_FONTS.add(name);
}
