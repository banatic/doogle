#!/usr/bin/env node
// UI 점검용 화면 캡처 — 모델 호출 없이(대본 provider) 주요 화면 상태를 PNG 로 남긴다.
//   node eval/ui-shots.mjs [--out <dir>] [--inspect]
// 결과: <repo>/output/ui-audit/*.png (+ inspect.json)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureStudioServer, FIXTURE_DIR, launchBrowser, openSession, REPO_ROOT } from './lib/session.mjs';

const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(REPO_ROOT, 'output', 'ui-audit');
const inspectOnly = argv.includes('--inspect');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 대본대로 움직이는 provider — 글·도구 호출·오류를 정해진 순서로 낸다. */
function scriptedProvider(script) {
  return {
    id: 'claude-sdk',
    label: 'Claude (Claude Code 로그인)',
    detect: async () => ({ available: true, models: [{ id: 'default', label: '기본값 (Claude Code 권장)', default: true }, { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }] }),
    async runTurn(p) {
      await script(p);
      return { messages: [] };
    },
  };
}

const server = await ensureStudioServer({ log: console.error });
const browser = await launchBrowser();
const gate = { release: null, hold: null };
const provider = scriptedProvider(async ({ emit, callTool, userText }) => {
  const say = async (text) => { for (const ch of text.match(/.{1,8}/gs) ?? []) { emit({ kind: 'text_delta', text: ch }); await sleep(6); } emit({ kind: 'text_done' }); };
  if (userText.includes('오류')) {
    await say('문서를 확인하겠습니다.');
    await callTool('replace_range', { expectedRevision: 1, paraIdx: 47, find: '없는 글', text: 'x' });
    emit({ kind: 'limit', message: 'Claude 구독 사용 한도에 도달했습니다.', resetAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
    throw Object.assign(new Error('Claude 구독 사용 한도에 도달했습니다.'), { code: 'LIMIT', emitted: true });
  }
  await say('먼저 문서 구조를 읽어 소제목을 확인하겠습니다.');
  const s = await callTool('get_structure', {});
  await callTool('find_text', { query: '사업명' });
  // 가운데에서 한 번 멈춘다 — 진행 중 화면을 찍는다
  await new Promise((resolve) => { gate.release = resolve; gate.hold?.(); });
  const rev = s.result?.revision;
  const w1 = await callTool('apply_edits', { expectedRevision: rev, render: 'crop', edits: [
    { tool: 'apply_char_format', paras: [47, 50, 57, 68, 72, 81], bold: true, fontSizePt: 13, textColor: '#1F4E79' },
    { tool: 'replace_range', paraIdx: 48, find: '홈페이지 구축', text: '누리집 구축' },
  ] });
  await callTool('insert_paragraphs', { expectedRevision: w1.result?.revision, paraIdx: 92, paragraphs: ['', '추진 일정'], formatFrom: 81 });
  await say('장 제목 6개를 굵게·13pt·파란색으로 바꾸고, "홈페이지 구축"을 "누리집 구축"으로 고쳤습니다. 문서 끝에는 "추진 일정" 제목을 추가했습니다.\n\n- **쪽수**: 6쪽 그대로입니다.\n- **확인할 점**: 하위 제목은 바꾸지 않았습니다. 같은 서식을 적용할까요?');
});

const session = await openSession({ browser, studioUrl: server.url, provider, mode: 'agent', log: () => {} });
const { page } = session;
const shot = async (name, clip) => {
  await sleep(350);
  await page.screenshot({ path: path.join(outDir, `${name}.png`), ...(clip ? { clip } : {}) });
  console.error(`shot ${name}`);
};
const click = async (selector) => page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; }, selector);
const clickText = async (text, tag = 'button') => page.evaluate((t, tg) => {
  const el = [...document.querySelectorAll(tg)].find((x) => x.textContent?.trim() === t || x.getAttribute('aria-label') === t || x.title === t);
  if (el) el.click();
  return !!el;
}, text, tag);
const rectOf = async (selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
}, selector);

try {
  // ── 1. 문서 없는 첫 화면 ──
  await sleep(1200);
  await shot('01-empty');

  // ── 2. 문서를 열면 뜨는 글꼴 대화상자 ──
  const input = await page.$('#file-input');
  await input.uploadFile(path.join(FIXTURE_DIR, 'biz_plan.hwp'));
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '대체 글꼴로 보기'), { timeout: 30_000 }).catch(() => {});
  await shot('02-font-dialog');
  await clickText('대체 글꼴로 보기');
  await sleep(1500);
  await shot('03-document-idle');

  if (inspectOnly) {
    const dom = await page.evaluate(() => {
      const pick = (root) => [...root.querySelectorAll('button, [role="tab"], [role="menuitem"], [role="menuitemradio"], textarea, select, input')].map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 70), text: (el.textContent ?? '').trim().slice(0, 30), aria: el.getAttribute('aria-label'), title: el.title, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), hidden: r.width === 0 };
      }).filter((e) => !e.hidden);
      const fonts = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return { font: cs.fontFamily.slice(0, 80), size: cs.fontSize, color: cs.color, bg: cs.backgroundColor, lh: cs.lineHeight }; };
      return {
        viewport: { w: innerWidth, h: innerHeight },
        theme: document.documentElement.getAttribute('data-theme') ?? document.documentElement.className,
        side: pick(document.querySelector('#side-panel-host') ?? document.body),
        chrome: pick(document.body).filter((e) => e.y < 180).slice(0, 120),
        status: pick(document.querySelector('#status-bar') ?? document.createElement('div')),
        styles: { input: fonts('.dg-input'), prose: fonts('.dg-prose'), ribbon: fonts('.dg-ribbon'), status: fonts('#status-bar'), title: fonts('.dg-titlebar') },
        sizes: Object.fromEntries(['.dg-titlebar', '.dg-ribbon', '.dg-ribbon-tabs', '#status-bar', '#side-panel-host', '#scroll-container'].map((s) => { const el = document.querySelector(s); const r = el?.getBoundingClientRect(); return [s, r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null]; })),
      };
    });
    await fs.writeFile(path.join(outDir, 'inspect.json'), JSON.stringify(dom, null, 1), 'utf8');
    console.error('inspect.json written');
  }

  // ── 3. 리본 탭들 ──
  for (const [i, tab] of ['보기', '입력', '서식', '쪽', '검토', '도구'].entries()) {
    if (await clickText(tab, '[role="tab"], button')) await shot(`04-ribbon-${i + 1}-${tab}`, { x: 0, y: 0, width: 1600, height: 190 });
  }
  await clickText('편집', '[role="tab"], button');
  if (await clickText('파일', '[role="tab"], button')) { await sleep(500); await shot('05-backstage'); await page.keyboard.press('Escape'); await sleep(300); }

  // ── 4. 사이드바 메뉴 ──
  const side = await rectOf('#side-panel-host');
  if (await click('.dg-model-btn, [class*="dg-model"]')) { await shot('06-model-menu', side ?? undefined); await page.keyboard.press('Escape'); }
  if (await click('.dg-mode-btn, [class*="dg-mode"]')) { await shot('07-mode-menu', side ?? undefined); await page.keyboard.press('Escape'); }
  if (await click('.dg-gear, [aria-label="설정"]')) { await sleep(400); await shot('08-settings', side ?? undefined); await page.keyboard.press('Escape'); await sleep(300); }
  await shot('09-sidebar-idle', side ?? undefined);

  // ── 5. 턴 진행 중 / 끝 ──
  const held = new Promise((resolve) => { gate.hold = resolve; });
  const turnDone = session.recorder.nextTurnEnd();
  await page.evaluate((value) => {
    const ta = document.querySelector('.dg-input');
    ta.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, '소제목을 모두 굵게, 13pt, 파란색으로 바꾸고 문서 끝에 "추진 일정" 제목을 추가해줘.');
  await sleep(300);
  await shot('10-composer-typed', side ?? undefined);
  await click('.dg-send');
  await held;
  await sleep(500);
  await shot('11-turn-running');
  await shot('11b-turn-running-sidebar', side ?? undefined);
  gate.release();
  await turnDone;
  await sleep(1500);
  await shot('12-turn-done-review');
  await shot('12b-turn-done-sidebar', side ?? undefined);
  // 도구 묶음 펼치기
  const expanded = await page.evaluate(() => { const b = document.querySelector('.dg-tools-toggle, .dg-tool-group summary, [class*="dg-tools"] button'); if (b) b.click(); return !!b; });
  if (expanded) await shot('13-tools-expanded', side ?? undefined);
  // 검토 줄 하나에 올리기
  await page.evaluate(() => document.querySelector('#scroll-container')?.scrollTo({ top: 0 }));
  const row = await rectOf('.dg-rl-row, [class*="dg-rl-row"]');
  if (row) { await page.mouse.move(row.x + 40, row.y + 10); await shot('14-review-row-hover', side ?? undefined); }
  // 문서 위 검토 표시 — 바뀐 곳으로 이동
  await clickText('다음 변경') || await click('[aria-label="다음 변경"]');
  await sleep(900);
  await shot('15-review-on-document');

  // ── 6. 좁은 화면 ──
  await page.setViewport({ width: 1280, height: 720 });
  await sleep(900);
  await shot('16-narrow-1280x720');
  await page.setViewport({ width: 1024, height: 700 });
  await sleep(900);
  await shot('17-narrow-1024x700');
  await page.setViewport({ width: 1600, height: 1000 });
  await sleep(600);

  // ── 7. 거절 뒤 / 오류·한도 ──
  await session.review('reject');
  await sleep(800);
  await shot('18-after-reject', side ?? undefined);
  const errDone = session.recorder.nextTurnEnd();
  await page.evaluate((value) => {
    const ta = document.querySelector('.dg-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, '오류 상황을 보여줘');
  await sleep(200);
  await click('.dg-send');
  await errDone;
  await sleep(1200);
  await shot('19-tool-error-and-limit', side ?? undefined);

  // ── 8. 밝은 테마 ──
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await sleep(900);
  await shot('20-light-theme');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  // ── 9. 연결 끊김 ──
  await session.hub.close();
  await sleep(2500);
  await shot('21-hub-disconnected', side ?? undefined);
} finally {
  await session.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.stop();
}
console.error(`결과: ${outDir}`);
