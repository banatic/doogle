//! [두글] 글이 있는 문단에 걸린 문단 기준 자리차지 표의 위끝을 저장 줄 사다리로 바로잡는다.
//!
//! 조판(typeset)이 확정해 넘기는 표 위끝은 조판 자신의 누적 높이 좌표다. 배치(layout)는
//! 글줄을 저장 `vertpos` 에 맞춰 그리므로, 두 좌표가 어긋나면 표만 위로 떠서 host 글줄과
//! 앞 문단을 덮는다(시험지: 문제 줄 + `[2.8점]` 문단에 걸린 보기 상자가 문제 줄 위로 29px).
//!
//! 한/글 저장값은 `표 바깥 상자 위끝 = 앵커 제어 문자가 실린 줄의 위끝 + vertOffset` 이다.
//! 다음 문단의 저장 `vertpos` 가 그 등식(+ 바깥여백 + 표 높이)을 그대로 증언할 때만 쓴다.

use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::shape::{TextWrap, VertAlign, VertRelTo};
use crate::model::table::Table;
use crate::renderer::float_placement::signed_hwpunit;

/// 저장 사다리와 다음 문단 시작이 허용하는 오차(HWPUNIT).
const LADDER_TOLERANCE_HU: i64 = 8;

/// host 문단 위끝에서 표 **괘선 위끝**까지의 거리(HWPUNIT). 증거가 없으면 `None`.
pub(crate) fn proven_host_float_border_top_hu(
    para: &Paragraph,
    control_index: usize,
    table: &Table,
    next_para: Option<&Paragraph>,
) -> Option<i32> {
    let common = &table.common;
    if common.treat_as_char
        || !matches!(common.text_wrap, TextWrap::TopAndBottom)
        || !matches!(common.vert_rel_to, VertRelTo::Para)
        || !matches!(common.vert_align, VertAlign::Top)
        || table.caption.is_some()
    {
        return None;
    }
    let offset = i64::from(signed_hwpunit(common.vertical_offset));
    if offset <= 0 || para.text.trim().is_empty() {
        return None;
    }
    let stored = |seg: &LineSeg| seg.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY == 0;
    let first = para.line_segs.first()?;
    let mut prev = first.vertical_pos;
    for seg in &para.line_segs {
        if !stored(seg) || seg.vertical_pos < prev {
            return None;
        }
        prev = seg.vertical_pos;
    }
    let anchor_line = para
        .line_segs
        .get(super::control_line_seg_index(para, control_index)?)?;
    let outer_top = i64::from(anchor_line.vertical_pos) - i64::from(first.vertical_pos) + offset;
    let border_top = outer_top + i64::from(table.outer_margin_top);
    let next = next_para?.line_segs.first().filter(|seg| stored(seg))?;
    let expected_next =
        border_top + i64::from(common.height) + i64::from(table.outer_margin_bottom);
    let actual_next = i64::from(next.vertical_pos) - i64::from(first.vertical_pos);
    ((actual_next - expected_next).abs() <= LADDER_TOLERANCE_HU)
        .then(|| i32::try_from(border_top).ok())
        .flatten()
}
