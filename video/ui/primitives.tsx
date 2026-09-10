import type { CSSProperties, ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';

import { brand, font, product } from '../tokens';
import { fadeUp, pulse, ramp } from './motion';

/* ------------------------------------------------------------- wordmark */

/**
 * The KIASA wordmark — Syncopate Bold, uppercase, tracked. This IS the logo;
 * there is no separate mark. `tracking` matches the stylesheet's
 * letter-spacing in em (0.34 in the app chrome, looser at display sizes).
 *
 * `reveal` clips it in from the left, with a thin light bar riding the edge —
 * the film's one signature motion, used at the open and nowhere else.
 */
export function Wordmark({
  size = 160,
  tracking = 0.2,
  color = brand.text,
  reveal = 1,
  style,
}: {
  size?: number;
  tracking?: number;
  color?: string;
  reveal?: number;
  style?: CSSProperties;
}) {
  const clip = Math.max(0, Math.min(1, reveal));
  return (
    <div style={{ position: 'relative', display: 'inline-block', lineHeight: 1, ...style }}>
      <div
        style={{
          fontFamily: font.head,
          fontWeight: 700,
          fontSize: size,
          letterSpacing: `${tracking}em`,
          // Letter-spacing trails the last glyph; pull it back so the run centres.
          marginRight: `-${tracking}em`,
          textTransform: 'uppercase',
          color,
          whiteSpace: 'nowrap',
          clipPath: `inset(0 ${(1 - clip) * 100}% 0 0)`,
        }}
      >
        KIASA
      </div>
      {clip > 0 && clip < 1 ? (
        <div
          style={{
            position: 'absolute',
            top: -size * 0.35,
            bottom: -size * 0.35,
            left: `calc(${clip * 100}% - 1px)`,
            width: 2,
            background: `linear-gradient(180deg, transparent, ${brand.accent} 30%, #fff 50%, ${brand.accent} 70%, transparent)`,
            boxShadow: `0 0 18px 2px ${brand.accent}`,
            opacity: 0.9,
          }}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- captions */

/**
 * A scene's headline: Syncopate, uppercase, tracked — the `.kauth__welcome`
 * treatment. Lines enter one after another on the brand curve.
 */
export function Headline({
  lines,
  start,
  size = 44,
  color = brand.text,
  align = 'left',
  stagger = 12,
}: {
  lines: readonly string[];
  start: number;
  size?: number;
  color?: string;
  align?: 'left' | 'center';
  stagger?: number;
}) {
  const frame = useCurrentFrame();
  return (
    <div style={{ textAlign: align }}>
      {lines.map((line, i) => (
        <div
          key={line}
          style={{
            fontFamily: font.head,
            fontWeight: 700,
            fontSize: size,
            lineHeight: 1.22,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color,
            ...fadeUp(frame, start + i * stagger, 34, 26),
          }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

/** Supporting copy under a headline: Rajdhani, muted. */
export function Sub({
  text,
  start,
  size = 28,
  color = brand.muted,
  align = 'left',
  style,
}: {
  text: string;
  start: number;
  size?: number;
  color?: string;
  align?: 'left' | 'center';
  style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        fontFamily: font.body,
        fontWeight: 500,
        fontSize: size,
        lineHeight: 1.45,
        color,
        textAlign: align,
        ...fadeUp(frame, start, 30, 18),
        ...style,
      }}
    >
      {text}
    </div>
  );
}

/** The small tracked label the product uses for section headers and row labels. */
export function Kicker({
  children,
  color = product.accent,
  size = 12,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontFamily: font.head,
        fontWeight: 700,
        fontSize: size,
        letterSpacing: '0.25em',
        textTransform: 'uppercase',
        color,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- product */

/** A `.kprof` surface: soft border, 8px radius, faint fill. */
export function Panel({
  children,
  style,
  raised = false,
}: {
  children: ReactNode;
  style?: CSSProperties;
  raised?: boolean;
}) {
  return (
    <div
      style={{
        border: `1px solid ${product.lineFilm}`,
        borderRadius: product.radius,
        background: raised ? product.surfaceRaised : product.surfaceFilm,
        fontFamily: font.ui,
        color: product.text,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A pill — the `.kprof__chip` treatment. `tone` picks the border/ink. */
export function Chip({
  children,
  tone = 'neutral',
  active = false,
  size = 14,
  style,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warn' | 'danger';
  active?: boolean;
  size?: number;
  style?: CSSProperties;
}) {
  const ink =
    tone === 'accent'
      ? product.accent
      : tone === 'success'
        ? product.success
        : tone === 'warn'
          ? product.warn
          : tone === 'danger'
            ? product.danger
            : product.text;
  const border =
    tone === 'neutral' ? product.lineSoft : `${ink}${active ? 'aa' : '66'}`;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: `${size * 0.32}px ${size * 0.7}px`,
        border: `1px solid ${border}`,
        borderRadius: 999,
        background: active && tone !== 'neutral' ? `${ink}1f` : 'transparent',
        fontFamily: font.ui,
        fontSize: size,
        lineHeight: 1.2,
        color: tone === 'neutral' ? (active ? product.text : product.muted) : ink,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** A small live dot. `state` chooses between working, done and stopped. */
export function Dot({
  state = 'working',
  size = 7,
}: {
  state?: 'working' | 'done' | 'stopped' | 'idle';
  size?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const color =
    state === 'done'
      ? product.success
      : state === 'stopped'
        ? product.warn
        : state === 'idle'
          ? product.muted
          : product.accent;
  const o = state === 'working' ? pulse(frame, fps) : 1;
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: state === 'working' ? `0 0 ${size * 1.4}px ${color}` : 'none',
        opacity: o,
        flex: 'none',
      }}
    />
  );
}

/** Monospace status line, the import-console voice: `◌ scoring` / `✓ scored`. */
export function Status({
  text,
  state,
  size = 13,
  style,
}: {
  text: string;
  state: 'working' | 'done' | 'stopped';
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: font.mono,
        fontSize: size,
        letterSpacing: '0.06em',
        color: state === 'done' ? product.success : state === 'stopped' ? product.warn : product.muted,
        ...style,
      }}
    >
      <Dot state={state} size={size * 0.5} />
      {text}
    </span>
  );
}

/** A hairline that draws from the centre outward. */
export function Rule({
  start,
  width = 320,
  dur = 40,
  color = brand.accent,
  opacity = 0.55,
}: {
  start: number;
  width?: number;
  dur?: number;
  color?: string;
  opacity?: number;
}) {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, dur);
  return (
    <div
      style={{
        width: width * p,
        height: 1,
        background: color,
        opacity,
        margin: '0 auto',
      }}
    />
  );
}

/** Ambient violet cast, matching `.kauth::before`. Purely decorative. */
export function Ambient({ strength = 1 }: { strength?: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(ellipse 70% 50% at 50% 0%, rgba(216, 180, 254, ${0.1 * strength}), transparent 70%)`,
        pointerEvents: 'none',
      }}
    />
  );
}
