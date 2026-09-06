/**
 * Extracts the crawled legacy site into the Next.js project.
 *
 * CSS and JS are copied BYTE-FOR-BYTE — nothing is retyped or reformatted.
 * Only routing and metadata are re-derived. Re-runnable: `npm run extract`.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LEGACY = path.join(ROOT, 'legacy');
const OUT = {

  html: path.join(ROOT, 'content', 'pages'),
  js: path.join(ROOT, 'public', 'generated'),
  lib: path.join(ROOT, 'lib', 'generated'),
};
Object.values(OUT).forEach((d) => fs.mkdirSync(d, { recursive: true }));

/* ---------------------------------------------------------------- routing */

/** legacy file path -> route + storage key (+ query param for the ?s= / ?slug= families) */
function mapRoute(file) {
  const rel = file.split(path.sep).join('/').replace(/^legacy\//, '').replace(/\.html$/, '');
  if (rel === 'index') return { route: '/', key: 'home', segment: '' };
  const m = rel.match(/^([^_]+)__(s|slug)=(.+)$/);
  if (m) {
    return {
      route: '/' + m[1],
      key: m[1] + '__' + m[3],
      segment: m[1],
      param: { name: m[2], value: m[3] },
    };
  }
  return { route: '/' + rel, key: rel.split('/').join('__'), segment: rel };
}

/* ------------------------------------------------------------- extraction */

const RE_STYLE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const RE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function attr(tag, name) {
  if (!tag) return undefined;
  const dq = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  if (dq) return dq[1];
  const sq = tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i'));
  return sq ? sq[1] : undefined;
}

/** true for <script> types we execute; ld+json and friends stay in the markup */
const isExecutable = (type) => !type || /javascript|module/i.test(type);

/**
 * Third-party analytics. Tagged so the runtime can hold them back on localhost —
 * running them in dev would write into the real GTM / GA4 / Meta properties.
 * Production behaviour is unchanged (see NEXT_PUBLIC_WT_ANALYTICS).
 */
const ANALYTICS_SRC = /googletagmanager\.com|connect\.facebook\.net|google-analytics\.com/i;

/**
 * Inline vendor *bootstraps* only — the snippets whose whole job is to load GTM,
 * the Meta Pixel or gtag. Deliberately narrow: page logic that merely fires an
 * event (`fbq('track', …)`, `gtag('event', …)`) must NOT match. Matching on a
 * bare `fbq(` once held back contact/04.js — the contact form's own submit
 * handler and phone-country picker — and silently broke the page.
 */
const ANALYTICS_INLINE = /'gtm\.start'|"gtm\.start"|connect\.facebook\.net|fbevents\.js|gtag\s*\(\s*['"]js['"]/i;

/**
 * Blank out the *interior* of every HTML comment, preserving byte offsets.
 * This site's comments contain literal "<body>" and "<script>" text (see about.html:20),
 * which otherwise hijacks boundary detection. Offsets from the masked copy index
 * correctly into the original.
 */
/**
 * Roots and percent-encodes an /Assets URL.
 *
 * Two separate problems in the original:
 *   - index.html writes some of these page-relative ("Assets/wt-track.js"),
 *     which resolves against the route on nested URLs like /ar/… and 404s.
 *   - Filenames contain spaces, "+" and "&" ("100+ Websites Delivered.jpg").
 *     Raw, those are invalid in a URL; Next's static handler decodes "+" as a
 *     space and returns 404 where the PHP server happened to be lenient.
 *
 * The file on disk is untouched — only the URL that points at it is spelled
 * correctly. Decode-then-encode keeps already-encoded paths (%20) idempotent.
 */
function encodeAssetUrl(raw) {
  const rooted = raw.startsWith('/') ? raw : '/' + raw.replace(/^\.\//, '');
  return rooted
    .split('/')
    .map((seg) => {
      let decoded = seg;
      try { decoded = decodeURIComponent(seg); } catch { /* leave as-is */ }
      return encodeURIComponent(decoded);
    })
    .join('/');
}

/**
 * Same fix inside JS string literals — the hero's data model holds
 * `img:"Assets/100+ Websites Delivered.jpg"` and builds `background-image` from
 * it at runtime, so HTML/CSS rewriting alone leaves those images 404ing.
 *
 * Deliberately narrow: only a complete quoted string that starts with Assets/
 * and ends in a file extension. This is the one place the extracted JS is not
 * byte-identical to the original.
 */
function normaliseAssetUrlsInJs(code) {
  return code.replace(/(['"])((?:\/)?Assets\/[^'"\n]+?\.[A-Za-z0-9]{2,5})\1/g, (all, q, url) => `${q}${encodeAssetUrl(url)}${q}`);
}

/**
 * Attribute and <title> text is read straight out of the HTML source, so
 * entities are still encoded ("Let&#039;s Build"). The browser decoded those on
 * parse; Next's `metadata` export re-escapes whatever string it is given, so
 * passing the raw entity through renders a literal "Let&#039;s" in the tab.
 */
const NAMED_ENTITIES = {
  quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  times: '×', deg: '°', trade: '™', copy: '©', reg: '®', euro: '€', pound: '£',
};

function decodeOnce(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (all, name) => NAMED_ENTITIES[name.toLowerCase()] ?? all)
    .replace(/&amp;/g, '&'); // last, so "&amp;#039;" does not double-decode
}

/**
 * Two passes, because several og:title/description values in the original are
 * double-encoded ("&amp;mdash;"). One pass yields a literal "&mdash;" — which is
 * exactly what the live site prints in its social previews today. A second pass
 * resolves it. This is bounded: a plain "&amp;" becomes "&" on pass one and has
 * nothing left to decode on pass two, so ampersands in copy are safe.
 */
function decodeEntities(s) {
  if (!s) return s;
  const once = decodeOnce(s);
  return decodeOnce(once);
}

/** Fix every /Assets reference in an HTML or CSS blob. */
function normaliseAssetUrls(text) {
  const SKIP = /^(https?:|\/\/|#|mailto:|tel:|data:|javascript:)/i;
  return text
    // src="Assets/…" / href / poster / data-src
    .replace(/\b(src|href|poster|data-src)=("|')([^"']*?Assets\/[^"']*)\2/gi, (all, attr, q, url) =>
      SKIP.test(url) ? all : `${attr}=${q}${encodeAssetUrl(url)}${q}`
    )
    // url('Assets/…') inside style attributes and stylesheets
    .replace(/url\((\s*)(["']?)([^)"']*?Assets\/[^)"']*)\2(\s*)\)/gi, (all, s1, q, url, s2) =>
      SKIP.test(url) ? all : `url(${s1}${q}${encodeAssetUrl(url)}${q}${s2})`
    );
}

function maskComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (c) => '<!--' + ' '.repeat(Math.max(0, c.length - 7)) + '-->');
}

function extract(html, key) {
  const masked = maskComments(html);

  const headEnd = masked.search(/<\/head>/i);
  const head = html.slice(0, headEnd);
  const bodyOpen = masked.search(/<body\b/i);
  const bodyTag = (masked.slice(bodyOpen).match(/<body\b[^>]*>/i) || ['<body>'])[0];
  const bodyEnd = masked.search(/<\/body>/i);
  const body = html.slice(bodyOpen + bodyTag.length, bodyEnd === -1 ? html.length : bodyEnd);

  // Ranges covered by <noscript>. Anything inside only applies when scripting is
  // OFF; the browser never parses it otherwise.
  const noscriptRanges = [];
  for (const m of masked.matchAll(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi)) {
    noscriptRanges.push([m.index, m.index + m[0].length]);
  }
  const inNoscript = (i) => noscriptRanges.some(([a, b]) => i >= a && i < b);

  // ---- styles, in document order, byte-preserved.
  // The <noscript> block carries a no-JS stylesheet that hides every
  // script-driven element with display:none!important (gallery.html:1). Hoisting
  // that into the page stylesheet applies it unconditionally and blanks the page.
  const css = [];
  for (const m of masked.matchAll(RE_STYLE)) {
    if (inNoscript(m.index)) continue;
    css.push(m[2]);
  }

  // ---- scripts, in document order; inline bodies written to disk verbatim
  const scripts = [];
  let n = 0;
  for (const m of masked.matchAll(RE_SCRIPT)) {
    const tag = m[1];
    const code = m[2];
    const type = (attr(tag, 'type') || '').toLowerCase();
    if (!isExecutable(type) || inNoscript(m.index)) continue;
    const src = attr(tag, 'src');
    const isModule = type === 'module';
    const inHead = m.index < headEnd;

    if (src) {
      scripts.push({
        kind: 'external',
        // index.html writes these page-relative ("Assets/wt-track.js"); that resolves
        // against the route on nested URLs like /ar/… and 404s. Root them.
        src: /^(https?:)?\/\//i.test(src) || src.startsWith('/') ? src : '/' + src.replace(/^\.\//, ''),
        module: isModule,
        defer: /\bdefer\b/i.test(tag),
        async: /\basync\b/i.test(tag),
        inHead,
        analytics: ANALYTICS_SRC.test(src),
      });
    } else if (code.trim()) {
      const file = String(n++).padStart(2, '0') + (isModule ? '.mjs' : '.js');
      const dir = path.join(OUT.js, key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), normaliseAssetUrlsInJs(code)); // byte-for-byte apart from /Assets URL encoding
      scripts.push({ kind: 'inline', src: '/generated/' + key + '/' + file, module: isModule, inHead, analytics: ANALYTICS_INLINE.test(code) });
    }
  }

  // ---- markup: body minus executable <script> and <style> (both re-injected in order).
  // Ranges are located on the masked body so commented-out tags are left untouched.
  const maskedBody = maskComments(body);
  const cuts = [];
  for (const m of maskedBody.matchAll(RE_SCRIPT)) {
    if (isExecutable((attr(m[1], 'type') || '').toLowerCase())) cuts.push([m.index, m.index + m[0].length]);
  }
  for (const m of maskedBody.matchAll(RE_STYLE)) cuts.push([m.index, m.index + m[0].length]);
  cuts.sort((a, b) => a[0] - b[0]);
  let markup = '';
  let cursor = 0;
  for (const [start, end] of cuts) {
    if (start < cursor) continue;
    markup += body.slice(cursor, start);
    cursor = end;
  }
  markup += body.slice(cursor);

  markup = normaliseAssetUrls(markup);

  // ---- import map (index, gallery, contact). It maps bare "three" / "gsap"
  // specifiers to CDN URLs. It lived in <head>, and a module script cannot
  // resolve those specifiers without it, so it has to be re-emitted or every
  // `import ... from 'three'` throws and the WebGL scenes never start.
  let importMap;
  for (const m of masked.matchAll(/<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    importMap = html.slice(m.index, m.index + m[0].length).replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
  }

  // ---- head extras Next's <metadata> export does not cover
  const maskedHead = masked.slice(0, headEnd);
  const jsonLd = [];
  for (const m of maskedHead.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    jsonLd.push(head.slice(m.index, m.index + m[0].length).replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim());
  }

  // external stylesheets linked from the head, in order (e.g. /Assets/site.css)
  const stylesheets = [];
  for (const m of maskedHead.matchAll(/<link\b[^>]*>/gi)) {
    const tag = head.slice(m.index, m.index + m[0].length);
    if (/rel\s*=\s*["']stylesheet["']/i.test(tag)) {
      const href = attr(tag, 'href');
      if (href) stylesheets.push(href);
    }
  }

  // every <meta name|property> in the head, so nothing is silently dropped
  const metaAll = [];
  for (const m of maskedHead.matchAll(/<meta\b[^>]*>/gi)) {
    const name = attr(m[0], 'name');
    const property = attr(m[0], 'property');
    const content = attr(m[0], 'content');
    if ((name || property) && content !== undefined) metaAll.push({ name, property, content });
  }

  // find on the masked head, read the bytes back out of the real head
  const metaTag = (re) => {
    const m = maskedHead.match(re);
    return m ? head.slice(m.index, m.index + m[0].length) : undefined;
  };
  const titleMatch = maskedHead.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const meta = {
    title: titleMatch
      ? decodeEntities(head.slice(titleMatch.index, titleMatch.index + titleMatch[0].length).replace(/<\/?title[^>]*>/gi, '').trim()) || undefined
      : undefined,
    description: decodeEntities(attr(metaTag(/<meta[^>]+name\s*=\s*"description"[^>]*>/i), 'content')),
    canonical: attr(metaTag(/<link[^>]+rel\s*=\s*"canonical"[^>]*>/i), 'href'),
    ogImage: attr(metaTag(/<meta[^>]+property\s*=\s*"og:image"[^>]*>/i), 'content'),
    ogTitle: decodeEntities(attr(metaTag(/<meta[^>]+property\s*=\s*"og:title"[^>]*>/i), 'content')),
    lang: (html.match(/<html[^>]+lang\s*=\s*"([^"]*)"/i) || [])[1] || 'en',
    dir: (html.match(/<html[^>]+dir\s*=\s*"([^"]*)"/i) || [])[1] || 'ltr',
    bodyClass: attr(bodyTag, 'class') || '',
    bodyId: attr(bodyTag, 'id') || '',
  };

  return { css, scripts, markup, meta, jsonLd, metaAll, stylesheets, importMap };
}

/* ------------------------------------------------------------------- main */

function collectFiles() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'Assets') walk(path.join(dir, e.name), prefix + e.name + '/');
      else if (e.isFile() && e.name.endsWith('.html')) out.push('legacy/' + prefix + e.name);
    }
  };
  walk(LEGACY, '');
  return out.sort();
}

const manifest = {};
let cssBytes = 0;
let inlineCount = 0;

for (const rel of collectFiles()) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const r = mapRoute(rel);
  const { css, scripts, markup, meta, jsonLd, metaAll, stylesheets, importMap } = extract(html, r.key);

  if (css.length) {
    const joined = css.join('\n');
    const dir = path.join(OUT.js, r.key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page.css'), joined);
    cssBytes += joined.length;
  }
  fs.writeFileSync(path.join(OUT.html, r.key + '.html'), markup);
  inlineCount += scripts.filter((s) => s.kind === 'inline').length;

  if (jsonLd.length) fs.writeFileSync(path.join(OUT.html, r.key + '.jsonld.json'), JSON.stringify(jsonLd, null, 2));
  manifest[r.key] = { ...r, meta, metaAll, stylesheets, importMap: importMap ?? null, jsonLdCount: jsonLd.length, hasCss: css.length > 0, scripts };
}

fs.writeFileSync(path.join(OUT.lib, 'pages.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(
  path.join(OUT.lib, 'pages.ts'),
  [
    '// GENERATED by scripts/extract.mjs — do not edit by hand.',
    "import raw from './pages.json';",
    "import type { PageManifest } from '@/types/page';",
    '',
    'export const pages = raw as unknown as PageManifest;',
    'export type PageKey = keyof typeof raw;',
    '',
  ].join('\n')
);

const byRoute = {};
for (const [key, p] of Object.entries(manifest)) {
  (byRoute[p.route] ||= []).push({ key, param: p.param || null });
}

console.log(
  'pages=' + Object.keys(manifest).length +
  '  cssBytes=' + cssBytes +
  '  inlineScripts=' + inlineCount
);
console.log('\nroutes:');
for (const [route, variants] of Object.entries(byRoute).sort()) {
  const named = variants.find((v) => v.param);
  const note = variants.length > 1 ? variants.length + ' variants' + (named ? ' (?' + named.param.name + '=)' : '') : '';
  console.log('  ' + route.padEnd(28) + ' ' + note);
}
