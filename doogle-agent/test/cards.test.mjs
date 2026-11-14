// 카드 저장소(CardStore)와 hub 카드 메시지(cards_query · card_save · card_delete).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import WebSocket from 'ws';

import { CARD_LIMITS, CardStore, normalizeCard } from '../src/cards.mjs';
import { createHub } from '../src/hub.mjs';
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
  rows: [['1', '강서윤', '010-2201-4410'], [2, '권도현']],
};

describe('normalizeCard', () => {
  test('항목형: 빠진 값은 빈 글, 민감 여부·설명 기본값', () => {
    const c = normalizeCard({ ...ME, values: { 이름: '김하늘' } });
    assert.deepEqual(c.values, { 이름: '김하늘', 소속: '', 연락처: '' });
    assert.equal(c.fields[0].sensitive, false);
    assert.equal(c.fields[2].sensitive, true);
    assert.equal(normalizeCard({ ...ME, fields: [{ key: '이름' }], values: {} }).fields[0].desc, '');
  });

  test('표형: 숫자는 글로, 모자란 칸은 빈 글로 채워 항목 수에 맞춘다', () => {
    const c = normalizeCard(ROSTER);
    assert.deepEqual(c.rows, [['1', '강서윤', '010-2201-4410'], ['2', '권도현', '']]);
    assert.equal(c.values, undefined);
  });

  test('모르는 아이콘은 card 로', () => {
    assert.equal(normalizeCard({ ...ME, icon: 'rocket' }).icon, 'card');
  });

  test('잘못된 꼴은 INVALID_CARD', () => {
    const bad = [
      null,
      { ...ME, name: '  ' },
      { ...ME, kind: 'blob' },
      { ...ME, fields: [] },
      { ...ME, fields: [{ key: '이름' }, { key: '이름' }] },
      { ...ME, fields: [{ key: '학교.주소' }] },
      { ...ME, fields: [{ key: '{x}' }] },
      { ...ME, values: { 없는항목: 'x' } },
      { ...ME, values: { 이름: { nested: true } } },
      { ...ROSTER, rows: [['1', '2', '3', '4']] },
      { ...ROSTER, rows: 'x' },
      { ...ME, fields: Array.from({ length: CARD_LIMITS.fields + 1 }, (_, i) => ({ key: `k${i}` })), values: {} },
    ];
    for (const input of bad) assert.throws(() => normalizeCard(input), (e) => e.code === 'INVALID_CARD', JSON.stringify(input)?.slice(0, 80));
  });
});

describe('CardStore', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-cards-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  test('저장 → 다른 저장소에서 다시 읽기, 최근에 고친 것부터', async () => {
    const a = new CardStore({ dir });
    const me = await a.save(ME);
    assert.match(me.id, /^c-[0-9a-f]{16}$/);
    assert.equal(me.createdAt, me.updatedAt);
    await new Promise((r) => setTimeout(r, 5));
    const roster = await a.save(ROSTER);

    const b = new CardStore({ dir });
    const list = await b.list();
    assert.deepEqual(list.map((c) => c.id), [roster.id, me.id]);
    assert.deepEqual(await b.get(me.id), me);
  });

  test('id 가 있으면 고치고 createdAt 은 그대로, 모르는 id 는 새 카드', async () => {
    const s = new CardStore({ dir });
    const me = await s.save(ME);
    await new Promise((r) => setTimeout(r, 5));
    const edited = await s.save({ ...ME, id: me.id, name: '내 정보' });
    assert.equal(edited.id, me.id);
    assert.equal(edited.createdAt, me.createdAt);
    assert.notEqual(edited.updatedAt, me.updatedAt);
    assert.equal((await s.list()).length, 1);
    const other = await s.save({ ...ME, id: 'c-unknown' });
    assert.notEqual(other.id, 'c-unknown');
    assert.equal((await s.list()).length, 2);
  });

  test('지우면 파일도 사라지고, 없는 카드는 false', async () => {
    const s = new CardStore({ dir });
    const me = await s.save(ME);
    await fs.access(path.join(dir, `${me.id}.json`));
    assert.equal(await s.delete(me.id), true);
    await assert.rejects(fs.access(path.join(dir, `${me.id}.json`)), (e) => e.code === 'ENOENT');
    assert.equal(await s.delete(me.id), false);
    assert.equal(await new CardStore({ dir }).get(me.id), null);
  });

  test('깨진 파일·남의 파일은 건너뛴다', async () => {
    const s = new CardStore({ dir });
    const me = await s.save(ME);
    await fs.writeFile(path.join(dir, 'c-broken.json'), '{깨짐');
    await fs.writeFile(path.join(dir, 'not a card.json'), JSON.stringify(ME));
    const list = await new CardStore({ dir }).list();
    assert.deepEqual(list.map((c) => c.id), [me.id]);
  });

  test('메모리 전용(dir 없음)도 같은 동작', async () => {
    const s = new CardStore();
    const me = await s.save(ME);
    assert.equal((await s.get(me.id)).name, ME.name);
    assert.equal(await s.delete(me.id), true);
  });
});

describe('hub 카드 메시지', () => {
  let hub, dataDir;
  before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-hub-cards-'));
    hub = await createHub({ port: 0, dataDir, providers: [], tools: { ...stubTools(), stub: false }, writeHubJson: false, log: () => {} });
  });
  after(async () => {
    await hub.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  /** 메시지 하나 보내고 pred 에 맞는 답 하나를 받는다 */
  async function open() {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/studio?token=${encodeURIComponent(hub.token)}`);
    const queue = [];
    ws.on('message', (d) => queue.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const ask = async (msg, pred) => {
      ws.send(JSON.stringify(msg));
      const until = Date.now() + 3000;
      for (;;) {
        const i = queue.findIndex(pred);
        if (i >= 0) return queue.splice(i, 1)[0];
        if (Date.now() > until) throw new Error(`timeout: ${msg.type}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    return { ws, ask };
  }

  test('저장 · 목록 · 고치기 · 지우기, 파일은 <dataDir>/cards 에', async () => {
    const { ws, ask } = await open();
    try {
      const empty = await ask({ type: 'cards_query', reqId: 'q1' }, (m) => m.type === 'cards' && m.reqId === 'q1');
      assert.deepEqual(empty.list, []);

      const saved = await ask({ type: 'card_save', reqId: 's1', card: ME }, (m) => m.type === 'card_saved' && m.reqId === 's1');
      assert.equal(saved.ok, true);
      assert.equal(saved.card.values.이름, '김하늘');
      await fs.access(path.join(dataDir, 'cards', `${saved.card.id}.json`));

      const edited = await ask({ type: 'card_save', reqId: 's2', card: { ...saved.card, name: '내 정보' } }, (m) => m.type === 'card_saved' && m.reqId === 's2');
      assert.equal(edited.card.id, saved.card.id);

      const list = await ask({ type: 'cards_query', reqId: 'q2' }, (m) => m.type === 'cards' && m.reqId === 'q2');
      assert.deepEqual(list.list.map((c) => c.name), ['내 정보']);

      const gone = await ask({ type: 'card_delete', reqId: 'd1', id: saved.card.id }, (m) => m.type === 'card_deleted' && m.reqId === 'd1');
      assert.equal(gone.ok, true);
      const again = await ask({ type: 'card_delete', reqId: 'd2', id: saved.card.id }, (m) => m.type === 'card_deleted' && m.reqId === 'd2');
      assert.equal(again.error.code, 'NOT_FOUND');
      const noId = await ask({ type: 'card_delete', reqId: 'd3' }, (m) => m.type === 'card_deleted' && m.reqId === 'd3');
      assert.equal(noId.error.code, 'INVALID_ARGS');
    } finally {
      ws.close();
    }
  });

  test('잘못된 카드는 ok:false + INVALID_CARD (hub 는 그대로 돈다)', async () => {
    const { ws, ask } = await open();
    try {
      const bad = await ask({ type: 'card_save', reqId: 'b1', card: { ...ME, kind: 'blob' } }, (m) => m.type === 'card_saved' && m.reqId === 'b1');
      assert.equal(bad.ok, false);
      assert.equal(bad.error.code, 'INVALID_CARD');
      const list = await ask({ type: 'cards_query', reqId: 'b2' }, (m) => m.type === 'cards' && m.reqId === 'b2');
      assert.ok(Array.isArray(list.list));
    } finally {
      ws.close();
    }
  });
});
