'use client';

import { useEffect, useLayoutEffect } from 'react';
import type { PageScript } from '@/types/page';

/**
 * A document only ever hosts one legacy page, and its scripts must execute
 * exactly once. React StrictMode double-invokes effects in development, which
 * without this guard loads every script twice — Turnstile warns, event
 * listeners double up, and the WebGL scenes get built twice on one canvas.
 * Module scope is per document, and every internal link is a plain <a> (a real
 * navigation), so this resets naturally on each page load.
 */
let started = false;
let unwrapped = false;

/**
 * Restores the original document shape, then runs the page's scripts.
 *
 * **Unwrap.** Server-rendered markup arrives inside a wrapper element, but the
 * original pages had those nodes as *direct children of `<body>`*. Real
 * behaviour depends on it: `_setGalleryModalIsolation` marks every
 * `document.body.children` entry `inert` when a gallery modal opens — with a
 * wrapper in place it would inert the modal itself and trap the user. React
 * never re-renders this subtree (static `dangerouslySetInnerHTML`), so moving
 * the nodes out is safe.
 *
 * **Execute.** Scripts run in original document order, classic vs module
 * preserved, each awaited so ordering matches the original parse.
 */
export default function LegacyRuntime({ scripts, wrapperId }: { scripts: PageScript[]; wrapperId: string }) {
  useLayoutEffect(() => {
    if (unwrapped) return;
    const wrapper = document.getElementById(wrapperId);
    if (!wrapper?.parentNode) return;
    const parent = wrapper.parentNode;
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
    unwrapped = true;
  }, [wrapperId]);

  useEffect(() => {
    if (started) return;
    started = true;

    const load = (s: PageScript) =>
      new Promise<void>((resolve) => {
        const el = document.createElement('script');
        if (s.module) el.type = 'module';
        el.src = s.src;
        el.async = false; // ordering comes from awaiting; never let the browser reorder
        el.onload = () => resolve();
        el.onerror = () => {
          console.warn('[legacy] failed to load', s.src);
          resolve();
        };
        document.body.appendChild(el);
      });

    // Opt-in on localhost: these write into the live GTM / GA4 / Meta properties,
    // so a dev session would otherwise appear as real traffic and real conversions.
    const analyticsOn = process.env.NEXT_PUBLIC_WT_ANALYTICS === '1';
    const queue = analyticsOn ? scripts : scripts.filter((s) => !s.analytics);
    const heldBack = scripts.length - queue.length;
    if (heldBack) {
      console.info(`[legacy] ${heldBack} analytics script(s) held back — set NEXT_PUBLIC_WT_ANALYTICS=1 to run them`);
    }

    void (async () => {
      for (const s of queue) await load(s);
    })();
  }, [scripts]);

  return null;
}
