import type { CSSProperties } from 'react';

import { ATS_LABEL, EMPLOYMENT_LABEL, remoteLabel, salaryLabel, type BoardStatus, type Job } from '../data/sample';
import { font, product } from '../tokens';
import { Chip, Dot, Panel } from './primitives';

/**
 * A job as the product will list it — the `NormalizedJob` fields, nothing the
 * contract cannot hold. `reading` shows the intake dot; `read` the tick.
 */
export function JobCard({
  job,
  state = 'plain',
  width = 400,
  style,
}: {
  job: Job;
  state?: 'plain' | 'reading' | 'read';
  width?: number;
  style?: CSSProperties;
}) {
  const remote = remoteLabel(job.remote);
  const salary = salaryLabel(job);
  return (
    <Panel style={{ width, padding: '16px 18px 14px', ...style }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.25, color: product.text }}>
            {job.title}
          </div>
          <div style={{ marginTop: 3, fontSize: 13.5, color: product.muted }}>
            {job.company} · {job.location}
          </div>
        </div>
        {state === 'reading' ? (
          <Dot state="working" size={8} />
        ) : state === 'read' ? (
          <span style={{ color: product.success, fontSize: 14, lineHeight: 1 }}>✓</span>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 11 }}>
        {remote ? <Chip size={12}>{remote}</Chip> : null}
        <Chip size={12}>{EMPLOYMENT_LABEL[job.employment_type]}</Chip>
        {salary ? <Chip size={12}>{salary}</Chip> : null}
        <span
          style={{
            marginLeft: 'auto',
            alignSelf: 'center',
            fontFamily: font.mono,
            fontSize: 11,
            letterSpacing: '0.06em',
            color: product.muted,
            opacity: 0.8,
          }}
        >
          {ATS_LABEL[job.ats]}
        </span>
      </div>
    </Panel>
  );
}

const STATUS_TONE: Record<BoardStatus, { tone: 'accent' | 'neutral' | 'success' | 'warn'; dot: 'working' | 'done' | 'stopped' | 'idle' | null }> = {
  Matched: { tone: 'accent', dot: null },
  Queued: { tone: 'neutral', dot: 'idle' },
  Preparing: { tone: 'accent', dot: 'working' },
  Ready: { tone: 'accent', dot: null },
  Applied: { tone: 'success', dot: 'done' },
  'Needs review': { tone: 'warn', dot: 'stopped' },
};

/** The application state as a pill. Every label maps to a real status. */
export function StatusPill({ status, note, size = 12 }: { status: BoardStatus; note?: string; size?: number }) {
  const { tone, dot } = STATUS_TONE[status];
  return (
    <Chip tone={tone} active size={size}>
      {dot ? <Dot state={dot} size={size * 0.5} /> : null}
      {status}
      {note ? <span style={{ opacity: 0.7 }}>· {note}</span> : null}
    </Chip>
  );
}

/** The compact card used on the pipeline board. */
export function BoardCard({
  job,
  status,
  note,
  width = 292,
  style,
}: {
  job: Job;
  status: BoardStatus;
  note?: string;
  width?: number;
  style?: CSSProperties;
}) {
  return (
    <Panel raised style={{ width, padding: '12px 14px', ...style }}>
      <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {job.title}
      </div>
      <div style={{ marginTop: 2, fontSize: 12.5, color: product.muted }}>{job.company}</div>
      <div style={{ marginTop: 9 }}>
        <StatusPill status={status} note={note} size={11.5} />
      </div>
    </Panel>
  );
}
