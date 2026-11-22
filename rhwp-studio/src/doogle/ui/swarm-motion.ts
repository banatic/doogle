/**
 * 편집 표시(edit-swarm.ts)의 움직임 계산 — 카메라(스크롤 추적)의 목표·감속, 커서의 비행·치기 시간,
 * 바뀐 픽셀 범위. 여기는 계산만 한다(DOM 을 쓰지 않아 node 시험에서 바로 돈다).
 */

export interface MotionBox { left: number; top: number; width: number; height: number }

// ─── 카메라 ──────────────────────────────────────────

/**
 * 임계 감쇠 스프링 한 걸음. x = 목표까지 남은 거리(지금 − 목표), v = 속도(px/초), dt = 초.
 * 닫힌 꼴이라 dt 가 커도(프레임이 밀려도) 튀지 않는다. 목표가 도중에 바뀌어도 속도를 이어 받아
 * 멈췄다 다시 가지 않는다 — 브라우저의 smooth 스크롤은 목표를 바꿀 때마다 새로 출발한다.
 */
export function springStep(x: number, v: number, dt: number, omega: number): { x: number; v: number } {
  const e = Math.exp(-omega * dt);
  const c = v + omega * x;
  return { x: (x + c * dt) * e, v: (v - omega * c * dt) * e };
}

/**
 * 편집이 시작되는 줄을 보여 줄 스크롤 위치. 이미 편히 보이면(위·아래 여백 안) null — 움직이지 않는다.
 * 아니면 줄 윗변을 화면 높이의 at 지점에 둔다.
 */
export function revealTop(scrollTop: number, viewHeight: number, box: { top: number; height: number }, at: number): number | null {
  const margin = Math.min(80, viewHeight * 0.12);
  if (box.top >= scrollTop + margin && box.top + box.height <= scrollTop + viewHeight - margin) return null;
  return box.top - viewHeight * at;
}

/**
 * 치고 있는 줄을 띠(화면 높이의 lo ~ hi) 안에 두는 스크롤 위치. 띠 안이면 null.
 * 띠를 벗어난 만큼만 옮긴다 — 폭포가 한 줄씩 내려가면 화면도 한 줄씩 미끄러진다(덩어리로 뛰지 않는다).
 */
export function bandTop(scrollTop: number, viewHeight: number, box: { top: number; height: number }, lo = 0.18, hi = 0.62): number | null {
  const floor = scrollTop + viewHeight * hi;
  const ceil = scrollTop + viewHeight * lo;
  // 띠보다 큰 상자(큰 표 칸)는 윗변을 띠 위쪽에 맞춘다
  if (box.height > viewHeight * (hi - lo)) return Math.abs(box.top - ceil) < 1 ? null : box.top - viewHeight * lo;
  if (box.top + box.height > floor) return box.top + box.height - viewHeight * hi;
  if (box.top < ceil) return box.top - viewHeight * lo;
  return null;
}

/**
 * 가로 스크롤 위치 — 상자가 보이는 폭(가려진 곳을 뺀 viewWidth) 안에 들게. 이미 들어 있으면 null.
 * 상자가 보이는 폭보다 넓으면 왼쪽 끝을 맞춘다(글은 왼쪽부터 읽는다).
 */
export function panLeft(scrollLeft: number, viewWidth: number, box: { left: number; width: number }, margin = 24): number | null {
  const lo = scrollLeft + margin;
  const hi = scrollLeft + viewWidth - margin;
  if (box.left >= lo && box.left + box.width <= hi) return null;
  if (box.width > viewWidth - margin * 2 || box.left < lo) return box.left - margin;
  return box.left + box.width - (viewWidth - margin);
}

/**
 * 줄들을 가까운 것끼리 묶는다(위에서 아래로 정렬돼 있다고 본다). 앞줄 아랫변에서 gap 넘게 떨어지면 새 묶음.
 * 카메라는 묶음 하나를 다 보여 준 뒤 다음 묶음으로 간다 — 쪽을 건너뛰는 편집에서 치는 도중에 떠나지 않게.
 */
export function clusterLines<T extends { top: number; height: number }>(lines: readonly T[], gap: number): T[][] {
  const out: T[][] = [];
  for (const line of lines) {
    const group = out[out.length - 1];
    const prev = group?.[group.length - 1];
    if (prev && line.top - (prev.top + prev.height) <= gap) group.push(line);
    else out.push([line]);
  }
  return out;
}

// ─── 커서 ──────────────────────────────────────────

/** 날아가는 시간(ms) — 거리에 비례하되 너무 짧거나 길지 않게. 가까운 커서가 느릿하거나 먼 커서가 쏜살같지 않다 */
export function flightMs(distance: number): number {
  return Math.round(Math.max(380, Math.min(760, 260 + distance * 0.55)));
}

/** 치는 시간(ms) — 폭에 비례(약 500px/초). 토막 폭이 달라도 치는 빠르기가 비슷하다 */
export function typeMs(width: number): number {
  return Math.round(Math.max(360, Math.min(1000, width * 2)));
}

/** 지우는 시간(ms) — 치기보다 훨씬 빠르게 */
export function eraseMs(width: number): number {
  return Math.round(Math.max(140, Math.min(280, width * 0.6)));
}

// ─── 바뀐 자리 ──────────────────────────────────────────

/** RGBA 그림 한 장 (행 우선) */
export interface Pixels { data: ArrayLike<number>; width: number; height: number }

/**
 * 두 RGBA 그림의 같은 크기 조각(a 의 (ax, ay), b 의 (bx, by) 에서 width × height)에서 다른 열의 범위
 * [start, end) — 조각 안의 열 번호. 같으면 null, 조각이 그림 밖으로 나가 견줄 수 없으면 undefined.
 * 고치기 전·후 화면을 견줘 정말 바뀐 곳만 다시 치려고 쓴다 — 낱말 하나를 바꿨는데 문단을 통째로 치지 않게.
 * tolerance 는 채널 차이 허용치(같은 글을 같은 자리에 그리면 0 이지만, 압축·색 관리 오차를 조금 봐 준다).
 */
export function changedSpan(
  a: Pixels, ax: number, ay: number, b: Pixels, bx: number, by: number, width: number, height: number, tolerance = 12,
): { start: number; end: number } | null | undefined {
  const inside = (p: Pixels, x: number, y: number) => x >= 0 && y >= 0 && x + width <= p.width && y + height <= p.height
    && p.data.length >= p.width * p.height * 4;
  if (width <= 0 || height <= 0 || !inside(a, ax, ay) || !inside(b, bx, by)) return undefined;
  const differs = (x: number): boolean => {
    for (let y = 0; y < height; y++) {
      const i = ((ay + y) * a.width + ax + x) * 4;
      const j = ((by + y) * b.width + bx + x) * 4;
      if (Math.abs(a.data[i] - b.data[j]) > tolerance || Math.abs(a.data[i + 1] - b.data[j + 1]) > tolerance
        || Math.abs(a.data[i + 2] - b.data[j + 2]) > tolerance || Math.abs(a.data[i + 3] - b.data[j + 3]) > tolerance) return true;
    }
    return false;
  };
  let start = 0;
  while (start < width && !differs(start)) start++;
  if (start === width) return null;
  let end = width;
  while (end > start + 1 && !differs(end - 1)) end--;
  return { start, end };
}
