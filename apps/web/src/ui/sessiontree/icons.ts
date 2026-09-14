// ============================================================================
// ui/sessions/icons.ts — 内联 SVG 图标（不引图标库；W748 从 ui/sessions.ts 拆出）。
// ============================================================================

export type IconKind = 'folder' | 'file' | 'search' | 'sort' | 'folder-plus' | 'plus';

export function svgIcon(kind: IconKind): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  switch (kind) {
    case 'folder':
      p.setAttribute('d', 'M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z');
      break;
    case 'file':
      p.setAttribute('d', 'M3 1.5h6l4 4v9h-10zM9 1.5v4h4');
      break;
    case 'search':
      p.setAttribute('d', 'M6.5 11.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zM14.5 14.5l-3.8-3.8');
      break;
    case 'sort':
      p.setAttribute('d', 'M2 4h12M5 8h7M8 12h4');
      break;
    case 'folder-plus':
      p.setAttribute('d', 'M1.5 3.5h4l1.5 2h7.5v4M1.5 3.5v8a1 1 0 0 0 1 1h5.5M11 9v5M8.5 11.5h5');
      break;
    case 'plus':
      p.setAttribute('d', 'M8 3v10M3 8h10');
      break;
  }
  svg.appendChild(p);
  return svg;
}
/** 侧栏用的小盾牌图标（实心；颜色由 .sess-leaf-grant 的 class 决定）。 */
export function grantShieldIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M8 1.6 13.2 3.4v4.2c0 3.1-2.1 5.6-5.2 6.8-3.1-1.2-5.2-3.7-5.2-6.8V3.4z');
  svg.appendChild(p);
  return svg;
}
