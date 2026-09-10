import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { COPY } from '../timeline';
import { brand, font } from '../tokens';
import { useFormat } from '../ui/layout';
import { fadeUp, ramp, settle } from '../ui/motion';
import { Ambient, Rule, Wordmark } from '../ui/primitives';

/**
 * 0:00–0:03. The wordmark cut in by a slow light sweep; a hairline draws
 * beneath it; two lines of copy rise. No bloom, no flash — the sweep is the
 * whole event.
 */
export function S1Logo() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { s, landscape } = useFormat();

  const reveal = settle(frame, fps, 6, 66);
  const size = (landscape ? 168 : 128) * s;

  return (
    <AbsoluteFill style={{ background: brand.bg, justifyContent: 'center', alignItems: 'center' }}>
      <Ambient strength={ramp(frame, 0, 60)} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 * s }}>
        <Wordmark size={size} tracking={0.22} reveal={reveal} />
        <Rule start={46} width={320 * s} />
        <div style={{ marginTop: 6 * s, textAlign: 'center' }}>
          {COPY.logo.lines.map((line, i) => (
            <div
              key={line}
              style={{
                fontFamily: font.body,
                fontWeight: 500,
                fontSize: (landscape ? 40 : 34) * s,
                lineHeight: 1.3,
                color: i === 1 ? brand.accent : brand.text,
                ...fadeUp(frame, 72 + i * 16, 36, 20),
              }}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}
