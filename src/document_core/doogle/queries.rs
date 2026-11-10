// Ported from banatic/rhwp-x (MIT) rhwp/src/document_core/queries/rendering.rs,
// queries/cursor_nav.rs, commands/table_ops.rs, mod.rs
//! 에이전트 읽기 전용 질의: 전체 쪽 정보, 쪽 줄 배치, 개체 경계, 선택 안의 표, 글꼴 목록.

use crate::document_core::helpers::{find_logical_control_positions, navigable_text_len};
use crate::document_core::{helpers, DocumentCore};
use crate::error::HwpError;
use crate::model::control::Control;

impl DocumentCore {
    pub fn get_all_page_info_native(&self) -> Result<String, HwpError> {
        let page_count = self.page_count();
        let mut json = String::with_capacity(page_count as usize * 320);
        json.push('[');
        for page_num in 0..page_count {
            if page_num > 0 {
                json.push(',');
            }
            json.push_str(&self.get_page_info_native(page_num)?);
        }
        json.push(']');
        Ok(json)
    }

    /// 쪽의 줄 배치 요약 (네이티브 에러 타입) — 에이전트 `get_page_geometry` 용.
    ///
    /// `TextLine` 노드마다 줄 상자(x,y,w,h), 실제로 그려지는 베이스라인(`bl`),
    /// 잉크 x 범위(`tx0`/`tx1`), 문서 좌표와 그 줄 TextRun 의 `[x, w, cs, ce]` 를 모은다.
    /// `getPageTextLayout` 은 글자별 X 배열·서식까지 싣고 줄 경계·베이스라인이 없어
    /// 측정용으로는 무겁고 부족하다. 좌표는 쪽 기준 px, 문자 범위는 텍스트 오프셋이다.
    pub fn get_page_line_layout_native(&self, page_num: u32) -> Result<String, HwpError> {
        use crate::renderer::render_tree::{RenderNode, RenderNodeType, TextRunNode};

        let tree = self.build_page_tree_cached(page_num)?;

        // 줄 안의 TextRun — 안쪽 줄·표·글상자는 그쪽 TextLine 이 따로 수집한다.
        fn collect_runs<'a>(
            node: &'a RenderNode,
            out: &mut Vec<(&'a RenderNode, &'a TextRunNode)>,
        ) {
            for child in &node.children {
                match &child.node_type {
                    RenderNodeType::TextRun(run) => out.push((child, run)),
                    RenderNodeType::TextLine(_)
                    | RenderNodeType::Table(_)
                    | RenderNodeType::TextBox => {}
                    _ => collect_runs(child, out),
                }
            }
        }

        fn walk(node: &RenderNode, area: &'static str, lines: &mut Vec<String>) {
            let area = match node.node_type {
                RenderNodeType::Header => "header",
                RenderNodeType::Footer => "footer",
                RenderNodeType::FootnoteArea => "note",
                RenderNodeType::MasterPage => "master",
                _ => area,
            };
            if let RenderNodeType::TextLine(line) = &node.node_type {
                let mut runs = Vec::new();
                collect_runs(node, &mut runs);
                let mut sec = line.section_index;
                let mut para = line.para_index;
                let mut cell = String::new();
                let mut baseline: Option<f64> = None;
                let (mut cs, mut ce): (Option<usize>, usize) = (None, 0);
                let (mut tx0, mut tx1) = (f64::INFINITY, f64::NEG_INFINITY);
                let mut run_items = Vec::new();
                for (run_node, run) in &runs {
                    let len = run.text.chars().count();
                    if len > 0 {
                        tx0 = tx0.min(run_node.bbox.x);
                        tx1 = tx1.max(run_node.bbox.x + run_node.bbox.width);
                        if baseline.is_none() {
                            baseline = Some(run_node.bbox.y + run.baseline);
                        }
                    }
                    let Some(start) = run.char_start else {
                        continue;
                    };
                    if cs.is_none() {
                        sec = run.section_index.or(sec);
                        para = run.para_index.or(para);
                        if let Some(ctx) = &run.cell_context {
                            let path: Vec<String> = ctx
                                .path
                                .iter()
                                .map(|e| {
                                    format!(
                                        "[{},{},{}]",
                                        e.control_index, e.cell_index, e.cell_para_index
                                    )
                                })
                                .collect();
                            cell = format!(
                                ",\"cell\":{{\"pp\":{},\"path\":[{}]}}",
                                ctx.parent_para_index,
                                path.join(",")
                            );
                        }
                    }
                    cs = Some(cs.map_or(start, |v| v.min(start)));
                    ce = ce.max(start + len);
                    if len > 0 {
                        run_items.push(format!(
                            "[{:.1},{:.1},{},{}]",
                            run_node.bbox.x,
                            run_node.bbox.width,
                            start,
                            start + len
                        ));
                    }
                }
                let b = &node.bbox;
                let doc = match (sec, para) {
                    (Some(s), Some(p)) => format!(",\"sec\":{},\"para\":{}", s, p),
                    _ => String::new(),
                };
                let range = cs.map_or_else(String::new, |s| format!(",\"cs\":{},\"ce\":{}", s, ce));
                let ink = if tx0.is_finite() {
                    format!(",\"tx0\":{:.1},\"tx1\":{:.1}", tx0, tx1)
                } else {
                    String::new()
                };
                let area_str = if area.is_empty() {
                    String::new()
                } else {
                    format!(",\"area\":\"{}\"", area)
                };
                lines.push(format!(
                    "{{\"x\":{:.1},\"y\":{:.1},\"w\":{:.1},\"h\":{:.1},\"bl\":{:.1}{}{}{}{}{},\"runs\":[{}]}}",
                    b.x,
                    b.y,
                    b.width,
                    b.height,
                    baseline.unwrap_or(b.y + line.baseline),
                    doc,
                    range,
                    ink,
                    area_str,
                    cell,
                    run_items.join(",")
                ));
            }
            for child in &node.children {
                walk(child, area, lines);
            }
        }

        let mut lines = Vec::new();
        walk(&tree.root, "", &mut lines);
        Ok(format!("{{\"lines\":[{}]}}", lines.join(",")))
    }

    pub fn get_font_list(&self) -> String {
        let mut entries = Vec::new();
        for (lang_idx, lang_fonts) in self.document.doc_info.font_faces.iter().enumerate() {
            for (font_idx, font) in lang_fonts.iter().enumerate() {
                entries.push(format!(
                    "{{\"lang\":{},\"id\":{},\"name\":\"{}\"}}",
                    lang_idx,
                    font_idx,
                    helpers::json_escape(&font.name)
                ));
            }
        }
        format!("[{}]", entries.join(","))
    }

    /// 한 컨테이너의 선택 범위에 통째로 든 표 주소를 돌려준다.
    /// 본문과 중첩 셀 모두 문단/컨트롤 모델에서 찾으므로 렌더 트리의 주소 누락에 의존하지 않는다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn table_controls_in_selection_native(
        &self,
        section_idx: usize,
        parent_para_idx: usize,
        container_path: &[(usize, usize, usize)],
        start_para: usize,
        start_offset: usize,
        end_para: usize,
        end_offset: usize,
    ) -> Result<String, HwpError> {
        if start_para > end_para || (start_para == end_para && start_offset > end_offset) {
            return Err(HwpError::RenderError("표 선택 범위가 뒤집혔습니다".into()));
        }
        let mut refs = Vec::new();
        for para_idx in start_para..=end_para {
            let mut path = container_path.to_vec();
            let para = if path.is_empty() {
                self.document
                    .sections
                    .get(section_idx)
                    .and_then(|sec| sec.paragraphs.get(para_idx))
                    .ok_or_else(|| HwpError::RenderError("표 선택 문단 범위 초과".into()))?
            } else {
                path.last_mut().unwrap().2 = para_idx;
                self.resolve_paragraph_by_path(section_idx, parent_para_idx, &path)?
            };
            let positions = find_logical_control_positions(para);
            let length = navigable_text_len(para);
            for (control_idx, control) in para.controls.iter().enumerate() {
                let Control::Table(table) = control else {
                    continue;
                };
                let position = positions.get(control_idx).copied().unwrap_or(0);
                let after_start = para_idx > start_para || start_offset <= position;
                let before_end = para_idx < end_para
                    || if table.common.treat_as_char {
                        end_offset > position
                    } else {
                        end_offset > length
                    };
                if !after_start || !before_end {
                    continue;
                }
                let cell_path = if path.is_empty() {
                    serde_json::Value::Null
                } else {
                    path.push((control_idx, 0, 0));
                    serde_json::Value::Array(
                        path.iter()
                            .map(|(ci, cell, cp)| {
                                serde_json::json!({
                                    "controlIndex": ci, "cellIndex": cell, "cellParaIndex": cp,
                                })
                            })
                            .collect(),
                    )
                };
                refs.push(serde_json::json!({
                    "sec": section_idx,
                    "ppi": if container_path.is_empty() { para_idx } else { parent_para_idx },
                    "ci": if container_path.is_empty() { control_idx } else { container_path[0].0 },
                    "cellPath": cell_path,
                }));
                if !container_path.is_empty() {
                    path.pop();
                }
            }
        }
        serde_json::to_string(&refs).map_err(|err| HwpError::RenderError(err.to_string()))
    }

    /// Agent pending preview needs the rendered pixels of a picture or equation,
    /// including an equation inside one table cell. A shape bbox cannot resolve
    /// either control type, and a cell bbox colors unrelated cell content.
    pub(crate) fn get_object_bbox_native(
        &self,
        kind: &str,
        section_idx: usize,
        parent_para_idx: usize,
        control_idx: usize,
        cell_idx: Option<usize>,
        cell_para_idx: Option<usize>,
        inner_control_idx: Option<usize>,
        cell_path_json: Option<&str>,
    ) -> Result<String, HwpError> {
        use crate::renderer::render_tree::{RenderNode, RenderNodeType};

        // doogle: upstream 렌더 트리의 ImageNode 에는 셀 위치 필드가 없고, EquationNode 에는
        // rx 의 inner_control_index·cell_context 가 없다(셀 수식의 control_index 는 바깥 표).
        // 그래서 셀 그림은 지원하지 않고, 셀 수식은 깊이 1 경로(셀·셀문단)로만 찾으며
        // 같은 셀 문단에 수식이 여럿이면 첫 수식의 경계를 돌려준다(inner_control_index 무시).
        let _ = inner_control_idx;
        let cell_path = cell_path_json.map(Self::parse_cell_path).transpose()?;
        let (cell_idx, cell_para_idx) = match &cell_path {
            Some(path) => {
                if path.len() != 1 || path[0].0 != control_idx {
                    return Err(HwpError::RenderError(
                        "중첩 셀 경로의 개체 경계는 지원하지 않습니다".to_string(),
                    ));
                }
                (Some(path[0].1), Some(path[0].2))
            }
            None => (cell_idx, cell_para_idx),
        };
        if kind == "image" && cell_idx.is_some() {
            return Err(HwpError::RenderError(
                "셀 안 그림의 개체 경계는 지원하지 않습니다".to_string(),
            ));
        }

        fn find(
            node: &RenderNode,
            kind: &str,
            sec: usize,
            para: usize,
            ctrl: usize,
            cell: Option<usize>,
            cell_para: Option<usize>,
        ) -> Option<crate::renderer::render_tree::BoundingBox> {
            let matches = match (&node.node_type, kind) {
                (RenderNodeType::Image(image), "image") => {
                    image.section_index == Some(sec)
                        && image.para_index == Some(para)
                        && image.control_index == Some(ctrl)
                }
                (RenderNodeType::Equation(eq), "equation") => {
                    eq.section_index == Some(sec)
                        && eq.para_index == Some(para)
                        && eq.control_index == Some(ctrl)
                        && eq.cell_index == cell
                        && eq.cell_para_index == cell_para
                }
                _ => false,
            };
            if matches {
                return Some(node.bbox);
            }
            node.children
                .iter()
                .find_map(|child| find(child, kind, sec, para, ctrl, cell, cell_para))
        }

        if kind != "image" && kind != "equation" {
            return Err(HwpError::RenderError(format!(
                "지원하지 않는 개체 종류: {kind}"
            )));
        }
        for page in 0..self.page_count() as usize {
            let tree = self.build_page_tree_cached(page as u32)?;
            if let Some(bbox) = find(
                &tree.root,
                kind,
                section_idx,
                parent_para_idx,
                control_idx,
                cell_idx,
                cell_para_idx,
            ) {
                return Ok(format!(
                    "{{\"pageIndex\":{},\"x\":{:.1},\"y\":{:.1},\"width\":{:.1},\"height\":{:.1}}}",
                    page, bbox.x, bbox.y, bbox.width, bbox.height,
                ));
            }
        }
        Err(HwpError::RenderError(format!(
            "개체 노드를 찾을 수 없습니다 (kind={kind}, sec={section_idx}, ppi={parent_para_idx}, ci={control_idx})"
        )))
    }
}

#[cfg(test)]
mod tests {
    use crate::document_core::DocumentCore;

    #[test]
    fn agent_read_queries_return_rx_json_shapes() {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().expect("blank document");
        core.insert_text_native(0, 0, 0, "가나다").expect("text");

        let pages = core.get_all_page_info_native().unwrap();
        assert!(pages.starts_with('[') && pages.ends_with(']'), "{pages}");
        assert_eq!(
            pages.matches("\"pageIndex\"").count(),
            core.page_count() as usize,
            "{pages}"
        );

        let lines = core.get_page_line_layout_native(0).unwrap();
        assert!(lines.starts_with("{\"lines\":["), "{lines}");
        assert!(lines.contains("\"sec\":0,\"para\":0"), "{lines}");
        assert!(lines.contains("\"cs\":0,\"ce\":3"), "{lines}");

        let fonts = core.get_font_list();
        assert!(
            fonts.starts_with('[') && fonts.contains("\"lang\":0"),
            "{fonts}"
        );

        let created = core.create_table_native(0, 0, 3, 2, 2).expect("table");
        assert!(created.contains("\"ok\":true"), "{created}");
        let para_count = core.document.sections[0].paragraphs.len();
        let refs = core
            .table_controls_in_selection_native(0, 0, &[], 0, 0, para_count - 1, usize::MAX)
            .unwrap();
        assert!(refs.contains("\"cellPath\":null"), "{refs}");
    }
}
