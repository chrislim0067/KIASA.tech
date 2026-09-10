import type { Metadata } from 'next';
import ContactViewJa from '@/components/experience/generated/ContactViewJa';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('ja/contact');
}

export default function Page() {
  return <ExperiencePage slug="ja/contact" view="contact" View={ContactViewJa} />;
}
