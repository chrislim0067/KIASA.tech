import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { COPY, OVERLAP } from '../timeline';
import { brand, font } from '../tokens';
import { useFormat } from '../ui/layout';
import { fadeUp, ramp, settle } from '../ui/motion';
import { Ambient, Rule, Wordmark } from '../ui/primitives';

/**
 * 0:23–0:26. Everything before it has already blurred away. The wordmark
 * settles, a rule draws, one line, the URL. The only motion at the end is the
 * wordmark's tracking easing closed — the subtle logo animation asked for.
 */
export function S7End() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { s, landscape } = useFormat();
  const enter = ramp(frame, 0, OVERLAP + 10);

  const markIn = settle(frame, fps, 6, 50);
  const tracking = 0.30 - 0.10 * settle(frame, fps, 6, 150);

  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: enter, justifyContent: 'center', alignItems: 'center' }}>
      <Ambient strength={0.8} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 * s }}>
        <div style={{ opacity: markIn, transform: `translateY(${(1 - markIn) * 14}px)` }}>
          <Wordmark size={(landscape ? 150 : 112) * s} tracking={tracking} />
        </div>
        <Rule start={40} width={300 * s} />
        <div
          style={{
            fontFamily: font.body,
            fontWeight: 500,
            fontSize: (landscape ? 34 : 30) * s,
            color: brand.muted,
            textAlign: 'center',
            ...fadeUp(frame, 62, 36, 16),
          }}
        >
          {COPY.end.tagline}
        </div>
        <div
          style={{
            marginTop: 10 * s,
            fontFamily: font.head,
            fontWeight: 700,
            fontSize: 20 * s,
            letterSpacing: '0.46em',
            marginRight: '-0.46em',
            textTransform: 'uppercase',
            color: brand.accent,
            ...fadeUp(frame, 100, 36, 12),
          }}
        >
          {COPY.end.url}
        </div>
      </div>
    </AbsoluteFill>
  );
}
