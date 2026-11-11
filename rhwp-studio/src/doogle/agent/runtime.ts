/**
 * 두글 에이전트 런타임 진입점.
 *
 * ```ts
 * import { createDoogleAgentRuntime } from '@/doogle/agent/runtime.ts';
 * const runtime = createDoogleAgentRuntime(depsFromHost(pluginHost));
 * const r = await runtime.executeTool('get_structure', {}, { origin: 'agent', threadId, mode: 'agent' });
 * runtime.pending.onChange((e) => …); runtime.pending.acceptAll(threadId); runtime.pending.rejectAll(threadId);
 * ```
 */
import { Engine } from './engine-adapter.ts';
import { DoogleToolExecutor } from './executor.ts';
import type { DoogleAgentDeps, DoogleAgentRuntime, PendingChangeTarget, SelectionRect, ToolContext, ToolResult } from './types.ts';

/**
 * 변경 자리 → 지금 문서에서의 쪽 사각형(쪽 px, 배율 1). 문서 위 강조가 쓴다 — 기록 때가 아니라
 * 지금 계산하므로 다시 조판·배율·직접 편집 뒤에도 맞는다. 표는 셀 상자, 글은 그 범위(0자면 문단 전체).
 */
function targetRects(engine: Engine, targets: PendingChangeTarget[]): Array<SelectionRect & { item?: number }> {
  const out: Array<SelectionRect & { item?: number }> = [];
  for (const t of targets.slice(0, 60)) {
    if (t.wholeSection) continue;
    // 묶음 편집의 어느 항목이 만든 자리인지 — 강조에 마우스를 올리면 그 항목의 전·후를 보인다
    const tag = typeof t.item === 'number' ? { item: t.item } : {};
    const table = t.table ?? (t.cell ? { paraIdx: t.cell.paraIdx, controlIdx: t.cell.controlIdx } : null);
    if (table) {
      for (const b of engine.tableCellBoxes(t.sectionIdx, table.paraIdx, table.controlIdx)) {
        if (!t.cell || b.cellIdx === t.cell.cellIdx) out.push({ pageIndex: b.pageIndex, x: b.x, y: b.y, width: b.w, height: b.h, ...tag });
      }
      continue;
    }
    if (t.paraIdx < 0 || t.paraIdx >= engine.paragraphCount(t.sectionIdx)) continue;
    const len = engine.length(t.sectionIdx, t.paraIdx);
    const start = t.length > 0 ? Math.min(t.charOffset, len) : 0;
    const end = t.length > 0 ? Math.min(t.charOffset + t.length, len) : len;
    for (const r of engine.selectionRects(t.sectionIdx, t.paraIdx, start, t.paraIdx, Math.max(end, start))) out.push({ ...r, ...tag });
  }
  return out;
}

export function createDoogleAgentRuntime(deps: DoogleAgentDeps): DoogleAgentRuntime {
  const executor = new DoogleToolExecutor(deps);
  // 도구 호출은 한 번에 하나씩 — 쓰기의 revision 연쇄와 스테이징 기록이 섞이지 않게 줄 세운다.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    executeTool(name: string, args: unknown, ctx: Partial<ToolContext> & Pick<ToolContext, 'origin'>): Promise<ToolResult> {
      const full: ToolContext = {
        origin: ctx.origin ?? 'agent',
        mode: ctx.mode === 'full' ? 'full' : 'agent',
        ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
      };
      const run = queue.then(() => executor.execute(name, args, full));
      queue = run.catch(() => undefined);
      return run;
    },
    pending: {
      list: (threadId) => executor.staging.list(threadId),
      acceptAll: (threadId) => executor.staging.acceptAll(threadId),
      rejectAll: (threadId) => executor.staging.rejectAll(threadId),
      onChange: (cb) => executor.staging.onChange(cb),
      hasPending: (threadId) => executor.staging.hasPending(threadId),
      accept: (id) => executor.staging.accept(id),
      rejectFrom: (id) => executor.staging.rejectFrom(id),
      hasUserEditsSince: (id) => executor.staging.hasUserEditsSince(id),
      revertInfo: () => executor.staging.revertInfo(),
      revertAccepted: () => executor.staging.revertAccepted(),
      pageCount: () => {
        const doc = deps.getDocument();
        if (!doc) return 0;
        try { return new Engine(doc).pageCount(); } catch { return 0; }
      },
      rectsOf: (id) => {
        const doc = deps.getDocument();
        const change = executor.staging.list().find((c) => c.id === id);
        if (!doc || !change) return [];
        try { return targetRects(new Engine(doc), change.targets ?? []); } catch { return []; }
      },
    },
    revision: () => executor.revision,
    noteDocumentSwap: () => executor.syncDocumentInstance(),
    dispose: () => executor.dispose(),
  };
}
