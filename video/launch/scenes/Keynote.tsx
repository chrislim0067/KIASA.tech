import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand } from '../../tokens';
import { ramp, settle } from '../../ui/motion';
import { Figure, Glow, Vignette, seeded } from '../../brand/set';
import { KEYNOTE_SHOTS, PLATES } from '../timeline';

/**
 * 0:45–0:58. The founder, on stage, in three real shots — wide, medium,
 * close. The plates are portrait (880×1072); rather than pillarbox them,
 * each is placed at the centre of a designed wide stage: its own image
 * blurred and darkened fills the width, side light and haze extend the room,
 * and in the wide shot a foreground of audience silhouettes gives the frame
 * depth. The clip's own screen, audience and lighting stay as they are.
 */
export function Keynote() {
  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <Sequence from={KEYNOTE_SHOTS.wide.from} durationInFrames={KEYNOTE_SHOTS.wide.dur} name="wide">
        <Shot src={PLATES.founderWide} duration={KEYNOTE_SHOTS.wide.dur} fadeIn={24} audience push={0.08} width={860} />
      </Sequence>
      <Sequence from={KEYNOTE_SHOTS.medium.from} durationInFrames={KEYNOTE_SHOTS.medium.dur} name="medium">
        <Shot src={PLATES.founderMedium} duration={KEYNOTE_SHOTS.medium.dur} push={0.05} width={900} shade={0.8} />
      </Sequence>
      <Sequence from={KEYNOTE_SHOTS.close.from} durationInFrames={KEYNOTE_SHOTS.close.dur} name="close">
        <Shot src={PLATES.founderClose} duration={KEYNOTE_SHOTS.close.dur} fadeOut={30} push={0.04} width={960} shade={0.85} />
      </Sequence>
    </AbsoluteFill>
  );
}

function Shot({
  src,
  duration,
  fadeIn = 0,
  fadeOut = 0,
  push,
  width,
  audience = false,
  shade = 0,
}: {
  src: string;
  duration: number;
  fadeIn?: number;
  fadeOut?: number;
  push: number;
  /** Display width of the plate at 1080 tall. */
  width: number;
  audience?: boolean;
  /**
   * 0–1: darken the top of the frame. In the closer shots the screen behind
   * the presenter carries generated lettering that does not survive
   * inspection; a camera this close would have it dim and soft anyway.
   */
  shade?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = (fadeIn ? ramp(frame, 0, fadeIn) : 1) * (fadeOut ? 1 - ramp(frame, duration - fadeOut, fadeOut) : 1);
  const t = settle(frame, fps, 0, duration);
  const scale = 1 + push * t;
  const video = staticFile(src);

  const rnd = seeded(77);
  const rows = [
    { y: 1060, h: 250, gap: 190, blur: 3.0, fill: '#010102', op: 1 },
    { y: 985, h: 180, gap: 140, blur: 2.0, fill: '#030307', op: 0.95 },
  ];

  return (
    <AbsoluteFill style={{ background: '#000', opacity: a }}>
      <div style={{ position: 'absolute', inset: 0, transform: `scale(${scale})`, transformOrigin: '50% 45%' }}>
        {/* the room: the plate itself, blown out and darkened, fills the width */}
        <div style={{ position: 'absolute', inset: -60, filter: 'blur(38px) brightness(0.32) saturate(0.85)' }}>
          <OffthreadVideo src={video} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
        {/* side light and haze, as on the built stage */}
        {[150, 1770].map((x) => (
          <div key={x}>
            <div
              style={{
                position: 'absolute',
                left: x - 3,
                top: 40,
                width: 6,
                height: 640,
                background: 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.12) 70%, transparent)',
                filter: 'blur(1.5px)',
                opacity: 0.5,
              }}
            />
            <Glow x={x} y={320} rx={160} ry={440} color="#ffffff" opacity={0.05} blur={40} />
          </div>
        ))}
        <Glow x={960} y={560} rx={1000} ry={320} color="#9aa4ff" opacity={0.05} blur={90} />

        {/* the plate, centred, its edges feathered into the room */}
        <div
          style={{
            position: 'absolute',
            left: (1920 - width) / 2,
            top: 0,
            width,
            height: 1080,
            maskImage: 'linear-gradient(90deg, transparent 0, #000 7%, #000 93%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(90deg, transparent 0, #000 7%, #000 93%, transparent 100%)',
          }}
        >
          <OffthreadVideo src={video} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
        {shade ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: `linear-gradient(180deg, rgba(0,0,0,${shade}) 0%, rgba(0,0,0,${shade * 0.7}) 22%, transparent 42%)`,
            }}
          />
        ) : null}

        {/* foreground audience, wide shot only */}
        {audience ? (
          <div style={{ position: 'absolute', inset: 0 }}>
            {rows.map((row, r) =>
              Array.from({ length: Math.ceil(2200 / row.gap) }, (_, i) => {
                if (rnd() < 0.15) return null;
                const x = -140 + i * row.gap + (rnd() - 0.5) * 70 + (r % 2) * (row.gap / 2);
                return (
                  <Figure
                    key={`${r}-${i}`}
                    kind="audience"
                    x={x}
                    y={row.y + (rnd() - 0.5) * 24}
                    height={row.h * (0.75 + rnd() * 0.5)}
                    fill={row.fill}
                    rim={rnd() < 0.5 ? `rgba(216,180,254,${0.06 + rnd() * 0.16})` : undefined}
                    rimSide={rnd() < 0.5 ? 'right' : 'left'}
                    soft={row.blur * (0.8 + rnd() * 0.5)}
                    opacity={row.op * (0.85 + rnd() * 0.15)}
                    flip={rnd() < 0.3}
                  />
                );
              })
            )}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 300, background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.9))' }} />
          </div>
        ) : null}
      </div>
      <Vignette strength={0.65} />
    </AbsoluteFill>
  );
}
