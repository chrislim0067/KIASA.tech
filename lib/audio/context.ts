/**
 * AudioContext unlocking and recovery.
 *
 * Browsers only allow an AudioContext to start after a user gesture. Howler resumes the
 * context from its own `touchend`/`click`/`keydown` listeners; this helper adds
 * `pointerdown`/`touchstart` gestures, retries while the context is `suspended` or
 * `interrupted` (iOS), resumes when the tab becomes visible again and exposes a promise that
 * resolves once audio can actually be heard.
 */
import { Howler } from 'howler';

type ContextState = AudioContextState | 'interrupted';

const GESTURE_EVENTS: Array<keyof DocumentEventMap> = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click'];

export class AudioUnlocker {
  private resolved = false;
  private readonly waiters: Array<() => void> = [];
  private listening = false;
  private disposed = false;

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.attachStateListener();
    this.listenForGesture();
    this.check();
  }

  get context(): AudioContext | null {
    return (Howler.ctx as AudioContext | null) ?? null;
  }

  get state(): ContextState | 'none' {
    return (this.context?.state as ContextState | undefined) ?? 'none';
  }

  get unlocked(): boolean {
    return this.state === 'running';
  }

  /** Resolves when the context is running. Resolves immediately if it already is. */
  whenUnlocked(): Promise<void> {
    if (this.unlocked) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Attempts to resume the context; safe to call at any time. */
  resume(): Promise<boolean> {
    const ctx = this.context;
    if (!ctx) return Promise.resolve(false);
    if (ctx.state === 'running') {
      this.flush();
      return Promise.resolve(true);
    }
    return ctx
      .resume()
      .then(() => {
        this.check();
        return ctx.state === 'running';
      })
      .catch(() => false);
  }

  private attachStateListener(): void {
    const ctx = this.context;
    if (!ctx) return;
    ctx.addEventListener('statechange', this.onStateChange);
  }

  private onStateChange = (): void => {
    this.check();
    if (!this.unlocked) this.listenForGesture();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible' && this.context && this.context.state !== 'running') {
      void this.resume();
    }
  };

  private onGesture = (): void => {
    void this.resume().then((ok) => {
      if (ok) this.stopListeningForGesture();
    });
  };

  private listenForGesture(): void {
    if (this.listening || this.disposed) return;
    this.listening = true;
    GESTURE_EVENTS.forEach((name) => document.addEventListener(name, this.onGesture, { passive: true }));
  }

  private stopListeningForGesture(): void {
    if (!this.listening) return;
    this.listening = false;
    GESTURE_EVENTS.forEach((name) => document.removeEventListener(name, this.onGesture));
  }

  private check(): void {
    if (this.unlocked) {
      this.flush();
      this.stopListeningForGesture();
    }
  }

  private flush(): void {
    this.resolved = true;
    this.waiters.splice(0).forEach((resolve) => resolve());
  }

  dispose(): void {
    this.disposed = true;
    this.stopListeningForGesture();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.context?.removeEventListener('statechange', this.onStateChange);
    this.waiters.length = 0;
  }
}
