import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { brand } from '../../tokens';
import { ramp, settle } from '../../ui/motion';
import { KEYNOTE_SHOTS, OVERLAP } from '../timeline';
import { Vignette } from '../set';
import { Auditorium, FOUNDER, SCREEN } from '../keynote/Auditorium';
import type { FounderPlateKey } from '../assets';

/**
 * 0:32–0:44. Four shots on one set, cut hard, each with its own slow move:
 *
 *   A  wide      the room, the audience, the screen, the presenter small
 *   B  medium    the presenter, the screen soft behind
 *   C  vision    closer — the personal lines land here
 *   D  screen    the slide fills the frame, then the room comes back
 *
 * The camera is a transform over the world; the set never moves.
 */

interface Cam { s: number; cx: number; cy: number }

const lerp = (a: Cam, b: Cam, t: number): Cam => ({
  s: a.s + (b.s - a.s) * t,
  cx: a.cx + (b.cx - a.cx) * t,
  cy: a.cy + (b.cy - a.cy) * t,
});

const founderCentre = { x: FOUNDER.x + FOUNDER.w / 2, y: FOUNDER.y + FOUNDER.h * 0.42 };
const screenCentre = { x: SCREEN.x + SCREEN.w / 2, y: SCREEN.y + SCREEN.h / 2 };

export function B5Keynote() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP);

  const shots = KEYNOTE_SHOTS;
  let key: FounderPlateKey = 'wide';
  let cam: Cam;
  let screenBlur = 0;
  let audienceBlur = 0;
  let audienceOpacity = 1;
  let founderOpacity = 1;

  if (frame < shots.medium.from) {
    // A — dolly toward the stage.
    key = 'wide';
    const t = settle(frame, fps, shots.wide.from, shots.wide.dur + 30);
    cam = lerp({ s: 1.0, cx: 960, cy: 560 }, { s: 1.12, cx: 900, cy: 520 }, t);
    audienceBlur = 1.5;
  } else if (frame < shots.vision.from) {
    // B — a slow push on the presenter; the screen goes soft.
    key = 'medium';
    const t = settle(frame, fps, shots.medium.from, shots.medium.dur + 30);
    cam = lerp({ s: 1.5, cx: founderCentre.x + 140, cy: founderCentre.y + 40 }, { s: 1.64, cx: founderCentre.x + 120, cy: founderCentre.y + 30 }, t);
    screenBlur = 3;
    audienceOpacity = 0.35;
  } else if (frame < shots.screen.from) {
    // C — closer, and a breath of camera rather than a move.
    key = 'vision';
    const breathe = Math.sin(((frame - shots.vision.from) / fps) * 2 * Math.PI * 0.18) * 4;
    cam = { s: 2.35, cx: founderCentre.x + 70 + breathe * 0.3, cy: founderCentre.y - 10 + breathe };
    screenBlur = 7;
    audienceOpacity = 0;
  } else {
    // D — the slide, then pull back into the room.
    key = 'wide';
    const t = settle(frame, fps, shots.screen.from + 60, shots.screen.dur - 40);
    cam = lerp({ s: 1.52, cx: screenCentre.x, cy: screenCentre.y }, { s: 0.98, cx: 960, cy: 600 }, t);
    audienceBlur = 2 * t;
    founderOpacity = 1;
  }

  const tx = 960 - cam.cx * cam.s;
  const ty = 540 - cam.cy * cam.s;

  return (
    <AbsoluteFill style={{ background: brand.bg, opacity: enter }}>
      <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${tx}px, ${ty}px) scale(${cam.s})`, transformOrigin: '0 0' }}>
        <Auditorium
          local={frame}
          shot={key}
          screenBlur={screenBlur}
          audienceBlur={audienceBlur}
          audienceOpacity={audienceOpacity}
          founderOpacity={founderOpacity}
        />
      </div>
      <Vignette strength={0.7} />
    </AbsoluteFill>
  );
}
