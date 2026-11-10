/** 두글 사이드바·검토 막 아이콘 — 시안 F 의 stroke 아이콘 (aria-hidden). */
const SVG_NS = 'http://www.w3.org/2000/svg';

export const ICONS = {
  chevronDown: ['M6 9l6 6 6-6'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  history: ['M12 8v4l3 2', 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z'],
  compose: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z'],
  close: ['M6 6l12 12M18 6L6 18'],
  tool: ['M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z'],
  check: ['M5 12l5 5L20 7'],
  copy: ['M8 8h12v12H8z', 'M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3'],
  retry: ['M20 12a8 8 0 11-2.3-5.7M20 4v5h-5'],
  undo: ['M9 14L4 9l5-5', 'M4 9h11a5 5 0 010 10h-3'],
  plus: ['M12 5v14M5 12h14'],
  send: ['M12 19V5M5 12l7-7 7 7'],
  stop: ['M7 7h10v10H7z'],
  bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
  gear: ['M12 15a3 3 0 100-6 3 3 0 000 6z', 'M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z'],
  file: ['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5'],
  folder: ['M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
  terminal: ['M4 17l6-5-6-5', 'M12 19h8'],
  clock: ['M12 7v5l3 2', 'M21 12a9 9 0 11-18 0 9 9 0 0118 0z'],
  alert: ['M12 8v5M12 16.5v.5', 'M10.3 4.3L2.6 18a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0z'],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16, stroke = 1.8): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
