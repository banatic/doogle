// 검토 상태 — 일부만 처리했을 때 남은 것·처리한 것·다음 초점. 실행기 의미(agent/pending.ts)를 흉내 낸 가짜 API.
// 실행: cd rhwp-studio && node --test src/doogle/review/__tests__/review-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStore } from '../state.ts';
import { bulkLabel, impactSentence, remainingText } from '../keys.ts';

function fakePending(n) {
  let entries = Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, threadId: 'A', toolName: 'insert_text', summary: `변경 ${i + 1}`, pages: [0], revision: i, createdAt: i }));
  const subs = new Set();
  const emit = () => { for (const cb of subs) cb(); };
  const settle = () => { while (entries.length && entries[0].kept) entries.shift(); };
  return {
    list: () => entries.map((e) => ({ ...e })),
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    acceptAll: () => { const k = entries.length; entries = []; emit(); return { accepted: k }; },
    rejectAll: () => { const k = entries.length; entries = []; emit(); return { rejected: k, userEditsReverted: false }; },
    accept: (id) => { const e = entries.find((x) => x.id === id); e.kept = true; settle(); emit(); return { accepted: 1 }; },
    rejectFrom: (id) => {
      const i = entries.findIndex((x) => x.id === id);
      const k = entries.length - i;
      entries = entries.slice(0, i);
      emit();
      settle(); // 실행기도 알린 뒤에 앞 kept 행을 정리한다
      return { rejected: k, userEditsReverted: false };
    },
    hasUserEditsSince: () => false,
  };
}

test('review store: partial accept/reject keeps a handled log and a remaining / total count', () => {
  const store = new ReviewStore();
  store.attach(fakePending(5));
  assert.equal(store.total, 5);
  assert.equal(remainingText(store.count, store.handled().length), '5건');
  assert.equal(bulkLabel('accept', store.count, 0), '모두 적용');

  store.focus('c2');
  store.decide('accept', 'c2');
  assert.deepEqual(store.rows().map((r) => r.id), ['c1', 'c3', 'c4', 'c5']);
  assert.equal(store.currentId, 'c3', 'focus moves to the next remaining row, not back to the top');
  assert.deepEqual(store.handled().map((h) => [h.change.id, h.kind]), [['c2', 'accept']]);
  assert.equal(remainingText(store.count, store.handled().length), '남은 변경 4 / 5');
  assert.equal(bulkLabel('reject', store.count, 1), '남은 4건 거절');

  // 남은 모두 거절은 그 사이 적용 표시 행도 되돌리므로 묻고, 그렇다고 말한다
  assert.equal(store.needsConfirm(), true);
  assert.equal(impactSentence(store.rejectImpact(), true), '남은 변경 4건과 함께 적용 표시한 1건도 되돌아갑니다.');

  store.decide('reject', 'c4');
  assert.deepEqual(store.rows().map((r) => r.id), ['c1', 'c3']);
  assert.equal(store.currentId, 'c3', 'after reject the nearest remaining row above is current');
  assert.deepEqual(store.handled().map((h) => [h.change.id, h.kind]), [['c2', 'accept'], ['c4', 'reject'], ['c5', 'reject']]);
  assert.equal(store.total, 5);

  store.decide('accept', 'c1');
  assert.deepEqual(store.rows().map((r) => r.id), ['c3']);
  assert.equal(store.currentId, 'c3');
  assert.equal(store.handled().length, 4, 'settled kept row stays accepted');
  assert.equal(remainingText(store.count, store.handled().length), '남은 변경 1 / 5');

  store.decide('accept');
  assert.equal(store.count, 0);
  assert.equal(store.handled().length, 0, 'batch log resets when nothing is pending');
  store.attach(null);
});

test('review store: rejecting an earlier row records later kept rows as reverted', () => {
  const store = new ReviewStore();
  store.attach(fakePending(3));
  store.decide('accept', 'c3');
  assert.deepEqual(store.handled().map((h) => [h.change.id, h.kind]), [['c3', 'accept']]);
  assert.equal(store.currentId, 'c1', 'accepting the last row wraps to the first remaining');
  store.decide('reject', 'c2');
  assert.deepEqual(store.handled().map((h) => [h.change.id, h.kind]), [['c3', 'reject'], ['c2', 'reject']]);
  assert.equal(impactSentence(store.rejectImpact(), true), '남은 변경 1건을 모두 되돌립니다.');
  store.attach(null);
});
