// 두글 실행기 순수 로직·가짜 엔진 테스트.
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/agent-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnchor, looseWhitespacePattern, parseAnchorArgs, buildAnchorScope } from '../anchor.ts';
import { EditJournal } from '../edit-journal.ts';
import { RevisionTracker } from '../revision.ts';
import { createDoogleAgentRuntime } from '../runtime.ts';
import { describeChange, formatChips } from '../../review/describe.ts';
import { ReviewStore } from '../../review/state.ts';
import { matchReviewKey, impactSentence, chainSentence, gutterPositions } from '../../review/keys.ts';

// ─── 가짜 원천 / 엔진 ──────────────────────────────────

function sourceOf(paragraphs) {
  return {
    exact(query, caseSensitive) {
      const out = [];
      paragraphs.forEach((text, paraIdx) => {
        const hay = caseSensitive ? text : text.toLowerCase();
        const needle = caseSensitive ? query : query.toLowerCase();
        for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
          out.push({ sectionIdx: 0, paraIdx, charOffset: [...text.slice(0, i)].length, length: [...query].length, context: text });
        }
      });
      return out;
    },
    *paragraphs() {
      for (const [paraIdx, text] of paragraphs.entries()) yield { sectionIdx: 0, paraIdx, text };
    },
  };
}

/** 본문만 있는 아주 작은 HwpDocument 흉내 (구역 1개, 쪽 = 문단 2개씩) */
class FakeDoc {
  constructor(paragraphs) { this.paras = [...paragraphs]; this.snaps = new Map(); this.next = 1; }
  getSectionCount() { return 1; }
  getParagraphCount() { return this.paras.length; }
  pageCount() { return Math.max(1, Math.ceil(this.paras.length / 2)); }
  getDocumentInfo() { return JSON.stringify({ pageCount: this.pageCount(), sectionCount: 1 }); }
  check(p) { if (p < 0 || p >= this.paras.length) throw new Error(`para ${p} out of range`); }
  getParagraphLength(_s, p) { this.check(p); return [...this.paras[p]].length; }
  getTextRange(_s, p, off, n) { this.check(p); return [...this.paras[p]].slice(off, off + n).join(''); }
  insertText(_s, p, off, text) {
    this.check(p);
    const c = [...this.paras[p]]; if (off > c.length) throw new Error('offset');
    this.paras[p] = c.slice(0, off).join('') + text + c.slice(off).join(''); return JSON.stringify({ ok: true });
  }
  deleteText(_s, p, off, n) { this.check(p); const c = [...this.paras[p]]; c.splice(off, n); this.paras[p] = c.join(''); return '{"ok":true}'; }
  replaceText(_s, p, off, n, text) { this.deleteText(0, p, off, n); return this.insertText(0, p, off, text); }
  splitParagraph(_s, p, off) { const c = [...this.paras[p]]; this.paras.splice(p, 1, c.slice(0, off).join(''), c.slice(off).join('')); return '{"ok":true}'; }
  deleteRange(_s, sp, so, ep, eo) {
    const head = [...this.paras[sp]].slice(0, so).join(''); const tail = [...this.paras[ep]].slice(eo).join('');
    this.paras.splice(sp, ep - sp + 1, head + tail); return '{"ok":true}';
  }
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
  getCharPropertiesAt(_s, p) { return JSON.stringify({ fontSize: 1000, bold: false, ...(this.fmt?.get(p) ?? {}) }); }
  applyCharFormat(_s, p, _start, _end, json) {
    this.check(p); this.fmt ??= new Map(); this.fmt.set(p, { ...(this.fmt.get(p) ?? {}), ...JSON.parse(json) }); return '{"ok":true}';
  }
  getParaPropertiesAt() { return JSON.stringify({ headType: 'None' }); }
  getPageOfPosition(_s, p) { return JSON.stringify({ ok: true, page: Math.floor(p / 2) }); }
  getPageTextLayout(page) { const p = page * 2; return JSON.stringify({ runs: p < this.paras.length ? [{ secIdx: 0, paraIdx: p, charStart: 0, text: 'x', x: 0, y: 0, w: 1, h: 1 }] : [] }); }
  saveSnapshot() { const id = this.next++; this.snaps.set(id, [...this.paras]); return id; }
  restoreSnapshot(id) { const s = this.snaps.get(id); if (!s) throw new Error('no snapshot'); this.paras = [...s]; return '{"ok":true}'; }
  discardSnapshot(id) { this.snaps.delete(id); }
}

function fakeDeps(doc, undoLog = []) {
  return {
    getDocument: () => doc,
    transaction: (label, fn) => {
      const before = [...doc.paras];
      try {
        const r = fn(doc);
        undoLog.push({ label, before });
        return r;
      } catch (e) {
        doc.paras = before; // SnapshotCommand 처럼 원자 롤백
        throw e;
      }
    },
  };
}

// ─── 앵커 ─────────────────────────────────────────────

test('anchor: exact single match resolves; ambiguous fails with candidates; occurrence picks', () => {
  const src = sourceOf(['가나다 라마', '바사 가나다']);
  const one = resolveAnchor(src, parseAnchorArgs({ find: '라마' }), undefined);
  assert.deepEqual([one.paraIdx, one.charOffset, one.length], [0, 4, 2]);
  assert.throws(() => resolveAnchor(src, parseAnchorArgs({ find: '가나다' }), undefined), /ambiguous — 2 matches/);
  const second = resolveAnchor(src, parseAnchorArgs({ find: '가나다', occurrence: 2 }), undefined);
  assert.deepEqual([second.paraIdx, second.charOffset], [1, 3]);
  assert.throws(() => resolveAnchor(src, parseAnchorArgs({ find: '없음' }), undefined), /matched nothing/);
});

test('anchor: whitespace-tolerant fallback and scoping by paraIdx', () => {
  const src = sourceOf(['제 1 조   목적', '제 1 조 목적']);
  const scope = buildAnchorScope({ paraIdx: 0 }, undefined);
  const m = resolveAnchor(src, parseAnchorArgs({ find: '1 조 목적' }), scope);
  assert.equal(m.paraIdx, 0);
  assert.equal(m.matchedText, '1 조   목적');
  assert.ok(looseWhitespacePattern('a b').test('a　b'));
  assert.throws(() => parseAnchorArgs({ find: 'x', charOffset: 3 }), /both place the target/);
  assert.throws(() => parseAnchorArgs({ occurrence: 2 }), /refines a text match/);
});

// ─── revision · 저널 ──────────────────────────────────

test('revision: noteWrite bumps once; events dedupe within a tick', async () => {
  const handlers = new Map();
  const events = { on(name, h) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(h); return () => {}; } };
  const t = new RevisionTracker(events, { initialRevision: 10 });
  handlers.get('document-changed')[0]();
  handlers.get('document-mutated')[0]();
  assert.equal(t.revision, 11);
  assert.equal(t.noteWrite(10), 11, 'event bump already happened');
  assert.equal(t.noteWrite(11), 12, 'second write in the same tick still gets its own revision');
  await Promise.resolve();
  handlers.get('document-changed')[0]();
  assert.equal(t.revision, 13);
});

test('journal: disjoint edits rebase, overlapping edits conflict, gaps refuse', () => {
  const j = new EditJournal();
  j.record(1, 2, { sectionIdx: 0, paraStart: 3, paraEnd: 3, paraDelta: 2 });
  assert.deepEqual(j.rebase(1, 2, 0, 10, 10), { ok: true, shift: 2 });
  assert.equal(j.rebase(1, 2, 0, 3, 3).ok, false);
  assert.equal(j.rebase(1, 3, 0, 10, 10).reason, 'gap');
});

// ─── 실행기 (가짜 엔진) ────────────────────────────────

test('executor: read → write with expectedRevision; stale revision → REVISION_MISMATCH', async () => {
  const doc = new FakeDoc(['첫째 문단', '둘째 문단', '셋째']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const ctx = { origin: 'agent', threadId: 't1', mode: 'full' };
  const s = await rt.executeTool('get_structure', {}, ctx);
  assert.ok(s.ok, JSON.stringify(s));
  assert.match(s.result.text, /s0 p0 \(5\) 첫째 문단/);
  const rev = s.result.revision;
  const w = await rt.executeTool('replace_range', { expectedRevision: rev, find: '둘째', text: '두 번째' }, ctx);
  assert.ok(w.ok, JSON.stringify(w));
  assert.equal(doc.paras[1], '두 번째 문단');
  assert.ok(w.result.revision > rev);
  assert.equal(w.result.after.paragraphs[0].text, '두 번째 문단');
  // 낡은 revision 의 좌표 쓰기 — 같은 문단이면 충돌
  const stale = await rt.executeTool('insert_text', { expectedRevision: rev, paraIdx: 1, charOffset: 0, text: 'X' }, ctx);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'REVISION_MISMATCH');
  // 다른 문단이면 저널로 리베이스
  const rebased = await rt.executeTool('insert_text', { expectedRevision: rev, paraIdx: 2, charOffset: 0, text: 'Y' }, ctx);
  assert.ok(rebased.ok, JSON.stringify(rebased));
  assert.equal(doc.paras[2], 'Y셋째');
});

test('executor: apply_edits is atomic and reports every failing item', async () => {
  const doc = new FakeDoc(['alpha', 'beta']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const ctx = { origin: 'mcp', mode: 'full' };
  const rev = rt.revision();
  const r = await rt.executeTool('apply_edits', {
    expectedRevision: rev,
    edits: [
      { tool: 'replace_range', find: 'alpha', text: 'ALPHA' },
      { tool: 'replace_range', find: 'missing', text: 'x' },
      { tool: 'insert_text', paraIdx: 9, charOffset: 0, text: 'x' },
    ],
  }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BATCH_FAILED');
  assert.match(r.error.message, /edits\[1\].*edits\[2\]/);
  assert.deepEqual(doc.paras, ['alpha', 'beta'], 'nothing applied');
  const ok = await rt.executeTool('apply_edits', {
    expectedRevision: rt.revision(),
    edits: [{ tool: 'replace_range', find: 'alpha', text: 'ALPHA' }, { tool: 'insert_text', paraIdx: 1, text: '!' }],
  }, ctx);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual(doc.paras, ['ALPHA', 'beta!']);
});

test('executor: agent mode stages edits; reject restores; other thread is busy', async () => {
  const doc = new FakeDoc(['원문']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const ctx = { origin: 'agent', threadId: 'A', mode: 'agent' };
  const events = [];
  rt.pending.onChange((e) => events.push(e.kind));
  const r = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: ' 추가' }, ctx);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.result.staged, true);
  assert.equal(doc.paras[0], '원문 추가', 'live preview applied');
  assert.equal(rt.pending.list('A').length, 1);
  const busy = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: '!' }, { ...ctx, threadId: 'B' });
  assert.equal(busy.error?.code, 'DOCUMENT_WRITER_BUSY');
  const rej = rt.pending.rejectAll('A');
  assert.equal(rej.rejected, 1);
  assert.equal(doc.paras[0], '원문');
  assert.deepEqual(events, ['added', 'rejected']);
  const next = await rt.executeTool('get_text_range', { paraIdx: 0 }, ctx);
  assert.equal(next.result.editReport.decision, 'rejected');
});

test('executor: per-change review — accept keeps, rejectFrom restores that change and later ones', async () => {
  const doc = new FakeDoc(['하나', '둘', '셋']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const ctx = { origin: 'agent', threadId: 'A', mode: 'agent' };
  for (const [paraIdx, text] of [[0, '1'], [1, '2'], [2, '3']]) {
    const r = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx, text }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
  }
  const list = rt.pending.list('A');
  assert.equal(list.length, 3);
  assert.equal(list[0].targets?.[0]?.paraIdx, 0);
  assert.equal(list[0].args?.text, '1');
  // 마지막 행만 거절
  assert.equal(rt.pending.rejectFrom(list[2].id).rejected, 1);
  assert.deepEqual(doc.paras, ['하나1', '둘2', '셋']);
  // 두 번째 행 적용(kept) → 첫 행이 대기 중이라 남아 있다
  rt.pending.accept(list[1].id);
  assert.equal(rt.pending.list('A').length, 2);
  assert.equal(rt.pending.list('A')[1].kept, true);
  // 첫 행 적용 → 모두 확정
  rt.pending.accept(list[0].id);
  assert.equal(rt.pending.hasPending(), false);
  assert.deepEqual(doc.paras, ['하나1', '둘2', '셋']);
  assert.equal(doc.snaps.size, 0, 'all review snapshots discarded');
});

// ─── 검토 흐름 (UI_AUDIT 3.3) ─────────────────────────

function eventSource() {
  const handlers = new Map();
  return {
    on(name, h) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(h); return () => {}; },
    emit(name, payload) { for (const h of handlers.get(name) ?? []) h(payload); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('pending: user edits between / after staged writes are flagged and reported before reject', async () => {
  const doc = new FakeDoc(['가', '나', '다']);
  const events = eventSource();
  const rt = createDoogleAgentRuntime({ ...fakeDeps(doc), events });
  const ctx = { origin: 'agent', threadId: 'A', mode: 'agent' };
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: '1' }, ctx)).ok);
  await tick();
  assert.equal(rt.pending.hasUserEditsSince(), false, 'agent writes alone are not user edits');
  // 사용자가 둘째 문단을 직접 고친다
  doc.paras[1] += 'U';
  events.emit('document-changed');
  await tick();
  assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 2, text: '3' }, ctx)).ok);
  await tick();
  const [first, second] = rt.pending.list('A');
  assert.equal(first.userEditsBefore, undefined);
  assert.equal(second.userEditsBefore, true);
  assert.equal(rt.pending.hasUserEditsSince(first.id), true, 'rejecting the first change would revert the user edit');
  assert.equal(rt.pending.hasUserEditsSince(second.id), false, 'the user edit sits before the second change snapshot');
  // 마지막 변경 뒤 직접 편집
  doc.paras[0] += 'T';
  events.emit('document-changed');
  await tick();
  assert.equal(rt.pending.hasUserEditsSince(second.id), true);
  const r = rt.pending.rejectFrom(second.id);
  assert.equal(r.userEditsReverted, true);
  assert.deepEqual(doc.paras, ['가1', '나U', '다'], 'edit between rows kept; trailing edit reverted with the row');
});

test('pending: format writes record before/after props; describe renders chips', async () => {
  const doc = new FakeDoc(['원문 둘째']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const ctx = { origin: 'agent', threadId: 'A', mode: 'agent' };
  const w = await rt.executeTool('apply_char_format', { expectedRevision: rt.revision(), find: '원문', bold: true, fontSizePt: 12 }, ctx);
  assert.ok(w.ok, JSON.stringify(w));
  const [cs] = rt.pending.list('A');
  assert.equal(cs.formats?.length, 1);
  assert.deepEqual(cs.formats[0].before, { bold: false, fontSize: 1000 });
  assert.deepEqual(cs.formats[0].after, { bold: true, fontSize: 1200 });
  const view = describeChange(cs);
  assert.deepEqual(view.chips, ['굵게', '10pt → 12pt']);
  assert.equal(view.summary, '글자 서식');
  assert.equal(view.location, '1쪽 ¶1');
  assert.deepEqual(
    formatChips({ kind: 'para', keys: ['alignment', 'lineSpacing'], before: { alignment: 'left', lineSpacing: 160, lineSpacingType: 'Percent' }, after: { alignment: 'justify', lineSpacing: 180, lineSpacingType: 'Percent' } }),
    ['왼쪽 → 양쪽', '줄간격 160% → 180%'],
  );
});

test('review store: reject impact counts later and kept rows; confirm only when something else reverts', async () => {
  const doc = new FakeDoc(['하나', '둘', '셋']);
  const rt = createDoogleAgentRuntime(fakeDeps(doc));
  const ctx = { origin: 'agent', threadId: 'A', mode: 'agent' };
  for (const [paraIdx, text] of [[0, '1'], [1, '2'], [2, '3']]) {
    assert.ok((await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx, text }, ctx)).ok);
  }
  const store = new ReviewStore();
  store.attach(rt.pending);
  const [a, b, c] = store.rows();
  assert.deepEqual(store.rejectImpact(a.id), { count: 3, later: 2, kept: 0, userEdits: false });
  assert.equal(store.needsConfirm(c.id), false, 'last row reverts only itself');
  assert.equal(store.needsConfirm(a.id), true);
  assert.equal(store.needsConfirm(), false, 'reject-all without user edits needs no extra confirm');
  store.decide('accept', b.id);
  assert.equal(store.rows().length, 2, 'kept row leaves the list');
  assert.deepEqual(store.rejectImpact(a.id), { count: 3, later: 2, kept: 1, userEdits: false });
  assert.match(chainSentence(store.rejectImpact(a.id)), /아래 2건\(적용 표시한 1건 포함\)도 함께 되돌아갑니다/);
  assert.equal(impactSentence(store.rejectImpact(c.id)), '이 변경만 되돌립니다.');
  store.attach(null);
});

test('review keys: Alt+↑/↓, Alt+Shift+Enter/X/G; never steals upstream Alt+Enter or Alt+Backspace', () => {
  const k = (key, mods = {}) => ({ key, code: mods.code, altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });
  assert.equal(matchReviewKey(k('ArrowDown')), 'next');
  assert.equal(matchReviewKey(k('ArrowUp')), 'prev');
  assert.equal(matchReviewKey(k('Enter', { shiftKey: true })), 'accept');
  assert.equal(matchReviewKey(k('ㅌ', { shiftKey: true, code: 'KeyX' })), 'reject');
  assert.equal(matchReviewKey(k('G', { shiftKey: true, code: 'KeyG' })), 'reveal');
  assert.equal(matchReviewKey(k('Enter')), null, 'Alt+Enter is table:insert-row-col');
  assert.equal(matchReviewKey(k('Backspace')), null);
  assert.equal(matchReviewKey(k('Backspace', { shiftKey: true })), null);
  assert.equal(matchReviewKey(k('ArrowDown', { ctrlKey: true })), null);
  assert.equal(matchReviewKey(k('ArrowDown', { isComposing: true })), null);
  assert.equal(matchReviewKey({ ...k('ArrowDown'), altKey: false }), null);
});

test('review gutter: positions follow page then paragraph order', () => {
  const row = (id, page, paraIdx) => ({ id, pages: [page], targets: [{ sectionIdx: 0, paraIdx, charOffset: 0, length: 0 }] });
  const pos = gutterPositions([row('a', 2, 9), row('b', 0, 1), row('c', 2, 3)], 4);
  assert.ok(pos[1] < pos[2] && pos[2] < pos[0], JSON.stringify(pos));
  assert.ok(pos.every((p) => p > 0 && p < 1));
  assert.deepEqual(gutterPositions([row('a', 0, 0)], 0), [0.5]);
});
