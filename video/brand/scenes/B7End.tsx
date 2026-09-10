import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand, font } from '../../tokens';
import { fadeUp, ramp, settle } from '../../ui/motion';
import { Rule, Wordmark } from '../../ui/primitives';
import { KEY_TEXT, OVERLAP } from '../timeline';

/**
 * 0:53–0:59. Black. The wordmark. The line. The address. The only motion is
 * the wordmark's tracking easing closed — then nothing, long enough to
 * remember the name.
 */
export function B7End() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP + 16);

  const markIn = settle(frame, fps, 10, 60);
  const tracking = 0.32 - 0.1 * settle(frame, fps, 10, 260);

  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: enter, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 30 }}>
        <div style={{ opacity: markIn, transform: `translateY(${(1 - markIn) * 12}px)` }}>
          <Wordmark size={160} tracking={tracking} />
        </div>
        <Rule start={70} width={300} />
        <div
          style={{
            fontFamily: font.head,
            fontWeight: 700,
            fontSize: 24,
            letterSpacing: '0.3em',
            marginRight: '-0.3em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.92)',
            ...fadeUp(frame, 110, 40, 12),
          }}
        >
          {KEY_TEXT.end.tagline}
        </div>
        <div
          style={{
            marginTop: 8,
            fontFamily: font.head,
            fontWeight: 700,
            fontSize: 19,
            letterSpacing: '0.46em',
            marginRight: '-0.46em',
            textTransform: 'uppercase',
            color: brand.accent,
            ...fadeUp(frame, 190, 40, 10),
          }}
        >
          {KEY_TEXT.end.url}
        </div>
      </div>
    </AbsoluteFill>
  );
}
