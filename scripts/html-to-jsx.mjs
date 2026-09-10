// Dev tool: converts an HTML fragment from the original build into JSX source.
// Usage: node scripts/html-to-jsx.mjs <file.html> <css-selector> [--all]
import { parse } from 'node-html-parser';
import fs from 'node:fs';

const ATTR_MAP = {
  class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength',
  autocomplete: 'autoComplete', autoplay: 'autoPlay', playsinline: 'playsInline', crossorigin: 'crossOrigin',
  srcset: 'srcSet', enctype: 'encType', novalidate: 'noValidate', spellcheck: 'spellCheck',
  contenteditable: 'contentEditable', frameborder: 'frameBorder', allowfullscreen: 'allowFullScreen',
  'accept-charset': 'acceptCharset', 'http-equiv': 'httpEquiv', datetime: 'dateTime', rowspan: 'rowSpan',
  colspan: 'colSpan', usemap: 'useMap', ismap: 'isMap', hreflang: 'hrefLang', referrerpolicy: 'referrerPolicy',
  fetchpriority: 'fetchPriority', viewbox: 'viewBox', 'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin', 'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset', 'stroke-miterlimit': 'strokeMiterlimit', 'stroke-opacity': 'strokeOpacity',
  'fill-rule': 'fillRule', 'fill-opacity': 'fillOpacity', 'clip-rule': 'clipRule', 'clip-path': 'clipPath',
  'stop-color': 'stopColor', 'stop-opacity': 'stopOpacity', 'font-family': 'fontFamily', 'font-size': 'fontSize',
  'font-weight': 'fontWeight', 'text-anchor': 'textAnchor', 'dominant-baseline': 'dominantBaseline',
  'letter-spacing': 'letterSpacing', 'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace', 'xmlns:xlink': 'xmlnsXlink',
  'vector-effect': 'vectorEffect', 'shape-rendering': 'shapeRendering',
  'color-interpolation-filters': 'colorInterpolationFilters', 'flood-color': 'floodColor',
  'flood-opacity': 'floodOpacity', stddeviation: 'stdDeviation', gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform', patternunits: 'patternUnits', maskunits: 'maskUnits',
  clippathunits: 'clipPathUnits', preserveaspectratio: 'preserveAspectRatio', attributename: 'attributeName',
  repeatcount: 'repeatCount', keytimes: 'keyTimes', keysplines: 'keySplines', calcmode: 'calcMode',
  baseprofile: 'baseProfile',
};
const BOOL_ATTRS = new Set(['disabled', 'checked', 'selected', 'hidden', 'muted', 'autoplay', 'loop', 'playsinline',
  'controls', 'required', 'readonly', 'multiple', 'open', 'async', 'defer', 'nomodule', 'novalidate', 'autofocus',
  'default', 'ismap', 'reversed', 'itemscope']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr']);
const BACKSLASH = String.fromCharCode(92);
// node-html-parser lowercases tag names; React needs the camelCase SVG names.
const SVG_TAGS = ["feFlood","feBlend","feColorMatrix","feOffset","feGaussianBlur","feComposite","feMerge","feMergeNode","feDropShadow","feTurbulence","feDisplacementMap","feImage","feMorphology","feSpecularLighting","feDiffuseLighting","fePointLight","feSpotLight","feDistantLight","feComponentTransfer","feFuncA","feFuncR","feFuncG","feFuncB","feConvolveMatrix","feTile","linearGradient","radialGradient","clipPath","textPath","foreignObject","animateMotion","animateTransform","glyphRef","altGlyph"];
const TAG_MAP = Object.fromEntries(SVG_TAGS.map((t) => [t.toLowerCase(), t]));
const tagName = (node) => TAG_MAP[node.rawTagName.toLowerCase()] ?? node.rawTagName.toLowerCase();

function styleToObject(str) {
  const out = [];
  str.split(';').forEach((decl) => {
    const i = decl.indexOf(':');
    if (i < 0) return;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop) return;
    const key = prop.startsWith('--') ? JSON.stringify(prop) : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out.push(`${key}: ${JSON.stringify(val)}`);
  });
  return `{{ ${out.join(', ')} } as CSSProperties}`;
}
function escText(t) {
  return t
    .split(BACKSLASH).join(BACKSLASH + BACKSLASH)
    .replace(/[{}]/g, (m) => `{'${m}'}`)
    .replace(/>/g, '&gt;');
}
function attrs(node) {
  const parts = [];
  for (const [rawName, rawVal] of Object.entries(node.attributes)) {
    const lower = rawName.toLowerCase();
    let name = ATTR_MAP[lower] ?? rawName;
    if (name === 'style') { parts.push(`style=${styleToObject(rawVal)}`); continue; }
    if (BOOL_ATTRS.has(lower)) { parts.push(name); continue; }
    if (lower.startsWith('data-') || lower.startsWith('aria-')) name = rawName;
    // Astro serialised boolean `aria-hidden` as an empty attribute; React types want "true".
    if (lower === 'aria-hidden' && rawVal === '') { parts.push(`aria-hidden="true"`); continue; }
    parts.push(`${name}=${JSON.stringify(rawVal)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}
export function toJsx(node, depth = 0) {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) {
    const t = node.rawText;
    if (!t.trim()) return t.includes('\n') ? '' : (t ? '{" "}' : '');
    return pad + escText(t.replace(/\s+/g, ' ').trim());
  }
  if (node.nodeType === 8) return '';
  const tag = tagName(node);
  if (tag === 'script') return `${pad}{/* inline script removed: ${node.text.trim().slice(0, 60).replace(/[*]\//g, '')} */}`;
  if (VOID.has(tag)) return `${pad}<${tag}${attrs(node)} />`;
  const kids = node.childNodes;
  const onlyText = kids.every((k) => k.nodeType === 3);
  if (onlyText) {
    const txt = kids.map((k) => k.rawText).join('');
    const compact = txt.replace(/\s+/g, ' ').trim();
    if (!compact) return `${pad}<${tag}${attrs(node)}></${tag}>`;
    if (txt.startsWith(' ') || txt.endsWith(' ') || txt.startsWith('\n') || txt.endsWith('\n')) {
      return `${pad}<${tag}${attrs(node)}>{${JSON.stringify(txt.replace(/\s+/g, ' '))}}</${tag}>`;
    }
    return `${pad}<${tag}${attrs(node)}>${escText(compact)}</${tag}>`;
  }
  const inner = kids.map((k) => toJsx(k, depth + 1)).filter(Boolean).join('\n');
  return `${pad}<${tag}${attrs(node)}>\n${inner}\n${pad}</${tag}>`;
}
if (process.argv[1] && process.argv[1].endsWith('html-to-jsx.mjs')) {
  const [, , file, selector, mode] = process.argv;
  const root = parse(fs.readFileSync(file, 'utf8'), { comment: false });
  const nodes = mode === '--all' ? root.querySelectorAll(selector) : [root.querySelector(selector)];
  nodes.forEach((n, i) => {
    if (!n) { console.error('not found:', selector); process.exit(1); }
    if (i) console.log('\n{/* ---- */}\n');
    console.log(toJsx(n, 0));
  });
}
