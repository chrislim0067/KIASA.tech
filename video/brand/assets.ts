/**
 * Every external asset the brand film can take, and whether it has one yet.
 *
 * All paths are relative to video/public (served by Remotion's public dir),
 * so `staticFile(path)` resolves them. `null` means "not supplied yet" and
 * the film renders its designed stand-in instead — the picture is never
 * blocked on an asset.
 *
 * To drop an asset in: put the file under video/public/… and set the path
 * here. Nothing else changes.
 */

/* ---------------------------------------------------------------- founder */

/**
 * The founder video plates. THESE MUST BE GENERATED OUTSIDE THIS REPOSITORY.
 *
 * This environment has no image-to-video capability. Until each plate exists,
 * the keynote renders {@link FOUNDER_REFERENCE} — the founder's real photo —
 * as a clearly-marked placeholder in the same slot, so the environment, camera
 * and timing can be judged now and the plate swapped in later.
 *
 * Specifications and prompts for generating each plate: video/brand/founder/PLATES.md
 */
export const FOUNDER_PLATES = {
  /** Shot A. Full figure at a lectern, seen from the auditorium. 4s+, 1920×1080. */
  wide:   { video: null as string | null, expected: 'founder/founder-wide.mp4' },
  /** Shot B. Waist-up, presenting, one restrained gesture. 4s+, 1920×1080. */
  medium: { video: null as string | null, expected: 'founder/founder-medium.mp4' },
  /** Shot C. Chest-up, listening then speaking, a glance to the screen. 4s+, 1920×1080. */
  vision: { video: null as string | null, expected: 'founder/founder-vision.mp4' },
} as const;

export type FounderPlateKey = keyof typeof FOUNDER_PLATES;

/** The identity reference — the founder's actual photo, copied from public/Assets. */
export const FOUNDER_REFERENCE = 'founder/founder-reference.webp';

/* ------------------------------------------------------------------ audio */

/**
 * Narration and score. Both `null` for V1: the picture is cut to the markers
 * in timeline.ts, and the audio is laid to those markers when it arrives.
 */
export const AUDIO = {
  /** One file, lines placed per VOICEOVER markers — or separate takes, see BrandFilm. */
  voiceover: null as string | null,
  /** A licensed track, 62–65s, cued per MUSIC_CUES. */
  music: null as string | null,
} as const;

/* ------------------------------------------------------------ live action */

/**
 * Optional licensed plates for the human moments. Each `null` renders the
 * designed plate built for that moment instead.
 */
export const LIVE_PLATES = {
  /** Scene 1: a person at a desk at night, lit by a screen. */
  desk:   { video: null as string | null, expected: 'plates/desk-night.mp4' },
  /** Scene 6: a person at ease, looking up and out toward light. */
  future: { video: null as string | null, expected: 'plates/looking-out.mp4' },
} as const;
