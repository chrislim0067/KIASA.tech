import { AbsoluteFill } from 'remotion';

import { brand } from '../../tokens';
import { PLATES, SCENES } from '../timeline';
import { Plate } from '../Plate';

/** 0:00–0:04. The city at dusk. Nothing said. */
export function Open() {
  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <Plate src={PLATES.city} duration={SCENES.open.dur} fadeIn={50} fadeOut={24} push={0.07} pan={[-0.01, 0]} vignette={0.55} />
    </AbsoluteFill>
  );
}
