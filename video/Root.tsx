import { Composition } from 'remotion';

import { BrandFilm } from './brand/BrandFilm';
import { FPS as BRAND_FPS, TOTAL_FRAMES as BRAND_FRAMES } from './brand/timeline';
import { Promo } from './Promo';
import { FPS, TOTAL_FRAMES } from './timeline';

/**
 * Two films.
 *
 * KiasaBrandFilm — the company film: who KIASA is, why it exists, what it
 * builds, who is behind it, where it is going. 59s, 16:9 master.
 *
 * KiasaPromo — the product film, kept as its own composition. Three formats;
 * the vertical and square render the same scenes through {@link SceneLayout}.
 */
export function RemotionRoot() {
  return (
    <>
      <Composition
        id="KiasaBrandFilm"
        component={BrandFilm}
        durationInFrames={BRAND_FRAMES}
        fps={BRAND_FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="KiasaPromo16x9"
        component={Promo}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="KiasaPromo9x16"
        component={Promo}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1080}
        height={1920}
      />
      <Composition
        id="KiasaPromo1x1"
        component={Promo}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1080}
        height={1080}
      />
    </>
  );
}
