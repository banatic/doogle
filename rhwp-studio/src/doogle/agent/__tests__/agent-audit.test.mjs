// 에이전트 평가(docs/doogle/AGENT_EVAL.md)에서 찾은 결함의 회귀 테스트 — 가짜 엔진으로 실행기 동작을 고정한다.
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/agent-audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFromSearchHit } from '../anchor.ts';
import { checkEngineArgs, engineSignatureText } from '../engine-signatures.ts';
import { createDoogleAgentRuntime } from '../runtime.ts';
import { renderCompactStructure, STRUCTURE_LEGEND } from '../structure.ts';

/**
 * 본문 문단 + 문단에 붙은 개체를 흉내 내는 엔진.
 * objs: [{ para, controlIndex, kind, pos }] — pos 는 그 개체의 글자 위치.
 */
class FakeDoc {
  constructor(paragraphs, objs = []) {
    this.paras = [...paragraphs];
    this.objs = objs.map((o) => ({ ...o }));
    this.snaps = new Map();
    this.next = 1;
    this.clip = [];
  }
  getSectionCount() { return 1; }
  getParagraphCount() { return this.paras.length; }
  pageCount() { return Math.max(1, Math.ceil(this.paras.length / 4)); }
  getDocumentInfo() { return JSON.stringify({ pageCount: this.pageCount(), sectionCount: 1 }); }
  check(p) { if (p < 0 || p >= this.paras.length) throw new Error(`para ${p} out of range`); }
  getParagraphLength(_s, p) { this.check(p); return [...this.paras[p]].length; }
  getTextRange(_s, p, off, n) { this.check(p); return [...this.paras[p]].slice(off, off + n).join(''); }
  insertText(_s, p, off, text) {
    this.check(p);
    const c = [...this.paras[p]];
    if (off > c.length) throw new Error('offset');
    this.paras[p] = c.slice(0, off).join('') + text + c.slice(off).join('');
    return '{"ok":true}';
  }
  deleteText(_s, p, off, n) { this.check(p); const c = [...this.paras[p]]; c.splice(off, n); this.paras[p] = c.join(''); return '{"ok":true}'; }
  replaceText(_s, p, off, n, text) { this.deleteText(0, p, off, n); return this.insertText(0, p, off, text); }
  splitParagraph(_s, p, off) {
    const c = [...this.paras[p]];
    this.paras.splice(p, 1, c.slice(0, off).join(''), c.slice(off).join(''));
    // 실제 엔진처럼: 나눈 자리 뒤의 개체는 새 문단으로 간다
    for (const o of this.objs) {
      if (o.para > p) o.para += 1;
      else if (o.para === p && o.pos >= off) { o.para += 1; o.pos -= off; }
    }
    return '{"ok":true}';
  }
  deleteRange(_s, sp, so, ep, eo) {
    const head = [...this.paras[sp]].slice(0, so).join('');
    const tail = [...this.paras[ep]].slice(eo).join('');
    this.paras.splice(sp, ep - sp + 1, head + tail);
    // 실제 엔진처럼: 범위에 걸린 개체는 사라진다 (끝 문단 오프셋 0 의 개체 포함)
    this.objs = this.objs.filter((o) => !(o.para > sp && o.para < ep) && !(o.para === ep && o.pos <= eo && ep > sp) && !(o.para === sp && o.pos >= so && ep > sp));
    for (const o of this.objs) if (o.para > ep) o.para -= ep - sp;
    return '{"ok":true}';
  }
  insertParagraph(_s, p) {
    if (p < 0 || p > this.paras.length) throw new Error('para out of range');
    this.paras.splice(p, 0, '');
    for (const o of this.objs) if (o.para >= p) o.para += 1;
    return JSON.stringify({ ok: true, paraIdx: p });
  }
  deleteParagraph(_s, p) {
    this.check(p);
    if (this.paras.length <= 1) throw new Error('last paragraph');
    this.paras.splice(p, 1);
    this.objs = this.objs.filter((o) => o.para !== p);
    for (const o of this.objs) if (o.para > p) o.para -= 1;
    return '{"ok":true}';
  }
  copySelection(_s, sp, _so, ep) {
    this.clip = this.paras.slice(sp, ep + 1).map((text, i) => ({ text, objs: this.objs.filter((o) => o.para === sp + i).map((o) => ({ ...o })) }));
    return '{"ok":true}';
  }
  pasteInternal(_s, p) {
    // 빈 문단에 k 문단을 붙이면 k 문단이 된다
    this.paras.splice(p, 1, ...this.clip.map((c) => c.text));
    for (const o of this.objs) if (o.para > p) o.para += this.clip.length - 1;
    this.clip.forEach((c, i) => { for (const o of c.objs) this.objs.push({ ...o, para: p + i }); });
    return JSON.stringify({ ok: true, paraIdx: p + this.clip.length - 1, charOffset: 0 });
  }
  searchAllText(q) {
    const out = [];
    this.paras.forEach((t, para) => {
      for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) out.push({ sec: 0, para, charOffset: [...t.slice(0, i)].length, length: [...q].length });
    });
    return JSON.stringify(out);
  }
  getObjects() { return JSON.stringify(this.objs.map((o) => ({ para: o.para, controlIndex: o.controlIndex, kind: o.kind }))); }
  getControlTextPositions(_s, p) {
    const list = this.objs.filter((o) => o.para === p).sort((a, b) => a.controlIndex - b.controlIndex);
    const out = [];
    for (const o of list) out[o.controlIndex] = o.pos;
    return JSON.stringify(out.map((v) => v ?? 0));
  }
  getTableDimensions(_s, p, c) {
    if (!this.objs.some((o) => o.para === p && o.controlIndex === c && o.kind === 'table')) throw new Error('not a table');
    return JSON.stringify({ rowCount: 1, colCount: 1, cellCount: 1 });
  }
  getTableCellBboxes() { return '[]'; }
  getCharShapeRuns(_s, _p, start, end) { return JSON.stringify([{ startOffset: start, endOffset: end, charShapeId: 3 }]); }
  getCharPropertiesAt() { return JSON.stringify({ fontSize: 1000, bold: false, charShapeId: 3 }); }
  getParaPropertiesAt() { return JSON.stringify({ headType: 'None', paraShapeId: 7 }); }
  setParaShapeId(_s, p, id) { (this.shapes ??= []).push({ p, para: id }); return '{"ok":true}'; }
  setCharShapeId(_s, p, _a, _b, id) { (this.shapes ??= []).push({ p, char: id }); return '{"ok":true}'; }
  getPageOfPosition(_s, p) { return JSON.stringify({ ok: true, page: Math.floor(p / 4) }); }
  getPageTextLayout(page) {
    const p = page * 4;
    return JSON.stringify({ runs: p < this.paras.length ? [{ secIdx: 0, paraIdx: p, charStart: 0, text: 'x', x: 0, y: 0, w: 1, h: 1 }] : [] });
  }
  saveSnapshot() { const id = this.next++; this.snaps.set(id, { paras: [...this.paras], objs: this.objs.map((o) => ({ ...o })) }); return id; }
  restoreSnapshot(id) { const s = this.snaps.get(id); if (!s) throw new Error('no snapshot'); this.paras = [...s.paras]; this.objs = s.objs.map((o) => ({ ...o })); return '{"ok":true}'; }
  discardSnapshot(id) { this.snaps.delete(id); }
  // 탈출구 검사용 — 인자 형이 틀리면 진짜 엔진은 죽는다
  copyControl(sec, para, pathJson, ctrl) {
    if (typeof pathJson !== 'string') throw new Error('memory access out of bounds');
    return JSON.stringify({ ok: true, sec, para, ctrl });
  }
}

function deps(doc) {
  return {
    getDocument: () => doc,
    transaction: (_label, fn) => {
      const before = { paras: [...doc.paras], objs: doc.objs.map((o) => ({ ...o })) };
      try { return fn(doc); } catch (e) { doc.paras = before.paras; doc.objs = before.objs; throw e; }
    },
  };
}

const full = { origin: 'mcp', mode: 'full' };

// ─── 검색: 중첩 셀 ─────────────────────────────────────

test('find: 중첩 셀 매치는 cellPath 만 와도 셀 주소가 된다', () => {
  // 엔진은 깊이 1 셀에는 cellContext 를, 중첩 셀에는 cellPath 만 싣는다 (kps-ai.hwp p674)
  const path = [{ controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }, { controlIndex: 1, cellIndex: 10, cellParaIndex: 0 }];
  const nested = matchFromSearchHit({ sec: 0, para: 674, charOffset: 7, length: 3, cellPath: path }, '');
  assert.equal(nested.paraIdx, 0, '가장 안쪽 셀의 문단');
  assert.deepEqual({ paraIdx: nested.cell.paraIdx, controlIdx: nested.cell.controlIdx, cellIdx: nested.cell.cellIdx }, { paraIdx: 674, controlIdx: 0, cellIdx: 2 });
  assert.deepEqual(nested.cellPath, path);
  const flat = matchFromSearchHit({ sec: 0, para: 170, charOffset: 5, length: 3, cellContext: { parentPara: 170, ctrlIdx: 0, cellIdx: 1, cellPara: 0 } }, '');
  assert.deepEqual(flat.cell, { paraIdx: 170, controlIdx: 0, cellIdx: 1 });
  assert.equal(flat.cellPath, undefined);
  const body = matchFromSearchHit({ sec: 0, para: 36, charOffset: 18, length: 3 }, '');
  assert.equal(body.cell, undefined);
  assert.equal(body.paraIdx, 36);
});

// ─── 구조 텍스트 ───────────────────────────────────────

test('get_structure: 범례를 결과마다 싣지 않고, 중첩 표를 주소와 함께 보인다', () => {
  const inner = {
    paraIdx: 5, controlIdx: 0, rowCount: 1, colCount: 2,
    path: [{ controlIndex: 0, cellIndex: 2, cellParaIndex: 0 }, { controlIndex: 1, cellIndex: 0, cellParaIndex: 0 }],
    cells: [
      { cellIdx: 0, row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [{ cellParaIdx: 0, length: 4, text: '사업기간' }] },
      { cellIdx: 1, row: 0, col: 1, rowSpan: 1, colSpan: 1, paragraphs: [{ cellParaIdx: 0, length: 3, text: '6개월' }] },
    ],
  };
  const data = {
    pageCount: 1, sectionCount: 1, pageMarks: [], fullText: true, truncated: false,
    sections: [{
      sectionIdx: 0, paragraphCount: 6,
      paragraphs: [{ paraIdx: 5, length: 0, text: '' }],
      tables: [{
        paraIdx: 5, controlIdx: 0, rowCount: 1, colCount: 3,
        cells: [
          { cellIdx: 0, row: 0, col: 0, rowSpan: 1, colSpan: 1, paragraphs: [{ cellParaIdx: 0, length: 2, text: '붙임' }] },
          { cellIdx: 1, row: 0, col: 1, rowSpan: 1, colSpan: 1, paragraphs: [{ cellParaIdx: 0, length: 0, text: '' }] },
          { cellIdx: 2, row: 0, col: 2, rowSpan: 1, colSpan: 1, paragraphs: [{ cellParaIdx: 0, length: 0, text: '' }], nested: [inner] },
        ],
      }],
    }],
  };
  const text = renderCompactStructure(data, 'revision 9');
  assert.ok(!text.includes(STRUCTURE_LEGEND), '범례는 TOOL_RULES 에만 있다');
  assert.equal(text.split('\n')[1], 's0 · 6 paragraphs', '머리 줄 바로 다음이 본문이다');
  assert.match(text, /r0 \[0\] 붙임 \| \[1\] \| \[2 ▦\]/);
  assert.match(text, /nested table in \[2\] 1x2 · cell \{paraIdx:5,controlIdx:0,cellIdx:2\} \+ cellPath \[\{"controlIndex":0,"cellIndex":2,"cellParaIndex":0\},\{"controlIndex":1,"cellIndex":n,"cellParaIndex":0\}\]/);
  assert.match(text, / {4}r0 \[0\] 사업기간 \| \[1\] 6개월/);
});

// ─── 글 범위 도구는 개체를 지우지 않는다 ────────────────

test('delete_range: 표가 걸린 범위는 거절하고 고칠 방법을 알려 준다', async () => {
  // biz_plan.hwp 평가에서 delete_range p92@0..p94@0 이 p94 의 표를 지웠다
  const doc = new FakeDoc(['머리', '', '추진 일정', ''], [{ para: 3, controlIndex: 0, kind: 'table', pos: 0 }]);
  const rt = createDoogleAgentRuntime(deps(doc));
  const r = await rt.executeTool('delete_range', { expectedRevision: rt.revision(), startParaIdx: 1, startCharOffset: 0, endParaIdx: 3, endCharOffset: 0 }, full);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'RANGE_HAS_OBJECTS');
  assert.match(r.error.message, /table s0 p3 c0/);
  assert.match(r.error.message, /delete_paragraphs \{startParaIdx:1, endParaIdx:2\}/);
  assert.equal(doc.objs.length, 1, '표는 그대로다');
  assert.deepEqual(doc.paras, ['머리', '', '추진 일정', '']);
  // 안내대로 문단 단위로 지우면 된다
  const ok = await rt.executeTool('delete_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 1, endParaIdx: 2 }, full);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(doc.paras, ['머리', '']);
  assert.deepEqual(doc.objs.map((o) => o.para), [1]);
});

test('replace_range: 한 문단 안에서 개체 앞의 글은 고칠 수 있고, 개체를 덮는 범위는 거절한다', async () => {
  const doc = new FakeDoc(['가나다라마'], [{ para: 0, controlIndex: 0, kind: 'equation', pos: 3 }]);
  const rt = createDoogleAgentRuntime(deps(doc));
  const before = await rt.executeTool('replace_range', { expectedRevision: rt.revision(), paraIdx: 0, startCharOffset: 0, endCharOffset: 3, text: 'ABC' }, full);
  assert.ok(before.ok, JSON.stringify(before));
  assert.equal(doc.paras[0], 'ABC라마');
  const over = await rt.executeTool('replace_range', { expectedRevision: rt.revision(), paraIdx: 0, find: 'ABC라마', text: 'x' }, full);
  assert.equal(over.error?.code, 'RANGE_HAS_OBJECTS');
  assert.equal(doc.paras[0], 'ABC라마');
});

test('insert_text: 표로 끝나는 문단 끝에 덧붙이면 표 앞에 들어가므로 막고 insert_paragraphs 를 안내한다', async () => {
  const doc = new FakeDoc(['본문', ''], [{ para: 1, controlIndex: 0, kind: 'table', pos: 0 }]);
  const rt = createDoogleAgentRuntime(deps(doc));
  const r = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 1, text: '\n추진 일정' }, full);
  assert.equal(r.error?.code, 'OBJECT_AT_PARAGRAPH_END');
  assert.match(r.error.message, /insert_paragraphs \{paraIdx:1/);
  // 오프셋을 직접 주면(표 앞에 쓰겠다는 뜻) 그대로 한다
  const explicit = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 1, charOffset: 0, text: '표 앞' }, full);
  assert.ok(explicit.ok, JSON.stringify(explicit));
});

// ─── 문단 단위 도구 ────────────────────────────────────

test('insert_paragraphs: 표가 든 마지막 문단 뒤에 문단을 넣는다 (표는 그대로)', async () => {
  const doc = new FakeDoc(['본문', ''], [{ para: 1, controlIndex: 0, kind: 'table', pos: 0 }]);
  const rt = createDoogleAgentRuntime(deps(doc));
  const r = await rt.executeTool('insert_paragraphs', { expectedRevision: rt.revision(), paraIdx: 1, paragraphs: ['', '추진 일정'] }, full);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(doc.paras, ['본문', '', '', '추진 일정']);
  assert.deepEqual(doc.objs.map((o) => o.para), [1], '표는 제자리');
  assert.deepEqual(r.result.inserted, { sectionIdx: 0, firstParaIdx: 2, lastParaIdx: 3 });
  assert.deepEqual(r.result.after.paragraphs.map((p) => [p.paraIdx, p.text]), [[2, ''], [3, '추진 일정']]);
});

test('insert_paragraphs: where:"before" 와 formatFrom(서식 복사)', async () => {
  const doc = new FakeDoc(['가. 첫째', '나. 둘째', '본문']);
  const rt = createDoogleAgentRuntime(deps(doc));
  const r = await rt.executeTool('insert_paragraphs', { expectedRevision: rt.revision(), paraIdx: 2, where: 'before', paragraphs: ['다. 셋째'], formatFrom: 1 }, full);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(doc.paras, ['가. 첫째', '나. 둘째', '다. 셋째', '본문']);
  assert.deepEqual(doc.shapes, [{ p: 2, para: 7 }, { p: 2, char: 3 }], '문단 모양과 글자 모양을 formatFrom 문단에서 가져온다');
  const bad = await rt.executeTool('insert_paragraphs', { expectedRevision: rt.revision(), paraIdx: 9, paragraphs: ['x'] }, full);
  assert.equal(bad.error?.code, 'INVALID_ARGS');
});

test('delete_paragraphs: 개체가 든 문단은 includeObjects 없이는 지우지 않는다', async () => {
  const doc = new FakeDoc(['a', '', 'c'], [{ para: 1, controlIndex: 0, kind: 'table', pos: 0 }]);
  const rt = createDoogleAgentRuntime(deps(doc));
  const refused = await rt.executeTool('delete_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 1 }, full);
  assert.equal(refused.error?.code, 'RANGE_HAS_OBJECTS');
  assert.equal(doc.paras.length, 3);
  const ok = await rt.executeTool('delete_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 1, includeObjects: true }, full);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(doc.paras, ['a', 'c']);
  assert.equal(ok.result.deletedObjects, 1);
  const all = await rt.executeTool('delete_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 0, endParaIdx: 1 }, full);
  assert.match(all.error?.message ?? '', /keeps at least one paragraph/);
});

test('move_paragraphs: 뒤로·앞으로 옮기고 표를 함께 가져간다', async () => {
  const doc = new FakeDoc(['p0', 'p1', 'p2', 'p3', 'p4'], [{ para: 2, controlIndex: 0, kind: 'table', pos: 0 }]);
  const rt = createDoogleAgentRuntime(deps(doc));
  // p1..p2 를 맨 끝으로
  const down = await rt.executeTool('move_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 1, endParaIdx: 2, toParaIdx: 4, where: 'after' }, full);
  assert.ok(down.ok, JSON.stringify(down));
  assert.deepEqual(doc.paras, ['p0', 'p3', 'p4', 'p1', 'p2']);
  assert.deepEqual(doc.objs.map((o) => o.para), [4], '표가 문단을 따라간다');
  assert.deepEqual(down.result.moved, { paragraphs: 2, from: [1, 2], to: [3, 4] });
  // p4(p2) 를 맨 앞으로
  const up = await rt.executeTool('move_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 4, toParaIdx: 0 }, full);
  assert.ok(up.ok, JSON.stringify(up));
  assert.deepEqual(doc.paras, ['p2', 'p0', 'p3', 'p4', 'p1']);
  assert.deepEqual(doc.objs.map((o) => o.para), [0]);
  const noop = await rt.executeTool('move_paragraphs', { expectedRevision: rt.revision(), startParaIdx: 1, endParaIdx: 2, toParaIdx: 3 }, full);
  assert.match(noop.error?.message ?? '', /nothing would move/);
});

// ─── 배치의 after 보고 ─────────────────────────────────

test('apply_edits: 뒤 항목이 문단 수를 바꾸면 앞 항목의 after 자리도 따라 옮긴다', async () => {
  // move-paragraph 평가: 끝에 넣고 앞에서 지웠더니 after 가 없는 문단(p41~44)을 가리켰다
  const doc = new FakeDoc(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  const rt = createDoogleAgentRuntime(deps(doc));
  const r = await rt.executeTool('apply_edits', {
    expectedRevision: rt.revision(),
    edits: [
      { tool: 'insert_paragraphs', paraIdx: 5, paragraphs: ['끝에 넣은 줄'] },
      { tool: 'delete_paragraphs', startParaIdx: 1, endParaIdx: 2 },
    ],
  }, full);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(doc.paras, ['p0', 'p3', 'p4', 'p5', '끝에 넣은 줄']);
  const shown = r.result.after.paragraphs.find((p) => p.text === '끝에 넣은 줄');
  assert.ok(shown, JSON.stringify(r.result.after.paragraphs));
  assert.equal(shown.paraIdx, 4, '배치가 끝난 문서의 문단 번호');
});

// ─── 엔진 탈출구 ───────────────────────────────────────

test('engine escape hatch: 시그니처를 알려 주고, 틀린 인자는 엔진에 닿기 전에 거절한다', async () => {
  assert.equal(checkEngineArgs('copyControl', [0, 89, '', 0]), null);
  assert.match(checkEngineArgs('copyControl', [0, 89, 0]), /takes 4 positional argument\(s\) but got 3\. Signature: copyControl\(section_idx: number, para_idx: number, cell_path_json: string, control_idx: number\)/);
  assert.match(checkEngineArgs('copyControl', [0, 89, 0, 0]), /argument 2 \(cell_path_json\) must be a string but got the number 0/);
  assert.match(checkEngineArgs('noSuchMethod', []), /no known signature/);
  assert.match(engineSignatureText('insertText'), /^insertText\(section_idx: number, para_idx: number, char_offset: number, text: string\)/);

  const doc = new FakeDoc(['a']);
  const rt = createDoogleAgentRuntime(deps(doc));
  const caps = await rt.executeTool('get_engine_edit_capabilities', { query: 'copyControl' }, full);
  assert.ok(caps.ok, JSON.stringify(caps));
  assert.match(caps.result.signatures.copyControl, /cell_path_json: string/);
  const wrong = await rt.executeTool('prepare_engine_edit_session', { expectedRevision: rt.revision(), method: 'copyControl', args: [0, 0, 0] }, full);
  assert.equal(wrong.error?.code, 'INVALID_ARGS', '엔진을 죽이는 호출은 미리 막는다');
  assert.match(wrong.error.message, /Signature: copyControl/);
  const right = await rt.executeTool('prepare_engine_edit_session', { expectedRevision: rt.revision(), method: 'copyControl', args: [0, 0, '', 0] }, full);
  assert.ok(right.ok, JSON.stringify(right));
});

// ─── 실패한 쓰기는 편집기의 "명령 실패"가 되지 않는다 ────

test('write failure: 호스트가 noChange 를 알면 던지지 않고 스스로 되돌린 뒤 무변경으로 끝낸다', async () => {
  // 기준선: 도구 실패가 studio 의 명령 실패 복구를 타다 확인이 어긋나 문서 편집이 통째로 잠겼다(EDITOR_BLOCKED)
  const doc = new FakeDoc(['alpha', 'beta']);
  const log = { thrown: 0, noChange: 0, committed: 0 };
  const host = {
    getDocument: () => doc,
    transaction: (_label, fn) => {
      let unchanged = false;
      try {
        const r = fn(doc, { noChange: () => { unchanged = true; } });
        if (unchanged) log.noChange += 1; else log.committed += 1;
        return r;
      } catch (e) { log.thrown += 1; throw e; }
    },
  };
  const rt = createDoogleAgentRuntime(host);
  const r = await rt.executeTool('apply_edits', {
    expectedRevision: rt.revision(),
    edits: [{ tool: 'replace_range', find: 'alpha', text: 'ALPHA' }, { tool: 'replace_range', find: 'missing', text: 'x' }],
  }, full);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BATCH_FAILED');
  assert.deepEqual(log, { thrown: 0, noChange: 1, committed: 0 }, '호스트에는 실패가 아니라 무변경으로 보인다');
  assert.deepEqual(doc.paras, ['alpha', 'beta'], '앞 항목이 바꾼 것도 되돌렸다');
  assert.equal(doc.snaps.size, 0, '복원용 스냅샷을 남기지 않는다');
  // 바로 다음 쓰기는 같은 revision 으로 된다 (문서가 그대로이므로)
  const ok = await rt.executeTool('replace_range', { expectedRevision: rt.revision(), find: 'alpha', text: 'ALPHA' }, full);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(log, { thrown: 0, noChange: 1, committed: 1 });
  assert.equal(doc.snaps.size, 0);
});

test('write failure: 엔진 트랩은 감싸지 않고 그대로 올린다 (호스트가 문서를 잠가야 한다)', async () => {
  class TrapDoc extends FakeDoc {
    insertText() { throw new WebAssembly.RuntimeError('memory access out of bounds'); }
  }
  const doc = new TrapDoc(['alpha']);
  let thrown = null;
  const host = {
    getDocument: () => doc,
    transaction: (_label, fn) => { try { return fn(doc, { noChange() {} }); } catch (e) { thrown = e; throw e; } },
  };
  const rt = createDoogleAgentRuntime(host);
  const r = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, charOffset: 0, text: 'x' }, full);
  assert.equal(r.ok, false);
  assert.ok(thrown instanceof WebAssembly.RuntimeError, '트랩은 transaction 밖으로 나간다');
});
