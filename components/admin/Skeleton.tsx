/**
 * Loading skeletons for the administrator routes.
 *
 * These are what Next renders through a route's `loading.tsx` while the page's
 * server component is still fetching. That is the whole trick behind the way
 * LinkedIn and X feel instant: the chrome and the SHAPE of the content appear
 * on click, and the data fills in underneath. Nothing is faster, but the wait
 * stops being a blank screen.
 *
 * Two rules that keep it from looking cheap:
 *
 *   * The skeleton must match the real layout's dimensions. A placeholder that
 *     is the wrong size causes the page to jump when data arrives, which reads
 *     as *slower* than having shown nothing.
 *
 *   * `aria-hidden` plus a single announced status. A screen reader should hear
 *     "loading" once, not read out forty empty boxes.
 */

export function SkeletonLine({ w = '100%', h = '0.9rem' }: { w?: string; h?: string }) {
  return <span className="kadmin__skel" style={{ width: w, height: h }} aria-hidden="true" />;
}

/** Mirrors .kadmin__stats — a wrapping row of counter tiles. */
export function SkeletonStats({ count = 6 }: { count?: number }) {
  return (
    <div className="kadmin__stats" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="kadmin__stat" key={i}>
          <SkeletonLine w="60%" h="0.6rem" />
          <SkeletonLine w="40%" h="1.5rem" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonSection({ title, tiles = 6 }: { title: string; tiles?: number }) {
  return (
    <section className="kadmin__section">
      <div className="kadmin__sectionHead">
        <h2 className="kadmin__sectionTitle">{title}</h2>
      </div>
      <SkeletonStats count={tiles} />
    </section>
  );
}

/** Mirrors the user table, including the caption row. */
export function SkeletonTable({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="kadmin__tableWrap" aria-hidden="true">
      <div style={{ padding: '0.75rem 1rem' }}>
        <SkeletonLine w="9rem" h="0.7rem" />
      </div>
      <table className="kadmin__table">
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c}>
                  <SkeletonLine w={c === 0 ? '70%' : '45%'} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The one thing assistive technology should hear while a route loads. */
export function LoadingAnnouncement({ label }: { label: string }) {
  return (
    <span className="kadmin__srOnly" role="status" aria-live="polite">
      {label}
    </span>
  );
}
