import { useEffect, useState } from 'react';
import { continueRender, delayRender, staticFile } from 'remotion';

/**
 * Loads the brand faces before the first frame renders.
 *
 * Self-hosted from video/public/fonts — Syncopate-Bold.ttf is the same file
 * scripts/gen-brand-logo.mjs builds the 3D wordmark from, and the Rajdhani
 * faces are the SIL OFL release from the google/fonts repository (licence
 * alongside them). No CDN request, so a render is deterministic and works
 * offline.
 *
 * `delayRender` holds the frame until the faces are in `document.fonts`;
 * without it the first few frames would render in a fallback face.
 */
const FACES = [
  { family: 'Syncopate', file: 'fonts/Syncopate-Bold.ttf', weight: '700' },
  { family: 'Rajdhani', file: 'fonts/Rajdhani-Regular.ttf', weight: '400' },
  { family: 'Rajdhani', file: 'fonts/Rajdhani-Medium.ttf', weight: '500' },
  { family: 'Rajdhani', file: 'fonts/Rajdhani-SemiBold.ttf', weight: '600' },
] as const;

let loading: Promise<void> | null = null;

function loadAll(): Promise<void> {
  if (!loading) {
    loading = Promise.all(
      FACES.map(({ family, file, weight }) => {
        const face = new FontFace(family, `url(${staticFile(file)})`, { weight });
        return face.load().then((loaded) => {
          document.fonts.add(loaded);
        });
      })
    ).then(() => undefined);
  }
  return loading;
}

export function useBrandFonts(): void {
  const [handle] = useState(() => delayRender('Loading brand fonts'));

  useEffect(() => {
    // A failed load still continues the render — a wrong face is a visible
    // problem to fix, a render that never finishes is not.
    loadAll().then(
      () => continueRender(handle),
      () => continueRender(handle)
    );
  }, [handle]);
}
