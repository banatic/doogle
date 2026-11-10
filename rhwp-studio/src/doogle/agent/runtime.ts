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
import type { DoogleAgentDeps, DoogleAgentRuntime, ToolContext, ToolResult } from './types.ts';

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
    },
    revision: () => executor.revision,
    dispose: () => executor.dispose(),
  };
}
