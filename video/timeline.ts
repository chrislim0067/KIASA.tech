/**
 * The cut, in one place.
 *
 * Every scene's in-point, length and on-screen copy lives here so the film can
 * be re-timed or re-worded without opening a scene file. Frame counts are at
 * {@link FPS}; the seconds in the comments are for reading, the frames are the
 * truth.
 *
 * Scenes OVERLAP by {@link OVERLAP} frames: each scene's <Sequence> begins that
 * many frames before its nominal in-point and handles its own entrance (a fade
 * or a wipe) over that span, while the previous scene keeps rendering beneath
 * it. That is what turns hard cuts into transitions without a transition layer.
 */

export const FPS = 60;
export const OVERLAP = 18;

const s = (seconds: number) => Math.round(seconds * FPS);

export const SCENES = {
  /* 0:00–0:03 */ logo:      { from: s(0),  dur: s(3) },
  /* 0:03–0:07 */ discover:  { from: s(3),  dur: s(4) },
  /* 0:07–0:11 */ match:     { from: s(7),  dur: s(4) },
  /* 0:11–0:15 */ prepare:   { from: s(11), dur: s(4) },
  /* 0:15–0:20 */ automate:  { from: s(15), dur: s(5) },
  /* 0:20–0:23 */ dashboard: { from: s(20), dur: s(3) },
  /* 0:23–0:26 */ end:       { from: s(23), dur: s(3) },
} as const;

export type SceneKey = keyof typeof SCENES;

export const TOTAL_FRAMES = SCENES.end.from + SCENES.end.dur;

/**
 * Copy. Short on purpose — the visuals explain the product; these name the
 * beat. Arrays are line breaks.
 */
export const COPY = {
  logo: {
    lines: ['Your job search.', 'Powered by AI.'],
  },
  discover: {
    // Three short lines: Syncopate is wide, and this caption sits in a
    // narrow column beside the job list. Two lines wrap unevenly there.
    main: ['Discover the', 'right', 'opportunities.'],
    sub: 'Search less. Find better matches.',
    listTitle: 'Jobs',
    listCount: 48,
  },
  match: {
    main: ['Know where', 'you fit.'],
    verdict: 'Strong match',
    verdictNote: 'Recommended',
    scoring: 'scoring',
    scored: (confidence: number) => `scored · confidence ${confidence.toFixed(2)}`,
    explanation:
      'Design-systems depth and accessibility work map directly to the role’s core requirements.',
  },
  prepare: {
    main: ['Tailored for', 'every opportunity.'],
    tailoring: 'tailoring',
    tailored: 'tailored',
  },
  automate: {
    main: ['Automate the', 'repetitive work.'],
    automation: 'Automation',
    on: 'On',
    columns: ['Discover', 'Match', 'Prepare', 'Apply'],
  },
  dashboard: {
    main: ['One platform.', 'One smarter job search.'],
    tiles: [
      { label: 'Jobs found', value: 48 },
      { label: 'Strong matches', value: 12 },
      { label: 'Applications', value: 9 },
      { label: 'In progress', value: 3 },
    ],
    profile: 'Your profile',
    profileNote: '4 of 4 required',
    profileReady: 'Your profile is ready.',
  },
  end: {
    tagline: 'Find better opportunities. Apply smarter.',
    url: 'KIASA.TECH',
  },
} as const;
