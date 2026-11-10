/**
 * 상태 표시줄 보강 — upstream #status-bar 를 그대로 두고(쪽·구역·삽입/수정·배율은 upstream 이 갱신)
 * 시안 F 의 칸을 덧붙인다: 단, 줄/칸, 변경 추적 · N건.
 *
 * - 단·줄/칸은 플러그인 host 의 캐럿 + 읽기 전용 문서 조회로 계산한다. host 가 붙기 전에는 숨긴다.
 *   '줄'은 캐럿 문단 안의 줄 번호, '칸'은 그 줄 안의 글자 위치(1부터)다.
 * - 변경 추적 건수는 사이드바(agent S)가 보내는 `doogle:pending-count` 창 이벤트를 받는다.
 */
import type { PluginHost } from '@/plugin/types';

export const PENDING_COUNT_EVENT = 'doogle:pending-count';

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

window.addEventListener(PENDING_COUNT_EVENT, (e) => {
  const detail = (e as CustomEvent<{ count?: unknown }>).detail;
  setPendingCount(Number(detail?.count ?? 0));
});

interface LineInfo { lineIndex: number; lineCount: number; charStart: number; charEnd: number }

export class StatusAddons {
  private readonly col: HTMLElement;
  private readonly line: HTMLElement;
  private readonly track: HTMLButtonElement;
  private host: PluginHost | null = null;
  private queued = false;

  constructor(bar: HTMLElement, onTrackClick: () => void) {
    this.col = document.createElement('span');
    this.col.className = 'stb-item dg-sb-col';
    this.col.hidden = true;

    this.line = document.createElement('span');
    this.line.className = 'stb-item dg-sb-line';
    this.line.hidden = true;

    this.track = document.createElement('button');
    this.track.type = 'button';
    this.track.className = 'stb-item dg-sb-track';
    this.track.hidden = true;
    this.track.title = '에이전트 변경 검토';
    this.track.addEventListener('click', onTrackClick);

    const page = bar.querySelector('#sb-page');
    page?.after(this.col, this.line);
    const mode = bar.querySelector('#sb-mode');
    (mode ?? page)?.after(this.track);

    pendingListeners.add((n) => this.renderTrack(n));
    this.renderTrack(pendingCount);
  }

  attach(host: PluginHost): void {
    this.host = host;
    for (const name of ['cursor-rect-updated', 'cursor-para-changed', 'cursor-format-changed', 'document-changed', 'cursor-cell-changed']) {
      host.events.on(name, () => this.queue());
    }
    host.onDocumentSwap(() => this.queue());
    this.queue();
  }

  private renderTrack(n: number): void {
    this.track.hidden = n <= 0;
    this.track.textContent = `변경 추적 · ${n}건`;
    this.track.setAttribute('aria-label', `검토할 에이전트 변경 ${n}건, 사이드바 열기`);
  }

  queue(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.update(); });
  }

  private update(): void {
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
