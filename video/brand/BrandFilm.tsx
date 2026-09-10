import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from 'remotion';

import { useBrandFonts } from '../fonts';
import { brand } from '../tokens';
import { AUDIO } from './assets';
import { B1World } from './scenes/B1World';
import { B2Problem } from './scenes/B2Problem';
import { B3Reveal } from './scenes/B3Reveal';
import { B4Capabilities } from './scenes/B4Capabilities';
import { B5Keynote } from './scenes/B5Keynote';
import { B6Future } from './scenes/B6Future';
import { B7End } from './scenes/B7End';
import { OVERLAP, SCENES, type SceneKey } from './timeline';

/**
 * The company film. Seven scenes on a 1920×1080 stage; the stage scales to
 * whatever the composition is, so the same cut renders any 16:9 size.
 *
 * Scenes start {@link OVERLAP} frames early and play their own entrance over
 * the one beneath. Audio is optional and centralised in assets.ts: when the
 * narration and score arrive they are laid under the picture here, and the
 * picture — cut to the markers in timeline.ts — does not move.
 */
export function BrandFilm() {
  useBrandFonts();
  const { width } = useVideoConfig();
  const k = width / 1920;

  const seq = (key: SceneKey) => ({
    from: Math.max(0, SCENES[key].from - OVERLAP),
    durationInFrames: SCENES[key].dur + (SCENES[key].from === 0 ? 0 : OVERLAP),
  });

  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, transform: `scale(${k})`, transformOrigin: '0 0' }}>
        <Sequence {...seq('world')} name="1 · The world is changing"><B1World /></Sequence>
        <Sequence {...seq('problem')} name="2 · The problem"><B2Problem /></Sequence>
        <Sequence {...seq('reveal')} name="3 · Why KIASA exists"><B3Reveal /></Sequence>
        <Sequence {...seq('capabilities')} name="4 · What KIASA does"><B4Capabilities /></Sequence>
        <Sequence {...seq('keynote')} name="5 · Founder keynote"><B5Keynote /></Sequence>
        <Sequence {...seq('future')} name="6 · The future"><B6Future /></Sequence>
        <Sequence {...seq('end')} name="7 · KIASA"><B7End /></Sequence>
      </div>

      {AUDIO.music ? <Audio src={staticFile(AUDIO.music)} volume={0.9} /> : null}
      {AUDIO.voiceover ? <Audio src={staticFile(AUDIO.voiceover)} /> : null}
    </AbsoluteFill>
  );
}
