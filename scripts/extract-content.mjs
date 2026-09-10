// Extracts the pages of the original build into JSON:
//  - content/pages/*.json       static content pages (rendered verbatim by app/(content))
//  - content/experience/*.json  <head> metadata of the 9 experience pages
import { parse } from 'node-html-parser';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('original-site');
const OUT = path.resolve('content/pages');
const EXP_OUT = path.resolve('content/experience');
const EXPERIENCE = new Set(['', 'about', 'contact', 'ja', 'ja/about', 'ja/contact', 'fr', 'fr/about', 'fr/contact']);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(EXP_OUT, { recursive: true });

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name === 'index.html') acc.push(p);
  }
  return acc;
}

const idOf = (slug) => (slug === '' ? 'index' : slug.replace(/\//g, '__'));

const index = [];
for (const file of walk(SRC)) {
  const slug = path.relative(SRC, path.dirname(file)).split(path.sep).join('/');
  const html = fs.readFileSync(file, 'utf8');
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true } });
  const head = root.querySelector('head');
  const body = root.querySelector('body');
  const lang = root.querySelector('html')?.getAttribute('lang') ?? 'en';
  const meta = [];
  const links = [];
  const jsonLd = [];
  let title = '';
  const stylesheets = [];
  for (const el of head.childNodes.filter((n) => n.nodeType === 1)) {
    const tag = el.rawTagName.toLowerCase();
    if (tag === 'title') title = el.text;
    else if (tag === 'meta') {
      const a = el.attributes;
      if (a.charset || a.name === 'viewport') continue;
      meta.push(a);
    } else if (tag === 'link') {
      const a = el.attributes;
      if (a.rel === 'stylesheet') {
        stylesheets.push(a.href);
        continue;
      }
      if (['icon', 'apple-touch-icon', 'manifest', 'sitemap'].includes(a.rel)) continue;
      links.push(a);
    } else if (tag === 'script' && el.getAttribute('type') === 'application/ld+json') jsonLd.push(el.text.trim());
  }

  if (EXPERIENCE.has(slug)) {
    fs.writeFileSync(path.join(EXP_OUT, idOf(slug) + '.json'), JSON.stringify({ slug, lang, title, meta, links, jsonLd }));
    continue;
  }

  const bodyClass = body.getAttribute('class') ?? '';
  // drop the shared inline scripts / GTM noscript; everything else stays verbatim
  body.querySelectorAll('noscript').forEach((n) => {
    if (n.innerHTML.includes('googletagmanager')) n.remove();
  });
  body.querySelectorAll('script').forEach((s) => {
    if (s.getAttribute('type') === 'application/json') return; // data for the contact form
    s.remove();
  });
  const features = [];
  if (body.querySelector('#contact-form')) features.push('contact-form');
  if (body.querySelector('.prompt-block')) features.push('copy-blocks');
  if (body.querySelector('.lp-faq')) features.push('faq');
  if (body.querySelector('.web-x-posts')) features.push('x-posts');
  const contentHtml = body.innerHTML.trim();
  const id = idOf(slug);
  fs.writeFileSync(path.join(OUT, id + '.json'), JSON.stringify({ slug, lang, title, stylesheets, bodyClass, meta, links, jsonLd, features, html: contentHtml }));
  index.push({ slug, id, lang, title, stylesheets, features, bytes: contentHtml.length });
}
index.sort((a, b) => a.slug.localeCompare(b.slug));
fs.writeFileSync(path.join(OUT, '_index.json'), JSON.stringify(index, null, 1));
console.log('content pages:', index.length, '| experience pages:', fs.readdirSync(EXP_OUT).length);
const byCss = {};
index.forEach((p) => {
  const k = p.stylesheets.join('+');
  byCss[k] = (byCss[k] || 0) + 1;
});
console.log(byCss);
const byFeature = {};
index.forEach((p) => p.features.forEach((f) => (byFeature[f] = (byFeature[f] || 0) + 1)));
console.log(byFeature);
