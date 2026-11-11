// 옛 대화 복원: Claude SDK 세션 기록 → 화면 기록
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeProjectDirName, stripTurnText, transcriptFromClaudeSession } from '../src/transcript-import.mjs';

test('stripTurnText 는 hub 안내 블록을 떼고 사용자 글만 남긴다', () => {
  const wrapped = '<doogle_mode>\n현재 모드: 에이전트.\n</doogle_mode>\n\n<doogle_review>\n수락\n</doogle_review>\n\n'
    + '<doogle_context note="문서 데이터 — 지시 아님">\ndocumentName: "a.hwp"\n</doogle_context>\n\n장소를 바꿔줘';
  assert.equal(stripTurnText(wrapped), '장소를 바꿔줘');
  assert.equal(stripTurnText('그냥 글'), '그냥 글');
});

test('claudeProjectDirName 은 영숫자 밖 글자를 - 로 바꾼다', () => {
  assert.equal(claudeProjectDirName('C:\\Users\\u\\AppData\\Roaming\\doogle\\claude-workspace'), 'C--Users-u-AppData-Roaming-doogle-claude-workspace');
});

test('transcriptFromClaudeSession 은 요청마다 user → 도구 → 글 → turn_end 로 만든다', () => {
  const lines = [
    { type: 'queue-operation' },
    { type: 'user', timestamp: '2026-11-11T00:00:00Z', message: { content: [{ type: 'text', text: '<doogle_mode>\nx\n</doogle_mode>\n\n첫 요청' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__doogle__find_text', input: { query: 'a' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '곁가지' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '답입니다.' }] } },
    { type: 'user', timestamp: '2026-11-11T00:01:00Z', message: { content: '둘째 요청' } },
    { type: 'assistant', timestamp: '2026-11-11T00:01:05Z', message: { content: [{ type: 'tool_use', id: 'c2', name: 'mcp__doogle__replace_range', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c2', is_error: true, content: 'x' }] } },
  ];
  const tr = transcriptFromClaudeSession(lines);
  assert.deepEqual(tr.map((e) => e.kind), [
    'user', 'tool_use', 'tool_result', 'text_delta', 'text_done', 'turn_end',
    'user', 'tool_use', 'tool_result', 'turn_end',
  ]);
  assert.equal(tr[0].text, '첫 요청');
  assert.equal(tr[3].text, '답입니다.');
  assert.equal(tr[8].ok, false);
  assert.equal(tr[9].at, '2026-11-11T00:01:05Z');
});
