// studio 그림 결과({mimeType, base64})가 모든 provider 에서 텍스트가 아닌 그림 블록으로 나가는지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toCallToolResult } from '../src/providers/claude-sdk.mjs';
import { toToolResult } from '../src/providers/anthropic-api.mjs';
import { functionCallOutput } from '../src/providers/openai-api.mjs';

const big = 'A'.repeat(100_000);
const r = { ok: true, result: { revision: 7, renderRegions: [{ pageIndex: 1 }], image: { mimeType: 'image/png', base64: big } } };

test('studio PngImage(base64) becomes an image block, never JSON text', () => {
  const sdk = toCallToolResult(r);
  assert.equal(sdk.content[0].type, 'image');
  assert.equal(sdk.content[0].data, big);
  assert.ok(!sdk.content[1].text.includes(big));

  const api = toToolResult('t1', r);
  assert.equal(api.content[0].type, 'image');
  assert.ok(!api.content[1].text.includes(big));

  const oa = functionCallOutput(r);
  assert.ok(Array.isArray(oa));
  assert.equal(oa[1].type, 'input_image');
  assert.ok(!oa[0].text.includes(big));
  assert.equal(typeof functionCallOutput({ ok: true, result: { a: 1 } }), 'string');
});
