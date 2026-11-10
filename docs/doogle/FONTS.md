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
