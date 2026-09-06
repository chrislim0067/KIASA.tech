import type { Metadata } from 'next';
import LegacyPage from '@/components/legacy/LegacyPage';
import { buildMetadata } from '@/lib/pages';

const KEY = "about";

export const metadata: Metadata = buildMetadata(KEY);

export default function Page() {
  return <LegacyPage pageKey={KEY} />;
}
