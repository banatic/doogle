// src/tools/index.mjs(담당 B) 로더. 모듈이 아직 없거나 로드에 실패해도 hub는 뜬다(빈 tool 목록).

/**
 * @typedef {{name:string, description:string, kind:'read'|'write'|'control'|'hub', shape:Record<string, any>, validate?:(args:any)=>any}} ToolDef
 * @typedef {{
 *   TOOL_RULES: string,
 *   TOOLS: ToolDef[],
 *   getTool(name:string): ToolDef|undefined,
 *   validateArgs(name:string, args:any): {ok:true, args:any}|{ok:false, error:{code:string, message:string}},
 *   toJsonSchema(name:string): object,
 *   toolsForProvider(kind:string): any[],
 *   prepareInsertImageArgs?: (args:any, roots?:string[]) => Promise<any>,
 *   toToolContent?: (result:any) => any[],
 *   HUMAN_WAIT_TOOL_NAMES?: readonly string[],
 *   stub: boolean,
 *   loadError?: string,
 * }} ToolsModule
 */

/** @type {Promise<ToolsModule> | null} */
let cached = null;

/** @returns {ToolsModule} */
export function stubTools(loadError) {
  return {
    TOOL_RULES: '',
    TOOLS: [],
    getTool: () => undefined,
    validateArgs: (name, args) => ({ ok: true, args }),
    toJsonSchema: () => ({ type: 'object', properties: {} }),
    toolsForProvider: () => [],
    stub: true,
    ...(loadError ? { loadError } : {}),
  };
}

/** @param {any} m @returns {ToolsModule} */
function normalize(m) {
  const TOOLS = Array.isArray(m.TOOLS) ? m.TOOLS : [];
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  return {
    TOOL_RULES: typeof m.TOOL_RULES === 'string' ? m.TOOL_RULES : '',
    TOOLS,
    getTool: typeof m.getTool === 'function' ? m.getTool : (name) => byName.get(name),
    validateArgs: typeof m.validateArgs === 'function' ? m.validateArgs : (name, args) => ({ ok: true, args }),
    toJsonSchema: typeof m.toJsonSchema === 'function' ? m.toJsonSchema : () => ({ type: 'object', properties: {} }),
    toolsForProvider: typeof m.toolsForProvider === 'function' ? m.toolsForProvider : () => [],
    ...(typeof m.prepareInsertImageArgs === 'function' ? { prepareInsertImageArgs: m.prepareInsertImageArgs } : {}),
    ...(typeof m.toToolContent === 'function' ? { toToolContent: m.toToolContent } : {}),
    ...(Array.isArray(m.HUMAN_WAIT_TOOL_NAMES) ? { HUMAN_WAIT_TOOL_NAMES: m.HUMAN_WAIT_TOOL_NAMES } : {}),
    stub: false,
  };
}

/**
 * @param {{reload?: boolean}} [opts]
 * @returns {Promise<ToolsModule>}
 */
export function loadTools({ reload = false } = {}) {
  if (!cached || reload) {
    cached = import('./tools/index.mjs').then(normalize, (err) => {
      const msg = err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('tools')
        ? 'src/tools/index.mjs 없음 — tool 없이 실행합니다'
        : `src/tools/index.mjs 로드 실패: ${err?.message ?? err}`;
      process.emitWarning(msg, { code: 'DOOGLE_TOOLS_STUB' });
      return stubTools(msg);
    });
  }
  return cached;
}
