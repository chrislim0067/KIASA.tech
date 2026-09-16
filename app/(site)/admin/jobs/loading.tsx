import AdminShell from '@/components/admin/AdminShell';
import { SkeletonLine, LoadingAnnouncement } from '@/components/admin/Skeleton';
import '@/styles/admin-jobs.css';

/**
 * Shown the instant /admin/jobs is clicked, while the board's query runs.
 *
 * The placeholder cards are the same height as the real ones, for the reason
 * given in `components/admin/Skeleton.tsx`: a skeleton of the wrong size makes
 * the page jump when data lands, which reads as slower than showing nothing.
 */
export default function Loading() {
  return (
    <AdminShell
      title="Job board"
      lede="Every posting saved by the browser extension, across all accounts. Read-only."
      actorEmail={null}
      currentPath="/admin/jobs"
    >
      <LoadingAnnouncement label="Loading saved jobs" />

      <div className="kjobs" aria-hidden="true">
        <div className="kjobs__head">
          <SkeletonLine w="11rem" h="0.9rem" />
        </div>

        <div className="kjobs__rows">
          {Array.from({ length: 4 }).map((_, i) => (
            <article className="kjobs__card kjobs__card--skeleton" key={i}>
              <div className="kjobs__cardBody">
                <span className="kadmin__skel kjobs__logo" />
                <div className="kjobs__cardContent">
                  <SkeletonLine w="5rem" h="0.65rem" />
                  <SkeletonLine w="60%" h="1.15rem" />
                  <SkeletonLine w="35%" h="0.8rem" />
                  <SkeletonLine w="85%" h="2.6rem" />
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </AdminShell>
  );
}
