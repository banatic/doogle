/**
 * 쪽이 쓸 수 있는 폭(px) — 스크롤 영역에서 안쪽 좌우 여백(메모 말풍선 자리·떠 있는 사이드바 자리)을 뺀 것.
 *
 * 유리 리본이 켜져 있으면 스크롤 영역의 clientWidth 는 이미 사이드바 자리를 뺀 값이다(glass.ts) — 거기서
 * 여백을 또 빼면 사이드바 자리를 두 번 뺀다. 그래서 상자 폭에서 여백을 뺀 값과 clientWidth 중 작은 쪽을 쓴다.
 * 의존이 없는 파일이다(단위 시험이 읽는 narrow-fit 이 가져온다).
 */
export function usablePageWidth(container: HTMLElement): number {
  const style = getComputedStyle(container);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const box = Math.round(container.getBoundingClientRect().width) - padding;
  return Math.max(0, Math.min(container.clientWidth, box));
}
