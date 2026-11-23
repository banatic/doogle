//! 셀 경로(cellPath)로 가리키는 표 — 중첩 표·머리말/꼬리말 안 표 — 의 구조·속성 편집.
//!
//! 평면 API(`insert_table_row_native` 등)는 `(구역, 문단, 컨트롤)` 로 **최상위 표만** 닿는다.
//! 중첩 표나 머리말·꼬리말 안 표는 그 좌표계로 가리킬 수 없어 셀 속성·행/열·병합/분할·
//! 영역 테두리·표 속성을 바꿀 길이 없었다.
//!
//! 여기서는 평면 구현을 **그대로** 다시 쓴다. 표를 품은 문단(host — 셀 문단 또는 머리말·꼬리말
//! 문단)을 잠깐 구역의 최상위 문단 자리(`parent_para_idx`)에 올려 두고 평면 API 를 부른 뒤
//! 원래 자리로 되돌린다. 평면 구현이 보는 "부모 문단" 이 실제 부모(host)이므로 테두리 조각
//! 바인딩 같은 부모 기준 검사도 같은 뜻으로 동작한다. 문단 수는 바뀌지 않아 구역의 문단별
//! 캐시(dirty 비트·단 지도)는 길이가 그대로다.
//!
//! 평면 구현이 그 사이에 하는 재조판·쪽 나누기는 batch 모드로 미루고, 되돌린 뒤 구역을
//! 다시 조판한다. 바깥 셀·표 높이는 쪽 나누기의 표 측정이 다시 잰다 — 바깥 문단이 중첩
//! 표 측정 캐시의 주인이라 그 문단을 dirty 로 표시한다(`mark_cell_control_dirty`).
//!
//! 경로 규약은 다른 `*_by_cell_path` 와 같다: `[(controlIndex, cellIndex, cellParaIndex), ..]`,
//! 마지막 항목의 controlIndex 가 대상 표(그 항목의 cell 값은 쓰지 않는다). 깊이 1 이면
//! 평면 API 에 그대로 위임한다.

use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::event::DocumentEvent;

type CellPath = [(usize, usize, usize)];

impl DocumentCore {
    /// 경로 표에 평면 표 명령 `op(self, 구역, 문단, 컨트롤)` 을 적용한다.
    ///
    /// 깊이 1 은 그대로 위임. 깊이 ≥ 2 는 host 문단을 최상위 자리로 잠깐 옮겨 부른다 —
    /// `op` 가 실패해도 문서 배치는 원래대로 돌려놓는다.
    fn with_table_at_cell_path<R>(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        op: impl FnOnce(&mut Self, usize, usize, usize) -> Result<R, HwpError>,
    ) -> Result<R, HwpError> {
        let Some(&(control_idx, _, _)) = path.last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        if path.len() == 1 {
            return op(self, section_idx, parent_para_idx, control_idx);
        }
        // 경로가 표에 닿는지 먼저 확인한다 — 문서를 옮기기 전에 오류를 낸다.
        self.resolve_table_mut_by_cell_path(section_idx, parent_para_idx, path)?;

        let depth = path.len() - 1;
        let host_path = &path[..depth];
        let host = std::mem::take(self.get_cell_paragraph_mut_by_path(
            section_idx,
            parent_para_idx,
            host_path,
        )?);
        let outer = std::mem::replace(
            &mut self.document.sections[section_idx].paragraphs[parent_para_idx],
            host,
        );

        let batch_before = self.batch_mode;
        let events_before = self.event_log.len();
        self.batch_mode = true;
        let result = op(self, section_idx, parent_para_idx, control_idx);
        self.batch_mode = batch_before;
        // 평면 명령의 이벤트는 (문단, 컨트롤) 이 임시 자리를 가리킨다 — 바깥 셀 변경으로 바꾼다.
        self.event_log.truncate(events_before);

        let host = std::mem::replace(
            &mut self.document.sections[section_idx].paragraphs[parent_para_idx],
            outer,
        );
        *self
            .get_cell_paragraph_mut_by_path(section_idx, parent_para_idx, host_path)
            .expect("host 문단 경로는 옮기기 전에 확인했다") = host;

        if result.is_ok() {
            self.finish_table_edit_at_cell_path(section_idx, parent_para_idx, path);
        } else {
            // 평면 명령은 바꾸기 전에 검사하지만, 임시 자리에서 남긴 조판 결과는 버린다.
            self.recompose_section(section_idx);
            self.paginate_if_needed();
        }
        result
    }

    /// 경로 표 편집 뒤처리 — 구역 재조판·쪽 나누기, 바깥 측정 캐시 무효화, 이벤트.
    fn finish_table_edit_at_cell_path(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
    ) {
        let (outer_ctrl, outer_cell, _) = path[0];
        // 표를 품은 문단의 저장 줄(LINE_SEG)은 표의 옛 크기다 — 글자처럼 취급한 표는 그 줄
        // 높이를 먼저 차지하고 늘어난 만큼 더 쌓여, 바깥 칸이 실제보다 커진다(실측: 3행
        // 중첩 표 바깥 칸 125.7px, 줄을 다시 짠 문서는 83.9px). 안쪽에서 바깥으로 각 host 문단을
        // 다시 짜고 그 칸의 문단 세로 위치를 다시 잇는다 — 셀 안 표 만들기와 같은 뒤처리다.
        for depth in (1..path.len()).rev() {
            let host_path = &path[..depth];
            let host_para = host_path[depth - 1].2;
            self.reflow_cell_paragraph_by_path(section_idx, parent_para_idx, host_path, host_para);
            self.recalculate_cell_paragraph_vpos_by_path(
                section_idx,
                parent_para_idx,
                host_path,
                host_para,
                None,
            );
        }
        // 평면 명령이 임시 자리에서 남긴 조판 결과는 버린다 — 바깥 문단 전체를 다시 잰다.
        self.mark_cell_control_dirty(section_idx, parent_para_idx, outer_ctrl);
        self.document.sections[section_idx].raw_stream = None;
        self.recompose_section(section_idx);
        self.paginate_if_needed();
        self.invalidate_page_tree_cache();
        self.event_log.push(DocumentEvent::CellTextChanged {
            section: section_idx,
            para: parent_para_idx,
            ctrl: outer_ctrl,
            cell: outer_cell,
        });
    }

    /// 경로 표에 행을 넣는다. 반환은 평면 API 와 같다 `{"ok":true,"rowCount":..,"colCount":..}`.
    pub fn insert_table_row_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        row_idx: u16,
        below: bool,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.insert_table_row_native(s, p, c, row_idx, below)
        })
    }

    /// 경로 표에 열을 넣는다.
    pub fn insert_table_column_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        col_idx: u16,
        right: bool,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.insert_table_column_native(s, p, c, col_idx, right)
        })
    }

    /// 경로 표에서 행을 지운다.
    pub fn delete_table_row_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        row_idx: u16,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.delete_table_row_native(s, p, c, row_idx)
        })
    }

    /// 경로 표에서 열을 지운다.
    pub fn delete_table_column_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        col_idx: u16,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.delete_table_column_native(s, p, c, col_idx)
        })
    }

    /// 경로 표의 셀을 합친다.
    #[allow(clippy::too_many_arguments)]
    pub fn merge_table_cells_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        start_row: u16,
        start_col: u16,
        end_row: u16,
        end_col: u16,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.merge_table_cells_native(s, p, c, start_row, start_col, end_row, end_col)
        })
    }

    /// 경로 표의 셀을 N줄 × M칸으로 나눈다 (`split_table_cell_into_native` 와 같은 인자).
    #[allow(clippy::too_many_arguments)]
    pub fn split_table_cell_into_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        row: u16,
        col: u16,
        n_rows: u16,
        m_cols: u16,
        equal_row_height: bool,
        merge_first: bool,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.split_table_cell_into_native(
                s,
                p,
                c,
                row,
                col,
                n_rows,
                m_cols,
                equal_row_height,
                merge_first,
            )
        })
    }

    /// 경로 표의 셀 속성(크기·안 여백·세로 정렬·테두리·채우기 …)을 바꾼다.
    ///
    /// JSON 은 `set_cell_properties_native` 와 같다. 테두리 조각(셀 테두리를 그림으로 그린
    /// 원본)이 걸린 표의 테두리 변경은 거절한다 — 그 undo 기록이 평면 좌표를 열쇠로 쓴다.
    pub fn set_cell_properties_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        cell_idx: usize,
        json: &str,
    ) -> Result<String, HwpError> {
        let border_keys = [
            "border",
            "fill",
            "diagonal",
            "centerLine",
            "pattern",
            "gradient",
            "image",
        ];
        let touches_borders = border_keys.iter().any(|k| json.contains(k));
        let nested = path.len() > 1;
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            if nested && touches_borders {
                core.ensure_table_cell_topology_supported(s, p, c)
                    .map_err(|_| {
                        HwpError::RenderError(
                        "원본 테두리 조각이 있는 중첩 표의 테두리·채우기는 경로로 바꿀 수 없습니다"
                            .to_string(),
                    )
                    })?;
            }
            core.set_cell_properties_native(s, p, c, cell_idx, json)
        })
    }

    /// 경로 표의 셀 영역(cellzone) 테두리·채우기를 바꾼다.
    #[allow(clippy::too_many_arguments)]
    pub fn set_cell_zone_properties_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        start_row: u16,
        start_col: u16,
        end_row: u16,
        end_col: u16,
        json: &str,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.set_cell_zone_properties_native(
                s, p, c, start_row, start_col, end_row, end_col, json,
            )
        })
    }

    /// 경로 표의 표 속성(안 여백·셀 간격·쪽 나눔·바깥 여백·위치 …)을 바꾼다.
    ///
    /// 캡션 키는 중첩 표에서 거절한다 — 평면 구현이 글자처럼 취급한 표의 캡션을 만들면
    /// 부모 문단을 **구역 본문 문단**으로 보고 뒤 문단 세로 위치까지 다시 잰다.
    pub fn set_table_properties_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        json: &str,
    ) -> Result<String, HwpError> {
        if path.len() > 1 && json.to_ascii_lowercase().contains("caption") {
            return Err(HwpError::RenderError(
                "중첩 표·머리말/꼬리말 안 표의 캡션은 경로로 바꿀 수 없습니다".to_string(),
            ));
        }
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.set_table_properties_native(s, p, c, json)
        })
    }

    /// 경로 표의 열 폭(HWPUNIT)을 절대값으로 정한다.
    pub fn set_table_column_widths_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
        widths: Vec<u32>,
    ) -> Result<String, HwpError> {
        self.with_table_at_cell_path(section_idx, parent_para_idx, path, |core, s, p, c| {
            core.set_table_column_widths_native(s, p, c, widths)
        })
    }

    /// 경로 표를 지운다. 깊이 1 은 `delete_table_control_native`, 깊이 ≥ 2 는 표를 품은
    /// 셀(또는 머리말·꼬리말) 문단에서 그 컨트롤을 걷어낸다(`delete_cell_table_control_by_path`).
    pub fn delete_table_by_cell_path_native(
        &mut self,
        section_idx: usize,
        parent_para_idx: usize,
        path: &CellPath,
    ) -> Result<String, HwpError> {
        let Some(&(control_idx, _, _)) = path.last() else {
            return Err(HwpError::RenderError("경로가 비어있습니다".to_string()));
        };
        if path.len() == 1 {
            return self.delete_table_control_native(section_idx, parent_para_idx, control_idx);
        }
        self.resolve_table_mut_by_cell_path(section_idx, parent_para_idx, path)?;
        let host_path: Vec<serde_json::Value> = path[..path.len() - 1]
            .iter()
            .map(|&(c, cell, cp)| {
                serde_json::json!({"controlIndex": c, "cellIndex": cell, "cellParaIndex": cp})
            })
            .collect();
        let json = serde_json::Value::Array(host_path).to_string();
        self.delete_cell_table_control_by_path_native(
            section_idx,
            parent_para_idx,
            &json,
            control_idx,
        )
    }
}

#[cfg(test)]
mod tests {
    //! 셀 경로 표 편집 — 중첩 표(깊이 2·3)와 꼬리말 안 표. 바깥 칸 높이가 따라 변하는지(저장 후
    //! 다시 연 문서와 같은지), HWP·HWPX 저장 왕복, 실패 시 문서가 그대로인지 본다.
    use crate::document_core::DocumentCore;
    use crate::model::control::Control;
    use crate::model::table::Table;

    type Path = Vec<(usize, usize, usize)>;

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap_or_else(|e| panic!("bad json {s}: {e}"))
    }

    /// 본문 2×2 표, 그 첫 칸에 2×2 중첩 표. 반환: (core, 바깥 표 문단, 안쪽 표 경로)
    fn nested_core() -> (DocumentCore, usize, Path) {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().expect("blank");
        core.insert_text_native(0, 0, 0, "앞 문단").expect("text");
        let r = json(
            &core
                .create_table_native(0, 0, 4, 2, 2)
                .expect("outer table"),
        );
        let ppi = r["paraIdx"].as_u64().unwrap() as usize;
        let oci = r["controlIdx"].as_u64().unwrap() as usize;
        let r = json(
            &core
                .create_table_in_cell_by_path_native(
                    0,
                    ppi,
                    &[(oci, 0, 0)],
                    0,
                    2,
                    2,
                    None,
                    None,
                    true,
                )
                .expect("inner table"),
        );
        let cpi = r["cellParaIdx"].as_u64().unwrap() as usize;
        let ici = r["controlIdx"].as_u64().unwrap() as usize;
        (core, ppi, vec![(oci, 0, cpi), (ici, 0, 0)])
    }

    fn table_at<'a>(
        core: &'a DocumentCore,
        ppi: usize,
        path: &[(usize, usize, usize)],
    ) -> &'a Table {
        let mut para = &core.document().sections[0].paragraphs[ppi];
        for (i, &(c, cell, cp)) in path.iter().enumerate() {
            let ctrl = &para.controls[c];
            if i + 1 == path.len() {
                return match ctrl {
                    Control::Table(t) => t,
                    _ => panic!("not a table"),
                };
            }
            para = match ctrl {
                Control::Table(t) => &t.cells[cell].paragraphs[cp],
                Control::Header(h) => &h.paragraphs[cp],
                Control::Footer(f) => &f.paragraphs[cp],
                _ => panic!("bad path"),
            };
        }
        unreachable!()
    }

    fn outer_cell_height(core: &DocumentCore, ppi: usize, oci: usize, cell: usize) -> f64 {
        let v = json(
            &core
                .get_table_cell_bboxes_at_page_native(0, ppi, oci, 0)
                .unwrap(),
        );
        v.as_array()
            .unwrap()
            .iter()
            .find(|c| c["cellIdx"].as_u64() == Some(cell as u64))
            .map(|c| c["h"].as_f64().unwrap())
            .expect("outer cell bbox")
    }

    fn fill_color(core: &DocumentCore, bf_id: u16) -> Option<u32> {
        let bf = &core.document().doc_info.border_fills[(bf_id as usize).saturating_sub(1)];
        bf.fill.solid.as_ref().map(|s| s.background_color)
    }

    fn reload(bytes: Vec<u8>) -> DocumentCore {
        DocumentCore::from_bytes(&bytes).expect("reload")
    }

    /// 저장 뒤 다시 연 문서에서 같은 자리의 안쪽 표를 찾는다(경로는 그대로).
    fn assert_roundtrip(core: &DocumentCore, ppi: usize, path: &Path, label: &str) {
        let want = table_at(core, ppi, path);
        let (rows, cols, cells) = (want.row_count, want.col_count, want.cells.len());
        let want_fill = fill_color(core, want.cells[0].border_fill_id);
        for (fmt, bytes) in [
            ("hwp", core.export_hwp_native().expect("hwp")),
            ("hwpx", core.export_hwpx_native().expect("hwpx")),
        ] {
            let back = reload(bytes);
            let got = table_at(&back, ppi, path);
            assert_eq!(
                (got.row_count, got.col_count, got.cells.len()),
                (rows, cols, cells),
                "{label} {fmt} dims"
            );
            assert_eq!(
                fill_color(&back, got.cells[0].border_fill_id),
                want_fill,
                "{label} {fmt} fill"
            );
        }
    }

    #[test]
    fn nested_rows_cols_and_parent_growth() {
        let (mut core, ppi, path) = nested_core();
        let oci = path[0].0;
        let h0 = outer_cell_height(&core, ppi, oci, 0);
        let r = json(
            &core
                .insert_table_row_by_cell_path_native(0, ppi, &path, 1, true)
                .unwrap(),
        );
        assert_eq!(r["rowCount"], 3);
        for _ in 0..3 {
            core.insert_table_row_by_cell_path_native(0, ppi, &path, 0, true)
                .unwrap();
        }
        let r = json(
            &core
                .insert_table_column_by_cell_path_native(0, ppi, &path, 0, true)
                .unwrap(),
        );
        assert_eq!(
            (r["rowCount"].as_u64(), r["colCount"].as_u64()),
            (Some(6), Some(3))
        );
        let inner = table_at(&core, ppi, &path);
        assert_eq!(
            (inner.row_count, inner.col_count, inner.cells.len()),
            (6, 3, 18)
        );
        let outer = table_at(
            &core,
            ppi,
            &path[..1]
                .iter()
                .map(|&(c, _, _)| (c, 0, 0))
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            (outer.row_count, outer.col_count, outer.cells.len()),
            (2, 2, 4),
            "outer untouched"
        );
        let h1 = outer_cell_height(&core, ppi, oci, 0);
        assert!(
            h1 > h0 + 20.0,
            "outer cell grows with the nested table: {h0} -> {h1}"
        );
        // 다른 행의 바깥 칸(1행)도 같이 내려가야 한다 — 행 높이가 갱신된 것이다
        core.delete_table_row_by_cell_path_native(0, ppi, &path, 0)
            .unwrap();
        core.delete_table_row_by_cell_path_native(0, ppi, &path, 0)
            .unwrap();
        core.delete_table_row_by_cell_path_native(0, ppi, &path, 0)
            .unwrap();
        let r = json(
            &core
                .delete_table_column_by_cell_path_native(0, ppi, &path, 2)
                .unwrap(),
        );
        assert_eq!(
            (r["rowCount"].as_u64(), r["colCount"].as_u64()),
            (Some(3), Some(2))
        );
        let h2 = outer_cell_height(&core, ppi, oci, 0);
        assert!(h2 < h1, "outer cell shrinks back: {h1} -> {h2}");
        // 편집 뒤 측정 == 저장 후 다시 연 문서의 측정 (낡은 높이가 남지 않았다)
        for bytes in [
            core.export_hwp_native().unwrap(),
            core.export_hwpx_native().unwrap(),
        ] {
            let back = reload(bytes);
            let hb = outer_cell_height(&back, ppi, oci, 0);
            assert!((hb - h2).abs() < 1.0, "live {h2} vs reloaded {hb}");
        }
        assert_roundtrip(&core, ppi, &path, "rows/cols");
    }

    #[test]
    fn nested_merge_split() {
        let (mut core, ppi, path) = nested_core();
        let r = json(
            &core
                .merge_table_cells_by_cell_path_native(0, ppi, &path, 0, 0, 0, 1)
                .unwrap(),
        );
        assert_eq!(r["cellCount"], 3);
        let inner = table_at(&core, ppi, &path);
        assert_eq!(inner.cells[0].col_span, 2);
        assert_roundtrip(&core, ppi, &path, "merge");
        let r = json(
            &core
                .split_table_cell_into_by_cell_path_native(0, ppi, &path, 0, 0, 1, 2, true, false)
                .unwrap(),
        );
        assert_eq!(r["cellCount"], 4);
        let r = json(
            &core
                .split_table_cell_into_by_cell_path_native(0, ppi, &path, 1, 1, 2, 1, true, false)
                .unwrap(),
        );
        assert_eq!(r["cellCount"], 5);
        assert_roundtrip(&core, ppi, &path, "split");
    }

    #[test]
    fn nested_cell_and_table_props() {
        let (mut core, ppi, path) = nested_core();
        let outer_bf_before: Vec<u16> = table_at(&core, ppi, &[(path[0].0, 0, 0)])
            .cells
            .iter()
            .map(|c| c.border_fill_id)
            .collect();
        core.set_cell_properties_by_cell_path_native(
            0,
            ppi,
            &path,
            1,
            r##"{"fillType":"solid","fillColor":"#FF0000","verticalAlign":1,"paddingLeft":567,"applyInnerMargin":true}"##,
        )
        .unwrap();
        let inner = table_at(&core, ppi, &path);
        let cell = &inner.cells[1];
        assert_eq!(
            fill_color(&core, cell.border_fill_id),
            Some(0x0000FF),
            "red fill (BGR)"
        );
        assert_eq!(cell.padding.left, 567);
        assert!(matches!(
            cell.vertical_align,
            crate::model::table::VerticalAlign::Center
        ));
        let outer_bf_after: Vec<u16> = table_at(&core, ppi, &[(path[0].0, 0, 0)])
            .cells
            .iter()
            .map(|c| c.border_fill_id)
            .collect();
        assert_eq!(
            outer_bf_before, outer_bf_after,
            "outer cells keep their fills"
        );

        let r = json(
            &core
                .set_cell_zone_properties_by_cell_path_native(
                    0,
                    ppi,
                    &path,
                    0,
                    0,
                    1,
                    1,
                    r##"{"borderTop":{"type":1,"width":5,"color":"#0000FF"},"borderBottom":{"type":1,"width":5,"color":"#0000FF"}}"##,
                )
                .unwrap(),
        );
        assert_eq!(r["ok"], true);
        assert_eq!(table_at(&core, ppi, &path).zones.len(), 1);

        core.set_table_properties_by_cell_path_native(
            0,
            ppi,
            &path,
            r#"{"paddingLeft":300,"cellSpacing":50}"#,
        )
        .unwrap();
        let inner = table_at(&core, ppi, &path);
        assert_eq!((inner.padding.left, inner.cell_spacing), (300, 50));
        assert!(core
            .set_table_properties_by_cell_path_native(0, ppi, &path, r#"{"hasCaption":true}"#)
            .is_err());

        core.set_table_column_widths_by_cell_path_native(0, ppi, &path, vec![3000, 5000])
            .unwrap();
        assert_eq!(
            table_at(&core, ppi, &path).get_column_widths(),
            vec![3000, 5000]
        );

        // 저장 왕복: 칸 채우기·정렬·여백·영역·표 속성
        for (fmt, bytes) in [
            ("hwp", core.export_hwp_native().unwrap()),
            ("hwpx", core.export_hwpx_native().unwrap()),
        ] {
            let back = reload(bytes);
            let t = table_at(&back, ppi, &path);
            assert_eq!(
                fill_color(&back, t.cells[1].border_fill_id),
                Some(0x0000FF),
                "{fmt} fill"
            );
            assert_eq!(t.cells[1].padding.left, 567, "{fmt} padding");
            assert!(
                matches!(
                    t.cells[1].vertical_align,
                    crate::model::table::VerticalAlign::Center
                ),
                "{fmt} valign"
            );
            assert_eq!(
                (t.padding.left, t.cell_spacing),
                (300, 50),
                "{fmt} table props"
            );
            assert_eq!(t.zones.len(), 1, "{fmt} zone");
            assert_eq!(t.get_column_widths(), vec![3000, 5000], "{fmt} widths");
        }
    }

    #[test]
    fn nested_delete_and_errors() {
        let (mut core, ppi, path) = nested_core();
        let paras = core.document().sections[0].paragraphs.len();
        // 표가 아닌 컨트롤/없는 셀을 가리키면 문서를 바꾸지 않고 실패한다
        let bad: Path = vec![path[0], (path[1].0 + 5, 0, 0)];
        assert!(core
            .insert_table_row_by_cell_path_native(0, ppi, &bad, 0, true)
            .is_err());
        assert!(
            core.merge_table_cells_by_cell_path_native(0, ppi, &path, 0, 0, 9, 9)
                .is_err(),
            "out of range merge"
        );
        assert_eq!(
            table_at(&core, ppi, &path).cells.len(),
            4,
            "failed op leaves the nested table"
        );
        assert_eq!(core.document().sections[0].paragraphs.len(), paras);
        assert!(core
            .insert_table_row_by_cell_path_native(0, ppi, &[], 0, true)
            .is_err());
        // 깊이 1 은 평면 API 와 같다 — 바깥 표에 행이 든다
        core.insert_table_row_by_cell_path_native(0, ppi, &[(path[0].0, 0, 0)], 1, true)
            .unwrap();
        assert_eq!(table_at(&core, ppi, &[(path[0].0, 0, 0)]).row_count, 3);
        // 안쪽 표 지우기
        core.delete_table_by_cell_path_native(0, ppi, &path)
            .unwrap();
        let host = &table_at(&core, ppi, &[(path[0].0, 0, 0)]).cells[0].paragraphs;
        assert!(
            host.iter()
                .all(|p| !p.controls.iter().any(|c| matches!(c, Control::Table(_)))),
            "nested table removed"
        );
    }

    #[test]
    fn footer_table() {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, "본문").unwrap();
        let r = json(&core.create_header_footer_native(0, false, 0).unwrap());
        let ppi = r["paraIndex"].as_u64().unwrap() as usize;
        let hci = r["controlIndex"].as_u64().unwrap() as usize;
        let r = json(
            &core
                .create_table_in_cell_by_path_native(
                    0,
                    ppi,
                    &[(hci, 0, 0)],
                    0,
                    1,
                    2,
                    None,
                    None,
                    true,
                )
                .expect("footer table"),
        );
        let cpi = r["cellParaIdx"].as_u64().unwrap() as usize;
        let tci = r["controlIdx"].as_u64().unwrap() as usize;
        let path: Path = vec![(hci, 0, cpi), (tci, 0, 0)];
        core.insert_table_row_by_cell_path_native(0, ppi, &path, 0, true)
            .unwrap();
        core.insert_table_column_by_cell_path_native(0, ppi, &path, 1, true)
            .unwrap();
        core.merge_table_cells_by_cell_path_native(0, ppi, &path, 0, 0, 0, 1)
            .unwrap();
        core.set_cell_properties_by_cell_path_native(
            0,
            ppi,
            &path,
            0,
            r##"{"fillType":"solid","fillColor":"#00FF00"}"##,
        )
        .unwrap();
        let t = table_at(&core, ppi, &path);
        assert_eq!((t.row_count, t.col_count, t.cells.len()), (2, 3, 5));
        assert_eq!(fill_color(&core, t.cells[0].border_fill_id), Some(0x00FF00));
        assert_roundtrip(&core, ppi, &path, "footer");
        // 그림이 그려지는지(쪽 렌더가 실패하지 않는지)
        core.render_page_svg_native(0)
            .expect("render with footer table");
        core.delete_table_by_cell_path_native(0, ppi, &path)
            .unwrap();
        let footer_paras = match &core.document().sections[0].paragraphs[ppi].controls[hci] {
            Control::Footer(f) => &f.paragraphs,
            _ => panic!("footer"),
        };
        assert!(footer_paras
            .iter()
            .all(|p| !p.controls.iter().any(|c| matches!(c, Control::Table(_)))));
    }

    #[test]
    fn depth3() {
        let (mut core, ppi, path) = nested_core();
        // 안쪽 표 첫 칸에 또 표
        let mut cell_path = path.clone();
        cell_path[1] = (path[1].0, 0, 0);
        let r = json(
            &core
                .create_table_in_cell_by_path_native(0, ppi, &cell_path, 0, 1, 1, None, None, true)
                .expect("depth3 table"),
        );
        let mut p3 = cell_path.clone();
        p3[1].2 = r["cellParaIdx"].as_u64().unwrap() as usize;
        p3.push((r["controlIdx"].as_u64().unwrap() as usize, 0, 0));
        let oci = path[0].0;
        let h0 = outer_cell_height(&core, ppi, oci, 0);
        for _ in 0..4 {
            core.insert_table_row_by_cell_path_native(0, ppi, &p3, 0, true)
                .unwrap();
        }
        assert_eq!(table_at(&core, ppi, &p3).row_count, 5);
        assert_eq!(
            table_at(&core, ppi, &path).row_count,
            2,
            "middle table rows unchanged"
        );
        let h1 = outer_cell_height(&core, ppi, oci, 0);
        assert!(
            h1 > h0 + 20.0,
            "outermost cell grows with depth-3 table: {h0} -> {h1}"
        );
        assert_roundtrip(&core, ppi, &p3, "depth3");
    }
}
