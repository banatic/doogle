/**
 * 엔진 탈출구(apply_engine_edits / prepare_engine_edit_session)의 인자 검사.
 *
 * wasm-bindgen 메서드는 인자 개수·형이 틀리면 오류를 던지지 않고 메모리를 잘못 읽어 엔진이 죽는다
 * (예: 문자열 자리에 숫자 → "memory access out of bounds"). 모델은 시그니처를 모른 채 이름만 보고 부르기 쉬우므로
 * 부르기 전에 생성된 시그니처 표(engine-signatures.generated.ts)와 대조해 틀리면 고친 꼴을 알려 준다.
 */
import { ENGINE_METHOD_SIGNATURES } from './engine-signatures.generated.ts';

export { ENGINE_METHOD_SIGNATURES };

interface Param { name: string; type: string; optional: boolean }

function paramsOf(method: string): Param[] | null {
  const sig = ENGINE_METHOD_SIGNATURES[method];
  if (!sig) return null;
  return sig.p.map((entry) => {
    const at = entry.indexOf(':');
    const head = entry.slice(0, at);
    const optional = head.endsWith('?');
    return { name: optional ? head.slice(0, -1) : head, type: entry.slice(at + 1), optional };
  });
}

/** 모델에게 보일 한 줄 시그니처 — "insertText(section_idx: number, …) — 설명" */
export function engineSignatureText(method: string): string {
  const params = paramsOf(method);
  if (!params) return `${method}(…)`;
  const list = params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type === 'Uint8Array' ? '{$base64}' : p.type}`).join(', ');
  const doc = ENGINE_METHOD_SIGNATURES[method].doc;
  return `${method}(${list})${doc ? ` — ${doc}` : ''}`;
}

function typeOk(type: string, value: unknown): boolean {
  switch (type) {
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'Uint8Array':
      return value instanceof Uint8Array
        || (value !== null && typeof value === 'object' && typeof (value as { $base64?: unknown }).$base64 === 'string');
    case 'Uint32Array': return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v));
    default: return true; // any 등 — 엔진이 직접 검사한다
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}…` : value)}`;
  if (typeof value === 'object') return 'an object';
  return `the ${typeof value} ${String(value)}`;
}

/**
 * 인자가 시그니처와 맞는지 본다. 맞으면 null, 틀리면 모델이 읽고 고칠 수 있는 문장.
 * {$base64} 는 Uint8Array 자리로 본다(실행기가 부르기 직전에 바꾼다).
 */
export function checkEngineArgs(method: string, args: unknown[]): string | null {
  const params = paramsOf(method);
  if (!params) return `${method} has no known signature in this build — it cannot be called through the engine escape hatch`;
  const required = params.filter((p) => !p.optional).length;
  const signature = engineSignatureText(method);
  if (args.length < required || args.length > params.length) {
    const want = required === params.length ? `${required}` : `${required}..${params.length}`;
    return `${method} takes ${want} positional argument(s) but got ${args.length}. Signature: ${signature}`;
  }
  for (const [i, value] of args.entries()) {
    const p = params[i];
    if ((value === null || value === undefined) && p.optional) continue;
    if (!typeOk(p.type, value)) {
      return `${method} argument ${i} (${p.name}) must be ${p.type === 'Uint8Array' ? '{$base64:"…"}' : `a ${p.type}`} but got ${describe(value)}. Signature: ${signature}`;
    }
  }
  return null;
}
