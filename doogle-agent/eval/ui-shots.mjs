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
    // 첫 시도는 실패하고(없는 글), 에이전트가 스스로 다시 해낸다 → "다시 시도함" 으로 접힌다
    const miss = await callTool('replace_range', { expectedRevision: 1, paraIdx: 47, find: '없는 글', text: 'x' });
    const s = await callTool('get_structure', {});
    await callTool('replace_range', { expectedRevision: s.result?.revision ?? miss.error?.data?.currentRevision, paraIdx: 48, find: '홈페이지 구축', text: '누리집 구축' });
    emit({ kind: 'limit', message: 'Claude 구독 사용 한도에 도달했습니다.', resetAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
    throw Object.assign(new Error('Claude 구독 사용 한도에 도달했습니다.'), { code: 'LIMIT', emitted: true });
  }
  if (userText.includes('보기 좋게')) {
    // 범위를 정할 수 없는 요청 — 질문 카드로 되묻고 턴을 끝낸다
    await callTool('get_structure', {});
    await callTool('ask_user_question', {
      question: '어느 범위를 바꿀까요?',
      options: [
        { label: '장 제목 7개만', description: '1. 사업 개요처럼 번호가 붙은 큰 제목' },
        { label: '하위 제목만' },
        { label: '두 단계 모두' },
      ],
    });
    await say('제목 서식을 어디까지 바꿀지 골라 주세요.');
    return;
  }
  if (userText.includes('장 제목 7개만')) {
    await say('장 제목 7개만 바꾸겠습니다. (대본: 여기서는 문서를 고치지 않습니다)');
    return;
  }
  if (userText.includes('수식')) {
    const s = await callTool('get_structure', {});
    await callTool('insert_equation', { expectedRevision: s.result?.revision, sectionIdx: 0, paraIdx: 47, charOffset: 0, script: 'x= {-b +- sqrt {b^2 -4ac}} over {2a}', fontSizePt: 14 });
    await say('근의 공식을 넣었습니다.');
    return;
  }
  await say('먼저 문서 구조를 읽어 소제목을 확인하겠습니다.');
  const s = await callTool('get_structure', {});
  await callTool('find_text', { query: '사업명' });
  // 가운데에서 한 번 멈춘다 — 진행 중 화면을 찍는다
  const rev = s.result?.revision;
  const first = callTool('apply_edits', { expectedRevision: rev, render: 'crop', edits: [
    { tool: 'apply_char_format', paras: [47, 50, 57, 68, 72, 81], bold: true, fontSizePt: 13, textColor: '#1F4E79' },
    { tool: 'replace_range', paraIdx: 48, find: '홈페이지 구축', text: '누리집 구축' },
  ] });
  const w1 = await first;
  await new Promise((resolve) => { gate.release = resolve; gate.hold?.(); });
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
const type = async (value) => {
  await page.evaluate((v) => {
    const ta = document.querySelector('.dg-input');
    ta.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await sleep(250);
};
/** 한 턴을 보내고 끝날 때까지 기다린다 */
const ask = async (value) => {
  const done = session.recorder.nextTurnEnd();
  await type(value);
  await click('.dg-send');
  await done;
  await sleep(900);
};
/** 화면에 보이는 글 (검증용) */
const textOf = async (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent?.replace(/\s+/g, ' ').trim()).filter(Boolean), selector);
const facts = {};

try {
  // ── 1. 문서 없는 첫 화면 ──
  await sleep(1200);
  await shot('01-empty');
  facts.placeholderNew = await page.evaluate(() => document.querySelector('.dg-input')?.placeholder);

  // ── 2. 문서 열기 — 글꼴 창 대신 알림 띠 ──
  const input = await page.$('#file-input');
  await input.uploadFile(path.join(FIXTURE_DIR, 'biz_plan.hwp'));
  await page.waitForFunction(() => document.querySelectorAll('#scroll-container canvas').length > 0, { timeout: 60_000 }).catch(() => {});
  await sleep(1800);
  facts.fontDialog = await page.evaluate(() => [...document.querySelectorAll('.modal-overlay .dialog-title')].map((n) => n.textContent));
  facts.banner = await textOf('.dg-banner:not([hidden]) .dg-banner-text');
  await shot('02-font-banner');
  if (await clickText('글꼴 확인')) { await shot('02b-font-banner-open', { x: 0, y: 0, width: 1600, height: 420 }); await clickText('접기'); }
  await shot('03-document-idle');
  facts.statusBar = await textOf('#status-bar .stb-item:not([hidden]), #status-bar #sb-message');

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

  // ── 3. 사이드바: 입력창·모델 이름 ──
  const side = await rectOf('#side-panel-host');
  facts.modelButton = await textOf('.dg-model-text');
  if (await click('.dg-model-btn')) { await shot('06-model-menu', side ?? undefined); await page.keyboard.press('Escape'); }
  await shot('09-sidebar-idle', side ?? undefined);

  // ── 4. 턴 진행 중 / 끝 ──
  const held = new Promise((resolve) => { gate.hold = resolve; });
  const turnDone = session.recorder.nextTurnEnd();
  await type('소제목을 모두 굵게, 13pt, 파란색으로 바꾸고 문서 끝에 "추진 일정" 제목을 추가해줘.');
  await shot('10-composer-typed', side ?? undefined);
  await click('.dg-send');
  await held;
  await sleep(500);
  facts.runningStatus = await textOf('.dg-thinking');
  facts.doneLines = await textOf('.dg-done-item');
  await shot('11-turn-running');
  await shot('11b-turn-running-sidebar', side ?? undefined);
  gate.release();
  await turnDone;
  await sleep(1500);
  facts.placeholderAfter = await page.evaluate(() => document.querySelector('.dg-input')?.placeholder);
  facts.turnOrder = await page.evaluate(() => [...(document.querySelector('.dg-turn')?.children ?? [])].map((n) => n.className.split(' ')[0]));
  facts.reviewBar = await textOf('.dg-review-bar .dg-rl-head > *');
  facts.reviewRows = await page.evaluate(() => [...document.querySelectorAll('.dg-rl-row')].map((row) => ({
    lines: [...row.querySelectorAll('.dg-rl-line')].map((l) => l.textContent.replace(/\s+/g, ' ').trim()),
    swatches: row.querySelectorAll('.dg-swatch').length,
    buttons: [...row.querySelectorAll('.dg-rl-act')].map((b) => b.textContent.trim()),
  })));
  facts.revertWhilePending = await page.evaluate(() => [...document.querySelectorAll('.dg-act-revert')].map((b) => !b.hidden));
  await shot('12-turn-done-review');
  await shot('12b-turn-done-sidebar', side ?? undefined);
  // 되돌리기 단추에 올리면 함께 되돌아갈 행이 강조된다
  const chained = await rectOf('.dg-rl-act.dg-rl-chained');
  if (chained) {
    await page.mouse.move(chained.x + 10, chained.y + 8);
    await sleep(250);
    facts.revertHighlight = await page.evaluate(() => document.querySelectorAll('.dg-rl-row.dg-rl-revert').length);
    await shot('14-reject-chain-hover', side ?? undefined);
    await page.mouse.move(600, 500);
  }
  // 문서 위 검토 표시 — 바뀐 곳으로 이동 (대상이 화면 3분의 1 지점, 풍선은 이동 막대와 겹치지 않게)
  for (const step of [1, 2]) {
    await click('[aria-label^="다음 변경"]');
    await sleep(1100);
    facts[`popover${step}`] = await page.evaluate(() => {
      const r = (el) => { if (!el || el.hidden) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
      const boxes = [...document.querySelectorAll('#scroll-content .selection-layer > div')].filter((n) => n.style.display !== 'none').map((n) => n.getBoundingClientRect()).filter((b) => b.width > 0);
      const editor = document.getElementById('scroll-container').getBoundingClientRect();
      const top = boxes.length ? Math.min(...boxes.map((b) => b.top)) : null;
      return {
        pop: r(document.querySelector('.dg-review-pop')),
        pill: r(document.querySelector('.dg-review-pill')),
        targetAt: top === null ? null : Number(((top - editor.top) / editor.height).toFixed(2)),
        counter: document.querySelector('.dg-pill-count')?.textContent,
      };
    });
    await shot(`15-review-on-document-${step}`);
  }

  // ── 5. 좁은 화면 ──
  await page.setViewport({ width: 1280, height: 720 });
  await sleep(1200);
  await shot('16-narrow-1280x720');
  for (const [w, h] of [[1024, 700], [860, 700]]) {
    await page.setViewport({ width: w, height: h });
    await sleep(1500);
    facts[`narrow${w}`] = await page.evaluate(() => {
      const sc = document.getElementById('scroll-container');
      const side = document.getElementById('side-panel-host');
      const canvas = sc.querySelector('canvas');
      const c = canvas?.getBoundingClientRect();
      const s = sc.getBoundingClientRect();
      const composer = document.querySelector('.dg-composer-wrap')?.getBoundingClientRect();
      const scroll = document.querySelector('.dg-scroll')?.getBoundingClientRect();
      return {
        sidebar: Math.round(side.getBoundingClientRect().width),
        sidebarPosition: getComputedStyle(side).position,
        editor: Math.round(s.width),
        pageLeftInside: c ? Math.round(c.left - s.left) : null,
        pageWidth: c ? Math.round(c.width) : null,
        horizontalOverflow: sc.scrollWidth - sc.clientWidth,
        zoom: document.querySelector('.dg-pill-zoomval')?.textContent,
        conversationEndsAboveComposer: composer && scroll ? Math.round(composer.top - scroll.bottom) >= 0 : null,
      };
    });
    await shot(`17-narrow-${w}x${h}`);
  }
  await page.setViewport({ width: 1600, height: 1000 });
  await sleep(1500);
  facts.zoomRestored = await textOf('.dg-pill-zoomval');

  // ── 6. 적용 뒤 — "이 요청의 변경 되돌리기" ──
  await session.review('accept');
  await sleep(800);
  facts.revertAfterApply = await page.evaluate(() => [...document.querySelectorAll('.dg-act-revert')].map((b) => ({ shown: !b.hidden, text: b.textContent.trim(), title: b.title })));
  await shot('18-after-apply', side ?? undefined);
  const before = (await session.structure()).length;
  await click('.dg-act-revert:not([hidden])');
  await sleep(800);
  facts.revertedDocumentChanged = (await session.structure()).length !== before;
  facts.afterRevertNotice = (await textOf('.dg-notice')).slice(-1);
  await shot('18b-after-revert', side ?? undefined);

  // ── 7. 질문 카드 ──
  await ask('제목을 보기 좋게 정리해줘');
  facts.askCard = await page.evaluate(() => [...document.querySelectorAll('.dg-ask')].map((c) => ({ q: c.querySelector('.dg-card-title')?.textContent, opts: [...c.querySelectorAll('.dg-ask-opt')].map((b) => b.textContent.trim()) })));
  await shot('19-question-card', side ?? undefined);
  const answered = session.recorder.nextTurnEnd();
  await page.evaluate(() => document.querySelector('.dg-ask-opt')?.click());
  await answered;
  await sleep(800);
  facts.askAnswered = await page.evaluate(() => ({ user: [...document.querySelectorAll('.dg-user')].at(-1)?.textContent, closed: document.querySelector('.dg-ask')?.dataset.answered }));
  await shot('19b-question-answered', side ?? undefined);

  // ── 8. 도구 실패(다시 시도함)·한도 카드 ──
  await ask('오류 상황을 보여줘');
  await session.review('reject');
  await page.evaluate(() => {
    const chips = [...document.querySelectorAll('.dg-tools-chip')];
    chips.at(-1)?.click();
    const scroller = document.querySelector('.dg-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await sleep(300);
  facts.toolFailure = await page.evaluate(() => [...document.querySelectorAll('.dg-tool')].filter((li) => li.querySelector('.dg-tool-reason')).map((li) => ({ state: li.dataset.state, reason: li.querySelector('.dg-tool-reason').textContent, rawFolded: !li.querySelector('.dg-tool-raw')?.open })));
  facts.cards = await textOf('.dg-card:not(.dg-ask):not(.dg-start) .dg-card-title');
  await shot('20-tool-error-and-limit', side ?? undefined);

  // ── 9. 수식 — 한컴 수식 글꼴이 없어도 글자가 깨지지 않는다 ──
  await ask('근의 공식을 수식으로 넣어줘');
  facts.equationFonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => /hyhwpeq|hancomeqn/i.test(f.family)).map((f) => `${f.family}:${f.status}`);
  });
  await click('[aria-label^="다음 변경"]');
  await sleep(1300);
  await page.evaluate(() => document.querySelector('.dg-review-pop')?.setAttribute('hidden', ''));
  const eq = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#scroll-content .selection-layer > div, #scroll-content .caret')].map((n) => n.getBoundingClientRect()).filter((b) => b.height > 0);
    if (!boxes.length) return null;
    const top = Math.min(...boxes.map((b) => b.top));
    return { x: 300, y: Math.max(0, Math.floor(top - 60)), width: 760, height: 200 };
  });
  await shot('21-equation', eq ?? undefined);
  await session.review('accept');

  // ── 10. 밝은 테마 ──
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await sleep(900);
  await shot('22-light-theme');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  facts.consoleErrors = session.consoleErrors.slice(0, 10);
} finally {
  await fs.writeFile(path.join(outDir, 'facts.json'), JSON.stringify(facts, null, 1), 'utf8').catch(() => {});
  await session.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.stop();
}
console.error(`결과: ${outDir}`);
