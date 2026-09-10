import { AbsoluteFill, Sequence } from 'remotion';

import { useBrandFonts } from './fonts';
import { S1Logo } from './scenes/S1Logo';
import { S2Discover } from './scenes/S2Discover';
import { S3Match } from './scenes/S3Match';
import { S4Prepare } from './scenes/S4Prepare';
import { S5Pipeline } from './scenes/S5Pipeline';
import { S7End } from './scenes/S7End';
import { OVERLAP, SCENES } from './timeline';
import { brand } from './tokens';

/**
 * The film. One <Sequence> per scene, each starting {@link OVERLAP} frames
 * before its nominal in-point so it can play its own entrance over the scene
 * beneath. Later sequences stack on top, which is what makes an entering
 * wipe reveal the new scene rather than erase the old one.
 *
 * Scenes 5 and 6 are one component — the pull-back from the pipeline into the
 * dashboard is a single camera move and cannot be cut in half.
 */
export function Promo() {
  useBrandFonts();

  const seq = (key: keyof typeof SCENES, extra = 0) => ({
    from: Math.max(0, SCENES[key].from - OVERLAP),
    durationInFrames: SCENES[key].dur + extra + (SCENES[key].from === 0 ? 0 : OVERLAP),
  });

  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <Sequence {...seq('logo')} name="1 · Logo">
        <S1Logo />
      </Sequence>
      <Sequence {...seq('discover')} name="2 · Discover">
        <S2Discover />
      </Sequence>
      <Sequence {...seq('match')} name="3 · Match">
        <S3Match />
      </Sequence>
      <Sequence {...seq('prepare')} name="4 · Prepare">
        <S4Prepare />
      </Sequence>
      <Sequence {...seq('automate', SCENES.dashboard.dur)} name="5–6 · Automate → Dashboard">
        <S5Pipeline />
      </Sequence>
      <Sequence {...seq('end')} name="7 · End">
        <S7End />
      </Sequence>
    </AbsoluteFill>
  );
}
