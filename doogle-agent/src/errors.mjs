// provider 공용 에러 타입.

/**
 * provider가 던지는 에러. hub는 `emitted`가 아니면 `{kind:'error', code, message}`를 내보내고
 * turn_end(reason:'error')로 닫는다. provider가 이미 limit/error 이벤트를 emit했다면 emitted:true.
 */
export class ProviderError extends Error {
  /**
   * @param {string} code 예: CLAUDE_LOGIN_REQUIRED, API_KEY_MISSING, LIMIT, PROVIDER_ERROR
   * @param {string} message 사용자에게 보일 문구(한국어)
   * @param {{emitted?: boolean, cause?: unknown}} [opts]
   */
  constructor(code, message, { emitted = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.code = code;
    this.emitted = emitted;
  }
}
