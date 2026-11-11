#!/usr/bin/env node
// 참고 파일(첨부) 탐침 — 실제 화면(헤드리스 Chrome) + 실제 hub + 실제 문서 엔진, 모델 호출 없음(대본 provider).
//   python scripts/doogle/make-attach-fixtures.py        (견본 파일 만들기 — 처음 한 번)
//   node eval/probes/attachments.mjs [--out <dir>]
// 본다:
//   1) '+' 단추로 여러 형식(글·EUC-KR csv·xlsx·docx·pptx·pdf·png·hwp·hwpx)을 올리면 모두 읽혀 칩이 된다.
//      그동안 편집기에 열린 문서는 그대로다.
//   2) 보내면 턴 글에 목록이 실리고, 에이전트는 read_attachment 로 내용을 읽는다(글 조각·찾기·그림).
//   3) 읽지 못하는 파일은 사유가 적힌 칩이 되고 보내지지 않는다. 한 번에 10개까지.
//   4) 글이 없는 PDF(스캔본)는 쪽 그림으로 간다.
//   5) 끌어다 놓기·붙여 넣기로도 붙는다.
//   6) 새로고침 뒤 대화를 다시 열면 보낸 파일 칩이 그대로 보이고, 에이전트는 여전히 읽을 수 있다.
// 실패하면 던진다. 값은 <out>/attachments.json, 화면은 같은 폴더의 PNG.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureStudioServer, FIXTURE_DIR, launchBrowser, openSession, REPO_ROOT, waitFor } from '../lib/session.mjs';

const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(REPO_ROOT, 'output', 'ui-audit');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = (name) => path.join(FIXTURE_DIR, 'attach', name);
const F = (name) => path.join(FIXTURE_DIR, name);

/** 대본: 다음 턴에서 provider 가 할 일. 받은 턴 글은 turns 에 쌓인다 */
let script = null;
const turns = [];
const provider = {
  id: 'claude-sdk',
  label: 'Claude (Claude Code 로그인)',
  detect: async () => ({ available: true, models: [{ id: 'default', label: '기본값', default: true }] }),
  async runTurn(p) {
    const turn = { text: p.text, userText: p.userText, out: null, error: null };
    turns.push(turn);
    try {
      if (script) turn.out = await script(p);
    } catch (err) {
      turn.error = String(err?.stack ?? err);
    }
    p.emit({ kind: 'text_delta', text: '확인했습니다.' });
    p.emit({ kind: 'text_done' });
    return { messages: [] };
  },
};

const server = await ensureStudioServer({ log: console.error });
const browser = await launchBrowser();
let session = await openSession({ browser, studioUrl: server.url, provider, mode: 'agent', log: () => {} });
let { page } = session;
const { hub } = session;
const facts = {};
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); console.error(`shot ${name}`); };

const upload = async (files) => {
  const input = await page.$('.dg-attach-input');
  assert.ok(input, '파일 고르기 입력이 없습니다');
  await input.uploadFile(...files);
};
const chips = () => page.evaluate(() => [...document.querySelectorAll('.dg-attach-row .dg-file-chip')].map((c) => ({
  name: c.querySelector('.dg-file-name')?.textContent ?? '',
  state: c.dataset.state,
  detail: c.querySelector('.dg-file-sub')?.textContent ?? '',
})));
const settled = async () => {
  await waitFor(async () => { const c = await chips(); return c.length > 0 && c.every((x) => x.state !== 'reading'); }, 60_000, '첨부 읽기가 끝나지 않았습니다');
  return chips();
};
const sendState = () => page.evaluate(() => { const b = document.querySelector('.dg-send'); return { disabled: b.disabled, title: b.title }; });
const type = async (value) => page.evaluate((v) => {
  const ta = document.querySelector('.dg-input');
  ta.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
/** 보내고 그 턴이 끝날 때까지 기다린다 — 그 턴의 기록을 돌려준다 */
const send = async (value) => {
  const before = turns.length;
  const done = session.recorder.nextTurnEnd();
  await type(value);
  await page.waitForFunction(() => !document.querySelector('.dg-send').disabled, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('.dg-send').click());
  await done;
  await sleep(600);
  assert.equal(turns.length, before + 1);
  const turn = turns.at(-1);
  assert.equal(turn.error, null, turn.error ?? '');
  return turn;
};
const clearTray = () => page.evaluate(() => { for (const b of [...document.querySelectorAll('.dg-attach-row .dg-file-remove')]) b.click(); });
const read = async (p, args) => {
  const r = await p.callTool('read_attachment', args);
  assert.ok(r.ok, `read_attachment ${JSON.stringify(args)} → ${JSON.stringify(r.error)}`);
  return r.result;
};
/** 글 전체 (조각을 이어 읽는다) */
const readAll = async (p, name) => {
  let text = '';
  let total = 0;
  for (let offset = 0; offset !== null;) {
    const r = await read(p, { name, offset, maxChars: 40_000 });
    text += r.text;
    total = r.totalChars;
    offset = r.nextOffset;
  }
  assert.equal(text.length, total, `${name}: 조각을 이으면 전체 길이가 되어야 한다`);
  return text;
};

try {
  for (const f of ['신청자.txt', '명단.csv', '예산.xlsx', '운영계획.docx', '설명회.pptx', '지원규정.pdf', '스캔본.pdf', '직인.png', '옛문서.doc', '빈 파일.txt']) {
    await fs.access(A(f)).catch(() => { throw new Error(`견본 파일이 없습니다: ${A(f)} — python scripts/doogle/make-attach-fixtures.py 를 먼저 돌리세요`); });
  }
  await session.openDocument(F('table-001.hwp'));
  const docBefore = await session.structure();
  const revBefore = (await session.tool('get_document_info')).result.revision;
  facts.attachButton = await page.evaluate(() => {
    const b = document.querySelector('.dg-comp-square');
    return { disabled: b.disabled, label: b.getAttribute('aria-label') };
  });
  assert.deepEqual(facts.attachButton, { disabled: false, label: '참고 파일 붙이기' });

  // ── 1. 여러 형식을 한 번에 올린다 ───────────────────────
  const many = [A('신청자.txt'), A('명단.csv'), A('예산.xlsx'), A('운영계획.docx'), A('설명회.pptx'), A('지원규정.pdf'), A('직인.png'), F('biz_plan.hwp'), F('복학원서.hwpx')];
  await upload(many);
  facts.sendWhileReading = await sendState();
  facts.chips = await settled();
  await shot('40-attach-chips');
  assert.deepEqual(facts.chips.map((c) => [c.name, c.state]), many.map((f) => [path.basename(f), 'ready']), JSON.stringify(facts.chips, null, 1));
  assert.match(facts.chips[2].detail, /^스프레드시트 · /);
  assert.match(facts.chips[6].detail, /^그림 · /);
  assert.match(facts.chips[7].detail, /^한글 문서 · /);
  // 편집기에 열린 문서는 그대로다 (참고 문서는 엔진으로 따로 열었다 닫는다)
  assert.equal((await session.tool('get_document_info')).result.revision, revBefore, '첨부를 읽는 동안 열린 문서의 revision 이 바뀌었습니다');
  assert.equal(await session.structure(), docBefore, '첨부를 읽는 동안 열린 문서가 바뀌었습니다');
  assert.equal((await session.tool('get_document_info')).result.name, 'table-001.hwp');

  // ── 2. 보내면 목록이 턴 글에 실리고, tool 로 내용을 읽는다 ──
  script = async (p) => {
    const out = {};
    out.list = (await p.callTool('list_attachments', {})).result;
    out.csv = await readAll(p, '명단.csv');
    out.xlsx = await readAll(p, '예산.xlsx');
    out.docx = await readAll(p, '운영계획.docx');
    out.pptx = await readAll(p, '설명회.pptx');
    out.pdf = await readAll(p, '지원규정.pdf');
    out.hwp = await readAll(p, 'biz_plan.hwp');
    out.hwpx = await readAll(p, '복학원서.hwpx');
    out.hwpSlice = await read(p, { name: 'biz_plan.hwp', offset: 0, maxChars: 800 });
    out.hwpFind = await read(p, { name: 'biz_plan.hwp', find: '홈페이지 구축' });
    const pic = await read(p, { name: '직인.png' });
    out.pic = { mimeType: pic.image.mimeType, width: pic.width, height: pic.height, bytes: Math.round(pic.image.base64.length * 0.75), imageCount: pic.imageCount };
    out.missing = (await p.callTool('read_attachment', { name: '없는 파일.txt' })).error;
    return out;
  };
  const t1 = await send('붙인 파일을 참고해서 신청서를 채워 줘');
  const o = t1.out;
  facts.turnTextChars = t1.text.length;
  facts.block = /<doogle_attachments[\s\S]*<\/doogle_attachments>/.exec(t1.text)?.[0].slice(0, 2400) ?? null;
  assert.ok(facts.block, '턴 글에 참고 파일 블록이 없습니다');
  assert.match(t1.text, /이번 메시지에 새로 붙인 파일 9개:/);
  // 짧은 글은 통째로 실린다 — tool 호출 없이 바로 본다
  assert.match(t1.text, /<attachment name="신청자\.txt">\n소속: 한빛고등학교\n직위: 수석교사\n성명: 이서연\n/);
  assert.ok(t1.text.indexOf('</doogle_attachments>') < t1.text.indexOf('붙인 파일을 참고해서'));
  assert.ok(t1.text.length < 40_000, `턴 글이 너무 깁니다: ${t1.text.length}`);
  assert.equal(o.list.count, 9);
  facts.list = o.list.files.map((f) => `${f.name} — ${f.description}`);
  // EUC-KR csv
  assert.equal(o.csv, '이름,부서,내선\n홍길동,총무과,1234\n김철수,교무부,4321\n');
  // xlsx: 시트 순서, 날짜, 숫자
  assert.match(o.xlsx, /^## 시트: 예산\n\n\| 항목 \| 금액 \| 집행일 \| 비율 \|\n\| 연수비 \| 150000 \| 2026-07-20 \| 25% \|\n\| 교재비 \| 32000\.5 \| 2026-08-14 09:30 \| 0\.3 \|/);
  assert.match(o.xlsx, /## 시트: 담당자\n\n\| 이름 \| 부서 \| 비고 \|/);
  // docx: 문단과 표
  assert.match(o.docx, /^2026학년도 교원 자율연수 운영 계획\n1\. 목적: /);
  assert.match(o.docx, /\| 연수 과정 \| 연수 기관 \|\n\| AI 활용 수업 설계 \| 한빛교원연수원 \|/);
  // pptx: 발표 순서(파일 번호 순서가 아니다)
  assert.equal(o.pptx, '## 슬라이드 1\n자율연수 설명회\n발표: 교무부장 박영희\n\n## 슬라이드 2\n추진 일정\n7월: 연수 신청 · 8월: 연수 이수 · 9월: 정산');
  // pdf: 엔진이 읽은 글, 쪽 표시
  facts.pdf = o.pdf;
  assert.match(o.pdf, /교원 자율연수비 지원 규정/);
  assert.match(o.pdf, /제2조\(지원 한도\) 지원 한도는 1인당 연 150,000원으로 한다/);
  assert.match(o.pdf, /\[2쪽\][\s\S]*제4조\(정산\)/);
  // hwp: 본문과 표, 열린 문서용 주소는 없다
  facts.hwpHead = o.hwp.slice(0, 400);
  facts.hwpChars = o.hwp.length;
  assert.ok(o.hwp.length > 3000, `biz_plan.hwp 글이 너무 짧습니다: ${o.hwp.length}`);
  assert.match(o.hwp, /홈페이지 구축/);
  assert.match(o.hwp, /^\| .+ \| .+ \|$/m, '표가 행으로 실려야 한다');
  assert.match(o.hwp, /\[2쪽\]/);
  assert.doesNotMatch(o.hwp, /^s\d+ p\d+ /m, '열린 문서용 주소가 섞였습니다');
  assert.equal(o.hwpSlice.offset, 0);
  assert.ok(o.hwpSlice.nextOffset > 0 && o.hwpSlice.text.length <= 800);
  assert.ok(o.hwpFind.matchCount >= 1);
  assert.equal(o.hwp.slice(o.hwpFind.matches[0].offset, o.hwpFind.matches[0].offset + 7), '홈페이지 구축');
  facts.hwpxHead = o.hwpx.slice(0, 300);
  assert.match(o.hwpx, /복\s*학\s*원\s*서|복학/);
  // 그림: 긴 변을 줄여 보낸다 (원본 1800x1200)
  facts.pic = o.pic;
  assert.equal(o.pic.mimeType, 'image/png');
  assert.deepEqual([o.pic.width, o.pic.height], [1568, 1045]);
  assert.equal(o.missing.code, 'ATTACHMENT_NOT_FOUND');
  assert.match(o.missing.message, /"신청자\.txt"/);
  // 보낸 뒤: 첨부 줄은 비고, 말풍선 위에 파일 칩이 남는다
  facts.afterSend = await page.evaluate(() => ({
    tray: document.querySelectorAll('.dg-attach-row .dg-file-chip').length,
    trayHidden: document.querySelector('.dg-attach-row').hidden,
    sent: [...document.querySelectorAll('.dg-user-files .dg-file-chip .dg-file-name')].map((n) => n.textContent),
    toolRows: [...document.querySelectorAll('.dg-turn')].at(-1)?.textContent?.includes('참고 파일') ?? false,
  }));
  assert.equal(facts.afterSend.tray, 0);
  assert.equal(facts.afterSend.trayHidden, true);
  assert.deepEqual(facts.afterSend.sent, many.map((f) => path.basename(f)));
  await shot('41-attach-sent');
  // hub: 대화 파일에는 목록만, 내용은 따로
  await hub.store.flush();
  const threadId = [...hub.store.threads.keys()].at(-1);
  const threadFile = await fs.readFile(path.join(hub.dataDir, 'threads', `${threadId}.json`), 'utf8');
  facts.threadFileBytes = threadFile.length;
  facts.contentFiles = (await fs.readdir(path.join(hub.dataDir, 'threads', `${threadId}.files`))).length;
  assert.equal(facts.contentFiles, 9);
  assert.ok(threadFile.length < 30_000, `대화 파일이 큽니다(내용이 섞였나): ${threadFile.length}`);

  // ── 다음 턴: 새 파일 없이도 앞서 붙인 파일을 읽는다 ──
  script = async (p) => ({ again: await read(p, { name: '신청자.txt' }) });
  const t2 = await send('계좌번호는 뭐였지?');
  assert.match(t2.text, /이 대화에 붙인 파일 9개 \(내용은 read_attachment 로 읽기\):/);
  assert.equal(t2.text.includes('소속: 한빛고등학교'), false, '앞서 붙인 파일의 내용을 다시 싣지 않는다');
  assert.match(t2.out.again.text, /계좌번호: 110-234-567890/);

  // ── 3. 읽지 못하는 파일 · 한도 ─────────────────────────
  await upload([A('옛문서.doc'), A('빈 파일.txt')]);
  facts.badChips = await settled();
  assert.deepEqual(facts.badChips.map((c) => c.state), ['error', 'error']);
  assert.match(facts.badChips[0].detail, /\.doc 파일은 읽지 못합니다\. \.docx 로 저장/);
  assert.match(facts.badChips[1].detail, /빈 파일입니다/);
  assert.equal((await sendState()).disabled, true, '읽지 못한 파일만 있으면 보낼 수 없다');
  await shot('42-attach-errors');
  // 읽지 못한 칩이 있어도 글은 보낼 수 있고, 그 파일은 가지 않는다
  script = async (p) => ({ count: (await p.callTool('list_attachments', {})).result.count });
  const t3 = await send('이 파일들은 무시해도 돼');
  assert.equal(t3.out.count, 9, '읽지 못한 파일이 대화에 붙었습니다');
  await clearTray();
  // 한 번에 10개까지
  const eleven = [];
  for (let i = 0; i < 11; i++) {
    const f = path.join(hub.dataDir, `메모 ${i + 1}.txt`);
    await fs.writeFile(f, `메모 ${i + 1}의 내용`);
    eleven.push(f);
  }
  await upload(eleven);
  facts.limitChips = (await settled()).length;
  facts.limitNotice = await page.evaluate(() => [...document.querySelectorAll('.dg-notice')].map((n) => n.textContent).filter((t) => t.includes('10개까지')));
  assert.equal(facts.limitChips, 10);
  assert.equal(facts.limitNotice.length, 1, '한도 알림이 없습니다');
  await clearTray();
  await sleep(150);
  assert.equal((await chips()).length, 0);

  // ── 4. 글이 없는 PDF 는 쪽 그림으로 ─────────────────────
  await upload([A('스캔본.pdf')]);
  facts.scanChip = (await settled())[0];
  assert.equal(facts.scanChip.state, 'ready', JSON.stringify(facts.scanChip));
  script = async (p) => {
    const first = await read(p, { name: '스캔본.pdf' });
    const second = await read(p, { name: '스캔본.pdf', image: 1 });
    const text = await p.callTool('read_attachment', { name: '스캔본.pdf', find: 'SCAN' });
    return { first: { mimeType: first.image.mimeType, width: first.width, height: first.height, imageCount: first.imageCount, label: first.label, bytes: Math.round(first.image.base64.length * 0.75) }, second: { label: second.label, imageIndex: second.imageIndex }, findError: text.error?.code };
  };
  // 글 없이 파일만 보낸다
  const before = turns.length;
  const done = session.recorder.nextTurnEnd();
  await page.waitForFunction(() => !document.querySelector('.dg-send').disabled, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('.dg-send').click());
  await done;
  await sleep(500);
  assert.equal(turns.length, before + 1);
  const t4 = turns.at(-1);
  assert.equal(t4.error, null, t4.error ?? '');
  assert.equal(t4.userText, '첨부한 파일을 확인해 주세요.');
  facts.scan = t4.out;
  assert.equal(t4.out.first.mimeType, 'image/jpeg');
  assert.equal(t4.out.first.imageCount, 2);
  assert.equal(t4.out.first.label, '1쪽');
  assert.ok(Math.max(t4.out.first.width, t4.out.first.height) <= 1568 && t4.out.first.bytes > 3000, JSON.stringify(t4.out.first));
  assert.deepEqual(t4.out.second, { label: '2쪽', imageIndex: 1 });
  assert.equal(t4.out.findError, 'NO_TEXT');
  assert.match(t4.text, /"스캔본\.pdf" \(PDF, 2쪽, 그림 2장\) — 그림은 read_attachment \{name, image\} 로 보기/);

  // ── 5. 끌어다 놓기 · 붙여 넣기 ──────────────────────────
  await page.evaluate(() => {
    const file = (name, type, body) => new File([body], name, { type });
    const drop = new DataTransfer();
    drop.items.add(file('끌어온 메모.txt', 'text/plain', '끌어다 놓은 내용'));
    const panel = document.querySelector('.dg-panel');
    for (const kind of ['dragenter', 'dragover', 'drop']) panel.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: drop }));
    const paste = new DataTransfer();
    paste.items.add(file('', 'text/plain', '붙여 넣은 내용'));
    document.querySelector('.dg-input').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: paste }));
  });
  facts.dropPaste = await settled();
  assert.deepEqual(facts.dropPaste.map((c) => [c.name, c.state]), [['끌어온 메모.txt', 'ready'], ['붙여 넣은 파일', 'ready']]);
  // 글을 붙여 넣는 것은 그대로 글이다 (첨부가 되지 않는다)
  const pastedText = await page.evaluate(() => {
    const paste = new DataTransfer();
    paste.setData('text/plain', '그냥 글');
    return document.querySelector('.dg-input').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: paste }));
  });
  assert.equal(pastedText, true, '글 붙여 넣기를 가로채면 안 된다');
  assert.equal((await chips()).length, 2);
  // 칩의 X 로 하나를 뺀다
  await page.evaluate(() => document.querySelector('.dg-attach-row .dg-file-remove').click());
  assert.deepEqual((await chips()).map((c) => c.name), ['붙여 넣은 파일']);
  await clearTray();

  // ── 6. 새로고침 뒤에도 남는다 ───────────────────────────
  facts.consoleErrors = session.consoleErrors.slice(0, 10);
  assert.deepEqual(facts.consoleErrors, [], '콘솔 오류');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.rhwpStudio?.plugins?.isLoaded?.('doogle'), { timeout: 120_000 });
  await waitFor(() => hub.studioConnected, 30_000, '새로고침 뒤 다시 붙지 않았습니다');
  await session.openDocument(F('table-001.hwp'));
  await waitFor(() => page.evaluate(() => document.querySelectorAll('.dg-user-files').length > 0), 15_000, '새로고침 뒤 대화가 복원되지 않았습니다');
  facts.restored = await page.evaluate(() => [...document.querySelectorAll('.dg-user-files')].map((row) => [...row.querySelectorAll('.dg-file-name')].map((n) => n.textContent)));
  assert.deepEqual(facts.restored.map((r) => r.length), [9, 1]);
  assert.deepEqual(facts.restored[1], ['스캔본.pdf']);
  script = async (p) => ({ count: (await p.callTool('list_attachments', {})).result.count, hwp: (await read(p, { name: 'biz_plan.hwp', find: '누리집' })).matchCount });
  const t5 = await send('새로고침 뒤에도 읽을 수 있니?');
  assert.equal(t5.out.count, 10);
  await shot('43-attach-restored');

  await fs.writeFile(path.join(outDir, 'attachments.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 2));
} finally {
  await session.close();
  await browser.close();
  await server.stop();
}
