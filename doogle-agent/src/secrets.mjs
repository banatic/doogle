// 두글 비밀값 저장소 — OS keyring (@napi-rs/keyring), service "doogle".
// API key, SIWC refresh token 등 앱이 직접 발급받은 비밀만 저장한다.
// Claude/Codex CLI의 자격증명은 절대 읽거나 저장하지 않는다 (CONTRACT §0).

export const SECRET_SERVICE = 'doogle';

/** @typedef {{get(key:string):Promise<string|null>, set(key:string, value:string):Promise<void>, delete(key:string):Promise<boolean>}} SecretBackend */

/** @type {SecretBackend | null} */
let backend = null;

/** @returns {Promise<SecretBackend>} */
async function keyringBackend() {
  const { Entry } = await import('@napi-rs/keyring');
  const entry = (key) => new Entry(SECRET_SERVICE, key);
  return {
    async get(key) {
      try {
        const v = entry(key).getPassword();
        return v == null || v === '' ? null : v;
      } catch {
        return null; // 항목 없음 또는 keyring 사용 불가
      }
    },
    async set(key, value) {
      entry(key).setPassword(value);
    },
    async delete(key) {
      try {
        return entry(key).deletePassword() !== false;
      } catch {
        return false;
      }
    },
  };
}

/** 메모리 백엔드 (테스트, keyring 없는 환경). */
export function createMemorySecretBackend(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { return map.delete(key); },
  };
}

/** 백엔드 교체 (테스트용). null이면 기본 keyring으로 되돌린다. */
export function setSecretBackend(b) {
  backend = b;
}

async function getBackend() {
  if (!backend) {
    if (process.env.DOOGLE_SECRETS === 'memory') backend = createMemorySecretBackend();
    else backend = await keyringBackend();
  }
  return backend;
}

function checkKey(key) {
  if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) {
    throw new Error(`invalid secret key: ${key}`);
  }
}

/** @param {string} key @returns {Promise<string|null>} */
export async function getSecret(key) {
  checkKey(key);
  return (await getBackend()).get(key);
}

/** @param {string} key @param {string} value */
export async function setSecret(key, value) {
  checkKey(key);
  if (typeof value !== 'string' || value === '') throw new Error('secret value must be a non-empty string');
  await (await getBackend()).set(key, value);
}

/** @param {string} key @returns {Promise<boolean>} */
export async function deleteSecret(key) {
  checkKey(key);
  return (await getBackend()).delete(key);
}

/** @param {string} key */
export async function hasSecret(key) {
  return (await getSecret(key)) != null;
}

/** 알려진 비밀 키 이름 */
export const SECRET_KEYS = Object.freeze({
  ANTHROPIC_API_KEY: 'anthropic-api-key',
  OPENAI_API_KEY: 'openai-api-key',
});
