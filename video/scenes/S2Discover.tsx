import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { JOBS } from '../data/sample';
import { COPY, OVERLAP } from '../timeline';
import { font, product } from '../tokens';
import { JobCard } from '../ui/JobCard';
import { SceneLayout } from '../ui/layout';
import { arrive, count, ramp } from '../ui/motion';
import { Dot, Headline, Sub } from '../ui/primitives';

const CARD_W = 400;
const CARD_H = 118;
const GAP = 14;
const COLS = 2;
const UI_W = CARD_W * COLS + GAP;
const UI_H = 40 + (CARD_H + GAP) * Math.ceil(JOBS.length / COLS);

/**
 * 0:03–0:07. Jobs arrive from every edge — scattered, tilted, out of focus —
 * and settle into a sorted list, each one read (dot) and then confirmed (tick).
 * KIASA is doing the searching and the organising; the candidate is watching.
 */
export function S2Discover() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP);

  // Deterministic scatter: each card has its own origin and tilt.
  const origins = [
    [-520, -200, -7], [560, -260, 6], [-480, 380, 5], [620, 300, -6],
    [-560, 90, 8], [520, 40, -8], [-380, -420, -5], [460, 460, 7],
  ] as const;

  const found = count(frame, 20, 150, COPY.discover.listCount);

  const ui = (
    <div style={{ position: 'relative', width: UI_W, height: UI_H }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 40,
          fontFamily: font.mono,
          fontSize: 14.5,
          letterSpacing: '0.08em',
          color: product.muted,
          opacity: ramp(frame, 8, 24),
        }}
      >
        <Dot state={frame < 175 ? 'working' : 'done'} size={7} />
        {COPY.discover.listTitle} · {found} found
      </div>
      {JOBS.map((job, i) => {
        const start = 10 + i * 11;
        const p = arrive(frame, fps, start);
        const [ox, oy, rot] = origins[i % origins.length];
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const x = col * (CARD_W + GAP);
        const y = 40 + row * (CARD_H + GAP);
        const landed = frame - start;
        const state = landed < 0 ? 'plain' : landed < 55 + i * 4 ? 'reading' : 'read';
        return (
          <div
            key={job.id}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              transform: `translate(${ox * (1 - p)}px, ${oy * (1 - p)}px) rotate(${rot * (1 - p)}deg) scale(${0.86 + 0.14 * p})`,
              opacity: Math.min(1, p * 1.6),
              filter: `blur(${(1 - p) * 8}px)`,
            }}
          >
            <JobCard job={job} state={state} width={CARD_W} />
          </div>
        );
      })}
    </div>
  );

  const caption = (
    <div>
      <Headline lines={COPY.discover.main} start={64} size={42} stagger={9} />
      <Sub text={COPY.discover.sub} start={110} style={{ marginTop: 22 }} />
    </div>
  );

  return (
    <AbsoluteFill style={{ background: product.bg, opacity: enter }}>
      <SceneLayout ui={ui} caption={caption} uiSize={{ w: UI_W, h: UI_H }} captionPos="right" uiAlign="start" />
    </AbsoluteFill>
  );
}
