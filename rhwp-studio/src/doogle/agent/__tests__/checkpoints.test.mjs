// 문서 갈래(agent/checkpoints.ts) · 갈래 그림 배치(ui/branch-graph.ts) 테스트.
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/checkpoints.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoogleAgentRuntime } from '../runtime.ts';
import { layoutBranches, branchName, checkpointNumber } from '../../ui/branch-graph.ts';
import { CheckpointTree, resetCheckpointSweepForTests } from '../checkpoints.ts';
import {
  MemoryCheckpointStore, checkpointDocKey, planPrune, sweepStore, STALE_MS,
} from '../checkpoint-store.ts';

/** 문단 배열만 있는 가짜 문서 — 스냅샷과 쓰기만 흉내 낸다 */
class MiniDoc {
  constructor(paras) { this.paras = [...paras]; this.snaps = new Map(); this.next = 1; }
  getSectionCount() { return 1; }
  getParagraphCount() { return this.paras.length; }
  pageCount() { return 1; }
  getParagraphLength(_s, p) { return [...this.paras[p]].length; }
  getTextRange(_s, p, off, n) { return [...this.paras[p]].slice(off, off + n).join(''); }
  insertText(_s, p, off, text) {
    const c = [...this.paras[p]];
    this.paras[p] = c.slice(0, off).join('') + text + c.slice(off).join('');
    return '{"ok":true}';
  }
  getPageOfPosition() { return JSON.stringify({ ok: true, page: 0 }); }
  getPageTextLayout() { return JSON.stringify({ runs: [] }); }
  getCharShapeRuns(_s, _p, start, end) { return JSON.stringify([{ startOffset: start, endOffset: end, charShapeId: 0 }]); }
  getCharPropertiesAt() { return '{}'; }
  getParaPropertiesAt() { return '{}'; }
  getObjects() { return '[]'; }
  saveSnapshot() { const id = this.next++; this.snaps.set(id, [...this.paras]); return id; }
  restoreSnapshot(id) { const s = this.snaps.get(id); if (!s) throw new Error('no snapshot'); this.paras = [...s]; return '{"ok":true}'; }
  discardSnapshot(id) { this.snaps.delete(id); }
  // 문서 갈래 영속화 — 바이트로 뜨고(HWP 대신 JSON), 바이트를 스냅샷으로 넣는다
  exportHwp() { return new TextEncoder().encode(JSON.stringify(this.paras)); }
  importSnapshot(bytes) {
    const paras = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(paras)) throw new Error('bad bytes');
    const id = this.next++;
    this.snaps.set(id, paras);
    return id;
  }
}

function setup(paras) {
  const doc = new MiniDoc(paras);
  let t = 1000;
  const rt = createDoogleAgentRuntime({
    getDocument: () => doc,
    transaction: (_label, fn) => fn(doc),
    now: () => (t += 1000),
  });
  const write = async (text, threadId = 't1') => {
    const r = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, charOffset: 0, text }, { origin: 'agent', threadId, mode: 'full' });
    assert.ok(r.ok, JSON.stringify(r));
  };
  return { doc, rt, h: rt.history, write };
}

test('checkpoints: a turn that edits leaves a node under the origin; a read-only turn leaves none', async () => {
  const { doc, h, write } = setup(['본문']);
  h.beginTurn('t1', 'k1', '앞에 A');
  await write('A');
  const n1 = h.endTurn('k1');
  assert.equal(n1.kind, 'agent');
  assert.equal(n1.label, '앞에 A');
  const origin = h.nodes().find((n) => n.kind === 'origin');
  assert.equal(n1.parentId, origin.id);
  assert.equal(h.head(), n1.id);
  h.beginTurn('t1', 'k2', '읽기만');
  assert.equal(h.endTurn('k2'), null);
  assert.equal(h.nodes().length, 2);
  assert.equal(doc.paras[0], 'A본문');
});

test('checkpoints: checkout restores the state; a new turn from an old node opens a branch', async () => {
  const { doc, h, write } = setup(['본문']);
  h.beginTurn('t1', 'k1', 'A');
  await write('A');
  const a = h.endTurn('k1');
  h.beginTurn('t1', 'k2', 'B');
  await write('B');
  const b = h.endTurn('k2');
  assert.equal(doc.paras[0], 'BA본문');

  const r = h.checkout(a.id);
  assert.equal(r.changed, true);
  assert.equal(doc.paras[0], 'A본문');
  assert.equal(h.head(), a.id);
  assert.equal(h.dirty(), false);

  h.beginTurn('t1', 'k3', 'C');
  await write('C');
  const c = h.endTurn('k3');
  assert.equal(c.parentId, a.id, 'forks from the checked-out node');
  const { rows, lanes } = layoutBranches(h.nodes());
  assert.equal(lanes, 2);
  const laneOf = (id) => rows.find((x) => x.node.id === id).lane;
  assert.equal(laneOf(b.id), 0, 'first child keeps the main lane');
  assert.equal(laneOf(c.id), 1, 'second child opens a new lane');
  assert.equal(branchName(1), '갈래 2');

  // 다른 갈래의 끝으로도 돌아간다
  h.checkout(b.id);
  assert.equal(doc.paras[0], 'BA본문');
});

test('checkpoints: direct edits since the head are kept as a "직접 고침" node before checkout', async () => {
  const { doc, rt, h, write } = setup(['본문']);
  h.beginTurn('t1', 'k1', 'A');
  await write('A');
  const a = h.endTurn('k1');
  // 사용자가 직접 고쳤다 — 이벤트 원천이 없는 구성이라 실행기 쓰기로 revision 을 올린다(mcp 출처)
  await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, charOffset: 0, text: 'U' }, { origin: 'mcp', mode: 'full' });
  assert.equal(h.dirty(), true);
  const origin = h.nodes().find((n) => n.kind === 'origin');
  const r = h.checkout(origin.id);
  assert.equal(r.savedManual, true);
  assert.equal(doc.paras[0], '본문');
  const manual = h.nodes().find((n) => n.kind === 'manual');
  assert.equal(manual.parentId, a.id);
  h.checkout(manual.id);
  assert.equal(doc.paras[0], 'UA본문', 'the direct edit is not lost');
});

test('checkpoints: a node whose snapshot is gone is marked lost and the document stays put', async () => {
  const { doc, h, write } = setup(['본문']);
  h.beginTurn('t1', 'k1', 'A');
  await write('A');
  h.endTurn('k1');
  const origin = h.nodes().find((n) => n.kind === 'origin');
  doc.snaps.clear(); // 엔진이 오래된 스냅샷을 버렸다
  assert.throws(() => h.checkout(origin.id), (e) => e.code === 'CHECKPOINT_LOST');
  assert.equal(doc.paras[0], 'A본문');
  assert.equal(h.nodes().find((n) => n.id === origin.id).lost, true);
});

test('branch layout: topo order — children above parents, a branch stays together; numbers follow creation order', () => {
  const nodes = [
    { id: 'cp1', parentId: null, kind: 'origin', label: '처음 상태', createdAt: 1 },
    { id: 'cp2', parentId: 'cp1', kind: 'agent', label: 'A', createdAt: 2 },
    { id: 'cp3', parentId: 'cp1', kind: 'agent', label: 'B', createdAt: 3 },
    { id: 'cp4', parentId: 'cp2', kind: 'agent', label: 'C', createdAt: 4 },
  ];
  const { rows, lanes } = layoutBranches(nodes);
  // 본줄기(cp4 → cp2)를 끊지 않고 이어 놓은 뒤 갈래 2(cp3), 맨 아래 뿌리
  assert.deepEqual(rows.map((r) => r.node.id), ['cp4', 'cp2', 'cp3', 'cp1']);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 1, 0]);
  assert.equal(lanes, 2);
  assert.equal(checkpointNumber(nodes, 'cp3'), 3);
});

test('branch layout: switching back and forth between branches does not interleave their rows', () => {
  // 본줄기 A, 갈래 2 B(A 의 앞 지점에서), 다시 본줄기 C, 다시 갈래 2 D — 시각 순이면 C·B·D 가 번갈아 끼었다
  const nodes = [
    { id: 'cp1', parentId: null, kind: 'origin', label: '처음', createdAt: 1 },
    { id: 'cp2', parentId: 'cp1', kind: 'agent', label: 'A', createdAt: 2 },
    { id: 'cp3', parentId: 'cp1', kind: 'agent', label: 'B', createdAt: 3 },
    { id: 'cp4', parentId: 'cp2', kind: 'agent', label: 'C', createdAt: 4 },
    { id: 'cp5', parentId: 'cp3', kind: 'agent', label: 'D', createdAt: 5 },
  ];
  const { rows } = layoutBranches(nodes);
  assert.deepEqual(rows.map((r) => r.node.id), ['cp5', 'cp3', 'cp4', 'cp2', 'cp1']);
  // 자식은 언제나 부모보다 위
  const at = new Map(rows.map((r) => [r.node.id, r.row]));
  for (const n of nodes) if (n.parentId) assert.ok(at.get(n.id) < at.get(n.parentId), `${n.id} above ${n.parentId}`);
});

// ─── 영속화 (agent/checkpoint-store.ts) ─────────────────────

const DOC_KEY = 'c:\\docs\\보고서.hwpx';

/** 저장소에 묶인 문서 갈래 하나 — 앱을 한 번 연 것처럼 */
function openTree(store, paras, key = DOC_KEY) {
  const doc = new MiniDoc(paras);
  let rev = 0;
  let t = 10_000;
  const deps = {
    getDocument: () => doc,
    transaction: (_label, fn) => { const r = fn(doc); rev++; return r; },
    now: () => (t += 1000),
    documentKey: () => key,
    checkpointStore: store,
  };
  const tree = new CheckpointTree(deps, {
    revision: () => rev,
    noteWrite: () => rev,
    noteReview: () => {},
  });
  /** 에이전트 턴 하나 — 앞에 text 를 넣는다 */
  const turn = (turnKey, text) => {
    tree.beginTurn('t1', turnKey, text);
    deps.transaction('w', () => doc.insertText(0, 0, 0, text));
    return tree.endTurn(turnKey);
  };
  return { doc, tree, turn };
}

test('persist: nodes survive a reopen and a stored node can be checked out', async () => {
  resetCheckpointSweepForTests();
  const store = new MemoryCheckpointStore();
  const first = openTree(store, ['본문']);
  const a = first.turn('k1', 'A');
  const b = first.turn('k2', 'B');
  assert.equal(first.doc.paras[0], 'BA본문');
  await first.tree.flush();
  const saved = store.trees.get(DOC_KEY);
  assert.equal(saved.nodes.length, 3);
  assert.equal(saved.headId, b.id);
  assert.equal(store.blobs.size, 3, 'origin, A and B each keep their bytes');

  // 앱을 다시 열었다 — 저장한 문서(BA본문)를 연다. 엔진 스냅샷은 하나도 없다
  first.tree.dispose();
  const again = openTree(store, ['BA본문']);
  await again.tree.flush();
  const nodes = again.tree.nodes();
  assert.deepEqual(nodes.map((n) => n.id), saved.nodes.map((n) => n.id));
  assert.ok(nodes.every((n) => n.stored && !n.lost));
  assert.equal(again.tree.head(), b.id, 'same bytes as B → B is where we are');
  assert.equal(again.tree.dirty(), false);
  assert.equal(nodes.find((n) => n.id === a.id).turnKey, 'k1', 'turn links survive for the sidebar');

  // 저장 바이트로 A 에 되돌아간다 — 미리 읽어 둔 바이트라 곧바로
  const r = again.tree.checkout(a.id);
  assert.equal(r.changed, true);
  assert.equal(r.pending, undefined);
  assert.equal(again.doc.paras[0], 'A본문');
  assert.equal(again.tree.head(), a.id);

  // 되돌아간 자리에서 새 요청 → 저장된 나무에 이어 붙는 새 갈래
  const c = again.turn('k3', 'C');
  assert.equal(c.parentId, a.id);
  assert.ok(!saved.nodes.some((n) => n.id === c.id), 'new ids do not collide with stored ones');
  await again.tree.flush();
  assert.equal(store.trees.get(DOC_KEY).nodes.length, 4);
  assert.equal(store.trees.get(DOC_KEY).headId, c.id);
});

test('persist: a stored node not yet in memory is checked out after the read (pending)', async () => {
  resetCheckpointSweepForTests();
  const store = new MemoryCheckpointStore();
  const first = openTree(store, ['본문']);
  const a = first.turn('k1', 'A');
  first.turn('k2', 'B');
  await first.tree.flush();
  first.tree.dispose();

  // 미리 읽기가 실패한 상황 — 읽기를 막아 두었다가 푼다
  const getBlob = store.getBlob.bind(store);
  let open = false;
  store.getBlob = (k, id) => (open ? getBlob(k, id) : Promise.resolve(null));
  const again = openTree(store, ['BA본문']);
  await again.tree.flush();
  open = true;
  const r = again.tree.checkout(a.id);
  assert.equal(r.changed, false);
  assert.ok(r.pending instanceof Promise);
  const done = await r.pending;
  assert.deepEqual({ changed: done.changed, error: done.error }, { changed: true, error: undefined });
  assert.equal(again.doc.paras[0], 'A본문');
  assert.equal(again.tree.head(), a.id);
});

test('persist: a reopened document that differs from the head gets a "직접 고침" node under it', async () => {
  resetCheckpointSweepForTests();
  const store = new MemoryCheckpointStore();
  const first = openTree(store, ['본문']);
  const a = first.turn('k1', 'A');
  await first.tree.flush();
  first.tree.dispose();

  // 앱 밖에서 고친 뒤 다시 열었다
  const again = openTree(store, ['밖에서 A본문']);
  await again.tree.flush();
  assert.equal(again.tree.head(), a.id);
  assert.equal(again.tree.dirty(), true);
  const b = again.turn('k2', 'B');
  const manual = again.tree.nodes().find((n) => n.kind === 'manual');
  assert.equal(manual.parentId, a.id);
  assert.equal(b.parentId, manual.id);
  // 직접 고친 상태로도 돌아올 수 있다
  again.tree.checkout(manual.id);
  assert.equal(again.doc.paras[0], '밖에서 A본문');
});

test('persist: nodes made before the stored tree finished loading are grafted under it', async () => {
  resetCheckpointSweepForTests();
  const store = new MemoryCheckpointStore();
  const first = openTree(store, ['본문']);
  const a = first.turn('k1', 'A');
  await first.tree.flush();
  first.tree.dispose();

  const again = openTree(store, ['A본문']);
  again.turn('k2', 'B'); // 불러오기 전에 요청이 끝났다
  await again.tree.flush();
  const nodes = again.tree.nodes();
  assert.equal(nodes.filter((n) => n.kind === 'origin').length, 1, 'the in-memory root folds into the stored A');
  const bNow = nodes.find((n) => n.turnKey === 'k2');
  assert.equal(bNow.parentId, a.id);
  assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length, 'ids stay unique');
  again.tree.checkout(a.id);
  assert.equal(again.doc.paras[0], 'A본문');
  await again.tree.flush();
  assert.equal(store.trees.get(DOC_KEY).nodes.length, 3);
});

test('persist: a new unsaved document (no key) stays session-only', async () => {
  resetCheckpointSweepForTests();
  const store = new MemoryCheckpointStore();
  const blank = openTree(store, ['본문'], null);
  blank.turn('k1', 'A');
  await blank.tree.flush();
  assert.equal(store.trees.size, 0);
  assert.equal(store.blobs.size, 0);
  assert.equal(blank.tree.nodes().some((n) => n.stored), false);
});

test('persist: nodes whose engine snapshot is trimmed stay reachable through stored bytes', async () => {
  resetCheckpointSweepForTests();
  const store = new MemoryCheckpointStore();
  const s = openTree(store, ['본문']);
  await s.tree.flush();
  const first = s.turn('k0', 'x');
  for (let i = 1; i < 30; i++) s.turn(`k${i}`, 'x');
  await s.tree.flush();
  const node = s.tree.nodes().find((n) => n.id === first.id);
  assert.equal(node.lost, undefined);
  assert.equal(node.stored, true);
  const r = s.tree.checkout(first.id);
  if (r.pending) assert.equal((await r.pending).changed, true); else assert.equal(r.changed, true);
  assert.equal(s.doc.paras[0], 'x본문');
});

test('checkpoint store: prune keeps root and head, drops oldest bytes then unreachable leaves', () => {
  const nodes = [
    { id: 'cp1', parentId: null, kind: 'origin', createdAt: 1, size: 10, stored: true, live: false },
    { id: 'cp2', parentId: 'cp1', kind: 'agent', createdAt: 2, size: 10, stored: true, live: false },
    { id: 'cp3', parentId: 'cp2', kind: 'agent', createdAt: 3, size: 10, stored: true, live: false },
    { id: 'cp4', parentId: 'cp1', kind: 'agent', createdAt: 4, size: 10, stored: false, live: false },
    { id: 'cp5', parentId: 'cp3', kind: 'agent', createdAt: 5, size: 10, stored: true, live: true },
  ];
  const plan = planPrune({ nodes, headId: 'cp5' }, { maxStored: 3, maxBytes: 25, maxNodes: 4 });
  assert.deepEqual(plan.dropBytes, ['cp2', 'cp3'], 'oldest first, origin kept');
  assert.deepEqual(plan.dropNodes, ['cp4'], 'only an unreachable leaf is removed');
});

test('checkpoint store: document keys and the app-wide sweep', async () => {
  assert.equal(checkpointDocKey('C:/Docs/보고서.HWPX', '보고서.HWPX', false), DOC_KEY);
  assert.equal(checkpointDocKey(null, '보고서 복구본.hwp', false), 'name:보고서');
  assert.equal(checkpointDocKey(null, '새 문서.hwp', true), null);
  assert.equal(checkpointDocKey(null, '보고서.hwp', false, false), null, 'desktop: no path → session-only');
  const store = new MemoryCheckpointStore();
  const now = 10 * STALE_MS;
  await store.saveTree({ v: 1, docKey: 'old', headId: null, seq: 0, nodes: [], bytes: 1, updatedAt: now - STALE_MS - 1 });
  await store.saveTree({ v: 1, docKey: 'fresh', headId: null, seq: 0, nodes: [], bytes: 1, updatedAt: now - 1 });
  await store.putBlob('old', 'cp1', new Uint8Array([1]));
  assert.deepEqual(await sweepStore(store, null, now), ['old']);
  assert.equal(store.blobs.size, 0);
  assert.ok(store.trees.has('fresh'));
});

test('persist: a reopened HWPX whose bytes shifted but text did not still lands on its head', async () => {
  resetCheckpointSweepForTests();
  const store = new MemoryCheckpointStore();
  const first = openTree(store, ['본문']);
  const a = first.turn('k1', 'A');
  await first.tree.flush();
  first.tree.dispose();

  // 다시 열면 내보낸 바이트가 조금 다르다(HWPX → HWP 첫 왕복) — 글은 그대로
  const doc = new MiniDoc(['A본문']);
  const plain = doc.exportHwp.bind(doc);
  doc.exportHwp = () => new Uint8Array([...plain(), 32]);
  const again = openTree(store, ['A본문']);
  again.doc.exportHwp = doc.exportHwp;
  await again.tree.flush();
  assert.equal(again.tree.head(), a.id);
  assert.equal(again.tree.dirty(), false, 'no spurious "직접 고침" node');
});

test('checkpoints: an executor made before the document loaded does not wipe the first turn on its first tool call', async () => {
  // 문서 탭: 실행기는 새 문서가 다 열리기 전(인스턴스 0)에 만들어질 수 있다 — 그 뒤 첫 도구 호출이
  // 인스턴스가 바뀐 것을 보고 갈래까지 지우면 새 문서의 첫 요청 지점이 사라진다.
  const doc = new MiniDoc(['본문']);
  let instance = 0;
  const rt = createDoogleAgentRuntime({
    getDocument: () => doc,
    transaction: (_label, fn) => fn(doc),
    documentInstance: () => instance,
  });
  instance = 1; // 문서가 다 열렸다
  rt.history.beginTurn('t1', 'k1', 'A');
  assert.equal(rt.history.nodes().length, 1, 'origin captured');
  const ctx = { origin: 'agent', threadId: 't1', mode: 'full' };
  const r = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, charOffset: 0, text: 'A' }, ctx);
  assert.ok(r.ok, JSON.stringify(r));
  const node = rt.history.endTurn('k1');
  assert.ok(node, 'the turn left a checkpoint');
  assert.deepEqual(rt.history.nodes().map((n) => n.kind), ['origin', 'agent']);
});
