import AdminShell from '@/components/admin/AdminShell';
import { SkeletonSection, LoadingAnnouncement } from '@/components/admin/Skeleton';

/**
 * Shown the instant /admin is clicked, while the page's queries run.
 *
 * Next wraps the route in a Suspense boundary with this as the fallback, so the
 * navigation is immediate and the data streams in underneath. The shell is the
 * real one — nav, brand, live pulse — so only the numbers change when the data
 * lands, not the layout.
 */
export default function Loading() {
  return (
    <AdminShell
      title="Platform overview"
      lede="Live counters, read directly from the database on every load."
      actorEmail={null}
      currentPath="/admin"
    >
      <LoadingAnnouncement label="Loading platform overview" />
      <SkeletonSection title="Accounts" tiles={8} />
      <SkeletonSection title="Applications" tiles={7} />
      <SkeletonSection title="Bid Bot" tiles={4} />
      <SkeletonSection title="Job intake" tiles={4} />
    </AdminShell>
  );
}
