// 두글 에이전트 평가 시나리오.
//
// 문서는 eval/.fixtures/ 에 둔다(추적하지 않음) — upstream(edwardkim/rhwp) samples/ 에서 받는다:
//   git cat-file blob "upstream/main:samples/<이름>" > doogle-agent/eval/.fixtures/<이름>
//
// check 는 편집 뒤 구조 덤프(after, text:"full")와 도구 기록으로 결과를 본다. 판정은 느슨하게 —
// 모델 문장은 매번 다르므로 "요청한 것이 문서에 반영됐나"만 본다. 도구 호출 품질은 audit 가 따로 센다.

const has = (text, needle) => text.includes(needle);
const count = (text, needle) => text.split(needle).length - 1;
const writes = (record) => record.turns.flatMap((t) => t.toolCalls ?? []).filter((c) => /^(insert_|replace_|delete_|move_|apply_|create_|edit_|set_)/.test(c.name));
/** 되물었는가 — 물음표나 '알려 주세요' 꼴의 요청으로 끝난다 */
// 되물음: 글로 묻거나(끝 400자) 질문 카드(ask_user_question)를 띄웠다
const asked = (record) => calls(record, 'ask_user_question').some((c) => c.ok)
  || /\?|알려 ?주|말씀해 ?주|골라 ?주|정해 ?주/.test(finalText(record).slice(-400));
const okWrites = (record) => writes(record).filter((c) => c.ok);
const calls = (record, name) => record.turns.flatMap((t) => t.toolCalls ?? []).filter((c) => c.name === name);
const allCalls = (record) => record.turns.flatMap((t) => t.toolCalls ?? []);
const failed = (record) => allCalls(record).filter((c) => !c.ok);
const noToolErrors = (record) => ({ name: '도구 오류 없음', pass: failed(record).length === 0, detail: failed(record).map((c) => `${c.name}:${c.error?.code}`).join(', ') });
const callsAtMost = (record, n) => ({ name: `도구 호출 ${n}회 이하`, pass: allCalls(record).length <= n, detail: `${allCalls(record).length}회` });
const used = (record, name) => [...calls(record, name), ...calls(record, 'apply_edits').filter((c) => (c.args?.edits ?? []).some((e) => e.tool === name))].some((c) => c.ok);
const finalText = (record) => record.turns.flatMap((t) => (t.timeline ?? []).filter((x) => x.kind === 'text').map((x) => x.text)).join('\n');
const changed = (before, after) => ({ name: '문서가 바뀜', pass: before !== after });
const unchanged = (before, after) => ({ name: '문서를 건드리지 않음', pass: before === after });

/** @type {Array<{id:string, doc:string, prompt?:string, turns?:any[], mode?:'agent'|'full', timeoutMs?:number, check?:(ctx:any)=>any}>} */
export const SCENARIOS = [
  // ── 글 고치기 ──
  {
    id: 'replace-all-term',
    doc: 'biz_plan.hwp',
    prompt: "문서 전체에서 '사업'이라는 낱말을 '프로젝트'로 바꿔줘. 표 안도 포함해서.",
    // '사업단'·'사업자'는 다른 낱말이라 남겨도 된다(모델이 그렇게 판단해 알린다) — 낱말 '사업'이 대부분 바뀌었는지만 본다.
    check: ({ before, after, record }) => [
      { name: "낱말 '사업'이 바뀜", pass: count(after, '사업') <= 8 && count(after, '프로젝트') >= 20, detail: `'사업' ${count(before, '사업')}→${count(after, '사업')}, '프로젝트' ${count(after, '프로젝트')}` },
      noToolErrors(record),
      callsAtMost(record, 6),
    ],
  },
  {
    id: 'proofread',
    doc: '2022년 국립국어원 업무계획.hwp',
    prompt: '3쪽("성과" 부분)만 맞춤법과 띄어쓰기를 교정해줘. 내용은 바꾸지 말고, 고칠 곳이 없으면 없다고 말해줘.',
    check: ({ record }) => [
      noToolErrors(record),
      { name: '쓰기 호출 2회 이하(배치)', pass: writes(record).length <= 2, detail: `쓰기 ${writes(record).length}회` },
      // 교정은 글만 고친다 — 쪽 넘김을 되돌리려고 장평·셀 높이·표 속성을 건드리면 안 된다
      { name: '서식·표 속성을 건드리지 않음', pass: !['apply_char_format', 'apply_para_format', 'set_cell_props', 'set_table_props', 'edit_table'].some((n) => used(record, n)), detail: ['apply_char_format', 'apply_para_format', 'set_cell_props', 'set_table_props', 'edit_table'].filter((n) => used(record, n)).join(', ') },
      callsAtMost(record, 6),
    ],
  },
  {
    id: 'rewrite-paragraph',
    doc: 'text-align.hwp',
    prompt: '"ㅇ 세대별·지역별 언어 변이 조사"로 시작하는 문단이 너무 길어. 같은 내용을 "ㅇ" 항목 두 개로 나눠서 다시 써줘. 서식은 그대로 두고.',
    check: ({ before, after, record }) => [
      changed(before, after),
      { name: '쓰기 성공', pass: okWrites(record).length > 0 },
      { name: '문단이 하나 늘어남', pass: /s0 · 6 paragraphs/.test(after), detail: after.split('\n')[1] },
      { name: '표가 그대로 있음', pass: has(after, '어휘·표현') && has(after, '주제별 구술발화') },
    ],
  },
  {
    id: 'long-doc-find-edit',
    doc: 'kps-ai.hwp',
    prompt: '이 제안요청서의 사업기간을 "계약일로부터 8개월"로 바꿔줘. 문서 다른 곳에 사업기간이 6개월로 적힌 데가 있으면 같이 고치고, 어디를 고쳤는지 알려줘.',
    timeoutMs: 15 * 60_000,
    check: ({ after, record }) => [
      { name: '사업기간이 8개월로 바뀜', pass: has(after, '사업기간: 계약일로부터 8개월') },
      { name: '추진기간 줄도 바뀜', pass: has(after, '추진기간 : 8개월(계약일로부터 8개월)') },
      noToolErrors(record),
      { name: '읽은 양 6만 자 이하', pass: allCalls(record).reduce((n, c) => n + (c.resultChars ?? 0), 0) <= 60_000, detail: `${allCalls(record).reduce((n, c) => n + (c.resultChars ?? 0), 0).toLocaleString()}자` },
    ],
  },
  {
    id: 'nested-cell-edit',
    doc: 'kps-ai.hwp',
    prompt: '<붙임1> 표 안에 들어 있는 표에서 사업기간 칸의 "계약일로부터 6개월"을 "계약일로부터 8개월"로 고쳐줘. 다른 곳은 건드리지 말고.',
    check: async ({ after, record, tool }) => {
      const found = await tool('find_text', { query: '계약일로부터 8개월' });
      const matches = found.result?.matches ?? [];
      return [
        { name: '중첩 표 안의 값이 바뀜', pass: matches.some((m) => m.cellPath && m.cell?.paraIdx === 674), detail: JSON.stringify(matches).slice(0, 200) },
        { name: '본문 사업기간은 그대로', pass: has(after, '사업기간: 계약일로부터 6개월') },
        noToolErrors(record),
        callsAtMost(record, 5),
      ];
    },
  },
  {
    id: 'long-doc-insert-summary',
    doc: 'kps-ai.hwp',
    prompt: '"Ⅰ 사업개요"의 "1. 사업일반" 항목들(가~라) 바로 아래에, 이 사업을 한 문장으로 요약한 "  마. 요    약: …" 줄을 같은 서식으로 추가해줘.',
    check: ({ before, after, record }) => [
      { name: "'마.' 줄이 추가됨", pass: /마\. 요 *약/.test(after) },
      { name: '문단이 하나만 늘어남', pass: Number(/s0 · (\d+) paragraphs/.exec(after)?.[1]) === Number(/s0 · (\d+) paragraphs/.exec(before)?.[1]) + 1, detail: after.split('\n')[1] },
      { name: 'insert_paragraphs 사용', pass: used(record, 'insert_paragraphs') },
      // 쪽 넘김을 되돌리려고 다른 문단의 간격을 바꾸거나 빈 줄을 지우면 안 된다
      { name: '다른 문단을 건드리지 않음', pass: !used(record, 'delete_range') && !used(record, 'delete_paragraphs') && !used(record, 'apply_para_format'), detail: ['delete_range', 'delete_paragraphs', 'apply_para_format'].filter((n) => used(record, n)).join(', ') },
      noToolErrors(record),
      callsAtMost(record, 6),
    ],
  },
  {
    id: 'delete-paragraphs',
    doc: 'para-001.hwp',
    prompt: '"옹주(雍州) 땅에"로 시작하는 문단을 통째로 삭제해줘. 그 문단 자리에 빈 줄이 더 늘어나지 않게.',
    check: ({ after, record }) => [
      { name: '문단이 사라짐', pass: !has(after, '옹주(雍州) 땅에') },
      { name: '다른 문단은 그대로', pass: has(after, '오호라, 건곤') && has(after, '서씨가 이 소문을 듣고') },
      { name: '문단 수가 줄어듦', pass: Number(/s0 · (\d+) paragraphs/.exec(after)?.[1]) < 41, detail: after.split('\n')[1] },
      { name: 'delete_paragraphs 사용', pass: used(record, 'delete_paragraphs') },
      noToolErrors(record),
    ],
  },
  {
    id: 'move-paragraph',
    doc: 'para-001.hwp',
    prompt: '"여러 자서제질(子壻諸姪)"로 시작하는 한 줄짜리 문단을 문서 맨 끝으로 옮겨줘.',
    check: ({ after, record }) => {
      const lines = after.split('\n').filter((l) => /^s0 p\d+ \(\d/.test(l) && !/\(1\) " "/.test(l));
      return [
        { name: '한 번만 남음', pass: count(after, '여러 자서제질') === 1, detail: `수 ${count(after, '여러 자서제질')}` },
        { name: '맨 끝 문단임', pass: has(lines.at(-1) ?? '', '여러 자서제질'), detail: (lines.at(-1) ?? '').slice(0, 80) },
        { name: 'move_paragraphs 사용(다시 치지 않음)', pass: used(record, 'move_paragraphs') },
        noToolErrors(record),
      ];
    },
  },

  // ── 서식 ──
  {
    id: 'format-headings',
    doc: 'biz_plan.hwp',
    prompt: '문서의 소제목들을 모두 굵게, 13pt, 파란색(#1F4E79)으로 바꿔줘.',
    // 소제목의 범위(장 제목만? 하위 제목까지?)가 갈린다 — 물어보고 멈추거나, 한 범위를 골라 바로 적용하거나 둘 다 괜찮다.
    check: ({ record }) => [
      noToolErrors(record),
      { name: '적용했거나 범위를 물었음', pass: used(record, 'apply_char_format') || asked(record) },
      { name: '쓰기 호출 2회 이하(paras 배치)', pass: writes(record).length <= 2, detail: `쓰기 ${writes(record).length}회` },
    ],
  },
  {
    id: 'format-paragraphs',
    doc: 'text-align.hwp',
    prompt: '본문 문단 전체를 양쪽 정렬, 줄 간격 180%, 첫 줄 들여쓰기 10pt 로 맞춰줘.',
    check: ({ record }) => [
      { name: 'apply_para_format 성공', pass: [...calls(record, 'apply_para_format'), ...calls(record, 'apply_edits')].some((c) => c.ok) },
    ],
  },
  {
    id: 'make-list',
    doc: 'number-bullet.hwp',
    prompt: '문서 맨 끝에 "준비물" 이라는 줄을 추가하고, 그 아래에 노트북, 충전기, 신분증을 번호 목록(1. 2. 3.)으로 넣어줘.',
    check: ({ after, record }) => [
      { name: '세 항목이 들어감', pass: ['노트북', '충전기', '신분증'].every((w) => has(after, w)) },
      { name: 'apply_list 사용(진짜 목록)', pass: [...calls(record, 'apply_list'), ...calls(record, 'apply_edits').filter((c) => JSON.stringify(c.args).includes('apply_list'))].some((c) => c.ok) },
      { name: "글자로 '1.' 을 치지 않음", pass: !/p\d+ \(\d+[^)]*\) 1\. ?노트북/.test(after) },
    ],
  },

  // ── 표 ──
  {
    id: 'table-fill-cells',
    doc: 'hwp_table_test.hwp',
    prompt: '첫 번째 표(제목/담당자/세부 내용)의 빈 칸 9개를 적당한 예시 값으로 채워줘.',
    check: ({ before, after, record }) => {
      const all = after.split('\n');
      const rows = all.slice(all.findIndex((l) => l.includes('table s0 p3 c0')) + 2).slice(0, 3);
      return [
        changed(before, after),
        { name: '빈 칸 9개가 모두 참', pass: rows.every((r) => !/\[\d+[^\]]*\]( \||$)/.test(r)), detail: rows.join(' / ').slice(0, 200) },
        noToolErrors(record),
        { name: '쓰기 호출 2회 이하', pass: writes(record).length <= 2, detail: `쓰기 ${writes(record).length}회` },
      ];
    },
  },
  {
    id: 'table-add-row-simple',
    doc: '통합재정통계(2014.8월).hwp',
    prompt: '큰 표의 맨 아래("통합재정수지 (A-B)" 행 아래)에 행을 하나 추가하고, 첫 칸에 "비고", 마지막 칸에 "잠정치"라고 적어줘.',
    check: ({ after, record }) => [
      { name: '표가 10행이 됨', pass: has(after, 'table s0 p6 c0 10x8'), detail: after.split('\n').find((l) => l.includes('table s0 p6')) },
      { name: "'비고'·'잠정치'가 들어감", pass: has(after, '비고') && has(after, '잠정치') },
      noToolErrors(record),
      // insert_row 가 새 셀 번호를 돌려주므로 구조를 다시 읽지 않아도 된다: 읽기 1 + 행 추가 1 + 채우기 1
      callsAtMost(record, 4),
    ],
  },
  {
    id: 'table-add-row',
    doc: 'table-001.hwp',
    prompt: '첫 번째 표 맨 아래에 행을 하나 추가하고, 첫 칸에 "합계"라고 적어줘.',
    check: ({ after, record }) => [
      { name: "'합계'가 들어감", pass: has(after, '합계') },
      { name: 'edit_table insert_row 성공', pass: [...calls(record, 'edit_table'), ...calls(record, 'apply_edits')].some((c) => c.ok && JSON.stringify(c.args).includes('insert_row')) },
    ],
  },
  {
    id: 'table-create',
    doc: 'biz_plan.hwp',
    prompt: '문서 맨 끝에 "추진 일정"이라는 제목을 넣고, 그 아래에 단계/기간/담당 3열짜리 표를 만들어 3개 단계(기획, 개발, 검증)를 채워줘. 머리행은 회색 배경으로.',
    check: ({ after, record }) => [
      { name: '표 내용이 들어감', pass: ['단계', '기간', '담당', '기획', '개발', '검증'].every((w) => has(after, w)) },
      { name: 'create_table 성공', pass: used(record, 'create_table') },
      // 기준선에서는 문서 끝의 표(인수(검수) 확인)를 지우고 다시 만들었다
      { name: '원래 있던 표가 그대로 있음', pass: has(after, '인수(검수)확인서') && has(after, '주관기관 최종 검수 책임자') && has(after, 'table s0 p92 c0 5x2') },
      { name: '새 표가 문서 끝에 있음', pass: /table s0 p9[4-9] c0 4x3/.test(after), detail: after.split('\n').filter((l) => l.includes('table s0 p9')).join(' / ') },
      noToolErrors(record),
      callsAtMost(record, 8),
    ],
  },
  {
    id: 'table-delete-column',
    doc: 'table-complex.hwp',
    prompt: '첫 번째 표의 마지막 열("산출내역")을 삭제해줘.',
    check: ({ after, record }) => [
      { name: '첫 표가 8열이 됨', pass: has(after, 'table s0 p0 c5 15x8'), detail: after.split('\n').find((l) => l.includes('table s0 p0')) },
      { name: '쓰기 실패 없음', pass: writes(record).every((c) => c.ok), detail: writes(record).filter((c) => !c.ok).map((c) => `${c.name}:${c.error?.code}: ${c.error?.message?.slice(0, 120)}`).join(' | ') },
    ],
  },
  {
    id: 'table-style-header',
    doc: '통합재정통계(2014.8월).hwp',
    prompt: '큰 표(구분/일반 회계/…)의 머리행(첫 행)을 굵게 하고 배경을 연한 회색(#E7E6E6)으로 바꿔줘. 그리고 숫자가 든 칸은 모두 오른쪽 정렬로.',
    check: async ({ record, tool }) => {
      const head = await tool('get_table_properties', { sectionIdx: 0, paraIdx: 6, controlIdx: 0, cellIdx: 1 });
      const num = await tool('get_para_format', { sectionIdx: 0, paraIdx: 0, cell: { paraIdx: 6, controlIdx: 0, cellIdx: 8 } });
      const shot = await tool('render_page', { pageIndex: 0, scale: 1, regionMm: { x: 60, y: 70, width: 10, height: 4 } });
      return [
        // 기준선에서는 도구가 성공이라 했지만 화면의 머리행은 원래 색(#ccffcc) 그대로였다
        { name: '머리행 배경 값이 바뀜', pass: String(head.result?.cell?.fillColor ?? '').toLowerCase() === '#e7e6e6', detail: String(head.result?.cell?.fillColor) },
        { name: '숫자 칸이 오른쪽 정렬', pass: num.result?.alignment === 'right', detail: String(num.result?.alignment) },
        { name: '그림을 다시 그릴 수 있음', pass: !!shot.result?.image },
        noToolErrors(record),
        { name: '쓰기 호출 2회 이하(cells 배치)', pass: writes(record).length <= 2, detail: `쓰기 ${writes(record).length}회` },
      ];
    },
  },

  // ── 서식 문서(양식) ──
  {
    id: 'form-fill-fields',
    doc: '누름틀-2024.hwpx',
    // 두 누름틀은 이름이 같다(안내문 기본값) — set_field_value 로는 구별할 수 없어 자리로 고쳐야 한다
    prompt: '이 양식의 누름틀 두 개를 채워줘. 첫째 줄 누름틀에는 홍길동, 둘째 줄 누름틀에는 010-1234-5678.',
    check: ({ after, record }) => [
      { name: '두 값이 제자리에 들어감', pass: /s0 p0 \(3\) 홍길동/.test(after) && /s0 p1 \(13\) 010-1234-5678/.test(after), detail: after.split('\n').slice(-2).join(' / ') },
      noToolErrors(record),
      { name: 'get_fields 로 확인', pass: [...calls(record, 'get_fields'), ...calls(record, 'read_batch').filter((c) => JSON.stringify(c.args).includes('get_fields'))].length > 0 },
    ],
  },
  {
    id: 'form-fill-application',
    doc: '복학원서.hwpx',
    prompt: '복학원서를 채워줘. 성명 홍길동, 학번 20201234, 학과 컴퓨터공학과, 연락처 010-1234-5678. 날짜는 2026년 11월 11일.',
    check: ({ after, record }) => [
      { name: '값이 들어감', pass: ['홍길동', '20201234', '컴퓨터공학과', '010-1234-5678'].every((w) => has(after, w)), detail: ['홍길동', '20201234', '컴퓨터공학과', '010-1234-5678'].filter((w) => !has(after, w)).join(', ') },
      { name: '쓰기 실패 없음', pass: writes(record).every((c) => c.ok), detail: writes(record).filter((c) => !c.ok).map((c) => `${c.name}:${c.error?.code}: ${c.error?.message?.slice(0, 120)}`).join(' | ') },
    ],
  },

  // ── 쪽·머리말·각주 ──
  {
    id: 'footer-page-number',
    doc: 'biz_plan.hwp',
    prompt: '꼬리말 가운데에 "- 쪽번호 -" 형태로 쪽 번호를 넣어줘.',
    check: ({ record }) => [{ name: 'edit_header_footer 성공', pass: [...calls(record, 'edit_header_footer'), ...calls(record, 'apply_edits')].some((c) => c.ok) }],
  },
  {
    id: 'page-layout',
    doc: 'biz_plan.hwp',
    prompt: '용지를 가로 방향으로 바꾸고 좌우 여백을 20mm로 맞춰줘.',
    check: ({ record }) => [{ name: 'set_page_layout 성공', pass: [...calls(record, 'set_page_layout'), ...calls(record, 'apply_edits')].some((c) => c.ok) }],
  },
  {
    id: 'footnote-add',
    doc: 'footnote-01.hwp',
    prompt: '"플라스틱 액체와 같은 원료를"로 시작하는 문단 끝에 "출처: 통계청(2025)" 라는 각주를 달아줘.',
    check: async ({ record, tool }) => {
      const notes = await tool('list_footnotes');
      return [
        { name: 'insert_footnote 성공', pass: [...calls(record, 'insert_footnote'), ...calls(record, 'apply_edits')].some((c) => c.ok) },
        { name: '각주 글이 들어감', pass: JSON.stringify(notes.result ?? '').includes('통계청(2025)'), detail: JSON.stringify(notes.result ?? notes.error).slice(0, 200) },
      ];
    },
  },
  {
    id: 'equation-insert',
    doc: 'para-001.hwp',
    prompt: '문서 맨 끝에 새 문단으로 이차방정식 근의 공식을 수식으로 넣어줘.',
    check: ({ record }) => [{ name: 'insert_equation 성공', pass: [...calls(record, 'insert_equation'), ...calls(record, 'apply_edits')].some((c) => c.ok) }],
  },

  // ── 판단 ──
  {
    id: 'question-only',
    doc: 'biz_plan.hwp',
    prompt: '이 문서가 몇 쪽이고 표가 몇 개인지만 알려줘. 고치지는 마.',
    check: ({ before, after, record }) => [unchanged(before, after), { name: '쓰기 호출 없음', pass: writes(record).length === 0 }],
  },
  {
    id: 'ambiguous-request',
    doc: 'biz_plan.hwp',
    prompt: '이거 좀 보기 좋게 해줘.',
    // 무엇을 어디까지 바꿀지 정할 수 없는 요청 — 문서를 고치지 말고 되물어야 한다
    check: ({ before, after, record }) => [
      noToolErrors(record),
      unchanged(before, after),
      { name: '되물음', pass: asked(record), detail: finalText(record).slice(-160) },
    ],
  },
  {
    id: 'multi-turn-review',
    doc: 'biz_plan.hwp',
    turns: [
      '문서 제목을 "2027년도 사업계획서(안)"으로 바꿔줘.',
      { review: 'reject' },
      '방금 변경은 취소했어. 대신 제목 뒤에 " (초안)"만 붙여줘.',
    ],
    check: ({ after }) => [
      { name: "'(초안)'이 붙음", pass: has(after, '(초안)') },
      { name: '거절한 제목이 남지 않음', pass: !has(after, '2027년도 사업계획서(안)') },
    ],
  },

  // ── 참고 파일(첨부) ── 견본은 `python scripts/doogle/make-attach-fixtures.py` 가 eval/.fixtures/attach/ 에 만든다
  {
    id: 'attach-fill-form',
    doc: '복학원서.hwpx',
    turns: [{ prompt: '붙인 파일의 정보로 복학원서를 채워줘.', attach: ['attach/복학생 정보.txt'] }],
    check: ({ after, record }) => {
      const want = ['박지우', '20221187', '전자공학과', '010-5555-0142', 'jiwoo.park@example.com'];
      return [
        { name: '파일의 값이 들어감', pass: want.every((w) => has(after, w)), detail: want.filter((w) => !has(after, w)).join(', ') },
        // 파일에 없는 값을 지어내지 않는다 — 지도교수·학부모 연락처는 파일에 없다
        { name: '파일에 없는 사람을 지어내지 않음', pass: !has(after, '홍길동') && !has(after, '김철수') },
        { name: '쓰기 실패 없음', pass: writes(record).every((c) => c.ok), detail: writes(record).filter((c) => !c.ok).map((c) => `${c.name}:${c.error?.code}`).join(' | ') },
        // 짧은 글은 턴 글에 통째로 실리므로 다시 읽을 필요가 없다 — 읽어도 감점은 아니고 오류만 없으면 된다
        noToolErrors(record),
      ];
    },
  },
  {
    id: 'attach-xlsx-table',
    doc: 'para-001.hwp',
    turns: [{ prompt: '붙인 엑셀의 "예산" 시트를 문서 맨 끝에 표로 넣어줘. 값은 파일에 있는 그대로.', attach: ['attach/예산.xlsx'] }],
    check: ({ before, after, record }) => [
      changed(before, after),
      { name: '표를 만듦', pass: used(record, 'create_table') },
      { name: '시트의 값이 들어감', pass: ['항목', '연수비', '교재비', '2026-07-20'].every((w) => has(after, w)) && (has(after, '150000') || has(after, '150,000')), detail: after.split('\n').slice(-8).join(' / ').slice(0, 400) },
      { name: '다른 시트는 넣지 않음', pass: !has(after, '총무과') },
      noToolErrors(record),
    ],
  },
  {
    id: 'attach-image-read',
    doc: 'para-001.hwp',
    // 그림 속 글자는 그림을 실제로 봐야 알 수 있다 — read_attachment 가 그림을 돌려주는 길을 본다
    turns: [{ prompt: '붙인 그림에 크게 적힌 글자를 문서 맨 끝에 새 문단으로 그대로 적어줘.', attach: ['attach/직인.png'] }],
    check: ({ after, record }) => [
      { name: '그림을 열어 봄', pass: calls(record, 'read_attachment').some((c) => c.ok) },
      { name: '그림 속 글자가 문서에 들어감', pass: has(after, 'SEAL-4096'), detail: after.split('\n').slice(-3).join(' / ').slice(0, 300) },
      noToolErrors(record),
    ],
  },
  {
    id: 'attach-long-hwp-question',
    doc: 'para-001.hwp',
    // 긴 한글 문서(약 50쪽)를 참고 파일로 — 통째로 싣지 않는다. 답이 뒤쪽에 있어 찾아 읽어야 한다
    turns: [{ prompt: '붙인 제안요청서에서 제안서는 몇 부를 내야 하고, 협상적격자가 되려면 기술평가가 배점한도의 몇 % 이상이어야 해? 문서는 고치지 말고 답만 해줘.', attach: ['kps-ai.hwp'] }],
    timeoutMs: 15 * 60_000,
    check: ({ before, after, record }) => {
      const answer = finalText(record).split(' ').join('');
      return [
        unchanged(before, after),
        { name: '참고 파일을 찾아 읽음', pass: calls(record, 'read_attachment').some((c) => c.ok) },
        { name: '두 값을 답함 (10부 · 85%)', pass: has(answer, '10부') && has(answer, '85%'), detail: finalText(record).slice(-300) },
        noToolErrors(record),
        callsAtMost(record, 8),
      ];
    },
  },
  {
    id: 'attach-pdf-question',
    doc: 'para-001.hwp',
    turns: [{ prompt: '붙인 규정에서 신청서 제출 기한과 정산 서류 제출 기한을 알려줘. 문서는 고치지 마.', attach: ['attach/지원규정.pdf'] }],
    check: ({ before, after, record }) => [
      unchanged(before, after),
      { name: '두 기한을 답함', pass: /7\s*일/.test(finalText(record)) && /14\s*일/.test(finalText(record)), detail: finalText(record).slice(-300) },
      noToolErrors(record),
    ],
  },
  {
    id: 'attach-later-turn',
    doc: 'para-001.hwp',
    // 한 번 붙인 파일은 그 대화에 남는다 — 다음 요청에서 다시 붙이지 않아도 읽을 수 있어야 한다
    turns: [
      { prompt: '이 파일은 나중에 쓸 참고 자료야. 지금은 문서를 고치지 말고 무슨 파일인지만 한 줄로 말해줘.', attach: ['attach/신청자.txt'] },
      '아까 붙인 파일에 있는 계좌번호를 문서 맨 끝에 새 문단으로 적어줘.',
    ],
    check: ({ after, record }) => [
      { name: '첫 턴에는 고치지 않음', pass: (record.turns[0].toolCalls ?? []).filter((c) => /^(insert_|replace_|apply_|create_|edit_|set_)/.test(c.name)).length === 0 },
      { name: '둘째 턴에 계좌번호가 들어감', pass: has(after, '110-234-567890'), detail: after.split('\n').slice(-3).join(' / ').slice(0, 300) },
      noToolErrors(record),
    ],
  },
];
