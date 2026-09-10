import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand, font } from '../../tokens';
import { arrive, pulse, ramp, settle } from '../../ui/motion';
import { KEY_TEXT, OVERLAP } from '../timeline';
import { Doc, Figure, Vignette, seeded } from '../set';

/**
 * 0:07–0:14. The work. Documents and forms arrive from every side and stack
 * into depth, faster and faster, while one person stands still at the centre
 * and the camera pulls back so they get smaller as the work gets bigger.
 * Then it all stops: one empty field, one blinking caret.
 */
export function B2Problem() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP);

  const rnd = seeded(23);
  const docs = Array.from({ length: 54 }, (_, i) => {
    const z = 0.4 + rnd() * 1.2; // depth: bigger and sharper when near
    return {
      x: (rnd() - 0.5) * 2600,
      y: (rnd() - 0.5) * 1500,
      z,
      w: (90 + rnd() * 80) * z,
      rot: (rnd() - 0.5) * 16,
      lines: 4 + Math.floor(rnd() * 5),
      // Arrivals accelerate: the gap between documents shrinks as i grows.
      born: Math.round(12 + 250 * Math.pow(i / 54, 0.62)),
      from: rnd() * Math.PI * 2,
    };
  });

  const pullBack = 1 - 0.22 * settle(frame, fps, 0, 250);
  const stop = ramp(frame, 240, 40); // everything dims
  const caret = pulse(frame, fps, 1.2, 0, 1) > 0.5 ? 1 : 0;

  const labels = KEY_TEXT.problem.labels;

  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: enter }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${pullBack})`,
          transformOrigin: '50% 58%',
          opacity: 1 - stop * 0.9,
        }}
      >
        {docs.map((d, i) => {
          const p = arrive(frame, fps, d.born);
          if (p <= 0) return null;
          const sx = 960 + d.x * 0.5 + Math.cos(d.from) * 900 * (1 - p);
          const sy = 540 + d.y * 0.5 + Math.sin(d.from) * 600 * (1 - p);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: sx,
                top: sy,
                transform: `translate(-50%, -50%) rotate(${d.rot}deg) scale(${0.5 + 0.5 * p})`,
                filter: `blur(${(1.6 - d.z) * 1.6 + (1 - p) * 3}px)`,
                opacity: Math.min(1, p * 1.6),
              }}
            >
              <Doc w={d.w} h={d.w * 1.3} lines={d.lines} opacity={0.25 + d.z * 0.4} />
            </div>
          );
        })}

        {/* the labels, drifting through at different depths */}
        {labels.map((label, i) => {
          const at = 20 + i * 36;
          const p = ramp(frame, at, 200);
          const a = ramp(frame, at, 24) * (1 - ramp(frame, at + 150, 60));
          const lane = [200, 880, 340, 760, 520, 660][i];
          const dir = i % 2 === 0 ? 1 : -1;
          return (
            <div
              key={label}
              style={{
                position: 'absolute',
                top: lane,
                left: dir > 0 ? -300 + p * 1200 : 1920 - p * 1200,
                fontFamily: font.head,
                fontWeight: 700,
                fontSize: 15 + (i % 3) * 5,
                letterSpacing: '0.34em',
                textTransform: 'uppercase',
                color: 'rgba(216,180,254,0.85)',
                opacity: a,
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </div>
          );
        })}

        {/* the person, still, getting smaller */}
        <Figure kind="standing" x={960} y={905} height={560} rim="#6b73a0" rimSide="left" soft={1.4} />
      </div>

      {/* the stop: one field, one caret */}
      <div
        style={{
          position: 'absolute',
          left: 700,
          top: 512,
          width: 520,
          height: 56,
          border: '1px solid rgba(255,255,255,0.22)',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.35)',
          opacity: stop,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 18,
            top: 16,
            width: 2,
            height: 24,
            background: 'rgba(255,255,255,0.85)',
            opacity: caret,
          }}
        />
      </div>

      <Vignette strength={0.8} />
    </AbsoluteFill>
  );
}
