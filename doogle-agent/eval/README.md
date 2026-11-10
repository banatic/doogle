# doogle-agent/eval — 에이전트 평가 하네스

실제 hub + 실제 편집기 화면(헤드리스 Chrome) + 실제 provider 로 에이전트 턴을 돌리고 도구 호출 전문을 남긴다.
방법·결과·찾은 결함은 [docs/doogle/AGENT_EVAL.md](../../docs/doogle/AGENT_EVAL.md).

| 파일 | 하는 일 |
|---|---|
| `run.mjs` | 시나리오 실행 → `output/agent-eval/<tag>/` (`--only`, `--tag`, `--parallel`, `--model`, `--mode`, `--dump`) |
| `scenarios.mjs` | 시나리오(문서·요청·결과 검사) |
| `show.mjs` | 한 시나리오의 호출 기록 요약 보기 |
| `probe.mjs` + `probes/` | 모델 없이 실제 엔진으로 도구를 직접 불러 검증 |
| `ui-shots.mjs` | 모델 없이(대본 provider) 주요 화면 상태 캡처 → `output/ui-audit/` |
| `debug.mjs` | 문서 하나를 열고 한 턴을 보내 상태를 찍어 본다 |
| `lib/session.mjs` | hub·브라우저·문서 세션, 기록기 |
| `lib/audit.mjs` | 호출 기록 집계(오류·낭비 신호)와 `audit.md`·`summary.md` |
| `.fixtures/` | 평가 문서 (추적하지 않음 — upstream `samples/` 에서 받는다) |
