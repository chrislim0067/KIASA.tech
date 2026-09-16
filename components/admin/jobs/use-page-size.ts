'use client';

import { useSyncExternalStore } from 'react';

/**
 * The remembered "rows per page" setting.
 *
 * Someone who wants ten per page wants it every time, and re-choosing it on
 * every visit is exactly the kind of small friction that makes a setting feel
 * broken. So it lives in `localStorage` — per viewer, per browser, and of no
 * consequence if it comes back empty.
 *
 * WHY useSyncExternalStore RATHER THAN AN EFFECT
 *
 * `localStorage` does not exist during server rendering, so the obvious shapes
 * both fail: a lazy `useState` initialiser reads it during render and produces
 * a hydration mismatch, and reading it in a mount effect means calling
 * `setState` in an effect body, which cascades an extra render on every load of
 * the page. `useSyncExternalStore` is the primitive built for exactly this —
 * `getServerSnapshot` supplies the default for the server and for hydration,
 * and React re-reads the real value immediately afterwards.
 *
 * The store is module-level because the setting is genuinely global to the tab:
 * two components asking for it should never disagree, and a write from one
 * must reach the other.
 */

const STORAGE_KEY = 'kiasa-admin:jobs:page-size';

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

let listeners: (() => void)[] = [];

/**
 * The snapshot must be referentially stable between reads, or
 * `useSyncExternalStore` re-renders forever. Cached rather than re-read from
 * storage on every call, and invalidated only by {@link setStoredPageSize}.
 */
let cached: number | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.push(onChange);
  return () => {
    listeners = listeners.filter((listener) => listener !== onChange);
  };
}

function getSnapshot(): number {
  if (cached !== null) return cached;

  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    cached = (PAGE_SIZES as readonly number[]).includes(stored) ? stored : DEFAULT_PAGE_SIZE;
  } catch {
    // Private mode, or storage disabled. The default is fine.
    cached = DEFAULT_PAGE_SIZE;
  }

  return cached;
}

/** What the server renders, and what hydration matches against. */
function getServerSnapshot(): number {
  return DEFAULT_PAGE_SIZE;
}

export function setStoredPageSize(size: number): void {
  cached = size;

  try {
    window.localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    // Not worth surfacing; the list still works, it just forgets.
  }

  for (const listener of listeners) listener();
}

export function usePageSize(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
