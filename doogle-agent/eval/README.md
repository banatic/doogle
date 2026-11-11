# doogle-agent/eval — 에이전트 평가 하네스

실제 hub + 실제 편집기 화면(헤드리스 Chrome) + 실제 provider 로 에이전트 턴을 돌리고 도구 호출 전문을 남긴다.
방법·결과·찾은 결함은 [docs/doogle/AGENT_EVAL.md](../../docs/doogle/AGENT_EVAL.md).

| 파일 | 하는 일 |
|---|---|
| `run.mjs` | 시나리오 실행 → `output/agent-eval/<tag>/` (`--only`, `--tag`, `--parallel`, `--model`, `--mode`, `--dump`) |
| `scenarios.mjs` | 시나리오(문서·요청·결과 검사) |
| `show.mjs` | 한 시나리오의 호출 기록 요약 보기 |
| `probe.mjs` + `probes/` | 모델 없이 실제 엔진으로 도구를 직접 불러 검증 |
| `probes/threads-and-reconnect.mjs` | 혼자 도는 탐침(대본 provider, `node eval/probes/threads-and-reconnect.mjs [--out <dir>]`): 음영 칸에서 편집 표시 덮개 색, 응답 도중 연결이 끊겼다 다시 붙기, 대화 지우기, 새로고침 때 바로 멈추기. 실패하면 던진다 |
| `probes/attachments.mjs` | 혼자 도는 탐침(대본 provider): 참고 파일을 실제 화면에 올려 형식별 읽기(글 · EUC-KR csv · xlsx · docx · pptx · pdf · 스캔본 pdf · 그림 · hwp · hwpx), `read_attachment` 조각·찾기·그림, 읽지 못하는 파일, 한도, 끌어다 놓기·붙여 넣기, 새로고침 뒤 복원을 본다. 견본 파일은 `python scripts/doogle/make-attach-fixtures.py` 가 `.fixtures/attach/` 에 만든다 |
| `probes/desk-files.mjs` | 혼자 도는 탐침(대본 provider): 데스크탑 셸을 흉내 낸 다리(`__TAURI_INTERNALS__.invoke` → Node 가 임시 폴더의 진짜 파일로 처리)를 끼워, Tauri 창 없이 데스크탑의 열기·저장을 본다 — 연 파일에 그대로 저장, 쓰기 실패 알림, 저장 안 한 문서에서 열기 전 확인, 문서 교체 때 검토 목록 비우기, 열 수 없는 파일, 다른 이름으로 저장, 응답 도중 새 대화, 붙여 넣기. Rust 쪽 코드는 돌지 않는다 |
| `ui-shots.mjs` | 모델 없이(대본 provider) 주요 화면 상태 캡처 → `output/ui-audit/` (`--out` 으로 바꾼다). 화면에서 잰 값(안내문·검토 행 문구·좁은 창 배율·풍선 위치 등)은 같은 폴더의 `facts.json` |
| `debug.mjs` | 문서 하나를 열고 한 턴을 보내 상태를 찍어 본다 |
| `lib/session.mjs` | hub·브라우저·문서 세션, 기록기 |
| `lib/audit.mjs` | 호출 기록 집계(오류·낭비 신호)와 `audit.md`·`summary.md` |
| `.fixtures/` | 평가 문서 (추적하지 않음 — upstream `samples/` 에서 받는다) |
