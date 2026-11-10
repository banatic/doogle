# ENGINE_GAPS — rhwp-x 에이전트가 쓰는 WASM API와 upstream 대조

소유: 에이전트 A(engine). 소비: 에이전트 E(studio-exec, `rhwp-studio/src/doogle/agent/**`).
작성 상태: **v2 (이식 완료분 반영)** — status 열이 최신이다.

## 0. 조사 방법과 한계

- 대상 코드: `$RX/rhwp/rhwp-studio/src/agent/*.ts` 전부. 에이전트 코드는 `HwpDocument`를
  직접 부르지 않고 **`WasmBridge`(`src/core/wasm-bridge.ts`) 메서드 `wasm.X(...)`**를 부른다
  (예외: `document-preflight.worker.ts`가 `HwpDocument.fromBytesWithFontMetrics`, `convertToEditable` 직접 호출).
- 그래서 두 층을 각각 대조했다.
  1. **브리지 층**: 에이전트가 쓰는 `WasmBridge` 메서드 174개 → upstream `rhwp-studio/src/core/wasm-bridge.ts`에 있는지.
  2. **WASM 층**: 그 174개 브리지 메서드 본문이 호출하는 `HwpDocument` 메서드 167개 + 직접 호출 2개 →
     upstream `src/wasm_api.rs`, `src/wasm_api/**`의 `#[wasm_bindgen]` export와 비교.
- WASM 층 비교 기준: `#[wasm_bindgen]` 래퍼 함수의 시그니처와 본문(공백 무시). "identical"은
  **래퍼 본문이 같다**는 뜻이며 그 아래 `DocumentCore` 구현의 JSON 형태까지 diff 하지는 않았다(**미검증**).
- 분석 스크립트·중간 JSON은 scratchpad의 `gap/`에 있다(저장소 밖).

## 1. 요약

| 분류 | 개수 |
|---|---|
| WASM 메서드: 래퍼 동일 (present-identical) | 118 |
| WASM 메서드: 있으나 시그니처/동작 차이 (present-different) | 19 |
| WASM 메서드: upstream에 없음 (missing) | 31 (+`fromBytesWithFontMetrics`) |
| 브리지 메서드: upstream `WasmBridge`에 없음 | 31 |

## 2. upstream에 없는 WASM 메서드 (missing)

status: `ported` = upstream `src/`에 새 export로 이식 완료(`cargo test` 통과분은 ✔) · `ported*` = 제한 있음 ·
`skip` = 이식하지 않음 → E가 TS에서 대체.

이식 코드: `src/wasm_api/doogle_agent.rs`(export), `src/document_core/doogle/{paragraph_capture,queries,object,equation}.rs`(core).
기존 파일 변경은 `DocumentCore`에 `doogle: DoogleState` 필드 1개 추가(+ 생성자 2곳, 문서 로드 시 초기화)와 `mod` 선언뿐이다.

| WASM 메서드 | 쓰는 곳 (rhwp-x) | status | 비고 / E 측 대응 |
|---|---|---|---|
| `captureParagraph` / `restoreCapturedParagraph` / `discardParagraphCapture` | pending-edits | ported ✔ | 복원은 upstream `restoreSnapshot`과 같은 `rebuild_derived_state()`(문서 전체 재조판). 그대로 호출 |
| `getParagraphContentDigest` | pending-edits | ported ✔ | rx 해시에서 upstream에 없는 `special_space_origins` 필드만 빠짐(같은 빌드 안에서만 비교하므로 무해) |
| `getAllPageInfo` | pending-overlay | ported ✔ | |
| `getPageLineLayout` | tool-executor(get_page_geometry), document-region-capture | ported ✔ | JSON 형태 rx와 동일 |
| `getObjectBBox` | pending-overlay | ported* | upstream 렌더 노드에 셀 정보가 부족: **셀 안 그림 미지원(오류)**, 셀 수식은 깊이 1 경로만, `innerControlIdx` 무시(셀 문단 첫 수식). 오류 시 overlay 생략 |
| `getTableControlsInSelection` | tool-executor | ported ✔ | |
| `getFontList` | tool-executor(get_document_info) | ported ✔ | |
| `fitTableToPage` / `setTableColumnWidths` | pending-edits, edit_table | ported | upstream native 재사용(export만 추가). 반환 JSON 동일 |
| `changeObjectZOrder` | pending-edits, edit_object | ported | 컴파일만 확인, 단위 테스트 없음(**미검증**) |
| `insertEquationInCell` / `...ByPath` | pending-edits | ported ✔(깊이 1) | 수식 조립은 upstream `insertEquation`과 같다. `logical=true`는 오류. 편집 후 문서 전체 재조판. ByPath 깊이≥2는 테스트 없음 |
| `deleteEquationControlInCell` / `...ByPath` | pending-edits | ported ✔(깊이 1) | 위와 같음 |
| `getEquationScriptInCellAt` | pending-edits | ported ✔ | |
| `getEquationPropertiesAt` / `getEquationPropertiesByPath` | pending-edits, inline-prompt | ported ✔ | |
| `logicalToTextOffsetInCell` / `...ByPath`, `textToLogicalOffsetInCellByPath`, `getCellLogicalLengthByPath` | inline-prompt, tool-executor, pending-* | ported | 컴파일 확인. upstream helper 그대로 사용 |
| `setTableCaptionText` | pending-edits | **skip** | upstream에 표 캡션 생성(`hasCaption`)·자동 번호 재배정 경로가 없음. E: 캡션 편집은 `UNSUPPORTED` 오류로 처리 |
| `splitParagraphLogical` / `splitParagraphInCellLogical` | pending-edits | **skip** | upstream에 `ParagraphSplitIntent::LogicalContinuation` 없음(분할 내부 변경 필요). E: `splitParagraph(sec, para, off)` / `splitParagraphInCell(sec, ppi, ci, cell, cp, off)`로 대체 — 차이: 원 문단의 강제 쪽/단 나눔 속성이 새 문단에 이어질 수 있음 |
| `getSelectionRectsByPath` | pending-overlay | **skip** | upstream `get_selection_rects_native`에 경로 주소가 없음. E: 깊이 1이면 `getSelectionRectsInCell(sec, ppi, ci, cell, sp, so, ep, eo)`, 깊이≥2는 하이라이트 생략 |
| `renderEquationPreviewWithFont` | preview_equation | **skip** | 렌더러 변경 필요. E: `renderEquationPreview(script, size, color)`로 대체(글꼴 인자 무시) |
| `refreshLayout` | (브리지 내부) | **skip** | 조판 캐시 내부. upstream 브리지는 이미 `?.()` 옵셔널 호출 |
| `pasteDocumentBlock` | tool-executor(template 전송) | **skip** (v1 범위 밖) | 코드 경로 제거 |
| `fromBytesWithFontMetrics` | document-preflight.worker | **skip** | `new HwpDocument(bytes)` 사용 |

## 3. 있으나 다른 WASM 메서드 (present-different)

| WASM 메서드 | 차이 | 영향 | E 측 대응 |
|---|---|---|---|
| `getTextRange`, `getTextInCell`, `getTextInCellByPath`, `insertText`, `insertTextInCell`, `insertTextInCellByPath`, `deleteRange`, `deleteRangeInCellByPath`, `insertEquation` | rx는 끝에 `logical?: bool` 추가. 생략/false면 upstream과 **같은 텍스트 오프셋 경로**. | tool-executor는 `logical`을 넘기지 않음(텍스트 오프셋 계약). 브리지 기본값 `logical=false`. | 인자 생략. escape hatch 시그니처에서 `logical` 제거 |
| `getSelectionRects` | rx는 `closeGaps?: bool`(기본 true) 추가 | 오버레이 사각형 사이 틈 메우기 여부만 다름 | 인자 생략(틈 메우기 없음 — 시각 차이만) |
| `getNumberingList` | rx JSON에 `numberFormats:[...]` 추가 | apply_list가 번호 형식 코드를 읽으면 없음 | `numberFormats` 없을 때 `levelFormats`로 폴백 |
| `getBulletList` | 문자 이스케이프 방식 차이 | JSON 파싱 결과 같음(추정, 미검증) | 없음 |
| `createNumbering`, `ensureDefaultBullet` | upstream이 더 최신(`attr` 자동 번호, raw stream dirty) | 없음 | 없음 |
| `evaluateTableFormulaEx` | rx는 `evaluate_table_formula_formatted(…, options)` — 결과 서식 옵션 지원 | 서식 옵션 무시됨 | 서식 옵션 미지원으로 취급 |
| `insertPictureEx` | rx는 options `placement:"inline"|"floating"` 지원 | upstream은 항상 floating | inline 요청 시 `treatAsChar` 속성 후처리 또는 미지원 경고 |
| `getCellParaPropertiesAtByPath` | `&self` vs `&mut self` | 없음 | 없음 |
| `exportHwp`, `renderPageToCanvas` | 내부 구현 차이(upstream이 더 최신) | 없음 | 없음 |

## 4. 래퍼 동일 WASM 메서드 (present-identical, 118개)

`addBookmark`, `applyCellStyle`, `applyCharFormat`, `applyCharFormatInCell`, `applyCharFormatInCellByPath`, `applyParaFormat`, `applyParaFormatInCell`, `applyParaFormatInCellByPath`, `applyParaFormatInHf`, `applyStyle`, `convertToEditable`, `createHeaderFooter`, `createShapeControl`, `createTableEx`, `deleteBookmark`, `deleteCellPictureControlByPath`, `deleteEquationControl`, `deleteFootnote`, `deleteHeaderFooter`, `deletePictureControl`, `deleteRangeInCell`, `deleteShapeControl`, `deleteTableColumn`, `deleteTableControl`, `deleteTableRow`, `deleteTextInFootnote`, `discardSnapshot`, `exportHwpx`, `findOrCreateFontId`, `getBookmarks`, `getCellCharPropertiesAt`, `getCellCharPropertiesAtByPath`, `getCellInfo`, `getCellParaPropertiesAt`, `getCellParagraphCount`, `getCellParagraphCountByPath`, `getCellParagraphLength`, `getCellParagraphLengthByPath`, `getCellPicturePropertiesByPath`, `getCellProperties`, `getCellShapePropertiesByPath`, `getCharPropertiesAt`, `getCharShapeRuns`, `getCharShapeRunsInCellByPath`, `getColumnDef`, `getControlTextPositions`, `getCursorRect`, `getCursorRectByPath`, `getCursorRectInCell`, `getDocumentInfo`, `getEquationProperties`, `getFieldList`, `getFootnoteInfo`, `getHeaderFooter`, `getHeaderFooterParaInfo`, `getLogicalLength`, `getNoteEquationProperties`, `getPageBorderFill`, `getPageControlLayout`, `getPageDef`, `getPageFootnoteInfo`, `getPageInfo`, `getParaPropertiesAt`, `getParagraphCount`, `getParagraphLength`, `getPictureProperties`, `getPositionOfPage`, `getSectionCount`, `getSectionDef`, `getShapeBBox`, `getShapeProperties`, `getSourceFormat`, `getStructure`, `getStyleList`, `getTableBBox`, `getTableBBoxAtPage`, `getTableCellBboxes`, `getTableCellBboxesByPath`, `getTableDimensions`, `getTableDimensionsByPath`, `getTableProperties`, `insertEndnote`, `insertFootnote`, `insertPicture`, `insertTableColumn`, `insertTableRow`, `insertTextInFootnote`, `logicalToTextOffset`, `mergeTableCells`, `pageCount`, `renameBookmark`, `renderEquationPreview`, `renderPageSvg`, `replaceRangeInHeaderFooter`, `restoreSnapshot`, `saveSnapshot`, `setCellParaShapeId`, `setCellParaShapeIdByPath`, `setCellPicturePropertiesByPath`, `setCellProperties`, `setCellShapePropertiesByPath`, `setCellZoneProperties`, `setCharShapeId`, `setCharShapeIdInCell`, `setCharShapeIdInCellByPath`, `setCharShapeRuns`, `setCharShapeRunsInCellByPath`, `setColumnDef`, `setFieldValueByName`, `setPageDef`, `setParaShapeId`, `setPictureProperties`, `setSectionDef`, `setShapeProperties`, `setTableProperties`, `splitParagraphInCellByPath`, `splitTableCellInto`, `textToLogicalOffset`

(래퍼만 동일. 그 아래 core 구현의 반환 JSON 필드는 미검증.)

## 5. 브리지 층 (E가 처리)

upstream `WasmBridge`에 없는 메서드(에이전트 사용분): `captureParagraph`, `changeObjectZOrder`,
`deleteEquationControlInCell(ByPath)`, `discardParagraphCapture`, `documentInstance`,
`evaluateTableFormulaEx`, `fitTableToPage`, `getAllPageInfo`, `getCellLogicalLengthByPath`,
`getEquationPropertiesByPath`, `getEquationScriptInCellAt`, `getFontList`, `getObjectBBox`,
`getOutlineStructure`(= `doc.getStructure`), `getPageLineLayout`, `getParagraphContentDigest`,
`getSelectionRectsByPath`, `getTableControlsInSelection`, `insertEquationInCell(ByPath)`,
`logicalToTextOffsetInCell(ByPath)`, `pasteDocumentBlock`, `restoreCapturedParagraph`,
`setTableCaptionText`, `setTableColumnWidths`, `splitParagraphInCellLogical`, `splitParagraphLogical`,
`textToLogicalOffsetInCellByPath`, `withBodyTextPaginationBatch`.

권장: E는 upstream `WasmBridge`를 수정하지 말고(소유 밖) `rhwp-studio/src/doogle/agent/` 안에
`AgentWasm` 어댑터를 두어 rhwp-x 브리지 메서드 본문(대부분 `JSON.parse(this.doc.X(...))` 한 줄)을
이식한다. raw `HwpDocument` 접근은 upstream 브리지의 `doc` 필드(private)를 통해야 하므로 어댑터에서
`(wasm as any).doc`로 얻는다. `documentInstance`/`withBodyTextPaginationBatch`는 TS 전용 개념이라
어댑터에서 구현(인스턴스 카운터 / 단순 콜백 실행)한다.

### escape hatch (`engine-edit-capabilities.generated.ts`)

rx 목록 187개 중 40개는 upstream 브리지에 없다. 그중 upstream WASM에 있는 것: `deleteCellTableControlByPath`,
`deleteParagraph`, `evaluateTableFormulaEx`, `insertParagraph`, `setPageHide`. 나머지 35개
(`*AcrossSections`, `*InHf`/`*InFootnote` 서식, `*ByPath` 표 행/열/병합/분할, `copy/paste/clearTableCellRange`,
`movePictureControl(ByPath)`, `setEquationPropertiesByPath`, 그리고 §2의 이식 대상)는 §2에서 이식된 것(`changeObjectZOrder`, `fitTableToPage`, `setTableColumnWidths`, 셀 수식 4종)을 제외하면
upstream WASM에 없다 → E는 capability 목록을 upstream 기준으로 재생성(없는 메서드 제외)해야 한다.

## 6. 빌드·검증 기록 (2026-11-10, 에이전트 A)

- 환경 주의: 저장소 고정 툴체인 `1.93.1`로는 이 머신에서 build script 실행 파일이 생성 직후 사라져
  `os error 5`로 실패한다(빈 프로젝트+`libc`로도 재현, `stable` 1.98.0은 정상). 아래는 모두 `stable` 툴체인.
- sparse checkout에 `tools saved assets samples ttfs`를 추가했다(워크스페이스 멤버·`include_bytes!` 대상).
- `cargo +stable check -p rhwp --lib --target-dir target/pr-review` → 성공, 새 경고 없음.
- `cargo +stable test -p rhwp --lib --target-dir target/pr-review doogle` → 6 passed
  (paragraph_capture 4, queries 1, equation 1).
- WASM: `RUSTUP_TOOLCHAIN=stable CARGO_TARGET_DIR=target/pr-review scripts/wasm-pack-locked.ps1 --target web --out-dir pkg`
  → 성공(21분), `pkg/rhwp.js`·`pkg/rhwp_bg.wasm`·`pkg/rhwp.d.ts` 생성, 새 export가 `pkg/rhwp.d.ts`에 있음.
  `.ps1` 래퍼는 `.sh`와 달리 `rhwp-studio/public/`에 동기화하지 않는다 — public의 `rhwp.js`는 이전 빌드다.
- 미실행: clippy/fmt 게이트, 브라우저 실동작, `changeObjectZOrder`·오프셋 변환·깊이≥2 셀 수식 테스트.
