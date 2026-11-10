// provider 레지스트리: src/providers/*.mjs를 동적으로 로드한다.
// 다른 담당자의 파일이 아직 없거나 로드에 실패해도 나머지는 동작한다.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROVIDERS_DIR = path.join(HERE, 'providers');

/** 표시 순서 */
export const PROVIDER_ORDER = ['claude-sdk', 'openai-siwc', 'codex-app-server', 'anthropic-api', 'openai-api'];

/**
 * @typedef {{
 *   id: string, label: string,
 *   detect(ctx: any): Promise<{available:boolean, reason?:string, models:Array<{id:string,label:string}>, authHint?:string}>,
 *   runTurn(p: any): Promise<{messages:any[]}>,
 * }} Provider
 */

function isProvider(p) {
  return p && typeof p.id === 'string' && typeof p.detect === 'function' && typeof p.runTurn === 'function';
}

/**
 * @param {{dir?: string}} [opts]
 * @returns {Promise<{providers: Map<string, Provider>, errors: Array<{file:string, error:string}>}>}
 */
export async function loadProviders({ dir = DEFAULT_PROVIDERS_DIR } = {}) {
  /** @type {Map<string, Provider>} */
  const providers = new Map();
  const errors = [];
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.mjs')).sort();
  } catch (err) {
    if (err?.code !== 'ENOENT') errors.push({ file: dir, error: String(err?.message ?? err) });
  }
  for (const file of files) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      const p = mod.default;
      if (!isProvider(p)) {
        errors.push({ file, error: 'default export가 provider 인터페이스(id, detect, runTurn)가 아님' });
        continue;
      }
      if (providers.has(p.id)) {
        errors.push({ file, error: `중복 provider id: ${p.id}` });
        continue;
      }
      providers.set(p.id, p);
    } catch (err) {
      errors.push({ file, error: String(err?.message ?? err) });
    }
  }
  for (const e of errors) process.emitWarning(`provider 로드 실패 ${e.file}: ${e.error}`, { code: 'DOOGLE_PROVIDER_LOAD' });
  return { providers: sortProviders(providers), errors };
}

/** @param {Map<string, Provider>} map */
export function sortProviders(map) {
  const rank = (id) => {
    const i = PROVIDER_ORDER.indexOf(id);
    return i < 0 ? PROVIDER_ORDER.length : i;
  };
  return new Map([...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])));
}
