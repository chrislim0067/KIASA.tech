/**
 * Downloads the gallery artwork referenced by Assets/gallery-data.js.
 *
 * The crawler only found the handful of pieces linked from HTML; the rest are
 * named in `window.WT_WORKS` as bare slugs and resolved at runtime, so they were
 * never discovered. Fetches into public/Assets (and mirrors into legacy/Assets
 * so the comparison server serves them too).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// The archived source site, not the rebranded one — this downloads originals.
const ORIGIN = 'https://webtactics.org';
const DIRS = [path.join(ROOT, 'public', 'Assets'), path.join(ROOT, 'legacy', 'Assets')];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const data = fs.readFileSync(path.join(ROOT, 'public', 'Assets', 'gallery-data.js'), 'utf8');
const slugs = [...data.matchAll(/\bsrc:\s*"([^"]+)"/g)].map((m) => m[1]);
console.log(`slugs in gallery-data.js: ${slugs.length}`);

// The runtime builds "Assets/Pieces/web/<slug>.webp" (see the <slug> placeholder
// the crawler choked on). robots.txt disallows Pieces/thumb and projects-source;
// Pieces/web is not disallowed.
let got = 0, had = 0, missing = [];
for (const slug of slugs) {
  const rel = `Pieces/web/${slug}.webp`;
  const dest = DIRS.map((d) => path.join(d, rel));
  if (dest.every((f) => fs.existsSync(f) && fs.statSync(f).size > 0)) { had++; continue; }
  try {
    const res = await fetch(`${ORIGIN}/Assets/${rel.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    for (const f of dest) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); }
    console.log(`  ${String(buf.length).padStart(8)}  ${rel}`);
    got++;
    await sleep(60);
  } catch (e) {
    missing.push(`${slug} (${e.message})`);
  }
}

console.log(`\ndownloaded=${got}  alreadyHad=${had}  missing=${missing.length}`);
for (const m of missing) console.log('  MISSING ' + m);
