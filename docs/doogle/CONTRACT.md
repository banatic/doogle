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
| H→S | `welcome` | `{protocol:1, hubVersion, resumed:boolean}` — `resumed`: 끊기기 전의 응답을 이어 간다(아래 "연결이 끊겼을 때") |
| S→H | `providers_query` | `{}` |
| H→S | `providers` | `{list:[{id, label, available:boolean, reason?:string, models:Model[], defaultModel:string\|null, modelsUpdatedAt:string\|null, modelsError?:string, authHint?:string}]}` |
| S→H | `models_refresh` | `{providerId?}` — 모델 목록을 다시 받은 뒤(없으면 전체) `providers`로 응답 |
| S→H | `chat_send` | `{threadId, providerId, model?, text, mode:"agent"\|"full", context?:{selection?, documentName?}, doc?:{key, name}\|null, attachments?:Attachment[], cards?:string[], purpose?:"card-draft"}` — `text` 는 `attachments`·`cards` 가 있으면 비어도 된다 |
| S→H | `chat_cancel` | `{threadId}` |
| H→S | `agent_event` | `{threadId, event}` — event는 §3 |
| H→S | `tool_call` | `{callId, name, args, origin:"agent"\|"mcp", threadId?}` |
| S→H | `tool_result` | `{callId, ok:true, result}` 또는 `{callId, ok:false, error:{code, message, data?}}` |
| S→H | `review_decision` | `{threadId, decision:"accept_all"\|"reject_all"\|"partial", note?}` (스테이징 검토 결과, hub가 다음 턴 컨텍스트로 전달) |
| S→H | `threads_query` | `{reqId?, limit?, doc?:{key, name}\|null}` — 저장된 대화 목록. `doc` 을 주면 그 문서의 대화만, `doc:null` 이면 빈 목록 |
| H→S | `threads` | `{reqId?, list:[{id, title, createdAt, updatedAt, turns, doc, running}]}` (최근 것부터) |
| S→H | `thread_load` | `{reqId?, threadId}` |
| H→S | `thread` | `{reqId?, threadId, title, doc, createdAt, updatedAt, running, transcript}` — transcript = `{kind:"user", text, providerId, at}` 와 그때 보낸 `agent_event.event` 들 |
| S→H | `thread_delete` | `{reqId?, threadId}` — 저장된 대화를 지운다(되돌릴 수 없다) |
| H→S | `thread_deleted` | `{reqId?, threadId, ok, error?:{code, message}}` — 응답 중인 대화는 `THREAD_BUSY` |
| S→H | `thread_card_detach` | `{reqId?, threadId, id}` — 대화에서 카드를 뗀다(다음 턴부터 블록·자리표시자·read_card·가리기·그림 막기에서 빠진다). `thread` 응답에는 붙은 카드 `cards:[{id, name, icon, sensitive}]` |
| H→S | `thread_card_detached` | `{reqId?, threadId, id, ok, cards?, error?}` — 응답 중인 대화는 `THREAD_BUSY` |
| S→H | `cards_query` | `{reqId?}` — 카드 목록 |
| H→S | `cards` | `{reqId?, list:Card[]}` (최근에 고친 것부터) |
| S→H | `card_save` | `{reqId?, card}` — `card.id` 가 있고 아는 카드면 고치고, 없으면 새로 만든다 |
| H→S | `card_saved` | `{reqId?, ok, card?:Card, error?:{code, message}}` — `INVALID_CARD` · `TOO_MANY_CARDS` · `SAVE_FAILED` |
| S→H | `card_delete` | `{reqId?, id}` |
| H→S | `card_deleted` | `{reqId?, id, ok, error?:{code, message}}` — `NOT_FOUND` · `INVALID_ARGS` · `DELETE_FAILED` |

**카드** (`doogle-agent/src/cards.mjs`): `Card` = `{id, name, icon:"card"|"person"|"list"|"school", kind:"item"|"table", fields:[{key, desc, sensitive}], values?:{[key]:string}, rows?:string[][], createdAt, updatedAt}`.
카드 하나 = `appDataDir()/cards/<id>.json`, 이 컴퓨터에만 둔다.

카드를 모델에 쓰는 규칙 (값은 되도록 모델에 보내지 않는다):
- `chat_send.cards` 로 붙인 카드는 대화(`thread.cards`)에 남는다(한 메시지 5개까지, 없는 카드면 `error:CARD_NOT_FOUND` 뒤 `turn_end:"error"`). 매 턴 글에 `<doogle_cards>` 블록 — 항목 이름·설명·민감 여부만, 값은 없다. transcript 의 `user` 줄에는 `cards:[{id, name, icon}]`.
- 문서로 가는 tool 인자(에이전트 대화에서)의 자리표시자 `{{card:<id>.<항목>}}` / `{{card:<id>.rows[N].<항목>}}`(N 은 1부터)는 hub 가 studio 로 넘기기 직전에 실제 값으로 바꾼다. 대화에 붙지 않은 카드·없는 항목·없는 줄이면 studio 에 보내지 않고 `CARD_PLACEHOLDER` 오류. 카드를 붙인 대화에서는 그 카드들의 **민감** 값을 모든 도구 결과(바뀐 문단 글, 뒤 턴의 문서 읽기)에서 가려 모델에 돌려준다. 카드를 붙이지 않은 대화에서 같은 문서를 읽으면 문서에 들어간 값은 그대로 보인다(문서 내용이므로). 그림 속 글자는 가릴 수 없으므로, 민감 항목이 있는 카드를 붙인 대화에서는 문서 그림을 만들지 않는다: 쓰기의 `render` 를 빼고 결과에 `renderSkipped` 를 달며, `render_page` 는 `NOT_AVAILABLE`.
- hub tool `read_card {card, fields?, fromRow?, maxRows?}` — 값이 꼭 필요할 때(가공)만. 민감 항목은 가린 값(`010-****-5678`, `김**`).
- 카드 편집 화면의 AI 대화는 `purpose:"card-draft"`(대화 id `card-draft-…`, 편집 화면을 닫으면 studio 가 지운다). 이 대화에서는 hub tool `propose_card` 만 열리고(다른 tool 은 `NOT_AVAILABLE`), 보통 대화에서는 `propose_card` 가 막힌다. `propose_card` 는 저장하지 않고 H→S `card_proposal {threadId, card, source?:{dataStart, columns}}` 로 초안을 보낸다 — 저장은 사람이 한다. 파일로 만들 때 모델에는 표의 머리 줄 + 앞 3줄만 보내고, 나머지 줄은 studio 가 `source` 의 열 짝대로 채운다.
- 문서에 카드를 끌어 놓으면 studio(main.ts)가 놓은 자리로 캐럿을 옮기고 `doogle:card-drop` 을 알린다 → 사이드바가 그 카드를 붙인 채우기 요청을 보낸다. `item` 은 항목마다 값 하나(`values`), `table` 은 줄마다 `fields` 순서의 칸(`rows`). 항목 이름(`key`)은 자리표시자 `{{card:<id>.<key>}}` 에 쓰이므로 `. { } [ ]` 와 줄바꿈을 받지 않는다. 한도: 카드 200개, 항목 40개, 줄 1000개.

**참고 파일** (`doogle-agent/src/attachments.mjs`): `Attachment` = `{name, kind:"text"|"hwp"|"pdf"|"docx"|"xlsx"|"pptx"|"image", mime, size, text?, images?:[{mimeType, base64, width?, height?, label?}], meta?:{pages?, sheets?, slides?, encoding?, note?, truncated?}}`.
studio 가 파일을 읽어 글·그림으로 바꿔 보낸다(원본 바이트는 보내지 않는다). hub 는 내용을 `threads/<대화>.files/<id>.json` 에 두고 대화에는 목록만 붙인다.
받을 수 없는 첨부가 하나라도 있으면 턴을 시작하지 않고 `error`(`INVALID_ATTACHMENT` · `EMPTY_ATTACHMENT` · `ATTACHMENT_LIMIT` · `ATTACHMENT_TOO_LARGE`) 뒤 `turn_end:"error"` 를 보낸다.
에이전트는 hub tool `list_attachments` / `read_attachment` 로 읽는다(§4, `docs/doogle/TOOLS.md`). `thread` 응답에는 `attachments`(목록)가, transcript 의 `user` 줄에는 그 요청에 붙인 파일의 `attachments:[{id, name, kind, size}]` 가 실린다.

**대화 저장** (`doogle-agent/src/threads.mjs`): 대화 하나 = `appDataDir()/threads/<id>.json`. 목록은 색인(`threads/threads.index`)으로 만든다 — 파일마다 수정 시각·크기만 보고 색인과 다른 파일만 다시 읽는다. 색인은 캐시일 뿐이라 지워도 파일에서 다시 만든다. 보관 한도는 500개(`createHub({maxThreads})`, 0 = 한도 없음)이고, 넘으면 hub 기동 때와 턴이 끝날 때 오래 쓰지 않은 대화부터 지운다(응답 중·이번 실행에서 연 대화는 남긴다). 대화를 지워도 Claude Code 가 자기 폴더(`~/.claude/projects/…`)에 남긴 세션 기록은 건드리지 않는다.

**연결이 끊겼을 때**: studio 는 `/studio?token=…&client=<화면 id>` 로 붙는다(화면 id 는 페이지마다 새로 만들고 새로고침하면 바뀐다).
- 화면이 스스로 닫으면(닫는 코드 1000·1001·1005 — 새로고침·창 닫힘) 문서도 사라졌으므로 hub 는 진행 중 응답을 바로 멈춘다(`turn_end.reason:"interrupted"`).
- 뜻밖에 끊기면(그 밖의 코드) hub 는 같은 화면 id 가 돌아오길 10초(`createHub({reconnectGraceMs})`) 기다린다. 그동안 화면으로 갈 `agent_event`·`tool_call` 을 모아 두었다가, 돌아오면 순서대로 보내고 `welcome.resumed:true` 로 알린다. studio 는 끊긴 사이 끝난 `tool_result` 를 다시 붙은 뒤 보낸다.
- 다른 화면 id 가 붙거나 제때 돌아오지 않으면 응답을 멈추고(`interrupted`), 걸려 있던 tool 호출은 `STUDIO_DISCONNECTED` 로 끝낸다. 화면 id 를 주지 않는 연결은 기다리지 않는다.

`Model` = `{id, label, description?, default?:boolean, aliasOf?, resolvedModel?, supportsEffort?, effortLevels?:string[], source:"live"|"cache"|"fallback"}`.
- `defaultModel` = `default:true` 항목(없으면 첫 항목)의 id. `modelsUpdatedAt` = 목록을 받은 시각(ISO), fallback이면 null. `modelsError` = 마지막 실시간 조회 실패 사유.
- 모델 목록 캐시(`doogle-agent/src/model-catalog.mjs`): provider별 메모리 + `appDataDir()/models-cache.json`(0600), TTL 12시간, stale-while-revalidate(오래된 캐시를 즉시 `source:"cache"`로 주고 뒤에서 갱신), provider당 조회 하나만. 실시간·캐시 모두 실패할 때만 provider 정적 목록(`source:"fallback"`).
- hub가 갱신을 끝내면(목록이 바뀌었을 때) 요청 없이도 `providers`를 다시 보낸다. 자동 갱신 시점: hub 기동(캐시 없음/만료), `auth_done` 성공 후, `secrets_set` 성공 후(해당 provider), 턴이 '없는 모델' 오류로 실패했을 때.
- 모델 출처: `claude-sdk` = Claude Agent SDK `Query.supportedModels()`(prompt를 내보내지 않는 streaming-input 세션의 `initialize` 응답 — 모델 요청·사용량 없음, tool/MCP/settings 끔). `id:"default"` 행이 Claude Code 기본값이며 SDK에 model을 넘기지 않는다. `anthropic-api` = `GET https://api.anthropic.com/v1/models`(`x-api-key`, `anthropic-version: 2023-06-01`, `has_more`/`last_id`로 페이지 넘김). openai-*·codex는 provider가 직접 받은 목록(source 없으면 `live`).
- studio는 선택을 provider별로 `localStorage['doogle.model.<providerId>']`에 저장하고, 현재 목록에 없으면 `defaultModel` → 첫 항목으로 바꾼다. `chat_send.model` = 고른 `Model.id`.

mcp ↔ hub (`/mcp`): `tool_call` / `tool_result`만 사용 (hub가 studio로 중계, `origin:"mcp"`). studio 미연결 시 hub가 `{ok:false,error:{code:"NO_DOCUMENT",message:"두글에서 문서를 열어주세요"}}`.

## 3. agent_event.event
`{kind:"status", text}` · `{kind:"text_delta", text}` · `{kind:"text_done"}` · `{kind:"tool_use", callId, name, args}` · `{kind:"tool_result", callId, ok, summary}` · `{kind:"usage", inputTokens?, outputTokens?}` · `{kind:"limit", message, resetAt?}` · `{kind:"error", code, message}` · `{kind:"turn_end", reason:"done"|"cancelled"|"error"|"interrupted"}` (`interrupted`: 화면이 사라져 hub 가 멈췄거나, hub 가 죽어 끝맺지 못한 기록)

## 4. Tool 정의 모듈 (`doogle-agent/src/tools/index.mjs`)
```js
export const TOOL_RULES: string            // rhwp-x RHWP_TOOL_RULES 이식(브라우저 문단 제거)
export const TOOLS: Array<{name, description, kind:'read'|'write'|'control'|'hub', shape /*zod raw shape*/, validate?(args)}>
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
