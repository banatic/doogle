//! 다단 설정의 적용 범위 — 한/글 [쪽-다단 설정] 대화상자의 "적용 범위".
//!
//! 단 정의(`ColumnDef`)는 구역 정의와 달리 문단 컨트롤이다. 한 구역 안에 여러 개가 올 수 있고,
//! 단 정의를 지닌 문단은 문단 머리 나누기 바이트에 다단 나누기(0x02)를 적어 "여기서부터 새
//! 다단"임을 나타낸다. 조판(`process_multicolumn_break`)은 그 문단에서 단 영역(zone)을 새로
//! 연다. 그래서 표지는 1단, 본문은 2단처럼 한 구역 안에서 단 수를 바꿀 수 있다.
//!
//! 적용 범위:
//! - 현재 다단(`Current`): 캐럿 문단에 걸린(그 문단 이하의 마지막) 단 정의를 고친다.
//! - 새 다단으로(`New`): 캐럿 자리에 다단 나누기를 넣고 새 단 정의를 둔다. 앞 글은 옛 단 모양을,
//!   뒤 글은 새 단 모양을 따른다. 문단 처음이면 그 문단부터, 비어 있지 않은 문단의 끝이면 다음
//!   문단부터, 문단 가운데면 문단을 나눠 뒤 문단부터 새 다단이다.
//! - 현재 구역(`Section`): 구역 안 모든 단 정의를 고친다.
//! - 문서 전체(`Document`): 모든 구역의 모든 단 정의를 고친다.

use super::super::helpers::{json_ok_with, logical_paragraph_length};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::page::{ColumnDef, ColumnDirection, ColumnType};
use crate::model::paragraph::{ColumnBreakType, Paragraph};
use crate::renderer::composer::{reflow_line_segs, ParagraphBox};
use crate::renderer::page_layout::PageLayoutInfo;

/// 다단 설정의 적용 범위 (wasm 인자 `scope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnApplyScope {
    /// 0 — 캐럿 자리의 현재 다단.
    Current,
    /// 1 — 캐럿 자리에서 새 다단으로.
    New,
    /// 2 — 현재 구역 전체.
    Section,
    /// 3 — 문서 전체.
    Document,
}

impl ColumnApplyScope {
    pub fn from_u8(value: u8) -> Result<Self, HwpError> {
        match value {
            0 => Ok(Self::Current),
            1 => Ok(Self::New),
            2 => Ok(Self::Section),
            3 => Ok(Self::Document),
            _ => Err(HwpError::RenderError(format!(
                "다단 적용 범위 {} 은(는) 알 수 없습니다 (0=현재 다단, 1=새 다단으로, 2=현재 구역, 3=문서 전체)",
                value
            ))),
        }
    }
}

/// 대화상자가 고치는 단 모양 필드.
#[derive(Debug, Clone, Copy)]
pub struct ColumnSettings {
    pub column_count: u16,
    /// 0=일반, 1=배분, 2=평행
    pub column_type: u8,
    pub same_width: bool,
    /// 단 간격 (HWPUNIT)
    pub spacing: i16,
}

impl ColumnSettings {
    fn apply_to(&self, cd: &mut ColumnDef) {
        cd.column_count = self.column_count.max(1);
        cd.column_type = match self.column_type {
            1 => ColumnType::Distribute,
            2 => ColumnType::Parallel,
            _ => ColumnType::Normal,
        };
        cd.same_width = self.same_width;
        cd.spacing = self.spacing;
        // [#7523] HWP 저장은 raw_attr 가 있으면 그 값을 쓴다 — 비워서 바꾼 필드로 속성을 다시
        // 만들게 한다. 옛 단 수의 단별 너비도 새 단에 맞지 않는다.
        cd.raw_attr = 0;
        if self.same_width || cd.widths.len() != cd.column_count as usize {
            cd.widths.clear();
            cd.gaps.clear();
        }
    }

    fn new_def(&self) -> ColumnDef {
        let mut cd = ColumnDef {
            direction: ColumnDirection::LeftToRight,
            ..ColumnDef::default()
        };
        self.apply_to(&mut cd);
        cd
    }
}

/// `SectionDef`·`ColumnDef` 제어 문자(코드 2)의 control mask 비트.
const SECTION_COLUMN_DEF_MASK: u32 = 1 << 0x0002;
const EXTENDED_CONTROL_UNITS: u32 = 8;
/// 문단 머리 나누기 바이트의 다단 나누기 비트.
const MULTI_COLUMN_BREAK_BIT: u8 = 0x02;

impl DocumentCore {
    /// 캐럿 문단에 적용되는 단 정의를 JSON 으로 돌려준다(`getColumnDef`와 같은 모양).
    /// `zoneStart`는 그 단 정의를 지닌 문단(없으면 -1)이다.
    pub fn get_column_def_at_native(
        &self,
        section_idx: usize,
        para_idx: usize,
    ) -> Result<String, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;
        let para_idx = para_idx.min(section.paragraphs.len().saturating_sub(1));
        let zone = zone_start(&section.paragraphs, para_idx);
        let cd = Self::find_column_def_for_paragraph(&section.paragraphs, para_idx);
        let col_type = match cd.column_type {
            ColumnType::Normal => 0,
            ColumnType::Distribute => 1,
            ColumnType::Parallel => 2,
        };
        let zone_count = section
            .paragraphs
            .iter()
            .filter(|p| p.controls.iter().any(|c| matches!(c, Control::ColumnDef(_))))
            .count();
        Ok(format!(
            "{{\"columnCount\":{},\"columnType\":{},\"sameWidth\":{},\"spacing\":{},\"zoneStart\":{},\"zoneCount\":{}}}",
            cd.column_count,
            col_type,
            cd.same_width,
            cd.spacing,
            zone.map(|z| z as i64).unwrap_or(-1),
            zone_count
        ))
    }

    /// 적용 범위를 두고 단 모양을 바꾼다. 돌려주는 `section`·`para`·`charOffset`은 바꾼 뒤의
    /// 캐럿 자리다(새 다단으로이면 새 다단의 처음).
    pub fn apply_column_def_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
        scope: ColumnApplyScope,
        settings: ColumnSettings,
    ) -> Result<String, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!(
                "구역 인덱스 {} 범위 초과 (총 {}개)",
                section_idx,
                self.document.sections.len()
            ))
        })?;
        if para_idx >= section.paragraphs.len() {
            return Err(HwpError::RenderError(format!(
                "문단 인덱스 {} 범위 초과 (총 {}개)",
                para_idx,
                section.paragraphs.len()
            )));
        }

        let caret = match scope {
            ColumnApplyScope::Current => {
                let widths = self.paragraph_wrap_widths(section_idx);
                self.update_current_zone(section_idx, para_idx, settings);
                self.finish_column_change(section_idx, &widths);
                (section_idx, para_idx, char_offset)
            }
            ColumnApplyScope::Section => {
                let widths = self.paragraph_wrap_widths(section_idx);
                self.update_all_zones(section_idx, settings);
                self.finish_column_change(section_idx, &widths);
                (section_idx, para_idx, char_offset)
            }
            ColumnApplyScope::Document => {
                let widths: Vec<_> = (0..self.document.sections.len())
                    .map(|s| self.paragraph_wrap_widths(s))
                    .collect();
                for s in 0..self.document.sections.len() {
                    self.update_all_zones(s, settings);
                }
                for (s, before) in widths.iter().enumerate() {
                    self.finish_column_change(s, before);
                }
                (section_idx, para_idx, char_offset)
            }
            ColumnApplyScope::New => {
                let target = self.prepare_new_zone_paragraph(section_idx, para_idx, char_offset)?;
                let widths = self.paragraph_wrap_widths(section_idx);
                self.start_zone_at(section_idx, target, settings);
                self.finish_column_change(section_idx, &widths);
                (section_idx, target, 0)
            }
        };

        Ok(json_ok_with(&format!(
            "\"section\":{},\"para\":{},\"charOffset\":{}",
            caret.0, caret.1, caret.2
        )))
    }

    /// 캐럿 문단에 걸린 단 정의를 고친다. 단 정의가 없는 구역은 첫 문단에 새로 둔다.
    fn update_current_zone(&mut self, section_idx: usize, para_idx: usize, settings: ColumnSettings) {
        let paragraphs = &mut self.document.sections[section_idx].paragraphs;
        match zone_start(paragraphs, para_idx) {
            Some(zone) => {
                // 한 문단의 단 정의가 여럿이면 마지막 것이 그 뒤를 다스린다.
                if let Some(Control::ColumnDef(cd)) = paragraphs[zone]
                    .controls
                    .iter_mut()
                    .rev()
                    .find(|c| matches!(c, Control::ColumnDef(_)))
                {
                    settings.apply_to(cd);
                }
            }
            None => insert_zone_def(&mut paragraphs[0], settings.new_def()),
        }
    }

    /// 구역 안 모든 단 정의를 고친다. 단 정의가 없는 구역은 첫 문단에 새로 둔다.
    fn update_all_zones(&mut self, section_idx: usize, settings: ColumnSettings) {
        let paragraphs = &mut self.document.sections[section_idx].paragraphs;
        let mut found = false;
        for para in paragraphs.iter_mut() {
            for ctrl in para.controls.iter_mut() {
                if let Control::ColumnDef(cd) = ctrl {
                    settings.apply_to(cd);
                    found = true;
                }
            }
        }
        if !found {
            if let Some(first) = paragraphs.first_mut() {
                insert_zone_def(first, settings.new_def());
            }
        }
    }

    /// 새 다단을 시작할 문단을 정한다(필요하면 문단을 나눈다).
    fn prepare_new_zone_paragraph(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        char_offset: usize,
    ) -> Result<usize, HwpError> {
        let paragraphs = &self.document.sections[section_idx].paragraphs;
        let para = &paragraphs[para_idx];
        let length = logical_paragraph_length(para);
        let char_offset = char_offset.min(length);
        let last = para_idx + 1 == paragraphs.len();
        if char_offset == 0 {
            return Ok(para_idx);
        }
        if char_offset == length && !last {
            return Ok(para_idx + 1);
        }
        self.split_paragraph_native(section_idx, para_idx, char_offset, None)?;
        Ok(para_idx + 1)
    }

    /// `target` 문단에서 새 단 영역을 연다. 이미 단 정의를 지닌 문단이면 그 정의를 고친다.
    fn start_zone_at(&mut self, section_idx: usize, target: usize, settings: ColumnSettings) {
        let paragraphs = &mut self.document.sections[section_idx].paragraphs;
        // 새 단 정의는 앞 다단의 구분선 등 나머지 모양을 잇는다.
        let mut inherited = Self::find_column_def_for_paragraph(paragraphs, target);
        let para = &mut paragraphs[target];
        if let Some(Control::ColumnDef(cd)) = para
            .controls
            .iter_mut()
            .rev()
            .find(|c| matches!(c, Control::ColumnDef(_)))
        {
            settings.apply_to(cd);
        } else {
            if inherited.column_count == 0 {
                inherited = settings.new_def();
            }
            settings.apply_to(&mut inherited);
            insert_zone_def(para, inherited);
        }
        if target == 0 {
            // 구역 첫 문단은 구역 정의와 함께 이미 단 영역의 시작이다.
            para.invalidate_layout_inputs();
            return;
        }
        // 나누기 enum 만 지닌 옛 IR 은 raw 비트로 옮겨 둔다 — raw 가 있으면 저장은 raw 를 쓴다.
        if para.raw_break_type == 0 {
            para.raw_break_type = match para.column_type {
                ColumnBreakType::Section => 0x01,
                ColumnBreakType::Page if !para.page_break_synthesized => 0x04,
                ColumnBreakType::Column => 0x08,
                _ => 0,
            };
        }
        para.raw_break_type |= MULTI_COLUMN_BREAK_BIT;
        if para.column_type == ColumnBreakType::None
            || (para.column_type == ColumnBreakType::Page && para.page_break_synthesized)
        {
            para.column_type = ColumnBreakType::MultiColumn;
            para.page_break_synthesized = false;
        }
        para.invalidate_layout_inputs();
    }

    /// 구역 문단마다 줄을 접는 폭(px) — 그 문단에 걸린 단 정의의 첫 단 폭.
    fn paragraph_wrap_widths(&self, section_idx: usize) -> Vec<f64> {
        let Some(section) = self.document.sections.get(section_idx) else {
            return Vec::new();
        };
        let page_def = &section.section_def.page_def;
        let mut current = ColumnDef::default();
        let mut cached: Option<f64> = None;
        let mut widths = Vec::with_capacity(section.paragraphs.len());
        for para in &section.paragraphs {
            for ctrl in &para.controls {
                if let Control::ColumnDef(cd) = ctrl {
                    current = cd.clone();
                    cached = None;
                }
            }
            let width = *cached.get_or_insert_with(|| {
                let layout = PageLayoutInfo::from_page_def(page_def, &current, self.dpi);
                layout
                    .column_areas
                    .first()
                    .map(|a| a.width)
                    .unwrap_or(layout.body_area.width)
            });
            widths.push(width);
        }
        widths
    }

    /// 접는 폭이 바뀐 문단만 다시 접고 구역을 다시 조판한다.
    fn finish_column_change(&mut self, section_idx: usize, before: &[f64]) {
        let after = self.paragraph_wrap_widths(section_idx);
        let changed: Vec<usize> = after
            .iter()
            .enumerate()
            .filter(|(i, w)| before.get(*i).map_or(true, |b| (*b - **w).abs() > f64::EPSILON))
            .map(|(i, _)| i)
            .collect();
        if !changed.is_empty() {
            let styles = self.resolve_render_styles();
            let dpi = self.dpi;
            {
                let section = &mut self.document.sections[section_idx];
                for &i in &changed {
                    let para = &mut section.paragraphs[i];
                    let paragraph_box = ParagraphBox::body_for_style(
                        after[i],
                        styles.para_styles.get(para.para_shape_id as usize),
                        dpi,
                    );
                    para.line_segs.clear();
                    reflow_line_segs(para, paragraph_box, &styles, dpi);
                }
            }
            for &i in &changed {
                self.fit_cell_grid(section_idx, i, &styles);
            }
        }
        self.document.sections[section_idx].raw_stream = None;
        self.rebuild_section(section_idx);
    }
}

/// `para_idx` 이하에서 단 정의를 지닌 마지막 문단.
fn zone_start(paragraphs: &[Paragraph], para_idx: usize) -> Option<usize> {
    paragraphs
        .iter()
        .take(para_idx + 1)
        .rposition(|p| p.controls.iter().any(|c| matches!(c, Control::ColumnDef(_))))
}

/// 문단 맨 앞 선행 정의(구역·단 정의) 뒤에 단 정의를 넣고 그 8유닛만큼 문단 좌표를 민다.
fn insert_zone_def(para: &mut Paragraph, cd: ColumnDef) {
    let at = para
        .controls
        .iter()
        .take_while(|c| matches!(c, Control::SectionDef(_) | Control::ColumnDef(_)))
        .count();
    para.shift_for_inline_control_insert(at, 0);
    para.controls.insert(at, Control::ColumnDef(cd));
    if para.ctrl_data_records.len() >= at && !para.ctrl_data_records.is_empty() {
        para.ctrl_data_records.insert(at, None);
    }
    para.char_count += EXTENDED_CONTROL_UNITS;
    para.control_mask |= SECTION_COLUMN_DEF_MASK;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer::pagination::PageItem;

    fn settings(count: u16) -> ColumnSettings {
        ColumnSettings {
            column_count: count,
            column_type: 0,
            same_width: true,
            spacing: 2268,
        }
    }

    /// 표지 1문단 + 본문 여러 문단.
    fn cover_and_body() -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().expect("blank document");
        core.insert_text_native(0, 0, 0, "표지 제목").expect("cover");
        let body = "본문 문장입니다. 다단으로 나뉘어 흐르는 글을 충분히 길게 씁니다. ".repeat(6);
        for i in 0..6 {
            let len = logical_paragraph_length(&core.document.sections[0].paragraphs[i]);
            core.split_paragraph_native(0, i, len, None).expect("split");
            core.insert_text_native(0, i + 1, 0, &body).expect("body");
        }
        core
    }

    fn zone_counts(core: &DocumentCore, section_idx: usize) -> Vec<(usize, usize)> {
        // (첫 문단, 단 수) — 쪽마다 단 영역별로 모은다.
        let mut out = Vec::new();
        for page in &core.pagination[section_idx].pages {
            for col in &page.column_contents {
                let count = col
                    .zone_layout
                    .as_ref()
                    .map(|z| z.column_areas.len())
                    .unwrap_or(page.layout.column_areas.len());
                if let Some(first) = col.items.first().map(PageItem::para_index) {
                    out.push((first, count));
                }
            }
        }
        out
    }

    fn column_defs(core: &DocumentCore, section_idx: usize) -> Vec<(usize, u16)> {
        core.document.sections[section_idx]
            .paragraphs
            .iter()
            .enumerate()
            .flat_map(|(i, p)| {
                p.controls.iter().filter_map(move |c| match c {
                    Control::ColumnDef(cd) => Some((i, cd.column_count)),
                    _ => None,
                })
            })
            .collect()
    }

    fn assert_cover_one_body_two(core: &DocumentCore) {
        let defs = column_defs(core, 0);
        assert_eq!(defs.len(), 2, "단 정의 둘: {defs:?}");
        assert_eq!(defs[0], (0, 1));
        assert_eq!(defs[1], (1, 2));
        let p1 = &core.document.sections[0].paragraphs[1];
        assert_eq!(p1.column_type, ColumnBreakType::MultiColumn);
        assert_ne!(p1.raw_break_type & 0x02, 0);
        let zones = zone_counts(core, 0);
        assert!(
            zones.iter().any(|(first, count)| *first == 0 && *count == 1),
            "표지는 1단: {zones:?}"
        );
        assert!(
            zones.iter().any(|(first, count)| *first >= 1 && *count == 2),
            "본문은 2단: {zones:?}"
        );
    }

    #[test]
    fn new_zone_at_paragraph_start_keeps_cover_single_column() {
        let mut core = cover_and_body();
        let out = core
            .apply_column_def_native(0, 1, 0, ColumnApplyScope::New, settings(2))
            .expect("new zone");
        assert!(out.contains("\"para\":1"), "{out}");
        assert_cover_one_body_two(&core);
        // 같은 쪽에 1단 영역과 2단 영역이 함께 놓인다.
        let page0 = &core.pagination[0].pages[0];
        let counts: Vec<_> = page0
            .column_contents
            .iter()
            .map(|c| c.zone_layout.as_ref().map(|z| z.column_areas.len()))
            .collect();
        assert!(counts.contains(&Some(2)), "첫 쪽에 2단 영역: {counts:?}");
    }

    #[test]
    fn new_zone_at_end_of_cover_starts_next_paragraph() {
        let mut core = cover_and_body();
        let len = logical_paragraph_length(&core.document.sections[0].paragraphs[0]);
        let before = core.document.sections[0].paragraphs.len();
        let out = core
            .apply_column_def_native(0, 0, len, ColumnApplyScope::New, settings(2))
            .expect("new zone");
        assert!(out.contains("\"para\":1"), "{out}");
        assert_eq!(core.document.sections[0].paragraphs.len(), before);
        assert_cover_one_body_two(&core);
    }

    #[test]
    fn new_zone_mid_paragraph_splits() {
        let mut core = cover_and_body();
        let before = core.document.sections[0].paragraphs.len();
        core.apply_column_def_native(0, 2, 5, ColumnApplyScope::New, settings(3))
            .expect("new zone");
        assert_eq!(core.document.sections[0].paragraphs.len(), before + 1);
        let defs = column_defs(&core, 0);
        assert_eq!(defs.last(), Some(&(3, 3)), "{defs:?}");
    }

    #[test]
    fn current_scope_edits_only_the_caret_zone() {
        let mut core = cover_and_body();
        core.apply_column_def_native(0, 1, 0, ColumnApplyScope::New, settings(2))
            .unwrap();
        core.apply_column_def_native(0, 3, 0, ColumnApplyScope::Current, settings(3))
            .unwrap();
        assert_eq!(column_defs(&core, 0), vec![(0, 1), (1, 3)]);
        core.apply_column_def_native(0, 0, 0, ColumnApplyScope::Current, settings(1))
            .unwrap();
        assert_eq!(column_defs(&core, 0), vec![(0, 1), (1, 3)]);
        let json = core.get_column_def_at_native(0, 4).unwrap();
        assert!(json.contains("\"columnCount\":3"), "{json}");
        assert!(json.contains("\"zoneStart\":1"), "{json}");
        core.apply_column_def_native(0, 4, 0, ColumnApplyScope::Document, settings(2))
            .unwrap();
        assert_eq!(column_defs(&core, 0), vec![(0, 2), (1, 2)]);
    }

    #[test]
    fn new_zone_round_trips_through_hwp_and_hwpx() {
        let mut core = cover_and_body();
        core.apply_column_def_native(0, 1, 0, ColumnApplyScope::New, settings(2))
            .unwrap();
        let pages = core.page_count();

        let hwp = core.export_hwp_native().expect("hwp export");
        let reloaded = DocumentCore::from_bytes(&hwp).expect("hwp reload");
        assert_cover_one_body_two(&reloaded);
        assert_eq!(reloaded.page_count(), pages, "HWP 쪽 수");

        let hwpx = core.export_hwpx_native().expect("hwpx export");
        let reloaded = DocumentCore::from_bytes(&hwpx).expect("hwpx reload");
        assert_cover_one_body_two(&reloaded);
        assert_eq!(reloaded.page_count(), pages, "HWPX 쪽 수");
    }
}
