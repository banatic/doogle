// SIWC 인증 모듈 테스트 — OpenAI 엔드포인트는 fetch 모킹, 루프백 콜백만 실제 127.0.0.1 HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSiwcAuth, AUTHORIZE_URL, TOKEN_URL, DISCOVERY_URL, RESOURCE, DYNAMIC_CLIENT_ID,
} from '../src/auth/siwc.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const ISS = 'https://auth.openai.com';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

function signJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${s}`;
}

function memSecrets() {
  const m = new Map();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k) };
}

/** OpenAI 인증 서버 모킹. tokenHandler(form) → {status, body} */
function mockAuthServer({ tokenHandler, revokeStatus = 200 }) {
  const log = [];
  const f = async (url, init = {}) => {
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    log.push({ url, form });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === DISCOVERY_URL) return json(200, { issuer: ISS, jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
    if (url === 'https://auth.openai.com/jwks') return json(200, { keys: [jwk] });
    if (url === TOKEN_URL) { const r = tokenHandler(form); return json(r.status, r.body); }
    if (url === 'https://auth.openai.com/oauth/revoke') return new Response('', { status: revokeStatus });
    throw new Error(`unexpected ${url}`);
  };
  return { f, log };
}

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doogle-siwc-'));
  const secrets = memSecrets();
  let t = Date.parse('2026-11-10T00:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  let nonceSeen = null;
  const tokenHandler = opts.tokenHandler || ((form) => {
    if (form.grant_type === 'authorization_code') {
      return { status: 200, body: {
        access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600, scope: opts.scope ?? SCOPE,
        id_token: signJwt({ iss: ISS, aud: form.client_id, sub: 'user-1', email: 'u@example.com', nonce: nonceSeen, exp: Math.floor(t / 1000) + 3600, iat: Math.floor(t / 1000) }),
      } };
    }
    if (form.grant_type === 'refresh_token') {
      if (form.refresh_token === 'rt-dead') return { status: 400, body: { error: 'refresh_token_reused' } };
      return { status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600, scope: SCOPE } };
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  });
  const server = mockAuthServer({ tokenHandler, revokeStatus: opts.revokeStatus });
  const auth = createSiwcAuth({ fetch: server.f, secrets, storePath: path.join(dir, 'siwc.json'), now: clock.now, loginTimeoutMs: 10_000 });
  return { auth, secrets, server, clock, dir, setNonce: (n) => { nonceSeen = n; } };
}

async function login(env, { clientIdInCallback = 'client-abc', extra = {} } = {}) {
  const { authUrl, redirectUri, waitForCompletion } = await env.auth.startLogin();
  const u = new URL(authUrl);
  env.setNonce(u.searchParams.get('nonce'));
  const cb = new URL(redirectUri);
  cb.searchParams.set('state', u.searchParams.get('state'));
  cb.searchParams.set('code', 'code-1');
  if (clientIdInCallback) cb.searchParams.set('client_id', clientIdInCallback);
  for (const [k, v] of Object.entries(extra)) cb.searchParams.set(k, v);
  const done = waitForCompletion();
  done.catch(() => {}); // 거부는 각 테스트에서 assert.rejects로 확인
  const res = await fetch(cb);
  await res.text();
  return { u, redirectUri, done };
}

test('authorize URL: 문서 파라미터 (최초 등록)', async () => {
  const env = setup();
  const { u, redirectUri, done } = await login(env);
  await done;
  assert.equal(`${u.origin}${u.pathname}`, AUTHORIZE_URL);
  const q = u.searchParams;
  assert.equal(q.get('client_id'), DYNAMIC_CLIENT_ID);
  assert.match(q.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(q.get('agent_name_hint'), 'doogle');
  assert.equal(q.get('response_type'), 'code');
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  assert.equal(q.get('redirect_uri'), redirectUri);
  assert.equal(q.get('scope'), SCOPE);
  assert.equal(q.get('resource'), RESOURCE);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.ok(q.get('state') && q.get('nonce') && q.get('code_challenge'));
});

test('로그인 완료: 코드 교환·ID 토큰 검증·저장, 이후 재인가는 저장된 client_id 사용', async () => {
  const env = setup();
  const { u, redirectUri, done } = await login(env);
  const r = await done;
  assert.equal(r.clientId, 'client-abc');
  assert.equal(r.sub, 'user-1');

  const ex = env.server.log.find((l) => l.url === TOKEN_URL);
  assert.equal(ex.form.grant_type, 'authorization_code');
  assert.equal(ex.form.client_id, 'client-abc');
  assert.equal(ex.form.code, 'code-1');
  assert.equal(ex.form.redirect_uri, redirectUri);
  assert.equal(ex.form.resource, RESOURCE);
  const challenge = crypto.createHash('sha256').update(ex.form.code_verifier).digest('base64url');
  assert.equal(challenge, u.searchParams.get('code_challenge'));

  assert.equal(env.secrets.m.get('openai-siwc-refresh-token'), 'rt-1');
  const rec = JSON.parse(fs.readFileSync(path.join(env.dir, 'siwc.json'), 'utf8'));
  assert.equal(rec.clientId, 'client-abc');
  assert.ok(!JSON.stringify(rec).includes('rt-1'), '파일에 refresh token 저장 금지');
  const st = await env.auth.status();
  assert.equal(st.signedIn, true);
  assert.equal(st.planUsage, true);
  assert.equal(await env.auth.getAccessToken(), 'at-1');

  // 재인가: 저장된 client_id, agent_name_hint 없음, 같은 host id
  const again = await login(env, { clientIdInCallback: null });
  await again.done;
  assert.equal(again.u.searchParams.get('client_id'), 'client-abc');
  assert.equal(again.u.searchParams.get('agent_name_hint'), null);
  assert.equal(again.u.searchParams.get('ext_agent_host_id'), u.searchParams.get('ext_agent_host_id'));
});

test('최초 등록에서 callback에 client_id가 없으면 등록 미완료', async () => {
  const env = setup();
  const { done } = await login(env, { clientIdInCallback: null });
  await assert.rejects(done, (e) => e.code === 'REGISTRATION_INCOMPLETE');
});

test('access_denied → 코드 교환 없이 중단', async () => {
  const env = setup();
  const { done } = await login(env, { extra: { error: 'access_denied' } });
  await assert.rejects(done, (e) => e.code === 'ACCESS_DENIED');
  assert.ok(!env.server.log.some((l) => l.url === TOKEN_URL));
});

test('chatgpt.tokens.use.direct 미부여 → SCOPE_NOT_GRANTED', async () => {
  const env = setup({ scope: 'openid profile email offline_access' });
  const { done } = await login(env);
  await assert.rejects(done, (e) => e.code === 'SCOPE_NOT_GRANTED');
});

test('ID 토큰 서명 위조 → 거부', async () => {
  const env = setup({ tokenHandler: (form) => ({ status: 200, body: {
    access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: SCOPE,
    id_token: signJwt({ iss: ISS, aud: form.client_id, sub: 'x', exp: 9e9, nonce: 'n' }).replace(/\.[^.]+$/, '.AAAA'),
  } }) });
  const { done } = await login(env);
  await assert.rejects(done, (e) => e.code === 'ID_TOKEN_INVALID');
});

test('refresh: 만료 임박 시 발급 client_id·resource로 갱신, refresh token 회전', async () => {
  const env = setup();
  await (await login(env)).done;
  env.clock.advance(3590_000);
  const tok = await env.auth.getAccessToken();
  assert.equal(tok, 'at-2');
  const rf = env.server.log.filter((l) => l.form?.grant_type === 'refresh_token');
  assert.equal(rf.length, 1);
  assert.deepEqual(rf[0].form, { grant_type: 'refresh_token', client_id: 'client-abc', refresh_token: 'rt-1', resource: RESOURCE });
  assert.equal(env.secrets.m.get('openai-siwc-refresh-token'), 'rt-2');
});

test('refresh: 동시 호출은 한 번만 갱신(직렬화)', async () => {
  const env = setup();
  await (await login(env)).done;
  env.clock.advance(3600_000);
  const [a, b] = await Promise.all([env.auth.getAccessToken(), env.auth.getAccessToken()]);
  assert.equal(a, 'at-2'); assert.equal(b, 'at-2');
  assert.equal(env.server.log.filter((l) => l.form?.grant_type === 'refresh_token').length, 1);
});

test('refresh: 종단 오류(refresh_token_reused) → 토큰 삭제, 재로그인 필요', async () => {
  const env = setup();
  await (await login(env)).done;
  env.secrets.m.set('openai-siwc-refresh-token', 'rt-dead');
  env.clock.advance(3600_000);
  await assert.rejects(env.auth.getAccessToken(), (e) => e.code === 'SIWC_LOGIN_REQUIRED');
  assert.equal(env.secrets.m.has('openai-siwc-refresh-token'), false);
  assert.equal((await env.auth.status()).signedIn, false);
  assert.equal((await env.auth.status()).clientId, 'client-abc', 'client_id는 유지');
});

test('logout: revocation_endpoint에 refresh token 폐기 요청 후 로컬 삭제', async () => {
  const env = setup();
  await (await login(env)).done;
  const r = await env.auth.logout();
  assert.equal(r.revoked, true);
  const rv = env.server.log.find((l) => l.url === 'https://auth.openai.com/oauth/revoke');
  assert.deepEqual(rv.form, { token: 'rt-1', token_type_hint: 'refresh_token', client_id: 'client-abc' });
  assert.equal(env.secrets.m.has('openai-siwc-refresh-token'), false);
  const st = await env.auth.status();
  assert.equal(st.signedIn, false);
  assert.equal(st.registered, true);
});

test('logout: 폐기 실패 시 안내 메시지', async () => {
  const env = setup({ revokeStatus: 503 });
  await (await login(env)).done;
  const r = await env.auth.logout();
  assert.equal(r.revoked, false);
  assert.match(r.message, /ChatGPT 설정/);
});
