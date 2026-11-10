// 동적 모델 목록: model-catalog(캐시/TTL/fallback/중복 조회), claude-sdk·anthropic-api 매핑, hub models_refresh.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';

import { createHub } from '../src/hub.mjs';
import { defaultModelId, ModelCatalog, MODELS_CACHE_FILE, normalizeModels } from '../src/model-catalog.mjs';
import { listClaudeModels, mapClaudeModels } from '../src/providers/claude-sdk.mjs';
import { listAnthropicModels } from '../src/providers/anthropic-api.mjs';
import { stubTools } from '../src/tools-loader.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'doogle-models-test-'));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// ── model-catalog ───────────────────────────────────────────

describe('model-catalog', () => {
  test('normalizeModels: 형태 정리·중복 제거·source', () => {
    const out = normalizeModels([{ id: 'a', label: 'A', default: true, extra: 1 }, { id: 'a' }, { label: 'x' }, { id: 'b' }], 'live');
    assert.deepEqual(out, [{ id: 'a', label: 'A', default: true, source: 'live' }, { id: 'b', label: 'b', source: 'live' }]);
    assert.equal(defaultModelId(out), 'a');
    assert.equal(defaultModelId([{ id: 'x' }]), 'x');
    assert.equal(defaultModelId([]), null);
  });

  test('캐시 없음 → 실시간, 저장(0600 파일), 신선하면 재조회 없음', async () => {
    const dir = await tmpDir();
    let now = 1_000_000;
    const c = new ModelCatalog({ dataDir: dir, now: () => now });
    let calls = 0;
    const fetch = async () => { calls++; return [{ id: 'm1', label: 'M1' }]; };
    const r = await c.resolve('p', { fetch, fallback: [{ id: 'fb', label: 'FB' }] });
    assert.equal(r.source, 'live');
    assert.deepEqual(r.models, [{ id: 'm1', label: 'M1', source: 'live' }]);
    assert.equal(r.updatedAt, now);
    now += 1000;
    const r2 = await c.resolve('p', { fetch, fallback: [] });
    assert.equal(r2.source, 'live');
    assert.equal(calls, 1);
    await c.idle();
    const disk = JSON.parse(await fs.readFile(path.join(dir, MODELS_CACHE_FILE), 'utf8'));
    assert.deepEqual(disk.providers.p.models, [{ id: 'm1', label: 'M1' }]);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(dir, MODELS_CACHE_FILE))).mode & 0o777, 0o600);
    }
    // 새 프로세스: 디스크에서 읽으면 source 'cache'
    const c2 = new ModelCatalog({ dataDir: dir, now: () => now });
    const r3 = await c2.resolve('p', { fetch: async () => { throw new Error('offline'); } });
    assert.equal(r3.source, 'cache');
    assert.deepEqual(r3.models, [{ id: 'm1', label: 'M1', source: 'cache' }]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('TTL 지남 → 캐시를 즉시 돌려주고 뒤에서 갱신, 바뀌면 onUpdate', async () => {
    let now = 0;
    const c = new ModelCatalog({ file: null, ttlMs: 100, now: () => now });
    await c.refresh('p', async () => [{ id: 'old', label: 'Old' }]);
    now = 500;
    const d = deferred();
    const updated = [];
    const r = await c.resolve('p', { fetch: () => d.promise, onUpdate: (id) => updated.push(id) });
    assert.deepEqual(r.models.map((m) => m.id), ['old']);
    d.resolve([{ id: 'new', label: 'New' }]);
    await c.idle();
    await tick();
    assert.deepEqual(updated, ['p']);
    assert.deepEqual(c.peek('p').models.map((m) => m.id), ['new']);
  });

  test('실시간·캐시 모두 실패 → fallback(source fallback, error)', async () => {
    const c = new ModelCatalog({ file: null });
    const r = await c.resolve('p', { fetch: async () => { throw new Error('nope'); }, fallback: [{ id: 'fb', label: 'FB', default: true }] });
    assert.equal(r.source, 'fallback');
    assert.equal(r.updatedAt, null);
    assert.equal(r.error, 'nope');
    assert.deepEqual(r.models, [{ id: 'fb', label: 'FB', default: true, source: 'fallback' }]);
    // fetch 없음(사용 불가 provider) → 캐시 없으면 fallback
    const r2 = await c.resolve('q', { fallback: [{ id: 'x', label: 'X' }] });
    assert.equal(r2.source, 'fallback');
  });

  test('캐시 없고 조회가 느리면 waitMs 후 fallback, 끝나면 onUpdate', async () => {
    const c = new ModelCatalog({ file: null });
    const d = deferred();
    const updated = [];
    const r = await c.resolve('p', { fetch: () => d.promise, fallback: [{ id: 'fb', label: 'FB' }], waitMs: 10, onUpdate: (id) => updated.push(id) });
    assert.equal(r.source, 'fallback');
    d.resolve([{ id: 'live', label: 'Live' }]);
    await c.idle();
    await tick();
    assert.deepEqual(updated, ['p']);
  });

  test('provider당 조회는 하나만 (in-flight dedupe)', async () => {
    const c = new ModelCatalog({ file: null });
    const d = deferred();
    let calls = 0;
    const fetch = () => { calls++; return d.promise; };
    const a = c.refresh('p', fetch);
    const b = c.refresh('p', fetch);
    const r = c.resolve('p', { fetch, waitMs: 1000 });
    assert.equal(a, b);
    d.resolve([{ id: 'm', label: 'M' }]);
    await Promise.all([a, b, r]);
    assert.equal(calls, 1);
    // 끝난 뒤에는 새 조회 가능
    await c.refresh('p', async () => { calls++; return [{ id: 'm2' }]; });
    assert.equal(calls, 2);
  });

  test('빈 목록은 실패로 본다', async () => {
    const c = new ModelCatalog({ file: null });
    await assert.rejects(c.refresh('p', async () => []));
    assert.equal(c.peek('p'), null);
  });
});

// ── claude-sdk ──────────────────────────────────────────────

const SDK_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Most capable\nsecond line', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · everyday' },
  { value: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: '' },
  { value: 'sonnet', displayName: 'dup' },
  { displayName: 'no value' },
];

describe('claude-sdk 모델 목록', () => {
  test('mapClaudeModels: default 표시, 별칭 resolvedModel, effort', () => {
    assert.deepEqual(mapClaudeModels(SDK_MODELS), [
      { id: 'default', label: 'Default (recommended)', source: 'live', description: 'Opus 5.5 · Most capable', default: true, supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
      { id: 'sonnet', label: 'Sonnet', source: 'live', description: 'Sonnet 5.5 · everyday', resolvedModel: 'claude-sonnet-5-5', aliasOf: 'claude-sonnet-5-5' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', source: 'live' },
    ]);
  });

  test('listClaudeModels: 메시지를 보내지 않는 query로 supportedModels를 읽고 닫는다', async () => {
    let opts = null;
    let closed = false;
    let promptYielded = false;
    const fakeSdk = {
      query({ prompt, options }) {
        opts = options;
        // prompt를 소비해 본다: 아무것도 내보내지 않아야 한다
        (async () => { for await (const _ of prompt) promptYielded = true; })();
        return {
          async supportedModels() { return SDK_MODELS; },
          close() { closed = true; },
          async *[Symbol.asyncIterator]() { /* 메시지 없음 */ },
        };
      },
    };
    const models = await listClaudeModels({ sdk: fakeSdk, cwd: os.tmpdir(), exe: null });
    assert.equal(models.length, 3);
    assert.equal(closed, true);
    assert.equal(promptYielded, false);
    assert.deepEqual(opts.tools, []);
    assert.deepEqual(opts.mcpServers, {});
    assert.deepEqual(opts.settingSources, []);
    assert.equal(opts.strictMcpConfig, true);
    assert.equal('model' in opts, false);
  });

  test('listClaudeModels: 시간 초과 시 실패하고 닫는다', async () => {
    let closed = false;
    const fakeSdk = {
      query() {
        return {
          supportedModels: () => new Promise(() => {}),
          close() { closed = true; },
          async *[Symbol.asyncIterator]() {},
        };
      },
    };
    await assert.rejects(listClaudeModels({ sdk: fakeSdk, cwd: os.tmpdir(), exe: null, timeoutMs: 20 }), /시간 초과/);
    assert.equal(closed, true);
  });
});

// ── anthropic-api ───────────────────────────────────────────

describe('anthropic-api 모델 목록', () => {
  test('GET /v1/models 페이지 넘김(has_more/last_id), display_name, 헤더', async () => {
    const calls = [];
    const pages = [
      { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }], has_more: true, first_id: 'claude-opus-5-5', last_id: 'claude-sonnet-5-5' },
      { data: [{ type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }], has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5' },
    ];
    const fetch = async (url, init) => {
      calls.push({ url: new URL(url), headers: init.headers });
      const body = pages[calls.length - 1];
      return { ok: true, status: 200, json: async () => body };
    };
    const models = await listAnthropicModels({ apiKey: 'sk-test', fetch });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://api.anthropic.com/v1/models');
    assert.equal(calls[0].url.searchParams.get('after_id'), null);
    assert.equal(calls[1].url.searchParams.get('after_id'), 'claude-sonnet-5-5');
    assert.equal(calls[0].headers['x-api-key'], 'sk-test');
    assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(models, [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', source: 'live' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', source: 'live', default: true },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', source: 'live' },
    ]);
  });

  test('HTTP 오류 → 실패, key 없음 → 실패', async () => {
    await assert.rejects(listAnthropicModels({ apiKey: 'k', fetch: async () => ({ ok: false, status: 401 }) }), /401/);
    await assert.rejects(listAnthropicModels({ apiKey: null, fetch: async () => { throw new Error('호출되면 안 됨'); } }), /API key/);
  });
});

// ── hub models_refresh ──────────────────────────────────────

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.queue = [];
    this.waiters = [];
    this.ws.on('message', (d) => { this.queue.push(JSON.parse(String(d))); this.flush(); });
  }
  open() { return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); }); }
  send(o) { this.ws.send(JSON.stringify(o)); }
  flush() {
    for (const w of [...this.waiters]) {
      const i = this.queue.findIndex(w.pred);
      if (i >= 0) {
        const [m] = this.queue.splice(i, 1);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  }
  next(pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ pred, resolve, timer: setTimeout(() => reject(new Error('timeout')), ms) });
      this.flush();
    });
  }
  close() { this.ws.close(); }
}

describe('hub models_refresh', () => {
  let hub;
  let dir;
  let version = 1;
  let listCalls = 0;
  let failTurn = false;
  const live = {
    id: 'live',
    label: 'Live',
    async detect() { return { available: true, models: [{ id: 'fb', label: 'Fallback', default: true }] }; },
    async listModels() {
      listCalls++;
      return [{ id: `m${version}`, label: `M${version}` }, { id: 'def', label: 'Def', default: true }];
    },
    async runTurn() {
      if (failTurn) throw new Error('model: m0 not_found_error');
      return { messages: [] };
    },
  };

  before(async () => {
    dir = await tmpDir();
    hub = await createHub({ port: 0, dataDir: dir, writeHubJson: false, persistThreads: false, providers: [live], tools: { ...stubTools(), stub: false }, refreshModelsOnStart: true, log: () => {} });
  });
  after(async () => {
    await hub.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('기동 시 갱신 → providers에 live 목록·defaultModel·modelsUpdatedAt', async () => {
    for (let i = 0; i < 100 && !hub.modelCatalog.peek('live'); i++) await new Promise((r) => setTimeout(r, 10));
    await hub.modelCatalog.idle();
    assert.equal(listCalls, 1);
    const s = new Client(`ws://127.0.0.1:${hub.port}/studio?token=${hub.token}`);
    await s.open();
    s.send({ type: 'providers_query' });
    const p = await s.next((m) => m.type === 'providers');
    const e = p.list[0];
    assert.deepEqual(e.models.map((m) => [m.id, m.source]), [['m1', 'live'], ['def', 'live']]);
    assert.equal(e.defaultModel, 'def');
    assert.match(e.modelsUpdatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(listCalls, 1); // 신선한 캐시 — 재조회 없음

    // models_refresh → 다시 받고 providers 보냄
    version = 2;
    s.send({ type: 'models_refresh', providerId: 'live' });
    const p2 = await s.next((m) => m.type === 'providers');
    assert.equal(listCalls, 2);
    assert.deepEqual(p2.list[0].models.map((m) => m.id), ['m2', 'def']);

    // 없는 모델 오류로 턴 실패 → 자동 갱신 후 providers push
    version = 3;
    failTurn = true;
    s.send({ type: 'chat_send', threadId: 't1', providerId: 'live', model: 'm0', text: 'hi', mode: 'agent' });
    const p3 = await s.next((m) => m.type === 'providers' && m.list[0].models[0].id === 'm3');
    assert.equal(p3.list[0].models[0].id, 'm3');
    assert.equal(listCalls, 3);
    s.close();
  });
});
