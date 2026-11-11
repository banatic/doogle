// 대화 저장소(ThreadStore): 목록 색인 · 옛 대화 기록 채우기 · 지우기 · 보관 한도.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { ThreadStore, docMatches, docStem } from '../src/threads.mjs';

/** 대화 하나를 만들어 저장한다 */
async function put(store, id, { text = `${id} 요청`, doc = null, updatedAt = null } = {}) {
  const t = await store.get(id);
  t.title = text;
  t.transcript.push({ kind: 'user', text }, { kind: 'text_delta', text: '답' }, { kind: 'turn_end', reason: 'done' });
  if (doc) t.doc = doc;
  await store.save(t);
  if (updatedAt) {
    t.updatedAt = updatedAt;
    await store.save(t, { touch: false });
  }
  return t;
}

describe('ThreadStore', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-threads-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('목록은 색인으로 만든다 — 다시 열어도 대화 파일을 통째로 읽지 않는다', async () => {
    const a = new ThreadStore({ dir });
    const doc = { key: 'c:\\docs\\a.hwp', name: 'a.hwp' };
    for (let i = 0; i < 12; i++) await put(a, `t${i}`, { doc: i % 2 ? doc : null });
    await a.flush();

    // 새 프로세스(새 저장소): 색인 파일이 있어 대화 파일은 읽지 않는다
    const b = new ThreadStore({ dir });
    const all = await b.list(50);
    assert.equal(all.length, 12);
    assert.equal(b.fileReads, 0);
    const mine = await b.list(50, doc);
    assert.equal(mine.length, 6);
    assert.ok(mine.every((t) => t.doc?.key === doc.key));
    assert.equal(b.fileReads, 0);
    assert.deepEqual(Object.keys(all[0]).sort(), ['createdAt', 'doc', 'id', 'title', 'turns', 'updatedAt']);
    assert.equal(all[0].turns, 1);
  });

  test('색인이 없거나 깨져도 파일에서 다시 만들고, 바뀐 파일만 다시 읽는다', async () => {
    const a = new ThreadStore({ dir });
    for (let i = 0; i < 5; i++) await put(a, `t${i}`);
    await a.flush();
    await fs.writeFile(path.join(dir, 'threads.index'), '{깨진 색인');

    const b = new ThreadStore({ dir });
    assert.equal((await b.list()).length, 5);
    assert.equal(b.fileReads, 5); // 한 번은 다 읽는다
    await b.list();
    assert.equal(b.fileReads, 5); // 그 뒤로는 읽지 않는다

    // 밖에서 파일 하나가 바뀌면(다른 프로세스·수동 편집) 그 파일만 다시 읽는다
    const file = path.join(dir, 't3.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.title = '밖에서 고친 제목';
    await fs.writeFile(file, JSON.stringify(raw));
    const list = await b.list();
    assert.equal(b.fileReads, 6);
    assert.equal(list.find((t) => t.id === 't3').title, '밖에서 고친 제목');

    // 밖에서 지운 파일은 목록에서 빠진다
    await fs.unlink(path.join(dir, 't4.json'));
    assert.equal((await b.list()).some((t) => t.id === 't4'), false);
  });

  test('깨진 대화 파일은 건너뛰고, 바뀌기 전에는 다시 읽지 않는다', async () => {
    const a = new ThreadStore({ dir });
    await put(a, 'ok');
    await a.flush();
    await fs.writeFile(path.join(dir, 'broken.json'), '{');
    const b = new ThreadStore({ dir });
    assert.deepEqual((await b.list()).map((t) => t.id), ['ok']);
    const reads = b.fileReads;
    await b.list();
    assert.equal(b.fileReads, reads);
  });

  test('옛 대화의 화면 기록은 한 번 만들어 파일에 적어 둔다 (순서는 그대로)', async () => {
    const old = { id: 'old1', title: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', lastProviderId: 'claude-sdk', histories: { 'claude-sdk': [{ type: 'claude-sdk-session', sessionId: 's-1' }] }, pendingReviews: [] };
    const none = { ...old, id: 'old2', histories: {} };
    await fs.writeFile(path.join(dir, 'old1.json'), JSON.stringify(old));
    await fs.writeFile(path.join(dir, 'old2.json'), JSON.stringify(none));
    let calls = 0;
    const backfill = async (t) => {
      calls++;
      if (t.id !== 'old1') return null;
      return { transcript: [{ kind: 'user', text: '옛 요청' }, { kind: 'turn_end', reason: 'done' }], doc: { key: '', name: '옛문서.hwp' } };
    };
    const a = new ThreadStore({ dir, backfill });
    const first = await a.list();
    assert.deepEqual(first.map((t) => [t.id, t.title, t.updatedAt]), [['old1', '옛 요청', '2026-01-02T00:00:00.000Z']]);
    assert.equal(calls, 2);
    // 같은 저장소: 다시 만들지 않는다
    await a.list();
    assert.equal(calls, 2);
    await a.flush();
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'old1.json'), 'utf8'));
    assert.equal(saved.transcript.length, 2);
    assert.equal(saved.updatedAt, '2026-01-02T00:00:00.000Z');
    assert.deepEqual(saved.doc, { key: '', name: '옛문서.hwp' });

    // 새 프로세스: 만든 기록은 파일에 있고, 못 만든 대화는 색인에 표시돼 다시 시도하지 않는다
    const b = new ThreadStore({ dir, backfill });
    assert.deepEqual((await b.list(50, { key: '', name: '옛문서.hwpx' })).map((t) => t.id), ['old1']);
    assert.equal(calls, 2);
    assert.equal(b.fileReads, 0);
  });

  test('지우기 — 파일·목록에서 사라지고, 뒤늦은 저장이 되살리지 않는다', async () => {
    const a = new ThreadStore({ dir });
    const t = await put(a, 'gone');
    await put(a, 'stay');
    const pendingSave = a.save(t); // 저장이 도는 중에 지운다
    assert.equal(await a.delete('gone'), true);
    await pendingSave;
    await a.save(t);
    await a.flush();
    await assert.rejects(fs.access(path.join(dir, 'gone.json')), (e) => e.code === 'ENOENT');
    assert.deepEqual((await a.list()).map((x) => x.id), ['stay']);
    assert.equal(await a.delete('never-existed'), false);
    await assert.rejects(a.delete(''), /invalid threadId/);
    // 새 프로세스에서도 없다
    const b = new ThreadStore({ dir });
    assert.deepEqual((await b.list()).map((x) => x.id), ['stay']);
    assert.equal(b.fileReads, 0);
  });

  test('보관 한도 — 오래 쓰지 않은 것부터 지우고, 쓰는 대화·깨진 파일은 남긴다', async () => {
    const a = new ThreadStore({ dir });
    for (let i = 0; i < 8; i++) await put(a, `t${i}`, { updatedAt: `2026-02-0${i + 1}T00:00:00.000Z` });
    await a.flush();
    await fs.writeFile(path.join(dir, 'broken.json'), '{');

    const b = new ThreadStore({ dir, maxThreads: 5 });
    await b.get('t0'); // 이번 실행에서 연 대화
    const gone = await b.prune((id) => id === 't1'); // t1 은 응답 중
    assert.deepEqual(gone.sort(), ['t2']);
    assert.deepEqual((await b.list()).map((t) => t.id).sort(), ['t0', 't1', 't3', 't4', 't5', 't6', 't7']);
    await fs.access(path.join(dir, 'broken.json'));
    // 한도 안이면 아무것도 지우지 않는다
    const c = new ThreadStore({ dir, maxThreads: 50 });
    assert.deepEqual(await c.prune(), []);
    // 한도 0 = 한도 없음
    const d = new ThreadStore({ dir, maxThreads: 0 });
    assert.deepEqual(await d.prune(), []);
  });

  test('메모리 전용(dir 없음)에서도 목록·지우기가 된다', async () => {
    const a = new ThreadStore();
    await put(a, 'm1');
    await put(a, 'm2');
    assert.equal((await a.list()).length, 2);
    assert.equal(await a.delete('m1'), true);
    assert.deepEqual((await a.list()).map((t) => t.id), ['m2']);
  });

  test('문서 맞추기 — 경로가 둘 다 있으면 경로, 아니면 이름 줄기', () => {
    assert.equal(docStem('보고서 복구본 복구본.HWPX'), '보고서');
    assert.equal(docMatches({ key: 'c:\\a\\x.hwp', name: 'x.hwp' }, { key: 'c:\\b\\x.hwp', name: 'x.hwp' }), false);
    assert.equal(docMatches({ key: '', name: 'x.hwp' }, { key: 'c:\\b\\x.hwpx', name: 'X.hwpx' }), true);
    assert.equal(docMatches(null, { key: '', name: 'x.hwp' }), false);
  });
});
