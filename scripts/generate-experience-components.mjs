// Generates the JSX of the experience pages from the original HTML so the markup is
// preserved byte-for-byte (class names, ids, SVGs, letter-split labels, aria attributes).
// Output: components/experience/generated/*.tsx (committed; re-run after changing the source).
import { parse } from 'node-html-parser';
import fs from 'node:fs';
import path from 'node:path';
import { toJsx } from './html-to-jsx.mjs';

const SRC = path.resolve('original-site');
const OUT = path.resolve('components/experience/generated');
fs.mkdirSync(OUT, { recursive: true });

const LANGS = { en: '', ja: 'ja', fr: 'fr' };
const VIEWS = { top: '', about: 'about', contact: 'contact' };

const read = (slug) => parse(fs.readFileSync(path.join(SRC, slug, 'index.html'), 'utf8'), { comment: false });

const write = (name, body, propsType = '') => {
  const src = `// GENERATED FILE — do not edit. Source: original-site/*/index.html via scripts/generate-experience-components.mjs
import type { CSSProperties, JSX } from 'react';

export default function ${name}(${propsType}): JSX.Element {
  return (
${body
  .split('\n')
  .map((l) => '    ' + l)
  .join('\n')}
  );
}
`;
  fs.writeFileSync(path.join(OUT, `${name}.tsx`), src);
  console.log('wrote', name);
};

for (const [lang, prefix] of Object.entries(LANGS)) {
  const root = read(prefix);
  const L = lang[0].toUpperCase() + lang.slice(1);
  const header = root.querySelector('header#head');
  const labels = (fs.readFileSync(path.join(SRC, prefix, 'index.html'), 'utf8').match(/initialLabels = (\{[^}]+\})/) || [])[1];
  const i18n = labels ? JSON.parse(labels) : { mute: 'Mute Sound', unmute: 'Unmute Sound' };
  const sound = header.querySelector('.sound-button');
  sound.setAttribute('data-mute-label', i18n.mute);
  sound.setAttribute('data-unmute-label', i18n.unmute);
  write(`Header${L}`, toJsx(header));
  write(`Nav${L}`, toJsx(root.querySelector('nav.fixed-full')));
  write(`Loader${L}`, toJsx(root.querySelector('#loader')));
  const htibtn = root.querySelector('.htibtn');
  const close = root.querySelector('.htibtn-close');
  write(`InteractionButton${L}`, `<>\n${toJsx(htibtn, 1)}\n${toJsx(close, 1)}\n</>`);
  for (const [view, vslug] of Object.entries(VIEWS)) {
    const slug = [prefix, vslug].filter(Boolean).join('/');
    const page = read(slug);
    const taxiView = page.querySelector('[data-taxi-view]');
    const kids = taxiView.childNodes.filter((n) => n.nodeType === 1);
    const body = kids.length === 1 ? toJsx(kids[0]) : `<>\n${kids.map((k) => toJsx(k, 1)).join('\n')}\n</>`;
    const V = view[0].toUpperCase() + view.slice(1);
    write(`${V}View${L}`, body);
  }
}
console.log('done');
