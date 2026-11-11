#!/usr/bin/env node
// 데스크탑 열기·저장 탐침 — 실제 화면(헤드리스 Chrome) + 실제 hub + 실제 엔진에, 데스크탑 셸(doogle-desk)을
// 흉내 낸 다리를 끼워 돌린다. Tauri 창을 띄우지 않고도 "디스크의 파일을 열고 그 자리에 저장" 하는 길을 본다.
//   node eval/probes/desk-files.mjs [--out <dir>]
//
// 흉내 내는 것: `window.__TAURI_INTERNALS__.invoke` 가 부르는 doogle-desk 명령(open_file · save_file ·
// pick_open_file · pick_save_file …)을 Node 가 임시 폴더의 진짜 파일로 처리한다. Rust 쪽 코드는 돌지 않는다.
//
// 본다:
//   1) 디스크에서 연 문서의 Ctrl+S 는 저장 대화상자 없이 그 파일에 쓴다.
//   2) 쓰기가 실패하면(다른 프로그램이 잠금) 알리고, 문서는 "저장 안 됨" 으로 남는다. 내려받기로 돌리지 않는다.
//   3) 저장 안 한 문서에서 다른 문서를 열면 먼저 묻는다. 취소하면 그대로다.
//   4) 검토 대기 변경이 있는 채로 다른 문서로 바꾸면 검토 목록이 비워진다(새 문서에 남지 않는다).
//   5) 열 수 없는 파일은 사유를 알리고 이전 문서가 그대로 보인다.
//   6) 다른 이름으로 저장은 OS 대화상자로 고른 경로에 쓰고, 그 뒤의 저장은 새 경로로 간다.
//   7) 응답 도중 "새 대화" 를 눌러도 사이드바가 멈추지 않는다.
//   8) 글과 그림이 함께 든 클립보드(엑셀 셀 복사)는 글로 붙고, 그림만 있으면 첨부가 된다.
// 실패하면 던진다. 값은 <out>/desk-files.json.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureStudioServer, FIXTURE_DIR, launchBrowser, openSession, REPO_ROOT, waitFor } from '../lib/session.mjs';

const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(REPO_ROOT, 'output', 'ui-audit');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 임시 폴더의 문서들 ──
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-desk-probe-'));
const A = path.join(dir, 'a.hwp');
const B = path.join(dir, 'b.hwpx');
const C = path.join(dir, 'c.hwp');
const BROKEN = path.join(dir, 'broken.hwp');
await fs.copyFile(path.join(FIXTURE_DIR, 'table-001.hwp'), A);
await fs.copyFile(path.join(FIXTURE_DIR, '복학원서.hwpx'), B);
await fs.writeFile(BROKEN, Buffer.from('이건 한글 문서가 아닙니다. '.repeat(40)));

// ── 데스크탑 셸 흉내 (Node 쪽) ──
const desk = {
  calls: [],
  /** pick_open_file · pick_save_file 이 다음에 돌려줄 경로 */
  nextOpen: null,
  nextSave: null,
  /** 쓰기가 실패하는 경로(다른 프로그램이 잠근 파일 흉내) */
  locked: new Set(),
  hub: null,
  count(cmd, pred = () => true) { return this.calls.filter((c) => c.cmd === cmd && pred(c)).length; },
  async call(cmd, args, headers) {
    const entry = { cmd, path: args?.path ?? (headers?.['x-doogle-path'] ? decodeURIComponent(headers['x-doogle-path']) : undefined) };
    this.calls.push(entry);
    try {
      switch (cmd) {
        case 'hub_info': return { value: { port: this.hub.port, token: this.hub.token } };
        case 'open_file': return { bytes: (await fs.readFile(args.path)).toString('base64') };
        case 'save_file': {
          if (this.locked.has(entry.path)) throw '저장하지 못했습니다: 다른 프로세스가 파일을 사용 중입니다. (os error 32)';
          // doogle-desk files.rs 와 같은 순서: 같은 폴더의 임시 파일에 쓰고 이름을 바꾼다
          const tmp = `${entry.path}.probe.tmp`;
          await fs.writeFile(tmp, Buffer.from(args.bytes, 'base64'));
          await fs.rename(tmp, entry.path);
          return { value: null };
        }
        case 'pick_open_file': { const p = this.nextOpen; this.nextOpen = null; return { value: p }; }
        case 'pick_save_file': { const p = this.nextSave; this.nextSave = null; entry.suggested = args?.suggestedName ?? null; return { value: p }; }
        case 'take_open_requests': return { value: [] };
        case 'file_stat': return { value: { exists: await fs.access(args.path).then(() => true, () => false) } };
        case 'default_app_status': return { value: { supported: false, exts: [], hint: null } };
        case 'list_templates': return { value: [] };
        case 'update_check': return { value: null };
        case 'plugin:app|version': return { value: '0.0.0-probe' };
        case 'set_close_guard': case 'confirm_close': case 'reveal_in_folder': case 'open_external': case 'open_hub_log': case 'set_default_app':
          return { value: null };
        default:
          // 창 조작(제목 막대의 최소화·최대화)은 흉내 낼 창이 없다
          if (cmd.startsWith('plugin:window|')) return { value: cmd.endsWith('is_maximized') ? false : null };
          throw `알 수 없는 명령: ${cmd}`;
      }
    } catch (error) {
      entry.error = String(error?.message ?? error);
      return { error: entry.error };
    }
  },
};

// ── 대본 provider ──
const provider = {
  id: 'claude-sdk',
  label: 'Claude (Claude Code 로그인)',
  detect: async () => ({ available: true, models: [{ id: 'default', label: '기본값', default: true }] }),
  async runTurn(p) {
    p.emit({ kind: 'text_delta', text: '확인하겠습니다.' });
    if (p.userText.includes('기다림')) await new Promise((resolve) => p.signal.addEventListener('abort', resolve, { once: true }));
    p.emit({ kind: 'text_done' });
    return { messages: [] };
  },
};

const server = await ensureStudioServer({ log: console.error });
const browser = await launchBrowser();
const alerts = [];
const session = await openSession({
  browser, studioUrl: server.url, provider, mode: 'agent', log: () => {},
  beforeLoad: async (page, hub) => {
    desk.hub = hub;
    page.on('dialog', (d) => { alerts.push(d.message()); });
    await page.exposeFunction('__deskCall', (cmd, args, headers) => desk.call(cmd, args, headers));
    await page.evaluateOnNewDocument(() => {
      const callbacks = new Map();
      const listeners = new Map();
      let seq = 0;
      const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
      window.__TAURI_INTERNALS__ = {
        transformCallback(cb) { const id = ++seq; callbacks.set(id, cb); return id; },
        async invoke(cmd, args, options) {
          if (cmd === 'plugin:event|listen') { const id = ++seq; listeners.set(id, args); return id; }
          if (cmd === 'plugin:event|unlisten') { listeners.delete(args.eventId); return null; }
          // save_file 은 바이트를 본문으로 보낸다
          const payload = args instanceof Uint8Array ? { bytes: b64(args) } : args instanceof ArrayBuffer ? { bytes: b64(new Uint8Array(args)) } : args;
          const r = await window.__deskCall(cmd, payload ?? {}, options?.headers ?? null);
          // Tauri 는 Rust 의 Err(String) 을 문자열로 던진다
          if (r && typeof r.error === 'string') throw r.error;
          if (r && typeof r.bytes === 'string') return Uint8Array.from(atob(r.bytes), (c) => c.charCodeAt(0)).buffer;
          return r ? r.value : null;
        },
      };
    });
  },
});
const { page, hub } = session;
const facts = {};
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); console.error(`shot ${name}`); };

const docInfo = async () => (await session.tool('get_document_info')).result;
const ctx = () => page.evaluate(() => { const c = window.rhwpStudio.automation.getContext(); return { dirty: !!c.isDirty, hasDocument: !!c.hasDocument }; });
const run = (id) => page.evaluate((cmd) => { void Promise.resolve().then(() => window.rhwpStudio.automation.execute(cmd, {}, { allowDialog: true })); }, id);
const openNative = async (file) => { desk.nextOpen = file; await run('ext:doogle.open-native'); };
const waitDoc = (name) => waitFor(async () => (await docInfo())?.name === name, 30_000, `문서가 ${name} 으로 바뀌지 않았습니다`);
/** 문서에 글자를 쳐서 더럽힌다 */
const typeInDocument = async (text) => {
  const box = await page.evaluate(() => { const r = document.querySelector('#scroll-container').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 260 }; });
  await page.mouse.click(box.x, box.y);
  await sleep(200);
  await page.keyboard.type(text, { delay: 15 });
  await waitFor(async () => (await ctx()).dirty, 10_000, '글자를 쳤는데 문서가 바뀌지 않았습니다');
};
const ctrlS = async () => {
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
};
const modalButtons = () => page.evaluate(() => [...document.querySelectorAll('.modal-overlay button, dialog[open] button')].map((b) => b.textContent.trim()).filter(Boolean));
const waitModal = () => waitFor(async () => (await modalButtons()).length > 0, 15_000, '확인 대화상자가 뜨지 않았습니다');
const clickModal = async (label) => {
  const ok = await page.evaluate((text) => {
    const b = [...document.querySelectorAll('.modal-overlay button, dialog[open] button')].find((x) => x.textContent.trim() === text);
    if (b) b.click();
    return !!b;
  }, label);
  assert.ok(ok, `대화상자에 "${label}" 단추가 없습니다: ${JSON.stringify(await modalButtons())}`);
  await sleep(300);
};
const sidebar = () => page.evaluate(() => {
  const b = document.querySelector('.dg-send');
  return { send: b.getAttribute('aria-label'), sendDisabled: b.disabled, title: document.querySelector('.dg-title')?.textContent?.trim() };
});
const typeChat = (value) => page.evaluate((v) => {
  const ta = document.querySelector('.dg-input');
  ta.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

try {
  facts.isDesk = await page.evaluate(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  assert.equal(facts.isDesk, true);

  // ── 1. 디스크에서 열고 Ctrl+S ──────────────────────────
  await openNative(A);
  await waitDoc('a.hwp');
  await sleep(1200);
  const original = await fs.readFile(A);
  await typeInDocument('DGSAVE1 ');
  await ctrlS();
  await waitFor(async () => !(await ctx()).dirty, 20_000, 'Ctrl+S 뒤에도 문서가 "저장 안 됨" 입니다');
  const saved1 = await fs.readFile(A);
  facts.saveInPlace = {
    pickerShown: desk.count('pick_save_file'),
    writes: desk.calls.filter((c) => c.cmd === 'save_file').map((c) => path.basename(c.path)),
    bytesBefore: original.length,
    bytesAfter: saved1.length,
    changed: !original.equals(saved1),
  };
  assert.equal(facts.saveInPlace.pickerShown, 0, '디스크에서 연 문서인데 저장 대화상자가 떴습니다');
  assert.deepEqual(facts.saveInPlace.writes, ['a.hwp']);
  assert.ok(facts.saveInPlace.changed, '파일이 바뀌지 않았습니다');
  assert.deepEqual(alerts, []);
  // 디스크에 쓴 것이 진짜 문서인가 — 다시 열어 친 글자가 있는지 본다 (깨끗한 문서라 묻지 않는다)
  await openNative(A);
  await sleep(1500);
  assert.equal((await session.tool('find_text', { query: 'DGSAVE1' })).result?.matches?.length ?? (await session.tool('find_text', { query: 'DGSAVE1' })).result?.count, 1, '저장한 파일에 친 글자가 없습니다');
  facts.reopenedHasEdit = true;

  // ── 2. 쓰기 실패 ───────────────────────────────────────
  desk.locked.add(A);
  await typeInDocument('DGLOCK ');
  await ctrlS();
  await waitFor(() => alerts.length > 0, 15_000, '저장이 실패했는데 알림이 없습니다');
  await sleep(500);
  facts.saveFailure = { alert: alerts.at(-1), dirtyAfter: (await ctx()).dirty, fileUntouched: (await fs.readFile(A)).equals(saved1) };
  assert.match(facts.saveFailure.alert, /다른 프로세스가 파일을 사용 중/);
  assert.equal(facts.saveFailure.dirtyAfter, true, '저장이 실패했는데 문서가 "저장됨" 으로 바뀌었습니다');
  assert.ok(facts.saveFailure.fileUntouched);
  desk.locked.clear();

  // ── 3. 저장 안 한 문서에서 다른 문서 열기 ───────────────
  const readsOfB = () => desk.count('open_file', (c) => c.path === B);
  await openNative(B);
  await waitModal();
  facts.leaveDialog = await modalButtons();
  await shot('50-open-while-dirty');
  await clickModal('취소');
  await sleep(500);
  assert.equal((await docInfo()).name, 'a.hwp', '취소했는데 문서가 바뀌었습니다');
  assert.equal((await ctx()).dirty, true);
  assert.equal(readsOfB(), 0, '취소했는데 다른 문서를 읽었습니다');
  // 다시 열고 이번에는 버린다
  await openNative(B);
  await waitModal();
  const discard = (await modalButtons()).find((t) => /저장 안 함|저장하지 않음/.test(t));
  assert.ok(discard, `"저장 안 함" 단추가 없습니다: ${JSON.stringify(await modalButtons())}`);
  await clickModal(discard);
  await waitDoc('b.hwpx');
  await sleep(1200);
  assert.ok((await fs.readFile(A)).equals(saved1), '버린다고 했는데 a.hwp 에 썼습니다');

  // ── 4. 검토 대기 변경이 있는 채로 문서 바꾸기 ────────────
  const rev = (await docInfo()).revision;
  const staged = await session.tool('replace_all', { expectedRevision: rev, query: '복학', replacement: '재입학' });
  assert.ok(staged.ok, JSON.stringify(staged.error));
  await waitFor(async () => ((await docInfo()).pendingReview ?? 0) > 0, 10_000, '검토 대기 변경이 생기지 않았습니다');
  facts.pendingBeforeSwap = (await docInfo()).pendingReview;
  const bBefore = await fs.readFile(B);
  await openNative(A);
  await waitModal();
  facts.reviewLeaveDialog = await modalButtons();
  await clickModal('저장 안 함');
  await waitDoc('a.hwp');
  await sleep(1500);
  facts.afterSwap = {
    pendingReview: (await docInfo()).pendingReview ?? 0,
    pill: await page.evaluate(() => { const p = document.querySelector('.dg-review-pill'); return !!p && !p.hidden && p.getBoundingClientRect().height > 0; }),
    statusPending: await page.evaluate(() => [...document.querySelectorAll('#status-bar *')].map((n) => n.textContent ?? '').some((t) => /검토 대기 \d+건|검토 \d+건/.test(t))),
    hasEdit: ((await session.tool('find_text', { query: 'DGSAVE1' })).result?.matches?.length ?? 0) === 1,
  };
  assert.equal(facts.afterSwap.pendingReview, 0, '문서를 바꿨는데 검토 대기 변경이 남았습니다');
  assert.equal(facts.afterSwap.pill, false, '문서를 바꿨는데 검토 막대가 남았습니다');
  assert.ok(facts.afterSwap.hasEdit, '새로 연 문서가 저장해 둔 내용이 아닙니다');
  assert.ok((await fs.readFile(B)).equals(bBefore), '검토하지 않은 변경을 b.hwpx 에 썼습니다');

  // ── 5. 열 수 없는 파일 ─────────────────────────────────
  await openNative(BROKEN);
  await waitFor(() => page.evaluate(() => [...document.querySelectorAll('#rhwp-toast-container > *, .dg-toast')].some((n) => /로드 실패|열지 못했습니다/.test(n.textContent ?? ''))), 15_000, '열기에 실패했는데 알림이 없습니다');
  await sleep(600);
  facts.brokenOpen = {
    toast: await page.evaluate(() => [...document.querySelectorAll('#rhwp-toast-container > *, .dg-toast')].map((n) => n.textContent?.trim()).filter(Boolean)[0]?.slice(0, 160)),
    docStill: (await docInfo()).name,
    pagesShown: await page.evaluate(() => document.querySelectorAll('#scroll-container canvas').length),
  };
  await shot('51-open-broken-file');
  assert.equal(facts.brokenOpen.docStill, 'a.hwp');
  assert.ok(facts.brokenOpen.pagesShown > 0, '열기에 실패한 뒤 빈 화면만 남았습니다');
  await page.evaluate(() => { for (const b of document.querySelectorAll('#rhwp-toast-container button')) b.click(); });

  // ── 6. 다른 이름으로 저장 → 그 뒤의 저장은 새 경로로 ─────
  await typeInDocument('DGAS ');
  desk.nextSave = C;
  await run('file:save-as');
  await waitModal();
  facts.saveAsDialog = await modalButtons();
  await page.evaluate(() => (document.querySelector('.modal-overlay .dialog-btn-primary') ?? document.querySelector('dialog[open] .dialog-btn-primary')).click());
  await waitFor(async () => !(await ctx()).dirty, 20_000, '다른 이름으로 저장이 끝나지 않았습니다');
  await waitDoc('c.hwp');
  facts.saveAs = { picker: desk.count('pick_save_file'), suggested: desk.calls.find((c) => c.cmd === 'pick_save_file')?.suggested, cExists: (await fs.stat(C)).size > 1000, aUntouched: (await fs.readFile(A)).equals(saved1) };
  assert.equal(facts.saveAs.picker, 1);
  assert.ok(facts.saveAs.cExists && facts.saveAs.aUntouched);
  const cFirst = await fs.readFile(C);
  await typeInDocument('DGC2 ');
  await ctrlS();
  await waitFor(async () => !(await ctx()).dirty, 20_000, '새 경로에 저장되지 않았습니다');
  assert.equal(desk.count('pick_save_file'), 1, '이미 경로가 있는데 저장 대화상자가 또 떴습니다');
  assert.equal(desk.calls.filter((c) => c.cmd === 'save_file').at(-1).path, C);
  assert.ok(!(await fs.readFile(C)).equals(cFirst));
  assert.ok((await fs.readFile(A)).equals(saved1), '새 이름으로 저장한 뒤의 저장이 옛 파일에 갔습니다');
  facts.saveAfterSaveAs = path.basename(desk.calls.filter((c) => c.cmd === 'save_file').at(-1).path);

  // ── 7. 응답 도중 "새 대화" ─────────────────────────────
  await typeChat('기다림 시험');
  await page.waitForFunction(() => !document.querySelector('.dg-send').disabled, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('.dg-send').click());
  await waitFor(async () => (await sidebar()).send === '중지', 10_000, '턴이 시작되지 않았습니다');
  await page.evaluate(() => document.querySelector('button[aria-label="새 대화"]').click());
  await waitFor(async () => (await sidebar()).send === '보내기', 8000, '응답 도중 "새 대화" 를 누른 뒤 사이드바가 멈췄습니다');
  facts.newChatWhileBusy = await sidebar();
  assert.equal(facts.newChatWhileBusy.title, '새 대화');
  // 새 대화에서 바로 보낼 수 있다
  const done = session.recorder.nextTurnEnd();
  await typeChat('새 대화의 첫 요청');
  await page.waitForFunction(() => !document.querySelector('.dg-send').disabled, { timeout: 10_000 });
  await page.evaluate(() => document.querySelector('.dg-send').click());
  await done;
  await sleep(500);
  assert.equal((await sidebar()).send, '보내기');

  // ── 8. 붙여 넣기 ───────────────────────────────────────
  facts.paste = await page.evaluate(async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const input = document.querySelector('.dg-input');
    const chips = () => document.querySelectorAll('.dg-attach-row .dg-file-chip').length;
    // 엑셀 셀 복사: 글 + 그 모습의 그림
    const mixed = new DataTransfer();
    mixed.setData('text/plain', '이름\t부서');
    mixed.items.add(new File([png], 'image.png', { type: 'image/png' }));
    const mixedDefault = input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: mixed }));
    const afterMixed = chips();
    // 화면 갈무리: 그림만
    const only = new DataTransfer();
    only.items.add(new File([png], 'image.png', { type: 'image/png' }));
    const onlyDefault = input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: only }));
    await new Promise((r) => setTimeout(r, 400));
    return { mixedLeftToBrowser: mixedDefault, chipsAfterMixed: afterMixed, imageOnlyLeftToBrowser: onlyDefault, chipsAfterImage: chips() };
  });
  assert.deepEqual(facts.paste, { mixedLeftToBrowser: true, chipsAfterMixed: 0, imageOnlyLeftToBrowser: false, chipsAfterImage: 1 });

  facts.unknownCommands = desk.calls.filter((c) => /알 수 없는 명령/.test(c.error ?? '')).map((c) => c.cmd);
  facts.consoleErrors = session.consoleErrors.filter((t) => !/다른 프로세스가 파일을 사용 중|파일 로드 실패|file:save|문서를 열지 못했습니다/.test(t)).slice(0, 10);
  await fs.writeFile(path.join(outDir, 'desk-files.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 2));
  assert.deepEqual(facts.unknownCommands, [], '흉내가 모르는 데스크탑 명령이 불렸습니다 — 탐침을 고쳐야 합니다');
  assert.deepEqual(facts.consoleErrors, [], '콘솔 오류');
} finally {
  await session.close();
  await browser.close();
  await server.stop();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
