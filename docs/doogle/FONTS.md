# 두글 번들 글꼴 고지

두글(doogle) 데스크탑 셸의 UI 글꼴로 아래 글꼴을 저장소와 배포물에 포함한다. 문서 본문
렌더링 글꼴과는 무관하며, `<html data-doogle>` 화면의 `--dg-font-ui`에서만 쓴다.

## Pretendard Variable 1.3.9

| 항목 | 값 |
| --- | --- |
| 저작권 | Copyright (c) 2021, Kil Hyung-jin, with Reserved Font Name Pretendard |
| 라이선스 | SIL Open Font License 1.1 (`OFL-1.1`) |
| 출처 | npm `pretendard@1.3.9` (<https://github.com/orioncactus/pretendard>) |
| 원본 경로 | `dist/web/variable/woff2/PretendardVariable.woff2`, `dist/LICENSE.txt` |
| 저장소 경로 | `rhwp-studio/src/doogle/theme/fonts/PretendardVariable.woff2` |
| 크기 | 2,057,688 바이트 (가변 굵기 45–920, 수정 없음) |
| SHA-256 | `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4` |
| 라이선스 전문 | `rhwp-studio/src/doogle/theme/fonts/Pretendard-OFL.txt` (SHA-256 `b04538c9abec39a3db75108cf0af0fd9c77032fe8aa2cf38345b4d250e98e38e`) |

### 재배포 조건 확인

- OFL 1.1은 소프트웨어와 함께 묶어 재배포하는 것을 허용한다. 글꼴만 단독으로 판매하지 않는다.
- 저작권 고지와 라이선스 전문을 함께 배포한다(위 `Pretendard-OFL.txt`, Vite 빌드 산출물과 함께
  이 문서를 포함한다).
- 글꼴 파일을 수정하지 않았으므로 예약 글꼴 이름(Reserved Font Name) "Pretendard"를 그대로 쓴다.
  서브셋 등으로 수정하면 OFL 1.1 제3조에 따라 다른 이름으로 바꿔야 한다.

### 로드 방식

`rhwp-studio/src/doogle/theme/fonts.css`의 `@font-face`(`font-display: swap`)가 Vite 자산으로
로컬 파일을 참조한다. CDN을 쓰지 않으므로 오프라인에서도 같은 모양으로 그려진다. 로드 전·실패
시에는 `Malgun Gothic` → `Apple SD Gothic Neo` → `Noto Sans KR` → 시스템 글꼴 순으로 떨어진다.

## Doogle Eq Fallback (Latin Modern Math 1.959 파생)

수식 글자가 깨지지 않게 하는 대체 글꼴이다. 한글 수식은 한컴 수식 글꼴(HYhwpEQ · HancomEQN)의
사설 영역(PUA) 코드로 글자를 그리는데, 그 글꼴이 없는 컴퓨터에서는 x · b · 숫자가 한글 비슷한
글자나 네모로 보였다. 두글은 같은 PUA 코드에 Latin Modern Math 글리프를 묶은 작은 글꼴을 함께
싣고, 진짜 글꼴이 없을 때만 그것으로 그린다. **한컴 수식 글꼴 자체는 싣지 않는다.**

| 항목 | 값 |
| --- | --- |
| 원본 | Latin Modern Math 1.959 — `assets/fonts/LatinModernMath-Regular.woff2` (upstream rhwp 에 이미 포함) |
| 저작권 | Copyright 2012--2014 for Latin Modern Math OTF by B. Jackowski, P. Strzelczyk and P. Pianowski (on behalf of TeX users groups) |
| 라이선스 | GUST Font License (LPPL 1.3c 기반) |
| 저장소 경로 | `rhwp-studio/src/doogle/theme/fonts/DoogleEqFallback.woff2` |
| 크기 | 18,712 바이트 (글리프 210개) |
| SHA-256 | `bb03f8bc4f9bfd248765e85b9802d6e32d736917899a343ca9ca06c76f57d74f` |
| 라이선스 전문 | `rhwp-studio/src/doogle/theme/fonts/DoogleEqFallback-GUST-FONT-LICENSE.txt`, `assets/fonts/licenses/LPPL-1.3c.txt` |
| 만드는 법 | `python scripts/doogle/build-eq-fallback-font.py` (fontTools · brotli) |

### 고친 내용

- 필요한 글리프만 남겼다(영문·숫자·연산자·그리스 문자·수학 이탤릭).
- 한컴 수식 글꼴이 쓰는 PUA 코드(U+E000…)를 그 글자에 해당하는 Latin Modern Math 글리프에 묶었다.
  대응표는 엔진의 `src/renderer/equation/hancom_glyphs.rs` `glyph()` 와 같다.
- 조판 표(MATH · GSUB · GPOS)는 뺐다 — 수식 조판은 엔진이 한다.
- GUST Font License 의 요청대로 글꼴 이름을 "Doogle Eq Fallback" 으로 바꿨다.

### 로드 방식

`rhwp-studio/src/doogle/shell/eq-font.ts` 가 두글 모드에서만 `HyhwpEQ` · `HancomEQN` 이름의
`FontFace` 로 이 글꼴을 걸고, 두 이름을 upstream 의 등록 글꼴 목록(`REGISTERED_FONTS`)에 올린다
— 올리지 않으면 캔버스 글꼴 대체가 그 이름을 맑은 고딕 사슬로 바꿔치기해 PUA 글자가 깨진다.
진짜 한컴 수식 글꼴이 설치돼 있고 사용자가 알림 띠의 "이 컴퓨터에서 글꼴 찾기"를 승인했으면
upstream 이 설치 글꼴을 먼저 쓴다. 승인 전에는 이 대체 글꼴로 그린다.
글자 자리(전진 폭)는 엔진이 한컴 메트릭으로 정하므로 조판은 바뀌지 않고 글자 윤곽만 바뀐다.
