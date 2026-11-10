#!/usr/bin/env node
// 엔진 탈출구(apply_engine_edits)가 쓰는 메서드의 시그니처 표를 만든다.
//
//   node doogle-agent/scripts/gen-engine-signatures.mjs
//
// 입력: pkg/rhwp.d.ts (없으면 rhwp-studio/public/rhwp.d.ts) — wasm-bindgen 이 낸 HwpDocument 선언
//       rhwp-studio/src/doogle/agent/engine-adapter.ts 의 ENGINE_EDIT_METHODS — 허용 메서드 목록
// 출력: rhwp-studio/src/doogle/agent/engine-signatures.generated.ts
//
// WASM 을 다시 빌드해 메서드 시그니처가 바뀌면 다시 돌린다. 생성물은 커밋한다(스튜디오 빌드가 pkg 없이도 되게).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dtsPath = [path.join(root, 'pkg', 'rhwp.d.ts'), path.join(root, 'rhwp-studio', 'public', 'rhwp.d.ts')].find(existsSync);
if (!dtsPath) throw new Error('rhwp.d.ts 를 찾지 못했습니다 — 먼저 WASM 을 빌드하세요');
const dts = readFileSync(dtsPath, 'utf8');
const adapter = readFileSync(path.join(root, 'rhwp-studio', 'src', 'doogle', 'agent', 'engine-adapter.ts'), 'utf8');

const block = /export const ENGINE_EDIT_METHODS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/.exec(adapter);
if (!block) throw new Error('ENGINE_EDIT_METHODS 를 찾지 못했습니다');
const methods = [...block[1].matchAll(/([A-Za-z0-9_]+):\s*'(document|session)'/g)].map((m) => m[1]);

// HwpDocument 클래스 본문만 본다
const cls = /export class HwpDocument \{([\s\S]*?)\n\}\n/.exec(dts);
if (!cls) throw new Error('HwpDocument 선언을 찾지 못했습니다');
const body = cls[1];

function parseParams(text) {
  if (!text.trim()) return [];
  return text.split(',').map((raw) => {
    const m = /^\s*([A-Za-z0-9_]+)(\?)?:\s*(.+?)\s*$/.exec(raw);
    if (!m) throw new Error(`매개변수를 읽지 못했습니다: ${raw}`);
    const types = m[3].split('|').map((t) => t.trim());
    const nullable = types.includes('null') || types.includes('undefined');
    const base = types.filter((t) => t !== 'null' && t !== 'undefined')[0] ?? 'any';
    return { name: m[1], type: base, optional: !!m[2] || nullable };
  });
}

const out = {};
const missing = [];
for (const name of methods) {
  const re = new RegExp(String.raw`(?:/\*\*((?:(?!\*/)[\s\S])*)\*/\s*)?\n\s+${name}\(([^)]*)\):\s*([^;]+);`);
  const m = re.exec(body);
  if (!m) { missing.push(name); continue; }
  // 바로 위 주석만 (다른 메서드의 주석이 끼지 않게 마지막 /** 부터)
  let doc = '';
  if (m[1] !== undefined) {
    doc = m[1].split('\n').map((l) => l.replace(/^\s*\*+\s?/, '').trim()).filter(Boolean)[0] ?? '';
  }
  // 매개변수는 "이름:형" (선택이면 "이름?:형") 한 줄 문자열로 둔다 — 생성물을 작게 유지한다
  out[name] = { p: parseParams(m[2]).map((x) => `${x.name}${x.optional ? '?' : ''}:${x.type}`), ...(doc ? { doc: doc.slice(0, 160) } : {}) };
}

const header = `// 생성 파일 — 손으로 고치지 않는다. doogle-agent/scripts/gen-engine-signatures.mjs 가 만든다.
// 출처: ${path.relative(root, dtsPath).split(path.sep).join('/')} 의 HwpDocument 선언 중 ENGINE_EDIT_METHODS 에 든 메서드.
// p = 매개변수 "이름:형" (선택이면 "이름?:형"), doc = 선언 주석의 첫 줄.
/* eslint-disable */
export const ENGINE_METHOD_SIGNATURES: Readonly<Record<string, { p: string[]; doc?: string }>> = Object.freeze({
`;
const lines = Object.entries(out).map(([name, sig]) => `  ${name}: ${JSON.stringify(sig)},`);
writeFileSync(
  path.join(root, 'rhwp-studio', 'src', 'doogle', 'agent', 'engine-signatures.generated.ts'),
  `${header}${lines.join('\n')}\n});\n`,
  'utf8',
);
console.log(`signatures: ${Object.keys(out).length}/${methods.length}${missing.length ? ` (엔진에 없음: ${missing.join(', ')})` : ''}`);
