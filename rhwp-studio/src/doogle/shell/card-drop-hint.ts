/**
 * 카드 끌어 놓기 표시 — 서랍의 카드를 문서 위로 끄는 동안 "놓으면 채워질 자리" 를 칠한다.
 *
 *  - 포인터 아래가 표면 그 표 전체를, 아니면 그 줄을 옅은 강조색으로 칠하고 꼬리표를 단다
 *    (「내 인적 사항」 카드로 이 표 채우기). 자리는 main.ts 가 InputHandler.dropTargetAtClientPoint 로 구해 넘긴다.
 *  - 놓으면 그 자리가 한 번 번쩍이고 사라진다 — 받았다는 표시다. 실제로 채우는 것은 에이전트가 한다.
 *  - 모양은 card-shelf.css (.dg-drop-hint · .dg-drop-tag).
 */
import { currentDraggedCard } from '../ui/card-shelf.ts';

export interface CardDropTarget {
  kind: 'table' | 'line';
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 꼬리표 문구 */
export function cardDropLabel(kind: CardDropTarget['kind'], cardName: string): string {
  const name = cardName.trim() ? `「${cardName.trim()}」 카드` : '카드';
  return kind === 'table' ? `${name}로 이 표 채우기` : `${name}로 여기 채우기`;
}

/** 자리를 보이는 영역(clip) 안으로 자른다 — 다 가려지면 null */
export function clipDropTarget(target: CardDropTarget, clip: { left: number; top: number; right: number; bottom: number }): CardDropTarget | null {
  const left = Math.max(target.left, clip.left);
  const top = Math.max(target.top, clip.top);
  const right = Math.min(target.left + target.width, clip.right);
  const bottom = Math.min(target.top + target.height, clip.bottom);
  if (right - left < 1 || bottom - top < 1) return null;
  return { kind: target.kind, left, top, width: right - left, height: bottom - top };
}

const FLASH_MS = 650;
const TAG_HEIGHT = 26;

let box: HTMLElement | null = null;
let tag: HTMLElement | null = null;
let hideTimer = 0;
let flashing = false;

function ensure(): { box: HTMLElement; tag: HTMLElement } {
  if (!box || !tag) {
    box = document.createElement('div');
    box.className = 'dg-drop-hint';
    box.hidden = true;
    tag = document.createElement('div');
    tag.className = 'dg-drop-tag';
    tag.hidden = true;
    document.body.append(box, tag);
    // 끌기를 그만두면(Esc, 다른 곳에 놓기) 지운다
    document.addEventListener('dragend', hideCardDropHint);
  }
  return { box, tag };
}

/** 끄는 동안 — 자리를 칠한다. target 이 null 이면 지운다. clip: 문서 영역의 화면 사각형 */
export function updateCardDropHint(target: CardDropTarget | null, clip: DOMRect): void {
  if (flashing) return;
  window.clearTimeout(hideTimer);
  const shown = target ? clipDropTarget(target, clip) : null;
  const nodes = ensure();
  nodes.box.hidden = !shown;
  nodes.tag.hidden = !shown;
  if (!shown) return;
  nodes.box.dataset.kind = shown.kind;
  Object.assign(nodes.box.style, {
    left: `${shown.left}px`,
    top: `${shown.top}px`,
    width: `${shown.width}px`,
    height: `${shown.height}px`,
  });
  nodes.tag.textContent = cardDropLabel(shown.kind, currentDraggedCard()?.name ?? '');
  // 꼬리표는 자리 위에, 위에 틈이 없으면 자리 안쪽 맨 위에
  const above = shown.top - TAG_HEIGHT - 4;
  nodes.tag.style.left = `${shown.left}px`;
  nodes.tag.style.top = `${above >= clip.top ? above : shown.top + 4}px`;
}

/** 문서 밖으로 나갔다 — 잠깐 뒤에 지운다 (자식 요소를 넘나들 때의 깜박임을 막는다) */
export function hideCardDropHint(): void {
  if (flashing || !box || !tag) return;
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (flashing || !box || !tag) return;
    box.hidden = true;
    tag.hidden = true;
  }, 80);
}

/** 놓았다 — 칠해 둔 자리가 한 번 번쩍이고 사라진다 */
export function flashCardDropHint(): void {
  if (!box || !tag || box.hidden) return;
  window.clearTimeout(hideTimer);
  flashing = true;
  tag.hidden = true;
  box.classList.add('dg-drop-hint--flash');
  window.setTimeout(() => {
    flashing = false;
    if (!box) return;
    box.classList.remove('dg-drop-hint--flash');
    box.hidden = true;
  }, FLASH_MS);
}
