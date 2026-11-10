// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-agent/tools.mjs, rhwp/rhwp-agent/mcp-stdio.mjs
// Copyright (c) banatic, Hataewook/Rauhwpx, Edward Kim/rhwp — MIT License.
//
// 두글 tool 정의 모듈 — CONTRACT §4 의 공개 API. 순수 모듈(프로세스/네트워크 부수효과 없음).
//   TOOL_RULES, TOOLS, BATCHABLE_EDIT_TOOL_NAMES, BATCHABLE_READ_TOOL_NAMES,
//   getTool, toJsonSchema, validateArgs, toolsForProvider
// 추가 export: toToolContent(MCP content 변환), toolAnnotations, prepareInsertImageArgs,
//   HUMAN_WAIT_TOOL_NAMES, TOOL_NAMES.
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z, assertCellArgsPlacement, documentIdArgError, invalidArgs } from './params.mjs';
import { TOOLS, BATCHABLE_EDIT_TOOL_NAMES, BATCHABLE_READ_TOOL_NAMES } from './definitions.mjs';

export { TOOL_RULES } from './rules.mjs';
export { TOOLS, BATCHABLE_EDIT_TOOL_NAMES, BATCHABLE_READ_TOOL_NAMES } from './definitions.mjs';
export { prepareInsertImageArgs, imageDetails } from './insert-image.mjs';
export { documentIdArgError, assertCellArgsPlacement, TABLE_PROPS_KEYS, CELL_PROPS_KEYS } from './params.mjs';

/** tool 이름 목록 (정의 순서). */
export const TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));

/** 사용자 응답을 기다리는 tool — 호출 타임아웃을 두지 않는다 (사람이 답할 때까지). */
export const HUMAN_WAIT_TOOL_NAMES = Object.freeze(['ask_user_question', 'request_permission']);

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** @param {string} name */
export function getTool(name) {
  return TOOLS_BY_NAME.get(name);
}

// ─── zod 스키마 (strict) ───

const BATCH_ITEM_TOP_LEVEL_KEYS = ['expectedRevision', 'render'];

/** @type {Map<string, any>} */
const schemaCache = new Map();

function objectSchema(tool, { batchItem = false } = {}) {
  const key = `${tool.name}${batchItem ? '#item' : ''}`;
  let schema = schemaCache.get(key);
  if (!schema) {
    const shape = { ...tool.shape };
    if (batchItem) for (const k of BATCH_ITEM_TOP_LEVEL_KEYS) delete shape[k];
    schema = z.object(shape).strict();
    schemaCache.set(key, schema);
  }
  return schema;
}

function formatIssues(tool, error, validKeys) {
  return error.issues.map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join('.') : '';
    if (issue.code === 'unrecognized_keys') {
      if (!at) return `unknown argument ${issue.keys.join('/')} — valid arguments: ${validKeys.join(', ') || '(none)'}`;
      return `${at}: ${issue.message}`;
    }
    if (issue.code === 'invalid_type' && issue.received === 'undefined') return `${at || '(root)'}: required`;
    return `${at || '(root)'}: ${issue.message}`;
  }).join('; ');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 최상위 null 값은 "없음"으로 본다 — 일부 모델이 선택 인자를 null 로 채운다. */
function dropNulls(args) {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
}

/** 한 tool 인자를 검증해 파싱된 인자를 돌려준다. 실패하면 INVALID_ARGS 를 던진다. */
function parseToolArgs(tool, rawArgs, { batchItem = false } = {}) {
  if (rawArgs === undefined || rawArgs === null) rawArgs = {};
  if (!plainObject(rawArgs)) throw invalidArgs(`${tool.name} arguments must be an object`);
  const args = dropNulls(rawArgs);
  const docError = documentIdArgError(tool, args);
  if (docError) throw invalidArgs(docError);
  if (batchItem) {
    const misplaced = BATCH_ITEM_TOP_LEVEL_KEYS.filter((k) => Object.hasOwn(args, k));
    if (misplaced.length > 0) {
      throw invalidArgs(`${misplaced.join('/')} belongs on the apply_edits call itself, not on each item`);
    }
  }
  assertCellArgsPlacement(tool.name, args);
  const schema = objectSchema(tool, { batchItem });
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw invalidArgs(`${tool.name}: ${formatIssues(tool, parsed.error, Object.keys(schema.shape))}`);
  }
  const value = parsed.data;
  tool.validate?.(value);
  return value;
}

function itemError(err) {
  return err?.code === 'INVALID_ARGS' ? err.message : `unexpected validation error: ${err?.message ?? err}`;
}

/** apply_edits 항목 — 평평한 {tool, …인자} 로 정규화하고 항목별 tool 스키마로 검증한다. 실패 항목은 전부 모아 보고. */
function parseEditItems(edits) {
  const errors = [];
  const out = edits.map((item, index) => {
    const { tool: toolName, args: legacyArgs, ...flat } = item;
    // 옛 {tool, args:{…}} 꼴도 받는다 — 평평한 꼴로 푼다.
    const itemArgs = plainObject(legacyArgs) && Object.keys(flat).length === 0 ? legacyArgs
      : legacyArgs === undefined ? flat : { ...flat, args: legacyArgs };
    try {
      return { tool: toolName, ...parseToolArgs(getTool(toolName), itemArgs, { batchItem: true }) };
    } catch (err) {
      errors.push(`edits[${index}] (${toolName}): ${itemError(err)}`);
      return null;
    }
  });
  if (errors.length > 0) {
    throw invalidArgs(`apply_edits: ${errors.length} item(s) invalid — nothing was applied; fix them all and resend. ${errors.join(' | ')}`);
  }
  return out;
}

/** read_batch 항목 — {tool, args} 로 정규화하고 항목별 읽기 tool 스키마로 검증한다. */
function parseReadItems(reads) {
  const errors = [];
  const out = reads.map((item, index) => {
    const { tool: toolName, args, ...flat } = item;
    const itemArgs = args === undefined ? flat : (Object.keys(flat).length === 0 ? args : { ...flat, ...(plainObject(args) ? args : {}) });
    try {
      return { tool: toolName, args: parseToolArgs(getTool(toolName), itemArgs) };
    } catch (err) {
      errors.push(`reads[${index}] (${toolName}): ${itemError(err)}`);
      return null;
    }
  });
  if (errors.length > 0) {
    throw invalidArgs(`read_batch: ${errors.length} item(s) invalid. ${errors.join(' | ')}`);
  }
  return out;
}

/**
 * tool 인자 검증 — zod strict 파싱 + rhwp-x 검증 훅(validateAnchorTool/validateParas/…) +
 * documentId 거절 + 셀 주소 위치 안내. apply_edits/read_batch 는 항목도 각 tool 스키마로 검증한다.
 * @param {string} name
 * @param {unknown} args
 * @returns {{ok: true, args: Record<string, any>} | {ok: false, error: {code: 'INVALID_ARGS', message: string}}}
 */
export function validateArgs(name, args) {
  const tool = getTool(name);
  if (!tool) {
    return { ok: false, error: { code: 'INVALID_ARGS', message: `unknown tool "${name}" — not a 두글 document tool` } };
  }
  try {
    const parsed = parseToolArgs(tool, args);
    if (name === 'apply_edits') parsed.edits = parseEditItems(parsed.edits);
    if (name === 'read_batch') parsed.reads = parseReadItems(parsed.reads);
    return { ok: true, args: parsed };
  } catch (err) {
    return { ok: false, error: { code: 'INVALID_ARGS', message: itemError(err) } };
  }
}

// ─── JSON Schema ───

/** @type {Map<string, object>} */
const jsonSchemaCache = new Map();

function assertPlainJsonSchema(name, schema) {
  const serialized = JSON.stringify(schema);
  if (JSON.stringify(JSON.parse(serialized)) !== serialized) throw new Error(`${name}: JSON schema is not plain JSON`);
  const walk = (node, at) => {
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${at}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' || key === 'definitions' || key === '$defs') throw new Error(`${name}: JSON schema has ${key} at ${at}`);
      walk(value, `${at}.${key}`);
    }
  };
  walk(schema, '$');
  if (schema.type !== 'object') throw new Error(`${name}: JSON schema root must be an object`);
}

/**
 * tool 입력의 JSON Schema (draft-07, $ref 없음, 순수 JSON). 호출마다 새 사본을 돌려준다.
 * @param {string} name
 */
export function toJsonSchema(name) {
  let schema = jsonSchemaCache.get(name);
  if (!schema) {
    const tool = getTool(name);
    if (!tool) throw new Error(`unknown tool "${name}"`);
    schema = zodToJsonSchema(objectSchema(tool), {
      target: 'jsonSchema7',
      $refStrategy: 'none',
      strictUnions: true,
      pipeStrategy: 'input',
      effectStrategy: 'input',
    });
    schema.$schema = 'http://json-schema.org/draft-07/schema#';
    if (!schema.properties) schema.properties = {};
    assertPlainJsonSchema(name, schema);
    jsonSchemaCache.set(name, schema);
  }
  return structuredClone(schema);
}

/** provider 에 넘길 스키마 — $schema 키는 뺀다 (일부 API 가 거절한다). */
function providerSchema(name) {
  const { $schema: _omit, ...schema } = toJsonSchema(name);
  return schema;
}

/**
 * MCP tool annotations. 문서 쓰기는 undo/스테이징 검토로 보호되므로 destructive 로 표시하지 않는다
 * (그렇게 표시하면 Codex 안전 모드가 문서 편집 tool 을 거절한다 — rhwp-x toolAnnotations).
 * @param {{kind: string, label?: string}} tool
 */
export function toolAnnotations(tool) {
  return {
    ...(tool.label ? { title: tool.label } : {}),
    readOnlyHint: tool.kind === 'read',
    destructiveHint: false,
    openWorldHint: false,
  };
}

/**
 * provider 별 tool 목록.
 *  - 'anthropic'        → {name, description, input_schema}
 *  - 'openai-responses' → {type:'function', name, description, parameters, strict:false}
 *  - 'mcp'              → {name, description, inputSchema, annotations}
 *  - 'codex-dynamic'    → {name, description, inputSchema}
 * @param {'anthropic'|'openai-responses'|'mcp'|'codex-dynamic'} kind
 * @param {{filter?: (tool: typeof TOOLS[number]) => boolean}} [options]
 */
export function toolsForProvider(kind, { filter } = {}) {
  const tools = filter ? TOOLS.filter(filter) : TOOLS;
  switch (kind) {
    case 'anthropic':
      return tools.map((t) => ({ name: t.name, description: t.description, input_schema: providerSchema(t.name) }));
    case 'openai-responses':
      return tools.map((t) => ({
        type: 'function', name: t.name, description: t.description, parameters: providerSchema(t.name), strict: false,
      }));
    case 'mcp':
      return tools.map((t) => ({
        name: t.name, description: t.description, inputSchema: providerSchema(t.name), annotations: toolAnnotations(t),
      }));
    case 'codex-dynamic':
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: providerSchema(t.name) }));
    default:
      throw new Error(`unknown provider tool format "${kind}"`);
  }
}

// ─── 결과 → MCP content ───

function imageOf(result) {
  const image = plainObject(result) ? result.image : null;
  if (!plainObject(image) || typeof image.mimeType !== 'string') return null;
  const data = typeof image.base64 === 'string' ? image.base64 : typeof image.data === 'string' ? image.data : null;
  return data ? { data, mimeType: image.mimeType } : null;
}

/**
 * 결과에서 그림을 떼어 낸다. studio 의 PngImage 는 `{mimeType, base64}` 이고 일부 경로는 `{data}` 를 쓴다 —
 * 모든 provider 가 이 함수로 판별해야 그림이 base64 텍스트(수십만 자)로 모델에 들어가지 않는다.
 * @param {unknown} result
 * @returns {{ image: {data: string, mimeType: string} | null, rest: unknown }}
 */
export function splitToolImage(result) {
  const image = imageOf(result);
  if (!image) return { image: null, rest: result };
  const { image: _omit, ...rest } = /** @type {Record<string, unknown>} */ (result);
  return { image, rest };
}

/**
 * studio 결과를 MCP content 블록으로 변환한다. result.image 가 {mimeType, base64}(또는 data) 모양이면
 * image 블록을 먼저 두고 나머지 필드는 text(JSON) 블록에 담는다 (render_page png, render:"crop",
 * verify_changes includeImage).
 * @param {unknown} result
 */
export function toToolContent(result) {
  const image = imageOf(result);
  if (image) {
    const { image: _omit, ...rest } = /** @type {Record<string, unknown>} */ (result);
    return [
      { type: 'image', data: image.data, mimeType: image.mimeType },
      { type: 'text', text: JSON.stringify(rest) },
    ];
  }
  return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }];
}
