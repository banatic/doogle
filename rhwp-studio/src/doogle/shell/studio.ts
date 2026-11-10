/**
 * 셸이 upstream studio 를 만지는 유일한 자리.
 *
 * 커맨드는 `window.rhwpStudio.automation`(main.ts 가 프로덕션에도 노출하는 공개 표면)으로만 실행한다.
 * 메뉴·툴바·키보드와 같은 `CommandDispatcher` 를 타므로 양식 모드 차단·canExecute 게이트가 같다.
 * 셸은 사람이 누른 단추라서 대화상자를 여는 커맨드도 허용한다(`allowDialog`).
 */
import type { StudioAutomation } from '@/automation/types';
import type { EditorContext } from '@/command/types';

export const AGENT_TOGGLE_COMMAND = 'ext:doogle.toggle-panel';

export function automation(): StudioAutomation | null {
  const studio = (window as unknown as { rhwpStudio?: { automation?: StudioAutomation } }).rhwpStudio;
  return studio?.automation ?? null;
}

let knownIds: Set<string> | null = null;

/** 레지스트리에 있는 커맨드인가. 목록은 처음 한 번 읽고, ext: 는 늦게 등록되므로 매번 본다. */
export function hasCommand(id: string): boolean {
  const auto = automation();
  if (!auto) return true; // 아직 모르면 그려 두고 실행 때 판정한다
  if (id.startsWith('ext:')) return auto.listCommands().some((c) => c.id === id);
  if (!knownIds) knownIds = new Set(auto.listCommands().map((c) => c.id));
  return knownIds.has(id);
}

export function isEnabled(id: string): boolean {
  const auto = automation();
  if (!auto) return false;
  try {
    return auto.isEnabled(id);
  } catch {
    return false;
  }
}

export function context(): EditorContext | null {
  try {
    return automation()?.getContext() ?? null;
  } catch {
    return null;
  }
}

export function commandLabel(id: string): string | undefined {
  return automation()?.listCommands().find((c) => c.id === id)?.label;
}

export function commandShortcut(id: string): string | undefined {
  return automation()?.listCommands().find((c) => c.id === id)?.shortcutLabel;
}

export function run(id: string, params?: Record<string, unknown>): boolean {
  const auto = automation();
  if (!auto) return false;
  const result = auto.execute(id, params, { allowDialog: true });
  if (!result.ok && result.reason !== 'disabled') {
    console.warn('[doogle shell] 커맨드 실행 실패', id, result);
  }
  return result.ok;
}

/** 오른쪽 에이전트 사이드바를 연다/닫는다(index.ts 가 등록하는 ext 커맨드). */
export function toggleAgentPanel(): void {
  run(AGENT_TOGGLE_COMMAND);
}

/**
 * upstream 커맨드 팔레트(Ctrl+/)를 연다.
 * 팔레트 인스턴스는 InputHandler 안에 있어 직접 닿을 수 없으므로, 편집 입력 요소에 같은 키 이벤트를 보낸다.
 */
export function openCommandPalette(): boolean {
  const input = document.querySelector<HTMLElement>('[aria-label="문서 편집 입력"]');
  if (!input) return false;
  input.dispatchEvent(new KeyboardEvent('keydown', {
    key: '/', code: 'Slash', ctrlKey: true, bubbles: true, cancelable: true,
  }));
  return true;
}
