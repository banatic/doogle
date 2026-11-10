# 에이전트 평가와 도구 호출 감사 (2026-11-11)

두글 에이전트가 실제 문서를 고칠 때 도구를 어떻게 부르는지 기록하고, 거기서 드러난 결함을 고친 기록이다.
도구 정의(`doogle-agent/src/tools/`)나 실행기(`rhwp-studio/src/doogle/agent/`)를 바꿀 때는 이 평가를 다시 돌려 본다.

## 1. 평가 방법

`doogle-agent/eval/` 의 하네스는 실제 구성을 그대로 돌린다.

```
Node(eval/run.mjs) ── hub(createHub, provider 를 기록용으로 감쌈) ── ws ── studio(doogle.html, 헤드리스 Chrome)
```

- 문서는 실제 편집기 화면에서 열고, 요청은 사이드바 입력창으로 보낸다(`chat_send` 경로 그대로).
- provider 는 실제 `claude-sdk`(사용자의 Claude Code 로그인)다. 도구 호출의 인자·결과·오류·시간을 전부 남긴다.
- 턴이 끝나면 문서 구조를 다시 읽어 전후를 비교하고, 시나리오마다 결과 검사를 돌린다.

```sh
# 문서 받기 (upstream samples/ — 저장소에는 넣지 않는다)
git cat-file blob "upstream/main:samples/biz_plan.hwp" > doogle-agent/eval/.fixtures/biz_plan.hwp   # scenarios.mjs 의 doc 마다

cd doogle-agent
node eval/run.mjs --tag mine --parallel 4          # 전체 (약 8분, Claude 구독 한도 사용)
node eval/run.mjs --only table-create,proofread    # 일부
node eval/show.mjs mine/table-create               # 한 시나리오의 호출 기록
node eval/probe.mjs biz_plan.hwp eval/probes/real-engine.mjs   # 모델 없이 실제 엔진으로 도구 검증
node eval/ui-shots.mjs                             # 모델 없이 화면 상태 캡처 (UI 점검용)
```

결과는 `output/agent-eval/<tag>/` 에 쌓인다: 시나리오별 `transcript.json`·`audit.md`·`diff.txt`·쪽 그림, 전체 `summary.md`.
준비물: WASM 빌드(`pkg/`), `rhwp-studio`·`doogle-agent` 의 `npm install`, Chrome, `claude` 로그인.

## 2. 결과

같은 모델(Claude Code 기본값), 에이전트 모드, 문서 13종.

| | 고치기 전 | 고친 뒤 |
|---|---|---|
| 시나리오 | 25 | 26 |
| 결과 검사 통과 ² | 22 / 25 | 26 / 26 |
| 도구 호출 | 145 | 73 |
| 도구 오류 | 3 | 0 |
| 도구 결과 글자 수 (모델이 읽는 양) | 284,378 | 99,408 ¹ |
| 턴 시간 합계 | 979초 | 490초 |

¹ 수식 시나리오에서 모델이 쪽 SVG(31만 자)를 한 번 읽은 것을 뺀 값. 그 뒤 SVG 는 10만 자를 넘으면 거절하게 했다(§3-12).

² 두 열의 검사는 같지 않다. 고치기 전의 검사는 "요청한 글이 문서에 들어갔나" 정도였고, 기록을 읽어 찾은 결함을
잡도록 검사를 보강한 뒤 다시 돌린 것이 오른쪽이다(시나리오 1개 추가). 고치기 전에 검사를 통과한 시나리오 가운데
둘은 실제로는 문서를 망가뜨렸다: 기존 표를 지운 것(§3-1), 배경색이 바뀌지 않았는데 바뀌었다고 보고한 것(§3-5).

## 3. 찾은 결함과 고친 내용

| # | 증상 (평가 기록) | 원인 | 고친 내용 |
|---|---|---|---|
| 1 | "문서 끝에 제목과 표 추가" 요청에서 **기존 표를 지우고** 손으로 다시 만들었다. 도구 25회, 185초 (`table-create`) | 표가 든 문단 끝에 `insert_text "\n…"` 를 넣으면 글이 표 앞에 들어간다. 되돌리려는 `delete_range p92@0..p94@0` 은 끝 문단 오프셋 0 의 표까지 지웠다. 도구는 성공으로 답했다 | 글 범위 도구는 표·그림·수식이 걸리면 `RANGE_HAS_OBJECTS` 로 거절하고 고칠 호출을 알려 준다. 표로 끝나는 문단에 오프셋 없이 덧붙이면 `OBJECT_AT_PARAGRAPH_END`. 문단 단위 도구 `insert_paragraphs` / `delete_paragraphs` / `move_paragraphs` 추가 |
| 2 | 위 사고 뒤 모델이 `copyControl [0,89,0]` 을 불러 **엔진이 죽었다** (`memory access out of bounds`) | 엔진 탈출구가 메서드 이름만 알려 주고 시그니처를 주지 않았다. wasm-bindgen 메서드는 인자 형이 틀리면 오류 대신 메모리를 잘못 읽는다 | `engine-signatures.generated.ts`(생성물)로 시그니처를 알려 주고, 부르기 전에 개수·형을 대조한다. 엔진 트랩은 도구 오류로 감싸지 않고 그대로 올린다 |
| 3 | 실패한 편집 한 번에 **문서 편집이 통째로 잠겼다** (`EDITOR_BLOCKED`, "문서를 다시 여세요") | 실행기가 실패를 transaction 밖으로 던지면 studio 가 명령 실패 복구(화면·커서·기록 대조)를 돌린다. 그 확인이 어긋나면(쪽이 아직 안 그려짐, 검토 거절 직후 등) 세션을 잠근다 | 예상된 도구 실패는 transaction 안에서 받아 스스로 되돌리고 `tx.noChange()` 로 끝낸다(플러그인 계약에 훅 1개 추가). undo 기록도 남지 않는다 |
| 4 | 중첩 표 안의 글을 `find_text` 가 본문 문단으로 돌려줘(문맥도 빈 문자열) 모델이 주소를 찾느라 9번 더 읽고 실패했다 (`long-doc-find-edit`) | 엔진 `searchAllText` 는 중첩 셀에 `cellPath` 만 싣는데 실행기는 `cellContext` 가 있을 때만 셀로 봤다. `get_structure` 는 중첩 표를 아예 보이지 않았다 | `cellPath` 만 와도 셀 주소로 옮긴다. `get_structure` 가 중첩 표를 `▦` 와 `nested table in [n] … cellPath […]` 로 보인다 |
| 5 | 머리행 배경을 바꾸라는 요청에 도구는 성공, 모델도 "바꿨습니다"라고 했지만 **화면은 그대로**였다 (`table-style-header`) | `set_zone_borders` 의 영역 채움은 셀이 자기 채움을 갖고 있으면 그 아래 깔려 보이지 않는다(값은 바뀐 것처럼 읽힌다) | 채움은 영역 안 셀마다 직접 넣는다. 여러 셀 배경은 `set_cell_props cellIdxs` |
| 6 | `ask_user_question` 을 부르면 항상 `NOT_HANDLED_IN_STUDIO` (`format-headings`) | 대화 제어 도구 4개가 정의만 있고 hub·사이드바에 응답 화면이 없다. 시스템 프롬프트는 쓰라고 지시했다 | 도구 목록에서 뺐다. 모호하면 글로 묻고 턴을 끝내게 프롬프트를 고쳤다. `insert_chart`, `edit_table set_caption`(엔진 경로 없음)도 뺐다 |
| 7 | 교정 4곳을 고친 뒤 쪽 넘김을 되돌리려고 장평 90%·셀 높이·표 속성을 건드렸다. 도구 15회 (`proofread`). 한 줄 추가 뒤 다른 곳의 빈 줄을 지우고 줄 간격을 바꿨다 (`long-doc-insert-summary`) | 쓰기 결과의 "뒤 문단이 다른 쪽으로 이동"을 `warnings` 로 주고, 규칙이 "고쳐라"고 했다 | 쪽 넘김은 `after.reflow`(참고)로 옮기고, 이번 쓰기가 만든 문제만 `warnings`. 규칙과 프롬프트에 "쪽 배치 유지를 요청받지 않았으면 되돌리려 하지 말 것" |
| 8 | 표 속성을 건드릴 때마다 "표가 본문 폭을 4mm 넘는다" 경고(같은 줄이 두 번). 원래 넘쳐 있던 표다 | 넘침을 쓰기 뒤 상태만 보고 판단했다 | 쓰기 직전 넘침을 기억해 새로 생기거나 커진 넘침만 알린다 |
| 9 | `get_structure` 결과마다 범례 1,100자가 붙었다. 20자짜리 문단을 읽어도 1,388자 | 범례를 결과에 실었다 | 범례는 `TOOL_RULES` 의 "Structure text" 에 한 번만. 미리보기 읽기에 3만 자 예산 |
| 10 | 숫자 칸 48개를 오른쪽 정렬하는 데 편집 항목 48개(배치 한도 32를 넘어 두 번) | 셀 서식을 한 칸씩만 줄 수 있었다 | `apply_char_format` / `apply_para_format` 의 `cells:{paraIdx,controlIdx,cellIdxs}` |
| 11 | 행을 추가한 뒤 새 칸의 번호를 알려고 구조를 다시 읽었다 | `insert_row` 가 개수만 돌려줬다 | `newRow` / `newCol` 로 새 셀 번호를 돌려준다 |
| 12 | 새 표가 본문 폭을 4.3mm 넘고, 떠 있는 표로 만들어지고, 첫 열이 굵게 나왔다. `preview_equation` 은 SVG 3천 자를, `render_page svg` 는 31만 자를 돌려줬다 | 표가 놓인 빈 문단이 앞 문단의 왼쪽 여백·굵게를 물려받는다. 그림 대신 SVG 글을 줬다 | `create_table` 은 글자처럼 취급으로 만들고, 표만 있는 문단의 여백을 0 으로 하며, 머리행만 굵게 한다. `formatFrom` 은 빈 문단에도 글자 모양을 입힌다. SVG 는 달라고 할 때만, 10만 자까지 |
| 13 | 배치에서 뒤 항목이 문단 수를 바꾸면 `after.paragraphs` 가 없는 문단을 가리켰다 (`move-paragraph`) | 앞 항목이 적어 둔 자리를 뒤 항목이 민 만큼 옮기지 않았다 | 배치 안에서 자리를 따라 옮긴다 |

회귀 테스트: `rhwp-studio/src/doogle/agent/__tests__/agent-audit.test.mjs`(가짜 엔진 13건),
`doogle-agent/test/tools.test.mjs`, 실제 엔진 탐침 `doogle-agent/eval/probes/`.

## 4. 남은 문제

- **수식 글꼴**: 수식 글꼴이 없는 환경에서는 편집기 화면과 에이전트가 보는 쪽 그림 모두 수식 글자가 깨진다. 에이전트는 수식이 제대로 들어갔는지 그림으로 확인하지 못한다. 글꼴 번들·대체는 엔진·글꼴 쪽 일이다.
- **글꼴 감지 창**: 문서를 열 때 뜨는 「로컬 글꼴 감지」 창에 답하기 전에는 쪽이 그려지지 않는다. §3-3 을 고친 뒤로는 그 사이 도구가 실패해도 잠기지 않지만, 쪽 그림(`render_page`)은 빈 쪽이다.
- **질문 카드**: 에이전트의 되묻기는 글로만 온다. 선택 단추 카드를 만들면 `ask_user_question` 을 되살린다.
- **목차 같은 생성 필드**, 머리말 안의 글, 글상자 안의 글은 `get_structure` 에 보이지 않는다.
- **표 구조 도구**(`edit_table` 등)는 본문 표만 다룬다. 중첩 표는 셀 글 편집만 된다.
- 평가는 `claude-sdk` 로만 돌렸다. OpenAI 경로는 같은 도구 정의를 쓰지만 이 평가로 확인하지 않았다.
