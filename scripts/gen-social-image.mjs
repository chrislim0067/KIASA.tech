/**
 * Generates public/Assets/Social Sharing image.jpg — the og:image, the
 * homepage JSON-LD image, and the story picture on /about.
 *
 * The previous file was the old brand's glowing W in a neon ring on a violet
 * ground. This keeps that composition — the ring, the glow, the floor
 * reflection — and puts the KIASA wordmark where the W was, set from the same
 * Syncopate-Bold.ttf the wordmark and the 3D hero are built from. Same file,
 * same 1200×630, so nothing that references it changes.
 *
 *   node scripts/gen-social-image.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const FONT = path.join(ROOT, 'build-assets', 'Syncopate-Bold.ttf');
const OUT = path.join(ROOT, 'public', 'Assets', 'Social Sharing image.jpg');

const W = 1200;
const H = 630;
const ACCENT = '#d8b4fe';

const buf = fs.readFileSync(FONT);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/** Lay out with tracking (em), as the stylesheet expresses letter-spacing. */
function layout(text, size, tracking) {
  const extra = size * tracking;
  let x = 0;
  const parts = [];
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    parts.push(g.getPath(x, 0, size).toPathData(3));
    x += (g.advanceWidth / font.unitsPerEm) * size + extra;
  }
  return { d: parts.join(' '), width: x - extra };
}

const cx = W / 2;
const cy = H * 0.47;
const R = 200;

// The wordmark fills the ring's width with breathing room. Caps sit on the
// baseline, so centring them vertically means dropping it by half a cap.
const SIZE = 64;
const mark = layout('KIASA', SIZE, 0.14);
const mx = cx - mark.width / 2;
const my = cy + SIZE * 0.36;

const ring = (stroke = '#ffffff', width = 6) =>
  `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
const word = (fill = '#ffffff') =>
  `<path d="${mark.d}" fill="${fill}" transform="translate(${mx.toFixed(1)} ${my.toFixed(1)})"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="ground" cx="50%" cy="46%" r="62%">
      <stop offset="0%" stop-color="#3b1a6b"/>
      <stop offset="45%" stop-color="#1c0c36"/>
      <stop offset="100%" stop-color="#050308"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="reflect"><rect x="0" y="${cy + R + 10}" width="${W}" height="${H}" fill="url(#fade)"/></mask>
    <filter id="glowWide" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="28"/></filter>
    <filter id="glowTight" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#ground)"/>

  <!-- the reflection in the floor -->
  <g mask="url(#reflect)" transform="translate(0 ${2 * (cy + R + 10)}) scale(1 -1)" filter="url(#soft)">
    ${ring(ACCENT)}
    ${word(ACCENT)}
  </g>

  <!-- the glow: wide violet, then tight, under the crisp ring and mark -->
  <g filter="url(#glowWide)" opacity="0.95">
    ${ring(ACCENT, 14)}
    ${word(ACCENT)}
  </g>
  <g filter="url(#glowTight)" opacity="0.9">
    ${ring(ACCENT, 8)}
    ${word(ACCENT)}
  </g>
  ${ring()}
  ${word()}
</svg>`;

await sharp(Buffer.from(svg)).jpeg({ quality: 90, mozjpeg: true }).toFile(OUT);
console.log(`wrote ${path.relative(ROOT, OUT)} (${W}×${H})`);
