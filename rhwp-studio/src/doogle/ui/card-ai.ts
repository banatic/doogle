/**
 * 카드 편집 화면의 AI — 말·파일로 카드 초안을 받는다.
 *
 * 흐름: 편집 화면이 `card-draft-…` 대화로 chat_send(purpose 'card-draft')를 보낸다 → hub 는 문서 tool 을 막고
 * propose_card 만 연다 → 에이전트가 propose_card 를 부르면 hub 가 `card_proposal` 로 초안을 보낸다 →
 * 이 파일이 초안을 편집 화면에 맞게 다듬어(가린 값 되살리기, 파일·기존 줄 채우기) 돌려준다. 저장은 사람이 한다.
 *
 * 모델에 가는 것 (docs: 카드 기능 LLM 데이터 범위):
 *  - 사용자가 적은 말, 지금 초안(민감 값은 가려서, 표는 앞 3줄만).
 *  - 파일은 표의 머리 줄 + 앞 3줄만(tablePreview). 나머지 줄은 에이전트가 정한 열 짝대로 여기서 채운다.
 */
import type { AgentEvent, CardDraft, CardProposal, HubClient } from '../hub-client.ts';
import { readAttachment } from '../attach/attach-read.ts';
import { extractTable, mapRows, tablePreview } from '../attach/card-table.ts';
import type { CardAi } from './card-editor.ts';

/** hub cards.mjs maskValue 와 같은 규칙 — 숫자가 4개 이상이면 끝 4자리, 아니면 첫 글자만 */
export function maskValue(value: string): string {
  const s = String(value ?? '');
  if (!s.trim()) return s;
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits >= 4) {
    let keep = 4;
    let out = '';
    for (let i = s.length - 1; i >= 0; i--) {
      const ch = s[i];
      if (/\d/.test(ch)) {
        out = (keep > 0 ? ch : '*') + out;
        keep--;
      } else out = ch + out;
    }
    return out;
  }
  const chars = [...s.trim()];
  return chars.length <= 1 ? '*' : chars[0] + '*'.repeat(chars.length - 1);
}

/** 모델에 보낼 초안 — 민감 값은 가리고, 표는 앞 3줄과 줄 수만 */
export function draftForModel(draft: CardDraft): Record<string, unknown> {
  const sensitive = new Set(draft.fields.filter((f) => f.sensitive).map((f) => f.key));
  const base = { name: draft.name, icon: draft.icon, kind: draft.kind, fields: draft.fields };
  if (draft.kind === 'item') {
    const values = Object.fromEntries(draft.fields.map((f) => {
      const v = draft.values?.[f.key] ?? '';
      return [f.key, sensitive.has(f.key) ? maskValue(v) : v];
    }));
    return { ...base, values };
  }
  const rows = draft.rows ?? [];
  return {
    ...base,
    totalRows: rows.length,
    firstRows: rows.slice(0, 3).map((r) => r.map((v, i) => (sensitive.has(draft.fields[i]?.key) ? maskValue(v) : v))),
  };
}

/**
 * 받은 초안을 화면 초안으로 — 가린 값은 원래 값으로, 표의 줄은 파일(source)이나 지금 초안에서 항목 이름으로 옮긴다.
 * table: 파일에서 꺼낸 표 (파일을 보냈을 때만)
 */
export function mergeProposal(proposal: Pick<CardProposal, 'card' | 'source'>, current: CardDraft | null, table: string[][] | null): CardDraft {
  const card = proposal.card;
  const fields = card.fields.map((f) => ({ key: f.key, desc: f.desc ?? '', sensitive: !!f.sensitive }));
  const next: CardDraft = { name: card.name, icon: card.icon ?? 'card', kind: card.kind, fields };
  const oldValue = (key: string): string | undefined => {
    if (!current) return undefined;
    if (current.kind === 'item') return current.values?.[key];
    const at = current.fields.findIndex((f) => f.key === key);
    return at >= 0 ? current.rows?.[0]?.[at] : undefined;
  };
  if (card.kind === 'item') {
    next.values = Object.fromEntries(fields.map((f) => {
      const proposed = card.values?.[f.key] ?? '';
      const old = oldValue(f.key);
      // 모델은 가린 값만 보았다 — 가린 모양 그대로 돌아왔으면 원래 값을 지킨다
      const keep = old !== undefined && proposed.includes('*') && maskValue(old) === proposed;
      return [f.key, keep ? old : proposed];
    }));
    return next;
  }
  if (proposal.source && table) {
    next.rows = mapRows(table, proposal.source.dataStart, proposal.source.columns);
    return next;
  }
  if (current?.kind === 'table' && (current.rows?.length ?? 0) > 0) {
    // 지금 초안의 줄을 항목 이름으로 옮긴다 (새 항목은 빈칸)
    const from = fields.map((f) => current.fields.findIndex((g) => g.key === f.key));
    next.rows = (current.rows ?? []).map((r) => from.map((i) => (i >= 0 ? r[i] ?? '' : '')));
    return next;
  }
  if (current?.kind === 'item' && current.values) {
    const one = fields.map((f) => current.values?.[f.key] ?? '');
    next.rows = one.some((v) => v.trim()) ? [one] : [];
    if ((card.rows?.length ?? 0) > 0) next.rows = card.rows!.map((r) => fields.map((_, i) => r[i] ?? ''));
    return next;
  }
  next.rows = (card.rows ?? []).map((r) => fields.map((_, i) => r[i] ?? ''));
  return next;
}

export function createCardAi(opts: {
  hub: HubClient;
  /** 지금 고른 모델 (사이드바와 같은 것) */
  provider(): { id: string; available: boolean; label: string; model: string } | null;
}): CardAi {
  /** 편집 화면을 여는 동안 이어지는 대화 — 닫으면 지운다 */
  let threadId: string | null = null;

  const newThreadId = () => `card-draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    readiness() {
      if (opts.hub.state !== 'open') return { ok: false, reason: '에이전트 서비스에 연결되면 AI 로 만들 수 있습니다. 지금은 직접 입력하세요.' };
      const p = opts.provider();
      if (!p || !p.available) return { ok: false, reason: '사이드바에서 AI 계정을 연결하고 모델을 고르면 AI 로 만들 수 있습니다.' };
      return { ok: true };
    },

    end() {
      const id = threadId;
      threadId = null;
      if (id) void opts.hub.deleteThread(id).catch(() => { /* 응답 중이면 남는다 — 문서 목록에는 보이지 않는다 */ });
    },

    async run({ instruction, draft, file, signal }, onNote) {
      const provider = opts.provider();
      if (!provider?.available) throw new Error('AI 계정이 연결되어 있지 않습니다');
      let table: string[][] | null = null;
      const parts: string[] = [`사용자 요청: ${instruction || '(파일로 카드를 만들어 주세요)'}`];
      if (draft) parts.push(`지금 초안 (가린 값은 * 로 보입니다):\n${JSON.stringify(draftForModel(draft))}`);
      if (file) {
        onNote(`${file.name} 을(를) 읽는 중…`, 'quiet');
        const payload = await readAttachment(file);
        table = extractTable(payload.text ?? '');
        if (table.length === 0) throw new Error(`${file.name} 에서 표를 찾지 못했습니다. 표가 있는 엑셀·한글·CSV 파일을 골라 주세요.`);
        parts.push(`파일 ${JSON.stringify(file.name)} 의 표 앞부분 (머리 줄 + 앞 3줄만 보냅니다):\n${tablePreview(table, 4)}`);
      }
      if (signal.aborted) throw new Error('그만두었습니다');

      threadId ??= newThreadId();
      const id = threadId;
      let proposal: CardProposal | null = null;
      let failure = '';
      const done = new Promise<void>((resolve) => {
        const offs: Array<() => void> = [];
        const finish = () => {
          for (const off of offs) off();
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => { opts.hub.cancelChat(id); };
        signal.addEventListener('abort', onAbort, { once: true });
        offs.push(opts.hub.on('card_proposal', (message) => {
          const m = message as unknown as CardProposal;
          if (m.threadId === id && m.card) proposal = m;
        }));
        offs.push(opts.hub.on('agent_event', (message) => {
          const { threadId: t, event } = message as { threadId?: string; event?: AgentEvent };
          if (t !== id || !event) return;
          if (event.kind === 'text_delta' && typeof event.text === 'string') onNote(event.text);
          else if (event.kind === 'error') failure = typeof event.message === 'string' ? event.message : '오류가 났습니다';
          else if (event.kind === 'turn_end') finish();
        }));
        offs.push(opts.hub.onState((state) => {
          if (state !== 'open') { failure = '에이전트 서비스 연결이 끊겼습니다'; finish(); }
        }));
      });
      const sent = opts.hub.sendChat({
        threadId: id,
        providerId: provider.id,
        ...(provider.model ? { model: provider.model } : {}),
        text: parts.join('\n\n'),
        mode: 'agent',
        purpose: 'card-draft',
      });
      if (!sent) throw new Error('에이전트 서비스에 연결되어 있지 않습니다');
      await done;
      if (signal.aborted) throw new Error('그만두었습니다');
      if (failure && !proposal) throw new Error(failure);
      const got = proposal as CardProposal | null;
      return got ? mergeProposal(got, draft, table) : null;
    },
  };
}
