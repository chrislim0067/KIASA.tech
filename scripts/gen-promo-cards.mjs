/**
 * Renders the two replacement segments for the promo as PNG frame sequences.
 *
 * The old segments cannot be patched in place: the "2024" is a full-frame
 * outlined numeral that scales and drifts with chromatic fringing, and the
 * outro is an animated logo reveal. Motion-tracking either is out of reach, so
 * both are re-rendered from scratch in the site's own typography instead.
 *
 * Text becomes vector paths via opentype so nothing depends on a font being
 * installed — Syncopate-Bold.ttf is the same file the 3D wordmark is built
 * from, so the letterforms match the site exactly.
 *
 *   node scripts/gen-promo-cards.mjs <out-dir>
 *
 * Then splice them into the source promo. The frame numbers are exact and must
 * stay that way: the original audio is carried over untouched, so a segment one
 * frame short slides every later cut out of sync with it.
 *
 *   ffmpeg -i "<source>.mp4" \
 *     -framerate 30 -i <out>/logo/%04d.png -framerate 30 -i <out>/city/%04d.png \
 *     -framerate 30 -i <out>/year/%04d.png -framerate 30 -i <out>/end/%04d.png \
 *     -filter_complex "\
 *   [0:v]trim=start_frame=0:end_frame=20,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a0];\
 *   [1:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a1];\
 *   [0:v]trim=start_frame=42:end_frame=55,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a2];\
 *   [2:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a3];\
 *   [0:v]trim=start_frame=72:end_frame=200,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a4];\
 *   [3:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a5];\
 *   [0:v]trim=start_frame=258:end_frame=378,setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a6];\
 *   [4:v]setpts=PTS-STARTPTS,format=yuv420p,setsar=1[a7];\
 *   [a0][a1][a2][a3][a4][a5][a6][a7]concat=n=8:v=1:a=0,fps=30[vout]" \
 *     -map "[vout]" -map 0:a -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p \
 *     -movflags +faststart -c:a aac -b:a 128k "public/Assets/KIASA Promo.mp4"
 *
 * The result is 450 frames at 30fps — 15.000s, the same as the source.
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
 * font's own metric spacing, and Syncopate's display sizes need more air than
 * that, so advance each glyph by hand.
 *
 * `tracking` is in em, matching how the stylesheet expresses letter-spacing.
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
  // The trailing gap after the final glyph is not part of the visible run.
  return { d: parts.join(' '), width: x - extra };
}

/** Centre a laid-out run horizontally and place its baseline at `baseline`. */
function centred(text, size, tracking, baseline) {
  const { d, width } = layout(text, size, tracking);
  return { d, x: (W - width) / 2, y: baseline, width };
}

const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/* ---------------------------------------------------------------- segment A
 * Replaces 0.667s-1.400s, the "Introducing ->" brand reveal that showed the old
 * W mark. The original dissolved its logo into the word "Creative"; this holds
 * the wordmark and eases off so the cut back to "Creative" reads as deliberate.
 */
function logoFrame(i, n) {
  const t = i / (n - 1);
  const inA = ease(clamp01(t / 0.28));
  const out = 1 - ease(clamp01((t - 0.78) / 0.22));
  const a = inA * out;
  // A whisper of a push-in so the card is not visually inert.
  const scale = 1.02 - 0.02 * ease(t);
  const mark = centred('KIASA', 150, 0.20, H / 2 + 52);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="ibg" cx="50%" cy="50%" r="72%">
        <stop offset="0%" stop-color="#0c1420"/>
        <stop offset="100%" stop-color="#03060a"/>
      </radialGradient>
      <!-- A wide, gently-stepped falloff: a tighter radius renders as a
           visible oval blob behind the wordmark rather than as light. -->
      <radialGradient id="iglow" cx="50%" cy="50%" r="62%">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.17"/>
        <stop offset="45%" stop-color="${ACCENT}" stop-opacity="0.07"/>
        <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#ibg)"/>
    <rect width="${W}" height="${H}" fill="url(#iglow)" opacity="${a.toFixed(4)}"/>
    <g transform="translate(${W / 2} ${H / 2}) scale(${scale.toFixed(4)}) translate(${-W / 2} ${-H / 2})">
      <path d="${mark.d}" fill="#ffffff" opacity="${a.toFixed(4)}"
            transform="translate(${mark.x} ${mark.y})"/>
    </g>
  </svg>`;
}

/* ---------------------------------------------------------------- segment C
 * Replaces 1.867s-2.400s, the "DUBAI" card ringed by repeating "DUBAI BASED".
 * KIASA is Singapore-based — /about, the homepage badge and every JSON-LD
 * address all say so — so the city changes with the brand.
 */
function cityFrame(i, n) {
  const t = i / (n - 1);
  const a = ease(clamp01(t / 0.20)) * (1 - ease(clamp01((t - 0.80) / 0.20)));
  const city = centred('SINGAPORE', 96, 0.30, H / 2 + 34);

  // The ring of repeating text the original framed the card with. Each edge is
  // one long run, over-repeated and clipped by the viewBox rather than measured.
  const RING = 'SINGAPORE BASED   ';
  const ringRun = layout(RING.repeat(14), 21, 0.16);
  const edge = (transform) =>
    `<path d="${ringRun.d}" fill="#ffffff" opacity="${(0.34 * a).toFixed(4)}" transform="${transform}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="cbg" cx="50%" cy="62%" r="70%">
        <stop offset="0%" stop-color="#1a0f0c"/>
        <stop offset="70%" stop-color="#070507"/>
        <stop offset="100%" stop-color="#030204"/>
      </radialGradient>
      <radialGradient id="ember" cx="50%" cy="60%" r="34%">
        <stop offset="0%" stop-color="#ff7a3c" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#ff7a3c" stop-opacity="0"/>
      </radialGradient>
      <clipPath id="frame"><rect width="${W}" height="${H}"/></clipPath>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#cbg)"/>
    <rect width="${W}" height="${H}" fill="url(#ember)" opacity="${a.toFixed(4)}"/>
    <g clip-path="url(#frame)">
      ${edge('translate(-140 46)')}
      ${edge(`translate(-140 ${H - 20})`)}
      ${edge('translate(46 ' + (H + 140) + ') rotate(-90)')}
      ${edge(`translate(${W - 30} -140) rotate(90)`)}
    </g>
    <path d="${city.d}" fill="#ffffff" opacity="${a.toFixed(4)}"
          transform="translate(${city.x} ${city.y})"/>
  </svg>`;
}

/* ---------------------------------------------------------------- segment B
 * Replaces 6.80s-8.60s. The original showed a giant outlined year with a word
 * cycling over it; this keeps that idea and that pacing, with the year correct
 * and the typeface the site actually uses. "competetive" is fixed on the way
 * through.
 */
function yearFrame(i, n) {
  const t = i / (n - 1);
  const fade = ease(clamp01(t / 0.12)) * (1 - ease(clamp01((t - 0.88) / 0.12)));

  // A slow push-in, the one piece of motion the original had that reads at this
  // size. Scaling about the centre keeps the numerals from drifting off-axis.
  const scale = 1 + 0.045 * t;
  // Digits are cap-height, so centring them vertically means dropping the
  // baseline by half a cap rather than half an em.
  const YEAR_SIZE = 440;
  const year = centred('2026', YEAR_SIZE, 0.06, H / 2 + YEAR_SIZE * 0.35);

  const words = ['EFFECTIVE', 'COMPETITIVE', 'PRODUCTIVE'];
  const slot = Math.min(words.length - 1, Math.floor(t * words.length));
  const local = t * words.length - slot;
  // Each word fades up and back down inside its own third.
  const wordAlpha = ease(clamp01(local / 0.22)) * (1 - ease(clamp01((local - 0.72) / 0.28)));
  const word = centred(words[slot], 44, 0.42, H / 2 + 15);

  // Two offset copies stand in for the original's chromatic fringing.
  const fringe = (dx, colour, op) => `
    <g transform="translate(${dx} 0)">
      <path d="${year.d}" fill="none" stroke="${colour}" stroke-width="2.5"
            opacity="${(op * fade).toFixed(4)}" transform="translate(${year.x} ${year.y})"/>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="bg" cx="50%" cy="45%" r="75%">
        <stop offset="0%" stop-color="#12121a"/>
        <stop offset="100%" stop-color="#040407"/>
      </radialGradient>
      <linearGradient id="stroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#8fa6c4"/>
        <stop offset="50%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="${ACCENT}"/>
      </linearGradient>
      <!-- Sits under the cycling word so it stays legible where it crosses a
           numeral stroke, without the hard-edged band a rect would give. -->
      <radialGradient id="wordbg" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#050508" stop-opacity="0.92"/>
        <stop offset="55%" stop-color="#050508" stop-opacity="0.72"/>
        <stop offset="100%" stop-color="#050508" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <g transform="translate(${W / 2} ${H / 2}) scale(${scale.toFixed(4)}) translate(${-W / 2} ${-H / 2})">
      ${fringe(-5, '#ff4d6a', 0.30)}
      ${fringe(5, '#4de1ff', 0.30)}
      <path d="${year.d}" fill="none" stroke="url(#stroke)" stroke-width="2.5"
            opacity="${(0.92 * fade).toFixed(4)}" transform="translate(${year.x} ${year.y})"/>
    </g>
    <ellipse cx="${W / 2}" cy="${H / 2}" rx="${(word.width / 2 + 130).toFixed(1)}" ry="70"
             fill="url(#wordbg)" opacity="${(wordAlpha * fade).toFixed(4)}"/>
    <path d="${word.d}" fill="#ffffff" opacity="${(wordAlpha * fade).toFixed(4)}"
          transform="translate(${word.x} ${word.y})"/>
  </svg>`;
}

/* ---------------------------------------------------------------- segment D
 * Replaces 12.60s-15.00s, where the old logo, wordmark and webtactics.org sat.
 */
function endFrame(i, n) {
  const t = i / (n - 1);
  const inA = ease(clamp01((t - 0.02) / 0.30));
  const urlA = ease(clamp01((t - 0.34) / 0.28));
  const ruleA = ease(clamp01((t - 0.26) / 0.30));
  const out = 1 - ease(clamp01((t - 0.93) / 0.07));

  const mark = centred('KIASA', 168, 0.20, 548);
  const url = centred('KIASA.TECH', 34, 0.46, 664);
  const ruleW = 300 * ruleA;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="glow" cx="50%" cy="48%" r="46%">
        <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.20"/>
        <stop offset="60%" stop-color="${ACCENT}" stop-opacity="0.05"/>
        <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="bg2" cx="50%" cy="50%" r="75%">
        <stop offset="0%" stop-color="#0d0d14"/>
        <stop offset="100%" stop-color="#030305"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg2)"/>
    <rect width="${W}" height="${H}" fill="url(#glow)" opacity="${(inA * out).toFixed(4)}"/>
    <path d="${mark.d}" fill="#ffffff" opacity="${(inA * out).toFixed(4)}"
          transform="translate(${mark.x} ${mark.y})"/>
    <rect x="${(W - ruleW) / 2}" y="606" width="${ruleW}" height="1" fill="${ACCENT}"
          opacity="${(0.55 * ruleA * out).toFixed(4)}"/>
    <path d="${url.d}" fill="${ACCENT}" opacity="${(urlA * out).toFixed(4)}"
          transform="translate(${url.x} ${url.y})"/>
  </svg>`;
}

/**
 * Counts are given in frames, not seconds. The four replacements have to slot
 * into the original's 450-frame timeline exactly or the audio drifts out of
 * sync with the footage that follows.
 */
async function render(name, maker, n) {
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const svg = maker(i, n);
    await sharp(Buffer.from(svg))
      .png({ compressionLevel: 6 })
      .toFile(path.join(dir, String(i).padStart(4, '0') + '.png'));
  }
  console.log(`${name}: ${n} frames (${(n / FPS).toFixed(3)}s)`);
}

await render('logo', logoFrame, 22);  // frames  20- 41
// 17, not 16: the old DUBAI card's first frame is 55, one earlier than the
// title change suggested, so the replacement has to start there instead.
await render('city', cityFrame, 17);  // frames  55- 71
// The old year sequence starts dissolving in at frame 200, four frames before
// its numerals are legible, so the card has to cover from there.
await render('year', yearFrame, 58);  // frames 200-257
await render('end', endFrame, 72);    // frames 378-449
