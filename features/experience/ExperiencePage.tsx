import type { Metadata } from 'next';
import type { ComponentType } from 'react';
import { JsonLd } from '@/components/JsonLd';
import { PageEffects } from '@/components/PageEffects';
import { getExperienceHead } from '@/lib/content/pages';
import { buildMetadata } from '@/lib/metadata';
import { ExperienceView } from './ExperienceView';
import type { ViewName } from './runtime/navigation';

export const experienceMetadata = (slug: string): Metadata => buildMetadata(getExperienceHead(slug));

/** Server component shared by the nine experience routes. */
export function ExperiencePage({ slug, view, View }: { slug: string; view: ViewName; View: ComponentType }) {
  const head = getExperienceHead(slug);
  return (
    <>
      <PageEffects lang={head.lang} />
      <JsonLd blocks={head.jsonLd} />
      <ExperienceView view={view}>
        <View />
      </ExperienceView>
    </>
  );
}
