import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand } from '../../tokens';
import { ramp, settle } from '../../ui/motion';
import { KEY_TEXT, SCENES } from '../timeline';
import { Doc, Figure, Glow, KeyLine, Vignette } from '../set';

/**
 * 0:44–0:53. Out of the screen's light into a calm, wide space. Several
 * presences — small lights with trails, no faces — move with purpose along
 * their own paths behind a person who is simply looking out. The paths
 * gather into one line, which hands the person a single, finished thing.
 * Then light.
 */

interface Path { x0: number; y0: number; cx: number; cy: number; x1: number; y1: number; phase: number }

const PATHS: readonly Path[] = [
  { x0: -100, y0: 300, cx: 700, cy: 120, x1: 1500, y1: 560, phase: 0.0 },
  { x0: 2000, y0: 220, cx: 1200, cy: 460, x1: 1500, y1: 560, phase: 0.25 },
  { x0: -60, y0: 760, cx: 500, cy: 640, x1: 1500, y1: 560, phase: 0.5 },
  { x0: 2050, y0: 860, cx: 1300, cy: 700, x1: 1500, y1: 560, phase: 0.7 },
  { x0: 300, y0: -60, cx: 900, cy: 300, x1: 1500, y1: 560, phase: 0.85 },
];

const bez = (p: Path, t: number) => ({
  x: (1 - t) * (1 - t) * p.x0 + 2 * (1 - t) * t * p.cx + t * t * p.x1,
  y: (1 - t) * (1 - t) * p.y0 + 2 * (1 - t) * t * p.cy + t * t * p.y1,
});

export function B6Future() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, 40);

  const dolly = 1 + 0.05 * settle(frame, fps, 0, 520);
  // Each presence travels its own path; by 0:48.5 they have all converged.
  const converge = settle(frame, fps, 200, 120);
  const handoff = settle(frame, fps, 300, 90);
  const light = ramp(frame, 380, 140);

  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: enter }}>
      <div style={{ position: 'absolute', inset: 0, transform: `scale(${dolly})`, transformOrigin: '60% 50%' }}>
        {/* the space: a horizon, a distant light */}
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #020204 0%, #06070d 55%, #0b0c14 72%, #04040a 100%)' }} />
        <Glow x={1500} y={600} rx={700} ry={260} color="#c9d0ff" opacity={0.10 + 0.5 * light} blur={80} />
        <Glow x={1500} y={600} rx={300} ry={110} color="#ffffff" opacity={0.08 + 0.6 * light} blur={50} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 690, height: 1, background: 'rgba(200,206,255,0.14)' }} />

        {/* the presences and their trails */}
        <svg style={{ position: 'absolute', inset: 0 }} width={1920} height={1080}>
          {PATHS.map((p, i) => {
            const t = Math.min(1, Math.max(0, ((frame / 60) * 0.11 + p.phase) % 1.2));
            const tt = t + (1 - t) * converge;
            const pos = bez(p, tt);
            const trail = Array.from({ length: 14 }, (_, k) => bez(p, Math.max(0, tt - k * 0.02)));
            return (
              <g key={i} opacity={1 - handoff * 0.85}>
                {trail.map((q, k) => (
                  <circle key={k} cx={q.x} cy={q.y} r={4 - k * 0.22} fill={brand.accent} opacity={(1 - k / 14) * 0.35} />
                ))}
                <circle cx={pos.x} cy={pos.y} r={5} fill="#fff" opacity={0.9} />
                <circle cx={pos.x} cy={pos.y} r={12} fill={brand.accent} opacity={0.25} />
              </g>
            );
          })}
          {/* the one line, once they have gathered */}
          <line x1={1500} y1={560} x2={1500 - 560 * handoff} y2={560 + 30 * handoff} stroke={brand.accent} strokeWidth={1} opacity={0.7 * converge} />
        </svg>

        {/* the finished thing, handed over */}
        <div
          style={{
            position: 'absolute',
            left: 1500 - 560 * handoff - 40,
            top: 560 + 30 * handoff - 52,
            opacity: converge * (1 - light * 0.6),
            transform: `scale(${0.7 + 0.3 * handoff})`,
          }}
        >
          <Doc w={80} h={104} lines={5} opacity={0.9} accentLines={[0]} />
        </div>

        {/* the person, at ease, looking out */}
        <Figure kind="standing" x={880} y={1000} height={700} rim="#c9d0ff" rimSide="right" soft={1.6} />
      </div>

      {/* the light, rising */}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 30%, rgba(201,208,255,0.35) 100%)', opacity: light * 0.7 }} />

      <Vignette strength={0.55} />
      <KeyLine
        text={KEY_TEXT.future.line}
        start={KEY_TEXT.future.at - SCENES.future.from}
        end={KEY_TEXT.future.until - SCENES.future.from}
        align="center"
      />
    </AbsoluteFill>
  );
}
