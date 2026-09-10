import type { Metadata } from 'next';
import AboutViewJa from '@/components/experience/generated/AboutViewJa';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('ja/about');
}

export default function Page() {
  return <ExperiencePage slug="ja/about" view="about" View={AboutViewJa} />;
}
