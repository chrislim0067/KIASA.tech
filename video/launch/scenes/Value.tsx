import { AbsoluteFill, Sequence } from 'remotion';

import { brand } from '../../tokens';
import { PLATES, SCENES } from '../timeline';
import { Plate } from '../Plate';

const FIRST = 180;
const SECOND = SCENES.value.dur - FIRST;

/**
 * 0:26–0:32. Out of the services into real rooms: two offices, the kind of
 * place the work happens. No words — the figures follow.
 */
export function Value() {
  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <Sequence from={0} durationInFrames={FIRST + 10} name="office">
        <Plate src={PLATES.office} duration={FIRST + 10} fadeIn={20} fadeOut={10} push={0.06} pan={[-0.012, 0]} dim={0.08} vignette={0.65} />
      </Sequence>
      <Sequence from={FIRST} durationInFrames={SECOND} name="team">
        <Plate src={PLATES.team} duration={SECOND} fadeIn={10} fadeOut={26} push={0.05} pan={[0.01, -0.005]} dim={0.1} vignette={0.7} />
      </Sequence>
    </AbsoluteFill>
  );
}
