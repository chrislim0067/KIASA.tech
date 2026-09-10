import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand } from '../../tokens';
import { pulse, ramp, settle } from '../../ui/motion';
import { KEY_TEXT, SCENES } from '../timeline';
import { Figure, Glow, KeyLine, TextStream, Vignette, seeded } from '../set';

/**
 * 0:00–0:07. Black. One violet point. It is a screen, far away; we move
 * toward it and find a person working late with information passing through
 * the room. Then the information starts to multiply around them.
 *
 * One continuous shot. KIASA does not appear.
 */
export function B1World() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // The point of light becomes the laptop screen: same position, the room
  // simply fades up around it while we push in.
  const point = pulse(frame, fps, 0.35, 0.5, 1) * ramp(frame, 10, 50);
  const room = ramp(frame, 90, 80);
  const push = 1 + 0.06 * settle(frame, fps, 90, 330);

  // Notifications from the screen outward, accelerating, from 4.5s.
  const rnd = seeded(7);
  const cards = Array.from({ length: 22 }, (_, i) => {
    const angle = rnd() * Math.PI * 2;
    const dist = 260 + rnd() * 520;
    const born = 270 + Math.round(i * i * 0.55);
    return { angle, dist, born, w: 220 + rnd() * 120, rot: (rnd() - 0.5) * 10 };
  });

  return (
    <AbsoluteFill style={{ background: brand.bg }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${push})`,
          transformOrigin: '56% 46%',
        }}
      >
        {/* the room — a cool wall behind, a desk plane below */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: room,
            background:
              'linear-gradient(180deg, #06070c 0%, #04050a 55%, #020204 100%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 660,
            height: 2,
            opacity: room * 0.5,
            background: 'linear-gradient(90deg, transparent, rgba(160,170,220,0.35) 35%, rgba(160,170,220,0.5) 60%, transparent)',
          }}
        />

        {/* the screen: the point of light, then a laptop */}
        <Glow x={1080} y={470} rx={22} ry={14} color="#d8b4fe" opacity={point * (1 - room)} blur={4} />
        <div
          style={{
            position: 'absolute',
            left: 930,
            top: 380,
            width: 300,
            height: 190,
            opacity: room,
            transform: 'perspective(900px) rotateY(-14deg)',
            background: 'linear-gradient(160deg, #e9ecff 0%, #b9c2ff 45%, #8f9ae6 100%)',
            borderRadius: 4,
            boxShadow: '0 0 60px 8px rgba(190,200,255,0.35)',
          }}
        />
        <Glow x={1000} y={520} rx={520} ry={330} color="#b9c2ff" opacity={0.16 * room} blur={40} />
        <Glow x={1000} y={520} rx={260} ry={180} color="#d8b4fe" opacity={0.12 * room} blur={30} />

        {/* the person — side-on, lit from the screen on their right */}
        <div style={{ opacity: room }}>
          <Figure kind="seated" x={770} y={690} height={420} rim="#8f9ae6" rimSide="right" soft={1.6} />
        </div>

        {/* information passing through the room */}
        <div style={{ opacity: room }}>
          <TextStream y={150} depth={0.15} offset={2} speed={0.9} opacity={0.5} />
          <TextStream y={240} depth={0.55} offset={5} speed={1.2} opacity={0.7} />
          <TextStream y={330} depth={0.3} offset={8} speed={1.0} opacity={0.45} />
          <TextStream y={760} depth={0.85} offset={11} speed={1.5} opacity={0.75} />
          <TextStream y={860} depth={0.45} offset={1} speed={1.1} opacity={0.5} />
          <TextStream y={950} depth={0.95} offset={6} speed={1.8} opacity={0.6} />
        </div>

        {/* the multiplication */}
        {cards.map((c, i) => {
          const p = settle(frame, fps, c.born, 70);
          if (p <= 0) return null;
          const x = 1080 + Math.cos(c.angle) * c.dist * p;
          const y = 470 + Math.sin(c.angle) * c.dist * 0.62 * p;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: x - c.w / 2,
                top: y - 30,
                width: c.w,
                height: 60,
                borderRadius: 6,
                border: '1px solid rgba(200,206,240,0.28)',
                background: 'rgba(200,206,240,0.06)',
                opacity: Math.min(1, p * 1.8) * 0.9,
                transform: `rotate(${c.rot}deg) scale(${0.6 + 0.4 * p})`,
                filter: `blur(${(1 - p) * 4}px)`,
              }}
            >
              <div style={{ position: 'absolute', left: 14, top: 16, width: '55%', height: 3, background: 'rgba(230,234,255,0.6)', borderRadius: 2 }} />
              <div style={{ position: 'absolute', left: 14, top: 32, width: '75%', height: 3, background: 'rgba(230,234,255,0.28)', borderRadius: 2 }} />
            </div>
          );
        })}
      </div>

      <Vignette strength={0.75} />
      <KeyLine text={KEY_TEXT.world.line} start={KEY_TEXT.world.at} end={Math.min(KEY_TEXT.world.until, SCENES.world.dur)} />
    </AbsoluteFill>
  );
}
