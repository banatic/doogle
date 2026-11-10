# 두글 — rhwp 포크 + AI 편집 에이전트 계획서

작성일: 2026-11-10 · 기준: edwardkim/rhwp HEAD (v0.9.0, 2026-11-08)

---

## 0. 조사 결론 (계획의 전제)

### 0.1 rhwp에는 이미 AI 패널이 있다
- `rhwp-studio/src/ai/` — 빌드 플래그 `__RHWP_AI__`로 켜지는 `ai-assistant` 플러그인
  - provider: `provider/claude.ts`(Anthropic SDK, 브라우저 직접 호출, API key), `openai.ts`(`/v1/responses`), `gemini.ts`
  - agent loop: `agent/agent-loop.ts`, `chat-controller.ts`, `system-prompt.ts`
  - tools: `tools/read-tools.ts`(9개), `write-tools.ts`(30개), `command-tools.ts`(`run_command`)
  - 편집 방식: "찾을 텍스트" 기반 지정 → 제안(proposal) → 승인 → `host.transaction`으로 undo 1단계
  - key 저장: `settings/key-store.ts` (세션 / IndexedDB / PBKDF2+AES-GCM 암호화)
- 플러그인 호스트: `rhwp-studio/src/plugin/host.ts` (사이드패널, 커맨드, caret/selection, transaction, events)
- 파일 기반 MCP 서버: `src/mcp_serve.rs` (`rhwp mcp-serve`, `hwp_open`/`hwp_doc_*`) — **열려있는 편집기 문서가 아니라 파일**을 다룸
- Tauri 2 데스크탑: `rhwp-desk/` — 하지만 CLI를 돌리는 "agent workbench"이지 편집기 셸이 아님
- 업스트림 ROADMAP: "데스크탑 앱, 조직별 인증, 서비스별 UI는 downstream(포크)에서" → **우리 포크의 정당한 영역**

➡ **새로 만들 것은 "AI 패널"이 아니라: ① 데스크탑 셸 ② 구독 기반 인증/외부 에이전트 연결 ③ 라이브 문서 브리지(MCP) ④ 변경 검토 UX ⑤ tool 품질 개선.**

### 0.2 HamaEditor / rhwp-x
- HamaEditor(상용, 비공개)의 전신 Rauhwpx(MIT)는 비공개 전환됨. 사용자 포크 **https://github.com/banatic/rhwp-x** (MIT, Tauri)에 소스 보존
- rhwp-x에 이미 있는 것: Node 에이전트 허브(`rhwp-agent/`), 문서 tool 90여 개(zod), 공통 규칙 `RHWP_TOOL_RULES`, 스테이징 검토(`pending-edits.ts`), 리비전 잠금, MCP stdio, Claude Agent SDK 연동, Codex app-server 연동, 한국어 스킬
- **tool 설계는 `TOOLS.md`로 정리.** 이 계획의 §3/§4는 rhwp-x 방식으로 대체
- ⚠ rhwp-x는 Claude OAuth 토큰을 Keychain/파일에서 직접 읽고 복제함 → 해당 코드는 가져오지 않음 (`TOOLS.md` §4)

### 0.3 "데스크탑에 설치돼 있으면 바로 쓰는" 공식 방법 — 결론

| 방법 | 구독 사용 | 공식/허용 여부 | 판단 |
|---|---|---|---|
| **ChatGPT: Sign in with ChatGPT (SIWC)** — OAuth PKCE, loopback, Responses API | O (Plus/Pro, 앱별 한도) | **공식.** 오픈소스·로컬 앱은 바로 가능, 유료/호스팅 앱은 신청 | ✅ 1순위 |
| **Codex app-server** — 사용자가 `codex login` 해둔 것 재사용 | O | 로컬/OSS는 용인. "상업·호스팅 서비스엔 허용된 적 없음", SIWC로 이전 권장 | ✅ 2순위 (OSS 전제) |
| **Claude: 사용자의 Claude Desktop / Claude Code가 우리 MCP 서버를 로드** (.mcpb, `claude mcp add`) | O | **공식, 정상 사용** | ✅ Claude 구독용 유일한 안전 경로 |
| Claude API key (Console / Bedrock / Vertex) | X (Max/Team은 월간 API 크레딧을 Console key로 사용 가능) | 공식 | ✅ 기존 구현 재사용 |
| **Claude Agent SDK + 사용자가 직접 로그인한 Claude Code** | O (구독 한도 차감) | Help Center "Use the Claude Agent SDK with your Claude plan"이 공식 지원 (2026-06-15: SDK·`claude -p`·third-party app 사용 모두 구독 한도 차감). 단 legal 페이지는 앱이 로그인 UI 제공·토큰 수집/저장/중계 금지 | ✅ **Claude 기본 경로로 채택.** 조건: 로그인은 사용자가 `claude`로 직접, 두글은 토큰 미접근, 수정 안 된 바이너리. 정책 변경 대비 API key/MCP 폴백 유지 |
| ChatGPT 데스크탑 앱 → 로컬 MCP | O | 공개 HTTPS 또는 Secure MCP Tunnel 필요, 로컬 stdio 지원은 미확인 | ❌ 범위 밖 |
| OpenAI API key | X | 공식 | ✅ 기존 구현 재사용 |

출처: code.claude.com/docs/en/agent-sdk/overview, code.claude.com/docs/en/legal-and-compliance, developers.openai.com/siwc/*, learn.chatgpt.com/docs/app-server, github.com/modelcontextprotocol/mcpb

**전제 결정: 포크는 오픈소스(MIT 유지)로 배포한다.** → SIWC 즉시 사용 가능, Codex app-server 용인 범위. (유료 배포로 가면 SIWC 신청 + Codex 경로 재검토 필요)

---

## 1. 목표 / 비목표

**목표**
1. Windows/macOS 데스크탑 앱에서 HWP/HWPX를 열고, 사이드 패널의 에이전트(Claude / ChatGPT)가 문서를 수정
2. 사용자는 API key 없이 **ChatGPT 구독**으로 바로 사용 (SIWC 또는 설치된 Codex)
3. **Claude 구독** 사용자는 자신의 Claude Desktop / Claude Code에서 열린 문서를 편집 (MCP 브리지)
4. 모든 에이전트 편집은 **검토 후 적용**(수락/거절, 턴 단위 undo), 원본 서식 보존

**비목표 (v1)**
- 웹 호스팅 서비스, 계정 시스템, 결제
- Gemini/OpenRouter (구조상 나중에 추가 가능하게만)
- ChatGPT 데스크탑 앱 연동, 협업 편집

---

## 2. 아키텍처

```
┌──────────────── Tauri 2 앱 (두글) ─────────────────────────────┐
│  WebView: rhwp-studio (+ WASM HwpDocument)                     │
│   ├─ ai/ 패널 (기존)  ──► AgentProvider 인터페이스               │
│   │     ├ AnthropicApiProvider   (기존 claude.ts)              │
│   │     ├ OpenAIResponsesProvider (기존 openai.ts + SIWC 토큰)  │
│   │     └ CodexAppServerProvider (신규, Rust 측 프로세스 중계)    │
│   ├─ ToolRegistry (단일 정의: 스키마 + 실행 + 검토 정책)          │
│   └─ ChangeReview (제안 → diff 오버레이 → 수락/거절)              │
│                                                                │
│  Rust(Tauri core)                                              │
│   ├─ siwc_auth.rs   : PKCE + 127.0.0.1 loopback + keyring      │
│   ├─ codex_bridge.rs: `codex app-server` spawn, JSON-RPC 중계   │
│   └─ live_bridge.rs : 127.0.0.1 WebSocket (토큰 인증)            │
└──────────────────────────────┬─────────────────────────────────┘
                               │ ws://127.0.0.1:<port> + token
             ┌─────────────────┴──────────────────┐
             │ doogle-mcp (stdio MCP 서버, Node)    │  ← Claude Desktop(.mcpb),
             │  tools = ToolRegistry 스키마 그대로   │     Claude Code, Codex가 로드
             └────────────────────────────────────┘
```

핵심 원칙
- **tool은 한 곳에서 정의, 세 곳에서 노출**: 앱 내 agent loop / Codex `dynamicTools`(또는 MCP) / 외부 MCP 브리지. 실행은 항상 WebView의 WASM 문서에서.
- **외부 에이전트도 같은 검토 파이프라인을 통과**: MCP로 들어온 write도 바로 반영하지 않고 ChangeReview 큐로.
- 업스트림 충돌 최소화: 포크 코드는 새 디렉터리(`doogle-desk/`, `doogle-mcp/`, `rhwp-studio/src/ai/ext/`)에 두고 기존 파일 수정은 훅 포인트만.

---

## 3. Tool 설계

> **갱신(2026-11-10): rhwp-x의 tool 체계를 채택한다 → `TOOLS.md`.** 블록 ID/hash 대신 `expectedRevision` 잠금 + 좌표/`find` 앵커, 검토는 "라이브 스테이징" 방식. 아래 3.1–3.3은 초안으로 남겨둠.

### 3.1 기존 tool 재사용 + 개선 방향
기존 39개 tool(read 9 / write 30)을 출발점으로 쓰고, HamaEditor가 강조하는 "변경 검토 / 내 문서 그대로"와 외부 에이전트(MCP) 사용을 위해 아래를 보강.

| 문제 | 개선 |
|---|---|
| 텍스트 검색 기반 위치 지정 → 동일 문장 중복 시 모호 | **블록 ID 주소 체계** 추가: `s{섹션}.p{문단}` / `s0.p12.t0.c(2,3).p0` (표 셀 경로). 텍스트 매칭은 보조 수단으로 유지 |
| 읽은 뒤 문서가 바뀌면 stale edit | 모든 read 결과에 `rev`(문서 리비전)과 블록별 `hash` 포함. write는 `expect_hash` 필수 → 불일치 시 거부 + 최신 내용 반환 |
| 외부 에이전트(Claude Code 등)는 문서 구조를 모름 | `get_outline` → `read_blocks(range)` 2단계 읽기, 긴 문서 페이징. 출력은 마크다운풍 텍스트 + 블록 ID 주석 (JSON보다 토큰 효율 좋음) |
| 편집마다 tool 호출 왕복 | `apply_edits` 배치 tool (여러 op를 한 제안으로 묶음) |
| `charOffset` 단위 불명확 (char vs UTF-16) | Phase 0에서 확인 후 tool 레벨에서는 **문자(코드포인트) 오프셋**으로 통일, 변환은 어댑터에서 |

### 3.2 v1 tool 목록 (외부 노출용 정규화 세트)
읽기
- `get_document_info` — 파일명, 섹션/페이지/문단 수, `rev`
- `get_outline` — 제목/개요 수준, 표·그림 위치, 블록 ID
- `read_blocks {from, to | ids[], max_chars}` — 블록 ID·hash·서식 요약 포함 텍스트
- `search_text {query, regex?, scope?}` → 블록 ID + 오프셋 목록
- `get_selection` — 사용자가 선택한 범위 (블록 ID + 텍스트)
- `read_table {table_id}` — 셀 그리드(병합 정보 포함)
- `get_formatting {block_id, range?}` — 글자/문단 모양, 스타일명

쓰기 (전부 제안 → 검토)
- `replace_text {block_id, expect_hash, find, replace, occurrence?}` — 서식 상속 치환(`replace_text_inheriting_char_shapes_native` 활용)
- `insert_paragraphs {after_block_id, paragraphs[{text, style?}]}`
- `delete_blocks {ids[], expect_hashes[]}`
- `rewrite_paragraph {block_id, expect_hash, new_text}` — 문단 전체 교체, 첫 run 서식 상속
- `format_text {block_id, range, props}` / `format_paragraph {block_id, props}` / `apply_style`
- `edit_table {table_id, ops[insert_row|delete_row|insert_col|delete_col|merge|split]}`
- `set_cells {table_id, cells[{row, col, text}]}`
- `insert_table {after_block_id, rows, cols, data?, header?}`
- `fill_fields {values{name: value}}` — 누름틀 채우기 (양식 문서 핵심)
- `apply_edits {ops[]}` — 위 op들을 묶은 배치

제어
- `get_pending_changes` / `discard_pending_changes` — 외부 에이전트가 검토 상태를 볼 수 있게
- (나머지 기존 tool: 그림/수식/각주/머리말 등은 v1.1에서 정규화 세트로 이전)

### 3.3 Tool 정의 형식
```ts
defineTool({
  name: 'replace_text',
  description: '...',          // 한국어/영어 병기, 언제 쓰는지 명시
  input: zodSchema,             // → JSON Schema 자동 생성 (MCP/Responses/Anthropic 공용)
  kind: 'write',                // read | write | control
  run: (doc, input) => Proposal // write는 Proposal 반환, 직접 적용 금지
})
```

---

## 4. 변경 검토 (ChangeReview)

1. write tool 실행 → `saveSnapshot` 위에 **임시 적용**해 결과를 계산 → `Proposal{ops, before, after, affected_blocks}` 생성 후 스냅샷 복원
2. 패널에 카드 표시: 블록별 before/after 단어 diff, 문서 위 하이라이트(`getSelectionRects` 재사용)
3. 사용자: 개별 수락 / 전체 수락 / 거절 / "수정 요청"(거절 사유를 에이전트에게 tool 결과로 반환)
4. 수락 → `beginBatch` … `endBatch` + `host.transaction`으로 **턴 단위 undo 1단계**
5. 설정: "자동 적용" 모드(검토 생략) — 기본 OFF
6. 거절/충돌 시 tool 결과에 최신 블록 내용과 hash를 돌려줘서 에이전트가 재시도 가능하게

---

## 5. Provider별 구현

### 5.1 ChatGPT — Sign in with ChatGPT (1순위)
- Rust `siwc_auth.rs`
  - PKCE S256, redirect `http://127.0.0.1:<port>/auth/callback` (**localhost 금지**, 문서 명시)
  - authorize `https://auth.openai.com/api/accounts/authorize`, token `.../oauth/token`, `resource=https://api.openai.com/v1`
  - 최초 `client_id=dynamic_agent_client` + `ext_agent_host_id`, `agent_name_hint` → 받은 client_id 저장
  - scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, 부여 여부 검증
  - refresh token은 OS keyring (`keyring` crate), WebView에는 access token만 전달
- WebView: 기존 `openai.ts`에 `authMode: 'apiKey' | 'siwc'` 추가, `store:false, stream:true`
- 에러 처리: `subscription_sharing_usage_limit_exceeded` / `_unavailable` → "이번 주 한도 소진" UI + API key 대체 안내
- **⚠ Phase 0 검증 필요: SIWC 토큰으로 function calling 동작 여부** (문서에 명시 없음). 안 되면 5.2(Codex + SIWC 토큰)로 우회

### 5.2 ChatGPT — Codex app-server (2순위, 설치된 Codex 재사용)
- 감지: PATH에서 `codex` 탐색 + `codex --version`, 로그인 상태는 app-server `account/*`로 확인 (`~/.codex/auth.json` 직접 읽지 않음)
- Rust `codex_bridge.rs`: `codex app-server` spawn, stdio JSONL JSON-RPC 중계
  - `initialize` → `initialized` → `thread/start {dynamicTools: [...], experimentalApi}` → `turn/start`
  - `item/tool/call` 수신 → WebView ToolRegistry 실행 → 응답
  - 대안: `-c mcp_servers.doogle.command=...`로 doogle-mcp 연결 (dynamicTools가 experimental이므로 폴백)
  - Codex 기본 tool(셸, 파일 수정) 차단: `--sandbox read-only` 상당 설정 + 승인 요청(`requestApproval`) 전부 거절
- 타입: `codex app-server generate-ts --out`으로 바인딩 생성해 고정 버전 관리
- SIWC 토큰 주입 옵션: `ACCESS_TOKEN` env + `-c model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"` → 사용자가 Codex 로그인 안 해도 됨

### 5.3 Claude — API key (기존)
- 기존 `claude.ts` 유지. 단 데스크탑에서는 key를 OS keyring에, 호출은 Rust 측 프록시로 옮겨 `dangerouslyAllowBrowser` 제거
- 기본 모델 `claude-sonnet-5-5`, 고난도 `claude-opus-5-5`, prompt caching(시스템 프롬프트+tool 정의) 적용
- 안내 문구: "Max/Team 플랜은 월간 API 크레딧을 Console key로 사용 가능"

### 5.4 Claude — 구독 사용자: 라이브 문서 MCP 브리지
- `doogle-mcp` (Node, stdio): 시작 시 `%APPDATA%/doogle/bridge.json`에서 포트+토큰 읽어 앱의 WebSocket에 연결
- 배포
  - Claude Desktop: `.mcpb` (`manifest.json` + server, `mcpb pack`; manifest_version은 출시 시점 스펙 확인)
  - Claude Code: 앱 설정 화면에 `claude mcp add doogle -- <path>` 복사 버튼
  - Codex 사용자도 동일: `codex mcp add doogle -- <path>`
- 앱 미실행/문서 미오픈 시 tool이 명확한 에러 반환 ("두글에서 문서를 열어주세요")
- 외부 에이전트의 write → ChangeReview 큐 → 사용자가 두글 창에서 승인 → tool 결과 반환 (승인 대기 timeout 설정)
- 기존 `rhwp mcp-serve`(파일 기반)는 "앱 없이 파일 일괄 처리"용으로 그대로 두고 문서에 구분 명시

### 5.5 (실험, 기본 OFF) Claude Code 직접 구동
- 개인용 빌드 플래그 `DOOGLE_EXPERIMENTAL_CLAUDE_CLI`에서만: 사용자가 직접 설치·로그인한 **수정 안 된** `claude` 바이너리를 `claude -p --input-format stream-json --output-format stream-json --mcp-config <doogle-mcp> --strict-mcp-config --tools "" --allowedTools "mcp__doogle__*"`로 실행
- 앱은 자격증명에 절대 접근하지 않음. 배포판 미포함. 정식화는 Anthropic 서면 승인 후

### 5.5' (확정) Claude — Agent SDK + 사용자 Claude Code 로그인 = Claude 기본 경로
- 위 §5.5의 실험 플래그를 정식 옵션으로 승격. rhwp-x `agents/claude.mjs`의 `query()` 루프를 이식하되 `prepareClaudeHome`/자격증명 미러링은 제거
- 감지: `claude` 설치 여부 → 미로그인 시 "터미널에서 `claude` 실행 후 /login" 안내 (두글은 로그인 UI 없음)
- tool: in-process `createSdkMcpServer` 또는 doogle-mcp, `tools: []`로 기본 tool 차단, `allowedTools: ["mcp__doogle__*"]`, write 승인은 스테이징 검토로
- 한도 초과/인증 오류는 SDK 이벤트로만 판단, API key 전환 버튼 제공

### 5.6 AgentProvider 인터페이스
```ts
interface AgentProvider {
  id: 'anthropic-api' | 'openai-api' | 'openai-siwc' | 'codex-app-server' | ...
  detect(): Promise<Availability>          // 설치/로그인/키 상태
  startThread(opts): Thread
  send(thread, userMsg, ctx): AsyncIterable<AgentEvent> // text-delta | tool-call | tool-result | usage | error
  cancel(thread): void
}
```
기존 `agent-loop.ts`는 API형 provider(Anthropic/OpenAI)에 계속 사용, Codex는 자체 루프이므로 이벤트만 어댑트.

---

## 6. 단계별 일정 (1인 풀타임 기준)

### Phase 0 — 스파이크/검증 (3–5일)
- [ ] 포크 생성, `upstream` remote 설정, WASM(docker) + studio(`npx vite --port 7700`) 빌드 성공
- [ ] `__RHWP_AI__` 켜고 기존 AI 패널을 Claude/OpenAI API key로 실제 사용해보고 tool 품질 메모
- [ ] `charOffset` 단위(char vs UTF-16) 확인 — 이모지/한자 포함 문서로 테스트
- [ ] SIWC 로그인 → Responses API **function calling** 동작 확인 (최소 스크립트)
- [ ] `codex app-server` + `dynamicTools`로 더미 tool 1개 호출 확인
- [ ] `.mcpb` 더미 서버를 Claude Desktop에 설치해 tool 호출 확인
- 산출물: 각 항목 Go/No-go 기록 → 5.1/5.2 우선순위 확정

### Phase 1 — 데스크탑 셸 (4–6일)
- [ ] `doogle-desk/` Tauri 2 앱, rhwp-studio를 frontend로 번들
- [ ] 파일 열기/저장(HWP/HWPX), 최근 파일, 파일 연결(.hwp/.hwpx)
- [ ] OS keyring 저장소, 설정 화면 골격
- 완료 기준: 실제 HWP 열고 수정·저장 → 한컴오피스에서 정상 열림

### Phase 2 — ToolRegistry + ChangeReview (1.5–2주 → rhwp-x 이식 시 약 1주)
> rhwp-x의 `tools.mjs` + `tool-executor.ts` + `pending-edits.ts`를 이식하면 아래 항목 대부분이 대체됨. 핵심 작업은 업스트림 rhwp WASM API와의 시그니처 대조.
- [ ] 기존 tool을 `defineTool` 형식으로 래핑 (zod → JSON Schema)
- [ ] 블록 ID / rev / hash 체계, `get_outline`·`read_blocks`
- [ ] 3.2 정규화 tool 세트 구현
- [ ] Proposal 계산(스냅샷 임시 적용) + diff 카드 + 문서 하이라이트 + 수락/거절 + 턴 단위 undo
- 완료 기준: API key provider로 "3번째 문단을 공문체로", "표 2행 추가 후 합계 채우기" 시나리오가 검토 → 적용 → undo까지 동작

### Phase 3 — ChatGPT 구독 (1–1.5주)
- [ ] `siwc_auth.rs` + openai provider `siwc` 모드 + 한도 에러 UI
- [ ] `codex_bridge.rs` + `CodexAppServerProvider` (감지, 스트리밍, tool 중계, 기본 tool 차단)
- 완료 기준: API key 없이 Plus 계정으로 Phase 2 시나리오 통과

### Phase 4 — 라이브 MCP 브리지 (1주)
- [ ] `live_bridge.rs` WebSocket(127.0.0.1, 랜덤 포트, 토큰, Origin 검사)
- [ ] `doogle-mcp` stdio 서버, `.mcpb` 패키징, Claude Code/Codex 설정 복사 UI
- [ ] 외부 write → ChangeReview 큐 연동, 승인 대기 timeout
- 완료 기준: Claude Desktop에서 "두글에 열린 문서 요약하고 결론 문단 다시 써줘" → 두글에서 승인 → 반영

### Phase 5 — 품질/평가 (1주, 이후 상시)
- [ ] 평가셋 20–30개: 공문서·보고서·양식(누름틀)·표 많은 문서 × 작업(교정, 요약 삽입, 표 채우기, 서식 통일)
- [ ] 자동 채점: 왕복 저장 후 의도한 블록만 바뀌었는지(블록 hash diff), 서식 보존(char shape 비교), 한컴 렌더 비교는 수동 샘플
- [ ] provider별 성공률·tool 호출 수·토큰 기록 → 시스템 프롬프트/tool 설명 튜닝
- [ ] 프롬프트 인젝션: 문서 본문은 `untrusted.ts` 방식으로 감싸 전달 (기존 구현 재사용)

### Phase 6 — 배포 (3–5일)
- [ ] Windows 코드서명 (HamaEditor는 미서명 — 차별점), macOS notarization
- [ ] 자동 업데이트(Tauri updater), 크래시 로그
- [ ] README: 인증 방식별 안내, 데이터 흐름(문서 내용이 어느 provider로 가는지) 명시

**총계: 약 6–8주** (Phase 0에서 SIWC function calling이 No-go면 +3일, Codex 경로로 대체)

---

## 7. 업스트림 관리
- 포크 전용 코드는 신규 디렉터리에, 기존 파일 수정은 최소 훅만 → 주 1회 `git fetch upstream && git rebase` (업스트림 매일 커밋, 매우 활발)
- 범용 개선(블록 ID 주소, stale 방지 hash, 배치 tool, ChangeReview 코어)은 업스트림 PR 후보 — `CONTRIBUTING.md`, `mydocs/manual/agent_surface_playbook.md` 규칙 따름
- 인증/데스크탑/브랜딩은 포크에만 (업스트림 ROADMAP의 downstream 원칙과 일치)

## 8. 리스크
| 리스크 | 영향 | 대응 |
|---|---|---|
| SIWC 토큰으로 function calling 불가 | ChatGPT 구독 경로 1순위 무효 | Codex app-server + SIWC 토큰 주입으로 대체 |
| Codex `dynamicTools` experimental 변경 | Codex 경로 깨짐 | MCP 설정(`-c mcp_servers`) 폴백, 버전 고정 + generate-ts |
| Anthropic 정책 (구독 재사용) | Claude 구독 사용자가 앱 내 패널 못 씀 | MCP 브리지로 해결, CLI 구동은 실험 플래그 + 승인 요청 |
| 유료/호스팅 전환 | SIWC 신청 필요, Codex 경로 불허 | OSS 유지 전제 명시, 전환 시 재검토 |
| 업스트림 변경 속도 | 리베이스 충돌 | 훅 최소화, 신규 디렉터리 격리 |
| 서식 보존 실패 | "내 문서 그대로" 약속 위반 | 서식 상속 치환 API 사용, Phase 5 자동 회귀 |
| 로컬 WebSocket 악용 | 다른 프로세스가 문서 조작 | 127.0.0.1 바인딩, 랜덤 토큰, 파일 권한, 모든 write는 사용자 승인 |

## 9. 미확인 항목 (Phase 0에서 확인)
- SIWC: function calling 지원, 주간 한도 수치, Plus/Pro 외 플랜
- Codex TS SDK가 ChatGPT 로그인을 재사용하는지 (문서 미기재)
- MCPB `manifest_version` (0.3 vs 0.4)
- rhwp `charOffset` 단위
- HamaEditor 실제 tool 스키마 (비공개)
