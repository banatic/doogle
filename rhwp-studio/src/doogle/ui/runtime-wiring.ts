/**
 * PluginHost → 실행기(agent E, `../agent/`) 의존성 연결.
 *
 * 실행기 모듈은 `import.meta.glob` 으로 찾는다. 아직 없거나 진입 함수 이름이 다르면 null 을 돌려주고
 * 사이드바는 실행기 없이(도구 호출은 NOT_IMPLEMENTED) 뜬다 — 병렬 작업 중에도 빌드가 깨지지 않게 하려는 것이다.
 */
import type { PluginHost, PluginCaret } from '@/plugin/types';
import type {
  DoogleAgentDeps,
  DoogleAgentRuntime,
  EngineDoc,
  SelectionInfo,
  SelectionPoint,
} from '../agent/types.ts';

type RuntimeFactory = (deps: DoogleAgentDeps) => DoogleAgentRuntime | Promise<DoogleAgentRuntime>;

const runtimeModules = import.meta.glob<Record<string, unknown>>([
  '../agent/index.ts',
  '../agent/runtime.ts',
]);

function point(caret: PluginCaret): SelectionPoint {
  return {
    sectionIndex: caret.sectionIndex,
    parentParaIndex: caret.parentParaIndex,
    cellPath: caret.cellPath.map((entry) => ({ ...entry })),
    charOffset: caret.charOffset,
  };
}

export function depsFromHost(host: PluginHost): DoogleAgentDeps {
  return {
    getDocument: () => (host.borrowDocument()?.handle as unknown as EngineDoc | undefined) ?? null,
    transaction: (label, fn) => host.transaction(label, (tx) => fn(tx.doc() as unknown as EngineDoc)),
    events: {
      on: (event, handler) => host.events.on(event, (payload) => handler(payload)),
    },
    documentInstance: () => host.currentGeneration(),
    getSelection: (): SelectionInfo | null => {
      const caret = host.getCaret();
      const selection = host.getSelectionText();
      return {
        caret: caret ? point(caret) : null,
        selection: selection
          ? { start: point(selection.start), end: point(selection.end), text: selection.text, truncated: selection.truncated }
          : null,
      };
    },
    getDocumentName: () => {
      const title = document.title.replace(/ - rhwp-studio$/, '');
      return title && title !== 'rhwp-studio' ? title : null;
    },
  };
}

export async function createRuntime(host: PluginHost): Promise<DoogleAgentRuntime | null> {
  for (const [path, load] of Object.entries(runtimeModules)) {
    try {
      const mod = await load();
      const factory = mod['createDoogleAgentRuntime'];
      if (typeof factory === 'function') {
        return await (factory as RuntimeFactory)(depsFromHost(host));
      }
    } catch (error) {
      console.error(`[doogle] 실행기(${path})를 만들지 못했습니다`, error);
    }
  }
  console.warn('[doogle] 실행기(createDoogleAgentRuntime)를 찾지 못했습니다 — 도구 호출은 NOT_IMPLEMENTED 로 답합니다');
  return null;
}
