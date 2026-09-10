/**
 * DOM CustomEvent based audio commands. UI controllers dispatch these on `document`;
 * the AudioManager listens. Names are identical to the original (`he` constants) so the
 * event contract is unchanged.
 */
import { interactionLoop, interactionStem } from './manifest';

export const AUDIO_EVENTS = {
  MUTE_SOUND: 'mute-sound',
  PLAY_SOUND: 'play-sound',
  STOP_SOUND: 'stop-sound',
  PLAY_TRANSITION: 'play-transition',
  STOP_TRANSITION: 'stop-transition',
  PLAY_MUSIC: 'play-music',
  STOP_MUSIC: 'stop-music',
  SCENE_4_PROGRESS: 'scene-4-progress',
  PLAY_TRANSITION_ANCHOR: 'play-transition-anchor',
} as const;

export interface PlaySoundDetail {
  soundName: string;
}
export interface StopSoundDetail {
  soundName: string;
  fadeDuration?: number;
}
export interface PlayTransitionDetail {
  transition: string;
  fadeInDuration?: number;
}
export interface StopTransitionDetail {
  transition: string;
  fadeDuration?: number;
}
export interface PlayMusicDetail {
  trackName: string;
  fadeDuration?: number;
  volume?: number;
  duration?: number;
}
export interface MuteDetail {
  isOff: boolean;
}
export interface Scene4ProgressDetail {
  progress: number;
}

const dispatch = <T>(name: string, detail: T): void => {
  document.dispatchEvent(new CustomEvent<T>(name, { detail }));
};

export const audioCommands = {
  playSound(soundName: string): void {
    dispatch<PlaySoundDetail>(AUDIO_EVENTS.PLAY_SOUND, { soundName });
  },
  stopSound(soundName: string, fadeDuration?: number): void {
    dispatch<StopSoundDetail>(AUDIO_EVENTS.STOP_SOUND, { soundName, fadeDuration });
  },
  playTransition(transition: string, fadeInDuration?: number): void {
    dispatch<PlayTransitionDetail>(AUDIO_EVENTS.PLAY_TRANSITION, { transition, fadeInDuration });
  },
  stopTransition(transition: string, fadeDuration?: number): void {
    dispatch<StopTransitionDetail>(AUDIO_EVENTS.STOP_TRANSITION, { transition, fadeDuration });
  },
  playTransitionAnchor(transition: string): void {
    dispatch<PlayTransitionDetail>(AUDIO_EVENTS.PLAY_TRANSITION_ANCHOR, { transition });
  },
  playMusic(trackName: string, fadeDuration = 500): void {
    dispatch<PlayMusicDetail>(AUDIO_EVENTS.PLAY_MUSIC, { trackName, fadeDuration });
  },
  stopMusic(musicName: string): void {
    dispatch<{ musicName: string }>(AUDIO_EVENTS.STOP_MUSIC, { musicName });
  },
  mute(isOff: boolean): void {
    dispatch<MuteDetail>(AUDIO_EVENTS.MUTE_SOUND, { isOff });
  },
  scene4Progress(progress: number): void {
    dispatch<Scene4ProgressDetail>(AUDIO_EVENTS.SCENE_4_PROGRESS, { progress });
  },
  /** Interaction "in"/"out" stem for a section (port of `Hs`). */
  playInteraction(section: string, isIn = true): void {
    audioCommands.playSound(interactionStem(section, isIn));
  },
  stopInteraction(section: string, isIn = true): void {
    audioCommands.stopSound(interactionStem(section, isIn), 300);
  },
  /** Interaction loop for a section (port of `Vs`). */
  interactionLoop(section: string, play = true, fadeInDuration = 4600): void {
    const name = interactionLoop(section);
    if (play) audioCommands.playTransition(name, fadeInDuration);
    else dispatch<StopTransitionDetail & { fadeInDuration: number }>(AUDIO_EVENTS.STOP_TRANSITION, { transition: name, fadeInDuration });
  },
};
