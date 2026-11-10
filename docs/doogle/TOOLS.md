# 두글 에이전트 tool 설계 — rhwp-x에서 가져온 것

출처: https://github.com/banatic/rhwp-x (MIT; © banatic, Hataewook/Rauhwpx, Edward Kim/rhwp)
- 스키마: `rhwp/rhwp-agent/tools.mjs` (2,127줄, zod)
- 공통 규칙: `rhwp/rhwp-agent/tool-rules.mjs` (`RHWP_TOOL_RULES`)
- 실행기: `rhwp/rhwp-studio/src/agent/tool-executor.ts` (8,110줄)
- 검토/스테이징: `rhwp/rhwp-studio/src/agent/pending-edits.ts`(4,284), `pending-overlay.ts`, `revision.ts`, `edit-journal.ts`, `turn-checkpoints.ts`
- MCP 노출: `rhwp/rhwp-agent/mcp-stdio.mjs`
- Provider: `agents/claude.mjs`(Agent SDK `query`), `agents/codex-app-server.mjs`
- 스킬: `rhwp-agent/skills/` (proofread-korean, humanize-korean, rewrite-tone, summarize-document, draft-document …)

MIT이므로 저작권 표시(LICENSE 3줄)만 유지하면 코드 그대로 가져와도 됨.

---

## 1. 설계 원칙 (가장 가치 있는 부분)

| 원칙 | 내용 | 두글 적용 |
|---|---|---|
| **공통 규칙 1회 기술** | 주소·리비전·배치·앵커·스테이징 규칙을 `RHWP_TOOL_RULES` 한 곳에 쓰고, 각 tool 설명엔 `"Write (rhwp tool rules)."` 포인터만 | 그대로 채택. MCP `instructions` + provider 시스템 프롬프트에 둘 다 실음 → 토큰 절약 |
| **리비전 낙관적 잠금** | 모든 read가 `revision` 반환, 모든 write는 `expectedRevision` 필수. 불일치 시 `REVISION_MISMATCH` + 현재 revision + 복구 안내. 서로 다른 문단 편집은 자동 rebase(`rebasedParaShift`) | 채택 (PLAN의 블록 hash 방식 대체 — 더 단순) |
| **좌표 + 텍스트 앵커 이중 지정** | `sectionIdx/paraIdx/charOffset` 또는 `find:"정확한 텍스트"` (+`occurrence`, `position: before/after/replace`). 실행 시점에 해석, 공백 차이 허용, 0개/다수 매치는 후보 5개와 함께 실패. 여러 문단 범위는 `anchor{text, occurrence, within{sectionIdx, paraRange, cell}}` | 채택 |
| **배치** | `apply_edits` 최대 32개 원자적(하나 실패 시 전체 롤백, 실패 항목 전부 보고), `read_batch` 최대 16개(항목별 독립) | 채택 |
| **다문단 서식** | `paras: [48, [51,53]]` — 인덱스 또는 구간 | 채택 |
| **write 결과 피드백** | `after {paragraphs(바뀐 텍스트), pageCountBefore, pageCount, pages, warnings}`; `render:"crop"`이면 바뀐 영역 PNG | 채택 — 모델이 결과를 눈으로 확인 |
| **스테이징 검토** | "에이전트 모드": 모든 write가 즉시 라이브 프리뷰로 적용(읽기/렌더도 반영된 상태), 턴 종료 시 사용자 검토로 보류, 조용히 롤백 안 함. "전체 모드": 바로 적용, write 1회 = undo 1단계 | 채택 (PLAN §4의 "스냅샷 임시 적용" 방식보다 낫다 — 모델이 자기 편집 결과를 이어서 읽을 수 있음) |
| **표 셀 주소** | `cell {paraIdx, controlIdx, cellIdx}` (cellIdx = 병합 셀 1개로 센 행 우선 인덱스), 중첩은 `cellPath [{controlIndex, cellIndex, cellParaIndex}]` | 채택 |
| **오프셋 정의** | `charOffset`은 텍스트 문자만 셈, 인라인 객체(수식/그림/표)는 오프셋 없음 | 채택 → PLAN Phase 0 "charOffset 단위" 검증 항목 해결 |
| **단위** | mm, pt, `#RRGGBB` | 채택 |
| **escape hatch** | `get_engine_edit_capabilities` → `apply_engine_edits {method, args}` 로 WASM 엔진 메서드 직접 호출(최대 32, 원자적) | 채택 (semantic tool로 안 되는 편집 대비) |
| **스키마 크기 절약** | 반복 스키마는 느슨하게(record) 두고 검증은 executor에서, 에러 메시지로 올바른 형태 안내 | 채택 |

## 2. 가져올 tool 목록 (v1)

### 읽기
| tool | 핵심 인자 | 비고 |
|---|---|---|
| `get_structure` | `pages[first,last]`, `range{sectionIdx,fromPara,toPara}`, `text: preview\|full`, `sinceRevision`, `format: text\|json` | **진입점.** 주소 + 텍스트 + 쪽 나눔 + 제목/굵게 태그, 표는 앵커 문단 뒤 cellIdx 그리드. `sinceRevision`이면 바뀐 문단만 |
| `get_outline` | – | 개요 |
| `get_text_range` | `sectionIdx, paraIdx, charOffset?, count?, cell?, cellPath?` | |
| `get_selection` | – | 사용자 커서/선택 (셀 주소 포함) |
| `find_text` | `query, caseSensitive?, maxResults?` | 결과를 그대로 write 인자로 사용 가능 |
| `get_document_info` | `fontQuery?` | documentId, digest, dirty, 쪽/구역 수, 사용 가능 폰트 |
| `get_fields` | – | 누름틀 목록 |
| `get_para_format` / `get_char_format` | 주소 | 서식 상속 규칙: 삽입 텍스트는 **삽입 지점 앞 글자** 서식 상속 |
| `get_table_properties` / `get_table_layout` | `paraIdx, controlIdx, cellIdx?` | layout은 페이지 넘침(`overflowsBody`) 감지 + 해결법 안내 |
| `list_styles` / `list_numberings` / `list_footnotes` / `list_bookmarks` | – | |
| `render_page` | `pageIndex, format: png\|svg, scale, regionMm` | 모델이 시각 확인 |
| `get_page_geometry` | `pageIndex, include[lines,runs,objects], regionMm` | 배치 작업용 |
| `verify_changes` | – | 선택적 검토 요약 |
| `read_batch` | `reads[{tool,args}]` ≤16 | |

### 쓰기 (모두 `expectedRevision`, `render?` 공통)
| tool | 핵심 인자 |
|---|---|
| `insert_text` | 좌표 또는 `find`+`position`; `"\n"`은 문단 분리 |
| `replace_range` | `find` 또는 좌표 범위, `text` (`""`=삭제). **서식 유지 — delete+insert보다 우선** |
| `delete_range` | `find` 또는 좌표 범위 (표를 가로지를 수 없음) |
| `replace_all` | 전체 치환 |
| `apply_char_format` | `find` / 범위 / 문단 / `paras`; `bold, italic, underline, strikethrough, fontSizePt, textColor, fontFamily, widthPercent(장평), letterSpacingPercent(자간)` … 절대값 |
| `apply_para_format` | 정렬, 간격, 줄간격, 들여쓰기, 탭, 테두리 … |
| `apply_style` / `apply_list` | 스타일, 번호/글머리 |
| `create_table` / `edit_table` / `set_table_props` / `set_cell_props` / `set_zone_borders` / `delete_table` | `edit_table`에 행/열 삽입삭제, 병합/분할, `fit_to_page`, `set_column_widths` |
| `set_field_value` | 누름틀 채우기 |
| `insert_page_break` / `set_page_layout` / `edit_header_footer` | |
| `insert_footnote` / `edit_footnote` / `set_bookmark` | |
| `insert_image` / `insert_equation` / `preview_equation` / `insert_shape` / `insert_chart` / `edit_object` | image·chart는 비동기라 배치 불가 |
| `apply_edits` | `edits[{tool, …인자}]` ≤32, 원자적 |
| `apply_engine_edits` / `prepare_engine_edit_session` | escape hatch |

### 대화 제어
`ask_user_question`, `request_permission`, `present_implementation_plan`, `update_todos`

## 3. v1에서 제외
| 영역 | tool | 이유 |
|---|---|---|
| 브라우저 자동화 | `browser_*`, `request_secret`, `browser_fill_*` | Playwright 의존, 범위 밖, 보안 표면 큼 |
| 프로젝트/참고자료 | `project_*`, `search_reference_files`, `read_reference_*`, `find_home_files` | v2 (RAG) |
| 서식 틀 | `template_*`, `get_active_template` | v1.1 |
| 레이아웃 복제 | `*copy_layout*` | Python 헬퍼 의존, v2 |
| 다중 문서/버전 | `list_documents`, `open_document`, `commit_version`, `materialize_document_snapshot` | v1.1 |
| 스킬 편집 | `update_agent_instructions`, `commit_product_skill` | v1.1 |

## 4. ⚠ 가져오면 안 되는 코드 (Anthropic 정책)
rhwp-x는 Claude 로그인 토큰을 직접 읽고 복제한다:
- `claude-credentials.mjs` — `~/.claude/.credentials.json` / macOS Keychain `Claude Code-credentials`에서 `claudeAiOauth.accessToken` 파싱
- `credential-mirror.mjs`, `oauth-credential-transaction.mjs` — 격리 홈으로 자격증명 미러링
- `provider-limits.mjs` — Keychain을 읽어 사용량 조회
- `agents/claude.mjs`의 `prepareClaudeHome` / `flushClaudeCredentialMirrors`

legal 페이지: *"developers may not collect, store, or intermediate Claude.ai credentials or session tokens"* → **두글은 이 파일들을 가져오지 않는다.** Agent SDK는 사용자의 기본 `~/.claude`로 그대로 실행하고(격리 홈 X), 사용량은 SDK가 주는 이벤트/에러로만 표시.

## 5. 이식 순서
1. `tool-rules.mjs` + `tools.mjs`의 문서 tool 정의만 추출 → `doogle-agent/tools/`
2. `tool-executor.ts`, `revision.ts`, `pending-edits.ts`, `pending-overlay.ts`, `write-report.ts`를 두글 studio로 이식, 업스트림 rhwp WASM API와 시그니처 대조 (rhwp-x는 자체 rhwp 사본 사용 — 차이 확인 필요)
3. `mcp-stdio.mjs` → 라이브 문서 MCP 브리지
4. `agents/claude.mjs`에서 SDK `query` 루프만 (자격증명 코드 제거)
5. `agents/codex-app-server.mjs` → Codex 경로
6. `skills/proofread-korean`, `humanize-korean`, `rewrite-tone`, `summarize-document`, `draft-document` (humanize-korean은 자체 LICENSE.txt 확인)
