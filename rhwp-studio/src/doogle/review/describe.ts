/**
 * 검토 행 문구 — 변경 한 건(PendingChangeSet)을 위치 이름("2문단", "표", "쪽 설정")과
 * 지운 글/넣은 글 또는 짧은 요약으로 바꾼다. DOM 없는 순수 함수.
 */
import type { PendingChangeSet, PendingChangeTarget } from '../agent/types.ts';
import { bareToolName, describeToolCall } from '../ui/tool-presentation.ts';

export interface ChangeView {
  location: string;
  /** del/ins 가 있으면 인라인 diff, 없으면 summary */
  del: string;
  ins: string;
  summary: string;
}

type Args = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function flat(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function rec(value: unknown): Args {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Args : {};
}

function anchorFind(a: Args): string {
  if (typeof a['find'] === 'string') return a['find'];
  if (typeof a['anchor'] === 'string') return a['anchor'];
  return str(rec(a['anchor'])['text']);
}

export function locationOf(tool: string, target: PendingChangeTarget | undefined, count = 1): string {
  if (!target) return '';
  const sec = target.sectionIdx > 0 ? `${target.sectionIdx + 1}구역 ` : '';
  if (target.wholeSection) {
    if (tool === 'set_page_layout') return '쪽 설정';
    if (tool === 'edit_header_footer') return '머리말';
    return `${sec}구역`.trim();
  }
  if (target.table) return `${sec}표`;
  if (target.cell) return `${sec}표 칸`;
  const base = `${sec}${target.paraIdx + 1}문단`;
  return count > 1 ? `${base} 외` : base;
}

function textDiff(tool: string, a: Args): { del: string; ins: string } | null {
  switch (tool) {
    case 'replace_range': return { del: anchorFind(a), ins: str(a['text']) };
    case 'insert_text': return { del: '', ins: str(a['text']) };
    case 'delete_range': {
      const find = anchorFind(a);
      return find ? { del: find, ins: '' } : null;
    }
    case 'replace_all': return { del: str(a['query']), ins: str(a['replacement']) };
    case 'set_field_value': return { del: '', ins: str(a['value']) };
    default: return null;
  }
}

export function describeChange(change: PendingChangeSet): ChangeView {
  const tool = bareToolName(change.tool);
  const args = change.args ?? {};
  const targets = change.targets ?? [];
  const paras = new Set(targets.map((t) => `${t.sectionIdx}:${t.paraIdx}:${t.cell?.cellIdx ?? ''}`));
  const location = locationOf(tool, targets[0], paras.size) || '변경';

  if (tool === 'apply_edits' && Array.isArray(args['edits'])) {
    const edits = args['edits'].map(rec);
    const first = edits[0] ?? {};
    const diff = textDiff(str(first['tool']), first);
    const more = edits.length > 1 ? ` 외 ${edits.length - 1}곳` : '';
    if (diff && (diff.del || diff.ins)) {
      return { location, del: flat(diff.del), ins: flat(diff.ins), summary: more.trim() };
    }
    const view = describeToolCall(str(first['tool']), first);
    return { location, del: '', ins: '', summary: `${view.label}${view.summary ? ` · ${view.summary}` : ''}${more}` };
  }

  const diff = textDiff(tool, args);
  if (diff && (diff.del || diff.ins)) {
    const summary = tool === 'replace_all' ? '모두 바꾸기' : tool === 'set_field_value' ? `필드 ${str(args['name'])}` : '';
    return { location, del: flat(diff.del), ins: flat(diff.ins), summary };
  }
  const view = describeToolCall(tool, args);
  return { location, del: '', ins: '', summary: view.summary ? `${view.label} · ${view.summary}` : view.label };
}
