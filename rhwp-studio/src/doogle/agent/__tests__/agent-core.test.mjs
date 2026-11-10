// 두글 실행기 순수 로직·가짜 엔진 테스트.
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/agent-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnchor, looseWhitespacePattern, parseAnchorArgs, buildAnchorScope } from '../anchor.ts';
import { EditJournal } from '../edit-journal.ts';
import { RevisionTracker } from '../revision.ts';
import { createDoogleAgentRuntime } from '../runtime.ts';

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
  getCharPropertiesAt() { return JSON.stringify({ fontSize: 1000, bold: false }); }
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
