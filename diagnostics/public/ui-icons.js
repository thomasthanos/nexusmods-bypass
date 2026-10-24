const SVG_NS = 'http://www.w3.org/2000/svg';
const PATHS = Object.freeze({
  audience: ['M3 20v-5m6 5V9m6 11V4m6 16V11', 'm3 9 6-5 6 3 6-5'],
  store: ['M3 10v11h18V10', 'M2 10 5 3h14l3 7', 'M2 10a3 3 0 0 0 5 2 3 3 0 0 0 5 0 3 3 0 0 0 5 0 3 3 0 0 0 5-2', 'M9 21v-6h6v6'],
  reviews: ['M21 11a8 8 0 0 1-8 8H7l-5 3 2-6a8 8 0 0 1-2-5 8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z', 'M7 8h9M7 12h6'],
  users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M17 4a4 4 0 0 1 0 7m5 10v-2a4 4 0 0 0-3-3.87'],
  rating: ['m12 3 2.8 5.67L21 9.58l-4.5 4.39 1.06 6.2L12 17.24l-5.56 2.93 1.06-6.2L3 9.58l6.2-.91L12 3Z'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2'],
  issues: ['m10.3 3.9-8.1 14a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3l-8.1-14a2 2 0 0 0-3.4 0Z', 'M12 8v5m0 4h.01'],
  settings: ['m9 3-.5 2.1-2 .9-2-.6-2 3.4L4 10.4v2.3L2.5 14l2 3.4 2-.6 2 .9L9 20h4l.5-2.3 2-.9 2 .6 2-3.4-1.5-1.3v-2.3L19.5 9l-2-3.4-2 .6-2-.9L13 3H9Z', 'M11 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'],
  health: ['M2 12h5l3-8 4 16 3-8h5'],
  shield: ['M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z', 'm9 12 2 2 4-4'],
  release: ['M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6', 'M12 16V3m-5 5 5-5 5 5'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6M10 14 21 3'],
  chevron: ['m9 18 6-6-6-6'],
  check: ['m5 13 4 4L19 7'],
  sync: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.6-2L20 8M4 16l2.3 3A7 7 0 0 0 17.9 17'],
  search: ['m21 21-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z'],
  sliders: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'],
  calendar: ['M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2ZM16 2v4M8 2v4M3 10h18'],
  github: ['M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2'],
  chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
});
const CHROME_SHAPES = [
  ['path', { fill: '#ea4335', d: 'M24 9.5h18.2A22 22 0 0 0 10.7 4.2l9.1 15.7A10.5 10.5 0 0 1 24 9.5z' }],
  ['path', { fill: '#fbbc05', d: 'M24 38.5a10.5 10.5 0 0 1-9.1-5.3L5.8 17.5A22 22 0 0 0 24 46l9.1-15.7a10.5 10.5 0 0 1-9.1 8.2z' }],
  ['path', { fill: '#34a853', d: 'M38.5 24a10.5 10.5 0 0 1-1.4 5.3L28 44A22 22 0 0 0 46 22H24a10.5 10.5 0 0 1 14.5 2z' }],
  ['circle', { cx: '24', cy: '24', r: '9', fill: '#ffffff' }],
  ['circle', { cx: '24', cy: '24', r: '7', fill: '#1a73e8' }],
];

/** Decorative icons use local constants; the surrounding text supplies their label. */
export function createIcon(doc, name, { tile = false } = {}) {
  const key = name === 'chrome' || Object.hasOwn(PATHS, name) ? name : 'health';
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.classList.add('ui-icon'); svg.dataset.icon = key;
  for (const [attribute, value] of Object.entries({ viewBox: key === 'chrome' ? '0 0 48 48' : '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: key === 'chrome' ? 'none' : 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(attribute, value);
  const shapes = key === 'chrome' ? CHROME_SHAPES : PATHS[key].map((d) => ['path', { d }]);
  for (const [tag, attributes] of shapes) {
    const shape = doc.createElementNS(SVG_NS, tag);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
    svg.append(shape);
  }
  if (!tile) return svg;
  const wrapper = doc.createElement('span'); wrapper.className = 'section-icon'; wrapper.setAttribute('aria-hidden', 'true'); wrapper.append(svg); return wrapper;
}
