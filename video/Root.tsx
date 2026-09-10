import { Composition } from 'remotion';

import { Promo } from './Promo';
import { FPS, TOTAL_FRAMES } from './timeline';

/**
 * Three compositions, one film. The 16:9 is the master; the vertical and the
 * square render the same scenes through {@link SceneLayout}, which stacks the
 * caption over the UI when the frame is taller than it is wide.
 */
export function RemotionRoot() {
  return (
    <>
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
