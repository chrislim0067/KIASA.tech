/**
 * The launch film's cut, in one place.
 *
 * One film directed from two sources:
 *
 *   the original   the film live on kiasa.tech — the identity source. Its
 *                  designed beats are used as they are, frame-accurately,
 *                  from the MP4: the wordmark, SINGAPORE, the 2026 numeral,
 *                  the four services, the figures.
 *   the new film   the generated cinematic plates — environments, people,
 *                  and the founder on stage.
 *
 * The brand system (reveal, key line, closing) holds them together as one.
 *
 *   Problem → KIASA → What we do → Value → Scale → Founder → Future → Closing
 */

export const FPS = 60;
const s = (seconds: number) => Math.round(seconds * FPS);

/** Scenes start this many frames early and play their own entrance. */
export const OVERLAP = 20;

export const SCENES = {
  /* 0:00 */ open:      { from: s(0),     dur: s(4) },      // the city, cold
  /* 0:04 */ problem:   { from: s(4),     dur: s(5) },      // a person under the work
  /* 0:09 */ singapore: { from: s(9),     dur: s(0.567) },  // original: SINGAPORE BASED
  /* 0:09 */ year:      { from: s(9.567), dur: s(1.933) },  // original: 2026 · effective · competitive · productive
  /* 0:11 */ grow:      { from: s(11.5),  dur: s(3.0) },    // original: Grow · Your Business · With Us
  /* 0:14 */ value:     { from: s(14.5),  dur: s(6) },      // real rooms, real people
  /* 0:20 */ keynote:   { from: s(20.5),  dur: s(13) },     // the founder, on stage
  /* 0:33 */ future:    { from: s(33.5),  dur: s(5) },      // alongside
  /* 0:38 */ end:       { from: s(38.5),  dur: s(6.8) },    // KIASA
} as const;

export type SceneKey = keyof typeof SCENES;
export const TOTAL_FRAMES = SCENES.end.from + SCENES.end.dur; // 2718 — 45.3s

/** Keynote shots, local to the keynote scene. */
export const KEYNOTE_SHOTS = {
  wide:   { from: s(0),   dur: s(4.2) },
  medium: { from: s(4.2), dur: s(4.4) },
  close:  { from: s(8.6), dur: s(4.4) },
} as const;

/**
 * The original film, as segments. Seconds into public/Assets/KIASA Promo.mp4
 * — the 15-second cut that is live on the site (commit a7dd905; 30fps).
 * Each is one of its beats, whole:
 *
 *   singapore  the SINGAPORE BASED card                          frames 55–71
 *   year       the outlined 2026 with effective · competitive · productive   200–257
 *   grow       its own footage and messaging: Grow · Your Business · With Us  72–161
 */
export const ORIGINAL = 'plates/launch/original.mp4';
export const ORIGINAL_CUTS = {
  singapore: { at: 55 / 30,  dur: 17 / 30 },
  year:      { at: 200 / 30, dur: 58 / 30 },
  grow:      { at: 72 / 30,  dur: 90 / 30 },
} as const;

/**
 * The cinematic plates, under video/public. No audio.
 *
 * WATERMARK. The generated clips carry an ANIMATED watermark in the top-right
 * corner — text, a swoosh, an icon, cycling — so it was inpainted over the
 * whole footprint of the cycle (ffmpeg delogo: landscape x1086 y1 188×78,
 * portrait x682 y1 196×90) from the original sources in one pass. The patch
 * is a smooth interpolation of its surroundings; Plate additionally scales
 * about a point low-left so most of that corner leaves the frame, and the
 * keynote shades it in the closer shots. Clip 2 carried a second watermark
 * top-left and was dropped for that and other reasons.
 */
export const PLATES = {
  city:          'plates/launch/01.mp4',
  office:        'plates/launch/03.mp4',
  tired:         'plates/launch/05.mp4',
  team:          'plates/launch/07.mp4',
  founderWide:   'plates/launch/08.mp4',
  founderMedium: 'plates/launch/09.mp4',
  founderClose:  'plates/launch/10.mp4',
  alongside:     'plates/launch/11.mp4',
} as const;

/** Everything this film sets in type itself (the original's beats carry their own). */
export const KEY_TEXT = {
  problem: { line: 'The way we work is changing', at: s(1.2), until: s(4.7) },
} as const;
