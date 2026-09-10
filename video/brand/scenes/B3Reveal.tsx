import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand, font } from '../../tokens';
import { ramp, settle } from '../../ui/motion';
import { Wordmark } from '../../ui/primitives';
import { KEY_TEXT, OVERLAP } from '../timeline';
import { Glow, Vignette } from '../set';

/**
 * 0:14–0:22. The noise is gone. What is left of it collapses into a single
 * line; the light sweep cuts the wordmark in, slowly; one bloom; then the
 * idea beneath it, one word at a time. The film's centre of gravity — given
 * room, not rushed.
 */
export function B3Reveal() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP);

  // The remnants of the pile flatten into the horizon line.
  const collapse = settle(frame, fps, 10, 70);
  const line = ramp(frame, 60, 70) * (1 - ramp(frame, 150, 60));

  // The reveal itself: slower than the product film's, and larger.
  const reveal = settle(frame, fps, 130, 130);
  const bloom = ramp(frame, 200, 40) * (1 - ramp(frame, 240, 120));
  const glow = 0.08 + 0.42 * bloom;

  // The idea, one word per beat.
  const words = KEY_TEXT.reveal.tagline.split(' ');
  const wordAt = (i: number) => 300 + i * 16;
  const rule = ramp(frame, 286, 50);

  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: enter, justifyContent: 'center', alignItems: 'center' }}>
      {/* what is left of the work */}
      {[-520, -300, -120, 80, 260, 440].map((x, i) => (
        <div
          key={x}
          style={{
            position: 'absolute',
            left: 960 + x,
            top: 540,
            width: 110 + (i % 3) * 30,
            height: 140,
            marginTop: -70,
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 4,
            transform: `scaleY(${1 - collapse}) rotate(${(i - 2.5) * 3 * (1 - collapse)}deg)`,
            opacity: 0.35 * (1 - collapse * 0.7),
          }}
        />
      ))}
      <div
        style={{
          position: 'absolute',
          top: 539,
          left: 960 - 260 * line,
          width: 520 * line,
          height: 1,
          background: brand.accent,
          opacity: 0.7,
        }}
      />

      <Glow x={960} y={540} rx={760} ry={420} color={brand.accent} opacity={glow} blur={70} />
      <Glow x={960} y={540} rx={320} ry={180} color="#ffffff" opacity={0.18 * bloom} blur={50} />

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34 }}>
        <Wordmark size={200} tracking={0.22} reveal={reveal} />
        <div style={{ width: 360 * rule, height: 1, background: brand.accent, opacity: 0.6 }} />
        <div
          style={{
            display: 'flex',
            gap: '0.9em',
            fontFamily: font.head,
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: '0.3em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.92)',
          }}
        >
          {words.map((w, i) => {
            const a = ramp(frame, wordAt(i), 30);
            return (
              <span key={w + i} style={{ opacity: a, transform: `translateY(${(1 - a) * 10}px)` }}>
                {w}
              </span>
            );
          })}
        </div>
      </div>

      <Vignette strength={0.6} />
    </AbsoluteFill>
  );
}
