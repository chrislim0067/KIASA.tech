import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';

import { B3Reveal } from '../brand/scenes/B3Reveal';
import { B7End } from '../brand/scenes/B7End';
import { useBrandFonts } from '../fonts';
import { brand } from '../tokens';
import { Future } from './scenes/Future';
import { Keynote } from './scenes/Keynote';
import { Open } from './scenes/Open';
import { OriginalCut } from './scenes/Original';
import { Problem } from './scenes/Problem';
import { Value } from './scenes/Value';
import { OVERLAP, SCENES, type SceneKey } from './timeline';

/**
 * The launch film. One story from two sources:
 *
 *   the original   the film on kiasa.tech — its beats cut in as they are
 *   the new plates real environments, real people, the founder on stage
 *   the brand system  the reveal, the key line, the closing
 *
 * Every scene starts {@link OVERLAP} frames early and plays its own entrance
 * over the one beneath it; later sequences stack on top. The original's
 * beats are black cards and cut hard, so they take no overlap.
 */
export function LaunchFilm() {
  useBrandFonts();
  const { width } = useVideoConfig();
  const k = width / 1920;

  const seq = (key: SceneKey, overlap = OVERLAP) => ({
    from: Math.max(0, SCENES[key].from - overlap),
    durationInFrames: SCENES[key].dur + (SCENES[key].from === 0 ? 0 : overlap),
  });

  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, transform: `scale(${k})`, transformOrigin: '0 0' }}>
        <Sequence {...seq('open')} name="1 · Open"><Open /></Sequence>
        <Sequence {...seq('problem')} name="2 · Problem"><Problem /></Sequence>
        <Sequence {...seq('reveal')} name="3 · KIASA"><B3Reveal /></Sequence>
        <Sequence {...seq('singapore', 0)} name="4 · Singapore (original)"><OriginalCut cut="singapore" fadeIn={4} fadeOut={4} /></Sequence>
        <Sequence {...seq('year', 0)} name="5 · 2026 (original)"><OriginalCut cut="year" fadeIn={4} /></Sequence>
        <Sequence {...seq('grow', 0)} name="6 · Grow · Your Business · With Us (original)"><OriginalCut cut="grow" fadeIn={6} fadeOut={12} /></Sequence>
        <Sequence {...seq('value')} name="7 · Real-world value"><Value /></Sequence>
        <Sequence {...seq('keynote')} name="8 · Keynote"><Keynote /></Sequence>
        <Sequence {...seq('future')} name="9 · Future"><Future /></Sequence>
        <Sequence {...seq('end')} name="10 · KIASA"><B7End /></Sequence>
      </div>
    </AbsoluteFill>
  );
}
