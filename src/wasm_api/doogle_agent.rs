// Ported from banatic/rhwp-x (MIT) rhwp/src/wasm_api.rs
//! 두글(doogle) 에이전트 도구 실행기용 WASM export.
//!
//! rhwp-x 스튜디오 에이전트가 쓰지만 upstream 에 없던 `HwpDocument` 메서드를 새로 노출한다.
//! JS 이름·인자 순서·반환 JSON 은 rhwp-x 와 같게 유지한다. 목록은
//! `docs/doogle/ENGINE_GAPS.md` 참조.
use super::{parse_cell_path_arg, HwpDocument};
use crate::document_core::DocumentCore;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl HwpDocument {
    // ─── 스테이징 문단 역연산 ─────────────────────────────

    /// 에이전트 대기 편집 전에 본문 문단 하나를 통째로 보관한다 (문단 단위 역연산).
    #[wasm_bindgen(js_name = captureParagraph)]
    pub fn capture_paragraph(&mut self, section_idx: u32, para_idx: u32) -> Result<u32, JsValue> {
        self.capture_paragraph_native(section_idx as usize, para_idx as usize)
            .map_err(|e| e.into())
    }

    /// 보관한 문단으로 지정 위치의 본문 문단을 되돌린다. 보관본은 유지된다.
    #[wasm_bindgen(js_name = restoreCapturedParagraph)]
    pub fn restore_captured_paragraph(
        &mut self,
        id: u32,
        section_idx: u32,
        para_idx: u32,
    ) -> Result<(), JsValue> {
        self.restore_captured_paragraph_native(id, section_idx as usize, para_idx as usize)
            .map_err(|e| e.into())
    }

    #[wasm_bindgen(js_name = discardParagraphCapture)]
    pub fn discard_paragraph_capture(&mut self, id: u32) {
        self.discard_paragraph_capture_native(id);
    }

    /// 레이아웃을 뺀 본문 문단 내용 지문 — 되돌리기 전 사용자 수정 여부 판별용.
    #[wasm_bindgen(js_name = getParagraphContentDigest)]
    pub fn get_paragraph_content_digest(
        &self,
        section_idx: u32,
        para_idx: u32,
    ) -> Result<String, JsValue> {
        self.paragraph_content_digest_native(section_idx as usize, para_idx as usize)
            .map_err(|e| e.into())
    }

    // ─── 읽기 / 측정 ─────────────────────────────────────

    /// 전체 페이지 정보를 JSON 배열로 반환한다 (`getPageInfo` 결과의 배열).
    #[wasm_bindgen(js_name = getAllPageInfo)]
    pub fn get_all_page_info(&self) -> Result<String, JsValue> {
        self.get_all_page_info_native().map_err(|e| e.into())
    }

    /// 쪽의 줄 상자·베이스라인·런 x 범위를 압축 JSON 으로 반환한다 (에이전트 측정용).
    #[wasm_bindgen(js_name = getPageLineLayout)]
    pub fn get_page_line_layout(&self, page_num: u32) -> Result<String, JsValue> {
        self.get_page_line_layout_native(page_num)
            .map_err(|e| e.into())
    }

    /// 에이전트가 넣은 그림·수식의 렌더 경계. 셀 좌표는 수식 자체를 가리킨다.
    #[wasm_bindgen(js_name = getObjectBBox)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_object_bbox(
        &self,
        kind: &str,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: Option<u32>,
        cell_para_idx: Option<u32>,
        inner_control_idx: Option<u32>,
        cell_path_json: Option<String>,
    ) -> Result<String, JsValue> {
        self.get_object_bbox_native(
            kind,
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
            cell_idx.map(|n| n as usize),
            cell_para_idx.map(|n| n as usize),
            inner_control_idx.map(|n| n as usize),
            cell_path_json.as_deref(),
        )
        .map_err(|e| e.into())
    }

    /// 본문 또는 셀 선택에 통째로 포함된 표 주소를 반환한다.
    #[wasm_bindgen(js_name = getTableControlsInSelection)]
    #[allow(clippy::too_many_arguments)]
    pub fn get_table_controls_in_selection(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        container_path_json: &str,
        start_para_idx: u32,
        start_char_offset: u32,
        end_para_idx: u32,
        end_char_offset: u32,
    ) -> Result<String, JsValue> {
        let path = parse_cell_path_arg(container_path_json)?;
        self.table_controls_in_selection_native(
            section_idx as usize,
            parent_para_idx as usize,
            &path,
            start_para_idx as usize,
            start_char_offset as usize,
            end_para_idx as usize,
            end_char_offset as usize,
        )
        .map_err(|err| err.into())
    }

    /// 등록된 글꼴 목록. 반환: JSON `[{"lang":0,"id":0,"name":"..."}]` — 대체 해소 없는 원본 이름.
    #[wasm_bindgen(js_name = getFontList)]
    pub fn get_font_list(&self) -> String {
        self.core.get_font_list()
    }

    // ─── 셀 오프셋 변환 (텍스트 오프셋 ↔ 캐럿 논리 오프셋) ──────────

    #[wasm_bindgen(js_name = logicalToTextOffsetInCell)]
    pub fn logical_to_text_offset_in_cell(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: u32,
        cell_para_idx: u32,
        logical_offset: u32,
    ) -> Result<u32, JsValue> {
        let para = self
            .get_cell_paragraph_ref(
                section_idx as usize,
                parent_para_idx as usize,
                control_idx as usize,
                cell_idx as usize,
                cell_para_idx as usize,
            )
            .ok_or_else(|| JsValue::from_str("셀 문단 접근 실패"))?;
        Ok(
            crate::document_core::helpers::logical_to_text_offset(para, logical_offset as usize).0
                as u32,
        )
    }

    #[wasm_bindgen(js_name = logicalToTextOffsetInCellByPath)]
    pub fn logical_to_text_offset_in_cell_by_path_api(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        path_json: &str,
        logical_offset: u32,
    ) -> Result<u32, JsValue> {
        let path = DocumentCore::parse_cell_path(path_json)?;
        let para = self
            .resolve_paragraph_by_path(section_idx as usize, parent_para_idx as usize, &path)
            .map_err(|e| -> JsValue { e.into() })?;
        Ok(
            crate::document_core::helpers::logical_to_text_offset(para, logical_offset as usize).0
                as u32,
        )
    }

    /// 셀(중첩 포함) 문단의 텍스트 오프셋 → 편집 캐럿 좌표(인라인 개체 = 1칸).
    #[wasm_bindgen(js_name = textToLogicalOffsetInCellByPath)]
    pub fn text_to_logical_offset_in_cell_by_path_api(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        path_json: &str,
        text_offset: u32,
    ) -> Result<u32, JsValue> {
        let path = DocumentCore::parse_cell_path(path_json)?;
        let para = self
            .resolve_paragraph_by_path(section_idx as usize, parent_para_idx as usize, &path)
            .map_err(|e| -> JsValue { e.into() })?;
        Ok(
            crate::document_core::helpers::text_to_logical_offset(para, text_offset as usize)
                as u32,
        )
    }

    /// 셀 문단의 커서 길이: 텍스트와 인라인 개체 슬롯을 함께 센다.
    #[wasm_bindgen(js_name = getCellLogicalLengthByPath)]
    pub fn get_cell_logical_length_by_path(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        path_json: &str,
    ) -> Result<u32, JsValue> {
        let path = DocumentCore::parse_cell_path(path_json)?;
        let paragraph = self
            .resolve_paragraph_by_path(section_idx as usize, parent_para_idx as usize, &path)
            .map_err(|e| -> JsValue { e.into() })?;
        Ok(crate::document_core::helpers::logical_paragraph_length(paragraph) as u32)
    }

    // ─── 표 / 개체 편집 ──────────────────────────────────

    /// 표의 열별 폭(HWPUNIT)을 절대값으로 설정한다. `widths.len()` 은 열 수와 같아야 한다.
    /// 반환: JSON `{"ok":true,"colCount":N,"tableWidth":W}`
    #[wasm_bindgen(js_name = setTableColumnWidths)]
    pub fn set_table_column_widths(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        widths: Vec<u32>,
    ) -> Result<String, JsValue> {
        self.set_table_column_widths_native(
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
            widths,
        )
        .map_err(|e| e.into())
    }

    /// 표를 본문 폭에 맞춰 비례 축소한다 (축소 전용). 반환: JSON `{"ok":true,...}`
    #[wasm_bindgen(js_name = fitTableToPage)]
    pub fn fit_table_to_page(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
    ) -> Result<String, JsValue> {
        self.fit_table_to_page_native(
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
        )
        .map_err(|e| e.into())
    }

    /// 최상위 floating 개체(도형/그림/표/수식) z-order 변경.
    /// operation: "front" | "back" | "forward" | "backward". 반환: `{"ok":true,"zOrder":N}`
    #[wasm_bindgen(js_name = changeObjectZOrder)]
    pub fn change_object_z_order(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        operation: &str,
    ) -> Result<String, JsValue> {
        self.change_object_z_order_native(
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
            operation,
        )
        .map_err(|e| e.into())
    }

    // ─── 표 셀 수식 ──────────────────────────────────────

    /// 표 셀 문단에 수식을 삽입한다. `logical` 은 rx 호환용으로 받기만 하며 true 는 지원하지 않는다
    /// (텍스트 오프셋 계약). 반환: `{"ok":true,"cellParaIdx":N,"controlIdx":N}`
    #[wasm_bindgen(js_name = insertEquationInCell)]
    #[allow(clippy::too_many_arguments)]
    pub fn insert_equation_in_cell(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: u32,
        cell_para_idx: u32,
        char_offset: u32,
        script: &str,
        font_size: u32,
        color: u32,
        logical: Option<bool>,
    ) -> Result<String, JsValue> {
        reject_logical(logical)?;
        self.insert_equation_in_cell_native(
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
            cell_idx as usize,
            cell_para_idx as usize,
            char_offset as usize,
            script,
            font_size,
            color,
        )
        .map_err(|e| e.into())
    }

    /// 중첩 표 셀 문단에 수식을 삽입한다.
    #[wasm_bindgen(js_name = insertEquationInCellByPath)]
    #[allow(clippy::too_many_arguments)]
    pub fn insert_equation_in_cell_by_path(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        cell_path_json: &str,
        char_offset: u32,
        script: &str,
        font_size: u32,
        color: u32,
        logical: Option<bool>,
    ) -> Result<String, JsValue> {
        reject_logical(logical)?;
        self.insert_equation_in_cell_by_path_native(
            section_idx as usize,
            parent_para_idx as usize,
            cell_path_json,
            char_offset as usize,
            script,
            font_size,
            color,
        )
        .map_err(|e| e.into())
    }

    /// 표 셀 문단에서 수식 컨트롤을 삭제한다. 반환: `{"ok":true}`
    #[wasm_bindgen(js_name = deleteEquationControlInCell)]
    pub fn delete_equation_control_in_cell(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: u32,
        cell_para_idx: u32,
        eq_control_idx: u32,
    ) -> Result<String, JsValue> {
        self.delete_equation_control_in_cell_native(
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
            cell_idx as usize,
            cell_para_idx as usize,
            eq_control_idx as usize,
        )
        .map_err(|e| e.into())
    }

    /// 중첩 표 셀 문단에서 정확한 수식 컨트롤을 삭제한다.
    #[wasm_bindgen(js_name = deleteEquationControlInCellByPath)]
    pub fn delete_equation_control_in_cell_by_path(
        &mut self,
        section_idx: u32,
        parent_para_idx: u32,
        cell_path_json: &str,
        eq_control_idx: u32,
    ) -> Result<String, JsValue> {
        self.delete_equation_control_in_cell_by_path_native(
            section_idx as usize,
            parent_para_idx as usize,
            cell_path_json,
            eq_control_idx as usize,
        )
        .map_err(|e| e.into())
    }

    /// 표 셀 문단의 지정 인덱스 수식 스크립트. 반환: `{"ok":true,"script":"..."}`
    #[wasm_bindgen(js_name = getEquationScriptInCellAt)]
    pub fn get_equation_script_in_cell_at_js(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: u32,
        cell_para_idx: u32,
        eq_control_idx: u32,
    ) -> Result<String, JsValue> {
        self.get_equation_script_in_cell_at(
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
            cell_idx as usize,
            cell_para_idx as usize,
            eq_control_idx as usize,
        )
        .map_err(|e| e.into())
    }

    /// 수식 속성 조회. 음수 셀 인자는 "없음"(본문 수식)이다.
    #[wasm_bindgen(js_name = getEquationPropertiesAt)]
    pub fn get_equation_properties_at(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        control_idx: u32,
        cell_idx: i32,
        cell_para_idx: i32,
        inner_control_idx: i32,
    ) -> Result<String, JsValue> {
        self.get_equation_properties_at_native(
            section_idx as usize,
            parent_para_idx as usize,
            control_idx as usize,
            (cell_idx >= 0).then_some(cell_idx as usize),
            (cell_para_idx >= 0).then_some(cell_para_idx as usize),
            (inner_control_idx >= 0).then_some(inner_control_idx as usize),
        )
        .map_err(|e| e.into())
    }

    /// 중첩 표 셀 문단의 정확한 수식 컨트롤 속성.
    #[wasm_bindgen(js_name = getEquationPropertiesByPath)]
    pub fn get_equation_properties_by_path(
        &self,
        section_idx: u32,
        parent_para_idx: u32,
        cell_path_json: &str,
        inner_control_idx: u32,
    ) -> Result<String, JsValue> {
        self.get_equation_properties_by_path_native(
            section_idx as usize,
            parent_para_idx as usize,
            cell_path_json,
            inner_control_idx as usize,
        )
        .map_err(|e| e.into())
    }
}

/// rx 의 `logical=true`(캐럿 논리 오프셋)는 upstream 에 대응 경로가 없어 명시적으로 거절한다.
fn reject_logical(logical: Option<bool>) -> Result<(), JsValue> {
    if logical == Some(true) {
        return Err(JsValue::from_str(
            "logical=true 오프셋은 지원하지 않습니다 — 텍스트 오프셋을 쓰십시오",
        ));
    }
    Ok(())
}
