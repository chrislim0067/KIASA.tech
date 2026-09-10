import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { ramp, settle } from '../ui/motion';
import { Vignette } from '../brand/set';

/**
 * A cinematic plate: a video clip filling the frame, with the handful of
 * things a shot needs and nothing more — a fade in and out, a slow push or
 * drift, an optional grade, and whatever is composited over it.
 *
 * The plates are 1280×720 at 24fps; the composition is 1920×1080 at 60fps.
 * Remotion scales and resamples. The 1.5× upscale is the cost of using real
 * plates at all, and a slow push on top of it is what keeps a still-camera
 * clip from feeling like a still.
 */
export function Plate({
  src,
  fadeIn = 0,
  fadeOut = 0,
  duration,
  push = 0.05,
  pan = [0, 0],
  dim = 0,
  blur = 0,
  vignette = 0.6,
  startFrom = 0,
  children,
  style,
}: {
  src: string;
  /** Frames. */
  fadeIn?: number;
  fadeOut?: number;
  /** Frames the plate is on screen; needed for the fade-out. */
  duration: number;
  /** Fractional scale gained over the shot. */
  push?: number;
  /** Fractional drift over the shot, in frame widths / heights. */
  pan?: readonly [number, number];
  /** 0–1: darken. */
  dim?: number;
  blur?: number;
  vignette?: number;
  /** Frames into the source to begin. */
  startFrom?: number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = ramp(frame, 0, fadeIn || 1) * (fadeOut ? 1 - ramp(frame, duration - fadeOut, fadeOut) : 1);
  const t = settle(frame, fps, 0, duration);
  // A base scale about a point low and left of centre: the plates carry an
  // inpainted patch in their top-right corner (see the watermark note in
  // launch/timeline.ts), and this carries most of that corner out of frame.
  const scale = 1.07 * (1 + push * t);
  const tx = pan[0] * 1920 * t;
  const ty = pan[1] * 1080 * t;

  return (
    <AbsoluteFill style={{ background: '#000', opacity: a, ...style }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: '32% 68%',
          filter: `${blur ? `blur(${blur}px) ` : ''}brightness(${1 - dim})`,
        }}
      >
        <OffthreadVideo src={staticFile(src)} startFrom={startFrom} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
      {children}
      <Vignette strength={vignette} />
    </AbsoluteFill>
  );
}
