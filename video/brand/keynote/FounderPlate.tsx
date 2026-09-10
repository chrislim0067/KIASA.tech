import type { CSSProperties } from 'react';
import { Img, OffthreadVideo, getRemotionEnvironment, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { font } from '../../tokens';
import { FOUNDER_PLATES, FOUNDER_REFERENCE, type FounderPlateKey } from '../assets';

/**
 * The founder in the keynote — a slot, not a picture.
 *
 * When a generated plate exists for the shot ({@link FOUNDER_PLATES}), it
 * plays here. Until then the slot shows the founder's real photo, treated for
 * the stage, as a PLACEHOLDER — and in Studio it says so, in the corner, so
 * nobody mistakes it for the finished shot.
 *
 * This environment cannot generate the plates. A photo panned and zoomed is
 * not footage of a person presenting, and this component does not pretend it
 * is: it exists so the environment, the camera and the cut can be judged
 * today, and the plates dropped in without touching the scene.
 */
export function FounderPlate({
  shot,
  width,
  height,
  /** Local frame of the keynote; plates are trimmed from their start. */
  local,
  style,
}: {
  shot: FounderPlateKey;
  width: number;
  height: number;
  local: number;
  style?: CSSProperties;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const plate = FOUNDER_PLATES[shot];
  const isStudio = getRemotionEnvironment().isStudio;

  if (plate.video) {
    return (
      <div style={{ position: 'absolute', width, height, overflow: 'hidden', ...style }}>
        <OffthreadVideo
          src={staticFile(plate.video)}
          startFrom={Math.max(0, -local)}
          style={{ width, height, objectFit: 'cover' }}
          muted
        />
      </div>
    );
  }

  // The placeholder. Black-on-black: the photo's charcoal studio backdrop is
  // crushed toward the stage black and feathered, so the figure sits in the
  // light without a cut-out. A slow breath keeps it from being a still.
  const breath = 1 + 0.004 * Math.sin((frame / fps) * 2 * Math.PI * 0.22);

  return (
    <div style={{ position: 'absolute', width, height, overflow: 'hidden', ...style }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${breath})`,
          transformOrigin: '50% 80%',
          // The radii are percentages of the slot, so they must stay inside
          // it: an ellipse wider than the slot never reaches the sides, and the
          // photo's edge shows as a box. 46% × 58% feathers every edge.
          maskImage:
            'radial-gradient(ellipse 46% 58% at 50% 42%, #000 38%, rgba(0,0,0,0.6) 62%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 46% 58% at 50% 42%, #000 38%, rgba(0,0,0,0.6) 62%, transparent 100%)',
        }}
      >
        <Img
          src={staticFile(FOUNDER_REFERENCE)}
          style={{
            width,
            height,
            objectFit: 'cover',
            objectPosition: '50% 8%',
            // A levels crush: the studio backdrop (~#1a1a1a) goes to black,
            // the face keeps its midtones. brightness first, then contrast.
            filter: 'brightness(0.86) contrast(1.32) saturate(0.86)',
          }}
        />
        {/* screen spill from the right, the rim from the left */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(270deg, rgba(216,180,254,0.34), transparent 55%)',
            mixBlendMode: 'screen',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(90deg, rgba(180,196,255,0.22), transparent 30%)',
            mixBlendMode: 'screen',
          }}
        />
      </div>

      {isStudio ? (
        <div
          style={{
            position: 'absolute',
            left: 8,
            bottom: 8,
            padding: '4px 8px',
            border: '1px solid #f0c977',
            borderRadius: 3,
            fontFamily: font.mono,
            fontSize: 11,
            letterSpacing: '0.06em',
            color: '#f0c977',
            background: 'rgba(0,0,0,0.6)',
          }}
        >
          PLACEHOLDER · {plate.expected}
        </div>
      ) : null}
    </div>
  );
}
