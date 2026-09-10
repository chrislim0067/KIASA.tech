/**
 * Generates the favicon: public/Assets/Favicon.png.
 *
 * KIASA has no symbol — the identity is the wordmark, and five letters are
 * illegible at 16px. So the icon is the wordmark's first letter, set in the
 * same Syncopate-Bold.ttf the wordmark and the 3D hero are built from, on the
 * brand ground, inside the thin ring the previous icon used. Nothing here is a
 * new mark; it is the logo's own initial in the logo's own face.
 *
 *   node scripts/gen-favicon.mjs
 *
 * 256×256 with alpha, matching what every JSON-LD block already declares for
 * this file (`"width":256,"height":256`) — so the schema stays true without
 * touching sixty-three files.
 */
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const FONT = path.join(ROOT, 'build-assets', 'Syncopate-Bold.ttf');
const OUT = path.join(ROOT, 'public', 'Assets', 'Favicon.png');

const SIZE = 256;
const GROUND = '#020204';
const ACCENT = '#d8b4fe';
const INK = '#ffffff';

const buf = fs.readFileSync(FONT);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

// The K, centred optically: Syncopate's K is wide and its bounding box is a
// fair stand-in for its visual centre, so centre the box.
const glyph = font.charToGlyph('K');
const fontSize = SIZE * 0.5;
const p = glyph.getPath(0, 0, fontSize);
const b = p.getBoundingBox();
const dx = SIZE / 2 - (b.x1 + b.x2) / 2;
const dy = SIZE / 2 - (b.y1 + b.y2) / 2;
const d = glyph.getPath(dx, dy, fontSize).toPathData(3);

const c = SIZE / 2;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <radialGradient id="g" cx="50%" cy="42%" r="60%">
      <stop offset="0%" stop-color="#14101c"/>
      <stop offset="100%" stop-color="${GROUND}"/>
    </radialGradient>
  </defs>
  <circle cx="${c}" cy="${c}" r="${c - 4}" fill="url(#g)"/>
  <circle cx="${c}" cy="${c}" r="${c - 9}" fill="none" stroke="${ACCENT}" stroke-width="5" opacity="0.95"/>
  <path d="${d}" fill="${INK}"/>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`wrote ${path.relative(ROOT, OUT)} (${SIZE}×${SIZE})`);
