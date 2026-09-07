import AdminShell from '@/components/admin/AdminShell';
import { SkeletonTable, LoadingAnnouncement } from '@/components/admin/Skeleton';

export default function Loading() {
  return (
    <AdminShell title="Users" actorEmail={null} currentPath="/admin/users">
      <LoadingAnnouncement label="Loading users" />
      <SkeletonTable rows={8} cols={7} />
    </AdminShell>
  );
}
