// 실제 엔진 탐침 2 — 문서에 따라 고른다.
//   node eval/probe.mjs kps-ai.hwp eval/probes/nested-and-fill.mjs            (중첩 표)
//   node eval/probe.mjs "통합재정통계(2014.8월).hwp" eval/probes/nested-and-fill.mjs   (머리행 채움)
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

export default async ({ tool }) => {
  const info = (await tool('get_document_info')).result;
  const log = [];
  if (String(info.name).includes('kps-ai')) {
    // 중첩 표 안의 글을 찾고(주소 포함) 구조에서도 보인다
    const found = await tool('find_text', { query: '6개월' });
    const nested = found.result.matches.find((m) => m.cellPath);
    assert.ok(nested, JSON.stringify(found.result.matches));
    assert.equal(nested.cell.paraIdx, 674);
    assert.ok(nested.context.includes('6개월'), `context: ${nested.context}`);
    log.push(`find_text 중첩 셀: cell ${JSON.stringify(nested.cell)} cellPath ${JSON.stringify(nested.cellPath)} "${nested.context}"`);

    const t0 = Date.now();
    const st = await tool('get_structure', { range: { sectionIdx: 0, fromPara: 674, toPara: 674 }, text: 'full' });
    const text = String(st.result.text);
    assert.match(text, /▦/);
    assert.match(text, /nested table in \[2\] 29x7 · cell \{paraIdx:674,controlIdx:0,cellIdx:2\} \+ cellPath/);
    log.push(`get_structure 중첩 표: ${Date.now() - t0}ms\n${text.split('\n').slice(1, 9).map((l) => l.slice(0, 150)).join('\n')}`);

    // 그 주소로 바로 고친다
    const fix = await tool('replace_range', { expectedRevision: st.result.revision, paraIdx: nested.paraIdx, cell: nested.cell, cellPath: nested.cellPath, find: '6개월', text: '8개월' });
    assert.ok(fix.ok, JSON.stringify(fix));
    const again = await tool('find_text', { query: '8개월' });
    assert.ok(again.result.matches.some((m) => m.cellPath && m.cell.paraIdx === 674));
    log.push('중첩 셀 편집: find_text 주소 그대로 replace_range 성공');

    // 문서 전체 구조 읽기 시간 (중첩 표 탐색 포함)
    const t1 = Date.now();
    const all = await tool('get_structure', {});
    log.push(`get_structure 전체(841문단): ${Date.now() - t1}ms, ${String(all.result.text).length.toLocaleString()}자`);
    return log;
  }

  // 자기 채움(#ccffcc)이 있는 머리행에 영역 채움을 넣어도 화면이 실제로 바뀐다
  const at = { sectionIdx: 0, paraIdx: 6, controlIdx: 0 };
  const z = await tool('set_zone_borders', { expectedRevision: info.revision, ...at, startCell: { row: 0, col: 0 }, endCell: { row: 0, col: 7 }, fillColor: '#E7E6E6' });
  assert.ok(z.ok, JSON.stringify(z));
  assert.equal(z.result.filledCells, 7);
  const img = await tool('render_page', { pageIndex: 0, scale: 1, regionMm: { x: 20, y: 68, width: 170, height: 14 } });
  if (process.env.OUT_PNG) writeFileSync(process.env.OUT_PNG, Buffer.from(img.result.image.base64, 'base64'));
  log.push(`set_zone_borders fillColor: ${z.result.filledCells}칸 채움`);
  return log;
};
