import { AbsoluteFill, useCurrentFrame } from 'remotion';

import { brand } from '../../tokens';
import { ramp } from '../../ui/motion';
import { KeyLine, TextStream } from '../../brand/set';
import { KEY_TEXT, PLATES, SCENES } from '../timeline';
import { Plate } from '../Plate';

/**
 * 0:04–0:09. A real person under the work, information passing through the
 * room. One line. Then black, and the wordmark.
 */
export function Problem() {
  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <Plate src={PLATES.tired} duration={SCENES.problem.dur} fadeIn={16} fadeOut={28} push={0.06} dim={0.08} vignette={0.7}>
        <Streams />
      </Plate>
      <KeyLine text={KEY_TEXT.problem.line} start={KEY_TEXT.problem.at} end={KEY_TEXT.problem.until} />
    </AbsoluteFill>
  );
}

function Streams() {
  const frame = useCurrentFrame();
  const a = ramp(frame, 20, 40);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: a * 0.85, mixBlendMode: 'screen' }}>
      <TextStream y={120} depth={0.2} offset={3} speed={0.9} opacity={0.5} />
      <TextStream y={210} depth={0.6} offset={7} speed={1.3} opacity={0.6} />
      <TextStream y={820} depth={0.9} offset={10} speed={1.7} opacity={0.6} />
      <TextStream y={920} depth={0.4} offset={1} speed={1.1} opacity={0.45} />
    </div>
  );
}
