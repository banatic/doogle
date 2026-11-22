/**
 * 문서 갈래 그림 — 요청마다 남긴 지점(agent/checkpoints.ts)을 git log --graph 처럼 그린다.
 *
 *  - 한 지점의 첫 자식은 부모와 같은 줄(갈래)을 잇고, 둘째 자식부터 새 갈래를 연다.
 *  - 줄 순서는 git log --topo-order 처럼: 자식이 늘 부모 위, 한 갈래의 지점은 이어서. 갈래 끝에만 이름표.
 *  - 지금 문서가 있는 지점(head)은 채운 점 + 옅은 고리, 되돌아갈 수 없는 지점은 점선 고리.
 *  - head 뒤로 직접 고친 것이 있으면 맨 위에 "지금 문서" 가짜 줄을 점선으로 잇는다(git 의 작업 트리).
 *  - 줄을 누르면 그 지점으로 되돌아간다.
 */
import type { CheckpointNode } from '../agent/types.ts';
import { icon } from './icons.ts';

export interface BranchRow {
  node: CheckpointNode;
  lane: number;
  /** 0 이 맨 위(가장 최근) */
  row: number;
}

/** 갈래 이름 — 0 은 본줄기, 그 뒤는 갈래 2, 3 … */
export function branchName(lane: number): string {
  return lane === 0 ? '본줄기' : `갈래 ${lane + 1}`;
}

/** 지점마다 갈래(lane)를 매긴다. 만든 순서대로 — 부모의 첫 자식은 부모 갈래, 그 밖은 새 갈래 */
export function layoutBranches(nodes: readonly CheckpointNode[]): { rows: BranchRow[]; lanes: number } {
  const ordered = [...nodes].sort((a, b) => a.createdAt - b.createdAt || seqOf(a.id) - seqOf(b.id));
  const laneOf = new Map<string, number>();
  const taken = new Set<string>();
  let next = 0;
  for (const node of ordered) {
    const parent = node.parentId;
    if (parent && laneOf.has(parent) && !taken.has(parent)) {
      laneOf.set(node.id, laneOf.get(parent)!);
      taken.add(parent);
    } else {
      if (parent) taken.add(parent);
      laneOf.set(node.id, next++);
    }
  }
  // 줄 순서는 git log --topo-order 처럼 — 자식이 늘 부모보다 위, 그리고 한 갈래의 지점은 끊기지 않고 이어서.
  // (만든 시각 순으로만 놓으면 갈래를 오가며 요청할 때 두 갈래의 줄이 번갈아 끼어 엉켜 보인다)
  const children = new Map<string, number>();
  for (const n of ordered) if (n.parentId) children.set(n.parentId, (children.get(n.parentId) ?? 0) + 1);
  const left = new Map(children);
  const done = new Set<string>();
  const top: CheckpointNode[] = [];
  let lane: number | null = null;
  while (top.length < ordered.length) {
    let pick: CheckpointNode | null = null;
    // 아직 자식이 다 위에 놓이지 않은 지점은 고를 수 없다. 지금 갈래를 이어 가는 것을 먼저, 없으면 가장 최근 것
    for (let i = ordered.length - 1; i >= 0; i--) {
      const n = ordered[i];
      if (done.has(n.id) || (left.get(n.id) ?? 0) > 0) continue;
      if (laneOf.get(n.id) === lane) { pick = n; break; }
      pick ??= n;
    }
    if (!pick) break; // 고리(있을 수 없음) — 남은 것은 아래에서 시각 순으로
    done.add(pick.id);
    top.push(pick);
    lane = laneOf.get(pick.id) ?? 0;
    if (pick.parentId) left.set(pick.parentId, (left.get(pick.parentId) ?? 1) - 1);
  }
  for (const n of [...ordered].reverse()) if (!done.has(n.id)) top.push(n);
  const rows = top.map((node, row) => ({ node, lane: laneOf.get(node.id) ?? 0, row }));
  return { rows, lanes: Math.max(1, next) };
}

function seqOf(id: string): number {
  const n = Number(id.replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** 지점이 속한 갈래 (지점 목록에서 다시 매긴다) */
export function laneOfNode(nodes: readonly CheckpointNode[], id: string): number {
  return layoutBranches(nodes).rows.find((r) => r.node.id === id)?.lane ?? 0;
}

/** 지점 번호 — 사람에게 보이는 짧은 이름 ("지점 3") */
export function checkpointNumber(nodes: readonly CheckpointNode[], id: string): number {
  const ordered = [...nodes].sort((a, b) => a.createdAt - b.createdAt || seqOf(a.id) - seqOf(b.id));
  return ordered.findIndex((n) => n.id === id) + 1;
}

const ROW = 46;
const LANE = 18;
const PAD = 16;
const SVG_NS = 'http://www.w3.org/2000/svg';

function laneX(lane: number): number {
  return PAD + lane * LANE;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function when(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface BranchPanelHost {
  nodes(): CheckpointNode[];
  head(): string | null;
  dirty(): boolean;
  checkout(id: string): void;
  busy(): boolean;
}

/** 머리의 "문서 갈래" 단추가 여는 떠 있는 판 */
export class BranchPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly host: BranchPanelHost;
  private focusId: string | null = null;

  constructor(host: BranchPanelHost) {
    this.host = host;
    this.root = document.createElement('div');
    this.root.className = 'dg-menu dg-branch-panel';
    this.root.dataset.dgFloating = '';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', '문서 갈래');
    this.root.hidden = true;
    const head = document.createElement('div');
    head.className = 'dg-branch-head';
    const title = document.createElement('span');
    title.className = 'dg-branch-title';
    title.append(icon('branch', 14, 2), document.createTextNode('문서 갈래'));
    const hint = document.createElement('span');
    hint.className = 'dg-branch-hint';
    hint.textContent = '지점을 누르면 그 상태로 돌아갑니다';
    head.append(title, hint);
    this.body = document.createElement('div');
    this.body.className = 'dg-branch-body';
    this.root.append(head, this.body);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(focusId?: string): void {
    this.focusId = focusId ?? null;
    this.root.hidden = false;
    this.render();
    requestAnimationFrame(() => {
      const target = (this.focusId && this.body.querySelector<HTMLElement>(`[data-id="${this.focusId}"]`))
        || this.body.querySelector<HTMLElement>('.dg-branch-row[aria-current="true"]')
        || this.body.querySelector<HTMLElement>('.dg-branch-row');
      target?.scrollIntoView({ block: 'nearest' });
      target?.focus();
    });
  }

  close(): void {
    this.root.hidden = true;
    this.focusId = null;
  }

  render(): void {
    if (this.root.hidden) return;
    const nodes = this.host.nodes();
    const head = this.host.head();
    const dirty = this.host.dirty();
    if (nodes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'dg-branch-empty';
      empty.textContent = '아직 지점이 없습니다. 요청이 문서를 고치면 그 상태가 지점으로 남습니다.';
      this.body.replaceChildren(empty);
      return;
    }
    const { rows, lanes } = layoutBranches(nodes);
    const offset = dirty ? 1 : 0;
    const total = rows.length + offset;
    const width = PAD * 2 + (lanes - 1) * LANE;
    const list = document.createElement('div');
    list.className = 'dg-branch-list';
    list.setAttribute('role', 'list');
    list.style.setProperty('--dg-branch-gutter', `${width}px`);
    list.style.height = `${total * ROW}px`;

    const graph = svg('svg', { class: 'dg-branch-graph', width, height: total * ROW, viewBox: `0 0 ${width} ${total * ROW}` });
    graph.setAttribute('aria-hidden', 'true');
    const y = (row: number) => (row + offset) * ROW + ROW / 2;
    const byId = new Map(rows.map((r) => [r.node.id, r]));
    // 선 먼저(점 아래에 깔리게)
    for (const r of rows) {
      const parent = r.node.parentId ? byId.get(r.node.parentId) : undefined;
      if (!parent) continue;
      const x1 = laneX(r.lane);
      const y1 = y(r.row);
      const x2 = laneX(parent.lane);
      const y2 = y(parent.row);
      // 갈라지는 곳은 부모 바로 위에서 부모 점을 떠나 옆 갈래로 휘어 올라간다(한 칸에 걸쳐 부드럽게)
      const bend = Math.min(ROW * 0.9, Math.max(0, y2 - y1));
      const d = x1 === x2
        ? `M${x1} ${y1} L${x2} ${y2}`
        : `M${x1} ${y1} L${x1} ${y2 - bend} C${x1} ${y2 - bend * 0.35} ${x2} ${y2 - bend * 0.55} ${x2} ${y2}`;
      graph.append(svg('path', { d, class: `dg-branch-edge dg-lane-${r.lane % 6}` }));
    }
    const headRow = head ? byId.get(head) : undefined;
    if (dirty && headRow) {
      const x = laneX(headRow.lane);
      graph.append(svg('path', { d: `M${x} ${ROW / 2} L${x} ${y(headRow.row)}`, class: 'dg-branch-edge dg-branch-edge--work' }));
      graph.append(svg('circle', { cx: x, cy: ROW / 2, r: 4, class: 'dg-branch-dot dg-branch-dot--work' }));
    }
    for (const r of rows) {
      const isHead = r.node.id === head;
      const cls = ['dg-branch-dot', `dg-lane-${r.lane % 6}`];
      if (r.node.lost) cls.push('dg-branch-dot--lost');
      if (r.node.kind !== 'agent' && !isHead) cls.push('dg-branch-dot--minor');
      // 지금 자리는 채운 점 + 둘레의 옅은 고리 — 빈 고리("처음 상태")와 헷갈리지 않게
      if (isHead) graph.append(svg('circle', { cx: laneX(r.lane), cy: y(r.row), r: 9, class: `dg-branch-halo dg-lane-${r.lane % 6}` }));
      graph.append(svg('circle', { cx: laneX(r.lane), cy: y(r.row), r: isHead ? 5.5 : 4.5, class: cls.join(' ') }));
    }
    list.append(graph);

    if (dirty) {
      const work = document.createElement('div');
      work.className = 'dg-branch-row dg-branch-row--work';
      work.style.top = '0px';
      const label = document.createElement('span');
      label.className = 'dg-branch-label';
      label.textContent = '지금 문서';
      const meta = document.createElement('span');
      meta.className = 'dg-branch-meta';
      meta.textContent = '지점 뒤로 직접 고침 · 되돌아가면 지점으로 남깁니다';
      work.append(label, meta);
      list.append(work);
    }

    const busy = this.host.busy();
    // 갈래마다 맨 위 지점(끝)에만 갈래 이름표를 단다 — git 의 브랜치 이름표처럼
    const tips = new Set<string>();
    const seenLane = new Set<number>();
    for (const r of rows) {
      if (seenLane.has(r.lane)) continue;
      seenLane.add(r.lane);
      tips.add(r.node.id);
    }
    for (const r of rows) {
      const isHead = r.node.id === head;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dg-branch-row';
      row.dataset.id = r.node.id;
      row.setAttribute('role', 'listitem');
      row.style.top = `${(r.row + offset) * ROW}px`;
      if (isHead) row.setAttribute('aria-current', 'true');
      if (r.node.id === this.focusId) row.classList.add('dg-branch-row--focus');
      const label = document.createElement('span');
      label.className = 'dg-branch-label';
      if (tips.has(r.node.id)) {
        const ref = document.createElement('span');
        ref.className = `dg-branch-ref dg-lane-${r.lane % 6}`;
        ref.textContent = branchName(r.lane);
        label.append(ref);
      }
      const text = document.createElement('span');
      text.className = 'dg-branch-label-text';
      text.textContent = r.node.label;
      label.append(text);
      label.title = r.node.label;
      const meta = document.createElement('span');
      meta.className = 'dg-branch-meta';
      meta.textContent = `지점 ${checkpointNumber(nodes, r.node.id)} · ${when(r.node.createdAt)}`;
      const tail = document.createElement('span');
      tail.className = 'dg-branch-tail';
      if (isHead && !dirty) {
        tail.textContent = '지금 여기';
        tail.classList.add('dg-branch-tail--here');
      } else if (r.node.lost) {
        tail.textContent = '되돌릴 수 없음';
      } else {
        tail.append(icon('undo', 12, 2), document.createTextNode('이 상태로'));
        tail.classList.add('dg-branch-tail--go');
      }
      row.append(label, meta, tail);
      const can = !r.node.lost && !(isHead && !dirty) && !busy;
      row.disabled = r.node.lost === true || busy;
      row.setAttribute('aria-label', `${r.node.label} — ${branchName(r.lane)}${isHead ? ', 지금 여기' : ''}${r.node.lost ? ', 되돌릴 수 없음' : ''}`);
      if (can) row.addEventListener('click', () => this.host.checkout(r.node.id));
      list.append(row);
    }
    this.body.replaceChildren(list);
  }
}
