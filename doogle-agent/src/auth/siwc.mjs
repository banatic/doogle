// Sign in with ChatGPT (SIWC) — "ChatGPT plan usage in open-source apps" 흐름.
//
// 근거 문서 (2026-11-10 확인):
//  - 개요:      https://developers.openai.com/siwc/token-sharing-open-source
//  - 로그인:    https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//  - 세션/갱신: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
//  - 토큰 필드: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
//  - 오류:      https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
//
// 저장 위치:
//  - 비밀(refresh token, id token): doogle-agent/src/secrets.mjs (OS keyring, service "doogle")
//  - 비밀이 아닌 기록(host id, 발급 client_id, sub, email, 부여 scope): appDataDir()/siwc.json (0600)
//  - access token(1시간)은 메모리에만 둔다. 재시작 후에는 refresh로 다시 받는다.
//
// 이 모듈은 Codex의 ~/.codex/auth.json 이나 Claude 자격증명을 절대 읽지 않는다 (CONTRACT §0).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

// --- 문서에 명시된 상수 (sign-in 페이지) ---------------------------------------------
export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
// revocation_endpoint / jwks_uri / issuer 는 discovery 문서에서 읽는다 (profiles-and-sessions 페이지).
export const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
/** 최초 등록용 client_id. token 교환/refresh에는 절대 쓰지 않는다(문서). */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/** 설치마다 동일하게 쓰는 앱 이름 (agent_name_hint). */
export const AGENT_NAME_HINT = 'doogle';
export const CALLBACK_PATH = '/auth/callback';
export const DEFAULT_ISSUER = 'https://auth.openai.com';

const SECRET_REFRESH = 'openai-siwc-refresh-token';
const SECRET_ID_TOKEN = 'openai-siwc-id-token';

// errors-and-recovery: 이 코드들은 refresh token을 더 쓸 수 없다는 뜻 → 토큰 삭제 후 재로그인.
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
]);

export class SiwcError extends Error {
  /** @param {string} code @param {string} message @param {{cause?: unknown}} [opts] */
  constructor(code, message, opts = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'SiwcError';
    this.code = code;
  }
}

// --- 작은 유틸 ----------------------------------------------------------------------
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const randomToken = (n = 32) => b64url(crypto.randomBytes(n));
export function pkcePair() {
  const verifier = randomToken(32); // 43자, RFC 7636 범위(43–128)
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
/** JWT payload를 서명 검증 없이 디코드 (access token의 scope 확인 등 보조용). */
export function decodeJwtPayload(jwt) {
  try {
    return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
const scopeSet = (s) => new Set(String(s || '').split(/\s+/).filter(Boolean));

async function defaultSecrets() {
  try {
    const m = await import('../secrets.mjs');
    return { get: m.getSecret, set: m.setSecret, delete: m.deleteSecret };
  } catch (e) {
    throw new SiwcError('SECRETS_UNAVAILABLE', '비밀 저장소(secrets.mjs)를 불러오지 못했습니다.', { cause: e });
  }
}
async function defaultStorePath() {
  try {
    const { appDataDir } = await import('../paths.mjs');
    return path.join(appDataDir(), 'siwc.json');
  } catch {
    const os = await import('node:os');
    return path.join(os.homedir(), '.doogle', 'siwc.json');
  }
}

/**
 * SIWC 인증 관리자 생성. 테스트에서는 fetch/secrets/storePath/now를 주입한다.
 * @param {{fetch?: typeof fetch, secrets?: {get(k:string):Promise<string|null>, set(k:string,v:string):Promise<void>, delete(k:string):Promise<boolean>}, storePath?: string, now?: () => number, callbackPort?: number, loginTimeoutMs?: number, skipIdTokenSignature?: boolean}} [opts]
 */
export function createSiwcAuth(opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const now = opts.now || (() => Date.now());
  const loginTimeoutMs = opts.loginTimeoutMs ?? 5 * 60_000;
  let secretsP = opts.secrets ? Promise.resolve(opts.secrets) : null;
  let storePathP = opts.storePath ? Promise.resolve(opts.storePath) : null;
  const secrets = () => (secretsP ||= defaultSecrets());
  const storePath = () => (storePathP ||= defaultStorePath());

  /** 메모리 access token: {token, expiresAt(ms), scope} */
  let access = null;
  /** 진행 중 refresh (같은 세션 refresh 직렬화 — 문서: rotating token 경쟁 방지) */
  let refreshing = null;
  let discovery = null;
  /** @type {{server: http.Server, cancel: (e?: Error)=>void} | null} */
  let pendingLogin = null;

  async function readRecord() {
    try {
      return JSON.parse(await fs.readFile(await storePath(), 'utf8'));
    } catch {
      return {};
    }
  }
  async function writeRecord(rec) {
    const file = await storePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file); // 원자적 교체 (sign-in 페이지 "Store credentials" 권고)
  }

  /** 호스트 ID: 최초 로그인 전에 만들어 영속화. urn:uuid 형식 (개요 페이지에서 허용). */
  async function ensureHostId() {
    const rec = await readRecord();
    if (rec.hostId) return rec;
    rec.hostId = `urn:uuid:${crypto.randomUUID()}`;
    await writeRecord(rec);
    return rec;
  }

  async function getDiscovery() {
    if (discovery) return discovery;
    const res = await doFetch(DISCOVERY_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new SiwcError('DISCOVERY_FAILED', `OpenID 설정을 가져오지 못했습니다 (HTTP ${res.status}).`);
    discovery = await res.json();
    return discovery;
  }

  /** ID token 검증: JWKS 서명(RS256), iss, aud=발급 client_id, exp, nonce (sign-in 페이지 Validation). */
  async function verifyIdToken(idToken, { clientId, nonce }) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰 형식이 올바르지 않습니다.');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const disc = await getDiscovery();
    if (!opts.skipIdTokenSignature) {
      if (header.alg !== 'RS256') throw new SiwcError('ID_TOKEN_INVALID', `지원하지 않는 ID 토큰 알고리즘: ${header.alg}`);
      const jwksRes = await doFetch(disc.jwks_uri, { headers: { accept: 'application/json' } });
      if (!jwksRes.ok) throw new SiwcError('ID_TOKEN_INVALID', 'JWKS를 가져오지 못했습니다.');
      const { keys = [] } = await jwksRes.json();
      const jwk = keys.find((k) => k.kid === header.kid) || (keys.length === 1 ? keys[0] : null);
      if (!jwk) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰 서명 키를 찾지 못했습니다.');
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
      if (!ok) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰 서명 검증 실패');
    }
    const issuer = disc.issuer || DEFAULT_ISSUER;
    if (claims.iss !== issuer) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰 발급자(iss) 불일치');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰 audience 불일치');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now() - 60_000) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰 만료');
    if (nonce != null && claims.nonce !== nonce) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰 nonce 불일치');
    if (!claims.sub) throw new SiwcError('ID_TOKEN_INVALID', 'ID 토큰에 sub가 없습니다.');
    return claims;
  }

  async function postForm(url, params) {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { res, body };
  }

  /** 토큰 응답의 scope (없으면 access token claim) 으로 부여 scope 확인. */
  function grantedScopes(tokenResp) {
    const s = tokenResp.scope || decodeJwtPayload(tokenResp.access_token)?.scope || '';
    return scopeSet(s);
  }

  function setAccess(tokenResp) {
    const expiresIn = Number(tokenResp.expires_in) || 3600;
    access = {
      token: tokenResp.access_token,
      expiresAt: now() + expiresIn * 1000,
      scope: [...grantedScopes(tokenResp)].join(' '),
      earliestRefreshAt: tokenResp.earliest_refresh_at ? Number(tokenResp.earliest_refresh_at) * 1000 : 0,
    };
  }

  /**
   * 로그인 시작. 루프백 리스너를 먼저 띄운 뒤 authUrl을 돌려준다(브라우저 열기는 호출자가).
   * @returns {Promise<{authUrl: string, redirectUri: string, waitForCompletion: () => Promise<{email?: string, sub: string, clientId: string, scopes: string[]}>, cancel: () => void}>}
   */
  async function startLogin() {
    if (pendingLogin) pendingLogin.cancel(new SiwcError('LOGIN_SUPERSEDED', '새 로그인 시도로 이전 시도가 취소되었습니다.'));
    const rec = await ensureHostId();
    const savedClientId = rec.clientId || null;
    const isRegistration = !savedClientId;
    const state = randomToken(24);
    const nonce = randomToken(24);
    const pkce = pkcePair();

    let resolveCb, rejectCb;
    const callbackP = new Promise((res, rej) => { resolveCb = res; rejectCb = rej; });
    callbackP.catch(() => {}); // 처리되지 않은 거부 경고 방지 (waitForCompletion에서 다시 await)

    const server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      if (u.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }
      const q = u.searchParams;
      const html = (msg) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>두글</title><body style="font-family:sans-serif;padding:2em">${msg}</body>`);
      };
      // 문서: state를 먼저 검증한다.
      if (q.get('state') !== state) { html('잘못된 로그인 응답입니다(state 불일치). 두글에서 다시 시도하세요.'); return; }
      if (q.get('error')) {
        html('로그인이 취소되었습니다. 이 창을 닫아도 됩니다.');
        rejectCb(new SiwcError(q.get('error') === 'access_denied' ? 'ACCESS_DENIED' : 'AUTHORIZE_ERROR',
          q.get('error') === 'access_denied' ? 'ChatGPT 로그인/동의가 거부되었습니다.' : `ChatGPT 로그인 오류: ${q.get('error')}`));
        return;
      }
      const code = q.get('code');
      if (!code) { html('인가 코드가 없습니다.'); rejectCb(new SiwcError('AUTHORIZE_ERROR', '인가 코드가 없습니다.')); return; }
      const cbClientId = q.get('client_id');
      let clientId;
      if (isRegistration) {
        // 최초 등록: callback이 발급 client_id를 준다. 없으면 등록 미완료로 처리(문서).
        if (!cbClientId || cbClientId === DYNAMIC_CLIENT_ID) {
          html('등록이 완료되지 않았습니다. 다시 시도하세요.');
          rejectCb(new SiwcError('REGISTRATION_INCOMPLETE', 'ChatGPT 앱 등록이 완료되지 않았습니다(client_id 없음).'));
          return;
        }
        clientId = cbClientId;
      } else {
        // 재인가: client_id가 없을 수 있음. 다른 값이 오면 거부(문서).
        if (cbClientId && cbClientId !== savedClientId) {
          html('예상하지 못한 client_id 입니다.');
          rejectCb(new SiwcError('CLIENT_MISMATCH', '재로그인 응답의 client_id가 저장된 값과 다릅니다.'));
          return;
        }
        clientId = savedClientId;
      }
      html('두글에 ChatGPT 로그인이 완료되었습니다. 이 창을 닫고 두글로 돌아가세요.');
      resolveCb({ code, clientId });
    });

    await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(opts.callbackPort ?? 0, '127.0.0.1', res); // localhost 금지, 127.0.0.1만 (문서)
    });
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    const p = new URLSearchParams({
      client_id: savedClientId || DYNAMIC_CLIENT_ID,
      ext_agent_host_id: rec.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
    if (isRegistration) p.set('agent_name_hint', AGENT_NAME_HINT); // 최초 등록에만
    // id_token_hint는 선택 사항이며 URL이 로그에 남을 위험이 있어 보내지 않는다(문서: redact 권고).
    const authUrl = `${AUTHORIZE_URL}?${p.toString()}`;

    let timer;
    const closeServer = () => { clearTimeout(timer); server.close(); server.closeAllConnections?.(); };
    const cancel = (err) => { rejectCb(err || new SiwcError('LOGIN_CANCELLED', '로그인이 취소되었습니다.')); };
    timer = setTimeout(() => cancel(new SiwcError('LOGIN_TIMEOUT', 'ChatGPT 로그인 대기 시간이 지났습니다.')), loginTimeoutMs);
    timer.unref?.();
    const handle = { server, cancel };
    pendingLogin = handle;

    let completion = null;
    async function complete() {
      try {
        const { code, clientId } = await callbackP;
        const { res, body } = await postForm(TOKEN_URL, {
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: pkce.verifier,
          redirect_uri: redirectUri,
          resource: RESOURCE,
        });
        if (!res.ok || !body?.access_token) {
          const err = body?.error || `http_${res.status}`;
          throw new SiwcError(err === 'invalid_grant' ? 'INVALID_GRANT' : 'TOKEN_EXCHANGE_FAILED',
            `ChatGPT 토큰 교환 실패: ${err}`);
        }
        const claims = await verifyIdToken(body.id_token, { clientId, nonce });
        const latest = await readRecord();
        // 두글은 단일 계정만 보관한다. 사용자가 직접 시작한 로그인이므로 다른 sub이면 기록 전체를 교체한다
        // (문서의 "returning account identity 확인"은 다중 계정 저장 시의 덮어쓰기 방지 목적).
        const accountChanged = !!(latest.sub && latest.sub !== claims.sub);
        const scopes = grantedScopes(body);
        if (!scopes.has(DIRECT_SCOPE)) {
          throw new SiwcError('SCOPE_NOT_GRANTED',
            'ChatGPT 플랜 사용 권한(chatgpt.tokens.use.direct)이 부여되지 않았습니다. 다시 로그인해 권한을 허용하세요.');
        }
        const s = await secrets();
        if (body.refresh_token) await s.set(SECRET_REFRESH, body.refresh_token);
        if (body.id_token) await s.set(SECRET_ID_TOKEN, body.id_token);
        await writeRecord({
          ...latest,
          hostId: latest.hostId || rec.hostId,
          clientId,
          sub: claims.sub,
          email: claims.email || null,
          scopes: [...scopes],
          signedIn: true,
          updatedAt: new Date(now()).toISOString(),
        });
        setAccess(body);
        return { sub: claims.sub, email: claims.email || undefined, clientId, scopes: [...scopes], accountChanged };
      } finally {
        closeServer();
        if (pendingLogin === handle) pendingLogin = null;
      }
    }
    return {
      authUrl,
      redirectUri,
      waitForCompletion: () => (completion ||= complete()),
      cancel: () => cancel(),
    };
  }

  async function doRefresh() {
    const rec = await readRecord();
    const s = await secrets();
    const refreshToken = await s.get(SECRET_REFRESH);
    if (!rec.clientId || !refreshToken) {
      throw new SiwcError('SIWC_LOGIN_REQUIRED', 'ChatGPT에 로그인해야 합니다.');
    }
    // profiles-and-sessions: grant_type=refresh_token, 발급 client_id, refresh_token, resource. scope 생략(기존 grant 유지).
    let res, body;
    try {
      ({ res, body } = await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: rec.clientId,
        refresh_token: refreshToken,
        resource: RESOURCE,
      }));
    } catch (e) {
      throw new SiwcError('NETWORK', 'ChatGPT 토큰 갱신 중 네트워크 오류', { cause: e });
    }
    if (!res.ok || !body?.access_token) {
      const err = body?.error || `http_${res.status}`;
      if (TERMINAL_REFRESH_ERRORS.has(err)) {
        await s.delete(SECRET_REFRESH);
        access = null;
        await writeRecord({ ...rec, signedIn: false });
        throw new SiwcError('SIWC_LOGIN_REQUIRED', 'ChatGPT 로그인이 만료되었습니다. 다시 로그인하세요.');
      }
      if (err === 'invalid_client') throw new SiwcError('INVALID_CLIENT', 'ChatGPT 클라이언트 설정 오류(invalid_client).');
      throw new SiwcError('REFRESH_FAILED', `ChatGPT 토큰 갱신 실패: ${err}`);
    }
    const scopes = grantedScopes(body);
    // 문서: refresh 후 access token, 만료, scope, 회전된 refresh token을 함께 교체.
    if (body.refresh_token) await s.set(SECRET_REFRESH, body.refresh_token);
    if (body.id_token) await s.set(SECRET_ID_TOKEN, body.id_token);
    await writeRecord({ ...rec, scopes: [...scopes], signedIn: true, updatedAt: new Date(now()).toISOString() });
    setAccess(body);
    if (!scopes.has(DIRECT_SCOPE)) {
      throw new SiwcError('SCOPE_NOT_GRANTED', 'ChatGPT 플랜 사용 권한(chatgpt.tokens.use.direct)이 없습니다. 다시 로그인하세요.');
    }
    return access.token;
  }

  /**
   * 유효한 access token 반환 (만료 60초 전이면 refresh).
   * @param {{forceRefresh?: boolean}} [o]
   */
  async function getAccessToken(o = {}) {
    const fresh = access && access.expiresAt - now() > 60_000;
    if (fresh && !o.forceRefresh) return access.token;
    if (o.forceRefresh && access && access.earliestRefreshAt > now() && access.expiresAt > now()) return access.token;
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** 로그아웃: refresh token 원격 폐기 시도 후 로컬 토큰 삭제. client_id/host id는 유지(문서). */
  async function logout() {
    const rec = await readRecord();
    const s = await secrets();
    const refreshToken = await s.get(SECRET_REFRESH);
    let revoked = false;
    if (refreshToken && rec.clientId) {
      try {
        const disc = await getDiscovery();
        if (disc.revocation_endpoint) {
          const { res } = await postForm(disc.revocation_endpoint, {
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: rec.clientId,
          });
          revoked = res.status === 200;
        }
      } catch {
        revoked = false;
      }
    }
    await s.delete(SECRET_REFRESH);
    await s.delete(SECRET_ID_TOKEN);
    access = null;
    await writeRecord({ ...rec, signedIn: false, updatedAt: new Date(now()).toISOString() });
    return {
      revoked,
      message: revoked ? undefined
        : '원격 세션 폐기를 확인하지 못했습니다. 필요하면 ChatGPT 설정에서 두글 연결을 해제하세요.',
    };
  }

  /** 로그인 상태(네트워크 호출 없음). */
  async function status() {
    const rec = await readRecord();
    let hasRefresh = false;
    try { hasRefresh = (await (await secrets()).get(SECRET_REFRESH)) != null; } catch { hasRefresh = false; }
    const scopes = rec.scopes || [];
    return {
      signedIn: !!(rec.signedIn && hasRefresh),
      email: rec.email || null,
      clientId: rec.clientId || null,
      registered: !!rec.clientId,
      scopes,
      planUsage: scopes.includes(DIRECT_SCOPE),
      accessTokenExpiresAt: access ? new Date(access.expiresAt).toISOString() : null,
    };
  }

  /** 401 수신 시 메모리 토큰 무효화 (다음 호출에서 refresh). */
  function invalidateAccessToken() { access = null; }

  return { startLogin, getAccessToken, logout, status, invalidateAccessToken, _verifyIdToken: verifyIdToken };
}

// --- 기본 싱글턴 (hub에서 사용) -----------------------------------------------------
let defaultAuth = null;
export function getSiwcAuth() { return (defaultAuth ||= createSiwcAuth()); }
/** 테스트용 교체 */
export function setSiwcAuth(a) { defaultAuth = a; }

export const startLogin = (...a) => getSiwcAuth().startLogin(...a);
export const getAccessToken = (...a) => getSiwcAuth().getAccessToken(...a);
export const logout = (...a) => getSiwcAuth().logout(...a);
export const status = (...a) => getSiwcAuth().status(...a);
