// Ported from banatic/rhwp-x (MIT) rhwp/src/document_core/commands/object_ops/equation.rs
//! 표 셀 문단의 수식 삽입·삭제·조회 (에이전트 대기 편집과 역연산용).
//!
//! rhwp-x 의 셀 수식 API 를 upstream 모델 위에 다시 세운다.
//! - 수식 컨트롤 조립은 upstream `insert_equation_native`(본문) 과 같은 한컴 인라인 수식 계약을
//!   따른다(`build_inline_equation`).
//! - 셀 문단 변이 후에는 upstream 셀 리플로우 primitive(셀 폭 줄나눔·vpos 재계산·표 텍스트
//!   reflow 표식)를 호출한 뒤, 증분 캐시를 추측하지 않도록 upstream 스냅샷 복원과 같은
//!   `rebuild_derived_state()` 로 파생 상태 전체를 다시 만든다. 대화형 타이핑 경로가 아니라
//!   에이전트 편집 한 건당 한 번이므로 비용보다 정확성을 택한다.

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::{Control, Equation};
use crate::model::paragraph::Paragraph;

fn err(message: impl Into<String>) -> HwpError {
    HwpError::RenderError(message.into())
}

fn equation_at(para: &Paragraph, eq_control_idx: usize) -> Result<&Equation, HwpError> {
    match para.controls.get(eq_control_idx) {
        Some(Control::Equation(eq)) => Ok(eq),
        Some(_) => Err(err("지정된 컨트롤이 수식이 아닙니다")),
        None => Err(err(format!("컨트롤 인덱스 {} 범위 초과", eq_control_idx))),
    }
}

/// 문단의 텍스트 오프셋 위치에 인라인 수식 컨트롤을 넣고 controls 인덱스를 돌려준다.
/// upstream `insert_equation_native` 의 본문 삽입 순서와 같다.
fn insert_equation_control(para: &mut Paragraph, equation: Equation, char_offset: usize) -> usize {
    let positions = crate::document_core::helpers::find_control_text_positions(para);
    let insert_idx = positions
        .iter()
        .position(|&pos| pos > char_offset)
        .unwrap_or(para.controls.len());
    para.align_ctrl_data_records();
    para.controls
        .insert(insert_idx, Control::Equation(Box::new(equation)));
    para.ctrl_data_records.insert(insert_idx, None);
    para.shift_for_inline_control_insert(insert_idx, char_offset);
    para.char_count += 8;
    para.control_mask |= 1u32 << 11;
    para.has_para_text = true;
    insert_idx
}

impl DocumentCore {
    /// upstream `insert_equation_native` 와 같은 인라인 수식 컨트롤을 만든다.
    fn build_inline_equation(
        &self,
        section_idx: usize,
        script: &str,
        font_size: u32,
        color: u32,
    ) -> Result<Equation, HwpError> {
        use crate::model::shape::{CommonObjAttr, HorzRelTo, TextWrap, VertRelTo};
        use crate::parser::tags::CTRL_EQUATION;

        let (width, height) = crate::renderer::equation::intrinsic_size_hwp(script, font_size);
        let equation_order = self.document.sections[section_idx]
            .paragraphs
            .iter()
            .flat_map(|paragraph| paragraph.controls.iter())
            .filter(|control| matches!(control, Control::Equation(_)))
            .count() as u32;
        let equation_instance_order = self
            .document
            .sections
            .iter()
            .flat_map(|section| section.paragraphs.iter())
            .flat_map(|paragraph| paragraph.controls.iter())
            .filter(|control| matches!(control, Control::Equation(_)))
            .count();
        let equation_instance_sequence = u32::try_from(equation_instance_order)
            .ok()
            .and_then(|order| order.checked_add(1))
            .filter(|&order| order <= 0x03ff_ffff)
            .ok_or_else(|| err("수식 instance ID를 더 이상 배정할 수 없습니다."))?;
        Ok(Equation {
            common: CommonObjAttr {
                ctrl_id: CTRL_EQUATION,
                attr: 0x0C2A_2311,
                numbering_type: crate::model::shape::ObjectNumberingType::Equation,
                treat_as_char: true,
                width,
                height,
                z_order: equation_order as i32,
                margin: crate::model::Padding {
                    left: 56,
                    right: 56,
                    top: 0,
                    bottom: 0,
                },
                instance_id: 0x4400_0000 | equation_instance_sequence,
                flow_with_text: true,
                vert_rel_to: VertRelTo::Para,
                horz_rel_to: HorzRelTo::Para,
                text_wrap: TextWrap::TopAndBottom,
                description: "수식입니다.".to_string(),
                ..Default::default()
            },
            script: script.to_string(),
            font_size,
            color,
            baseline: 85,
            version_info: "Equation Version 60".to_string(),
            font_name: "HYhwpEQ".to_string(),
            ..Default::default()
        })
    }

    fn check_section(&self, section_idx: usize) -> Result<(), HwpError> {
        if section_idx >= self.document.sections.len() {
            return Err(err(format!("구역 인덱스 {} 범위 초과", section_idx)));
        }
        Ok(())
    }

    /// 깊이 1 셀 문단 변이 후 재조판.
    fn finish_cell_equation_edit(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
    ) -> Result<(), HwpError> {
        self.mark_cell_control_dirty(section_idx, parent_para_idx, control_idx);
        self.reflow_cell_paragraph(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        );
        self.recalculate_cell_paragraph_vpos_native(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
            None,
        );
        self.finish_equation_edit_common(section_idx, parent_para_idx, control_idx)
    }

    /// 중첩 셀 경로 문단 변이 후 재조판.
    fn finish_cell_equation_edit_by_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &[(usize, usize, usize)],
    ) -> Result<(), HwpError> {
        let cell_para_idx = path.last().map(|entry| entry.2).unwrap_or(0);
        let outer_control_idx = path[0].0;
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_control_idx);
        self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, path, cell_para_idx);
        self.recalculate_cell_paragraph_vpos_by_path(
            section_idx,
            parent_para_idx,
            path,
            cell_para_idx,
            None,
        );
        self.finish_equation_edit_common(section_idx, parent_para_idx, outer_control_idx)
    }

    fn finish_equation_edit_common(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        outer_control_idx: usize,
    ) -> Result<(), HwpError> {
        if matches!(
            self.document.sections[section_idx].paragraphs[parent_para_idx]
                .controls
                .get(outer_control_idx),
            Some(Control::Table(_))
        ) {
            self.mark_table_text_reflowed_after_cell_edit(
                section_idx,
                parent_para_idx,
                outer_control_idx,
            )?;
        }
        self.document.sections[section_idx].raw_stream = None;
        self.rebuild_derived_state();
        Ok(())
    }

    /// 표 셀 문단에 수식을 삽입한다. `char_offset` 은 개체를 세지 않는 텍스트 오프셋.
    /// 반환: JSON `{"ok":true,"cellParaIdx":N,"controlIdx":N}` (controlIdx 는 셀 문단 안 인덱스)
    #[allow(clippy::too_many_arguments)]
    pub fn insert_equation_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        char_offset: usize,
        script: &str,
        font_size: u32,
        color: u32,
    ) -> Result<String, HwpError> {
        self.check_section(section_idx)?;
        let equation = self.build_inline_equation(section_idx, script, font_size, color)?;
        let cell_para = self.get_cell_paragraph_mut(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        let insert_idx = insert_equation_control(cell_para, equation, char_offset);
        self.finish_cell_equation_edit(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        Ok(format!(
            "{{\"ok\":true,\"cellParaIdx\":{},\"controlIdx\":{}}}",
            cell_para_idx, insert_idx
        ))
    }

    /// 중첩 표 셀 문단에 수식을 삽입한다. 경로의 마지막 항목이 대상 문단이다.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_equation_in_cell_by_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        cell_path_json: &str,
        char_offset: usize,
        script: &str,
        font_size: u32,
        color: u32,
    ) -> Result<String, HwpError> {
        let path = Self::parse_cell_path(cell_path_json)?;
        if path.is_empty() {
            return Err(err("셀 경로가 비어 있습니다"));
        }
        if path.len() == 1 {
            let (control_idx, cell_idx, cell_para_idx) = path[0];
            return self.insert_equation_in_cell_native(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                char_offset,
                script,
                font_size,
                color,
            );
        }
        self.check_section(section_idx)?;
        let equation = self.build_inline_equation(section_idx, script, font_size, color)?;
        let insert_idx = {
            let section = &mut self.document.sections[section_idx];
            let paragraph = Self::resolve_cell_paragraph_mut(section, parent_para_idx, &path)?;
            insert_equation_control(paragraph, equation, char_offset)
        };
        self.finish_cell_equation_edit_by_path(section_idx, parent_para_idx, &path)?;
        Ok(format!(
            "{{\"ok\":true,\"cellParaIdx\":{},\"controlIdx\":{}}}",
            path.last().map(|entry| entry.2).unwrap_or(0),
            insert_idx
        ))
    }

    /// 표 셀 문단에서 수식 컨트롤을 삭제한다 (insert 의 역연산). 반환: `{"ok":true}`
    pub fn delete_equation_control_in_cell_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        eq_control_idx: usize,
    ) -> Result<String, HwpError> {
        let cell_para = self.get_cell_paragraph_mut(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        equation_at(cell_para, eq_control_idx)?;
        cell_para.remove_control(eq_control_idx);
        self.finish_cell_equation_edit(
            section_idx,
            parent_para_idx,
            control_idx,
            cell_idx,
            cell_para_idx,
        )?;
        Ok(crate::document_core::helpers::json_ok())
    }

    pub fn delete_equation_control_in_cell_by_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        cell_path_json: &str,
        eq_control_idx: usize,
    ) -> Result<String, HwpError> {
        let path = Self::parse_cell_path(cell_path_json)?;
        if path.is_empty() {
            return Err(err("셀 경로가 비어 있습니다"));
        }
        if path.len() == 1 {
            let (control_idx, cell_idx, cell_para_idx) = path[0];
            return self.delete_equation_control_in_cell_native(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
                eq_control_idx,
            );
        }
        self.check_section(section_idx)?;
        {
            let section = &mut self.document.sections[section_idx];
            let paragraph = Self::resolve_cell_paragraph_mut(section, parent_para_idx, &path)?;
            equation_at(paragraph, eq_control_idx)?;
            paragraph.remove_control(eq_control_idx);
        }
        self.finish_cell_equation_edit_by_path(section_idx, parent_para_idx, &path)?;
        Ok(crate::document_core::helpers::json_ok())
    }

    /// 표 셀 문단의 지정 인덱스 수식 스크립트. 반환: `{"ok":true,"script":"..."}`
    pub fn get_equation_script_in_cell_at(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: usize,
        cell_para_idx: usize,
        eq_control_idx: usize,
    ) -> Result<String, HwpError> {
        let para = self
            .get_cell_paragraph_ref(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            )
            .ok_or_else(|| err("셀 문단 접근 실패"))?;
        let eq = equation_at(para, eq_control_idx)?;
        Ok(format!(
            "{{\"ok\":true,\"script\":\"{}\"}}",
            crate::document_core::helpers::json_escape(&eq.script)
        ))
    }

    /// 수식 속성 조회. `cell_idx`/`cell_para_idx` 가 있으면 표 셀 문단, 없으면 본문 컨트롤.
    /// `inner_control_idx` 가 있으면 셀 문단 안 그 인덱스의 수식, 없으면 첫 수식.
    pub fn get_equation_properties_at_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: Option<usize>,
        cell_para_idx: Option<usize>,
        inner_control_idx: Option<usize>,
    ) -> Result<String, HwpError> {
        let (Some(cell), Some(cell_para), Some(inner)) =
            (cell_idx, cell_para_idx, inner_control_idx)
        else {
            return self.get_equation_properties_native(
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            );
        };
        let para = self
            .get_cell_paragraph_ref(section_idx, parent_para_idx, control_idx, cell, cell_para)
            .ok_or_else(|| err("셀 문단 접근 실패"))?;
        Ok(Self::equation_properties_json(equation_at(para, inner)?))
    }

    /// 중첩 표 셀 문단의 정확한 수식 컨트롤 속성.
    pub fn get_equation_properties_by_path_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        cell_path_json: &str,
        inner_control_idx: usize,
    ) -> Result<String, HwpError> {
        let path = Self::parse_cell_path(cell_path_json)?;
        let para = self.resolve_paragraph_by_path(section_idx, parent_para_idx, &path)?;
        Ok(Self::equation_properties_json(equation_at(
            para,
            inner_control_idx,
        )?))
    }
}

#[cfg(test)]
mod tests {
    use crate::document_core::DocumentCore;

    fn table_document() -> (DocumentCore, usize, usize) {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().expect("blank document");
        let created = core
            .create_table_native(0, 0, 0, 2, 2)
            .expect("create table");
        assert!(created.contains("\"ok\":true"), "{created}");
        let (para, ci) = core.document.sections[0]
            .paragraphs
            .iter()
            .enumerate()
            .find_map(|(pi, p)| {
                p.controls
                    .iter()
                    .position(|c| matches!(c, crate::model::control::Control::Table(_)))
                    .map(|ci| (pi, ci))
            })
            .expect("table paragraph");
        (core, para, ci)
    }

    #[test]
    fn cell_equation_insert_read_delete_round_trip() {
        let (mut core, para, ci) = table_document();
        core.insert_text_in_cell_native(0, para, ci, 0, 0, 0, "ab")
            .expect("cell text");
        let digest_before = core.paragraph_content_digest_native(0, para).unwrap();

        let inserted = core
            .insert_equation_in_cell_native(0, para, ci, 0, 0, 1, "x^2", 1000, 0)
            .expect("insert equation in cell");
        assert!(inserted.contains("\"controlIdx\":0"), "{inserted}");
        let script = core
            .get_equation_script_in_cell_at(0, para, ci, 0, 0, 0)
            .unwrap();
        assert!(script.contains("x^2"), "{script}");
        let props = core
            .get_equation_properties_at_native(0, para, ci, Some(0), Some(0), Some(0))
            .unwrap();
        assert!(props.contains("x^2"), "{props}");
        let by_path = core
            .get_equation_properties_by_path_native(
                0,
                para,
                &format!(r#"[{{"controlIndex":{ci},"cellIndex":0,"cellParaIndex":0}}]"#),
                0,
            )
            .unwrap();
        assert_eq!(props, by_path);
        // 텍스트 오프셋 계약: 개체는 글자 수에 들지 않는다.
        let text = core
            .get_text_in_cell_native(0, para, ci, 0, 0, 0, 2)
            .unwrap();
        assert!(text.contains("ab"), "{text}");

        core.delete_equation_control_in_cell_native(0, para, ci, 0, 0, 0)
            .expect("delete equation");
        assert!(core
            .get_equation_script_in_cell_at(0, para, ci, 0, 0, 0)
            .is_err());
        assert_eq!(
            core.paragraph_content_digest_native(0, para).unwrap(),
            digest_before,
            "삽입 후 삭제는 문단 내용을 되돌린다"
        );
    }
}
