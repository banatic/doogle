# 두글(doogle) 모듈 계약 — 병렬 작업 공통 기준

포크: banatic/doogle (upstream edwardkim/rhwp), 브랜치 `doogle`.
tool/검토 설계 출처: banatic/rhwp-x (MIT). 로컬 사본(읽기 전용):
`C:/Users/user/AppData/Local/Temp/claude/4b022666f5526d21/44ab73b5-b42a-4ec0-a606-a9a592bc0abe/scratchpad/rhwp-x`
(이하 `$RX`). 설계 문서: `D:/dev/두글/PLAN.md`, `D:/dev/두글/TOOLS.md`.

## 0. 공통 규칙
- 자기 소유 디렉터리만 수정 (아래 §6). 다른 영역이 필요하면 리포트에 "요청"으로 적는다.
- git commit/push/branch 금지 (통합은 메인 세션이 함). `git status`/`diff` 조회는 가능.
- rhwp-x 코드 이식 시 파일 상단에 `// Ported from banatic/rhwp-x (MIT) <원본경로>` 주석.
- **금지**: Claude 자격증명(`~/.claude/.credentials.json`, Keychain `Claude Code-credentials`, `claudeAiOauth`)을 읽기/복사/저장/중계하는 코드. rhwp-x의 `claude-credentials.mjs`, `credential-mirror.mjs`, `oauth-credential-transaction.mjs`, `provider-limits.mjs`의 keychain 부분, `prepareClaudeHome`은 이식하지 않는다. Codex의 `~/.codex/auth.json`도 직접 읽지 않는다.
- v1 범위 밖: browser_*, project_*, reference_*, template_*, copy_layout, 다중 문서/버전, Playwright.
- 언어: hub는 Node 22+ ESM JavaScript(.mjs, JSDoc 타입), studio는 기존 TypeScript(Vite), 데스크탑은 Rust(Tauri 2).

## 1. 프로세스 구조
```
doogle-desk (Tauri 2) ──spawn──► doogle-agent hub (Node sidecar)
   │  webview = rhwp-studio            ▲  ws://127.0.0.1:{port}/studio?token=
   └───────────────────────────────────┘
외부 MCP 클라이언트(Claude Desktop/Code, Codex) ──stdio──► doogle-agent/bin/doogle-mcp.mjs
   └─► ws://127.0.0.1:{port}/mcp?token=  (hub가 studio로 tool_call 중계)
```
- hub 실행: `node doogle-agent/bin/doogle-hub.mjs` — 환경변수 `DOOGLE_HUB_PORT`(0=랜덤), `DOOGLE_HUB_TOKEN`(없으면 랜덤 생성).
- hub는 기동 후 `hub.json` = `{port, token, pid, version:1}`을 기록: Windows `%APPDATA%/doogle/hub.json`, macOS `~/Library/Application Support/doogle/hub.json`, Linux `$XDG_CONFIG_HOME/doogle/hub.json`. 파일 권한 0600. 표준출력 첫 줄에 `DOOGLE_HUB_READY {"port":..,"token":".."}` 출력(Tauri가 읽음).
- 127.0.0.1에만 바인딩. token 불일치·Origin 불허 시 연결 거절.

## 2. WebSocket 메시지 (JSON, 1메시지=1객체)
studio ↔ hub (`/studio`):
| 방향 | type | 필드 |
|---|---|---|
| S→H | `hello` | `{role:"studio", protocol:1}` |
| H→S | `welcome` | `{protocol:1, hubVersion}` |
| S→H | `providers_query` | `{}` |
| H→S | `providers` | `{list:[{id, label, available:boolean, reason?:string, models:Model[], defaultModel:string\|null, modelsUpdatedAt:string\|null, modelsError?:string, authHint?:string}]}` |
| S→H | `models_refresh` | `{providerId?}` — 모델 목록을 다시 받은 뒤(없으면 전체) `providers`로 응답 |
| S→H | `chat_send` | `{threadId, providerId, model?, text, mode:"agent"\|"full", context?:{selection?, documentName?}}` |
| S→H | `chat_cancel` | `{threadId}` |
| H→S | `agent_event` | `{threadId, event}` — event는 §3 |
| H→S | `tool_call` | `{callId, name, args, origin:"agent"\|"mcp", threadId?}` |
| S→H | `tool_result` | `{callId, ok:true, result}` 또는 `{callId, ok:false, error:{code, message, data?}}` |
| S→H | `review_decision` | `{threadId, decision:"accept_all"\|"reject_all"\|"partial", note?}` (스테이징 검토 결과, hub가 다음 턴 컨텍스트로 전달) |

`Model` = `{id, label, description?, default?:boolean, aliasOf?, resolvedModel?, supportsEffort?, effortLevels?:string[], source:"live"|"cache"|"fallback"}`.
- `defaultModel` = `default:true` 항목(없으면 첫 항목)의 id. `modelsUpdatedAt` = 목록을 받은 시각(ISO), fallback이면 null. `modelsError` = 마지막 실시간 조회 실패 사유.
- 모델 목록 캐시(`doogle-agent/src/model-catalog.mjs`): provider별 메모리 + `appDataDir()/models-cache.json`(0600), TTL 12시간, stale-while-revalidate(오래된 캐시를 즉시 `source:"cache"`로 주고 뒤에서 갱신), provider당 조회 하나만. 실시간·캐시 모두 실패할 때만 provider 정적 목록(`source:"fallback"`).
- hub가 갱신을 끝내면(목록이 바뀌었을 때) 요청 없이도 `providers`를 다시 보낸다. 자동 갱신 시점: hub 기동(캐시 없음/만료), `auth_done` 성공 후, `secrets_set` 성공 후(해당 provider), 턴이 '없는 모델' 오류로 실패했을 때.
- 모델 출처: `claude-sdk` = Claude Agent SDK `Query.supportedModels()`(prompt를 내보내지 않는 streaming-input 세션의 `initialize` 응답 — 모델 요청·사용량 없음, tool/MCP/settings 끔). `id:"default"` 행이 Claude Code 기본값이며 SDK에 model을 넘기지 않는다. `anthropic-api` = `GET https://api.anthropic.com/v1/models`(`x-api-key`, `anthropic-version: 2023-06-01`, `has_more`/`last_id`로 페이지 넘김). openai-*·codex는 provider가 직접 받은 목록(source 없으면 `live`).
- studio는 선택을 provider별로 `localStorage['doogle.model.<providerId>']`에 저장하고, 현재 목록에 없으면 `defaultModel` → 첫 항목으로 바꾼다. `chat_send.model` = 고른 `Model.id`.

mcp ↔ hub (`/mcp`): `tool_call` / `tool_result`만 사용 (hub가 studio로 중계, `origin:"mcp"`). studio 미연결 시 hub가 `{ok:false,error:{code:"NO_DOCUMENT",message:"두글에서 문서를 열어주세요"}}`.

## 3. agent_event.event
`{kind:"status", text}` · `{kind:"text_delta", text}` · `{kind:"text_done"}` · `{kind:"tool_use", callId, name, args}` · `{kind:"tool_result", callId, ok, summary}` · `{kind:"usage", inputTokens?, outputTokens?}` · `{kind:"limit", message, resetAt?}` · `{kind:"error", code, message}` · `{kind:"turn_end", reason:"done"|"cancelled"|"error"}`

## 4. Tool 정의 모듈 (`doogle-agent/src/tools/index.mjs`)
```js
export const TOOL_RULES: string            // rhwp-x RHWP_TOOL_RULES 이식(브라우저 문단 제거)
export const TOOLS: Array<{name, description, kind:'read'|'write'|'control', shape /*zod raw shape*/, validate?(args)}>
export const BATCHABLE_EDIT_TOOL_NAMES, BATCHABLE_READ_TOOL_NAMES
export function getTool(name)
export function toJsonSchema(name): object // JSON Schema (draft-07, $ref 없음)
export function validateArgs(name, args): {ok:true, args} | {ok:false, error:{code:'INVALID_ARGS', message}}
export function toolsForProvider(kind:'anthropic'|'openai-responses'|'mcp'|'codex-dynamic'): any[]
```
v1 tool 목록 = `D:/dev/두글/TOOLS.md` §2. `zod` 4.x 사용.

## 5. Provider 인터페이스 (`doogle-agent/src/providers/*.mjs`)
```js
export default {
  id: 'claude-sdk'|'anthropic-api'|'openai-siwc'|'openai-api'|'codex-app-server',
  label: string,
  async detect(ctx) -> {available, reason?, models:Model[] /*정적·기본 목록*/, authHint?},
  /** 선택: 실시간 모델 목록. 있으면 hub가 model-catalog로 캐시·fallback(detect().models)을 관리 */
  async listModels?(ctx) -> Model[],
  /** 한 턴 실행. callTool은 hub가 studio로 중계하고 결과를 돌려줌. emit은 §3 이벤트. */
  async runTurn({threadId, model, messages /*hub 보관 히스토리*/, text, mode, systemPrompt, tools /*TOOLS*/, callTool, emit, signal}) -> {messages /*갱신된 히스토리*/}
}
```
- `systemPrompt` = hub가 조립(기본 지침 + TOOL_RULES + mode 설명).
- `callTool(name, args) -> Promise<{ok, result|error}>`.
- 비밀값(API key, SIWC refresh token)은 `doogle-agent/src/secrets.mjs`(`@napi-rs/keyring`, service `doogle`)로만 저장.

## 6. 디렉터리 소유권
| 담당 | 소유 경로 |
|---|---|
| A engine | `src/**` (Rust), `typescript/rhwp.d.ts`, `docs/doogle/ENGINE_GAPS.md` |
| B tools | `doogle-agent/src/tools/**`, `doogle-agent/bin/doogle-mcp.mjs`, `doogle-agent/test/tools*` |
| C hub | `doogle-agent/package.json`, `doogle-agent/bin/doogle-hub.mjs`, `doogle-agent/src/*.mjs`(tools·providers 제외), `doogle-agent/src/providers/claude-sdk.mjs`, `anthropic-api.mjs`, `doogle-agent/test/hub*` |
| D openai | `doogle-agent/src/providers/openai-siwc.mjs`, `openai-api.mjs`, `codex-app-server.mjs`, `doogle-agent/src/auth/**`, `doogle-agent/test/openai*` |
| E studio-exec | `rhwp-studio/src/doogle/agent/**` |
| F desk+ui | `doogle-desk/**`, `rhwp-studio/src/doogle/ui/**`, `rhwp-studio/src/doogle/hub-client.ts`, `rhwp-studio/src/doogle/index.ts` + upstream 진입점에 1–3줄 훅 |
