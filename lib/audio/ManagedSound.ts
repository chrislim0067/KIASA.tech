/**
 * A Howl wrapper that survives load failures.
 *
 * Howler picks one source by codec support and never tries the next one when that file
 * fails to load (404, blocked host, CORS). `ManagedSound` keeps the ordered list of
 * candidate URLs and rebuilds the Howl with the next supported format on `loaderror`,
 * re-attaching every listener. It also exposes the current Web Audio source nodes for the
 * effect groups.
 */
import { Howl, Howler } from 'howler';

export interface ManagedSoundOptions {
  name: string;
  sources: string[];
  volume?: number;
  loop?: boolean;
  preload?: boolean;
}

type HowlEvent = 'play' | 'stop' | 'end' | 'fade' | 'load' | 'loaderror' | 'playerror';
type Listener = (id?: number) => void;

interface HowlInternals {
  _sounds: Array<{ _node?: AudioNode | HTMLAudioElement; _paused: boolean }>;
  _state: 'unloaded' | 'loading' | 'loaded';
}

const extension = (url: string): string => url.split('?')[0]!.split('.').pop()?.toLowerCase() ?? '';

export class ManagedSound {
  readonly name: string;
  private howl: Howl;
  private candidates: string[];
  private index = 0;
  private listeners = new Map<HowlEvent, Set<Listener>>();
  private disposed = false;
  private readonly options: ManagedSoundOptions;
  /** True when every candidate failed. */
  failed = false;

  constructor(options: ManagedSoundOptions) {
    this.options = options;
    this.name = options.name;
    this.candidates = ManagedSound.supported(options.sources);
    if (this.candidates.length === 0) this.candidates = [...options.sources];
    this.howl = this.build();
  }

  /** Keeps only sources whose format the browser can decode, preserving order. */
  static supported(sources: string[]): string[] {
    return sources.filter((src) => {
      const ext = extension(src);
      try {
        return ext ? Howler.codecs(ext) : true;
      } catch {
        return true;
      }
    });
  }

  private build(): Howl {
    const src = this.candidates[this.index]!;
    const howl = new Howl({
      src: [src],
      // Explicit format: Howler cannot always infer it from an extension-less CDN path.
      format: [extension(src)],
      volume: this.options.volume ?? 1,
      loop: this.options.loop ?? false,
      preload: this.options.preload ?? true,
      html5: false,
    });
    howl.on('loaderror', this.onLoadError);
    for (const [event, set] of this.listeners) set.forEach((l) => howl.on(event, l));
    return howl;
  }

  private onLoadError = (_id: number | undefined, error: unknown): void => {
    if (this.disposed) return;
    const failedSrc = this.candidates[this.index];
    if (this.index + 1 < this.candidates.length) {
      console.warn(`[audio] "${this.name}" failed to load ${failedSrc} (${String(error)}), trying next format`);
      const wasPlaying = this.howl.playing();
      const volume = this.howl.volume();
      this.howl.off();
      this.howl.unload();
      this.index += 1;
      this.howl = this.build();
      this.howl.volume(volume);
      if (wasPlaying) this.howl.play();
      return;
    }
    this.failed = true;
    console.error(`[audio] "${this.name}" could not be loaded from any source`, error);
    this.listeners.get('loaderror')?.forEach((l) => l());
  };

  get raw(): Howl {
    return this.howl;
  }

  get state(): 'unloaded' | 'loading' | 'loaded' {
    return (this.howl as unknown as HowlInternals)._state;
  }

  /** Active Web Audio source nodes (one per playing instance). */
  get sourceNodes(): AudioNode[] {
    const nodes: AudioNode[] = [];
    for (const sound of (this.howl as unknown as HowlInternals)._sounds) {
      const node = sound._node;
      if (node && 'connect' in node && typeof (node as AudioNode).connect === 'function') nodes.push(node as AudioNode);
    }
    return nodes;
  }

  get firstSourceNode(): AudioNode | null {
    return this.sourceNodes[0] ?? null;
  }

  on(event: HowlEvent, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    if (event !== 'loaderror') this.howl.on(event, listener);
    return () => this.off(event, listener);
  }

  once(event: HowlEvent, listener: Listener): void {
    const wrapped: Listener = (id) => {
      this.off(event, wrapped);
      listener(id);
    };
    this.on(event, wrapped);
  }

  off(event: HowlEvent, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
    if (event !== 'loaderror') this.howl.off(event, listener);
  }

  load(): void {
    if (this.disposed || this.failed) return;
    if (this.state === 'unloaded') this.howl.load();
  }

  play(): number | null {
    if (this.disposed || this.failed) return null;
    return this.howl.play();
  }

  playing(): boolean {
    return this.howl.playing();
  }

  stop(): void {
    this.howl.stop();
  }

  pause(): void {
    this.howl.pause();
  }

  volume(): number;
  volume(value: number): void;
  volume(value?: number): number | void {
    if (value === undefined) return this.howl.volume();
    this.howl.volume(value);
  }

  fade(from: number, to: number, duration: number): void {
    this.howl.fade(from, to, duration);
  }

  seek(): number;
  seek(position: number): void;
  seek(position?: number): number | void {
    if (position === undefined) {
      const value = this.howl.seek();
      return typeof value === 'number' ? value : 0;
    }
    this.howl.seek(position);
  }

  dispose(): void {
    this.disposed = true;
    this.howl.off();
    this.howl.stop();
    this.howl.unload();
    this.listeners.clear();
  }
}
