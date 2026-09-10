/**
 * The brand film's cut, in one place.
 *
 * Every scene in-point, every shot inside the keynote, every voiceover line
 * with its marker, every on-screen phrase, and the music cues. Change the film
 * here; the scene files only read from this.
 *
 * Frames are at {@link FPS}. The seconds in comments are for reading.
 *
 * VOICEOVER IS NOT ON SCREEN. The narration carries the story; the typography
 * only lands the key ideas. {@link KEY_TEXT} is the complete list of what is
 * ever set in type.
 */

export const FPS = 60;
const s = (seconds: number) => Math.round(seconds * FPS);

/** Scenes overlap by this many frames; each plays its own entrance. */
export const OVERLAP = 24;

export const SCENES = {
  /* 0:00–0:07 */ world:        { from: s(0),  dur: s(7) },
  /* 0:07–0:14 */ problem:      { from: s(7),  dur: s(7) },
  /* 0:14–0:22 */ reveal:       { from: s(14), dur: s(8) },
  /* 0:22–0:32 */ capabilities: { from: s(22), dur: s(10) },
  /* 0:32–0:44 */ keynote:      { from: s(32), dur: s(12) },
  /* 0:44–0:53 */ future:       { from: s(44), dur: s(9) },
  /* 0:53–0:59 */ end:          { from: s(53), dur: s(6) },
} as const;

export type SceneKey = keyof typeof SCENES;
export const TOTAL_FRAMES = SCENES.end.from + SCENES.end.dur; // 3540 — 59.0s

/** The five capability beats inside 0:22–0:32, local to that scene. */
export const CAPABILITY_BEATS = [
  { key: 'search',     word: 'Search',     from: s(0),   dur: s(1.8) },
  { key: 'understand', word: 'Understand', from: s(1.8), dur: s(2.2) },
  { key: 'prepare',    word: 'Prepare',    from: s(4.0), dur: s(1.6) },
  { key: 'coordinate', word: 'Coordinate', from: s(5.6), dur: s(1.8) },
  { key: 'act',        word: 'Act',        from: s(7.4), dur: s(2.6) },
] as const;

/** The four keynote shots inside 0:32–0:44, local to that scene. */
export const KEYNOTE_SHOTS = {
  wide:   { from: s(0), dur: s(3) },   // A — establishing, audience foreground
  medium: { from: s(3), dur: s(3) },   // B — presenter, screen behind
  vision: { from: s(6), dur: s(3) },   // C — closer, the personal lines
  screen: { from: s(9), dur: s(3) },   // D — the slide, then the audience
} as const;

/** When the presentation moves to its second slide, local to the keynote. */
export const SLIDE_CHANGE = s(8);

/* ------------------------------------------------------------- voiceover */

export interface VoLine {
  /** Absolute frame the line begins. */
  at: number;
  text: string;
  /** Who reads it. The founder's lines may be recorded by the founder. */
  voice: 'narrator' | 'founder';
}

export const VOICEOVER: readonly VoLine[] = [
  { at: s(1.5),  voice: 'narrator', text: 'The way we work is changing.' },
  { at: s(4.5),  voice: 'narrator', text: 'AI is changing what one person can accomplish.' },
  { at: s(8.0),  voice: 'narrator', text: 'But too much of our time is still spent doing work that technology should be doing for us.' },
  { at: s(14.5), voice: 'narrator', text: 'That’s why we’re building KIASA.' },
  { at: s(17.0), voice: 'narrator', text: 'KIASA is an AI and automation company built around a simple idea…' },
  { at: s(20.0), voice: 'narrator', text: 'Technology should work for people.' },
  { at: s(22.5), voice: 'narrator', text: 'We build intelligent systems that can search, understand, prepare, coordinate, and act.' },
  { at: s(28.0), voice: 'narrator', text: 'So people can spend less time on repetitive work and more time moving forward.' },
  { at: s(32.5), voice: 'founder',  text: 'When we started KIASA, we weren’t trying to build another website.' },
  { at: s(36.0), voice: 'founder',  text: 'We wanted to build systems that could actually do the work.' },
  { at: s(39.5), voice: 'founder',  text: 'Our goal is simple: give people back their time and expand what they’re capable of.' },
  { at: s(44.5), voice: 'narrator', text: 'We believe the next generation of software won’t just give people tools.' },
  { at: s(49.5), voice: 'narrator', text: 'It will work alongside them.' },
];

/* --------------------------------------------------------- on-screen text */

/** Everything that is ever set in type. Nothing else appears as words. */
export const KEY_TEXT = {
  world:        { line: 'The way we work is changing', at: s(3.0), until: s(6.5) },
  problem:      { labels: ['Applications', 'Research', 'Forms', 'Messages', 'Documents', 'Decisions'] },
  reveal:       { tagline: 'Technology should work for people' },
  capabilities: { cameo: 'KIASA intelligence' },
  keynote: {
    slide1: { title: 'KIASA', sub: 'Technology should work for people.' },
    slide2: { parts: ['AI', '+', 'Automation', '+', 'Human ambition'] },
  },
  future:       { line: 'It will work alongside them', at: s(50.0), until: s(52.6) },
  end:          { tagline: 'Technology that works for you', url: 'KIASA.TECH' },
} as const;

/* ------------------------------------------------------------------ music */

/** For whoever scores it. Absolute seconds. */
export const MUSIC_CUES = [
  { at: 0,  cue: 'minimal atmosphere — near silence, a pad' },
  { at: 7,  cue: 'a subtle pulse enters' },
  { at: 11, cue: 'drop to silence' },
  { at: 14, cue: 'the reveal begins — first rise' },
  { at: 22, cue: 'rhythmic intelligence sequence' },
  { at: 32, cue: 'emotional rise into the keynote' },
  { at: 40, cue: 'musical peak' },
  { at: 44, cue: 'release — wide, warm' },
  { at: 53, cue: 'minimal resolution — one sustained note' },
  { at: 59, cue: 'clean ending, no hit' },
] as const;
