// 두글 에이전트 평가 세션 — 실제 hub + 실제 studio(헤드리스 Chrome) + 실제 provider 로 한 턴을 돌리고
// 도구 호출 전문(인자·결과·오류·시간)을 기록한다.
//
// 구성:
//   Node(이 파일) ── createHub(provider 를 기록용으로 감쌈) ── ws ── studio 페이지(doogle.html, 헤드리스)
// 대화는 실제 사이드바 입력창으로 보낸다(chat_send 경로 그대로). 읽기 검증은 hub.callTool(origin:'mcp').
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHub, DEFAULT_ALLOWED_ORIGINS } from '../../src/hub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const STUDIO_DIR = path.join(REPO_ROOT, 'rhwp-studio');
export const FIXTURE_DIR = path.join(here, '..', '.fixtures');

const studioRequire = createRequire(path.join(STUDIO_DIR, 'package.json'));

const CHROME_CANDIDATES = [
  process.env.DOOGLE_EVAL_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function findChrome() {
  for (const c of CHROME_CANDIDATES) if (await exists(c)) return c;
  throw new Error('Chrome 을 찾지 못했습니다 — DOOGLE_EVAL_CHROME 에 실행 파일 경로를 주세요');
}

function httpOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode !== undefined && res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

/**
 * studio 개발 서버(Vite)를 확보한다. 이미 떠 있으면 그대로 쓰고, 없으면 띄운다.
 * @returns {Promise<{url: string, stop: () => Promise<void>}>}
 */
export async function ensureStudioServer({ port = 7700, log = () => {} } = {}) {
  const url = `http://127.0.0.1:${port}`;
  if (await httpOk(`${url}/doogle.html`)) return { url, stop: async () => {} };
  const viteBin = path.join(STUDIO_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: STUDIO_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let tail = '';
  const keep = (d) => { tail = (tail + String(d)).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite 가 종료했습니다 (${child.exitCode}): ${tail}`);
    if (await httpOk(`${url}/doogle.html`)) {
      log(`studio dev server: ${url}`);
      return { url, stop: async () => { child.kill(); } };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`Vite 가 ${port} 포트에서 뜨지 않았습니다: ${tail}`);
}

export async function launchBrowser({ headless = true } = {}) {
  const puppeteer = studioRequire('puppeteer-core');
  return puppeteer.launch({
    executablePath: await findChrome(),
    headless,
    args: ['--no-first-run', '--disable-extensions', '--window-size=1600,1000', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1600, height: 1000 },
  });
}

/** provider 를 감싸 한 턴의 이벤트·도구 호출 전문을 기록한다. */
function recordingProvider(real, recorder) {
  return {
    id: real.id,
    label: real.label,
    detect: (ctx) => real.detect(ctx),
    // listModels 는 넘기지 않는다 — 평가에서는 provider 정적 목록이면 충분하고 조회 세션을 띄우지 않는다.
    async runTurn(p) {
      const turn = recorder.beginTurn({ text: p.text, userText: p.userText, mode: p.mode, model: p.model ?? null });
      const callTool = async (name, args) => {
        const started = Date.now();
        const entry = turn.toolStart(name, args, started);
        const r = await p.callTool(name, args);
        turn.toolEnd(entry, r, Date.now() - started);
        return r;
      };
      const emit = (event) => { turn.event(event); p.emit(event); };
      try {
        const out = await real.runTurn({ ...p, callTool, emit });
        turn.end(null);
        return out;
      } catch (err) {
        turn.end(err);
        throw err;
      }
    },
  };
}

function jsonChars(value) {
  try { return (typeof value === 'string' ? value : JSON.stringify(value ?? null)).length; } catch { return 0; }
}

/** 그림(base64)은 기록에서 길이만 남긴다. */
function stripImage(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { value: result, image: null };
  const image = result.image;
  if (image && typeof image === 'object' && typeof (image.base64 ?? image.data) === 'string') {
    const { image: _omit, ...rest } = result;
    const b64 = image.base64 ?? image.data;
    return { value: { ...rest, image: `<${image.mimeType ?? 'image'} ${b64.length} b64 chars${image.width ? ` ${image.width}x${image.height}` : ''}>` }, image: { base64: b64, mimeType: image.mimeType ?? 'image/png' } };
  }
  return { value: result, image: null };
}

export class Recorder {
  constructor() {
    this.turns = [];
    this.waiters = [];
  }

  beginTurn(meta) {
    const startedAt = Date.now();
    const turn = {
      ...meta, startedAt, durationMs: null, error: null, usage: null,
      timeline: [], // {t, kind:'text'|'tool'|'status'|'error'|'limit', ...}
      toolCalls: [],
      images: [],
    };
    this.turns.push(turn);
    let text = '';
    const flushText = () => {
      if (text.trim()) turn.timeline.push({ t: Date.now() - startedAt, kind: 'text', text });
      text = '';
    };
    const self = this;
    return {
      toolStart(name, args, started) {
        flushText();
        const entry = { seq: turn.toolCalls.length + 1, name, args, t: started - startedAt, ms: null, ok: null, result: null, error: null, resultChars: 0 };
        turn.toolCalls.push(entry);
        turn.timeline.push({ t: entry.t, kind: 'tool', seq: entry.seq });
        return entry;
      },
      toolEnd(entry, r, ms) {
        entry.ms = ms;
        entry.ok = !!r?.ok;
        if (r?.ok) {
          const { value, image } = stripImage(r.result);
          entry.result = value;
          entry.resultChars = jsonChars(value);
          if (image) { entry.imageIndex = turn.images.length; turn.images.push(image); }
        } else {
          entry.error = r?.error ?? { code: 'UNKNOWN', message: '' };
          entry.resultChars = jsonChars(entry.error);
        }
      },
      event(e) {
        if (!e || typeof e !== 'object') return;
        if (e.kind === 'text_delta') { text += e.text ?? ''; return; }
        if (e.kind === 'text_done') { flushText(); return; }
        if (e.kind === 'usage') { turn.usage = { ...e }; delete turn.usage.kind; return; }
        turn.timeline.push({ t: Date.now() - startedAt, ...e });
      },
      end(err) {
        flushText();
        turn.durationMs = Date.now() - startedAt;
        if (err) turn.error = { code: err.code ?? 'ERROR', message: String(err.message ?? err) };
        for (const w of self.waiters.splice(0)) w(turn);
      },
    };
  }

  /** 다음에 끝나는 턴을 기다린다. */
  nextTurnEnd() {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * 평가 세션 하나 = hub 하나 + 페이지 하나 + 문서 하나.
 * @param {{browser: any, studioUrl: string, provider: any, mode?: 'agent'|'full', model?: string, log?: (m:string)=>void}} opts
 */
export async function openSession({ browser, studioUrl, provider, mode = 'agent', model = 'default', log = () => {} }) {
  const recorder = new Recorder();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doogle-eval-'));
  const origin = new URL(studioUrl).origin;
  const hub = await createHub({
    port: 0,
    dataDir,
    writeHubJson: false,
    refreshModelsOnStart: false,
    providers: [recordingProvider(provider, recorder)],
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, origin, origin.replace('127.0.0.1', 'localhost')],
    log: (m) => log(`[hub] ${m}`),
  });

  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 500)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e?.message ?? e).slice(0, 500)}`));
  page.on('dialog', (d) => { void d.accept().catch(() => {}); });
  await page.evaluateOnNewDocument((providerId, modelId, chatMode) => {
    try {
      localStorage.setItem('doogle.provider', providerId);
      localStorage.setItem(`doogle.model.${providerId}`, modelId);
      localStorage.setItem('doogle.mode', chatMode);
      localStorage.setItem('doogle.onboarded', '1');
      localStorage.setItem('doogle.panel', '1');
    } catch { /* ignore */ }
  }, provider.id, model, mode);
  await page.goto(`${studioUrl}/doogle.html?hubPort=${hub.port}&hubToken=${encodeURIComponent(hub.token)}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !!window.rhwpStudio?.plugins?.isLoaded?.('doogle'), { timeout: 120_000 });
  await waitFor(() => hub.studioConnected, 30_000, 'studio 가 hub 에 연결되지 않았습니다');

  const tool = (name, args = {}) => hub.callTool({ name, args, origin: 'mcp' });

  async function openDocument(file) {
    const input = await page.$('#file-input');
    if (!input) throw new Error('#file-input 이 없습니다');
    await input.uploadFile(file);
    const base = path.basename(file);
    await waitFor(async () => {
      const r = await tool('get_document_info');
      return r.ok && (r.result?.pageCount ?? 0) > 0 && (!r.result?.name || String(r.result.name).includes(base.replace(/\.[^.]+$/, '').slice(0, 8)));
    }, 120_000, `문서를 열지 못했습니다: ${base}`);
    // 두글은 글꼴이 없어도 창을 띄우지 않고 비슷한 글꼴로 바로 그린다(알림 띠만 뜬다).
    // 예전 빌드의 「로컬 글꼴 감지」 창이 남아 있으면 닫는다.
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '대체 글꼴로 보기')?.click();
    });
    // 첫 조판·글꼴 로드·첫 쪽 그리기가 가라앉을 시간
    await page.waitForFunction(() => {
      const pages = document.querySelectorAll('#scroll-container canvas');
      return pages.length > 0;
    }, { timeout: 20_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
  }

  /** 문서 전체의 full-text 구조 덤프 — 16k 글자 예산으로 잘리면 이어 읽어 붙인다(첫 줄의 revision 은 뺀다). */
  async function structure(extra = {}) {
    const parts = [];
    let args = { text: 'full', maxParagraphs: 2000, ...extra };
    for (let guard = 0; guard < 80; guard++) {
      const r = await tool('get_structure', args);
      if (!r.ok) { parts.push(`ERROR ${r.error?.code}: ${r.error?.message}`); break; }
      const text = String(r.result?.text ?? '');
      const lines = text.split('\n');
      // 머리 줄(revision 요약)은 첫 조각에서만 남긴다
      parts.push(guard === 0 ? [lines[0].replace(/^revision \d+ · /, ''), ...lines.slice(1)].join('\n') : lines.slice(1).join('\n'));
      const m = /TRUNCATED — continue with range \{sectionIdx:(\d+), fromPara:(\d+), toPara:(\d+)\}/.exec(lines[0]);
      if (!m) break;
      args = { text: 'full', maxParagraphs: 2000, range: { sectionIdx: Number(m[1]), fromPara: Number(m[2]), toPara: Number(m[3]) } };
    }
    return parts.join('\n');
  }

  /** 사이드바 입력창으로 한 턴을 보내고 끝날 때까지 기다린다. */
  async function send(text, { timeoutMs = 12 * 60_000 } = {}) {
    await page.waitForSelector('.dg-input', { timeout: 30_000 });
    const done = recorder.nextTurnEnd();
    await page.evaluate((value) => {
      const ta = document.querySelector('.dg-input');
      ta.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, value);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.waitForFunction(() => {
      const b = document.querySelector('.dg-send');
      return !!b && !b.disabled;
    }, { timeout: 60_000 });
    // Enter 는 편집기의 숨은 입력이 포커스를 가져가면 닿지 않는다 — 보내기 단추를 누른다.
    await page.evaluate(() => document.querySelector('.dg-send').click());
    let timer;
    const turn = await Promise.race([
      done,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`턴이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    // hub 의 turn_end 가 화면에 닿을 시간
    await new Promise((r) => setTimeout(r, 500));
    return turn;
  }

  /** 검토 대기 변경을 화면 단추로 모두 적용/거절한다. 단추가 없으면 false. */
  async function review(decision) {
    const selector = decision === 'accept' ? '.dg-rl-btn.dg-rl-primary' : '.dg-rl-btn.dg-rl-reject-all';
    const clicked = await page.evaluate((sel) => {
      const b = document.querySelector(sel);
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }, selector);
    if (clicked) await new Promise((r) => setTimeout(r, 600));
    return clicked;
  }

  async function exportDocument(format) {
    const b64 = await page.evaluate((fmt) => {
      const w = window.__wasm;
      const doc = w?.doc ?? w;
      const fn = fmt === 'hwpx' ? 'exportHwpx' : 'exportHwp';
      const bytes = typeof w?.[fn] === 'function' ? w[fn]() : doc[fn]();
      let s = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      return btoa(s);
    }, format);
    return Buffer.from(b64, 'base64');
  }

  async function close() {
    try { await page.close(); } catch { /* ignore */ }
    try { await context.close(); } catch { /* ignore */ }
    try { await hub.close(); } catch { /* ignore */ }
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  return { hub, page, recorder, consoleErrors, tool, openDocument, structure, send, review, exportDocument, close };
}

export async function waitFor(pred, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await pred()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${message}${last ? ` (${last.message})` : ''}`);
}
