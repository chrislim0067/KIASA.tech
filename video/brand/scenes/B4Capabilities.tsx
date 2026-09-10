import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { FOCUS_JOB } from '../../data/sample';
import { brand, font, product } from '../../tokens';
import { JobCard } from '../../ui/JobCard';
import { arrive, pulse, ramp, settle } from '../../ui/motion';
import { Chip } from '../../ui/primitives';
import { CAPABILITY_BEATS, KEY_TEXT, OVERLAP } from '../timeline';
import { Doc, Glow, Vignette, seeded } from '../set';

const SLOT = 1920;

/**
 * 0:22–0:32. Five capabilities of KIASA intelligence, one continuous lateral
 * move through five abstract compositions. No interface. The only product
 * element in the film — one real card — appears for 1.5 seconds inside
 * UNDERSTAND and leaves.
 */
export function B4Capabilities() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP);

  // Camera: eases to each slot at its beat's in-point.
  let x = 0;
  CAPABILITY_BEATS.forEach((b, i) => {
    if (i === 0) return;
    x += SLOT * settle(frame, fps, b.from - 20, 46);
  });

  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: enter }}>
      <div style={{ position: 'absolute', inset: 0, transform: `translateX(${-x}px)` }}>
        {CAPABILITY_BEATS.map((b, i) => (
          <Beat key={b.key} index={i} word={b.word} local={frame - b.from}>
            {b.key === 'search' && <Search local={frame - b.from} />}
            {b.key === 'understand' && <Understand local={frame - b.from} />}
            {b.key === 'prepare' && <Prepare local={frame - b.from} />}
            {b.key === 'coordinate' && <Coordinate local={frame - b.from} />}
            {b.key === 'act' && <Act local={frame - b.from} />}
          </Beat>
        ))}
      </div>
      <Vignette strength={0.65} />
    </AbsoluteFill>
  );
}

/** A slot in the lateral world: the composition centred, the word beneath. */
function Beat({ index, word, local, children }: { index: number; word: string; local: number; children: ReactNode }) {
  const wordA = ramp(local, 14, 30);
  return (
    <div style={{ position: 'absolute', left: index * SLOT, top: 0, width: SLOT, height: 1080 }}>
      {/* Compositions are drawn at 900×480 and shown at 1.3×: at 1:1 they sat
          small in a 1080p frame, and small reads as timid. */}
      <div style={{ position: 'absolute', left: 510, top: 250, width: 900, height: 480, transform: 'scale(1.3)', transformOrigin: '50% 50%' }}>
        {children}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 830,
          textAlign: 'center',
          fontFamily: font.head,
          fontWeight: 700,
          fontSize: 30,
          letterSpacing: '0.34em',
          textTransform: 'uppercase',
          color: brand.accent,
          opacity: wordA,
          transform: `translateY(${(1 - wordA) * 10}px)`,
        }}
      >
        {word}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- SEARCH */

function Search({ local }: { local: number }) {
  const rnd = seeded(41);
  const cols = 30;
  const rows = 14;
  const found = new Set([47, 88, 133, 171, 214, 259, 302, 341, 388]);
  const scan = ramp(local, 6, 84);
  const scanX = 900 * scan;
  return (
    <>
      {Array.from({ length: cols * rows }, (_, i) => {
        const cx = (i % cols) * 30 + 15 + (rnd() - 0.5) * 8;
        const cy = Math.floor(i / cols) * 34 + 17 + (rnd() - 0.5) * 8;
        const hit = found.has(i) && scanX > cx;
        const since = hit ? local - (6 + (cx / 900) * 84) : -1;
        const ring = hit ? ramp(since, 0, 40) : 0;
        return (
          <div key={i} style={{ position: 'absolute', left: cx, top: cy }}>
            <div
              style={{
                width: hit ? 5 : 3,
                height: hit ? 5 : 3,
                marginLeft: hit ? -2.5 : -1.5,
                marginTop: hit ? -2.5 : -1.5,
                borderRadius: '50%',
                background: hit ? brand.accent : 'rgba(255,255,255,0.22)',
                boxShadow: hit ? `0 0 10px ${brand.accent}` : undefined,
              }}
            />
            {hit ? (
              <div
                style={{
                  position: 'absolute',
                  left: -14 - ring * 14,
                  top: -14 - ring * 14,
                  width: 28 + ring * 28,
                  height: 28 + ring * 28,
                  borderRadius: '50%',
                  border: `1px solid ${brand.accent}`,
                  opacity: 0.7 * (1 - ring),
                }}
              />
            ) : null}
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: scanX,
          top: -20,
          width: 2,
          height: 520,
          background: `linear-gradient(180deg, transparent, ${brand.accent}, transparent)`,
          boxShadow: `0 0 24px 4px ${brand.accent}55`,
          opacity: scan > 0 && scan < 1 ? 0.9 : 0,
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------ UNDERSTAND */

function Understand({ local }: { local: number }) {
  const lit = [2, 5, 8].filter((_, i) => local > 20 + i * 18);
  const cameo = ramp(local, 50, 20) * (1 - ramp(local, 140, 18));
  return (
    <>
      <div style={{ position: 'absolute', left: 60, top: 20 }}>
        <Doc w={330} h={420} lines={11} opacity={0.8} accentLines={lit} />
      </div>
      <svg style={{ position: 'absolute', inset: 0 }} width={900} height={480}>
        {lit.map((line, i) => {
          const y1 = 20 + 50 + line * 29 + 9;
          const y2 = 120 + i * 90;
          const d = ramp(local, 20 + i * 18 + 6, 30);
          return (
            <g key={line}>
              <line x1={390} y1={y1} x2={390 + 220 * d} y2={y1 + (y2 - y1) * d} stroke={brand.accent} strokeWidth={1} opacity={0.7} />
              <circle cx={610} cy={y2} r={5 * d} fill={brand.accent} opacity={0.9} />
            </g>
          );
        })}
      </svg>
      {/* the film's one product element, 1.5 seconds */}
      <div style={{ position: 'absolute', left: 480, top: 250, opacity: cameo, transform: `translateY(${(1 - cameo) * 12}px)` }}>
        <div style={{ fontFamily: font.head, fontWeight: 700, fontSize: 10.5, letterSpacing: '0.34em', textTransform: 'uppercase', color: product.muted, marginBottom: 8 }}>
          {KEY_TEXT.capabilities.cameo}
        </div>
        <JobCard job={FOCUS_JOB} state="read" width={400} />
        <div style={{ marginTop: 8 }}>
          <Chip tone="success" active size={12}>✓ Strong match · 92</Chip>
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- PREPARE */

function Prepare({ local }: { local: number }) {
  const { fps } = useVideoConfig();
  const rnd = seeded(59);
  const frags = Array.from({ length: 16 }, (_, i) => ({
    fx: rnd() * 900,
    fy: rnd() * 480,
    w: 40 + rnd() * 70,
    tx: 330 + (i % 2) * 140,
    ty: 100 + Math.floor(i / 2) * 34,
    born: 4 + i * 3,
  }));
  const done = ramp(local, 70, 20);
  return (
    <>
      <div style={{ position: 'absolute', left: 300, top: 60, opacity: done }}>
        <Doc w={300} h={360} lines={8} opacity={0.9} accentLines={[0]} />
      </div>
      {frags.map((f, i) => {
        const p = arrive(local, fps, f.born);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: f.fx + (f.tx - f.fx) * p,
              top: f.fy + (f.ty - f.fy) * p,
              width: f.w * (1 - p) + 90 * p,
              height: 3,
              borderRadius: 2,
              background: `rgba(255,255,255,${0.5 - 0.3 * p})`,
              opacity: 1 - done,
              filter: `blur(${(1 - p) * 2}px)`,
            }}
          />
        );
      })}
      <div style={{ position: 'absolute', left: 620, top: 380, opacity: ramp(local, 80, 16) }}>
        <Chip tone="success" active size={13}>✓ Ready</Chip>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ COORDINATE */

function Coordinate({ local }: { local: number }) {
  const nodes = [
    [80, 260], [300, 120], [460, 300], [640, 140], [820, 280], [560, 420],
  ] as const;
  const edges = [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]] as const;
  const path = [0, 1, 2, 3, 4];
  const travel = ramp(local, 30, 70);
  const seg = Math.min(path.length - 2, Math.floor(travel * (path.length - 1)));
  const t = travel * (path.length - 1) - seg;
  const [ax, ay] = nodes[path[seg]];
  const [bx, by] = nodes[path[seg + 1]];
  const px = ax + (bx - ax) * t;
  const py = ay + (by - ay) * t;
  return (
    <svg style={{ position: 'absolute', inset: 0 }} width={900} height={480}>
      {edges.map(([a, b], i) => {
        const d = ramp(local, 6 + i * 9, 24);
        const [x1, y1] = nodes[a];
        const [x2, y2] = nodes[b];
        return <line key={i} x1={x1} y1={y1} x2={x1 + (x2 - x1) * d} y2={y1 + (y2 - y1) * d} stroke="rgba(255,255,255,0.3)" strokeWidth={1} />;
      })}
      {nodes.map(([x, y], i) => (
        <g key={i} opacity={ramp(local, i * 6, 16)}>
          <circle cx={x} cy={y} r={14} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
          <circle cx={x} cy={y} r={3} fill="rgba(255,255,255,0.7)" />
        </g>
      ))}
      <circle cx={px} cy={py} r={6} fill={brand.accent} opacity={travel > 0 ? 1 : 0} />
      <circle cx={px} cy={py} r={16} fill="none" stroke={brand.accent} strokeWidth={1} opacity={travel > 0 ? 0.5 : 0} />
    </svg>
  );
}

/* ------------------------------------------------------------------- ACT */

function Act({ local }: { local: number }) {
  const { fps } = useVideoConfig();
  const inA = ramp(local, 10, 24);
  const press = ramp(local, 78, 8) * (1 - ramp(local, 90, 14));
  const done = ramp(local, 96, 18);
  const ring = pulse(local, fps, 0.8, 0.2, 0.6) * (1 - done);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
      <Glow x={450} y={240} rx={300} ry={180} opacity={0.12 * inA} blur={40} />
      <div style={{ position: 'relative', opacity: inA, transform: `scale(${1 - press * 0.05})` }}>
        <div
          style={{
            position: 'absolute',
            inset: -18,
            borderRadius: 999,
            border: `1px solid ${brand.accent}`,
            opacity: ring,
          }}
        />
        <div style={{ opacity: 1 - done }}>
          <Chip tone="accent" active size={20} style={{ padding: '14px 34px', background: `rgba(216,180,254,${0.16 + press * 0.5})` }}>
            Approve
          </Chip>
        </div>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', opacity: done }}>
          <Chip tone="success" active size={20} style={{ padding: '14px 34px' }}>
            ✓ Done
          </Chip>
        </div>
      </div>
    </div>
  );
}
