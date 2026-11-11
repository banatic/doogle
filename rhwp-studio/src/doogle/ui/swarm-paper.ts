/**
 * 편집 표시(edit-swarm.ts)의 덮개가 깔 종이색 — 바뀐 자리의 바탕색을 화면 그림에서 읽는다.
 * 쪽이 늘 흰 것은 아니다: 음영을 넣은 표 칸, 배경색이 있는 쪽에서는 흰 덮개가 번쩍여 보인다.
 * 여기는 계산만 한다(DOM 을 쓰지 않아 node 시험에서 바로 돈다). 픽셀 읽기는 edit-swarm.ts.
 */

export interface PaperBox { left: number; top: number; width: number; height: number }
export type Rgba = readonly [number, number, number, number];

/**
 * 바탕색을 읽을 자리 — 상자 네 귀퉁이와 위·아래 변 가운데를 안쪽으로 조금 들인 점.
 * 글자는 줄 상자의 위·아래 끝까지 차지 않으므로(줄 간격) 이 점들은 대개 바탕이다.
 */
export function paperSamplePoints(box: PaperBox, inset = 1): Array<{ x: number; y: number }> {
  const dx = Math.min(inset, box.width / 2);
  const dy = Math.min(inset, box.height / 2);
  const l = box.left + dx;
  const r = box.left + box.width - dx;
  const t = box.top + dy;
  const b = box.top + box.height - dy;
  const m = box.left + box.width / 2;
  return [{ x: l, y: t }, { x: r, y: t }, { x: l, y: b }, { x: r, y: b }, { x: m, y: t }, { x: m, y: b }];
}

/**
 * 표본 중 가장 흔한 색 (CSS rgb). 비치는 픽셀(그려지지 않은 자리)은 뺀다. 같은 수면 먼저 나온 색.
 * 쓸 표본이 없으면 fallback — 읽지 못했을 때는 지금까지처럼 흰 종이로 본다.
 */
export function commonColor(samples: ReadonlyArray<Rgba | null | undefined>, fallback = '#ffffff'): string {
  const counts = new Map<string, number>();
  let best = '';
  let bestCount = 0;
  for (const s of samples) {
    if (!s || s[3] < 250) continue;
    const key = `rgb(${s[0]}, ${s[1]}, ${s[2]})`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > bestCount) {
      best = key;
      bestCount = n;
    }
  }
  return best || fallback;
}
