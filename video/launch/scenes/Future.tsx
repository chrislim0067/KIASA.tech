import { AbsoluteFill } from 'remotion';

import { brand } from '../../tokens';
import { PLATES, SCENES } from '../timeline';
import { Plate } from '../Plate';

/**
 * 0:58–1:03. Three people, a tablet, a window onto the city — and the line
 * the film has been building to, carried by the plate itself.
 */
export function Future() {
  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <Plate src={PLATES.alongside} duration={SCENES.future.dur} fadeIn={20} fadeOut={40} push={0.05} pan={[0.008, 0]} dim={0.06} vignette={0.6} />
    </AbsoluteFill>
  );
}
