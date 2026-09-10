/**
 * Single requestAnimationFrame loop shared by every main-thread animation
 * (port of `lt`). The loop stops itself when no callback is registered and
 * pauses while the document is hidden.
 */
export type TickCallback = (time: number) => void;

export class Ticker {
  private callbacks = new Set<TickCallback>();
  private rafId: number | null = null;
  private paused = false;

  private readonly loop = (time: number): void => {
    this.rafId = null;
    for (const cb of Array.from(this.callbacks)) {
      try {
        cb(time);
      } catch (error) {
        console.error('[ticker] callback failed', error);
      }
    }
    if (this.callbacks.size > 0 && !this.paused) this.rafId = requestAnimationFrame(this.loop);
  };

  add(cb: TickCallback): () => void {
    this.callbacks.add(cb);
    this.start();
    return () => this.remove(cb);
  }

  remove(cb: TickCallback): void {
    this.callbacks.delete(cb);
    if (this.callbacks.size === 0) this.stop();
  }

  pause(): void {
    this.paused = true;
    this.stop();
  }

  resume(): void {
    this.paused = false;
    this.start();
  }

  private start(): void {
    if (this.rafId === null && !this.paused && this.callbacks.size > 0) {
      this.rafId = requestAnimationFrame(this.loop);
    }
  }

  private stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  dispose(): void {
    this.callbacks.clear();
    this.stop();
  }
}

export const ticker = new Ticker();
