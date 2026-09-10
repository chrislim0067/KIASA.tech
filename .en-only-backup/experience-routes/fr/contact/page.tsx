import type { Metadata } from 'next';
import ContactViewFr from '@/components/experience/generated/ContactViewFr';
import { ExperiencePage, experienceMetadata } from '@/features/experience/ExperiencePage';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return experienceMetadata('fr/contact');
}

export default function Page() {
  return <ExperiencePage slug="fr/contact" view="contact" View={ContactViewFr} />;
}
