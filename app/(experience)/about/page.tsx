import type { Metadata } from 'next';
import AboutViewEn from '@/components/experience/generated/AboutViewEn';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('about');
}

export default function Page() {
  return <ExperiencePage slug="about" view="about" View={AboutViewEn} />;
}
