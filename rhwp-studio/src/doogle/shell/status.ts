/**
 * 상태 표시줄 보강 — upstream #status-bar 를 그대로 두고(쪽·구역·삽입/수정·배율은 upstream 이 갱신)
 * 세 구역으로 다시 묶는다(UI_AUDIT 3.7).
 *
 *   왼쪽 = 위치    : 쪽 · 줄/칸 · 단 · 구역 (· 셀 · 필드)
 *   가운데 = 메시지 : upstream #sb-message
 *   오른쪽 = 상태  : 업데이트 진행 · 에이전트 ● + 변경 N건 · 글자 수 · 삽입/수정 · 배율
 *
 * - 단·줄/칸·글자 수는 플러그인 host 의 캐럿 + 읽기 전용 문서 조회로 계산한다. host 가 붙기 전에는 숨긴다.
 * - 변경 건수는 `doogle:pending-count {detail:{count}}`(review/state.ts 가 쏜다).
 * - 에이전트 서비스 연결 상태는 `doogle:hub-state`(index.ts) 또는 `doogle:agent-state` {detail:{state, detail?}}
 *   (HubClient 상태 그대로) 를 받는다.
 *   아무도 보내지 않으면 데스크탑의 `doogle://hub` 이벤트로 대신 짐작한다.
 * - 하나의 aria-live 영역이 변경 건수·연결 상태·저장 완료를 읽어 준다(사이드바 announce 와 출처를 나눈다).
 */
import type { PluginHost } from '@/plugin/types';
import { isDesk, onHubEvent } from '../ui/desk-bridge';
import { onDocState, type DocState } from './doc-state';

export const PENDING_COUNT_EVENT = 'doogle:pending-count';
export const AGENT_STATE_EVENT = 'doogle:agent-state';

let pendingCount = 0;
const pendingListeners = new Set<(n: number) => void>();

/** 검토 대기 중인 에이전트 변경 건수(마지막으로 받은 값). */
export function getPendingCount(): number {
  return pendingCount;
}

export function setPendingCount(count: number): void {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === pendingCount) return;
  pendingCount = n;
  for (const fn of pendingListeners) fn(n);
}

export function onPendingCount(cb: (n: number) => void): () => void {
  pendingListeners.add(cb);
  return () => pendingListeners.delete(cb);
}

window.addEventListener(PENDING_COUNT_EVENT, (e) => {
  const detail = (e as CustomEvent<{ count?: unknown }>).detail;
  setPendingCount(Number(detail?.count ?? 0));
});

// ── 에이전트 연결 ─────────────────────────────────────────
/** HubClient 의 상태 이름 + 데스크탑 hub 실패 */
export type AgentConnState = 'open' | 'connecting' | 'retrying' | 'unavailable' | 'stopped' | 'failed';
type Tone = 'ok' | 'warn' | 'bad';

let agentState: AgentConnState | null = null;
let agentDetail = '';
let agentFromClient = false;
const agentListeners = new Set<() => void>();

export function getAgentState(): { state: AgentConnState | null; detail: string } {
  return { state: agentState, detail: agentDetail };
}

/** 에이전트 서비스 연결 상태를 알린다(window 이벤트 `doogle:agent-state` 와 같다). */
export function setAgentState(state: AgentConnState, detail = ''): void {
  if (state === agentState && detail === agentDetail) return;
  agentState = state;
  agentDetail = detail;
  for (const fn of agentListeners) fn();
}

/** index.ts 가 HubClient 상태를 그대로 싣는 이벤트 */
export const HUB_STATE_EVENT = 'doogle:hub-state';

const onClientState = (e: Event) => {
  const d = (e as CustomEvent<{ state?: unknown; detail?: unknown }>).detail;
  if (typeof d?.state !== 'string') return;
  agentFromClient = true;
  const raw = d.state;
  // 'ready'·'restarting' 같은 다른 이름도 받아 준다
  const state: AgentConnState = raw === 'ready' ? 'open' : raw === 'restarting' ? 'retrying' : raw as AgentConnState;
  setAgentState(state, typeof d.detail === 'string' ? d.detail : '');
};
window.addEventListener(AGENT_STATE_EVENT, onClientState);
window.addEventListener(HUB_STATE_EVENT, onClientState);

if (isDesk()) {
  void onHubEvent((event) => {
    if (agentFromClient || !event) return; // 사이드바 쪽 연결 상태가 더 정확하다
    if (event.state === 'ready') setAgentState('connecting');
    else if (event.state === 'exited') setAgentState('retrying', '에이전트 서비스가 멈춰 다시 시작합니다');
    else if (event.state === 'failed') setAgentState('failed', event.message);
  }).catch(() => {});
}

function agentTone(s: AgentConnState): Tone {
  if (s === 'open') return 'ok';
  if (s === 'connecting' || s === 'retrying') return 'warn';
  return 'bad';
}

function agentText(s: AgentConnState): string {
  switch (s) {
    case 'open': return '연결됨';
    case 'connecting': return '연결 중';
    case 'retrying': return '다시 연결 중';
    case 'failed': return '시작하지 못함';
    default: return '연결 안 됨';
  }
}

// ── 업데이트 진행 ─────────────────────────────────────────
export interface UpdateProgressView { text: string; fraction: number | null }
let updateView: UpdateProgressView | null = null;
const updateListeners = new Set<() => void>();

/** 업데이트 진행(내려받기·설치)을 상태 표시줄에 띄운다. null 이면 지운다. updater.ts 가 부른다. */
export function setUpdateProgress(view: UpdateProgressView | null): void {
  updateView = view;
  for (const fn of updateListeners) fn();
}

// ── 라이브 영역 ──────────────────────────────────────────
let liveEl: HTMLElement | null = null;
/** 상태 표시줄의 aria-live 로 읽어 준다(중복 낭독을 막으려고 같은 글은 한 번만). */
export function announceStatus(text: string): void {
  if (!liveEl) return;
  liveEl.textContent = '';
  window.setTimeout(() => { if (liveEl) liveEl.textContent = text; }, 30);
}

interface LineInfo { lineIndex: number; lineCount: number; charStart: number; charEnd: number }

const nf = new Intl.NumberFormat('ko-KR');

function zoneSep(order: number): HTMLElement {
  const s = document.createElement('span');
  s.className = 'dg-sb-zone';
  s.setAttribute('aria-hidden', 'true');
  s.style.order = String(order);
  return s;
}

export class StatusAddons {
  private readonly col: HTMLElement;
  private readonly line: HTMLElement;
  private readonly agent: HTMLButtonElement;
  private readonly chars: HTMLElement;
  private readonly update: HTMLElement;
  private host: PluginHost | null = null;
  private queued = false;
  private charTimer: number | undefined;
  private docChars: number | null = null;
  private docCharsStale = true;

  constructor(bar: HTMLElement, onAgentClick: () => void) {
    this.col = document.createElement('span');
    this.col.className = 'stb-item dg-sb-col';
    this.col.hidden = true;

    this.line = document.createElement('span');
    this.line.className = 'stb-item dg-sb-line';
    this.line.hidden = true;

    this.agent = document.createElement('button');
    this.agent.type = 'button';
    this.agent.className = 'stb-item dg-sb-agent';
    this.agent.hidden = true;
    this.agent.addEventListener('click', onAgentClick);

    this.chars = document.createElement('span');
    this.chars.className = 'stb-item dg-sb-chars';
    this.chars.hidden = true;

    this.update = document.createElement('span');
    this.update.className = 'stb-item dg-sb-update';
    this.update.hidden = true;
    this.update.setAttribute('role', 'status');

    liveEl = document.createElement('span');
    liveEl.className = 'dg-visually-hidden';
    liveEl.setAttribute('aria-live', 'polite');

    bar.append(this.col, this.line, zoneSep(20), zoneSep(40), this.update, this.agent, this.chars, liveEl);

    pendingListeners.add((n) => {
      this.renderAgent();
      if (n > 0) announceStatus(`검토 대기 중인 변경 ${n}건`);
    });
    agentListeners.add(() => {
      this.renderAgent();
      if (agentState) announceStatus(`에이전트 서비스 ${agentText(agentState)}`);
    });
    updateListeners.add(() => this.renderUpdate());
    let lastSaved: number | null = null;
    onDocState((s: DocState) => {
      if (s.savedAt && s.savedAt !== lastSaved) {
        lastSaved = s.savedAt;
        announceStatus('저장했습니다');
      }
    });
    this.renderAgent();
  }

  attach(host: PluginHost): void {
    this.host = host;
    for (const name of ['cursor-rect-updated', 'cursor-para-changed', 'cursor-format-changed', 'cursor-cell-changed', 'selection-changed']) {
      host.events.on(name, () => this.queue());
    }
    host.events.on('document-changed', () => { this.docCharsStale = true; this.queue(); });
    host.onDocumentSwap(() => { this.docCharsStale = true; this.queue(); });
    // 선택 변화는 이벤트가 없는 경로(마우스 끌기)도 있어 포인터·키를 뗄 때도 본다.
    document.addEventListener('pointerup', () => this.queue(), true);
    document.addEventListener('keyup', () => this.queue(), true);
    this.queue();
  }

  private renderAgent(): void {
    const n = pendingCount;
    const s = agentState;
    this.agent.hidden = !s && n <= 0;
    this.agent.replaceChildren();
    if (s) {
      const dot = document.createElement('span');
      dot.className = `dg-sb-dot dg-sb-dot--${agentTone(s)}`;
      dot.setAttribute('aria-hidden', 'true');
      this.agent.append(dot);
    }
    const parts = ['에이전트 서비스'];
    if (s && s !== 'open') parts.push(agentText(s));
    if (n > 0) parts.push(`변경 ${nf.format(n)}건`);
    this.agent.append(parts.join(' · '));
    this.agent.classList.toggle('dg-sb-agent--pending', n > 0);
    const label = [`에이전트 서비스 ${s ? agentText(s) : ''}`.trim(), n > 0 ? `검토할 변경 ${n}건` : ''].filter(Boolean).join(', ');
    this.agent.setAttribute('aria-label', `${label}. 사이드바 열기`);
    this.agent.title = agentDetail ? `${agentDetail}\n누르면 사이드바를 엽니다` : '누르면 사이드바를 엽니다';
  }

  private renderUpdate(): void {
    const v = updateView;
    this.update.hidden = !v;
    this.update.replaceChildren();
    if (!v) return;
    const label = document.createElement('span');
    label.textContent = v.text;
    const bar = document.createElement('progress');
    bar.className = 'dg-sb-progress';
    bar.max = 1;
    if (v.fraction !== null) bar.value = v.fraction;
    bar.setAttribute('aria-hidden', 'true');
    this.update.append(label, bar);
  }

  queue(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.updatePosition(); this.queueChars(); });
  }

  /** 글자 수 — 300ms 디바운스(긴 문서에서 타자마다 세지 않게). */
  private queueChars(): void {
    window.clearTimeout(this.charTimer);
    this.charTimer = window.setTimeout(() => this.updateChars(), 300);
  }

  private updateChars(): void {
    const host = this.host;
    if (!host || !host.getCaret()) {
      this.chars.hidden = true;
      return;
    }
    const sel = host.getSelectionText();
    if (sel?.text) {
      const n = Array.from(sel.text.replace(/\r?\n/g, '')).length;
      this.chars.textContent = `선택 ${nf.format(n)}${sel.truncated ? '+' : ''}자`;
      this.chars.hidden = false;
      return;
    }
    if (this.docCharsStale) {
      this.docChars = this.countDocument(host);
      this.docCharsStale = false;
    }
    this.chars.hidden = this.docChars === null;
    if (this.docChars !== null) this.chars.textContent = `${nf.format(this.docChars)}자`;
  }

  /** 본문 문단 글자 수의 합(표·글상자 안 글자는 세지 않는다). */
  private countDocument(host: PluginHost): number | null {
    try {
      return host.read((doc) => {
        const d = doc as unknown as {
          getSectionCount(): number;
          getParagraphCount(s: number): number;
          getParagraphLength(s: number, p: number): number;
        };
        let total = 0;
        const sections = d.getSectionCount();
        for (let s = 0; s < sections; s++) {
          const paras = d.getParagraphCount(s);
          for (let p = 0; p < paras; p++) total += d.getParagraphLength(s, p);
        }
        return total;
      });
    } catch {
      return null;
    }
  }

  private updatePosition(): void {
    const host = this.host;
    const caret = host?.getCaret();
    if (!host || !caret) {
      this.line.hidden = true;
      this.col.hidden = !this.col.textContent;
      return;
    }
    try {
      const { cols, info } = host.read((doc) => {
        const anyDoc = doc as unknown as {
          getColumnDef?: (sec: number) => string;
          getLineInfo: (s: number, p: number, o: number) => string;
          getLineInfoInCell: (s: number, pp: number, ci: number, cell: number, cp: number, o: number) => string;
        };
        let cols = 1;
        try {
          if (anyDoc.getColumnDef) cols = JSON.parse(anyDoc.getColumnDef(caret.sectionIndex)).columnCount || 1;
        } catch { /* 단 정보가 없으면 1단 */ }
        let info: LineInfo | null = null;
        if (caret.cellPath.length === 0) {
          info = JSON.parse(anyDoc.getLineInfo(caret.sectionIndex, caret.parentParaIndex, caret.charOffset));
        } else if (caret.cellPath.length === 1) {
          const c = caret.cellPath[0];
          info = JSON.parse(anyDoc.getLineInfoInCell(
            caret.sectionIndex, caret.parentParaIndex, c.controlIndex, c.cellIndex, c.cellParaIndex, caret.charOffset,
          ));
        }
        return { cols, info };
      });
      this.col.textContent = `${cols}단`;
      this.col.hidden = false;
      if (info) {
        this.line.textContent = `줄 ${info.lineIndex + 1} 칸 ${Math.max(1, caret.charOffset - info.charStart + 1)}`;
        this.line.hidden = false;
      } else {
        this.line.hidden = true;
      }
    } catch {
      this.line.hidden = true;
    }
  }
}
