import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { ATS_LABEL, FOCUS_JOB, PROFILE, REQUIREMENTS, SCORE } from '../data/sample';
import { COPY, OVERLAP } from '../timeline';
import { font, product } from '../tokens';
import { SceneLayout } from '../ui/layout';
import { count, fadeUp, ramp, settle } from '../ui/motion';
import { Chip, Headline, Panel, Status } from '../ui/primitives';

const PANEL_W = 440;
const PANEL_H = 330;
const GAP_NEAR = 150;
const GAP_FAR = 620;
const UI_W = PANEL_W * 2 + GAP_FAR;
const UI_H = PANEL_H + 60;

/**
 * 0:07–0:11. Profile on the left, the job's requirements on the right. Each
 * requirement is checked against the profile in turn — a matched pair lights
 * and a hairline joins them. Then the panels part, dim, and the score rises
 * between them: the big outlined numeral the old film spent on a year.
 */
export function S3Match() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP);

  // Phase A: panels close, evaluating. Phase B: panels part, score.
  const part = settle(frame, fps, 120, 54);
  const gap = GAP_NEAR + (GAP_FAR - GAP_NEAR) * part;
  const dim = 1 - 0.6 * part;
  const leftX = (UI_W - (PANEL_W * 2 + gap)) / 2;
  const rightX = leftX + PANEL_W + gap;
  const slideIn = settle(frame, fps, 4, 44);

  const evalStart = 34;
  const evalStep = 14;
  const evaluated = (i: number) => frame >= evalStart + i * evalStep;
  const allDone = frame >= evalStart + REQUIREMENTS.length * evalStep;

  // Rows: chips are laid out in a grid; a matched pair is joined by a line
  // from the profile chip's row to the requirement's row.
  const chipRowH = 38;
  const chipsTop = 118;

  const score = count(frame, 132, 60, SCORE.score);
  const scoreIn = settle(frame, fps, 128, 50);
  const verdict = fadeUp(frame, 176, 30, 16);

  const ui = (
    <div style={{ position: 'relative', width: UI_W, height: UI_H }}>
      {/* Profile */}
      <div
        style={{
          position: 'absolute',
          left: leftX,
          top: 20,
          opacity: dim * slideIn,
          transform: `translateX(${(1 - slideIn) * -60}px)`,
        }}
      >
        <Panel style={{ width: PANEL_W, height: PANEL_H, padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: '50%',
                border: `1px solid ${product.line}`,
                background: product.accentDim,
                display: 'grid',
                placeItems: 'center',
                fontFamily: font.head,
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: '0.1em',
                color: product.accent,
              }}
            >
              {PROFILE.initials}
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 600 }}>{PROFILE.name}</div>
              <div style={{ fontSize: 13.5, color: product.muted }}>
                {PROFILE.title} · {PROFILE.location}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 24, fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: product.muted }}>
            Skills
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {PROFILE.skills.map((skill) => {
              const req = REQUIREMENTS.findIndex((r) => r.matches === skill);
              const lit = req >= 0 && evaluated(req);
              return (
                <Chip key={skill} tone={lit ? 'accent' : 'neutral'} active={lit} size={13.5}>
                  {skill}
                </Chip>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* Requirements */}
      <div
        style={{
          position: 'absolute',
          left: rightX,
          top: 20,
          opacity: dim * slideIn,
          transform: `translateX(${(1 - slideIn) * 60}px)`,
        }}
      >
        <Panel style={{ width: PANEL_W, height: PANEL_H, padding: 22 }}>
          <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.25 }}>{FOCUS_JOB.title}</div>
          <div style={{ marginTop: 3, fontSize: 13.5, color: product.muted }}>
            {FOCUS_JOB.company} · {FOCUS_JOB.location} · {ATS_LABEL[FOCUS_JOB.ats]}
          </div>
          <div style={{ marginTop: 24, fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: product.muted }}>
            Requirements
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            {REQUIREMENTS.map((r, i) => {
              const done = evaluated(i);
              const hit = done && r.matches !== null;
              return (
                <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, height: chipRowH - 8 }}>
                  <Chip tone={hit ? 'accent' : 'neutral'} active={hit} size={13.5}>
                    {r.label}
                  </Chip>
                  <span style={{ fontFamily: font.mono, fontSize: 11.5, color: hit ? product.success : product.muted, opacity: done ? 1 : 0.35 }}>
                    {!done ? '·' : hit ? '✓ in profile' : '— not stated'}
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* Join lines, phase A only */}
      <svg
        style={{ position: 'absolute', inset: 0, opacity: (1 - part) * slideIn }}
        width={UI_W}
        height={UI_H}
      >
        {REQUIREMENTS.map((r, i) => {
          if (r.matches === null || !evaluated(i)) return null;
          const draw = ramp(frame, evalStart + i * evalStep, 16);
          const x1 = leftX + PANEL_W;
          const x2 = rightX;
          const y2 = 20 + 22 + 17 + 3 + 24 + 12 + 10 + chipsTop - 118 + 4 + i * chipRowH + 15;
          const y1 = y2 - 16 + i * 2;
          return (
            <line
              key={r.label}
              x1={x1}
              y1={y1}
              x2={x1 + (x2 - x1) * draw}
              y2={y1 + (y2 - y1) * draw}
              stroke={product.accent}
              strokeWidth={1}
              opacity={0.6}
            />
          );
        })}
      </svg>

      {/* The mid status */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          display: 'flex',
          justifyContent: 'center',
          opacity: ramp(frame, 18, 20) * (1 - part),
        }}
      >
        <Status text={allDone ? COPY.match.scored(SCORE.confidence) : COPY.match.scoring} state={allDone ? 'done' : 'working'} />
      </div>

      {/* The score, phase B */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 8,
          textAlign: 'center',
          opacity: scoreIn,
          transform: `translateY(${(1 - scoreIn) * 30}px)`,
        }}
      >
        <BigNumber value={score} />
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'center', gap: 10, ...verdict }}>
          <Chip tone="success" active size={14}>
            ✓ {COPY.match.verdict}
          </Chip>
          <Chip tone="accent" active size={14}>
            {COPY.match.verdictNote}
          </Chip>
        </div>
        <div
          style={{
            margin: '16px auto 0',
            maxWidth: 560,
            fontFamily: font.ui,
            fontSize: 15.5,
            lineHeight: 1.45,
            color: product.muted,
            ...fadeUp(frame, 192, 30, 12),
          }}
        >
          {COPY.match.explanation}
        </div>
      </div>
    </div>
  );

  const caption = <Headline lines={COPY.match.main} start={150} size={44} align="center" />;

  return (
    <AbsoluteFill style={{ background: product.bg }}>
      <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 ${(1 - enter) * 100}% 0 0)` }}>
        <SceneLayout ui={ui} caption={caption} uiSize={{ w: UI_W, h: UI_H }} captionPos="bottom" />
      </div>
    </AbsoluteFill>
  );
}

/** The outlined numeral with a whisper of the old film's chromatic fringe. */
function BigNumber({ value }: { value: number }) {
  const common = {
    fontFamily: font.head,
    fontWeight: 700,
    fontSize: 210,
    lineHeight: 1,
    letterSpacing: '0.02em',
    color: 'transparent',
    WebkitTextStroke: `2.5px ${product.text}`,
  } as const;
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <div style={{ ...common, position: 'absolute', left: -4, top: 0, WebkitTextStroke: '2.5px #ff4d6a', opacity: 0.28 }}>
        {value}
        <span style={{ fontSize: 80, verticalAlign: 'top', marginLeft: 8 }}>%</span>
      </div>
      <div style={{ ...common, position: 'absolute', left: 4, top: 0, WebkitTextStroke: '2.5px #4de1ff', opacity: 0.28 }}>
        {value}
        <span style={{ fontSize: 80, verticalAlign: 'top', marginLeft: 8 }}>%</span>
      </div>
      <div style={{ ...common, position: 'relative' }}>
        {value}
        <span style={{ fontSize: 80, verticalAlign: 'top', marginLeft: 8 }}>%</span>
      </div>
    </div>
  );
}
