/**
 * Main-thread event bus (port of the original `qn` class).
 *
 * Events triggered on the worker are echoed back through this bus, and a few main-thread
 * only events (`scroll`, `lenis:scrollTo`, `lenis:stop`, `startWebsite`, `getTextRenderInfo`)
 * are also dispatched here.
 *
 * Differences from the original:
 *  - `on()` registered every handler twice and `off()` removed only one copy, which doubled
 *    every callback and leaked listeners. Handlers are now registered exactly once.
 *  - `off(name)` without a handler removes every handler of that event instead of the last
 *    array element.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventHandler<T = any> = (data: T) => void;

export interface TriggerOptions {
  name: string;
  fireAtStart?: boolean;
  fireVirtualEvents?: boolean;
  log?: boolean;
}

export class EventBus {
  private listeners = new Map<string, Set<EventHandler>>();
  readonly data = new Map<string, unknown>();
  private fireAtStart = new Set<string>();

  on<T = unknown>(name: string, handler: EventHandler<T>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(handler as EventHandler);
    return () => this.off(name, handler);
  }

  once<T = unknown>(name: string, handler: EventHandler<T>): () => void {
    const wrapped: EventHandler<T> = (data) => {
      this.off(name, wrapped);
      handler(data);
    };
    return this.on(name, wrapped);
  }

  off<T = unknown>(name: string, handler?: EventHandler<T>): void {
    const set = this.listeners.get(name);
    if (!set) return;
    if (handler) set.delete(handler as EventHandler);
    else set.clear();
    if (set.size === 0) this.listeners.delete(name);
  }

  has(name: string, handler: EventHandler): boolean {
    return this.listeners.get(name)?.has(handler) ?? false;
  }

  trigger<T = unknown>(options: TriggerOptions | string, data?: T): void {
    const opts = typeof options === 'string' ? { name: options } : options;
    this.data.set(opts.name, data);
    if (opts.fireAtStart) this.fireAtStart.add(opts.name);
    const set = this.listeners.get(opts.name);
    if (!set) return;
    // Copy: handlers may unregister themselves while iterating.
    for (const handler of Array.from(set)) {
      try {
        handler(data);
      } catch (error) {
        console.error(`[events] handler for "${opts.name}" failed`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
    this.data.clear();
    this.fireAtStart.clear();
  }
}

export const events = new EventBus();

/** Helper for DOM CustomEvents used between UI controllers (port of `Re`). */
export const dispatchDom = <T>(name: string, detail?: T): void => {
  document.dispatchEvent(new CustomEvent(name, { detail }));
};
