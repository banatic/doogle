// Ported from banatic/rhwp-x (MIT) rhwp/src/document_core/commands/object_ops/mod.rs,
// commands/object_ops/shape.rs (change_object_z_order_native)
//! 최상위 floating 개체(도형/그림/표/수식)의 공통 z-order 변경.
//! upstream 에는 도형 전용 `change_shape_z_order_native` 만 있다.

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::document::Section;

/// 페이지 레이어 순서에 참여하는 최상위 개체 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayerOrderKind {
    Shape,
    Picture,
    Table,
    Equation,
}

/// 구역 안 최상위 floating 개체의 공통 레이어 정렬 항목.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LayerOrderEntry {
    pub z_order: i32,
    pub para_idx: usize,
    pub control_idx: usize,
    pub kind: LayerOrderKind,
}
fn layer_order_entries(section: &Section) -> Vec<LayerOrderEntry> {
    section
        .paragraphs
        .iter()
        .enumerate()
        .flat_map(|(para_idx, para)| {
            para.controls
                .iter()
                .enumerate()
                .filter_map(move |(control_idx, control)| match control {
                    Control::Shape(shape) => Some(LayerOrderEntry {
                        z_order: shape.z_order(),
                        para_idx,
                        control_idx,
                        kind: LayerOrderKind::Shape,
                    }),
                    Control::Picture(picture) => Some(LayerOrderEntry {
                        z_order: picture.common.z_order,
                        para_idx,
                        control_idx,
                        kind: LayerOrderKind::Picture,
                    }),
                    Control::Table(table) if !table.common.treat_as_char => Some(LayerOrderEntry {
                        z_order: table.common.z_order,
                        para_idx,
                        control_idx,
                        kind: LayerOrderKind::Table,
                    }),
                    Control::Equation(equation) if !equation.common.treat_as_char => {
                        Some(LayerOrderEntry {
                            z_order: equation.common.z_order,
                            para_idx,
                            control_idx,
                            kind: LayerOrderKind::Equation,
                        })
                    }
                    _ => None,
                })
        })
        .collect()
}
fn set_layer_z_order(section: &mut Section, entry: LayerOrderEntry, z_order: i32) -> bool {
    let Some(control) = section
        .paragraphs
        .get_mut(entry.para_idx)
        .and_then(|para| para.controls.get_mut(entry.control_idx))
    else {
        return false;
    };
    match (entry.kind, control) {
        (LayerOrderKind::Shape, Control::Shape(shape)) => {
            shape.common_mut().z_order = z_order;
            true
        }
        (LayerOrderKind::Picture, Control::Picture(picture)) => {
            picture.common.z_order = z_order;
            true
        }
        (LayerOrderKind::Table, Control::Table(table)) if !table.common.treat_as_char => {
            table.common.z_order = z_order;
            true
        }
        (LayerOrderKind::Equation, Control::Equation(equation))
            if !equation.common.treat_as_char =>
        {
            equation.common.z_order = z_order;
            true
        }
        _ => false,
    }
}

impl DocumentCore {
    /// 최상위 floating 개체의 z-order 변경 (네이티브).
    /// operation: "front" | "back" | "forward" | "backward"
    pub fn change_object_z_order_native(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        operation: &str,
    ) -> Result<String, HwpError> {
        let section = self.document.sections.get(section_idx).ok_or_else(|| {
            HwpError::RenderError(format!("구역 인덱스 {} 범위 초과", section_idx))
        })?;

        // 렌더 안정 순서와 같은 (z_order, paragraph, control) 키를 사용한다.
        let mut entries = layer_order_entries(section);
        entries.sort_by_key(|entry| (entry.z_order, entry.para_idx, entry.control_idx));

        let target_pos = entries
            .iter()
            .position(|entry| entry.para_idx == para_idx && entry.control_idx == control_idx)
            .ok_or_else(|| {
                HwpError::RenderError("대상 최상위 floating 개체를 찾을 수 없습니다".to_string())
            })?;
        let target = entries[target_pos];
        let current_z = target.z_order;
        let last_pos = entries.len() - 1;

        // (대상 새 z_order, 이웃 변경 정보 Option<(entry, 새 z_order)>)
        let changes: Option<(i32, Option<(LayerOrderEntry, i32)>)> = match operation {
            "front" => {
                if target_pos == last_pos {
                    None // 이미 맨 앞
                } else {
                    let max_z = entries[last_pos].z_order;
                    Some((max_z.saturating_add(1), None))
                }
            }
            "back" => {
                if target_pos == 0 {
                    None // 이미 맨 뒤
                } else {
                    let min_z = entries[0].z_order;
                    Some((min_z.saturating_sub(1), None))
                }
            }
            "forward" => {
                if target_pos >= last_pos {
                    None // 이미 맨 앞
                } else {
                    let neighbor = entries[target_pos + 1];
                    if current_z == neighbor.z_order {
                        // 같은 z_order — 대상만 +1하여 이웃 위로 이동
                        Some((current_z.saturating_add(1), None))
                    } else {
                        // 다른 z_order — 이웃과 z_order 교환
                        Some((neighbor.z_order, Some((neighbor, current_z))))
                    }
                }
            }
            "backward" => {
                if target_pos == 0 {
                    None // 이미 맨 뒤
                } else {
                    let neighbor = entries[target_pos - 1];
                    if current_z == neighbor.z_order {
                        // 같은 z_order — 대상만 -1하여 이웃 아래로 이동
                        Some((current_z.saturating_sub(1), None))
                    } else {
                        // 다른 z_order — 이웃과 z_order 교환
                        Some((neighbor.z_order, Some((neighbor, current_z))))
                    }
                }
            }
            _ => {
                return Err(HwpError::RenderError(format!(
                    "알 수 없는 operation: {}",
                    operation
                )))
            }
        };

        let (new_z, neighbor_change) = match changes {
            Some(c) => c,
            None => {
                return Ok(crate::document_core::helpers::json_ok_with(&format!(
                    "\"zOrder\":{}",
                    current_z
                )))
            }
        };
        let neighbor_para_idx = neighbor_change
            .as_ref()
            .map(|(neighbor, _)| neighbor.para_idx);

        // z_order 변경: 대상 + 이웃
        {
            let section = &mut self.document.sections[section_idx];
            if !set_layer_z_order(section, target, new_z) {
                return Err(HwpError::RenderError(
                    "대상 최상위 floating 개체의 종류가 변경되었습니다".to_string(),
                ));
            }
            if let Some((neighbor, neighbor_z)) = neighbor_change {
                if !set_layer_z_order(section, neighbor, neighbor_z) {
                    return Err(HwpError::RenderError(
                        "이웃 최상위 floating 개체의 종류가 변경되었습니다".to_string(),
                    ));
                }
            }
        }

        // doogle: rx 는 event_log.mark_paragraph_changed 로 문단 revision 을 올린다.
        // upstream 스냅샷 복원은 문서 전체를 다시 만들므로 구역 dirty 표시로 충분하다.
        let _ = neighbor_para_idx;
        self.mark_section_dirty(section_idx);
        self.document.sections[section_idx].raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();

        Ok(crate::document_core::helpers::json_ok_with(&format!(
            "\"zOrder\":{}",
            new_z
        )))
    }
}
