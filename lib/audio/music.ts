/**
 * Music track handling: per-track fade controller with "night-club" low-pass effect and the
 * cross-fading MusicManager (ports of `gi`, `vi`, `Si`).
 */
import { Howler } from 'howler';
import type { ManagedSound } from './ManagedSound';
import { MAX_MUSIC_VOLUME, MUSIC } from './manifest';

/** Low-pass + gain dip applied to a music track (port of `gi`). */
class NightClubEffect {
  private readonly ctx: AudioContext;
  private lowPassFilter: BiquadFilterNode | null = null;
  private gainNode: GainNode | null = null;
  private pendingReset: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sound: ManagedSound) {
    this.ctx = Howler.ctx as AudioContext;
  }

  applyNightClubEffect(frequency = 100, duration = 500): void {
    if (this.pendingReset) {
      clearTimeout(this.pendingReset);
      this.pendingReset = null;
    }
    this.applyAudioEffect({ frequency, gain: 0.5 }, duration);
  }

  removeNightClubEffect(frequency = 18000, duration = 500): void {
    this.applyAudioEffect({ frequency, gain: 1 }, duration);
    this.pendingReset = setTimeout(() => {
      this.removeAudioEffect();
      this.pendingReset = null;
    }, duration);
  }

  private applyAudioEffect({ frequency, gain }: { frequency: number; gain: number }, duration = 500): void {
    const source = this.sound.firstSourceNode;
    if (!source) return;
    const now = this.ctx.currentTime;
    const end = now + duration / 1000;
    const MAX_FREQ = 24000;
    if (this.lowPassFilter && this.gainNode) {
      this.lowPassFilter.frequency.cancelScheduledValues(now);
      this.gainNode.gain.cancelScheduledValues(now);
      this.lowPassFilter.frequency.setValueAtTime(Math.min(MAX_FREQ, this.lowPassFilter.frequency.value), now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.lowPassFilter.frequency.linearRampToValueAtTime(frequency, end);
      this.gainNode.gain.linearRampToValueAtTime(gain, end);
      return;
    }
    this.lowPassFilter = this.ctx.createBiquadFilter();
    this.lowPassFilter.type = 'lowpass';
    this.gainNode = this.ctx.createGain();
    this.lowPassFilter.frequency.setValueAtTime(Math.min(MAX_FREQ, this.ctx.sampleRate), now);
    this.gainNode.gain.setValueAtTime(1, now);
    this.lowPassFilter.frequency.linearRampToValueAtTime(frequency, end);
    this.gainNode.gain.linearRampToValueAtTime(gain, end);
    try {
      source.disconnect();
      source.connect(this.lowPassFilter);
      this.lowPassFilter.connect(this.gainNode);
      this.gainNode.connect(Howler.masterGain as GainNode);
    } catch (error) {
      console.error('[audio] failed to insert night-club effect', error);
    }
  }

  private removeAudioEffect(): void {
    const source = this.sound.firstSourceNode;
    if (!source) return;
    this.lowPassFilter?.disconnect();
    this.lowPassFilter = null;
    this.gainNode?.disconnect();
    this.gainNode = null;
    try {
      source.disconnect();
      source.connect(Howler.masterGain as GainNode);
    } catch (error) {
      console.error('[audio] failed to remove night-club effect', error);
    }
  }

  dispose(): void {
    if (this.pendingReset) clearTimeout(this.pendingReset);
    this.pendingReset = null;
    const source = this.sound.firstSourceNode;
    if (source) {
      try {
        source.disconnect();
        source.connect(Howler.masterGain as GainNode);
      } catch {
        /* node already gone */
      }
    }
    this.lowPassFilter?.disconnect();
    this.gainNode?.disconnect();
    this.lowPassFilter = null;
    this.gainNode = null;
  }
}

const enum FadeStatus {
  NONE,
  FADING_IN,
  FADING_OUT,
}

/** Fade / play state of one music track (port of `vi`). */
export class TrackController {
  currentVolume = 0;
  fadeDuration = 500;
  playWhileSilent = false;
  private fadingStatus = FadeStatus.NONE;
  private fadeTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly effect: NightClubEffect;

  constructor(
    readonly sound: ManagedSound,
    readonly trackName: string,
    private isCurrentTrack = false,
  ) {
    this.effect = new NightClubEffect(sound);
  }

  updateCurrentTrackStatus(isCurrent: boolean): void {
    this.isCurrentTrack = isCurrent;
    if (isCurrent) this.play(this.currentVolume);
  }

  play(volume: number): void {
    if ((volume > 0 || this.playWhileSilent) && !this.sound.playing()) this.sound.play();
  }

  isPlaying(): boolean {
    return this.sound.playing();
  }

  setVolume(volume: number, duration = this.fadeDuration): void {
    if (!this.isCurrentTrack) {
      this.currentVolume = volume;
      this.sound.volume(volume);
      return;
    }
    if ((volume === 0 && this.fadingStatus === FadeStatus.FADING_OUT) || (volume === 1 && this.fadingStatus === FadeStatus.FADING_IN)) return;
    if (this.fadeTimeout) clearTimeout(this.fadeTimeout);
    this.fadingStatus = volume === 0 ? FadeStatus.FADING_OUT : FadeStatus.FADING_IN;
    this.play(volume);
    this.sound.fade(this.sound.volume(), volume, duration);
    this.fadeTimeout = setTimeout(() => {
      if (this.fadingStatus === FadeStatus.FADING_OUT) {
        if (!this.playWhileSilent) this.sound.stop();
        this.currentVolume = 0;
      } else {
        this.currentVolume = 1;
      }
      this.fadingStatus = FadeStatus.NONE;
    }, duration);
  }

  applyNightClubEffect(frequency = 300, duration = 500): void {
    this.effect.applyNightClubEffect(frequency, duration);
  }

  removeNightClubEffect(frequency = 18000, duration = 500): void {
    this.effect.removeNightClubEffect(frequency, duration);
  }

  stop(): void {
    this.sound.stop();
    this.fadingStatus = FadeStatus.NONE;
  }

  dispose(): void {
    if (this.fadeTimeout) clearTimeout(this.fadeTimeout);
    this.fadeTimeout = null;
    this.effect.dispose();
    this.sound.stop();
  }
}

export interface MusicManagerHooks {
  /** Subscribes to a runtime event; returns an unsubscribe function. */
  on(name: 'isInteracting' | 'inSubPage', handler: (data: never) => void): () => void;
  isWebsiteStarted(): boolean;
}

/** Cross-fades the section tracks (port of `Si`). */
export class MusicManager {
  private readonly tracks = new Map<string, TrackController>();
  private currentTrackName: string | null = null;
  private currentTrack: TrackController | null = null;
  private kickTrack: TrackController | null = null;
  private inSubpage = false;
  private isInteracting = false;
  private nightClubApplied = false;
  private globalVolume = 1;
  private readonly maxVolumeMusic = MAX_MUSIC_VOLUME;
  private readonly disposers: Array<() => void> = [];

  constructor(
    sounds: Record<string, ManagedSound>,
    private readonly hooks: MusicManagerHooks,
  ) {
    for (const [name, sound] of Object.entries(sounds)) {
      this.tracks.set(name, new TrackController(sound, name, name === MUSIC.SECTION1));
    }
    this.setCurrentTrack(MUSIC.SECTION1);
    document.addEventListener('menuOpen', this.onMenuOpen);
    this.disposers.push(() => document.removeEventListener('menuOpen', this.onMenuOpen));
    this.disposers.push(hooks.on('isInteracting', this.onIsInteracting as (data: never) => void));
    this.disposers.push(hooks.on('inSubPage', this.onInSubPage as (data: never) => void));
  }

  start(trackName: string): void {
    this.setVolumeTrack(trackName, this.maxVolumeMusic, 6000);
  }

  getTrackByName(name: string): TrackController | undefined {
    return this.tracks.get(name);
  }

  private setVolumeTrack(name: string, volume: number, duration: number): void {
    this.tracks.get(name)?.setVolume(volume, duration);
  }

  private setCurrentTrack(name: string): void {
    this.currentTrackName = name;
    this.currentTrack = this.tracks.get(name) ?? null;
    this.currentTrack?.updateCurrentTrackStatus(true);
  }

  switchTrack(name: string, duration = 500): void {
    if (this.currentTrackName === name || !this.hooks.isWebsiteStarted()) return;
    if (this.currentTrackName) this.setVolumeTrack(this.currentTrackName, 0, duration);
    this.currentTrack?.updateCurrentTrackStatus(false);
    this.setCurrentTrack(name);
    this.setVolumeTrack(name, this.maxVolumeMusic * this.globalVolume, duration);
    if (this.nightClubApplied) this.currentTrack?.applyNightClubEffect(300, duration);
  }

  setGlobalVolume(volume: number, duration = 0): void {
    this.globalVolume = volume;
    if (this.currentTrackName) this.setVolumeTrack(this.currentTrackName, this.maxVolumeMusic * this.globalVolume, duration);
  }

  private applyNightClub(frequency = 300, duration = 500): void {
    this.currentTrack?.applyNightClubEffect(frequency, duration);
    this.kickTrack?.applyNightClubEffect(frequency, duration);
  }

  private removeNightClub(frequency = 18000, duration = 500): void {
    this.currentTrack?.removeNightClubEffect(frequency, duration);
    this.kickTrack?.removeNightClubEffect(frequency, duration);
  }

  toggleNightClubEffect(active: boolean): void {
    if (this.nightClubApplied === active) return;
    if (active) this.applyNightClub();
    else this.removeNightClub();
    this.nightClubApplied = active;
  }

  private onMenuOpen = (event: Event): void => {
    const { open } = (event as CustomEvent<{ open: boolean }>).detail;
    if (!this.inSubpage) this.toggleNightClubEffect(open);
  };

  private onInSubPage = ({ inSubpage }: { inSubpage: boolean }): void => {
    this.inSubpage = inSubpage;
    this.toggleNightClubEffect(inSubpage);
  };

  private onIsInteracting = ({ value }: { value: boolean }): void => {
    if (this.isInteracting === value) return;
    this.toggleNightClubEffect(value);
    this.isInteracting = value;
  };

  /** Section 4 "kick" layer, mixed in by scroll progress (ports of `initKickScene4` / `updateScene4Kick`). */
  updateScene4Kick(progress: number): void {
    if (progress === -1) {
      if (!this.kickTrack) return;
      this.kickTrack.playWhileSilent = false;
      this.kickTrack.setVolume(0, 300);
      this.kickTrack.updateCurrentTrackStatus(false);
      this.kickTrack = null;
      return;
    }
    if (!this.kickTrack) {
      this.kickTrack = this.tracks.get(MUSIC.SECTION4_KICK) ?? null;
      if (!this.kickTrack) return;
      if (!this.kickTrack.isPlaying() && this.currentTrack) this.kickTrack.sound.seek(this.currentTrack.sound.seek());
      this.kickTrack.playWhileSilent = true;
    }
    const level = Math.max(0, Math.min(1, -0.23 + progress * 1.3));
    this.kickTrack.updateCurrentTrackStatus(true);
    this.kickTrack.setVolume(level * this.maxVolumeMusic, 5);
  }

  dispose(): void {
    this.disposers.splice(0).forEach((d) => d());
    this.tracks.forEach((t) => t.dispose());
    this.tracks.clear();
    this.currentTrack = null;
    this.kickTrack = null;
  }
}
