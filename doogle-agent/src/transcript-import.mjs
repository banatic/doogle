// 화면 기록(transcript)이 없는 옛 대화를 Claude SDK 세션 기록에서 다시 만든다.
//
// transcript 저장을 넣기 전의 대화 파일에는 `histories['claude-sdk'] = [{type:'claude-sdk-session', sessionId}]`
// 만 있다. Claude SDK 는 세션을 `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd를 -로 바꾼 이름>/<sessionId>.jsonl`
// 에 남기므로, 거기서 사용자 글·답변·도구 호출을 읽어 화면 기록 모양으로 바꾼다.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compactForTranscript } from './threads.mjs';

const SESSION_MARKER = 'claude-sdk-session';

/** Claude SDK 가 프로젝트 폴더 이름을 만드는 방식: 영숫자 밖의 글자는 모두 '-' */
export function claudeProjectDirName(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeSessionFile(sessionId, cwd, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  return path.join(configDir, 'projects', claudeProjectDirName(cwd), `${sessionId}.jsonl`);
}

/** hub 가 사용자 글 앞에 붙인 안내 블록(<doogle_mode>·<doogle_review>·<doogle_context>·<doogle_attachments>)을 떼어 낸다 */
export function stripTurnText(text) {
  let rest = String(text ?? '');
  for (;;) {
    const m = /^\s*<doogle_(mode|review|context|attachments)\b[^>]*>[\s\S]*?<\/doogle_\1>\s*/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  return rest.trim();
}

/**
 * 옛 대화가 어느 문서의 것이었나 — hub 가 사용자 글 앞에 붙인 <doogle_context> 의 documentName.
 * 마지막으로 보낸 요청의 이름을 쓴다(다른 이름으로 저장했으면 새 이름).
 * @param {any[]} lines
 */
export function docNameFromClaudeSession(lines) {
  let name = '';
  for (const line of lines) {
    if (!line || line.isSidechain || line.type !== 'user') continue;
    const content = line.message?.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text) : [];
    for (const text of texts) {
      const m = /<doogle_context\b[^>]*>[\s\S]*?documentName:\s*("(?:[^"\\]|\\.)*")[\s\S]*?<\/doogle_context>/.exec(String(text ?? ''));
      if (!m) continue;
      try { name = String(JSON.parse(m[1])); } catch { /* 깨진 값은 건너뛴다 */ }
    }
  }
  return name;
}

function sessionIdOf(thread) {
  const list = thread?.histories?.['claude-sdk'];
  if (!Array.isArray(list)) return null;
  const marker = list.find((m) => m?.type === SESSION_MARKER && typeof m.sessionId === 'string');
  return marker?.sessionId ?? null;
}

/**
 * Claude SDK 세션 기록(JSONL 줄들) → 화면 기록.
 * @param {any[]} lines
 * @returns {any[]}
 */
export function transcriptFromClaudeSession(lines) {
  const out = [];
  let open = false;
  let lastAt = null;
  const close = () => {
    if (open) out.push({ kind: 'turn_end', reason: 'done', ...(lastAt ? { at: lastAt } : {}) });
    open = false;
  };
  for (const line of lines) {
    if (!line || line.isSidechain || (line.type !== 'user' && line.type !== 'assistant')) continue;
    const content = line.message?.content;
    const at = typeof line.timestamp === 'string' ? line.timestamp : null;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (line.type === 'user') {
      for (const b of blocks) {
        if (b?.type === 'tool_result' && open) {
          out.push({ kind: 'tool_result', callId: String(b.tool_use_id ?? ''), ok: !b.is_error });
        } else if (b?.type === 'text') {
          const text = stripTurnText(b.text);
          if (!text || text.startsWith('[Request interrupted')) continue;
          close();
          out.push({ kind: 'user', text, providerId: 'claude-sdk', ...(at ? { at } : {}) });
          open = true;
        }
      }
    } else if (open) {
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) {
          out.push({ kind: 'text_delta', text: String(b.text) }, { kind: 'text_done' });
        } else if (b?.type === 'tool_use') {
          out.push({ kind: 'tool_use', callId: String(b.id ?? ''), name: String(b.name ?? ''), args: compactForTranscript(b.input ?? {}) });
        }
      }
    }
    if (at) lastAt = at;
  }
  close();
  return out;
}

/**
 * 옛 대화의 화면 기록을 SDK 세션 기록에서 만든다. 만들 수 없으면 null.
 * @param {any} thread
 * @param {string} cwd claude-sdk provider 가 쓰는 작업 폴더 (<dataDir>/claude-workspace)
 */
export async function backfillFromClaudeSession(thread, cwd) {
  const sessionId = sessionIdOf(thread);
  if (!sessionId || !/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return null;
  let raw;
  try {
    raw = await fs.readFile(claudeSessionFile(sessionId, cwd), 'utf8');
  } catch {
    return null;
  }
  const lines = [];
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue;
    try { lines.push(JSON.parse(text)); } catch { /* 깨진 줄은 건너뛴다 */ }
  }
  const transcript = transcriptFromClaudeSession(lines);
  if (!transcript.some((e) => e.kind === 'user')) return null;
  // 옛 대화는 문서 경로를 남기지 않았다 — 이름으로만 문서에 붙는다
  const name = docNameFromClaudeSession(lines);
  return { transcript, doc: name ? { key: '', name } : null };
}
