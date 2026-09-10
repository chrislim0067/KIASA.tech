/**
 * Keeps exactly one experience runtime alive per document.
 *
 * React Strict Mode mounts effects twice and route changes can remount the runtime
 * component; the lease API makes those cases share the same boot instead of starting two
 * workers. Disposal happens on the next macrotask after the last lease is released so a
 * synchronous remount re-uses the running instance.
 */
import { startExperience, type ExperienceRuntime, type StartOptions } from './index';
import type { ExperienceNavigation } from './navigation';

interface Active {
  promise: Promise<ExperienceRuntime>;
  runtime: ExperienceRuntime | null;
  leases: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  navigation: ExperienceNavigation | null;
}

let active: Active | null = null;

export interface RuntimeLease {
  ready: Promise<ExperienceRuntime>;
  release(): void;
}

export function acquireRuntime(options: StartOptions): RuntimeLease {
  if (active?.disposeTimer) {
    clearTimeout(active.disposeTimer);
    active.disposeTimer = null;
  }
  if (!active) {
    const entry: Active = { promise: Promise.resolve() as unknown as Promise<ExperienceRuntime>, runtime: null, leases: 0, disposeTimer: null, navigation: null };
    entry.promise = startExperience({
      ...options,
      onNavigationCreated: (navigation) => {
        entry.navigation = navigation;
      },
    }).then((runtime) => {
      entry.runtime = runtime;
      return runtime;
    });
    active = entry;
  }
  const entry = active;
  entry.leases += 1;
  let released = false;
  return {
    ready: entry.promise,
    release() {
      if (released) return;
      released = true;
      entry.leases -= 1;
      if (entry.leases > 0) return;
      entry.disposeTimer = setTimeout(() => {
        if (entry.leases > 0) return;
        if (active === entry) active = null;
        if (entry.runtime) entry.runtime.dispose();
        else void entry.promise.then((runtime) => runtime.dispose());
      }, 0);
    },
  };
}

/** The navigation controller of the running (or booting) runtime, if any. */
export function getActiveNavigation(): ExperienceNavigation | null {
  return active?.navigation ?? null;
}
