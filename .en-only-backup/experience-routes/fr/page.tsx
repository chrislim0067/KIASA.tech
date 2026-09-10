import type { Metadata } from 'next';
import TopViewFr from '@/components/experience/generated/TopViewFr';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('fr');
}

export default function Page() {
  return <ExperiencePage slug="fr" view="top" View={TopViewFr} />;
}
