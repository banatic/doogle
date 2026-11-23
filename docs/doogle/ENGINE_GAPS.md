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

## 7. HWP 암호 문서 — 한글 2024 형식으로 맞춤 (2026-11-24)

- 처음 증상: 두글에서 암호를 걸어 저장한 `.hwp` 를 한글에서 열면 "암호 오류". 두글은 EncryptVersion `4` +
  길이를 바꾸지 않는 AES-128 CFB-1 (`hwp5_transform`) 로 썼는데, 한글 2024 는 그 형식을 쓰지 않는다.
- 한글 2024(13.0) 가 COM(`FilePassword` 액션 → `SaveAs`) 으로 저장한 파일을 암호·내용을 바꿔 가며 평문 쌍과
  대조해 형식을 확정했다. 공개 구현은 찾지 못했다(pyhwp · hwplib · hwp.js 는 암호 문서를 풀지 않는다.
  또렷(ttoryeot) README 의 "EncryptVersion 0 = DES" 한 줄이 실마리였고 코드는 보지 않았다).
- 한글 2024 의 HWP 암호 문서 형식:
  - FileHeader: flags 에 `0x02`(암호)를 더한다(압축 `0x01` 포함 `0x3`), **EncryptVersion `0`**.
    암호 없는 문서는 오히려 `4` 다. 다른 바이트는 그대로.
  - 암호 대상 stream 은 DocInfo, BodyText/*, BinData/*, Scripts/* 다. HwpSummaryInformation, DocOptions/* 는
    평문이고 **PrvText · PrvImage 는 쓰지 않는다.**
  - stream 하나의 구조:
    `DES-ECB( raw-deflate(원본) · 8바이트 정렬 0 채움 · CRC-32(원본) u64 LE · 원본 길이 u64 LE )`
    뒤에 암호화하지 않은 8바이트 trailer `38 A4 CE 59` · `CRC-32(DES 평문 payload) u32 LE`.
    trailer CRC 가 암호 검증 값이다(틀린 암호는 여기서 걸린다). 무작위 IV 가 없어 같은 원본·암호면 같은 바이트.
  - DES 키는 HWP3 과 같다: 암호 UTF-16LE 바이트를 7바이트 버퍼에 `(buf[i%7] ^ b) rol 1` 로 접고, 56비트를
    7비트씩 8바이트에 편다(`derive_hwp3_legacy_des_key`). 한글 암호(`pw한글`)도 같은 방식.
  - BIN_DATA 속성이 NoCompress 인 그림도 envelope 안에서는 deflate 한다(평문 문서에서는 PNG 그대로).
  - DocInfo 첫 레코드 DOCUMENT_PROPERTIES 본문 앞에 256바이트 채움 영역이 붙는다(26 → 282바이트).
    MSVC `rand()` 를 `time()` 으로 seed 해 `(rand()&0xff, (rand()&0xf)+1)` = (값, 반복 길이)를 이어 붙인 것으로,
    암호와 무관하다(같은 초에 저장한 두 암호 파일의 영역이 같고, seed = 저장 시각으로 재현된다).
- 두글 구현 (`crates/rhwp-password-crypto` `seal_hwp5_des_deflated` · `seal_hwp5_des_stored_deflate` ·
  `open_hwp5_des_stream` · `hwp5_password_prefix`):
  - 저장(`src/serializer/cfb_writer.rs`): 위 형식 그대로 쓴다. 암호 저장은 압축을 강제하고 PrvText/PrvImage 를
    뺀다. 한글이 쓴 deflate 바이트를 넣으면 암호화 결과가 한글 산출물과 바이트까지 같다(단위 테스트).
  - 열기(`src/parser/crypto.rs`): stream 끝 trailer 로 형식을 가려 한글 형식(EncryptVersion 0)과 예전 두글
    형식(EncryptVersion 4, AES CFB-1)을 모두 연다. EncryptVersion 1~3 은 여전히 거부한다.
  - 테스트: `crates/rhwp-password-crypto` 단위 테스트, `src/parser/hangul_password_tests.rs`
    (fixture `tests/fixtures/hwp_password/` — 한글 2024 산출물 3개).
- 남은 확인: 두글이 쓴 암호 HWP 를 한글에서 실제로 여는 것은 사람이 해 봐야 한다(자동화로 암호 문서를 열면
  암호 창이 떠서 멈춘다). 비압축 문서(FileHeader 압축 비트 0)를 한글이 암호 저장할 때의 형식, DocHistory 등
  다른 storage 의 암호화 여부는 보지 못했다. 한글 UI 의 암호 설정 창으로 저장한 파일도 같은 형식인지
  (COM 과 같은 코드 경로로 보이지만) 따로 확인하지 않았다.
- HWPX 는 한글과 같은 ODF AES-256-CBC/PBKDF2(HMAC-SHA1, 1024회) manifest 를 쓰고, 두글 복호기가 한글 산출물을
  정상 복호화했다(오답 암호는 거부).
- 편집기의 HWP 암호 저장 차단(`rhwp-studio/src/command/commands/file.ts`)은 걷어냈다.

## 8. 셀 경로 표 편집 · 다단 적용 범위 (2026-11-24)

엔진(`src/`)에는 들어갔고 `pkg/` WASM 은 아직 다시 빌드하지 않았다 — 두 기능 모두 새 빌드가 있어야 동작한다.
에이전트는 export 가 없으면 `ENGINE_UNSUPPORTED`(어느 메서드가 없는지 + 엔진을 다시 빌드하라는 안내)로 거절한다.

### 8.1 중첩 표 · 머리말/꼬리말 안 표 (`*ByPath`)

| WASM export | native | 평면 짝 |
|---|---|---|
| `insertTableRowByPath(sec, ppi, pathJson, row, below)` | `insert_table_row_by_cell_path_native` | `insertTableRow` |
| `insertTableColumnByPath(sec, ppi, pathJson, col, right)` | `insert_table_column_by_cell_path_native` | `insertTableColumn` |
| `deleteTableRowByPath(sec, ppi, pathJson, row)` | `delete_table_row_by_cell_path_native` | `deleteTableRow` |
| `deleteTableColumnByPath(sec, ppi, pathJson, col)` | `delete_table_column_by_cell_path_native` | `deleteTableColumn` |
| `mergeTableCellsByPath(sec, ppi, pathJson, sr, sc, er, ec)` | `merge_table_cells_by_cell_path_native` | `mergeTableCells` |
| `splitTableCellIntoByPath(sec, ppi, pathJson, row, col, n, m, equalRowHeight, mergeFirst)` | `split_table_cell_into_by_cell_path_native` | `splitTableCellInto` |
| `setCellPropertiesByPath(sec, ppi, pathJson, cellIdx, json)` | `set_cell_properties_by_cell_path_native` | `setCellProperties` |
| `setCellZonePropertiesByPath(sec, ppi, pathJson, sr, sc, er, ec, json)` | `set_cell_zone_properties_by_cell_path_native` | `setCellZoneProperties` |
| `setTablePropertiesByPath(sec, ppi, pathJson, json)` | `set_table_properties_by_cell_path_native` | `setTableProperties` (캡션 키 거절) |
| `setTableColumnWidthsByPath(sec, ppi, pathJson, widths)` | `set_table_column_widths_by_cell_path_native` | `setTableColumnWidths` |
| `deleteTableByPath(sec, ppi, pathJson)` | `delete_table_by_cell_path_native` | `deleteTableControl` / `deleteCellTableControlByPath` |

- 경로는 `resizeTableCellsByPath` 와 같다 — 마지막 항목의 `controlIndex` 가 대상 표, 깊이 1 이면 평면 API 그대로.
  머리말·꼬리말 마디(`{controlIndex:머리말, cellIndex:0, cellParaIndex:머리말 문단}`)도 받는다.
- 구현(`src/document_core/commands/table_path_ops.rs`): 표를 품은 문단(host)을 잠깐 구역의 `ppi` 자리에 올려 두고
  **평면 구현을 그대로 부른 뒤** 되돌린다(batch 모드로 그 사이 쪽 나누기는 미룬다). 평면 구현의 부모 문단 검사
  (테두리 조각 바인딩 등)가 실제 부모를 본다. 되돌린 뒤 안쪽에서 바깥으로 host 문단 줄(LINE_SEG)을 다시 짜고
  세로 위치를 다시 이은 다음 구역을 다시 조판한다 — 글자처럼 취급한 중첩 표는 host 줄 높이를 먼저 차지하므로
  이 단계가 없으면 바깥 칸이 실제보다 커진다(실측 125.7px → 83.9px).
- 거절: 원본 테두리 조각(셀 테두리를 그림으로 그린 원본)이 있는 중첩 표의 테두리·채우기 변경(그 undo 기록이 평면 좌표를 열쇠로 쓴다), 중첩 표 캡션.
- 이벤트 로그: 평면 명령의 이벤트 대신 바깥 칸의 `CellTextChanged` 하나.
- studio `WasmBridge` 에는 래퍼를 두지 않았다(에이전트는 `HwpDocument` 를 직접 부른다) — 편집기 UI 가 쓰게 되면
  브리지 메서드와 `mutation-method-registry.ts` 분류를 함께 더한다.
- 검증: `cargo test -p rhwp --lib table_path_ops` — 6개 통과(모듈 안 `#[cfg(test)]`): 깊이 2·3 중첩 표와 꼬리말 표에서
  행·열 넣기/지우기, 병합·나누기, 셀 속성, 영역, 표 속성, 열 폭, 지우기, 실패 시 문서 그대로, 바깥 칸 높이
  (편집 직후 = 저장 후 다시 연 문서), HWP·HWPX 저장 왕복. 워크스페이스 전체 `cargo test --lib` 는
  `crates/rhwp-contracts` 가 없는 `mydocs/` 문서를 include 해 이 checkout 에서 컴파일되지 않는다(`-p rhwp` 로 돌린다).

### 8.2 다단 적용 범위

`applyColumnDef(sec, para, charOffset, scope, count, type, sameWidth, spacingHu)` / `getColumnDefAt(sec, para)`
(`src/document_core/commands/column_ops.rs`). 에이전트 `set_columns` 가 쓴다 — "표지 1단 · 본문 2단" 은
본문 첫 문단에서 `scope:"from_here"`.
