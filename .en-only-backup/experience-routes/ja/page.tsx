import type { Metadata } from 'next';
import TopViewJa from '@/components/experience/generated/TopViewJa';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('ja');
}

export default function Page() {
  return <ExperiencePage slug="ja" view="top" View={TopViewJa} />;
}
