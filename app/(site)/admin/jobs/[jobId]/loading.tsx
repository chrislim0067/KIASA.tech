import AdminShell from '@/components/admin/AdminShell';
import { SkeletonLine, LoadingAnnouncement } from '@/components/admin/Skeleton';
import '@/styles/admin-jobs.css';

/** Shown while one posting's row is read. Same shape as the real page. */
export default function Loading() {
  return (
    <AdminShell title="Posting" actorEmail={null} currentPath="/admin/jobs">
      <LoadingAnnouncement label="Loading posting" />

      <section className="kadmin__panel" aria-hidden="true">
        <SkeletonLine w="6rem" h="1.4rem" />
        <div style={{ height: '1rem' }} />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: '1rem', padding: '0.4rem 0' }}>
            <SkeletonLine w="7rem" h="0.8rem" />
            <SkeletonLine w="12rem" h="0.8rem" />
          </div>
        ))}
      </section>
    </AdminShell>
  );
}
