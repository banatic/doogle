// 실제 엔진으로 도구 동작을 확인하는 탐침 (모델 호출 없음).
//   node eval/probe.mjs biz_plan.hwp eval/probes/real-engine.mjs full
// 평가에서 찾은 결함이 진짜 문서·진짜 엔진에서 고쳐졌는지 본다. 실패하면 던진다.
import assert from 'node:assert/strict';

export default async ({ tool, session, page }) => {
  const rev = async () => (await tool('get_document_info')).result.revision;
  const lines = async (from, to) => String((await tool('get_structure', { range: { sectionIdx: 0, fromPara: from, toPara: to } })).result.text).split('\n');
  const log = [];

  // 1) 범례는 결과에 없다
  const head = await lines(88, 92);
  assert.match(head[0], /^revision \d+ · 6 pages/);
  assert.match(head[1], /^s0 · 93 paragraphs/, '머리 줄 다음이 바로 본문');
  log.push('get_structure: 범례 없음');

  // 2) 표로 끝나는 마지막 문단(p92) — 글 덧붙이기는 막고, insert_paragraphs 는 표 뒤에 넣는다
  const blocked = await tool('insert_text', { expectedRevision: await rev(), paraIdx: 92, text: '\n추진 일정' });
  assert.equal(blocked.error?.code, 'OBJECT_AT_PARAGRAPH_END', JSON.stringify(blocked));
  const added = await tool('insert_paragraphs', { expectedRevision: await rev(), paraIdx: 92, paragraphs: ['', '추진 일정'], formatFrom: 81 });
  assert.ok(added.ok, JSON.stringify(added));
  assert.deepEqual(added.result.inserted, { sectionIdx: 0, firstParaIdx: 93, lastParaIdx: 94 });
  const tail = (await lines(91, 94)).join('\n');
  assert.match(tail, /table s0 p92 c0 5x2/, '표는 p92 에 그대로');
  assert.match(tail, /s0 p94 \(5 B\) 추진 일정/, 'formatFrom(7. 보고계획)의 굵게를 따른다');
  log.push('insert_paragraphs: 표 뒤 삽입 + 서식 복사');

  // 3) 표를 삼키는 범위 삭제는 거절
  const swallow = await tool('delete_range', { expectedRevision: await rev(), startParaIdx: 90, startCharOffset: 0, endParaIdx: 92, endCharOffset: 0 });
  assert.equal(swallow.error?.code, 'RANGE_HAS_OBJECTS', JSON.stringify(swallow));
  assert.match((await lines(92, 92)).join('\n'), /table s0 p92 c0 5x2/);
  log.push('delete_range: 표가 걸리면 거절');

  // 4) 굵은 제목 뒤에 본문 서식(formatFrom 48)의 빈 문단을 넣고 거기에 표를 만든다.
  //    - 표는 본문 폭 안에 든다(전에는 앞 문단의 왼쪽 여백만큼 밀려 4.3mm 넘쳤다)
  //    - 셀 글자는 굵지 않다(전에는 빈 문단이 앞 제목의 굵게를 물려받아 첫 열이 굵게 나왔다)
  const host = await tool('insert_paragraphs', { expectedRevision: await rev(), paraIdx: 94, paragraphs: [''], formatFrom: 48 });
  assert.ok(host.ok, JSON.stringify(host));
  const table = await tool('create_table', { expectedRevision: await rev(), sectionIdx: 0, paraIdx: 95, charOffset: 0, cells: [['단계', '기간', '담당'], ['기획', '', '']], headerRow: true });
  assert.ok(table.ok, JSON.stringify(table));
  assert.equal(table.result.after.warnings, undefined, JSON.stringify(table.result.after));
  const at = { sectionIdx: 0, paraIdx: table.result.paraIdx, controlIdx: table.result.controlIdx };
  const grid = (await lines(at.paraIdx, at.paraIdx)).join('\n');
  assert.match(grid, /r0 \[0 B\] 단계 \| \[1 B\] 기간 \| \[2 B\] 담당/, grid);
  assert.match(grid, /r1 \[3\] 기획/, `머리행만 굵다: ${grid}`);
  const layout = await tool('get_table_layout', { paraIdx: at.paraIdx, controlIdx: at.controlIdx });
  assert.equal(layout.result.overflowsBodyWidth, false, JSON.stringify(layout.result));
  const tprops = await tool('get_table_properties', at);
  assert.equal(tprops.result.positionMode, 'inline', '본문 표는 글자처럼 취급');
  log.push(`create_table: 본문 폭 안, 글자처럼 취급, 머리행만 굵게${table.result.fitted ? ` (${table.result.fitted})` : ''}`);
  const row = await tool('edit_table', { expectedRevision: await rev(), ...at, op: 'insert_row', rowIdx: 1 });
  assert.ok(row.ok, JSON.stringify(row));
  assert.deepEqual(row.result.newRow, { rowIdx: 2, cellIdxs: [6, 7, 8] });
  log.push('edit_table insert_row: newRow.cellIdxs');

  // 5) 여러 셀 서식·배경을 한 번에
  const fmt = await tool('apply_para_format', { expectedRevision: await rev(), cells: { paraIdx: at.paraIdx, controlIdx: at.controlIdx, cellIdxs: [[3, 8]] }, alignment: 'center' });
  assert.ok(fmt.ok, JSON.stringify(fmt));
  assert.equal(fmt.result.cells, 6);
  const fill = await tool('set_cell_props', { expectedRevision: await rev(), ...at, cellIdxs: [[0, 2]], cellProps: { fillColor: '#E7E6E6' } });
  assert.ok(fill.ok, JSON.stringify(fill));
  const props = await tool('get_table_properties', { ...at, cellIdx: 1 });
  assert.equal(String(props.result.cell.fillColor).toLowerCase(), '#e7e6e6');
  log.push('cells / cellIdxs: 여러 셀 한 번에');

  // 6) 문단 이동 — 표가 든 문단 묶음(5. 사업추진조직 + 가. + 표)을 문서 끝으로
  const before = (await lines(68, 70)).join('\n');
  assert.match(before, /s0 p68 \(9 B\) 5\. 사업추진조직/);
  const count = Number(/s0 · (\d+) paragraphs/.exec((await lines(0, 0))[1])[1]);
  const moved = await tool('move_paragraphs', { expectedRevision: await rev(), startParaIdx: 68, endParaIdx: 70, toParaIdx: count - 1, where: 'after' });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.deepEqual(moved.result.moved.to, [count - 3, count - 1]);
  const end = (await lines(count - 3, count - 1)).join('\n');
  assert.match(end, /\(9 B\) 5\. 사업추진조직/, '글자 모양 유지');
  assert.match(end, /table s0 p\d+ c0 5x6/, '표가 따라온다');
  assert.equal(Number(/s0 · (\d+) paragraphs/.exec((await lines(0, 0))[1])[1]), count, '문단 수는 그대로');
  assert.doesNotMatch((await lines(66, 70)).join('\n'), /5\. 사업추진조직/);
  log.push('move_paragraphs: 서식·표 유지');

  // 7) 문단 삭제 — 표가 든 문단은 includeObjects 없이는 거절
  const refuse = await tool('delete_paragraphs', { expectedRevision: await rev(), startParaIdx: count - 3, endParaIdx: count - 1 });
  assert.equal(refuse.error?.code, 'RANGE_HAS_OBJECTS');
  const gone = await tool('delete_paragraphs', { expectedRevision: await rev(), startParaIdx: count - 3, endParaIdx: count - 1, includeObjects: true });
  assert.ok(gone.ok, JSON.stringify(gone));
  assert.equal(gone.result.deletedParagraphs, 3);
  log.push('delete_paragraphs: 개체 보호');

  // 8) 탈출구: 틀린 인자는 엔진에 닿지 않는다 (전에는 memory access out of bounds)
  const trap = await tool('prepare_engine_edit_session', { expectedRevision: await rev(), method: 'copyControl', args: [0, 89, 0] });
  assert.equal(trap.error?.code, 'INVALID_ARGS', JSON.stringify(trap));
  const alive = await tool('get_document_info');
  assert.ok(alive.ok, '엔진이 살아 있다');
  log.push('engine escape hatch: 인자 검사');

  // 9) 실패한 배치는 문서를 잠그지 않는다
  const failed = await tool('apply_edits', { expectedRevision: await rev(), edits: [
    { tool: 'replace_range', paraIdx: 47, find: '사업명', text: '프로젝트명' },
    { tool: 'replace_range', paraIdx: 48, find: '없는글자열XYZ', text: 'x' },
  ] });
  assert.equal(failed.error?.code, 'BATCH_FAILED', JSON.stringify(failed));
  const next = await tool('replace_range', { expectedRevision: await rev(), paraIdx: 47, find: '사업명', text: '프로젝트명' });
  assert.ok(next.ok, JSON.stringify(next));
  log.push('apply_edits 실패 뒤에도 편집 가능');

  // 10) 검토에서 거절한 뒤의 실패도 문서를 잠그지 않는다 (화면 캡처 흐름에서 EDITOR_BLOCKED 가 났던 순서)
  if (await session.review('reject')) {
    const state = () => page.evaluate(() => window.__inputHandler?.getCommandErrorState?.()?.status);
    const miss = await tool('replace_range', { expectedRevision: await rev(), paraIdx: 47, find: '없는 글', text: 'x' });
    assert.equal(miss.error?.code, 'INVALID_ARGS', JSON.stringify(miss));
    assert.equal(await state(), 'ready');
    const stale = await tool('replace_range', { expectedRevision: 1, paraIdx: 47, find: '사업명', text: '프로젝트명' });
    assert.equal(stale.error?.code, 'REVISION_MISMATCH', JSON.stringify(stale));
    assert.equal(await state(), 'ready');
    const fine = await tool('replace_range', { expectedRevision: await rev(), paraIdx: 47, find: '사업명', text: '프로젝트명' });
    assert.ok(fine.ok, JSON.stringify(fine));
    log.push('거절 뒤 실패한 편집: 잠기지 않음');
  }

  return log;
};
