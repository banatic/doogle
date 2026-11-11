// 데스크탑 열기·저장과 문서 교체 — 저장 손잡이(native-file), 문서 교체 때 검토 목록 비우기, 붙여 넣기 판정.
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/desk-files.test.mjs
// (실제 화면에서의 흐름은 doogle-agent/eval/probes/desk-files.mjs 가 본다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { deskFileHandle, isDeskFileHandle, pathKey } from '../../shell/native-file.ts';
import { pasteIsAttachment } from '../../attach/attach-core.ts';
import { createDoogleAgentRuntime } from '../runtime.ts';

function fakeIo(files = new Map()) {
  const log = [];
  return {
    files,
    log,
    io: {
      readFile: async (path) => { log.push(['read', path]); if (!files.has(path)) throw new Error('파일을 읽을 수 없습니다'); return files.get(path); },
      writeFile: async (path, bytes) => { log.push(['write', path, bytes.length]); if (path.includes('잠김')) throw '저장하지 못했습니다: 다른 프로세스가 파일을 사용 중입니다.'; files.set(path, bytes); },
      written: (path) => log.push(['written', path]),
    },
  };
}

test('desk file handle: writes land on the opened path in one piece, and only on close', async () => {
  const { io, files, log } = fakeIo();
  const handle = deskFileHandle('C:\\문서\\보고서.hwp', io);
  assert.equal(handle.kind, 'file');
  assert.equal(handle.name, '보고서.hwp');
  assert.equal(handle.path, 'C:\\문서\\보고서.hwp');
  const w = await handle.createWritable();
  await w.write(new Blob([new Uint8Array([1, 2, 3])]));
  await w.write(new Blob([new Uint8Array([4, 5])]));
  assert.deepEqual(log, [], 'nothing touches the disk before close()');
  await w.close();
  assert.deepEqual([...files.get('C:\\문서\\보고서.hwp')], [1, 2, 3, 4, 5]);
  assert.deepEqual(log, [['write', 'C:\\문서\\보고서.hwp', 5], ['written', 'C:\\문서\\보고서.hwp']]);
  await w.close(); // 두 번 닫아도 다시 쓰지 않는다
  assert.equal(log.length, 2);
  await assert.rejects(w.write(new Blob(['x'])), /닫힌 파일/);
  // 읽기
  const file = await handle.getFile();
  assert.equal(file.name, '보고서.hwp');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.equal(await handle.queryPermission(), 'granted');
});

test('desk file handle: a failed write is an error for the caller, and an empty save never truncates the file', async () => {
  const { io, files, log } = fakeIo(new Map([['C:\\a\\잠김.hwp', new Uint8Array([9, 9])]]));
  const locked = await deskFileHandle('C:\\a\\잠김.hwp', io).createWritable();
  await locked.write(new Blob([new Uint8Array([1])]));
  await assert.rejects(locked.close(), (e) => /다른 프로세스가 파일을 사용 중/.test(String(e)));
  assert.deepEqual([...files.get('C:\\a\\잠김.hwp')], [9, 9], 'the original bytes stay');
  assert.equal(log.some((l) => l[0] === 'written'), false, 'a failed write is not announced as saved');
  const empty = await deskFileHandle('C:\\a\\b.hwp', io).createWritable();
  await assert.rejects(empty.close(), /저장할 내용이 없습니다/);
  assert.equal(files.has('C:\\a\\b.hwp'), false);
});

test('desk file handle: same-file comparison ignores case and slash direction on Windows paths', async () => {
  const { io } = fakeIo();
  const a = deskFileHandle('C:\\Docs\\A.hwp', io);
  assert.equal(await a.isSameEntry(deskFileHandle('c:/docs/a.HWP', io)), true);
  assert.equal(await a.isSameEntry(deskFileHandle('C:\\Docs\\B.hwp', io)), false);
  assert.equal(await a.isSameEntry({ kind: 'file', name: 'A.hwp' }), false, 'a browser handle is never the same entry');
  assert.equal(await a.isSameEntry(null), false);
  assert.equal(pathKey('/home/me/A.hwp'), '/home/me/A.hwp', 'POSIX paths stay case-sensitive');
  assert.equal(isDeskFileHandle(a), true);
  assert.equal(isDeskFileHandle({ kind: 'file', name: 'x', path: 'p' }), false);
});

test('desk file handle: cannot be structured-cloned — the recent-document store then records it without a handle', () => {
  // upstream recent-store 는 핸들을 IndexedDB 에 넣다 실패하면 핸들 없이 기록한다. 복제되면 메서드가 떨어진
  // 껍데기가 저장되어 "최근 문서 다시 열기" 가 그 껍데기를 파일 핸들처럼 쓰려다 깨진다.
  const { io } = fakeIo();
  assert.throws(() => structuredClone(deskFileHandle('C:\\a\\b.hwp', io)), (e) => e.name === 'DataCloneError');
});

test('paste: text wins over an accompanying picture; only a file-only clipboard becomes an attachment', () => {
  assert.equal(pasteIsAttachment(1, '이름\t부서\n홍길동\t총무과'), false, 'Excel cells arrive as text plus an image of the cells');
  assert.equal(pasteIsAttachment(1, ''), true, 'a screenshot');
  assert.equal(pasteIsAttachment(2, '  \n'), true, 'files copied in Explorer');
  assert.equal(pasteIsAttachment(0, '그냥 글'), false);
  assert.equal(pasteIsAttachment(0, ''), false);
});

// ─── 문서 교체 때 검토 대기 목록 ────────────────────────

class Doc {
  constructor(paras) { this.paras = [...paras]; this.snaps = new Map(); this.next = 1; }
  getSectionCount() { return 1; }
  getParagraphCount() { return this.paras.length; }
  pageCount() { return 1; }
  getDocumentInfo() { return JSON.stringify({ pageCount: 1, sectionCount: 1 }); }
  getParagraphLength(_s, p) { return [...this.paras[p]].length; }
  getTextRange(_s, p, off, n) { return [...this.paras[p]].slice(off, off + n).join(''); }
  insertText(_s, p, off, text) { const c = [...this.paras[p]]; this.paras[p] = c.slice(0, off).join('') + text + c.slice(off).join(''); return '{"ok":true}'; }
  getObjects() { return '[]'; }
  getCharShapeRuns(_s, _p, start, end) { return JSON.stringify([{ startOffset: start, endOffset: end, charShapeId: 0 }]); }
  getCharPropertiesAt() { return JSON.stringify({ fontSize: 1000, bold: false }); }
  getParaPropertiesAt() { return JSON.stringify({ headType: 'None' }); }
  getPageOfPosition() { return JSON.stringify({ ok: true, page: 0 }); }
  getPageTextLayout() { return JSON.stringify({ runs: [{ secIdx: 0, paraIdx: 0, charStart: 0 }] }); }
  saveSnapshot() { const id = this.next++; this.snaps.set(id, [...this.paras]); return id; }
  restoreSnapshot(id) { const s = this.snaps.get(id); if (!s) throw new Error('no snapshot'); this.paras = [...s]; return '{"ok":true}'; }
  discardSnapshot(id) { this.snaps.delete(id); }
}

test('document swap: pending review is dropped at once — rejecting later cannot roll the new document back', async () => {
  const a = new Doc(['A 문서의 원문']);
  const b = new Doc(['B 문서의 원문']);
  // B 는 사용자가 직접 고쳐 되돌리기 지점을 가진 문서다 — 번호가 A 의 스테이징 기준점과 같다(문서마다 1 부터)
  const undoPoint = b.saveSnapshot();
  b.paras[0] = 'B 문서를 사용자가 고친 글';
  let current = a;
  let generation = 1;
  const rt = createDoogleAgentRuntime({
    getDocument: () => current,
    documentInstance: () => generation,
    transaction: (_label, fn) => fn(current, { noChange() {} }),
  });
  const events = [];
  rt.pending.onChange((e) => events.push(e.kind));
  const staged = await rt.executeTool('insert_text', { expectedRevision: rt.revision(), paraIdx: 0, text: ' (에이전트)' }, { origin: 'agent', threadId: 'T', mode: 'agent' });
  assert.ok(staged.ok, JSON.stringify(staged));
  assert.equal(rt.pending.list().length, 1);
  assert.equal(undoPoint, 1);

  // 사용자가 다른 문서를 연다 — 다음 tool 호출 전이다
  current = b;
  generation = 2;
  rt.noteDocumentSwap();
  assert.equal(rt.pending.list().length, 0, 'the old document\'s pending edits are gone immediately');
  assert.equal(rt.pending.hasPending(), false);
  assert.deepEqual(events, ['added', 'rejected'], 'review surfaces are told so they clear');
  // "모두 거절" 을 눌러도 새 문서는 그대로다 (전에는 A 의 기준점 번호로 B 를 되돌렸다)
  const r = rt.pending.rejectAll();
  assert.equal(r.rejected, 0);
  assert.equal(b.paras[0], 'B 문서를 사용자가 고친 글');
  assert.ok(b.snaps.has(undoPoint), 'the new document\'s own undo snapshot is not discarded');
  // 같은 문서에서 다시 불러도 아무 일 없다
  rt.noteDocumentSwap();
  assert.deepEqual(events, ['added', 'rejected']);
});
