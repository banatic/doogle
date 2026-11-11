#!/usr/bin/env node
// 실제 화면(헤드리스 Chrome) + 실제 hub + 대본 provider 로 확인하는 탐침 (모델 호출 없음).
//   node eval/probes/threads-and-reconnect.mjs [--out <dir>]
// 본다:
//   1) 편집 표시의 덮개가 그 자리 바탕색을 따른다 (음영을 넣은 표 칸에서 흰 조각이 번쩍이지 않는다)
//   2) 응답 도중 연결이 뜻밖에 끊겨도, 같은 화면이 다시 붙으면 응답이 이어진다
//   3) 대화 목록에서 대화를 지운다 (한 번 더 묻고, hub 의 파일도 사라진다)
//   4) 새로고침은 기다리지 않고 바로 응답을 멈춘다 (유예는 뜻밖의 끊김에만)
// 실패하면 던진다. 결과 값은 <out>/threads-and-reconnect.json, 화면은 같은 폴더의 PNG.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureStudioServer, FIXTURE_DIR, launchBrowser, openSession, REPO_ROOT, waitFor } from '../lib/session.mjs';

const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(REPO_ROOT, 'output', 'ui-audit');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHADE = '#C6D9F1';
const SHADE_RGB = [198, 217, 241];
/** 대본이 멈춰 서는 자리 — 탐침이 풀어 준다 */
const gates = new Map();
const hold = (name) => new Promise((resolve) => { gates.set(name, resolve); });
const release = async (name) => {
  await waitFor(() => gates.has(name), 20_000, `대본이 ${name} 에 닿지 않았습니다`);
  gates.get(name)();
  gates.delete(name);
};

const provider = {
  id: 'claude-sdk',
  label: 'Claude (Claude Code 로그인)',
  detect: async () => ({ available: true, models: [{ id: 'default', label: '기본값', default: true }] }),
  async runTurn({ emit, callTool, userText, signal }) {
    const say = (text) => { emit({ kind: 'text_delta', text }); emit({ kind: 'text_done' }); };
    const rev = async () => (await callTool('get_document_info', {})).result?.revision;
    if (userText.includes('음영')) {
      const shaded = await callTool('set_cell_props', { expectedRevision: await rev(), sectionIdx: 0, paraIdx: 1, controlIdx: 0, cellIdx: 28, cellProps: { fillColor: SHADE } });
      assert.ok(shaded.ok, JSON.stringify(shaded));
      await hold('shaded'); // 칸 음영의 편집 표시가 끝나길 기다린다
      const replaced = await callTool('replace_all', { expectedRevision: await rev(), query: '킥오프', replacement: '착수 회의' });
      assert.ok(replaced.ok, JSON.stringify(replaced));
      say('칸에 음영을 넣고 낱말을 바꿨습니다.');
    } else if (userText.includes('끊김')) {
      say('문서를 확인합니다.');
      await callTool('get_structure', {});
      await hold('drop'); // 여기서 탐침이 연결을 끊는다
      // 끊긴 사이에 나가는 호출 — hub 가 모아 두었다가 화면이 돌아오면 전한다
      const during = await callTool('get_document_info', {});
      assert.ok(during.ok, `끊긴 사이의 호출: ${JSON.stringify(during)}`);
      const replaced = await callTool('replace_all', { expectedRevision: during.result.revision, query: '구 분', replacement: '구분' });
      assert.ok(replaced.ok, JSON.stringify(replaced));
      say('끊긴 뒤에도 이어서 고쳤습니다.');
    } else if (userText.includes('기다림')) {
      say('기다립니다.');
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    } else {
      say('네.');
    }
    return { messages: [] };
  },
};

const server = await ensureStudioServer({ log: console.error });
const browser = await launchBrowser();
const session = await openSession({ browser, studioUrl: server.url, provider, mode: 'agent', log: () => {} });
const { page, hub } = session;
const facts = {};
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); console.error(`shot ${name}`); };
const type = async (value) => {
  await page.evaluate((v) => {
    const ta = document.querySelector('.dg-input');
    ta.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await page.waitForFunction(() => { const b = document.querySelector('.dg-send'); return !!b && !b.disabled; }, { timeout: 30_000 });
  await page.evaluate(() => document.querySelector('.dg-send').click());
};
const threadFiles = async () => (await fs.readdir(path.join(hub.dataDir, 'threads')).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
/** 대화 목록 줄 — {title, current, canDelete} */
const menuRows = () => page.evaluate(() => [...document.querySelectorAll('.dg-thread-menu .dg-menu-row')].map((row) => ({
  title: row.querySelector('.dg-menu-label')?.textContent ?? '',
  current: row.querySelector('[role="menuitemradio"]')?.getAttribute('aria-checked') === 'true',
  del: row.querySelector('.dg-menu-del') ? (row.querySelector('.dg-menu-del').disabled ? 'disabled' : 'enabled') : 'none',
  confirm: row.classList.contains('dg-menu-confirm'),
})));

try {
  await session.openDocument(path.join(FIXTURE_DIR, 'table-001.hwp'));

  // ── 1. 덮개 색 ─────────────────────────────────────────
  // 편집 표시가 도는 동안 덮개가 가진 색을 모은다 (통째 덮개는 배경색, 옛 글 덮개는 종이색 캔버스의 픽셀)
  await page.evaluate(() => {
    const seen = new Set();
    window.__coverColors = seen;
    const read = () => {
      for (const cover of document.querySelectorAll('.dg-swarm-cover')) {
        const blank = cover.querySelector('canvas.dg-swarm-blank');
        if (blank) {
          const g = blank.getContext('2d');
          const w = blank.width;
          const h = blank.height;
          for (const [x, y] of [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2], [w >> 1, 1], [w >> 1, h - 2]]) {
            const d = g.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
            if (d[3] > 250) seen.add(`${d[0]},${d[1]},${d[2]}`);
          }
        } else {
          const m = /rgba?\((\d+), (\d+), (\d+)/.exec(getComputedStyle(cover).backgroundColor);
          if (m) seen.add(`${m[1]},${m[2]},${m[3]}`);
        }
      }
      window.__coverRaf = requestAnimationFrame(read);
    };
    read();
  });
  const turn1 = session.recorder.nextTurnEnd();
  await type('음영을 넣고 낱말을 바꿔 줘');
  await waitFor(() => gates.has('shaded'), 20_000, '음영 넣기가 끝나지 않았습니다');
  await sleep(4200); // 음영 넣기의 편집 표시가 다 지나가게
  await page.evaluate(() => window.__coverColors.clear());
  await release('shaded');
  await sleep(700);
  await shot('30-swarm-on-shaded-cell');
  const t1 = await turn1;
  assert.equal(t1.error, null, JSON.stringify(t1.error));
  await sleep(3500);
  facts.coverColors = await page.evaluate(() => { cancelAnimationFrame(window.__coverRaf); return [...window.__coverColors]; });
  assert.ok(facts.coverColors.length > 0, '편집 표시 덮개를 보지 못했습니다');
  // 음영 칸 위의 덮개는 그 음영색이어야 한다 — 흰색(255,255,255)이면 번쩍인다
  const near = (c) => c.split(',').map(Number).every((v, i) => Math.abs(v - SHADE_RGB[i]) <= 6);
  assert.ok(facts.coverColors.every(near), `덮개 색이 칸 음영(${SHADE_RGB})과 다릅니다: ${JSON.stringify(facts.coverColors)}`);
  await session.review('accept');

  // ── 2. 뜻밖의 끊김 → 같은 화면이 다시 붙어 이어 간다 ──────
  const turn2 = session.recorder.nextTurnEnd();
  await type('끊김 시험');
  await waitFor(() => gates.has('drop'), 20_000, '끊김 대본이 시작되지 않았습니다');
  hub.dropStudioConnection();
  await release('drop');
  await waitFor(() => !hub.studioConnected, 3000, '연결이 끊기지 않았습니다');
  await sleep(120);
  facts.whileDropped = await page.evaluate(() => ({
    activity: [...document.querySelectorAll('.dg-pstep-label, .dg-progress-note')].map((n) => n.textContent?.trim()).filter(Boolean),
    errorNotices: document.querySelectorAll('.dg-notice-error').length,
    stopShown: !!document.querySelector('.dg-send[aria-label*="중지"], .dg-stop'),
  }));
  await shot('31-reconnecting');
  const t2 = await turn2;
  assert.equal(t2.error, null, `끊긴 턴이 오류로 끝났습니다: ${JSON.stringify(t2.error)}`);
  assert.deepEqual(t2.toolCalls.map((c) => [c.name, c.ok]), [['get_structure', true], ['get_document_info', true], ['replace_all', true]]);
  await sleep(900);
  facts.afterResume = await page.evaluate(() => ({
    errorNotices: [...document.querySelectorAll('.dg-notice-error')].map((n) => n.textContent),
    lastProse: [...document.querySelectorAll('.dg-turn')].at(-1)?.textContent?.includes('끊긴 뒤에도 이어서 고쳤습니다') ?? false,
    progressTitle: [...document.querySelectorAll('.dg-turn')].at(-1)?.querySelector('.dg-progress-title, .dg-psteps-title')?.textContent ?? null,
  }));
  assert.ok(facts.whileDropped.activity.some((t) => t.includes('다시 연결하는 중')), `끊긴 동안의 진행 문구: ${JSON.stringify(facts.whileDropped)}`);
  assert.equal(facts.whileDropped.errorNotices, 0, '끊기자마자 오류 알림이 떴습니다');
  assert.deepEqual(facts.afterResume.errorNotices, [], '다시 붙은 뒤 오류 알림이 남았습니다');
  assert.ok(facts.afterResume.lastProse, '끊긴 뒤의 답이 화면에 없습니다');
  assert.ok(hub.studioConnected, '다시 붙지 않았습니다');
  const head = String((await session.tool('get_structure', { text: 'full', maxParagraphs: 3 })).result.text);
  assert.match(head, /\[0 B\] 구분 \|/, '끊긴 뒤의 편집이 문서에 들어가지 않았습니다');
  assert.match(head, /품질관리협의체 착수 회의/);
  await shot('32-resumed');
  await session.review('accept');

  // ── 3. 대화 지우기 ─────────────────────────────────────
  const firstTitle = await page.evaluate(() => document.querySelector('.dg-title')?.textContent?.trim());
  await page.evaluate(() => [...document.querySelectorAll('.dg-thread-menu [role="menuitem"]')].length); // (메뉴는 아직 닫혀 있다)
  await page.evaluate(() => document.querySelector('button[aria-label="대화 기록"]').click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.dg-thread-menu .dg-menu-item')].find((b) => b.textContent.includes('새 대화')).click());
  await sleep(200);
  const turn3 = session.recorder.nextTurnEnd();
  await type('두 번째 대화');
  await turn3;
  await sleep(700);
  facts.filesBefore = await threadFiles();
  assert.equal(facts.filesBefore.length, 2, `대화 파일: ${facts.filesBefore}`);
  await page.evaluate(() => document.querySelector('button[aria-label="대화 기록"]').click());
  await sleep(250);
  facts.menuBefore = await menuRows();
  assert.equal(facts.menuBefore.length, 2, JSON.stringify(facts.menuBefore));
  assert.ok(facts.menuBefore.every((r) => r.del === 'enabled'));
  await page.hover('.dg-thread-menu .dg-menu-row:nth-of-type(2)').catch(() => {});
  await shot('33-thread-menu');
  // 지금 보는 대화가 아닌 쪽(첫 대화)을 지운다 — 먼저 한 번 더 묻는다
  await page.evaluate(() => [...document.querySelectorAll('.dg-thread-menu .dg-menu-row')]
    .find((row) => row.querySelector('[role="menuitemradio"]')?.getAttribute('aria-checked') !== 'true')
    .querySelector('.dg-menu-del').click());
  await sleep(200);
  facts.menuConfirm = await menuRows();
  assert.equal(facts.menuConfirm.filter((r) => r.confirm).length, 1, JSON.stringify(facts.menuConfirm));
  assert.deepEqual(await threadFiles(), facts.filesBefore, '묻기만 했는데 파일이 지워졌습니다');
  await shot('34-thread-delete-confirm');
  // 취소 → 그대로
  await page.evaluate(() => document.querySelector('.dg-thread-menu .dg-menu-no').click());
  await sleep(150);
  assert.equal((await menuRows()).filter((r) => r.confirm).length, 0);
  // 다시 눌러 지운다
  await page.evaluate(() => [...document.querySelectorAll('.dg-thread-menu .dg-menu-row')]
    .find((row) => row.querySelector('[role="menuitemradio"]')?.getAttribute('aria-checked') !== 'true')
    .querySelector('.dg-menu-del').click());
  await sleep(150);
  await page.evaluate(() => document.querySelector('.dg-thread-menu .dg-menu-yes').click());
  await waitFor(async () => (await threadFiles()).length === 1, 5000, '대화 파일이 지워지지 않았습니다');
  await sleep(250);
  facts.menuAfter = await menuRows();
  facts.filesAfter = await threadFiles();
  assert.equal(facts.menuAfter.length, 1, JSON.stringify(facts.menuAfter));
  assert.ok(facts.menuAfter[0].current);
  assert.ok(!facts.menuAfter.some((r) => r.title === firstTitle), '지운 대화가 목록에 남았습니다');
  await shot('35-thread-deleted');
  await page.keyboard.press('Escape');

  // ── 4. 새로고침은 기다리지 않는다 ───────────────────────
  await type('기다림 시험');
  /** "기다림 시험" 을 받은 대화 (지금 보는 대화에 이어서 보냈다) */
  const waitingThread = () => [...hub.store.threads.values()].find((t) => t.transcript?.some((e) => e.kind === 'user' && e.text === '기다림 시험'));
  await waitFor(() => waitingThread()?.transcript.at(-1)?.kind === 'text_done', 10_000, '기다림 턴이 시작되지 않았습니다');
  await sleep(300);
  const reloadAt = Date.now();
  void page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitFor(() => waitingThread().transcript.at(-1)?.kind === 'turn_end', 4000, '새로고침 뒤에도 응답이 멈추지 않았습니다 (유예를 기다리는 중?)');
  facts.reloadStopMs = Date.now() - reloadAt;
  facts.reloadReason = waitingThread().transcript.at(-1).reason;
  assert.equal(facts.reloadReason, 'interrupted');
  assert.ok(facts.reloadStopMs < 4000, `새로고침 뒤 멈추는 데 ${facts.reloadStopMs}ms`);

  facts.consoleErrors = session.consoleErrors.slice(0, 10);
  await fs.writeFile(path.join(outDir, 'threads-and-reconnect.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts, null, 2));
} finally {
  for (const go of gates.values()) go();
  await session.close();
  await browser.close();
  await server.stop();
}
