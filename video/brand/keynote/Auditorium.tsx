import { useCurrentFrame, useVideoConfig } from 'remotion';

import { brand, font } from '../../tokens';
import { pulse, ramp } from '../../ui/motion';
import { KEY_TEXT, SLIDE_CHANGE } from '../timeline';
import { Figure, Glow, seeded } from '../set';
import { FounderPlate } from './FounderPlate';
import type { FounderPlateKey } from '../assets';

/**
 * The keynote set, in world units (1920×1080). A camera looks at it.
 *
 * Layers back to front: wall · screen and its spill · side light · stage and
 * its reflection of the screen · spotlight · founder · lectern · haze ·
 * audience. Each layer takes its own blur so a shot can hold focus on the
 * presenter and let the screen or the audience go soft.
 */

export const WORLD = { w: 1920, h: 1080 } as const;
/** The presenter stands BESIDE the screen, stage-left, never in front of it. */
export const SCREEN = { x: 560, y: 110, w: 1200, h: 450 } as const;
export const FOUNDER = { x: 210, y: 300, w: 320, h: 420 } as const;
export const LECTERN = { x: 280, y: 620, w: 180, h: 150 } as const;
const PRESENTER_X = FOUNDER.x + FOUNDER.w / 2;

export function Auditorium({
  local,
  shot,
  screenBlur = 0,
  audienceBlur = 0,
  audienceOpacity = 1,
  founderOpacity = 1,
}: {
  local: number;
  shot: FounderPlateKey;
  screenBlur?: number;
  audienceBlur?: number;
  audienceOpacity?: number;
  founderOpacity?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slide2 = ramp(local, SLIDE_CHANGE, 24);
  // A screen is never perfectly steady; the spill breathes with it.
  const flicker = 0.92 + 0.08 * pulse(frame, fps, 0.6, 0, 1);

  const rnd = seeded(101);
  // Three depths. The nearest row is the softest and darkest: at the back of
  // a hall the people in front of you are shapes, not silhouettes.
  const rows = [
    { y: 1015, h: 215, gap: 168, blur: 2.6, fill: '#010102', op: 1 },
    { y: 935, h: 160, gap: 128, blur: 1.6, fill: '#030307', op: 0.95 },
    { y: 872, h: 118, gap: 96, blur: 0.9, fill: '#06060c', op: 0.85 },
  ];

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: WORLD.w, height: WORLD.h, overflow: 'hidden' }}>
      {/* wall */}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, #07070c 0%, #040409 60%, #020204 100%)' }} />

      {/* screen */}
      <div style={{ position: 'absolute', inset: 0, filter: screenBlur ? `blur(${screenBlur}px)` : undefined }}>
        <Glow x={SCREEN.x + SCREEN.w / 2} y={SCREEN.y + SCREEN.h / 2} rx={900} ry={480} color={brand.accent} opacity={0.10 * flicker} blur={80} />
        <div
          style={{
            position: 'absolute',
            left: SCREEN.x,
            top: SCREEN.y,
            width: SCREEN.w,
            height: SCREEN.h,
            border: '3px solid #23232c',
            background: '#05060a',
            boxShadow: '0 0 90px 10px rgba(216,180,254,0.10), 0 40px 120px rgba(0,0,0,0.6)',
            overflow: 'hidden',
          }}
        >
          <Slide1 opacity={1 - slide2} />
          <Slide2 opacity={slide2} />
        </div>
        {/* spill onto the stage floor */}
        <div
          style={{
            position: 'absolute',
            left: SCREEN.x - 80,
            top: SCREEN.y + SCREEN.h,
            width: SCREEN.w + 160,
            height: 360,
            background: `linear-gradient(180deg, rgba(216,180,254,${0.16 * flicker}), transparent 70%)`,
            filter: 'blur(24px)',
          }}
        />
      </div>

      {/* side light */}
      {[130, 1790].map((x) => (
        <div key={x}>
          <div
            style={{
              position: 'absolute',
              left: x - 3,
              top: 40,
              width: 6,
              height: 620,
              background: 'linear-gradient(180deg, rgba(255,255,255,0.7), rgba(255,255,255,0.15) 70%, transparent)',
              filter: 'blur(1.5px)',
              opacity: 0.55,
            }}
          />
          <Glow x={x} y={300} rx={140} ry={420} color="#ffffff" opacity={0.06} blur={40} />
        </div>
      ))}

      {/* stage */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 640, height: 440, background: 'linear-gradient(180deg, #101018 0%, #08080e 30%, #020204 100%)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 640, height: 1, background: 'rgba(255,255,255,0.12)' }} />
      {/* the screen's reflection in the floor */}
      <div
        style={{
          position: 'absolute',
          left: SCREEN.x,
          top: 660,
          width: SCREEN.w,
          height: 260,
          background: `linear-gradient(180deg, rgba(216,180,254,${0.10 * flicker}) 0%, rgba(216,180,254,0.03) 50%, transparent 100%)`,
          filter: 'blur(14px)',
          transform: 'scaleY(-1)',
          transformOrigin: 'top',
        }}
      />

      <Glow x={PRESENTER_X} y={740} rx={220} ry={40} color="#ffffff" opacity={0.10} blur={20} />

      {/* the founder */}
      <div style={{ opacity: founderOpacity }}>
        <FounderPlate shot={shot} width={FOUNDER.w} height={FOUNDER.h} local={local} style={{ left: FOUNDER.x, top: FOUNDER.y }} />
      </div>

      {/* spotlight on the presenter — drawn OVER the plate, screen-blended, so
          the beam lights the plate's black backdrop exactly as it lights the
          stage. Under the plate, the backdrop read as a dark halo inside the
          beam. The generated plates are black-backed too; this covers them. */}
      <div
        style={{
          position: 'absolute',
          left: PRESENTER_X - 260,
          top: -160,
          width: 520,
          height: 900,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.11), rgba(255,255,255,0.035) 60%, transparent)',
          clipPath: 'polygon(46% 0, 54% 0, 100% 100%, 0 100%)',
          filter: 'blur(22px)',
          opacity: 0.9,
          mixBlendMode: 'screen',
          pointerEvents: 'none',
        }}
      />

      {/* lectern */}
      <div
        style={{
          position: 'absolute',
          left: LECTERN.x,
          top: LECTERN.y,
          width: LECTERN.w,
          height: LECTERN.h,
          background: 'linear-gradient(180deg, #14141c, #08080d)',
          borderTop: '1px solid rgba(255,255,255,0.22)',
          borderRadius: '3px 3px 0 0',
          boxShadow: '0 30px 60px rgba(0,0,0,0.7)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 62,
            textAlign: 'center',
            fontFamily: font.head,
            fontWeight: 700,
            fontSize: 9,
            letterSpacing: '0.34em',
            color: 'rgba(216,180,254,0.55)',
          }}
        >
          KIASA
        </div>
      </div>

      {/* haze */}
      <Glow x={960} y={620} rx={1100} ry={300} color="#9aa4ff" opacity={0.045} blur={90} />

      {/* audience */}
      <div style={{ position: 'absolute', inset: 0, opacity: audienceOpacity, filter: audienceBlur ? `blur(${audienceBlur}px)` : undefined }}>
        {rows.map((row, r) => {
          const n = Math.ceil(2200 / row.gap);
          return Array.from({ length: n }, (_, i) => {
            // No two alike: position, height, lean and how much screen light
            // catches each one all vary, and a few seats are empty.
            if (rnd() < 0.12) return null;
            const x = -140 + i * row.gap + (rnd() - 0.5) * 70 + (r % 2) * (row.gap / 2);
            const h = row.h * (0.74 + rnd() * 0.5);
            const rim = rnd() < 0.55 ? `rgba(216,180,254,${0.08 + rnd() * 0.2})` : undefined;
            return (
              <Figure
                key={`${r}-${i}`}
                kind="audience"
                x={x}
                y={row.y + (rnd() - 0.5) * 22}
                height={h}
                fill={row.fill}
                rim={rim}
                rimSide={rnd() < 0.5 ? 'right' : 'left'}
                soft={row.blur * (0.8 + rnd() * 0.5)}
                opacity={row.op * (0.85 + rnd() * 0.15)}
                flip={rnd() < 0.3}
              />
            );
          });
        })}
        {/* the room's darkness in the foreground */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 260, background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.85))' }} />
      </div>
    </div>
  );
}

function Slide1({ opacity }: { opacity: number }) {
  const { title, sub } = KEY_TEXT.keynote.slide1;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 34, opacity }}>
      <div style={{ fontFamily: font.head, fontWeight: 700, fontSize: 118, letterSpacing: '0.22em', marginRight: '-0.22em', color: '#fff', lineHeight: 1 }}>
        {title}
      </div>
      <div style={{ width: 260, height: 1, background: brand.accent, opacity: 0.6 }} />
      <div style={{ fontFamily: font.body, fontWeight: 500, fontSize: 36, color: brand.muted }}>{sub}</div>
    </div>
  );
}

function Slide2({ opacity }: { opacity: number }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.8em', opacity }}>
      {KEY_TEXT.keynote.slide2.parts.map((p, i) => (
        <span
          key={i}
          style={{
            fontFamily: font.head,
            fontWeight: 700,
            fontSize: p === '+' ? 46 : 54,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: p === '+' ? brand.accent : '#fff',
            lineHeight: 1,
          }}
        >
          {p}
        </span>
      ))}
    </div>
  );
}
