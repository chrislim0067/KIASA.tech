/**
 * Sound manifest. Names, file paths, volumes and flags are identical to the original site;
 * only the base path changed from the remote CDN to the local `public/cdn` folder.
 */
export const AUDIO_BASE = '/cdn/audio/';
export const AUDIO_PATHS = {
  sfx: `${AUDIO_BASE}sfx/`,
  music: `${AUDIO_BASE}music/`,
  transitions: `${AUDIO_BASE}transitions/`,
} as const;

/** Impulse response used by the reverb group (served from the site itself, as before). */
export const IMPULSE_RESPONSE_URL = '/audio/sfx/mp3/impulse_response.mp3';

export const MAX_MUSIC_VOLUME = 0.8;

export const SFX = {
  MENU_IN: 'menuIn',
  MENU_OUT: 'menuOut',
  ABOUT_HOVER: 'aboutHover',
  CONTACT_HOVER: 'contactHover',
  SIMPLE_HOVER: 'simpleHover',
  SIMPLE_OUT: 'simpleOut',
  MENU_BTN_HOVER: 'menuBtnHover',
  MENU_BTN_OUT: 'menuBtnOut',
  LOGO_LOOP: 'logoLoop',
  OPEN_WEBSITE: 'openWebsite',
} as const;
export type SfxName = (typeof SFX)[keyof typeof SFX];

export const MUSIC = {
  SECTION1: 'section1',
  SECTION2: 'section2',
  SECTION3: 'section3',
  SECTION4: 'section4',
  SECTION4_KICK: 'section4_kick',
  SECTION5: 'section5',
} as const;
export type MusicName = (typeof MUSIC)[keyof typeof MUSIC];

export const TRANSITIONS = {
  TRANSITION_SCENE_1_TO_2: 'transition_scene_1_to_2',
  TRANSITION_SCENE_2_TO_3: 'transition_scene_2_to_3',
  TRANSITION_SCENE_3_TO_4: 'transition_scene_3_to_4',
  TRANSITION_SCENE_4_TO_5: 'transition_scene_4_to_5',
  INTERACTION_SCENE_2_IN: 'interaction_scene_2_in',
  INTERACTION_SCENE_2_OUT: 'interaction_scene_2_out',
  INTERACTION_SCENE_2_LOOP: 'interaction_scene_2_loop',
  INTERACTION_SCENE_4_IN: 'interaction_scene_4_in',
  INTERACTION_SCENE_4_OUT: 'interaction_scene_4_out',
  INTERACTION_SCENE_4_LOOP: 'interaction_scene_4_loop',
} as const;
export type TransitionName = (typeof TRANSITIONS)[keyof typeof TRANSITIONS];

export interface SoundDefinition {
  name: string;
  path: string;
  /** Only loaded on non-touch devices. */
  desktop?: boolean;
  reverb?: boolean;
  loop?: boolean;
  autoplay?: boolean;
  preload?: boolean;
}

export const SFX_DEFINITIONS: SoundDefinition[] = [
  { name: SFX.OPEN_WEBSITE, path: 'open_website' },
  { name: SFX.MENU_IN, path: 'ui_menu_click_in', reverb: true },
  { name: SFX.MENU_OUT, path: 'ui_menu_click_out', reverb: true },
  { name: SFX.ABOUT_HOVER, path: 'ui_about_hover', desktop: true },
  { name: SFX.CONTACT_HOVER, path: 'ui_contact_hover', desktop: true },
  { name: SFX.SIMPLE_HOVER, path: 'ui_language_in', reverb: true, desktop: true },
  { name: SFX.SIMPLE_OUT, path: 'ui_language_out', reverb: true, desktop: true },
  { name: SFX.MENU_BTN_HOVER, path: 'ui_option_hover_in', reverb: true, desktop: true },
  { name: SFX.MENU_BTN_OUT, path: 'ui_option_hover_out', reverb: true, desktop: true },
  { name: SFX.LOGO_LOOP, path: 'sfx_logo_loop', loop: true, desktop: true },
];

export const MUSIC_DEFINITIONS: SoundDefinition[] = [
  { name: MUSIC.SECTION1, path: MUSIC.SECTION1, autoplay: true, preload: true },
  { name: MUSIC.SECTION2, path: MUSIC.SECTION2 },
  { name: MUSIC.SECTION3, path: MUSIC.SECTION3 },
  { name: MUSIC.SECTION4, path: MUSIC.SECTION4 },
  { name: MUSIC.SECTION4_KICK, path: MUSIC.SECTION4_KICK },
  { name: MUSIC.SECTION5, path: MUSIC.SECTION5 },
];

export const TRANSITION_DEFINITIONS: SoundDefinition[] = [
  { name: TRANSITIONS.TRANSITION_SCENE_1_TO_2, path: TRANSITIONS.TRANSITION_SCENE_1_TO_2 },
  { name: TRANSITIONS.TRANSITION_SCENE_2_TO_3, path: TRANSITIONS.TRANSITION_SCENE_2_TO_3, desktop: true },
  { name: TRANSITIONS.TRANSITION_SCENE_3_TO_4, path: TRANSITIONS.TRANSITION_SCENE_3_TO_4, desktop: true },
  { name: TRANSITIONS.TRANSITION_SCENE_4_TO_5, path: TRANSITIONS.TRANSITION_SCENE_4_TO_5, desktop: true },
  { name: TRANSITIONS.INTERACTION_SCENE_2_IN, path: TRANSITIONS.INTERACTION_SCENE_2_IN },
  { name: TRANSITIONS.INTERACTION_SCENE_2_OUT, path: TRANSITIONS.INTERACTION_SCENE_2_OUT },
  { name: TRANSITIONS.INTERACTION_SCENE_2_LOOP, path: TRANSITIONS.INTERACTION_SCENE_2_LOOP, loop: true },
  { name: TRANSITIONS.INTERACTION_SCENE_4_IN, path: TRANSITIONS.INTERACTION_SCENE_4_IN },
  { name: TRANSITIONS.INTERACTION_SCENE_4_OUT, path: TRANSITIONS.INTERACTION_SCENE_4_OUT },
  { name: TRANSITIONS.INTERACTION_SCENE_4_LOOP, path: TRANSITIONS.INTERACTION_SCENE_4_LOOP, loop: true },
];

/** Candidate URLs in preference order; the manager falls back to the next one on load errors. */
export const audioSources = (path: string, base: string): string[] => [
  `${base}opus/${path}.opus`,
  `${base}webm/${path}.webm`,
  `${base}mp3/${path}.mp3`,
];

/** Helpers mapping a section id to its interaction stems (ports of `vn`, `Vs`). */
export const interactionStem = (section: string, isIn = true): TransitionName =>
  TRANSITIONS[`INTERACTION_SCENE_${section === 'section2' ? 2 : 4}_${isIn ? 'IN' : 'OUT'}`];
export const interactionLoop = (section: string): TransitionName =>
  TRANSITIONS[`INTERACTION_SCENE_${section === 'section2' ? 2 : 4}_LOOP`];
