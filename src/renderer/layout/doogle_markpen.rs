//! [두글] HWPX 형광펜(`<hp:markpenBegin/End>`)을 그릴 범위로 바꾼다.
//!
//! HWPX 파서는 형광펜을 `Paragraph::markpen_marks` 에만 싣고 `range_tags` 는 비워 둔다.
//! 그리기는 `range_tags`(종류 2)만 읽어 HWPX 문서의 형광펜이 통째로 빠졌다.
//! 표지가 있으면 표지의 **글자 색인**으로 범위를 만든다(그리기 쪽 비교 축과 같다).

use crate::model::paragraph::{Paragraph, RangeTag};

/// 형광펜 범위. `start`/`end` 는 문단 글자 색인, `tag` 는 `0x02BBGGRR`.
pub(crate) fn markpen_char_ranges(para: &Paragraph) -> Vec<RangeTag> {
    if para.markpen_marks.is_empty() {
        return para
            .range_tags
            .iter()
            .filter(|r| (r.tag >> 24) & 0xFF == 2)
            .cloned()
            .collect();
    }
    let mut ranges = Vec::new();
    let mut open: Vec<(usize, Option<u32>)> = Vec::new();
    for mark in &para.markpen_marks {
        if let Some(color) = &mark.color {
            let rgb = color
                .strip_prefix('#')
                .filter(|s| s.len() == 6)
                .and_then(|s| u32::from_str_radix(s, 16).ok());
            open.push((mark.char_idx, rgb));
        } else if let Some((start, Some(rgb))) = open.pop() {
            if mark.char_idx > start {
                let bgr = ((rgb & 255) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 255);
                ranges.push(RangeTag {
                    start: start as u32,
                    end: mark.char_idx as u32,
                    tag: 0x0200_0000 | bgr,
                });
            }
        }
    }
    ranges
}
