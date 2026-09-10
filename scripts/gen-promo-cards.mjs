/**
 * Renders the KIASA-branded sequences for the promo film as PNG frame runs.
 *
 * The source promo was the previous brand's, and four of its moments carried
 * that identity: an opening logo reveal, a DUBAI title card, a full-frame
 * "2024", and an outro on webtactics.org. None could be patched in place — the
 * year scales and drifts with chromatic fringing, and both logo moments are
 * animated reveals, so matching them would need motion tracking. They are
 * re-rendered here instead, and every other frame of footage is the original.
 *
 * Two further runs — SERVICES and STATS — are new. The source ran 15s and had
 * no room to say what the studio actually does; these carry the figures the
 * site already states on /about and the homepage.
 *
 * Text becomes vector paths via opentype so nothing depends on a font being
 * installed — Syncopate-Bold.ttf is the same file scripts/gen-brand-logo.mjs
 * builds the 3D wordmark from, so the letterforms are the site's own.
 *
 *   node scripts/gen-promo-cards.mjs <out-dir>
 *
 * Then splice against the source. The film carries no audio, so these runs can
 * be re-timed freely — lengths here are the only thing that sets the cut.
 *
 *   ffmpeg -i "<source>.mp4" \
 *     -framerate 30 -i <out>/logo/%04d.png -framerate 30 -i <out>/city/%04d.png \
 *     -framerate 30 -i <out>/year/%04d.png -framerate 30 -i <out>/services/%04d.png \
 *     -framerate 30 -i <out>/stats/%04d.png -framerate 30 -i <out>/end/%04d.png \
 *     -filter_complex "\
 *   [0:v]trim=start_frame=0:end_frame=20,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a0];\
 *   [1:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a1];\
 *   [0:v]trim=start_frame=42:end_frame=55,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a2];\
 *   [2:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a3];\
 *   [0:v]trim=start_frame=72:end_frame=200,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a4];\
 *   [3:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a5];\
 *   [0:v]trim=start_frame=258:end_frame=378,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a6];\
 *   [4:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a7];\
 *   [5:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a8];\
 *   [6:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a9];\
 *   [a0][a1][a2][a3][a4][a5][a6][a7][a8][a9]concat=n=10:v=1:a=0,fps=30[vout]" \
 *     -map "[vout]" -an -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p \
 *     -movflags +faststart "public/Assets/KIASA Promo.mp4"
 *
 * 750 frames at 30fps — 25.000s, silent.
 */
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';

const ROOT = process.cwd();
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node scripts/gen-promo-cards.mjs <output-dir>');

const W = 1920;
const H = 1080;
const FPS = 30;
const ACCENT = '#d8b4fe';

const buf = fs.readFileSync(path.join(ROOT, 'build-assets', 'Syncopate-Bold.ttf'));
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/**
 * Lay out a string with explicit tracking. opentype's getPath applies only the
 * font's own metric spacing, and Syncopate at display sizes needs more air than
 * that. `tracking` is in em, matching how the stylesheet writes letter-spacing.
 */
function layout(text, size, tracking = 0) {
  const extra = size * tracking;
  let x = 0;
  const parts = [];
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    parts.push(g.getPath(x, 0, size).toPathData(3));
    x += (g.advanceWidth / font.unitsPerEm) * size + extra;
  }
  // The trailing gap after the last glyph is not part of the visible run.
  return { d: parts.join(' '), width: x - extra };
}

/** Centre a run horizontally, baseline at `baseline`. */
function centred(text, size, tracking, baseline) {
  const { d, width } = layout(text, size, tracking);
  return { d, x: (W - width) / 2, y: baseline, width };
}

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const ease = (t) => { const u = clamp01(t); return u * u * (3 - 2 * u); };
/** Decelerating ease, for things that should arrive rather than drift in. */
const outCubic = (t) => { const u = clamp01(t); return 1 - Math.pow(1 - u, 3); };

/** Shared dark ground. Every card sits on the same base so cuts don't flicker. */
const GROUND = (id, inner = '#0d0d14', outer = '#030305', cy = '50%') => `
  <radialGradient id="${id}" cx="50%" cy="${cy}" r="75%">
    <stop offset="0%" stop-color="${inner}"/>
    <stop offset="100%" stop-color="${outer}"/>
  </radialGradient>`;

/* ------------------------------------------------------------------ LOGO
 * Replaces the old W-mark reveal. A light bar travels across the frame and
 * the wordmark is cut in behind it, then blooms once and settles — the
 * wordmark arrives on a beat instead of dissolving up out of nothing.
 */
function logoFrame(i, n) {
  const t = i / (n - 1);
  const mark = centred('KIASA', 176, 0.20, H / 2 + 24);

  // The bar runs a little past both edges of the wordmark so the first and
  // last letters are cut by a moving edge rather than appearing at rest.
  const from = mark.x - 90;
  const to = mark.x + mark.width + 90;
  const sweep = outCubic(t / 0.42);
  const barX = from + (to - from) * sweep;
  const barA = (1 - ease(clamp01((t - 0.34) / 0.14))) * ease(clamp01(t / 0.06));

  // One bloom as the sweep lands, then it falls back to a steady glow.
  const bloom = ease(clamp01((t - 0.30) / 0.12)) * (1 - ease(clamp01((t - 0.44) / 0.26)));
  const glow = 0.12 + 0.30 * bloom;
  const ruleW = 340 * outCubic(clamp01((t - 0.46) / 0.30));
  const out = 1 - ease(clamp01((t - 0.88) / 0.12));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      ${GROUND('g')}
      <radialGradient id="bloom" cx="50%" cy="50%" r="60%">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.9"/>
        <stop offset="45%" stop-color="${ACCENT}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0"/>
        <stop offset="50%" stop-color="#ffffff" stop-opacity="1"/>
        <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="reveal">
        <rect x="0" y="0" width="${barX.toFixed(1)}" height="${H}"/>
      </clipPath>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <rect width="${W}" height="${H}" fill="url(#bloom)" opacity="${(glow * out).toFixed(4)}"/>
    <g clip-path="url(#reveal)">
      <path d="${mark.d}" fill="#ffffff" opacity="${out.toFixed(4)}"
            transform="translate(${mark.x} ${mark.y})"/>
    </g>
    <rect x="${(barX - 26).toFixed(1)}" y="${H / 2 - 150}" width="52" height="300"
          fill="url(#bar)" opacity="${(0.85 * barA * out).toFixed(4)}"/>
    <rect x="${((W - ruleW) / 2).toFixed(1)}" y="${H / 2 + 76}" width="${ruleW.toFixed(1)}" height="1"
          fill="${ACCENT}" opacity="${(0.6 * out).toFixed(4)}"/>
  </svg>`;
}

/* ------------------------------------------------------------------ CITY
 * Replaces the DUBAI card. KIASA is Singapore-based — /about, the homepage
 * badge and every JSON-LD address say so — so the city changes with the brand.
 * The ring of repeating type is the original card's device, kept.
 */
function cityFrame(i, n) {
  const t = i / (n - 1);
  const a = ease(clamp01(t / 0.18)) * (1 - ease(clamp01((t - 0.82) / 0.18)));
  const city = centred('SINGAPORE', 104, 0.30, H / 2 + 36);
  const drift = 14 * (1 - outCubic(t));

  const ringRun = layout('SINGAPORE BASED   '.repeat(14), 21, 0.16);
  const edge = (transform) =>
    `<path d="${ringRun.d}" fill="#ffffff" opacity="${(0.34 * a).toFixed(4)}" transform="${transform}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      ${GROUND('cg', '#1a0f0c', '#030204', '62%')}
      <radialGradient id="ember" cx="50%" cy="60%" r="34%">
        <stop offset="0%" stop-color="#ff7a3c" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#ff7a3c" stop-opacity="0"/>
      </radialGradient>
      <clipPath id="frame"><rect width="${W}" height="${H}"/></clipPath>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#cg)"/>
    <rect width="${W}" height="${H}" fill="url(#ember)" opacity="${a.toFixed(4)}"/>
    <g clip-path="url(#frame)">
      ${edge('translate(-140 46)')}
      ${edge(`translate(-140 ${H - 20})`)}
      ${edge(`translate(46 ${H + 140}) rotate(-90)`)}
      ${edge(`translate(${W - 30} -140) rotate(90)`)}
    </g>
    <path d="${city.d}" fill="#ffffff" opacity="${a.toFixed(4)}"
          transform="translate(${city.x} ${(city.y + drift).toFixed(1)})"/>
  </svg>`;
}

/* ------------------------------------------------------------------ YEAR
 * Replaces the full-frame "2024". Same idea as the original — a huge outlined
 * year with a word cycling over it — with the year right, the typeface the
 * site's own, and "competetive" spelled correctly.
 */
function yearFrame(i, n) {
  const t = i / (n - 1);
  const fade = ease(clamp01(t / 0.10)) * (1 - ease(clamp01((t - 0.90) / 0.10)));
  const scale = 1 + 0.05 * t;

  // Digits are cap-height, so centring them means dropping the baseline by
  // half a cap rather than half an em.
  const SIZE = 440;
  const year = centred('2026', SIZE, 0.06, H / 2 + SIZE * 0.35);

  const words = ['EFFECTIVE', 'COMPETITIVE', 'PRODUCTIVE'];
  const slot = Math.min(words.length - 1, Math.floor(t * words.length));
  const local = t * words.length - slot;
  const wordA = ease(clamp01(local / 0.20)) * (1 - ease(clamp01((local - 0.74) / 0.26)));
  const word = centred(words[slot], 44, 0.42, H / 2 + 15);

  // Two offset copies stand in for the original's chromatic fringing.
  const fringe = (dx, colour) => `<path d="${year.d}" fill="none" stroke="${colour}"
      stroke-width="2.5" opacity="${(0.30 * fade).toFixed(4)}"
      transform="translate(${year.x + dx} ${year.y})"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      ${GROUND('yg', '#12121a', '#040407', '45%')}
      <linearGradient id="stroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#8fa6c4"/>
        <stop offset="50%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="${ACCENT}"/>
      </linearGradient>
      <!-- Sits under the cycling word so it stays legible where it crosses a
           numeral stroke, without the hard edge a rect would give. -->
      <radialGradient id="wordbg" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#050508" stop-opacity="0.92"/>
        <stop offset="55%" stop-color="#050508" stop-opacity="0.72"/>
        <stop offset="100%" stop-color="#050508" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#yg)"/>
    <g transform="translate(${W / 2} ${H / 2}) scale(${scale.toFixed(4)}) translate(${-W / 2} ${-H / 2})">
      ${fringe(-5, '#ff4d6a')}
      ${fringe(5, '#4de1ff')}
      <path d="${year.d}" fill="none" stroke="url(#stroke)" stroke-width="2.5"
            opacity="${(0.92 * fade).toFixed(4)}" transform="translate(${year.x} ${year.y})"/>
    </g>
    <ellipse cx="${W / 2}" cy="${H / 2}" rx="${(word.width / 2 + 130).toFixed(1)}" ry="70"
             fill="url(#wordbg)" opacity="${(wordA * fade).toFixed(4)}"/>
    <path d="${word.d}" fill="#ffffff" opacity="${(wordA * fade).toFixed(4)}"
          transform="translate(${word.x} ${word.y})"/>
  </svg>`;
}

/* -------------------------------------------------------------- SERVICES
 * New. The source never said what the studio does. These are the four the
 * homepage leads with, one per beat, each cutting rather than dissolving.
 */
const SERVICES = ['IMMERSIVE WEB', 'CUSTOM PLATFORMS', 'AI AUTOMATION', 'BRAND IDENTITY'];

function servicesFrame(i, n) {
  const per = n / SERVICES.length;
  const slot = Math.min(SERVICES.length - 1, Math.floor(i / per));
  const local = (i - slot * per) / per;

  // Two or three frames either side, not a fifth of the beat: a long fade
  // leaves a third of a second of black between names, which reads as dead
  // air rather than as rhythm. The motion carries the transition instead.
  const a = ease(clamp01(local / 0.07)) * (1 - ease(clamp01((local - 0.91) / 0.09)));
  const rise = 40 * (1 - outCubic(clamp01(local / 0.34)));

  const label = centred(SERVICES[slot], 92, 0.16, H / 2 + 30);
  const index = layout(String(slot + 1).padStart(2, '0'), 26, 0.30);
  // The index sits on the same left edge as the label, one line above it.
  const ruleW = (label.width + 120) * outCubic(clamp01(local / 0.40));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>${GROUND('sg', '#0e0e16', '#030305')}</defs>
    <rect width="${W}" height="${H}" fill="url(#sg)"/>
    <path d="${index.d}" fill="${ACCENT}" opacity="${(0.85 * a).toFixed(4)}"
          transform="translate(${label.x.toFixed(1)} ${H / 2 - 92 + rise * 0.5})"/>
    <g transform="translate(0 ${rise.toFixed(2)})">
      <path d="${label.d}" fill="#ffffff" opacity="${a.toFixed(4)}"
            transform="translate(${label.x} ${label.y})"/>
    </g>
    <rect x="${((W - ruleW) / 2).toFixed(1)}" y="${H / 2 + 74}" width="${ruleW.toFixed(1)}" height="1"
          fill="${ACCENT}" opacity="${(0.4 * a).toFixed(4)}"/>
  </svg>`;
}

/* ----------------------------------------------------------------- STATS
 * New. The figures the homepage already claims, counted up the way the live
 * stat row does, so the film and the page agree.
 */
const STATS = [
  { to: 300, suffix: '+', label: 'PROJECTS DELIVERED' },
  { to: 10, suffix: '+', label: 'COUNTRIES SERVED' },
  { to: 100, suffix: '%', label: 'CLIENT RETENTION' },
];

function statsFrame(i, n) {
  const per = n / STATS.length;
  const slot = Math.min(STATS.length - 1, Math.floor(i / per));
  const local = (i - slot * per) / per;
  const stat = STATS[slot];

  const a = ease(clamp01(local / 0.07)) * (1 - ease(clamp01((local - 0.91) / 0.09)));
  // Counts up over the first half of the beat, then holds so it can be read.
  const value = Math.round(stat.to * outCubic(clamp01(local / 0.52)));
  const num = centred(`${value}${stat.suffix}`, 230, 0.06, H / 2 + 24);
  const label = centred(stat.label, 34, 0.44, H / 2 + 112);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      ${GROUND('tg', '#0e0e16', '#030305')}
      <!-- Wide and gently stepped: a tighter radius renders as a visible oval
           behind the figure rather than as light. -->
      <radialGradient id="tglow" cx="50%" cy="46%" r="72%">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.13"/>
        <stop offset="45%" stop-color="${ACCENT}" stop-opacity="0.055"/>
        <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#tg)"/>
    <rect width="${W}" height="${H}" fill="url(#tglow)" opacity="${a.toFixed(4)}"/>
    <path d="${num.d}" fill="#ffffff" opacity="${a.toFixed(4)}"
          transform="translate(${num.x} ${num.y})"/>
    <path d="${label.d}" fill="${ACCENT}" opacity="${(0.9 * a).toFixed(4)}"
          transform="translate(${label.x} ${label.y})"/>
  </svg>`;
}

/* ------------------------------------------------------------------- END
 * Replaces the outro that carried the W mark, "WEB TACTICS" and
 * webtactics.org.
 */
function endFrame(i, n) {
  const t = i / (n - 1);
  const markA = ease(clamp01(t / 0.16));
  const ruleA = outCubic(clamp01((t - 0.22) / 0.26));
  const urlA = ease(clamp01((t - 0.34) / 0.24));
  const out = 1 - ease(clamp01((t - 0.94) / 0.06));
  // A slow, continuous swell rather than a fixed glow, so the last seconds
  // are not visually static.
  const glow = (0.10 + 0.14 * ease(clamp01(t / 0.7))) * out;
  const ruleW = 320 * ruleA;

  const mark = centred('KIASA', 172, 0.20, H / 2 + 8);
  const url = centred('KIASA.TECH', 34, 0.46, H / 2 + 128);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      ${GROUND('eg')}
      <radialGradient id="eglow" cx="50%" cy="48%" r="62%">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.85"/>
        <stop offset="45%" stop-color="${ACCENT}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#eg)"/>
    <rect width="${W}" height="${H}" fill="url(#eglow)" opacity="${glow.toFixed(4)}"/>
    <path d="${mark.d}" fill="#ffffff" opacity="${(markA * out).toFixed(4)}"
          transform="translate(${mark.x} ${mark.y})"/>
    <rect x="${((W - ruleW) / 2).toFixed(1)}" y="${H / 2 + 62}" width="${ruleW.toFixed(1)}" height="1"
          fill="${ACCENT}" opacity="${(0.55 * ruleA * out).toFixed(4)}"/>
    <path d="${url.d}" fill="${ACCENT}" opacity="${(urlA * out).toFixed(4)}"
          transform="translate(${url.x} ${url.y})"/>
  </svg>`;
}

/** Counts are frames, not seconds — these lengths are what set the final cut. */
async function render(name, maker, n) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    await sharp(Buffer.from(maker(i, n)))
      .png({ compressionLevel: 6 })
      .toFile(path.join(dir, String(i).padStart(4, '0') + '.png'));
  }
  console.log(`${name.padEnd(9)} ${String(n).padStart(3)} frames  ${(n / FPS).toFixed(2)}s`);
}

await render('logo', logoFrame, 75);
await render('city', cityFrame, 40);
await render('year', yearFrame, 66);
await render('services', servicesFrame, 108);
await render('stats', statsFrame, 90);
await render('end', endFrame, 90);

const rendered = 75 + 40 + 66 + 108 + 90 + 90;
const footage = 20 + 13 + 128 + 120;
console.log(`\nrendered ${rendered} + footage ${footage} = ${rendered + footage} frames ` +
  `(${((rendered + footage) / FPS).toFixed(3)}s)`);
