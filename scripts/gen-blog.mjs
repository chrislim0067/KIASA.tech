/**
 * Builds content/blog-posts.json — the payload /api/blog-posts serves.
 *
 * The live endpoint is PHP backed by the real CMS. Every field it returns is
 * recoverable from the crawled post pages' own metadata, so the local grid
 * renders the real ten articles instead of an "unavailable" state. Replace this
 * with the real datasource when the PHP side is wired up.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'generated', 'pages.json'), 'utf8'));

/**
 * Attribute values are read straight out of the HTML source, so entities are
 * still encoded ("Bolt&#039;s"). A browser would have decoded them on parse;
 * JSON consumers will not, so do it here.
 */
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last: otherwise "&amp;#039;" double-decodes
}

const val = (metaAll, id) => decodeEntities(metaAll.find((m) => (m.property ?? m.name) === id)?.content);

/** Strip tags and count words to estimate reading time, matching the "N min read" label. */
function readTime(key) {
  const file = path.join(ROOT, 'content', 'pages', `${key}.html`);
  if (!fs.existsSync(file)) return '5 min read';
  const text = fs
    .readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  return `${Math.max(1, Math.round(text.trim().split(' ').length / 200))} min read`;
}

const posts = Object.values(manifest)
  .filter((p) => p.segment === 'blog-post' && p.param)
  .map((p) => {
    const src = p.metaAll;
    const image = val(src, 'og:image') ?? '';
    return {
      slug: p.param.value,
      title: val(src, 'og:title') ?? decodeEntities(p.meta.title) ?? p.param.value,
      excerpt: decodeEntities(p.meta.description) ?? '',
      category: val(src, 'article:section') ?? 'Insights',
      post_date: (val(src, 'article:published_time') ?? '').slice(0, 10),
      read_time: readTime(p.key),
      // Serve from our own /Assets rather than the production origin.
      // Serve from our own /Assets. Accepts either domain: the manifest holds the
      // source domain before scripts/rebrand.mjs runs and the new one after.
      thumbnail: image.replace(/^https?:\/\/(?:webtactics\.org|kiasa\.tech)/, ''),
      featured: false,
    };
  })
  .sort((a, b) => (a.post_date < b.post_date ? 1 : -1));

if (posts.length) posts[0].featured = true;

fs.mkdirSync(path.join(ROOT, 'content'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'content', 'blog-posts.json'), JSON.stringify(posts, null, 2));

console.log(`blog posts: ${posts.length}`);
for (const p of posts) console.log(`  ${p.post_date}  ${p.category.padEnd(12)} ${p.title.slice(0, 58)}`);
