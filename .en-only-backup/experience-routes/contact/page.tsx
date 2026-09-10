import type { Metadata } from 'next';
import ContactViewEn from '@/components/experience/generated/ContactViewEn';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('contact');
}

export default function Page() {
  return <ExperiencePage slug="contact" view="contact" View={ContactViewEn} />;
}
