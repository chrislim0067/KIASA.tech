import type { CSSProperties } from 'react';
import { useCurrentFrame } from 'remotion';

import { brand, font } from '../tokens';
import { ramp } from '../ui/motion';

/**
 * The film's set pieces: light, haze, human silhouettes, documents,
 * information streams, and the one text style that ever appears on screen.
 *
 * Everything is drawn — no bitmaps — so it grades with the palette and
 * scales to any frame. Silhouettes are deliberately soft-edged: at
 * cinematic scale a hard vector person reads as an icon.
 */

/* ------------------------------------------------------------------ light */

/** A soft elliptical light. Placed by centre. */
export function Glow({
  x,
  y,
  rx,
  ry = rx,
  color = brand.accent,
  opacity = 0.2,
  blur = 0,
  style,
}: {
  x: number;
  y: number;
  rx: number;
  ry?: number;
  color?: string;
  opacity?: number;
  blur?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x - rx,
        top: y - ry,
        width: rx * 2,
        height: ry * 2,
        borderRadius: '50%',
        background: `radial-gradient(ellipse closest-side, ${color}, transparent)`,
        opacity,
        filter: blur ? `blur(${blur}px)` : undefined,
        pointerEvents: 'none',
        ...style,
      }}
    />
  );
}

/** Edge darkening. Every scene wears one; it is what makes flat black feel like a room. */
export function Vignette({ strength = 0.7 }: { strength?: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(ellipse 80% 70% at 50% 50%, transparent 40%, rgba(0,0,0,${strength}) 100%)`,
        pointerEvents: 'none',
      }}
    />
  );
}

/** Atmospheric haze: a few large, faint, blurred lights. */
export function Haze({ opacity = 0.05 }: { opacity?: number }) {
  return (
    <>
      <Glow x={700} y={300} rx={700} ry={400} color="#8ea0ff" opacity={opacity} blur={60} />
      <Glow x={1300} y={700} rx={800} ry={420} color="#ffffff" opacity={opacity * 0.6} blur={80} />
    </>
  );
}

/* ---------------------------------------------------------------- figures */

const SHAPES = {
  /** Head and shoulders from behind — an audience member. viewBox 80×100. */
  audience: {
    viewBox: '-40 -40 80 100',
    d: 'M0 -18 m-15 0 a15 15 0 1 0 30 0 a15 15 0 1 0 -30 0 M-38 60 L-38 26 C-38 8 -24 2 -10 0 C-4 -1 4 -1 10 0 C24 2 38 8 38 26 L38 60 Z',
  },
  /** A person standing, from behind. viewBox 80×220. */
  standing: {
    viewBox: '-40 -100 80 220',
    d: 'M0 -84 m-14 0 a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0 M-31 -56 C-31 -68 -18 -70 -10 -69 L10 -69 C18 -70 31 -68 31 -56 L26 24 L12 24 L9 112 L-9 112 L-12 24 L-26 24 Z',
  },
  /** Seated at a desk, side-on, facing right. viewBox 120×120. */
  seated: {
    viewBox: '-60 -70 120 120',
    d: 'M-6 -52 m-14 0 a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0 M-30 -30 C-30 -40 -18 -42 -10 -40 C-2 -38 6 -34 12 -26 L46 -18 C50 -17 50 -11 46 -10 L14 -6 L14 40 L-34 40 L-34 -10 C-34 -20 -32 -26 -30 -30 Z',
  },
} as const;

/**
 * A human silhouette. `rim` adds a thin lit edge on one side, which is what
 * separates a person lit by a screen from a black paper cut-out.
 */
export function Figure({
  kind,
  x,
  y,
  height,
  fill = '#04040a',
  rim,
  rimSide = 'right',
  soft = 1.2,
  opacity = 1,
  flip = false,
}: {
  kind: keyof typeof SHAPES;
  x: number;
  y: number;
  height: number;
  fill?: string;
  rim?: string;
  rimSide?: 'left' | 'right';
  soft?: number;
  opacity?: number;
  flip?: boolean;
}) {
  const shape = SHAPES[kind];
  const [, , vw, vh] = shape.viewBox.split(' ').map(Number);
  const width = (height * vw) / vh;
  const rimDx = rimSide === 'right' ? 3 : -3;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y - height,
        width,
        height,
        opacity,
        filter: `blur(${soft}px)`,
        transform: flip ? 'scaleX(-1)' : undefined,
      }}
    >
      {rim ? (
        <svg viewBox={shape.viewBox} width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
          <path d={shape.d} fill={rim} transform={`translate(${rimDx} 0)`} opacity={0.7} />
        </svg>
      ) : null}
      <svg viewBox={shape.viewBox} width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        <path d={shape.d} fill={fill} />
      </svg>
    </div>
  );
}

/* -------------------------------------------------------------- documents */

/** A document as a shape: a page with unreadable lines. */
export function Doc({
  w,
  h,
  lines = 6,
  opacity = 0.5,
  accentLines = [],
  style,
}: {
  w: number;
  h: number;
  lines?: number;
  opacity?: number;
  /** Indices of lines drawn in the accent. */
  accentLines?: readonly number[];
  style?: CSSProperties;
}) {
  const pad = w * 0.12;
  const gap = (h - pad * 2) / lines;
  return (
    <div
      style={{
        width: w,
        height: h,
        border: `1px solid rgba(255,255,255,${0.16 * opacity + 0.04})`,
        borderRadius: Math.max(3, w * 0.03),
        background: `rgba(255,255,255,${0.025 * opacity})`,
        opacity,
        ...style,
      }}
    >
      {Array.from({ length: lines }, (_, i) => {
        const accent = accentLines.includes(i);
        const widthPct = i === 0 ? 55 : 60 + ((i * 37) % 30);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: pad,
              top: pad + i * gap + gap * 0.3,
              width: `${widthPct}%`,
              height: Math.max(1.5, h * 0.012),
              borderRadius: 2,
              background: accent ? brand.accent : `rgba(255,255,255,${i === 0 ? 0.5 : 0.22})`,
              boxShadow: accent ? `0 0 8px ${brand.accent}66` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- streams */

const STREAM_TEXT = [
  're: follow-up — can you send the updated version by Thursday',
  'quarterly_summary_v3.pdf · 2.4 MB',
  'application form · page 3 of 7 · save and continue',
  'meeting notes — action items (12)',
  'invoice 2041 · due in 6 days',
  'research: market sizing, APAC, 2026',
  'status update requested',
  'cover letter — draft 4',
  'onboarding checklist · 9 of 31 complete',
  'reply needed · 14 unread',
  'compliance form B · resubmit',
  'schedule request · 3 conflicts',
  'candidate summary · 17 pages',
  'export · rename · upload · confirm',
];

/**
 * A row of information passing through the frame. `depth` sets size, blur
 * and speed together so rows read as near or far, not as sizes.
 */
export function TextStream({
  y,
  depth,
  offset = 0,
  speed = 1,
  opacity = 0.6,
  color = '#c7cce0',
}: {
  y: number;
  /** 0 = far, 1 = near. */
  depth: number;
  offset?: number;
  speed?: number;
  opacity?: number;
  color?: string;
}) {
  const frame = useCurrentFrame();
  const size = 13 + depth * 14;
  const blur = (1 - depth) * 2.2;
  const px = (40 + depth * 160) * speed;
  const text = STREAM_TEXT.slice(offset % STREAM_TEXT.length)
    .concat(STREAM_TEXT.slice(0, offset % STREAM_TEXT.length))
    .join('      ·      ');
  const x = -((frame * px) / 60 + offset * 137) % 6000;
  return (
    <div
      style={{
        position: 'absolute',
        top: y,
        left: 0,
        whiteSpace: 'nowrap',
        fontFamily: font.mono,
        fontSize: size,
        letterSpacing: '0.04em',
        color,
        opacity: opacity * (0.35 + depth * 0.65),
        filter: `blur(${blur}px)`,
        transform: `translateX(${x + 2400}px)`,
      }}
    >
      {text}      ·      {text}
    </div>
  );
}

/* ------------------------------------------------------------------- type */

/**
 * The one on-screen text style: Syncopate, small, widely tracked, white. A
 * key idea, never a sentence of narration.
 */
export function KeyLine({
  text,
  start,
  end,
  align = 'left',
  size = 24,
  color = 'rgba(255,255,255,0.92)',
}: {
  text: string;
  start: number;
  end: number;
  align?: 'left' | 'center';
  size?: number;
  color?: string;
}) {
  const frame = useCurrentFrame();
  const a = ramp(frame, start, 36) * (1 - ramp(frame, end - 24, 24));
  const rise = (1 - ramp(frame, start, 40)) * 12;
  return (
    <div
      style={{
        position: 'absolute',
        left: align === 'left' ? 120 : 0,
        right: align === 'left' ? undefined : 0,
        bottom: align === 'left' ? 120 : 130,
        textAlign: align,
        fontFamily: font.head,
        fontWeight: 700,
        fontSize: size,
        letterSpacing: '0.3em',
        textTransform: 'uppercase',
        color,
        opacity: a,
        transform: `translateY(${rise}px)`,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

/** Deterministic pseudo-random in [0,1) — layouts must render identically every frame. */
export function seeded(seed: number): () => number {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
