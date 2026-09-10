'use client';

import { useEffect } from 'react';
import { captureAttribution } from '@/lib/content/attribution';

/**
 * Per-page side effects shared by every route: sets the document language and records the
 * visit attribution (port of the inline scripts of the original pages).
 */
export function PageEffects({ lang }: { lang: string }) {
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    captureAttribution();
  }, []);
  return null;
}
