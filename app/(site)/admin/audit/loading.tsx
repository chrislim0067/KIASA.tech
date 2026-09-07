import AdminShell from '@/components/admin/AdminShell';
import { SkeletonTable, LoadingAnnouncement } from '@/components/admin/Skeleton';

export default function Loading() {
  return (
    <AdminShell title="Audit log" actorEmail={null} currentPath="/admin/audit">
      <LoadingAnnouncement label="Loading audit log" />
      <SkeletonTable rows={10} cols={5} />
    </AdminShell>
  );
}
