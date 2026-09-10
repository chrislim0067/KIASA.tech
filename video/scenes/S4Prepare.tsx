import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { APPLICATION, FOCUS_JOB, JD_LINES, PROFILE } from '../data/sample';
import { COPY, OVERLAP } from '../timeline';
import { font, product } from '../tokens';
import { SceneLayout } from '../ui/layout';
import { fadeUp, ramp, settle } from '../ui/motion';
import { Chip, Dot, Headline, Panel, Status } from '../ui/primitives';

const COL_W = [440, 440, 500] as const;
const GAP = 40;
const UI_W = COL_W[0] + COL_W[1] + COL_W[2] + GAP * 2;
const UI_H = 360;

/**
 * 0:11–0:15. Job description + résumé → a tailored application. Phrases in
 * the posting light up; résumé entries are kept or skipped, as the real review
 * screen does; the application assembles on the right. Fragments only — never
 * a paragraph.
 */
export function S4Prepare() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(frame, 0, OVERLAP);

  const panelIn = (i: number) => settle(frame, fps, 6 + i * 10, 44);
  const marks = [52, 74, 96];
  const markOn = (i: number) => (i < marks.length ? ramp(frame, marks[i], 14) : 0);
  const keepAt = [62, 84, 108];
  const assembled = frame >= 168;
  const fieldIn = (i: number) => fadeUp(frame, 118 + i * 18, 28, 14);

  const col = (i: number) => COL_W.slice(0, i).reduce((a, b) => a + b, 0) + GAP * i;

  const ui = (
    <div style={{ position: 'relative', width: UI_W, height: UI_H, fontFamily: font.ui }}>
      {/* Job description */}
      <div style={{ position: 'absolute', left: col(0), top: 0, opacity: panelIn(0), transform: `translateY(${(1 - panelIn(0)) * 24}px)` }}>
        <Panel style={{ width: COL_W[0], height: UI_H, padding: 22 }}>
          <div style={{ fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: product.muted }}>
            Job description
          </div>
          <div style={{ marginTop: 6, fontSize: 15, fontWeight: 600 }}>
            {FOCUS_JOB.title} · {FOCUS_JOB.company}
          </div>
          <div style={{ display: 'grid', gap: 12, marginTop: 20 }}>
            {JD_LINES.map((line, i) => {
              const markIdx = JD_LINES.slice(0, i).filter((l) => l.mark).length;
              const on = line.mark ? markOn(markIdx) : 0;
              const [before, after] = line.mark ? line.text.split(line.mark) : [line.text, ''];
              return (
                <div key={line.text} style={{ fontSize: 14.5, lineHeight: 1.5, color: product.muted }}>
                  {before}
                  {line.mark ? (
                    <span
                      style={{
                        color: product.text,
                        background: `rgba(203, 170, 247, ${0.22 * on})`,
                        boxShadow: `0 0 0 ${3 * on}px rgba(203, 170, 247, ${0.22 * on})`,
                        borderRadius: 3,
                      }}
                    >
                      {line.mark}
                    </span>
                  ) : null}
                  {after}
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* Résumé — the real review screen's Keeping / Skipping rows */}
      <div style={{ position: 'absolute', left: col(1), top: 0, opacity: panelIn(1), transform: `translateY(${(1 - panelIn(1)) * 24}px)` }}>
        <Panel style={{ width: COL_W[1], height: UI_H, padding: 22 }}>
          <div style={{ fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: product.muted }}>
            Résumé · {PROFILE.name}
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
            {PROFILE.experience.map((e, i) => {
              const decided = frame >= keepAt[i];
              const keep = e.keep;
              return (
                <div
                  key={e.role}
                  style={{
                    padding: '12px 14px',
                    border: `1px ${decided && !keep ? 'dashed' : 'solid'} ${product.lineSoft}`,
                    borderRadius: product.radius,
                    background: product.surface,
                    opacity: decided && !keep ? 0.42 : 1,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14.5, fontWeight: 600 }}>{e.role}</div>
                    <div style={{ fontSize: 12.5, color: product.muted }}>
                      {e.company} · {e.span}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: !decided ? product.muted : keep ? product.success : product.muted,
                      opacity: decided ? 1 : 0.4,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {!decided ? '…' : keep ? 'Keeping' : 'Skipping'}
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      {/* Tailored application */}
      <div style={{ position: 'absolute', left: col(2), top: 0, opacity: panelIn(2), transform: `translateY(${(1 - panelIn(2)) * 24}px)` }}>
        <Panel raised style={{ width: COL_W[2], height: UI_H, padding: 22, borderColor: product.line }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12, letterSpacing: '0.14em', textTransform: 'uppercase', color: product.muted }}>
              Application · {FOCUS_JOB.company}
            </div>
            <Status text={assembled ? COPY.prepare.tailored : COPY.prepare.tailoring} state={assembled ? 'done' : 'working'} size={12} />
          </div>

          <div style={{ marginTop: 18, ...fieldIn(0) }}>
            <div style={{ fontSize: 11.5, color: product.muted, marginBottom: 4 }}>Summary</div>
            <div style={{ fontSize: 14.5, lineHeight: 1.45 }}>{APPLICATION.summary}</div>
          </div>

          <div style={{ marginTop: 16, ...fieldIn(1) }}>
            <div style={{ fontSize: 11.5, color: product.muted, marginBottom: 6 }}>Highlighted experience</div>
            {APPLICATION.highlights.map((h) => (
              <div key={h} style={{ display: 'flex', gap: 10, fontSize: 14, lineHeight: 1.45 }}>
                <span style={{ color: product.accent }}>—</span>
                {h}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 18, display: 'flex', gap: 8, ...fieldIn(2) }}>
            {APPLICATION.toggles.map((t) => (
              <Chip key={t.label} tone="success" active size={12}>
                <Dot state="done" size={6} />
                {t.label} · {t.value}
              </Chip>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );

  const caption = <Headline lines={COPY.prepare.main} start={150} size={44} align="center" />;

  return (
    <AbsoluteFill style={{ background: product.bg }}>
      <div style={{ position: 'absolute', inset: 0, clipPath: `inset(0 0 0 ${(1 - enter) * 100}%)` }}>
        <SceneLayout ui={ui} caption={caption} uiSize={{ w: UI_W, h: UI_H }} captionPos="bottom" />
      </div>
    </AbsoluteFill>
  );
}
