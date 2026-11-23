// 시험지 서식 만들기 사용자 보고의 회귀 테스트 — 에이전트 되돌리기, 꼬리말 표 칸 편집, 빈 줄 글자 크기,
// 중첩(경로) 표 크기·구조·속성, 다단 적용 범위(set_columns), 문단을 지운 뒤 낡은 문단 번호.
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/agent-fixes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoogleAgentRuntime } from '../runtime.ts';
import { EditJournal } from '../edit-journal.ts';

/**
 * 본문 문단 + 꼬리말 하나를 흉내 내는 엔진. 꼬리말 컨트롤은 본문 p0 의 컨트롤 1 이고, 꼬리말 문단 1 에
 * 1x2 표(컨트롤 0)가 있다 — 엔진 *ByPath API 처럼 [{1,0,hp},{0,cell,cp}] 경로로 닿는다.
 */
class FakeDoc {
  constructor(paragraphs, { footer = true } = {}) {
    this.state = {
      paras: [...paragraphs],
      footer: footer ? {
        paras: ['- 쪽 -', ''],
        // 꼬리말 문단 1 의 표: 셀마다 문단 목록, 폭·높이(HU)
        table: { hostPara: 1, cells: [['문항 수'], ['3']], width: [8000, 4000], height: [1000, 1000] },
      } : null,
    };
    this.snaps = new Map();
    this.next = 1;
    this.calls = [];
  }
  get paras() { return this.state.paras; }
  set paras(v) { this.state.paras = v; }
  // ── 본문 ──
  getSectionCount() { return 1; }
  getParagraphCount() { return this.paras.length; }
  pageCount() { return 1; }
  getDocumentInfo() { return JSON.stringify({ pageCount: 1, sectionCount: 1 }); }
  check(p) { if (p < 0 || p >= this.paras.length) throw new Error(`para ${p} out of range`); }
  getParagraphLength(_s, p) { this.check(p); return [...this.paras[p]].length; }
  getTextRange(_s, p, off, n) { this.check(p); return [...this.paras[p]].slice(off, off + n).join(''); }
  insertText(_s, p, off, text) {
    this.check(p);
    const c = [...this.paras[p]];
    this.paras[p] = c.slice(0, off).join('') + text + c.slice(off).join('');
    return '{"ok":true}';
  }
  deleteText(_s, p, off, n) { this.check(p); const c = [...this.paras[p]]; c.splice(off, n); this.paras[p] = c.join(''); return '{"ok":true}'; }
  replaceText(_s, p, off, n, text) { this.deleteText(0, p, off, n); return this.insertText(0, p, off, text); }
  splitParagraph(_s, p, off) { const c = [...this.paras[p]]; this.paras.splice(p, 1, c.slice(0, off).join(''), c.slice(off).join('')); return '{"ok":true}'; }
  insertParagraph(_s, p) { this.paras.splice(p, 0, ''); return '{"ok":true}'; }
  deleteParagraph(_s, p) { this.check(p); this.paras.splice(p, 1); return '{"ok":true}'; }
  searchAllText(q, cs) {
    const out = [];
    this.paras.forEach((t, para) => {
      const hay = cs ? t : t.toLowerCase(); const n = cs ? q : q.toLowerCase();
      for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) out.push({ sec: 0, para, charOffset: [...t.slice(0, i)].length, length: [...q].length });
    });
    return JSON.stringify(out);
  }
  getObjects() { return '[]'; }
  getCharShapeRuns(_s, _p, start, end) { return JSON.stringify([{ startOffset: start, endOffset: end, charShapeId: 0 }]); }
  getCharPropertiesAt() { return JSON.stringify({ fontSize: 1000 }); }
  getParaPropertiesAt() { return JSON.stringify({ headType: 'None' }); }
  applyCharFormat(_s, p, start, end, json) { this.check(p); this.calls.push(['applyCharFormat', p, start, end, JSON.parse(json)]); return '{"ok":true}'; }
  getPageOfPosition() { return JSON.stringify({ ok: true, page: 0 }); }
  getPageDef() { return JSON.stringify({ width: 59528, marginLeft: 8504, marginRight: 8504 }); }
  // ── 스냅샷 ──
  saveSnapshot() { const id = this.next++; this.snaps.set(id, structuredClone(this.state)); return id; }
  restoreSnapshot(id) { const s = this.snaps.get(id); if (!s) throw new Error('no snapshot'); this.state = structuredClone(s); return '{"ok":true}'; }
  discardSnapshot(id) { this.snaps.delete(id); }
  // ── 꼬리말 ──
  getHeaderFooterList() {
    return JSON.stringify({ ok: true, items: this.state.footer ? [{ sectionIdx: 0, isHeader: false, applyTo: 0 }] : [], currentIndex: -1 });
  }
  getHeaderFooter(_s, isHeader) {
    const f = this.state.footer;
    if (isHeader || !f) return JSON.stringify({ ok: true, exists: false });
    return JSON.stringify({ ok: true, exists: true, kind: 'footer', applyTo: 0, paraIndex: 0, controlIndex: 1, paraCount: f.paras.length, text: f.paras.join('\n') });
  }
  /** 경로 → 그 문단이 든 배열과 번호 */
  at(ppi, pathJson) {
    const path = JSON.parse(pathJson);
    const f = this.state.footer;
    if (ppi !== 0 || !f || path[0].controlIndex !== 1 || path[0].cellIndex !== 0) throw new Error(`path ${pathJson} is not in the footer`);
    if (path.length === 1) return { arr: f.paras, idx: path[0].cellParaIndex };
    if (path[0].cellParaIndex !== f.table.hostPara || path[1].controlIndex !== 0) throw new Error(`path ${pathJson}: no table`);
    const cell = f.table.cells[path[1].cellIndex];
    if (!cell) throw new Error('cell out of range');
    return { arr: cell, idx: path[path.length - 1].cellParaIndex, cell: path[1].cellIndex };
  }
  getCellParagraphCountByPath(_s, ppi, pathJson) { return this.at(ppi, pathJson).arr.length; }
  getCellParagraphLengthByPath(_s, ppi, pathJson) { const r = this.at(ppi, pathJson); return [...(r.arr[r.idx] ?? '')].length; }
  getTextInCellByPath(_s, ppi, pathJson, off, n) { const r = this.at(ppi, pathJson); return [...r.arr[r.idx]].slice(off, off + n).join(''); }
  insertTextInCellByPath(_s, ppi, pathJson, off, text) {
    const r = this.at(ppi, pathJson);
    if (JSON.parse(pathJson).length === 1) throw new Error('depth-1 cell path goes to the flat table API (not a table)');
    const c = [...r.arr[r.idx]];
    r.arr[r.idx] = c.slice(0, off).join('') + text + c.slice(off).join('');
    return '{"ok":true}';
  }
  deleteRangeInCellByPath(_s, ppi, pathJson, sp, so, ep, eo) {
    const r = this.at(ppi, pathJson);
    if (JSON.parse(pathJson).length === 1) throw new Error('depth-1 cell path goes to the flat table API (not a table)');
    if (sp !== ep) throw new Error('fake: one paragraph only');
    const c = [...r.arr[sp]]; c.splice(so, eo - so); r.arr[sp] = c.join('');
    return '{"ok":true}';
  }
  replaceRangeInHeaderFooter(_s, isHeader, _ap, sp, so, ep, eo, text) {
    if (isHeader || sp !== ep) throw new Error('fake: footer, one paragraph');
    const arr = this.state.footer.paras;
    const c = [...arr[sp]];
    arr[sp] = c.slice(0, so).join('') + text + c.slice(eo).join('');
    this.calls.push(['replaceRangeInHeaderFooter', sp, so, eo, text]);
    return '{"ok":true}';
  }
  deleteHeaderFooter() { this.calls.push(['deleteHeaderFooter']); this.state.footer = null; return '{"ok":true}'; }
  getCharShapeRunsInCellByPath() { return '[]'; }
  getCellCharPropertiesAtByPath() { return JSON.stringify({ fontSize: 1000 }); }
  getCellParaPropertiesAtByPath() { return '{}'; }
  getTableDimensionsByPath(_s, ppi, pathJson) { this.at(ppi, pathJson); return JSON.stringify({ rowCount: 1, colCount: 2, cellCount: 2 }); }
  getCellInfoByPath(_s, ppi, pathJson) { const r = this.at(ppi, pathJson); return JSON.stringify({ row: 0, col: r.cell, rowSpan: 1, colSpan: 1 }); }
  getTableControlsInSelection(_s, ppi, containerJson) {
    const path = JSON.parse(containerJson);
    if (ppi !== 0 || path.length !== 1 || path[0].controlIndex !== 1 || !this.state.footer) return '[]';
    const hp = this.state.footer.table.hostPara;
    return JSON.stringify([{ sec: 0, ppi: 0, ci: 1, cellPath: [{ controlIndex: 1, cellIndex: 0, cellParaIndex: hp }, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }] }]);
  }
  getCellPropertiesByPath(_s, ppi, pathJson, cellIdx) {
    this.at(ppi, pathJson);
    const t = this.state.footer.table;
    return JSON.stringify({ width: t.width[cellIdx], height: t.height[cellIdx], paddingLeft: 0, paddingRight: 0 });
  }
  resizeTableCellsByPath(_s, ppi, pathJson, json) {
    this.at(ppi, pathJson);
    const t = this.state.footer.table;
    const updates = JSON.parse(json);
    this.calls.push(['resizeTableCellsByPath', updates]);
    for (const u of updates) {
      t.width[u.cellIdx] += u.widthDelta ?? 0;
      t.height[u.cellIdx] += u.heightDelta ?? 0;
    }
    return '{"ok":true}';
  }
}

function fakeDeps(doc, extra = {}) {
  return {
    getDocument: () => doc,
    transaction: (_label, fn) => {
      const before = structuredClone(doc.state);
      try { return fn(doc); } catch (e) { doc.state = before; throw e; }
    },
    ...extra,
  };
}

function eventSource() {
  const handlers = new Map();
  return {
    on(name, h) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(h); return () => {}; },
    emit(name, payload) { for (const h of handlers.get(name) ?? []) h(payload); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const full = { origin: 'mcp', mode: 'full' };

// ─── 1. 되돌리기 ───────────────────────────────────────

test('undo (전체 모드): the agent takes back its own last writes one by one, without Ctrl+Z', async () => {
  const doc = new FakeDoc(['하나', '둘', '셋'], { footer: false });
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: 'A' }, full)).ok);
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 1, text: 'B' }, full)).ok);
  assert.deepEqual(doc.paras, ['하나A', '둘B', '셋']);
  const u1 = await rt.executeTool('undo', { expectedRevision: rt.revision() }, full);
  assert.ok(u1.ok, JSON.stringify(u1));
  assert.equal(u1.result.undone, 1);
  assert.equal(u1.result.mode, 'direct');
  assert.deepEqual(doc.paras, ['하나A', '둘', '셋']);
  const u2 = await rt.executeTool('undo', { expectedRevision: rt.revision() }, full);
  assert.ok(u2.ok, JSON.stringify(u2));
  assert.deepEqual(doc.paras, ['하나', '둘', '셋']);
  const none = await rt.executeTool('undo', { expectedRevision: rt.revision() }, full);
  assert.equal(none.error?.code, 'NOTHING_TO_UNDO');
  // count 로 여러 개를 한 번에
  for (const t of ['x', 'y', 'z']) assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 2, text: t }, full)).ok);
  const many = await rt.executeTool('undo', { expectedRevision: rt.revision(), count: 2 }, full);
  assert.ok(many.ok, JSON.stringify(many));
  assert.deepEqual(doc.paras, ['하나', '둘', '셋x']);
  assert.deepEqual(many.result.edits.map((e) => e.summary), ['insert "z"', 'insert "y"']);
  rt.dispose();
  assert.equal(doc.snaps.size, 0, 'undo points are released');
});

test('undo refuses (and changes nothing) when the user edited after the agent', async () => {
  const doc = new FakeDoc(['가', '나'], { footer: false });
  const events = eventSource();
  const rt = createDoogleAgentRuntime(fakeDeps(doc, { events }));
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: '1' }, full)).ok);
  await tick();
  doc.paras[1] += 'U'; // 사용자 직접 편집
  events.emit('document-changed');
  const r = await rt.executeTool('undo', { expectedRevision: rt.revision() }, full);
  assert.equal(r.error?.code, 'UNDO_BLOCKED');
  assert.deepEqual(doc.paras, ['가1', '나U']);
  const stale = await rt.executeTool('undo', { expectedRevision: rt.revision() - 1 }, full);
  assert.equal(stale.error?.code, 'REVISION_MISMATCH');
});

test('undo (에이전트 모드): drops the last staged edits from the review list and restores the document', async () => {
  const doc = new FakeDoc(['원문', '둘'], { footer: false });
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const ctx = { origin: 'agent', threadId: 'A', mode: 'agent' };
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: ' 1' }, ctx)).ok);
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 1, text: ' 2' }, ctx)).ok);
  assert.equal(rt.pending.list('A').length, 2);
  const u = await rt.executeTool('undo', { expectedRevision: rt.revision() }, ctx);
  assert.ok(u.ok, JSON.stringify(u));
  assert.equal(u.result.mode, 'staged');
  assert.deepEqual(doc.paras, ['원문 1', '둘']);
  assert.equal(rt.pending.list('A').length, 1);
  // 에이전트 스스로 되돌린 것이라 "사용자가 거절했다" 보고가 붙지 않는다
  const next = await rt.executeTool('get_text_range', { paraIdx: 0 }, ctx);
  assert.equal(next.result.editReport, undefined);
  // 사용자가 적용(✓)한 행은 되돌리지 않는다
  rt.pending.accept(rt.pending.list('A')[0].id);
  const kept = await rt.executeTool('undo', { expectedRevision: rt.revision() }, ctx);
  assert.equal(kept.error?.code, 'NOTHING_TO_UNDO');
});

// ─── 2. 꼬리말 표 칸 ────────────────────────────────────

test('footer table cells: get_structure lists them with cell + cellPath; find + replace_range edits the cell', async () => {
  const doc = new FakeDoc(['본문 첫 줄', '둘째 줄']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const s = await rt.executeTool('get_structure', {}, full);
  assert.ok(s.ok, JSON.stringify(s));
  assert.match(s.result.text, /footer s0 \(both\) · cell \{paraIdx:0,controlIdx:1,cellIdx:0\}/);
  assert.match(s.result.text, /p0 \(5\) - 쪽 -/);
  assert.match(s.result.text, /table in footer p1 1x2 · cell \{paraIdx:0,controlIdx:1,cellIdx:0\} \+ cellPath \[\{"controlIndex":1,"cellIndex":0,"cellParaIndex":1\},\{"controlIndex":0,"cellIndex":n,"cellParaIndex":0\}\]/);
  assert.match(s.result.text, /r0 \[0\] 문항 수 \| \[1\] 3/);
  // find_text 가 꼬리말 칸도 찾는다 — 그 주소를 그대로 쓰기에 쓴다
  const f = await rt.executeTool('find_text', { query: '3' }, full);
  assert.equal(f.result.matches.length, 1);
  const m = f.result.matches[0];
  assert.deepEqual(m.cell, { paraIdx: 0, controlIdx: 1, cellIdx: 0 });
  assert.deepEqual(m.cellPath, [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 1 }, { controlIndex: 0, cellIndex: 1, cellParaIndex: 0 }]);
  const w = await rt.executeTool('replace_range', { expectedRevision: rt.revision(), find: '3', text: '25' }, full);
  assert.ok(w.ok, JSON.stringify(w));
  assert.deepEqual(doc.state.footer.table.cells[1], ['25']);
  // 좌표로도: 바깥 주소 + cellPath, paraIdx 는 그 칸 안 문단
  const w2 = await rt.executeTool('insert_text', {
    expectedRevision: rt.revision(), cell: m.cell, cellPath: m.cellPath, paraIdx: 0, charOffset: 2, text: '문항',
  }, full);
  assert.ok(w2.ok, JSON.stringify(w2));
  assert.deepEqual(doc.state.footer.table.cells[1], ['25문항']);
  // 꼬리말 문단 자체(표 밖)는 꼬리말 API 로 간다
  const w3 = await rt.executeTool('replace_range', { expectedRevision: rt.revision(), find: '쪽', text: 'page' }, full);
  assert.ok(w3.ok, JSON.stringify(w3));
  assert.equal(doc.state.footer.paras[0], '- page -');
  assert.ok(doc.calls.some((c) => c[0] === 'replaceRangeInHeaderFooter'));
  // 틀린 경로는 엔진에 닿기 전에 걸러진다
  const badPath = await rt.executeTool('insert_text', {
    expectedRevision: rt.revision(), cell: m.cell, cellPath: [m.cellPath[0], { controlIndex: 0, cellIndex: 9, cellParaIndex: 0 }], paraIdx: 0, text: 'x',
  }, full);
  assert.equal(badPath.error?.code, 'INVALID_ARGS');
});

test('edit_header_footer refuses to rebuild a footer that holds a table (it would delete it)', async () => {
  const doc = new FakeDoc(['본문']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const r = await rt.executeTool('edit_header_footer', { expectedRevision: rt.revision(), which: 'footer', lines: ['새 꼬리말'] }, full);
  assert.equal(r.error?.code, 'RANGE_HAS_OBJECTS');
  assert.match(r.error.message, /cellPath/);
  assert.ok(doc.state.footer, 'footer (and its table) untouched');
  assert.equal(doc.calls.some((c) => c[0] === 'deleteHeaderFooter'), false);
});

// ─── 3. 빈 줄 글자 크기 ─────────────────────────────────

test('apply_char_format reaches empty paragraphs (their end-of-paragraph shape sets the blank line height)', async () => {
  const doc = new FakeDoc(['제목', '', '본문'], { footer: false });
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const one = await rt.executeTool('apply_char_format', { expectedRevision: rt.revision(), paraIdx: 1, fontSizePt: 6 }, full);
  assert.ok(one.ok, JSON.stringify(one));
  assert.deepEqual(doc.calls.filter((c) => c[0] === 'applyCharFormat').map((c) => c.slice(1, 4)), [[1, 0, 0]]);
  doc.calls.length = 0;
  const many = await rt.executeTool('apply_char_format', { expectedRevision: rt.revision(), paras: [[0, 2]], fontSizePt: 12 }, full);
  assert.ok(many.ok, JSON.stringify(many));
  assert.equal(many.result.paragraphs, 3);
  assert.equal(many.result.emptyParagraphs, 1);
  assert.deepEqual(doc.calls.filter((c) => c[0] === 'applyCharFormat').map((c) => c.slice(1, 4)), [[0, 0, 2], [1, 0, 0], [2, 0, 2]]);
});

// ─── 4. 경로 표(중첩·꼬리말) 크기 ───────────────────────

test('table size tools address a path table (nested / in a footer) via cellPath', async () => {
  const doc = new FakeDoc(['본문']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const cellPath = [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 1 }, { controlIndex: 0, cellIndex: 'n', cellParaIndex: 0 }];
  const addr = { expectedRevision: 0, paraIdx: 0, controlIdx: 1, cellPath };
  const props = await rt.executeTool('get_table_properties', { paraIdx: 0, controlIdx: 1, cellPath }, full);
  assert.ok(props.ok, JSON.stringify(props));
  assert.equal(props.result.nested, true);
  assert.equal(props.result.inHeaderFooter, true);
  assert.equal(props.result.columnWidthsMm.length, 2);
  const widths = await rt.executeTool('edit_table', { ...addr, expectedRevision: rt.revision(), op: 'set_column_widths', columnWidthsMm: [20, 40] }, full);
  assert.ok(widths.ok, JSON.stringify(widths));
  assert.deepEqual(widths.result.columnWidthsMm, [20, 40]);
  const rows = await rt.executeTool('edit_table', { ...addr, expectedRevision: rt.revision(), op: 'set_row_heights', rowHeightsMm: [10] }, full);
  assert.ok(rows.ok, JSON.stringify(rows));
  assert.deepEqual(doc.state.footer.table.height, [2835, 2835]);
  const cell = await rt.executeTool('set_cell_props', { ...addr, expectedRevision: rt.revision(), cellIdx: 1, cellProps: { widthMm: 30 } }, full);
  assert.ok(cell.ok, JSON.stringify(cell));
  assert.equal(doc.state.footer.table.width[1], 8504);
  // 경로 표에 없는 연산은 무엇이 되는지와 함께 거절
  const fill = await rt.executeTool('set_cell_props', { ...addr, expectedRevision: rt.revision(), cellIdx: 1, cellProps: { fillColor: '#FF0000' } }, full);
  assert.equal(fill.error?.code, 'ENGINE_UNSUPPORTED');
  const row = await rt.executeTool('edit_table', { ...addr, expectedRevision: rt.revision(), op: 'insert_row', rowIdx: 0 }, full);
  assert.equal(row.error?.code, 'ENGINE_UNSUPPORTED');
  assert.match(row.error.message, /set_column_widths/);
});

/** 경로 표 쓰기(*ByPath)가 있는 새 엔진 빌드 — 꼬리말 표를 행·열·병합·속성까지 고친다 */
class PathTableDoc extends FakeDoc {
  constructor(paragraphs) {
    super(paragraphs);
    this.state.footer.table.dims = { rows: 1, cols: 2 };
    this.state.footer.table.props = [{}, {}];
  }
  get table() { return this.state.footer.table; }
  /** 경로가 꼬리말 표(그 자체)를 가리키는지 — 마지막 항목이 표 컨트롤 0 */
  tablePath(ppi, pathJson) {
    const path = JSON.parse(pathJson);
    if (path.length !== 2 || path[1].controlIndex !== 0) throw new Error(`table path ${pathJson}: last entry must be the table control`);
    this.at(ppi, JSON.stringify([path[0], { ...path[1], cellIndex: 0 }]));
    return path;
  }
  getTableDimensionsByPath(_s, ppi, pathJson) {
    this.at(ppi, pathJson);
    const { rows, cols } = this.table.dims;
    return JSON.stringify({ rowCount: rows, colCount: cols, cellCount: rows * cols });
  }
  getCellInfoByPath(_s, ppi, pathJson) {
    const r = this.at(ppi, pathJson);
    const { cols } = this.table.dims;
    return JSON.stringify({ row: Math.floor(r.cell / cols), col: r.cell % cols, rowSpan: 1, colSpan: 1 });
  }
  grow(n) {
    for (let i = 0; i < n; i++) { this.table.cells.push(['']); this.table.width.push(4000); this.table.height.push(1000); this.table.props.push({}); }
  }
  insertTableRowByPath(_s, ppi, pathJson, row, below) {
    this.tablePath(ppi, pathJson);
    this.calls.push(['insertTableRowByPath', row, below]);
    this.table.dims.rows++;
    this.grow(this.table.dims.cols);
    return JSON.stringify({ ok: true, rowCount: this.table.dims.rows, colCount: this.table.dims.cols });
  }
  deleteTableColumnByPath(_s, ppi, pathJson, col) {
    this.tablePath(ppi, pathJson);
    this.calls.push(['deleteTableColumnByPath', col]);
    const { rows, cols } = this.table.dims;
    this.table.dims.cols--;
    for (let r = rows - 1; r >= 0; r--) for (const key of ['cells', 'width', 'height', 'props']) this.table[key].splice(r * cols + col, 1);
    return JSON.stringify({ ok: true, rowCount: rows, colCount: cols - 1 });
  }
  mergeTableCellsByPath(_s, ppi, pathJson, sr, sc, er, ec) {
    this.tablePath(ppi, pathJson);
    this.calls.push(['mergeTableCellsByPath', sr, sc, er, ec]);
    return JSON.stringify({ ok: true, cellCount: 1 });
  }
  splitTableCellIntoByPath(_s, ppi, pathJson, ...args) {
    this.tablePath(ppi, pathJson);
    this.calls.push(['splitTableCellIntoByPath', ...args]);
    return JSON.stringify({ ok: true, cellCount: 3 });
  }
  setCellPropertiesByPath(_s, ppi, pathJson, cellIdx, json) {
    this.tablePath(ppi, pathJson);
    Object.assign(this.table.props[cellIdx], JSON.parse(json));
    this.calls.push(['setCellPropertiesByPath', cellIdx, JSON.parse(json)]);
    return JSON.stringify({ ok: true });
  }
  setCellZonePropertiesByPath(_s, ppi, pathJson, sr, sc, er, ec, json) {
    this.tablePath(ppi, pathJson);
    this.calls.push(['setCellZonePropertiesByPath', sr, sc, er, ec, JSON.parse(json)]);
    return JSON.stringify({ ok: true });
  }
  setTablePropertiesByPath(_s, ppi, pathJson, json) {
    this.tablePath(ppi, pathJson);
    this.calls.push(['setTablePropertiesByPath', JSON.parse(json)]);
    return JSON.stringify({ ok: true });
  }
  deleteTableByPath(_s, ppi, pathJson) {
    this.tablePath(ppi, pathJson);
    this.calls.push(['deleteTableByPath', JSON.parse(pathJson)]);
    this.table.hostPara = -1; // 표가 없어졌다 — 그 경로는 더 닿지 않는다
    return JSON.stringify({ ok: true });
  }
  getTableControlsInSelection(...args) {
    return this.table.hostPara < 0 ? '[]' : super.getTableControlsInSelection(...args);
  }
}

test('nested / footer tables: rows, columns, merge, split, cell fill, zone borders, table props and delete go through *ByPath', async () => {
  const doc = new PathTableDoc(['본문']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const cellPath = [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 1 }, { controlIndex: 0, cellIndex: 'n', cellParaIndex: 0 }];
  const tablePathJson = [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 1 }, { controlIndex: 0, cellIndex: 0, cellParaIndex: 0 }];
  const run = (tool, args) => rt.executeTool(tool, { expectedRevision: rt.revision(), paraIdx: 0, controlIdx: 1, cellPath, ...args }, full);

  const row = await run('edit_table', { op: 'insert_row', rowIdx: 0 });
  assert.ok(row.ok, JSON.stringify(row));
  assert.equal(row.result.rowCount, 2);
  assert.deepEqual(row.result.newRow, { rowIdx: 1, cellIdxs: [2, 3] }, 'new cells come back for the nested table');
  assert.deepEqual(doc.calls.at(-1), ['insertTableRowByPath', 0, true]);

  const col = await run('edit_table', { op: 'delete_col', colIdx: 1 });
  assert.ok(col.ok, JSON.stringify(col));
  assert.equal(col.result.colCount, 1);

  const merge = await run('edit_table', { op: 'merge_cells', startRow: 0, startCol: 0, endRow: 1, endCol: 0 });
  assert.ok(merge.ok, JSON.stringify(merge));
  assert.deepEqual(doc.calls.at(-1), ['mergeTableCellsByPath', 0, 0, 1, 0]);
  const split = await run('edit_table', { op: 'split_cell', rowIdx: 0, colIdx: 0, splitRows: 1, splitCols: 2 });
  assert.ok(split.ok, JSON.stringify(split));
  assert.deepEqual(doc.calls.at(-1), ['splitTableCellIntoByPath', 0, 0, 1, 2, true, false]);

  const fill = await run('set_cell_props', { cellIdxs: [0, 1], cellProps: { fillColor: '#FF0000', verticalAlign: 'center' } });
  assert.ok(fill.ok, JSON.stringify(fill));
  assert.deepEqual(doc.table.props[1], { fillType: 'solid', fillColor: '#FF0000', verticalAlign: 1 });

  const zone = await run('set_zone_borders', {
    startCell: { row: 0, col: 0 }, endCell: { row: 1, col: 0 },
    borderTop: { type: 1, width: 3, color: '#000000' }, fillColor: '#00FF00',
  });
  assert.ok(zone.ok, JSON.stringify(zone));
  assert.equal(zone.result.filledCells, 2);
  assert.ok(doc.calls.some((c) => c[0] === 'setCellZonePropertiesByPath' && c[1] === 0 && c[3] === 1));
  assert.equal(doc.table.props[0].fillColor, '#00FF00');

  const props = await run('set_table_props', { tableProps: { cellPaddingMm: { left: 1 } } });
  assert.ok(props.ok, JSON.stringify(props));
  assert.equal(doc.calls.at(-1)[0], 'setTablePropertiesByPath');
  const caption = await run('set_table_props', { tableProps: { captionEnabled: true } });
  assert.equal(caption.error?.code, 'ENGINE_UNSUPPORTED', 'captions have no path API');
  const formula = await run('edit_table', { op: 'apply_formula', row: 0, col: 0, formula: '=SUM(A1:A2)' });
  assert.equal(formula.error?.code, 'ENGINE_UNSUPPORTED');

  const del = await run('delete_table', {});
  assert.ok(del.ok, JSON.stringify(del));
  assert.deepEqual(doc.calls.at(-1), ['deleteTableByPath', tablePathJson]);
  assert.equal(doc.table.hostPara, -1);
});

test('nested table delete falls back to deleteCellTableControlByPath on an engine build without deleteTableByPath', async () => {
  const doc = new PathTableDoc(['본문']);
  doc.deleteTableByPath = undefined;
  doc.deleteCellTableControlByPath = function (_s, ppi, hostJson, ctrl) {
    this.calls.push(['deleteCellTableControlByPath', ppi, JSON.parse(hostJson), ctrl]);
    this.table.hostPara = -1;
    return '{"ok":true}';
  };
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const cellPath = [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 1 }, { controlIndex: 0, cellIndex: 'n', cellParaIndex: 0 }];
  const del = await rt.executeTool('delete_table', { expectedRevision: rt.revision(), paraIdx: 0, controlIdx: 1, cellPath }, full);
  assert.ok(del.ok, JSON.stringify(del));
  assert.deepEqual(doc.calls.at(-1), ['deleteCellTableControlByPath', 0, [{ controlIndex: 1, cellIndex: 0, cellParaIndex: 1 }], 0]);
});

// ─── 다단 범위 (표지 1단 · 본문 2단) ─────────────────────

/** 엔진 applyColumnDef/getColumnDefAt 를 흉내 낸다 — 단 영역(zone)은 시작 문단과 단 모양 */
class ColumnDoc extends FakeDoc {
  constructor(paragraphs) {
    super(paragraphs, { footer: false });
    this.state.zones = [{ start: 0, count: 1, type: 0, sameWidth: true, spacing: 0 }];
  }
  zoneAt(p) { return [...this.state.zones].reverse().find((z) => z.start <= p); }
  getColumnDefAt(_s, p) {
    const z = this.zoneAt(p);
    return JSON.stringify({ columnCount: z.count, columnType: z.type, sameWidth: z.sameWidth, spacing: z.spacing, zoneStart: z.start, zoneCount: this.state.zones.length });
  }
  applyColumnDef(_s, p, off, scope, count, type, sameWidth, spacing) {
    this.check(p);
    this.calls.push(['applyColumnDef', p, off, scope, count, type, sameWidth, spacing]);
    const def = { count, type, sameWidth: sameWidth === 1, spacing };
    let target = p;
    if (scope === 1) {
      const len = [...this.paras[p]].length;
      if (off > 0 && off < len) { this.splitParagraph(0, p, off); target = p + 1; } else if (off > 0 && off >= len && p + 1 < this.paras.length) target = p + 1;
      this.state.zones = this.state.zones.map((z) => (z.start > target ? { ...z, start: z.start + (target > p ? 1 : 0) } : z));
      const at = this.state.zones.findIndex((z) => z.start === target);
      if (at >= 0) Object.assign(this.state.zones[at], def);
      else { this.state.zones.push({ start: target, ...def }); this.state.zones.sort((a, b) => a.start - b.start); }
    } else if (scope === 0) {
      Object.assign(this.zoneAt(p), def);
    } else {
      for (const z of this.state.zones) Object.assign(z, def);
    }
    return JSON.stringify({ ok: true, section: 0, para: target, charOffset: scope === 1 ? 0 : off });
  }
}

test('set_columns: cover page stays 1 column while the body starts a 2-column zone (from_here)', async () => {
  const doc = new ColumnDoc(['표지 제목', '본문 첫 문단', '본문 둘째 문단']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const r = await rt.executeTool('set_columns', { expectedRevision: rt.revision(), paraIdx: 1, count: 2, scope: 'from_here' }, full);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.zoneStartParaIdx, 1);
  assert.deepEqual(r.result.columns, { count: 2, type: 'normal', sameWidth: true, gapMm: 8 });
  assert.equal(r.result.zonesInSection, 2);
  assert.deepEqual(doc.state.zones.map((z) => [z.start, z.count]), [[0, 1], [1, 2]], 'cover zone keeps one column');
  assert.deepEqual(doc.calls.at(-1), ['applyColumnDef', 1, 0, 1, 2, 0, 1, 2268]);

  // 지금 다단만 바꾸기 — 간격·종류는 그 다단을 잇는다
  const zone = await rt.executeTool('set_columns', { expectedRevision: rt.revision(), paraIdx: 2, count: 3, type: 'distribute' }, full);
  assert.ok(zone.ok, JSON.stringify(zone));
  assert.deepEqual(doc.state.zones.map((z) => [z.start, z.count, z.type, z.spacing]), [[0, 1, 0, 0], [1, 3, 1, 2268]]);

  // 문단 가운데서 새 다단 — 문단이 나뉘고 뒤 번호가 밀린 것을 알린다
  const mid = await rt.executeTool('set_columns', { expectedRevision: rt.revision(), paraIdx: 2, charOffset: 2, count: 1, scope: 'from_here', gapMm: 5 }, full);
  assert.ok(mid.ok, JSON.stringify(mid));
  assert.deepEqual(mid.result.splitParagraph, { paraIdx: 2, charOffset: 2, newParaIdx: 3 });
  assert.equal(mid.result.zoneStartParaIdx, 3);
  assert.deepEqual(doc.paras, ['표지 제목', '본문 첫 문단', '본문', ' 둘째 문단']);

  const bad = await rt.executeTool('set_columns', { expectedRevision: rt.revision(), paraIdx: 1, charOffset: 2, count: 2 }, full);
  assert.equal(bad.error?.code, 'INVALID_ARGS', 'charOffset needs scope from_here');
});

test('set_columns on an engine build without applyColumnDef says the engine must be rebuilt', async () => {
  const doc = new FakeDoc(['표지', '본문'], { footer: false });
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const r = await rt.executeTool('set_columns', { expectedRevision: rt.revision(), paraIdx: 1, count: 2, scope: 'from_here' }, full);
  assert.equal(r.error?.code, 'ENGINE_UNSUPPORTED');
  assert.match(r.error.message, /applyColumnDef/);
  assert.match(r.error.message, /rebuilt/);
  assert.deepEqual(doc.paras, ['표지', '본문'], 'nothing changed');
});

// ─── 5. 문단을 지운 뒤 낡은 번호 ────────────────────────

test('stale paragraph index after delete_paragraphs fails loudly once, with where the old index moved', async () => {
  const doc = new FakeDoc(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'], { footer: false });
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  assert.ok((await rt.executeTool('get_structure', {}, full)).ok);
  const del = await rt.executeTool('delete_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 1 }, full);
  assert.ok(del.ok, JSON.stringify(del));
  assert.deepEqual(del.result.after.indexShift, [{ sectionIdx: 0, fromParaIdx: 1, delta: -1 }]);
  // 지우기 전 번호 p3 (= "p3") 로 이어 쓰면 지금 p3 은 "p4" 다 — 조용히 고치지 않고 멈춘다
  const stale = await rt.executeTool('replace_range', { expectedRevision: rt.revision(), paraIdx: 3, startCharOffset: 0, endCharOffset: 2, text: 'X' }, full);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_INDEX');
  assert.match(stale.error.message, /p3 now holds "p4"/);
  assert.match(stale.error.message, /now p2 "p3"/);
  assert.equal(stale.error.data.nowAt, 2);
  assert.deepEqual(doc.paras, ['p0', 'p2', 'p3', 'p4', 'p5', 'p6'], 'nothing changed');
  // 고친 번호로 — 통과
  const fixed = await rt.executeTool('replace_range', { expectedRevision: rt.revision(), paraIdx: 2, startCharOffset: 0, endCharOffset: 2, text: 'X' }, full);
  assert.ok(fixed.ok, JSON.stringify(fixed));
  assert.deepEqual(doc.paras, ['p0', 'p2', 'X', 'p4', 'p5', 'p6']);
  // 앞쪽(지운 자리 앞)은 번호가 그대로라 걸리지 않는다
  const del2 = await rt.executeTool('delete_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 2 }, full);
  assert.ok(del2.ok);
  const before = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: '!' }, full);
  assert.ok(before.ok, JSON.stringify(before));
  // 지운 자리 뒤는 다시 걸린다 (마지막 읽기 뒤로 또 문단이 빠졌다)
  const after = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 3, text: '?' }, full);
  assert.equal(after.error?.code, 'STALE_INDEX');
  // 같은 호출을 다시 보내면(이미 셈했다) 한 번만 멈추고 통과
  const resend = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 3, text: '?' }, full);
  assert.ok(resend.ok, JSON.stringify(resend));
  assert.deepEqual(doc.paras, ['p0!', 'p2', 'p4', 'p5?', 'p6']);
  // 다시 읽으면 기준이 새로 잡힌다
  assert.ok((await rt.executeTool('get_structure', {}, full)).ok);
  assert.ok((await rt.executeTool('insert_paragraphs', { expectedRevision: rt.revision(), paraIdx: 0, paragraphs: ['새'] }, full)).ok);
  // 넣은 문단 자체는 결과로 알려졌으니 바로 써도 된다
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 1, text: '줄' }, full)).ok);
  assert.equal(doc.paras[1], '새줄');
});

test('journal.shiftSince: deletes/inserts shift later indexes, inserted paragraphs are known, reorders flag the block', () => {
  const j = new EditJournal();
  j.record(1, 2, { sectionIdx: 0, paraStart: 5, paraEnd: 5, paraDelta: -1 });
  assert.equal(j.shiftSince(1, 2, 0, 3, 3), null, 'before the change');
  assert.equal(j.shiftSince(1, 2, 0, 5, 5), null, 'the paragraph left at the deletion point');
  assert.equal(j.shiftSince(1, 2, 0, 7, 7)?.paraIdx, 7);
  assert.equal(j.shiftSince(1, 2, 1, 7, 7), null, 'other section');
  j.record(2, 3, { sectionIdx: 0, paraStart: 1, paraEnd: 2, paraDelta: 2 });
  assert.equal(j.shiftSince(2, 3, 0, 2, 2), null, 'inserted paragraph');
  assert.equal(j.shiftSince(1, 3, 0, 2, 2), null, 'inserted paragraph, older basis');
  assert.equal(j.shiftSince(2, 3, 0, 4, 4)?.revision, 3);
  j.record(3, 4, { sectionIdx: 0, paraStart: 8, paraEnd: 10, paraDelta: 0, reorders: true });
  assert.equal(j.shiftSince(3, 4, 0, 9, 9)?.revision, 4);
  assert.equal(j.shiftSince(3, 4, 0, 11, 11), null);
  assert.equal(j.shiftSince(3, 6, 0, 11, 11), null, 'untracked bump: no opinion');
});
