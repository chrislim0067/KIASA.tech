/**
 * Central audio manager (replaces the original `Ei` class).
 *
 * Responsibilities
 *  - creates every sound from the manifest with format fallback (`ManagedSound`)
 *  - starts the section music as soon as the AudioContext is really running
 *    (`AudioUnlocker`) instead of relying on Howler's one-shot `unlock` event
 *  - listens to the DOM command events dispatched by the UI controllers
 *  - keeps the mute state in `localStorage` and tweens the master volume (1 s)
 *  - routes the menu sounds through a reverb group and the logo loop through a
 *    cursor-driven low-pass group (desktop only, as before)
 *  - disposes every Howl, node, listener and timer on `dispose()`
 */
import { Howler } from 'howler';
import { gsap } from 'gsap';
import { AudioUnlocker } from './context';
import { ManagedSound } from './ManagedSound';
import { AudioGroup, LowPassEffect, ReverbEffect, loadImpulseResponse } from './effects';
import { MusicManager, type MusicManagerHooks } from './music';
import { MenuSoundController } from './MenuSoundController';
import {
  AUDIO_EVENTS,
  type MuteDetail,
  type PlayMusicDetail,
  type PlaySoundDetail,
  type PlayTransitionDetail,
  type Scene4ProgressDetail,
  type StopSoundDetail,
  type StopTransitionDetail,
} from './events';
import {
  AUDIO_PATHS,
  IMPULSE_RESPONSE_URL,
  MAX_MUSIC_VOLUME,
  MUSIC,
  MUSIC_DEFINITIONS,
  SFX,
  SFX_DEFINITIONS,
  TRANSITION_DEFINITIONS,
  audioSources,
  type SoundDefinition,
} from './manifest';

export interface AudioManagerOptions extends MusicManagerHooks {
  /** Touch devices skip the desktop-only sounds and effect groups. */
  isTouchDevice: boolean;
  /** Resolves when the experience has rendered; the remaining sounds are loaded then. */
  onRenderedReady(handler: () => void): () => void;
  /** Anchor scroll started: `{ section }` — switches the music track with a long fade. */
  onAnchorScrollStarted?(handler: (section: string) => void): () => void;
}

const MUTE_STORAGE_KEY = 'isMuted';

export class AudioManager {
  readonly sounds: Record<string, ManagedSound> = {};
  readonly unlocker: AudioUnlocker;
  isMuted = false;
  private globalVolume = 1;
  private readonly maxVolumeMusic = MAX_MUSIC_VOLUME;
  private musicManager: MusicManager | null = null;
  private reverbGroup: AudioGroup | null = null;
  private lowPassGroup: AudioGroup | null = null;
  private menuSoundController: MenuSoundController | null = null;
  private volumeTween: gsap.core.Tween | null = null;
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly options: AudioManagerOptions) {
    const desktop = !options.isTouchDevice;

    try {
      if (localStorage.getItem(MUTE_STORAGE_KEY) === 'true') {
        this.isMuted = true;
        this.globalVolume = 0;
      }
    } catch {
      /* storage unavailable */
    }

    const create = (def: SoundDefinition, base: string, volume: number, preload: boolean): ManagedSound =>
      new ManagedSound({
        name: def.name,
        sources: audioSources(def.path, base),
        volume,
        loop: def.loop ?? false,
        preload: def.preload ?? preload,
      });

    SFX_DEFINITIONS.forEach((def) => {
      if (desktop || !def.desktop) this.sounds[def.name] = create(def, AUDIO_PATHS.sfx, 1, true);
    });
    const music: Record<string, ManagedSound> = {};
    MUSIC_DEFINITIONS.forEach((def) => {
      const sound = create(def, AUDIO_PATHS.music, 0, false);
      this.sounds[def.name] = sound;
      music[def.name] = sound;
    });
    TRANSITION_DEFINITIONS.forEach((def) => {
      if (desktop || !def.desktop) this.sounds[def.name] = create(def, AUDIO_PATHS.transitions, this.maxVolumeMusic, false);
    });

    // Howler creates the context lazily with the first Howl; apply the persisted mute now.
    Howler.volume(this.globalVolume);
    this.unlocker = new AudioUnlocker();

    this.attachListeners();
    this.setupMusic(music);
    if (desktop) {
      void this.addSfxReverbGroup();
      this.addLowPassLogoGroup();
    }
  }

  private attachListeners(): void {
    const add = <T>(name: string, handler: (detail: T) => void): void => {
      const listener = (event: Event): void => handler((event as CustomEvent<T>).detail);
      document.addEventListener(name, listener);
      this.disposers.push(() => document.removeEventListener(name, listener));
    };
    add<MuteDetail>(AUDIO_EVENTS.MUTE_SOUND, (d) => this.toggleMute(d.isOff));
    add<PlaySoundDetail>(AUDIO_EVENTS.PLAY_SOUND, (d) => d && this.play(d.soundName));
    add<StopSoundDetail>(AUDIO_EVENTS.STOP_SOUND, (d) => d && this.stop(d.soundName, d.fadeDuration ?? 0));
    add<PlayTransitionDetail>(AUDIO_EVENTS.PLAY_TRANSITION, (d) => d && this.play(d.transition, d.fadeInDuration ?? 0));
    add<StopTransitionDetail>(AUDIO_EVENTS.STOP_TRANSITION, (d) => d && this.stop(d.transition, d.fadeDuration ?? 0));
    add<PlayMusicDetail>(AUDIO_EVENTS.PLAY_MUSIC, (d) => d?.trackName && this.musicManager?.switchTrack(d.trackName, d.duration ?? 500));
    add<{ musicName: string }>(AUDIO_EVENTS.STOP_MUSIC, (d) => d && this.stop(d.musicName));
    add<Scene4ProgressDetail>(AUDIO_EVENTS.SCENE_4_PROGRESS, (d) => this.musicManager?.updateScene4Kick(d.progress));
    this.disposers.push(this.options.onRenderedReady(() => this.preloadOtherSounds()));
  }

  private setupMusic(music: Record<string, ManagedSound>): void {
    this.musicManager = new MusicManager(music, this.options);
    let started = false;
    const start = (): void => {
      if (started || this.disposed) return;
      started = true;
      this.musicManager?.start(MUSIC.SECTION1);
    };
    // Music starts once the context is running — immediately if autoplay is allowed,
    // otherwise right after the first user gesture (Begin button, tap, key press).
    void this.unlocker.whenUnlocked().then(start);
    if (this.options.onAnchorScrollStarted) {
      this.disposers.push(this.options.onAnchorScrollStarted((section) => this.musicManager?.switchTrack(section, 1500)));
    }
  }

  private async addSfxReverbGroup(): Promise<void> {
    try {
      const ctx = Howler.ctx as AudioContext;
      const impulse = await loadImpulseResponse(ctx, IMPULSE_RESPONSE_URL);
      if (this.disposed) return;
      this.reverbGroup = new AudioGroup([new ReverbEffect({ mix: 0.25, irAudioBuffer: impulse })]);
      SFX_DEFINITIONS.filter((d) => d.reverb).forEach((d) => {
        const sound = this.sounds[d.name];
        if (sound) this.reverbGroup?.addSound(sound);
      });
    } catch (error) {
      console.warn('[audio] reverb unavailable', error);
    }
  }

  private addLowPassLogoGroup(): void {
    const lowPass = new LowPassEffect({ initialFrequency: 100 });
    this.lowPassGroup = new AudioGroup([lowPass]);
    const loop = this.sounds[SFX.LOGO_LOOP];
    if (loop) this.lowPassGroup.addSound(loop);
    this.menuSoundController = new MenuSoundController(lowPass);
  }

  private preloadOtherSounds(): void {
    TRANSITION_DEFINITIONS.forEach((d) => this.sounds[d.name]?.load());
    MUSIC_DEFINITIONS.forEach((d) => this.sounds[d.name]?.load());
  }

  play(name: string, fadeIn = 0, volume = MAX_MUSIC_VOLUME): void {
    const sound = this.sounds[name];
    if (!sound) return;
    // Loops (logo loop, interaction loops) must never stack.
    if (sound.raw.loop() && sound.playing()) return;
    if (fadeIn === 0) {
      sound.volume(volume);
      sound.play();
      return;
    }
    sound.play();
    sound.fade(0, volume, fadeIn);
  }

  stop(name: string, fade = 0): void {
    const sound = this.sounds[name];
    if (!sound || !sound.playing()) return;
    if (fade === 0) {
      sound.stop();
      return;
    }
    const from = sound.volume();
    sound.fade(from, 0, fade);
    sound.once('fade', () => sound.stop());
  }

  toggleMute(isOff: boolean): void {
    this.isMuted = isOff;
    const target = isOff ? 0 : this.maxVolumeMusic;
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, String(isOff));
    } catch {
      /* storage unavailable */
    }
    this.volumeTween?.kill();
    const state = { volume: this.globalVolume };
    this.volumeTween = gsap.to(state, {
      volume: target,
      duration: 1,
      onUpdate: () => {
        this.globalVolume = state.volume;
        Howler.volume(this.globalVolume);
      },
    });
    this.musicManager?.setGlobalVolume(target, 10000);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.volumeTween?.kill();
    this.disposers.splice(0).forEach((d) => d());
    this.menuSoundController?.dispose();
    this.musicManager?.dispose();
    this.reverbGroup?.dispose();
    this.lowPassGroup?.dispose();
    Object.values(this.sounds).forEach((s) => s.dispose());
    this.unlocker.dispose();
  }
}
