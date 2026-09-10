import type { Metadata } from 'next';
import AboutViewFr from '@/components/experience/generated/AboutViewFr';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('fr/about');
}

export default function Page() {
  return <ExperiencePage slug="fr/about" view="about" View={AboutViewFr} />;
}
