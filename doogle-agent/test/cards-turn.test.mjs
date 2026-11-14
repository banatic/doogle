// 카드를 모델에 보낼 때: 가리기 · <doogle_cards> 블록 · read_card · 자리표시자 치환 · propose_card(카드 편집 대화).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';

import { cardsBlock, fillPlaceholders, maskSensitive, maskValue, normalizeCard, normalizeProposal, readCardView } from '../src/cards.mjs';
import { createHub } from '../src/hub.mjs';
import * as realTools from '../src/tools/index.mjs';
import { stubTools } from '../src/tools-loader.mjs';

const ME = {
  name: '내 인적 사항',
  icon: 'person',
  kind: 'item',
  fields: [
    { key: '이름', desc: '본인 이름. 성명·신청인 칸' },
    { key: '소속', desc: '근무 학교' },
    { key: '연락처', desc: '휴대폰', sensitive: true },
  ],
  values: { 이름: '김하늘', 소속: '한빛초등학교', 연락처: '010-1234-5678' },
};

const ROSTER = {
  name: '3학년 2반 명렬',
  icon: 'list',
  kind: 'table',
  fields: [{ key: '번호' }, { key: '성명' }, { key: '보호자 연락처', sensitive: true }],
  rows: [['1', '강서윤', '010-2201-4410'], ['2', '권도현', '010-3812-0927']],
};

const saved = (input, id) => ({ id, ...normalizeCard(input), createdAt: '', updatedAt: '' });

describe('카드 값 다루기', () => {
  const me = saved(ME, 'c-me');
  const roster = saved(ROSTER, 'c-roster');
  const lookup = (id) => ({ 'c-me': me, 'c-roster': roster })[id] ?? null;

  test('maskValue: 숫자가 많으면 끝 4자리, 아니면 첫 글자만', () => {
    assert.equal(maskValue('010-1234-5678'), '***-****-5678');
    assert.equal(maskValue('김하늘'), '김**');
    assert.equal(maskValue('A'), '*');
    assert.equal(maskValue(''), '');
  });

  test('cardsBlock 에는 항목 이름·설명만 있고 값은 없다', () => {
    const block = cardsBlock([me, roster], ['c-me']);
    assert.match(block, /<doogle_cards/);
    assert.match(block, /id=c-me "내 인적 사항" \[항목형, 이번에 붙임\]/);
    assert.match(block, /연락처\(민감\) — 휴대폰/);
    assert.match(block, /표 2줄/);
    for (const v of ['김하늘', '010-1234-5678', '강서윤', '010-2201-4410']) assert.equal(block.includes(v), false, v);
  });

  test('readCardView: 민감 값은 가리고, 표는 줄을 나눠 준다', () => {
    const item = readCardView(me);
    assert.equal(item.values.이름, '김하늘');
    assert.equal(item.values.연락처, '***-****-5678');
    const rows = readCardView(roster, { fromRow: 1, maxRows: 1, fields: ['성명', '보호자 연락처', '없음'] });
    assert.deepEqual(rows.rows, [{ row: 1, 성명: '강서윤', '보호자 연락처': '***-****-4410' }]);
    assert.equal(rows.nextRow, 2);
    assert.deepEqual(rows.unknownFields, ['없음']);
  });

  test('fillPlaceholders: 항목형·표형 값을 글 안 어디서나 바꾼다', () => {
    const r = fillPlaceholders({
      text: '신청인 {{card:c-me.이름}} ({{ card:c-me.연락처 }})',
      cells: [['{{card:c-roster.rows[2].성명}}', '{{card:c-roster.rows[1].보호자 연락처}}']],
      n: 3,
    }, lookup);
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, { text: '신청인 김하늘 (010-1234-5678)', cells: [['권도현', '010-2201-4410']], n: 3 });
    assert.equal(r.count, 4);
    assert.deepEqual(r.sensitive, ['010-1234-5678', '010-2201-4410']);
    // 결과에 섞여 돌아온 민감 값만 가린다
    assert.deepEqual(
      maskSensitive({ paragraphs: [{ text: '김하늘 010-1234-5678' }], n: 1 }, r.sensitive),
      { paragraphs: [{ text: '김하늘 ***-****-5678' }], n: 1 },
    );
  });

  test('fillPlaceholders: 모르는 카드·항목·줄, 꼴이 틀린 자리표시자는 오류', () => {
    for (const text of ['{{card:c-other.이름}}', '{{card:c-me.주소}}', '{{card:c-roster.rows[9].성명}}', '{{card:c-roster.성명}}', '{{card:c-me.rows[1].이름}}']) {
      const r = fillPlaceholders({ text }, lookup);
      assert.equal(r.ok, false, text);
      assert.equal(r.error.code, 'CARD_PLACEHOLDER');
    }
    assert.deepEqual(fillPlaceholders({ text: '{{그냥 중괄호}}' }, lookup), { ok: true, args: { text: '{{그냥 중괄호}}' }, count: 0, sensitive: [] });
  });

  test('normalizeProposal: 파일에서 만든 표형은 source, 열 수가 항목 수와 다르면 오류', () => {
    const p = normalizeProposal({ name: '명렬', kind: 'table', fields: [{ key: '번호' }, { key: '성명' }], source: { dataStart: 1, columns: [0, 2] } });
    assert.deepEqual(p.source, { dataStart: 1, columns: [0, 2] });
    assert.deepEqual(p.card.rows, []);
    assert.throws(() => normalizeProposal({ name: '명렬', kind: 'table', fields: [{ key: '번호' }], source: { dataStart: 0, columns: [0, 1] } }), /columns/);
    assert.throws(() => normalizeProposal({ name: '나', kind: 'item', fields: [{ key: '이름' }], source: { dataStart: 0, columns: [0] } }), /표형/);
  });
});

/** 진짜 카드 tool(read_card · propose_card) + 가짜 문서 tool 두 개 */
function cardTools() {
  const fake = [
    { name: 'get_selection', description: 'read', kind: 'read', shape: {} },
    { name: 'replace_range', description: 'write', kind: 'write', shape: {} },
    { name: 'render_page', description: 'read', kind: 'read', shape: {} },
  ];
  const TOOLS = [...fake, realTools.getTool('read_card'), realTools.getTool('propose_card')];
  return {
    ...stubTools(),
    stub: false,
    TOOL_RULES: 'FAKE',
    TOOLS,
    getTool: (n) => TOOLS.find((t) => t.name === n),
    validateArgs: (n, args) => (fake.some((t) => t.name === n) ? { ok: true, args } : realTools.validateArgs(n, args)),
  };
}

describe('hub: 카드를 붙인 대화', () => {
  let hub, dataDir;
  /** 턴마다 provider 가 할 일 — 테스트가 바꾼다 */
  let script = async () => {};
  const seen = [];
  const provider = {
    id: 'fake',
    label: 'Fake',
    async detect() { return { available: true, models: [{ id: 'm1', label: 'M1' }] }; },
    async runTurn(p) {
      seen.push(p.text);
      await script(p);
      return { messages: p.messages };
    },
  };

  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-hub-cardturn-'));
    hub = await createHub({ port: 0, dataDir, providers: [provider], tools: cardTools(), writeHubJson: false, toolTimeouts: { read: 2000, write: 2000 }, log: () => {} });
  });
  after(async () => {
    await hub.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function studio() {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/studio?token=${encodeURIComponent(hub.token)}`);
    const queue = [];
    ws.on('message', (d) => queue.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const next = async (pred, ms = 3000) => {
      const until = Date.now() + ms;
      for (;;) {
        const i = queue.findIndex(pred);
        if (i >= 0) return queue.splice(i, 1)[0];
        if (Date.now() > until) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const send = (m) => ws.send(JSON.stringify(m));
    const turnEnd = (threadId) => next((m) => m.type === 'agent_event' && m.threadId === threadId && m.event.kind === 'turn_end');
    return { ws, next, send, turnEnd, queue };
  }

  test('블록에는 값이 없고, read_card 는 가리고, 문서로 가는 인자의 자리표시자는 실제 값으로', async () => {
    const me = await hub.cards.save(ME);
    const s = await studio();
    try {
      let readResult;
      let writeResult;
      script = async (p) => {
        readResult = await p.callTool('read_card', { card: me.id });
        writeResult = await p.callTool('replace_range', { text: `{{card:${me.id}.이름}} / {{card:${me.id}.연락처}}`, render: 'crop' });
      };
      s.send({ type: 'chat_send', threadId: 'k1', providerId: 'fake', text: '카드로 채워 줘', mode: 'agent', cards: [me.id] });
      const call = await s.next((m) => m.type === 'tool_call' && m.name === 'replace_range');
      assert.equal(call.args.text, '김하늘 / 010-1234-5678');
      // 민감 값을 넣는 쓰기에는 문서 그림을 붙이지 않는다 (그림 속 글자는 가릴 수 없다)
      assert.equal('render' in call.args, false);
      // 쓰기 tool 은 바뀐 문단 글을 결과에 싣는다 — 민감 값은 모델에 가려서 돌아가야 한다
      s.send({ type: 'tool_result', callId: call.callId, ok: true, result: { applied: true, after: { text: `신청인 ${call.args.text}` } } });
      await s.turnEnd('k1');

      const text = seen.at(-1);
      assert.match(text, /<doogle_cards/);
      assert.equal(text.includes('김하늘'), false);
      assert.equal(readResult.ok, true);
      assert.equal(readResult.result.values.연락처, '***-****-5678');
      assert.equal(writeResult.ok, true);
      assert.equal(writeResult.result.after.text, '신청인 김하늘 / ***-****-5678');
      assert.match(writeResult.result.renderSkipped, /sensitive/);

      // 기록에 카드 이름이 남는다 (화면 복원용)
      const t = await hub.store.get('k1');
      assert.deepEqual(t.transcript.find((e) => e.kind === 'user').cards, [{ id: me.id, name: ME.name, icon: 'person' }]);
      assert.deepEqual(t.cards, [me.id]);

      // 다음 턴에도 카드가 대화에 남는다. 붙이지 않은 카드의 자리표시자는 오류로 끝나고 화면에 가지 않는다
      const other = await hub.cards.save({ ...ME, name: '다른 카드' });
      let bad;
      script = async (p) => { bad = await p.callTool('replace_range', { text: `{{card:${other.id}.이름}}` }); };
      s.send({ type: 'chat_send', threadId: 'k1', providerId: 'fake', text: '또', mode: 'agent' });
      await s.turnEnd('k1');
      assert.equal(bad.error.code, 'CARD_PLACEHOLDER');
      assert.equal(s.queue.some((m) => m.type === 'tool_call'), false);
      assert.match(seen.at(-1), new RegExp(`id=${me.id}`));

      // 뒤 턴에서 문서를 다시 읽어도, 붙인 카드의 민감 값은 모델에 가려서 간다
      let reread;
      script = async (p) => { reread = await p.callTool('get_selection', {}); };
      s.send({ type: 'chat_send', threadId: 'k1', providerId: 'fake', text: '다시 읽어 봐', mode: 'agent' });
      const read = await s.next((m) => m.type === 'tool_call' && m.name === 'get_selection');
      s.send({ type: 'tool_result', callId: read.callId, ok: true, result: { text: '성명 김하늘 연락처 010-1234-5678' } });
      await s.turnEnd('k1');
      assert.equal(reread.result.text, '성명 김하늘 연락처 ***-****-5678');

      // 민감 항목이 있는 카드를 붙인 대화에서는 쪽 그림을 만들지 않는다 (화면에 가지 않는다)
      let picture;
      script = async (p) => { picture = await p.callTool('render_page', { pageIndex: 0 }); };
      s.send({ type: 'chat_send', threadId: 'k1', providerId: 'fake', text: '쪽 그려 봐', mode: 'agent' });
      await s.turnEnd('k1');
      assert.equal(picture.error.code, 'NOT_AVAILABLE');
      assert.equal(s.queue.some((m) => m.type === 'tool_call' && m.name === 'render_page'), false);

      // 카드를 떼면 블록·가리기·그림 막기가 풀린다. 대화를 다시 열 때도 붙은 카드 목록이 온다
      s.send({ type: 'thread_load', reqId: 'L1', threadId: 'k1' });
      const loaded = await s.next((m) => m.type === 'thread' && m.reqId === 'L1');
      assert.deepEqual(loaded.cards, [{ id: me.id, name: ME.name, icon: 'person', sensitive: true }]);
      s.send({ type: 'thread_card_detach', reqId: 'D1', threadId: 'k1', id: me.id });
      const detached = await s.next((m) => m.type === 'thread_card_detached' && m.reqId === 'D1');
      assert.equal(detached.ok, true);
      assert.deepEqual(detached.cards, []);
      script = async (p) => { picture = await p.callTool('render_page', { pageIndex: 0 }); };
      s.send({ type: 'chat_send', threadId: 'k1', providerId: 'fake', text: '이제 그려 봐', mode: 'agent' });
      const draw = await s.next((m) => m.type === 'tool_call' && m.name === 'render_page');
      s.send({ type: 'tool_result', callId: draw.callId, ok: true, result: { text: '연락처 010-1234-5678' } });
      await s.turnEnd('k1');
      assert.equal(picture.ok, true);
      assert.equal(seen.at(-1).includes('<doogle_cards'), false);
      s.send({ type: 'thread_card_detach', reqId: 'D2', threadId: 'k1' });
      assert.equal((await s.next((m) => m.type === 'thread_card_detached' && m.reqId === 'D2')).error.code, 'INVALID_ARGS');
    } finally {
      s.ws.close();
    }
  });

  test('카드만 붙여 보내도 되고, 지워진 카드는 CARD_NOT_FOUND', async () => {
    const card = await hub.cards.save(ROSTER);
    const s = await studio();
    try {
      script = async () => {};
      s.send({ type: 'chat_send', threadId: 'k2', providerId: 'fake', text: '', mode: 'agent', cards: [card.id] });
      await s.turnEnd('k2');
      assert.match(seen.at(-1), /붙인 카드를 확인해 주세요/);
      await hub.cards.delete(card.id);
      s.send({ type: 'chat_send', threadId: 'k3', providerId: 'fake', text: '이거', mode: 'agent', cards: [card.id] });
      const err = await s.next((m) => m.type === 'agent_event' && m.threadId === 'k3' && m.event.kind === 'error');
      assert.equal(err.event.code, 'CARD_NOT_FOUND');
    } finally {
      s.ws.close();
    }
  });

  test('카드 편집 대화: propose_card 만 열리고 초안은 card_proposal 로 화면에 간다', async () => {
    const s = await studio();
    try {
      let blocked;
      let shown;
      script = async (p) => {
        blocked = await p.callTool('replace_range', { text: 'x' });
        shown = await p.callTool('propose_card', { name: '내 인적 사항', kind: 'item', fields: [{ key: '이름', desc: '성명 칸' }], values: { 이름: '김하늘' } });
      };
      s.send({ type: 'chat_send', threadId: 'card-draft-1', providerId: 'fake', text: '나는 김하늘', mode: 'agent', purpose: 'card-draft' });
      const proposal = await s.next((m) => m.type === 'card_proposal');
      await s.turnEnd('card-draft-1');
      assert.equal(proposal.threadId, 'card-draft-1');
      assert.equal(proposal.card.values.이름, '김하늘');
      assert.equal(blocked.error.code, 'NOT_AVAILABLE');
      assert.equal(shown.result.shown, true);
      assert.match(seen.at(-1), /<doogle_card_editor>/);

      // 보통 대화에서는 propose_card 를 쓸 수 없다
      let outside;
      script = async (p) => { outside = await p.callTool('propose_card', { name: 'x', kind: 'item', fields: [{ key: 'a' }] }); };
      s.send({ type: 'chat_send', threadId: 'k4', providerId: 'fake', text: '카드', mode: 'agent' });
      await s.turnEnd('k4');
      assert.equal(outside.error.code, 'NOT_AVAILABLE');

      // 카드를 붙이지 않은 대화에서는 쪽 그림을 그대로 쓸 수 있다
      let picture;
      script = async (p) => { picture = await p.callTool('render_page', { pageIndex: 0 }); };
      s.send({ type: 'chat_send', threadId: 'k4', providerId: 'fake', text: '쪽 그려 봐', mode: 'agent' });
      const call = await s.next((m) => m.type === 'tool_call' && m.name === 'render_page');
      s.send({ type: 'tool_result', callId: call.callId, ok: true, result: { pageIndex: 0 } });
      await s.turnEnd('k4');
      assert.equal(picture.ok, true);
    } finally {
      s.ws.close();
    }
  });
});
