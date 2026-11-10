// 두글 tool 정의 계약 테스트 (node:test). 실행: node --test test/tools.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BATCHABLE_EDIT_TOOL_NAMES,
  BATCHABLE_READ_TOOL_NAMES,
  TOOL_RULES,
  TOOLS,
  getTool,
  toJsonSchema,
  toToolContent,
  toolsForProvider,
  validateArgs,
} from '../src/tools/index.mjs';

const ok = (name, args) => {
  const r = validateArgs(name, args);
  assert.equal(r.ok, true, `${name} ${JSON.stringify(args)} should pass: ${r.ok ? '' : r.error.message}`);
  return r.args;
};
const bad = (name, args, pattern) => {
  const r = validateArgs(name, args);
  assert.equal(r.ok, false, `${name} ${JSON.stringify(args)} should fail`);
  assert.equal(r.error.code, 'INVALID_ARGS');
  if (pattern) assert.match(r.error.message, pattern);
  return r.error.message;
};

const OUT_OF_SCOPE = /^(browser_|project_|template_|request_secret$|search_reference|read_reference|find_home_files$|list_documents$|open_document$|create_document$|detach_document$|commit_version$|materialize_document_snapshot$|update_agent_instructions$|commit_product_skill$|read_product_skill$|list_harness_skills$|read_agent_instructions$|download_file$|publish_artifact$)|copy_layout/;

test('tool list: unique names, v1 only, every tool has kind/label/description', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of TOOLS) {
    assert.ok(['read', 'write', 'control'].includes(t.kind), `${t.name} kind`);
    assert.ok(t.description.length > 10, `${t.name} description`);
    assert.ok(t.label, `${t.name} label`);
    assert.doesNotMatch(t.name, OUT_OF_SCOPE);
    assert.equal(Object.hasOwn(t.shape, 'documentId'), false, `${t.name} must not take documentId`);
    if (t.kind === 'write') assert.ok(t.shape.expectedRevision, `${t.name} write needs expectedRevision`);
    assert.equal(getTool(t.name), t);
  }
  const count = (kind) => TOOLS.filter((t) => t.kind === kind).length;
  assert.deepEqual({ read: count('read'), write: count('write'), control: count('control') }, { read: 21, write: 29, control: 4 });
  for (const n of ['get_structure', 'find_text', 'render_page', 'read_batch', 'insert_text', 'replace_range', 'apply_edits',
    'apply_engine_edits', 'insert_image', 'ask_user_question', 'request_permission', 'present_implementation_plan', 'update_todos']) {
    assert.ok(getTool(n), `missing ${n}`);
  }
});

test('batchable lists only name v1 tools of the right kind', () => {
  for (const n of BATCHABLE_EDIT_TOOL_NAMES) assert.equal(getTool(n)?.kind, 'write', n);
  for (const n of BATCHABLE_READ_TOOL_NAMES) assert.equal(getTool(n)?.kind, 'read', n);
  assert.ok(!BATCHABLE_EDIT_TOOL_NAMES.includes('insert_image'));
  assert.ok(!BATCHABLE_READ_TOOL_NAMES.includes('render_page'));
});

test('TOOL_RULES: no browser / other-documents paragraphs, keeps mode staging text', () => {
  assert.doesNotMatch(TOOL_RULES, /browser|Browser access|documentId|Other documents/);
  assert.match(TOOL_RULES, /에이전트 mode/);
  assert.match(TOOL_RULES, /전체 mode/);
  assert.match(TOOL_RULES, /expectedRevision/);
  assert.match(TOOL_RULES, /paras:\[48,\[51,53\]\]/);
});

function walk(node, visit, at = '$') {
  visit(node, at);
  if (Array.isArray(node)) node.forEach((c, i) => walk(c, visit, `${at}[${i}]`));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, visit, `${at}.${k}`);
}

test('every tool JSON schema: draft-07 object, plain JSON, no $ref/definitions', () => {
  for (const t of TOOLS) {
    const s = toJsonSchema(t.name);
    assert.equal(s.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(s.type, 'object', t.name);
    assert.ok(s.properties && typeof s.properties === 'object', t.name);
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s, `${t.name} plain JSON`);
    walk(s, (node, at) => {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        for (const k of ['$ref', 'definitions', '$defs']) assert.equal(Object.hasOwn(node, k), false, `${t.name} ${at} has ${k}`);
      }
    });
    // shape keys == properties keys
    assert.deepEqual(Object.keys(s.properties).sort(), Object.keys(t.shape).sort(), t.name);
    if (t.kind === 'write') assert.ok(s.required?.includes('expectedRevision'), `${t.name} requires expectedRevision`);
  }
  // 반환값은 사본이다
  const a = toJsonSchema('get_structure');
  a.properties.hack = {};
  assert.equal(toJsonSchema('get_structure').properties.hack, undefined);
  // anchor (preprocess) 는 입력 스키마(object)로 나온다
  assert.equal(toJsonSchema('insert_text').properties.anchor.type, 'object');
  assert.deepEqual(toJsonSchema('insert_text').required.sort(), ['expectedRevision', 'text']);
});

test('provider shapes', () => {
  const anthropic = toolsForProvider('anthropic');
  assert.equal(anthropic.length, TOOLS.length);
  for (const t of anthropic) {
    assert.deepEqual(Object.keys(t).sort(), ['description', 'input_schema', 'name']);
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(t.input_schema.type, 'object');
    assert.equal(t.input_schema.$schema, undefined);
  }
  const openai = toolsForProvider('openai-responses');
  for (const t of openai) {
    assert.equal(t.type, 'function');
    assert.equal(t.strict, false);
    assert.equal(t.parameters.type, 'object');
    assert.ok(t.description && t.name);
  }
  const mcp = toolsForProvider('mcp');
  for (const t of mcp) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
    assert.equal(t.annotations.destructiveHint, false);
  }
  assert.equal(mcp.find((t) => t.name === 'get_structure').annotations.readOnlyHint, true);
  assert.equal(mcp.find((t) => t.name === 'insert_text').annotations.readOnlyHint, false);
  const codex = toolsForProvider('codex-dynamic');
  for (const t of codex) assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name']);
  assert.equal(toolsForProvider('anthropic', { filter: (t) => t.kind === 'read' }).length, 21);
  assert.throws(() => toolsForProvider('nope'));
});

test('validateArgs accepts TOOL_RULES / description examples', () => {
  ok('replace_range', { expectedRevision: 3, paraIdx: 64, find: 'old', text: 'new' });
  ok('insert_text', { expectedRevision: 3, paraIdx: 64, find: 'old', position: 'before', text: 'x' });
  ok('insert_text', { expectedRevision: 3, sectionIdx: 0, paraIdx: 2, charOffset: 5, text: 'a\nb' });
  ok('insert_text', { expectedRevision: 3, paraIdx: 2, text: 'append' });
  ok('apply_para_format', { expectedRevision: 1, paras: [48, [51, 53]], alignment: 'center' });
  ok('apply_char_format', { expectedRevision: 1, paras: [48, [51, 53]], bold: true });
  ok('apply_char_format', { expectedRevision: 1, sectionIdx: 0, paraIdx: 3, bold: true }); // whole paragraph
  ok('apply_style', { expectedRevision: 1, paras: [[0, 4]], styleId: 2 });
  ok('delete_range', { expectedRevision: 1, sectionIdx: 0, startParaIdx: 1, startCharOffset: 0, endParaIdx: 2, endCharOffset: 3 });
  ok('delete_range', { expectedRevision: 1, anchor: { text: '가나다', occurrence: 2, within: { sectionIdx: 0, paraRange: [3, 9] } } });
  const parsed = ok('replace_range', { expectedRevision: 1, anchor: '문자열 앵커', text: '' });
  assert.deepEqual(parsed.anchor, { text: '문자열 앵커' });
  ok('insert_text', { expectedRevision: 1, cell: { paraIdx: 5, controlIdx: 0, cellIdx: 3 }, paraIdx: 0, text: '셀' });
  ok('get_structure', {});
  ok('get_structure', { pages: [0, 2], text: 'full' });
  ok('get_structure', { range: { sectionIdx: 0, fromPara: 3, toPara: 9 }, sinceRevision: 4 });
  ok('set_table_props', { expectedRevision: 1, sectionIdx: 0, paraIdx: 5, controlIdx: 0, tableProps: { pageBreak: 'row', repeatHeader: true } });
  ok('edit_table', { expectedRevision: 1, sectionIdx: 0, paraIdx: 5, controlIdx: 0, op: 'fit_to_page' });
  ok('create_table', { expectedRevision: 1, sectionIdx: 0, paraIdx: 1, charOffset: 0, cells: [['a', 'b'], ['c']] });
  ok('apply_list', { expectedRevision: 1, sectionIdx: 0, startParaIdx: 2, endParaIdx: 5, format: '가.' });
  ok('render_page', { pageIndex: 0, regionMm: { x: 0, y: 0, width: 50, height: 20 } });
  ok('insert_image', { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, imagePath: '/tmp/a.png' });
  ok('ask_user_question', { questions: [{ id: 'q1', header: '어조', question: '어떤 어조로?', options: [{ label: '공식', description: '보고서체' }, { label: '친근', description: '대화체' }] }] });
  ok('request_permission', { capability: 'edit-document', reason: '본문을 고치려면 편집 모드가 필요합니다' });
  ok('update_todos', { planId: 'p1', todos: [{ content: '개요 다시 쓰기', status: 'in-progress' }] });
  // 최상위 null 은 "없음"
  ok('insert_text', { expectedRevision: 1, paraIdx: 1, text: 'x', charOffset: null, cell: null });
});

test('validateArgs rejects with careful messages', () => {
  bad('replace_range', { expectedRevision: 1, paraIdx: 1, find: 'a', anchor: { text: 'a' }, text: 'b' }, /pass find or anchor, not both/);
  bad('apply_para_format', { expectedRevision: 1, paras: [[53, 51]] }, /paras\[0\] \[53, 51\] is reversed — send \[51, 53\]/);
  bad('apply_char_format', { expectedRevision: 1, paras: [48], paraIdx: 3 }, /paras already names the target paragraphs — drop paraIdx/);
  bad('apply_char_format', { expectedRevision: 1, paras: [] }, /1\.\.64 entries/);
  bad('apply_char_format', { expectedRevision: 1, paras: ['x'] }, /paras\[0\] must be a paragraph index/);
  bad('insert_text', { expectedRevision: 1, paraIdx: 1, charOffset: 3, find: 'a', text: 'b' }, /charOffset and find both place the target/);
  bad('insert_text', { expectedRevision: 1, paraIdx: 1, occurrence: 2, text: 'b' }, /occurrence refines a text match/);
  bad('insert_text', { expectedRevision: 1, find: 'a', occurrence: 0, text: 'b' }, /occurrence must be a 1-based integer/);
  bad('insert_text', { expectedRevision: 1, find: 'a', position: 'middle', text: 'b' }, /position must be "before" \| "after" \| "replace"/);
  bad('delete_range', { expectedRevision: 1, anchor: { text: 'a', foo: 1 } }, /unknown anchor key foo/);
  bad('delete_range', { expectedRevision: 1, anchor: { text: 'a', within: { page: 1 } } }, /unknown anchor.within key page/);
  bad('delete_range', { expectedRevision: 1, anchor: { text: 'a', occurrence: 1 }, occurrence: 2 }, /disagree/);
  bad('delete_range', { expectedRevision: 1, sectionIdx: 0, startParaIdx: 1 }, /delete_range needs .* \(missing startCharOffset, endCharOffset\)/);
  bad('insert_text', { expectedRevision: 1, text: 'x' }, /insert_text needs sectionIdx, paraIdx — or find/);
  bad('insert_text', { expectedRevision: 1, paraIdx: 5, controlIdx: 0, cellIdx: 2, text: 'x' }, /without cell.*cell:\{paraIdx:5,controlIdx:0,cellIdx:2\}/);
  bad('insert_text', { paraIdx: 1, text: 'x' }, /expectedRevision: required/);
  bad('insert_text', { expectedRevision: 1, paraIdx: 1, text: 'x', fontsize: 3 }, /unknown argument fontsize — valid arguments:/);
  bad('get_structure', { documentId: 'other' }, /documentId is not supported/);
  bad('get_structure', { pages: [3, 1] }, /reversed — send \[1, 3\]/);
  bad('set_table_props', { expectedRevision: 1, sectionIdx: 0, paraIdx: 5, controlIdx: 0, tableProps: {} }, /tableProps needs at least one of/);
  bad('set_table_props', { expectedRevision: 1, sectionIdx: 0, paraIdx: 5, controlIdx: 0, tableProps: { centered: true } }, /Unknown tableProps key/);
  bad('edit_table', { expectedRevision: 1, sectionIdx: 0, paraIdx: 5, controlIdx: 0, op: 'merge_cells', startRow: 0 }, /requires startRow, startCol, endRow, endCol — missing: startCol, endRow, endCol/);
  bad('create_table', { expectedRevision: 1, sectionIdx: 0, paraIdx: 1, charOffset: 0 }, /rows\+cols or a cells grid/);
  bad('apply_list', { expectedRevision: 1, sectionIdx: 0, startParaIdx: 2, endParaIdx: 5 }, /requires format/);
  bad('apply_list', { expectedRevision: 1, sectionIdx: 0, startParaIdx: 5, endParaIdx: 2, format: '1.' }, /reversed/);
  bad('set_bookmark', { expectedRevision: 1, op: 'add', name: 'b' }, /op "add" requires sectionIdx/);
  bad('insert_image', { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0 }, /exactly one of imagePath or imageBase64/);
  bad('insert_image', { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, imagePath: '/a.png', xMm: 3 }, /need positionMode "floating"/);
  bad('request_permission', { capability: 'browser', reason: 'x' });
  bad('no_such_tool', {}, /unknown tool/);
  bad('get_structure', 'nope', /must be an object/);
});

test('apply_edits validates every item and reports all failures', () => {
  const args = ok('apply_edits', {
    expectedRevision: 7,
    edits: [
      { tool: 'replace_range', paraIdx: 64, find: 'old', text: 'new' },
      { tool: 'apply_para_format', args: { paras: [1, [3, 4]], alignment: 'right' } }, // 옛 {tool,args} 꼴
    ],
  });
  assert.deepEqual(args.edits[0], { tool: 'replace_range', paraIdx: 64, find: 'old', text: 'new' });
  assert.deepEqual(args.edits[1], { tool: 'apply_para_format', paras: [1, [3, 4]], alignment: 'right' });
  const msg = bad('apply_edits', {
    expectedRevision: 7,
    edits: [
      { tool: 'replace_range', paraIdx: 1, find: 'a', anchor: 'a', text: 'b' },
      { tool: 'insert_text', paraIdx: 1, text: 'ok' },
      { tool: 'apply_char_format', paras: [[9, 2]], bold: true },
      { tool: 'insert_text', expectedRevision: 7, paraIdx: 1, text: 'x' },
    ],
  }, /3 item\(s\) invalid/);
  assert.match(msg, /edits\[0\] \(replace_range\): pass find or anchor/);
  assert.match(msg, /edits\[2\] \(apply_char_format\): paras\[0\] \[9, 2\] is reversed/);
  assert.match(msg, /edits\[3\] \(insert_text\): expectedRevision belongs on the apply_edits call/);
  assert.doesNotMatch(msg, /edits\[1\]/);
  bad('apply_edits', { expectedRevision: 1, edits: [{ tool: 'insert_image' }] }, /edits\.0\.tool/);
  bad('apply_edits', { expectedRevision: 1, edits: [{ tool: 'insert_text', paraIdx: 1, text: 'x', documentId: 'd' }] }, /documentId/);
});

test('read_batch validates items', () => {
  const args = ok('read_batch', { reads: [{ tool: 'get_structure', args: { pages: [0, 1] } }, { tool: 'get_selection' }] });
  assert.deepEqual(args.reads, [{ tool: 'get_structure', args: { pages: [0, 1] } }, { tool: 'get_selection', args: {} }]);
  bad('read_batch', { reads: [{ tool: 'find_text', args: {} }] }, /reads\[0\] \(find_text\): find_text: query: required/);
  bad('read_batch', { reads: [{ tool: 'render_page', args: { pageIndex: 0 } }] });
  bad('read_batch', { reads: [{ tool: 'get_structure', args: { documentId: 'x' } }] }, /documentId/);
});

test('toToolContent maps image results to MCP image blocks', () => {
  const content = toToolContent({ revision: 3, image: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' }, pageIndex: 0 });
  assert.deepEqual(content[0], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
  assert.deepEqual(JSON.parse(content[1].text), { revision: 3, pageIndex: 0 });
  assert.deepEqual(toToolContent({ a: 1 }), [{ type: 'text', text: '{"a":1}' }]);
});
