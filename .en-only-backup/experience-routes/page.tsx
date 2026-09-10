import type { Metadata } from 'next';
import TopViewEn from '@/components/experience/generated/TopViewEn';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('');
}

export default function Page() {
  return <ExperiencePage slug="" view="top" View={TopViewEn} />;
}
