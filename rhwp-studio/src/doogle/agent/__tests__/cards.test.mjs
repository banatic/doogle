// 카드 — 파일에서 표 꺼내기, 엑셀 붙여 넣기, AI 초안 합치기(가린 값 되살리기 · 줄 채우기).
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/cards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTable, mapRows, tablePreview } from '../../attach/card-table.ts';
import { rowLine } from '../../attach/attach-core.ts';
import { columnEm, headerKeys, parseTsv } from '../../ui/card-editor.ts';
import { draftForModel, maskValue, mergeProposal } from '../../ui/card-ai.ts';

const ROSTER_TEXT = [
  '## 시트: 3학년 2반',
  rowLine(['3학년 2반 명렬표', '', '']),
  rowLine(['번호', '성명', '보호자 연락처']),
  rowLine(['1', '강서윤', '010-2201-4410']),
  rowLine(['2', '권도현', '010-3812-0927']),
  rowLine(['3', '김민재', '010-5530-1184']),
  '',
  rowLine(['작은 표', '']),
].join('\n');

test('extractTable: | 칸 | 줄 묶음 중 가장 큰 표, 빈 줄은 뺀다', () => {
  const t = extractTable(ROSTER_TEXT);
  assert.equal(t.length, 5);
  assert.deepEqual(t[1], ['번호', '성명', '보호자 연락처']);
  assert.deepEqual(t[4], ['3', '김민재', '010-5530-1184']);
});

test('extractTable: 표 줄이 없으면 TSV → CSV', () => {
  assert.deepEqual(extractTable('번호\t성명\n1\t강서윤\n'), [['번호', '성명'], ['1', '강서윤']]);
  assert.deepEqual(extractTable('번호,성명,주소\n1,"강서윤","서울, 마포"\n2,권도현'), [
    ['번호', '성명', '주소'], ['1', '강서윤', '서울, 마포'], ['2', '권도현', ''],
  ]);
  assert.deepEqual(extractTable('그냥 글입니다'), []);
});

test('tablePreview 는 앞 4줄과 전체 줄 수만 — 그 뒤 값은 보내지 않는다', () => {
  const t = extractTable(ROSTER_TEXT);
  const p = tablePreview(t, 4);
  assert.match(p, /^전체 5줄, 3칸/);
  assert.match(p, /3: "2", "권도현"/);
  assert.equal(p.includes('김민재'), false);
});

test('mapRows: 값 시작 줄과 열 짝대로, 빈 줄은 뺀다', () => {
  const t = extractTable(ROSTER_TEXT);
  assert.deepEqual(mapRows(t, 2, [1, 0, -1]), [['강서윤', '1', ''], ['권도현', '2', ''], ['김민재', '3', '']]);
});

test('parseTsv: 엑셀 복사 — 탭·줄, 따옴표 안 줄바꿈, 끝 빈 줄', () => {
  assert.deepEqual(parseTsv('1\t강서윤\r\n2\t"권\n도현"\r\n\r\n'), [['1', '강서윤'], ['2', '권\n도현']]);
});

test('headerKeys: 붙여 넣은 첫 줄을 항목 이름으로 — 못 쓰는 글자는 빈칸, 빈 칸은 지금 이름, 겹치면 번호', () => {
  assert.deepEqual(headerKeys(['번호', '성 명', ''], ['이름', '항목 2', '항목 3']), ['번호', '성 명', '항목 3']);
  assert.deepEqual(headerKeys(['연락처', '연락처', 'a.b[c]'], ['이름', '항목 2', '항목 3']), ['연락처', '연락처 2', 'a b c']);
  // 줄이 열보다 짧아도 열 수는 그대로
  assert.deepEqual(headerKeys(['번호'], ['이름', '항목 2']), ['번호', '항목 2']);
});

test('columnEm: 열 폭은 가장 긴 글에 맞추되 4.5~14em 사이', () => {
  assert.equal(columnEm([]), 4.5);
  assert.equal(columnEm(['1', '2']), 4.5);
  assert.equal(columnEm(['여', '2015-03-02']), 7.4); // 10자 × 0.6 + 1.4
  assert.equal(columnEm(['한빛초등학교']), 7.4); // 6자 × 1 + 1.4
  assert.equal(columnEm(['가'.repeat(40)]), 14);
});

test('maskValue 는 hub 와 같은 규칙', () => {
  assert.equal(maskValue('010-1234-5678'), '***-****-5678');
  assert.equal(maskValue('김하늘'), '김**');
});

const ME = {
  name: '내 인적 사항', icon: 'person', kind: 'item',
  fields: [{ key: '이름', desc: '', sensitive: false }, { key: '연락처', desc: '', sensitive: true }],
  values: { 이름: '김하늘', 연락처: '010-1234-5678' },
};

test('draftForModel: 민감 값은 가리고 표는 앞 3줄만', () => {
  assert.deepEqual(draftForModel(ME).values, { 이름: '김하늘', 연락처: '***-****-5678' });
  const table = {
    name: '명렬', icon: 'list', kind: 'table',
    fields: [{ key: '성명', desc: '', sensitive: false }, { key: '전화', desc: '', sensitive: true }],
    rows: [['가', '010-0000-0001'], ['나', '010-0000-0002'], ['다', '010-0000-0003'], ['라', '010-0000-0004']],
  };
  const m = draftForModel(table);
  assert.equal(m.totalRows, 4);
  assert.deepEqual(m.firstRows, [['가', '***-****-0001'], ['나', '***-****-0002'], ['다', '***-****-0003']]);
  assert.equal(JSON.stringify(m).includes('라'), false);
});

test('mergeProposal: 가린 모양 그대로 돌아온 민감 값은 원래 값으로, 바꾼 값은 그대로', () => {
  const proposal = {
    card: {
      name: '내 정보', icon: 'person', kind: 'item',
      fields: [...ME.fields, { key: '내선', desc: '학교 전화 내선', sensitive: false }],
      values: { 이름: '김하늘', 연락처: '***-****-5678', 내선: '302' },
    },
  };
  const merged = mergeProposal(proposal, ME, null);
  assert.deepEqual(merged.values, { 이름: '김하늘', 연락처: '010-1234-5678', 내선: '302' });
  const changed = mergeProposal({ card: { ...proposal.card, values: { ...proposal.card.values, 연락처: '010-9999-0000' } } }, ME, null);
  assert.equal(changed.values.연락처, '010-9999-0000');
});

test('mergeProposal: 파일(source)에서 줄을 채우고, 표를 고칠 때는 기존 줄을 항목 이름으로 옮긴다', () => {
  const t = extractTable(ROSTER_TEXT);
  const card = {
    name: '3학년 2반 명렬', icon: 'list', kind: 'table',
    fields: [{ key: '번호' }, { key: '성명' }, { key: '보호자 연락처', sensitive: true }],
  };
  const fromFile = mergeProposal({ card, source: { dataStart: 2, columns: [0, 1, 2] } }, null, t);
  assert.equal(fromFile.rows.length, 3);
  assert.deepEqual(fromFile.rows[2], ['3', '김민재', '010-5530-1184']);

  const reordered = mergeProposal({
    card: { ...card, fields: [{ key: '성명' }, { key: '번호' }, { key: '비고' }] },
  }, fromFile, null);
  assert.deepEqual(reordered.rows[0], ['강서윤', '1', '']);
  assert.equal(reordered.rows.length, 3);
});
