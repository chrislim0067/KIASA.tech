/**
 * Extraction confidence, as a ring.
 *
 * This occupies the slot a job site would fill with a résumé match score. It is
 * deliberately NOT that: nothing here knows anything about a candidate, so a
 * "92% match" would be decoration dressed as analysis. What this number does
 * say is how much of the posting the extractor actually recovered, and so how
 * much to trust the fields beside it — which is real, and worth surfacing,
 * because a generic-extractor reading of an unusual page genuinely can be wrong.
 *
 * Drawn with two SVG circles rather than a chart library: it is one arc.
 */
export default function ConfidenceRing({ value }: { value: number | null }) {
  const pct = value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100);

  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const filled = pct === null ? 0 : (pct / 100) * circumference;

  const tone = pct === null ? 'dim' : pct >= 70 ? 'high' : pct >= 45 ? 'mid' : 'low';

  return (
    <div className={`kjobs__ring kjobs__ring--${tone}`}>
      <svg width="68" height="68" viewBox="0 0 68 68" aria-hidden="true">
        <circle cx="34" cy="34" r={radius} className="kjobs__ringTrack" />
        <circle
          cx="34"
          cy="34"
          r={radius}
          className="kjobs__ringValue"
          strokeDasharray={`${filled} ${circumference - filled}`}
          // Start the arc at twelve o'clock instead of three.
          transform="rotate(-90 34 34)"
        />
      </svg>
      <span className="kjobs__ringLabel">
        {pct === null ? '—' : `${pct}%`}
        <small>extracted</small>
      </span>
    </div>
  );
}
