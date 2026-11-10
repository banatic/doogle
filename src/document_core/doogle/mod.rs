//! 두글(doogle) 에이전트 편집용 엔진 추가 기능.
//!
//! banatic/rhwp-x (MIT) 의 vendored rhwp 에서 에이전트 도구 실행기가 쓰는 API 중
//! upstream 에 없는 것을 새 파일로 이식한다. 기존 조판·렌더링 코드는 바꾸지 않는다.
//! 목록과 상태는 `docs/doogle/ENGINE_GAPS.md` 참조.

mod equation;
mod object;
mod paragraph_capture;
mod queries;

use crate::model::paragraph::Paragraph;

/// 두글 전용 상태. `DocumentCore::doogle` 필드 하나로만 기존 구조체에 붙는다.
#[derive(Default)]
pub(crate) struct DoogleState {
    /// 에이전트 대기 편집의 문단 보관본 (ID, 문단).
    pub(crate) paragraph_capture_store: Vec<(u32, Paragraph)>,
    /// 다음 문단 보관 ID.
    pub(crate) next_paragraph_capture_id: u32,
}
