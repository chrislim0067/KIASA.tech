import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import { BOARD_MOVES, BOARD_START, JOBS, PROFILE, type BoardStatus, type Column } from '../data/sample';
import { COPY, OVERLAP, SCENES } from '../timeline';
import { font, product } from '../tokens';
import { BoardCard } from '../ui/JobCard';
import { useFormat } from '../ui/layout';
import { arrive, count, fadeUp, ramp, settle } from '../ui/motion';
import { Chip, Dot, Headline, Kicker, Panel } from '../ui/primitives';

const COL_W = 300;
const COL_GAP = 28;
const CARD_H = 92;
const CARD_GAP = 12;
const HEAD_H = 46;
const BOARD_W = COL_W * 4 + COL_GAP * 3;
const BOARD_H = HEAD_H + (CARD_H + CARD_GAP) * 3;

interface CardState {
  col: Column;
  status: BoardStatus;
  note?: string;
  /** Frame the card last changed column; drives its spring. */
  movedAt: number;
}

/** The board at a local frame: every card's column, status and last move. */
function boardAt(frame: number): Map<string, CardState> {
  const state = new Map<string, CardState>();
  for (const c of BOARD_START) state.set(c.card, { col: c.col, status: c.status, movedAt: -999 });
  for (const m of BOARD_MOVES) {
    if (m.at > frame) break;
    const prev = state.get(m.card)!;
    state.set(m.card, {
      col: m.col,
      status: m.status,
      note: m.note,
      movedAt: m.col !== prev.col ? m.at : prev.movedAt,
    });
  }
  return state;
}

/**
 * 0:15–0:23, one continuous shot. Five seconds on the pipeline — cards moving
 * DISCOVER → MATCH → PREPARE → APPLY on their own, statuses ticking, one card
 * stopping for a human — then the camera pulls back and the board becomes a
 * panel of the dashboard.
 */
export function S5Pipeline() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, landscape, s } = useFormat();
  const enter = ramp(frame, 0, OVERLAP);

  const pullAt = SCENES.automate.dur;
  const pull = settle(frame, fps, pullAt, 70);
  const total = SCENES.automate.dur + SCENES.dashboard.dur;
  // A short blur-out right at the end: the dashboard needs its full beat on
  // screen, and the end card is already fading in over the top of this.
  const exit = ramp(frame, total - 22, 22);

  const state = boardAt(Math.min(frame, pullAt + 40));

  // Row = order of arrival within a column, so nothing overlaps.
  const rows = new Map<string, number>();
  for (let col = 0 as Column; col < 4; col = (col + 1) as Column) {
    const inCol = [...state.entries()]
      .filter(([, c]) => c.col === col)
      .sort((a, b) => a[1].movedAt - b[1].movedAt);
    inCol.forEach(([id], i) => rows.set(id, i));
  }

  const board = (
    <div style={{ position: 'relative', width: BOARD_W, height: BOARD_H }}>
      {COPY.automate.columns.map((name, i) => (
        <div key={name} style={{ position: 'absolute', left: i * (COL_W + COL_GAP), top: 0, width: COL_W }}>
          <div
            style={{
              height: HEAD_H,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              borderBottom: `1px solid ${product.lineSoft}`,
              opacity: ramp(frame, 6 + i * 6, 20),
            }}
          >
            <Kicker size={11.5}>{name}</Kicker>
            <span style={{ fontFamily: font.mono, fontSize: 11, color: product.muted }}>
              {[...state.values()].filter((c) => c.col === i).length}
            </span>
          </div>
        </div>
      ))}
      {[...state.entries()].map(([id, c]) => {
        const job = JOBS.find((j) => j.id === id)!;
        const p = c.movedAt < 0 ? 1 : arrive(frame, fps, c.movedAt);
        // Slide in from the previous column's x; we only know the target, so
        // ease from one column to the left, which is always where it came from.
        const x = c.col * (COL_W + COL_GAP);
        const fromX = x - (COL_W + COL_GAP);
        const y = HEAD_H + 14 + (rows.get(id) ?? 0) * (CARD_H + CARD_GAP);
        const appear = ramp(frame, 10 + (BOARD_START.findIndex((b) => b.card === id)) * 5, 24);
        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: fromX + (x - fromX) * p,
              top: y,
              width: COL_W,
              opacity: appear,
              transform: `scale(${0.96 + 0.04 * p})`,
            }}
          >
            <BoardCard job={job} status={c.status} note={c.note} width={COL_W} />
          </div>
        );
      })}
    </div>
  );

  // Camera. Phase A: board centred under the caption. Phase B: board scaled
  // and parked lower-right inside the dashboard frame.
  const pad = 80 * s;
  const boardK = landscape ? Math.min((width - pad * 2) / BOARD_W, 1.15 * s) : (width - pad * 2) / BOARD_W;
  const aLeft = (width - BOARD_W * boardK) / 2;
  const aTop = landscape ? height * 0.38 : height * 0.42;

  // In the dashboard the board is the right-hand column, top-aligned with the
  // stat tiles on the left — a grid, the way a dashboard is.
  const dashK = boardK * (landscape ? 0.72 : 0.78);
  const bLeft = landscape ? width - pad - BOARD_W * dashK : (width - BOARD_W * dashK) / 2;
  const bTop = landscape ? 72 * s + pad * 0.7 : height - pad - BOARD_H * dashK;

  const k = boardK + (dashK - boardK) * pull;
  const left = aLeft + (bLeft - aLeft) * pull;
  const top = aTop + (bTop - aTop) * pull;

  const dashIn = ramp(frame, pullAt + 18, 40);
  const tileAt = pullAt + 30;

  return (
    <AbsoluteFill
      style={{
        background: product.bg,
        opacity: enter,
        filter: `blur(${exit * 14}px)`,
      }}
    >
      {/* Dashboard chrome — `.kprof__bar` */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: 72 * s,
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${pad}px`,
          borderBottom: `1px solid ${product.line}`,
          background: 'rgba(11, 12, 16, 0.92)',
          fontFamily: font.ui,
          opacity: dashIn,
          transform: `translateY(${(1 - dashIn) * -20}px)`,
        }}
      >
        <span style={{ fontFamily: font.head, fontWeight: 700, fontSize: 14 * s, letterSpacing: '0.34em', textTransform: 'uppercase', color: product.text }}>
          KIASA
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 18 * s, fontSize: 13.5 * s, color: product.muted }}>
          <span>{PROFILE.email}</span>
          <span>Dashboard</span>
        </span>
      </div>

      {/* Phase A caption + automation toggle */}
      <div
        style={{
          position: 'absolute',
          left: pad,
          right: pad,
          top: landscape ? height * 0.13 : height * 0.16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18 * s,
          opacity: 1 - pull,
          transform: `scale(${s})`,
          transformOrigin: 'top center',
        }}
      >
        <Headline lines={COPY.automate.main} start={40} size={44} align="center" />
        <div style={{ ...fadeUp(frame, 14, 26, 10) }}>
          <Chip tone="success" active size={13}>
            <Dot state="done" size={7} />
            {COPY.automate.automation} · {COPY.automate.on}
          </Chip>
        </div>
      </div>

      {/* Phase B: stat tiles + profile, left column */}
      <div
        style={{
          position: 'absolute',
          left: pad,
          top: 72 * s + pad * 0.7,
          width: landscape ? width - pad * 3 - BOARD_W * dashK : width - pad * 2,
          opacity: dashIn,
          transform: `translateY(${(1 - dashIn) * 16}px) scale(${s})`,
          transformOrigin: 'top left',
          fontFamily: font.ui,
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14, width: landscape ? 560 : (width - pad * 2) / s }}>
          {COPY.dashboard.tiles.map((t, i) => (
            <Panel key={t.label} style={{ padding: '16px 18px', ...fadeUp(frame, tileAt + i * 8, 26, 12) }}>
              <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>
                {count(frame, tileAt + i * 8, 46, t.value)}
              </div>
              <div style={{ marginTop: 2, fontSize: 12.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: product.muted }}>
                {t.label}
              </div>
            </Panel>
          ))}
        </div>
        <Panel style={{ marginTop: 14, padding: '14px 18px', width: landscape ? 560 : (width - pad * 2) / s, display: 'flex', alignItems: 'center', gap: 14, ...fadeUp(frame, tileAt + 40, 26, 12) }}>
          <div style={{ fontSize: 13, color: product.muted, whiteSpace: 'nowrap' }}>{COPY.dashboard.profile}</div>
          <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div style={{ width: `${100 * ramp(frame, tileAt + 44, 40)}%`, height: '100%', borderRadius: 999, background: product.success }} />
          </div>
          <div style={{ fontSize: 13, color: product.muted, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {COPY.dashboard.profileNote}
          </div>
        </Panel>
      </div>

      {/* Phase B headline: full width along the bottom, where the dashboard
          leaves room, rather than squeezed into the stat column. */}
      <div
        style={{
          position: 'absolute',
          left: pad,
          right: pad,
          bottom: pad,
          opacity: dashIn,
          transform: `scale(${s})`,
          transformOrigin: 'bottom left',
        }}
      >
        <Headline lines={COPY.dashboard.main} start={tileAt + 56} size={44} />
      </div>

      {/* The board, both phases */}
      <div
        style={{
          position: 'absolute',
          left,
          top,
          width: BOARD_W,
          height: BOARD_H,
          transform: `scale(${k})`,
          transformOrigin: 'top left',
        }}
      >
        {board}
      </div>
    </AbsoluteFill>
  );
}
