import { createIcon } from './ui-icons.js';

/**
 * Shared text-only DOM builders for the dashboard modules.
 * Every value is assigned through textContent or attributes; HTML is never parsed.
 */
export function createUi(doc) {
  function el(tag, className = '', text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function icon(name, options) { return createIcon(doc, name, options); }
  function button(label, action, className = 'button') {
    const node = el('button', className, label); node.type = 'button';
    if (action) node.addEventListener('click', action);
    return node;
  }
  function externalLink(label, href, { className = 'button button-small button-quiet', ariaLabel } = {}) {
    const link = el('a', className, label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    if (ariaLabel) link.setAttribute('aria-label', ariaLabel);
    link.append(icon('external'));
    return link;
  }
  /** Card heading: small decorative glyph, a real heading and optional trailing accessories. */
  function panelHeading(title, { icon: iconName, description, level = 2, accessories = [] } = {}) {
    const top = el('div', 'panel-heading');
    if (iconName) top.append(icon(iconName, { tile: true }));
    const copy = el('div', 'heading-copy'); copy.append(el(`h${level}`, '', title));
    if (description) copy.append(el('p', 'panel-description', description));
    top.append(copy, ...accessories);
    return top;
  }
  function panel(title, options = {}) {
    const root = el('section', `panel ${options.className ?? ''}`.trim());
    root.append(panelHeading(title, options));
    return root;
  }
  /** One metric in a hairline-separated stat grid; `tone` colours only the value. */
  function stat({ label, value, note, tone = '', key = '', icon: iconName = '' }) {
    const item = el('div', 'stat'); if (key) item.dataset.metric = key;
    const labelNode = el('div', 'stat-label');
    if (iconName) labelNode.append(icon(iconName));
    labelNode.append(doc.createTextNode(label));
    const valueNode = el('div', 'stat-value', value); if (tone) valueNode.dataset.tone = tone;
    item.append(labelNode, valueNode);
    if (note) item.append(typeof note === 'string' ? el('div', 'stat-note', note) : note);
    return item;
  }
  function stats(items, className = '') {
    const grid = el('div', `stats ${className}`.trim()); grid.append(...items); return grid;
  }
  function tag(text, kind = '') { return el('span', `tag ${kind ? `tag-${kind}` : ''}`.trim(), text); }
  /** One-line state indicator; healthy states stay small, warnings use the same footprint. */
  function statusLine(text, tone = '') {
    const line = el('p', 'status-line'); if (tone) line.dataset.tone = tone;
    const dot = el('span', 'status-dot'); dot.setAttribute('aria-hidden', 'true');
    line.append(dot, doc.createTextNode(text)); return line;
  }
  function emptyState(title, description, kind = '') {
    const box = el('div', `empty-state${kind ? ` empty-state-${kind}` : ''}`);
    if (kind === 'quiet') { const badge = el('span', 'empty-state-icon'); badge.append(icon('quiet')); box.append(badge); }
    const copy = el('div', 'empty-state-copy'); copy.append(el('h3', '', title), el('p', 'muted', description));
    box.append(copy); return box;
  }
  function loadingState(message) {
    const box = el('div', 'loading-state'); box.setAttribute('role', 'status');
    const spinner = el('span', 'spinner'); spinner.setAttribute('aria-hidden', 'true');
    box.append(spinner, doc.createTextNode(message)); return box;
  }
  return { el, icon, button, externalLink, panelHeading, panel, stat, stats, tag, statusLine, emptyState, loadingState };
}
