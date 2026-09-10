import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand } from '../../tokens';
import { ramp } from '../../ui/motion';
import { ORIGINAL, ORIGINAL_CUTS } from '../timeline';

/**
 * A beat of the original film, played as it is.
 *
 * These are the identity: the exact wordmark treatment, the exact type, the
 * exact figures the company put on its own site. They are not re-drawn — a
 * re-drawing would be a second opinion. They are cut in, frame-accurately,
 * from the live MP4, with only a short fade at each end so a hard cut into a
 * black card never flashes.
 */
export function OriginalCut({ cut, fadeIn = 8, fadeOut = 8 }: { cut: keyof typeof ORIGINAL_CUTS; fadeIn?: number; fadeOut?: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { at, dur } = ORIGINAL_CUTS[cut];
  const frames = Math.round(dur * fps);
  const a = ramp(frame, 0, fadeIn) * (1 - ramp(frame, frames - fadeOut, fadeOut));
  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: a }}>
      <OffthreadVideo
        src={staticFile(ORIGINAL)}
        startFrom={Math.round(at * fps)}
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </AbsoluteFill>
  );
}
