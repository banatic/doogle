// ChatGPT 플랜 사용 (Sign in with ChatGPT) provider — Responses API 직접 호출.
//
// 문서 (2026-11-10 확인):
//  - 추론: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//    POST https://api.openai.com/v1/responses, Authorization: Bearer <ACCESS_TOKEN>, store:false, stream:true,
//    response.completed 수신 시에만 성공. 한도 오류는 스트림 시작 후 response.failed로도 올 수 있음.
//  - 모델 목록: GET https://api.openai.com/v1/models → {models:[{slug, display_name, visibility}]}, visibility=="list"만 사용.
//  - 제약: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
//    · system 메시지 항목 거부 → instructions 사용
//    · temperature, max_output_tokens, metadata, previous_response_id 등 미지원
//    · "Function and custom tools must be grouped in namespaces or supplied through additional_tools input items."
//      → 두글 tool은 {type:'namespace', name:'doogle', tools:[...function]} 으로 묶어 보낸다.
//  - 오류: https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
//
// ⚠ function calling 확인 상태: preview-limitations 페이지가 namespace로 묶은 function tool을 "Supported tools"로
//   명시하므로 문서상 지원된다. 다만 (1) namespace 안의 함수 호출 시 function_call 항목에 name이 어떻게 오는지
//   (name만 / "doogle.name" / namespace 필드), (2) store:false에서 function_call 재전송 형식은 문서 예시가 없어
//   실제 계정으로 검증하지 않았다(UNVERIFIED). 두 형태 모두 처리하도록 구현했다.

import { runResponsesTurn, providerError, DEFAULT_OPENAI_MODELS } from './openai-api.mjs';

const MODELS_URL = 'https://api.openai.com/v1/models';
const MODEL_CACHE_MS = 10 * 60_000;

async function loadAuth() {
  return (await import('../auth/siwc.mjs')).getSiwcAuth();
}

/**
 * @param {{auth?: any, fetch?: typeof fetch}} [deps]
 */
export function createOpenAISiwcProvider(deps = {}) {
  const authP = () => (deps.auth ? Promise.resolve(deps.auth) : loadAuth());
  const doFetch = deps.fetch || ((...a) => globalThis.fetch(...a));
  let modelCache = null; // {at, models}

  async function listModels(auth) {
    if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
    const token = await auth.getAccessToken();
    const res = await doFetch(MODELS_URL, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`models HTTP ${res.status}`);
    const body = await res.json();
    const models = (body.models || [])
      .filter((m) => m && m.visibility === 'list' && m.slug)
      .map((m) => ({ id: m.slug, label: m.display_name || m.slug })); // 서버 순서 유지(문서)
    if (models.length) modelCache = { at: Date.now(), models };
    return models;
  }

  const provider = {
    id: 'openai-siwc',
    label: 'ChatGPT (구독 로그인)',
    async detect() {
      let auth;
      try { auth = await authP(); } catch (e) {
        return { available: false, reason: `SIWC 모듈 오류: ${e?.message || e}`, models: DEFAULT_OPENAI_MODELS };
      }
      const st = await auth.status();
      if (!st.signedIn) {
        return {
          available: false,
          reason: 'ChatGPT에 로그인하지 않았습니다.',
          models: DEFAULT_OPENAI_MODELS,
          authHint: 'ChatGPT로 로그인 버튼을 눌러 브라우저에서 로그인하세요.',
        };
      }
      if (!st.planUsage) {
        return { available: false, reason: 'ChatGPT 플랜 사용 권한(chatgpt.tokens.use.direct)이 없습니다.', models: DEFAULT_OPENAI_MODELS, authHint: '다시 로그인해 권한을 허용하세요.' };
      }
      let models = DEFAULT_OPENAI_MODELS;
      try {
        const listed = await listModels(auth);
        if (listed.length) models = listed;
      } catch (e) {
        if (e?.code === 'SIWC_LOGIN_REQUIRED') {
          return { available: false, reason: e.message, models, authHint: 'ChatGPT로 다시 로그인하세요.' };
        }
        // 네트워크 실패 등은 기본 목록으로 계속
      }
      return { available: true, models };
    },
    async runTurn(turn) {
      const auth = await authP();
      let model = turn.model;
      if (!model) {
        try { model = (await listModels(auth))[0]?.id; } catch { model = undefined; }
        model ||= DEFAULT_OPENAI_MODELS[0].id;
      }
      const getToken = async ({ forceRefresh } = {}) => {
        try {
          if (forceRefresh) auth.invalidateAccessToken?.();
          return await auth.getAccessToken({ forceRefresh });
        } catch (e) {
          throw await providerError(e?.code === 'SIWC_LOGIN_REQUIRED' ? 'SIWC_LOGIN_REQUIRED' : 'SIWC_AUTH_ERROR', e?.message || String(e), { cause: e });
        }
      };
      return runResponsesTurn({
        getToken,
        authKind: 'siwc',
        namespaceTools: true,
        fetch: deps.fetch,
        turn: { ...turn, model },
      });
    },
    // hub/UI 용 보조 (CONTRACT §5 외 확장): 로그인 시작/상태/로그아웃
    async startLogin() { return (await authP()).startLogin(); },
    async authStatus() { return (await authP()).status(); },
    async logout() { modelCache = null; return (await authP()).logout(); },
  };
  return provider;
}

export default createOpenAISiwcProvider();
