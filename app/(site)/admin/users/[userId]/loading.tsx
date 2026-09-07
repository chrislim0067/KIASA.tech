import AdminShell from '@/components/admin/AdminShell';
import { SkeletonSection, SkeletonTable, LoadingAnnouncement } from '@/components/admin/Skeleton';

export default function Loading() {
  return (
    <AdminShell title="User" actorEmail={null} currentPath="/admin/users">
      <LoadingAnnouncement label="Loading user" />
      <SkeletonSection title="Applications" tiles={7} />
      <SkeletonTable rows={5} cols={6} />
    </AdminShell>
  );
}
