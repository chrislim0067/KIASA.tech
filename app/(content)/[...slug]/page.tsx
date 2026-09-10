import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ContentEnhancements } from '@/components/content/ContentEnhancements';
import { JsonLd } from '@/components/JsonLd';
import { PageEffects } from '@/components/PageEffects';
import { getContentIndex, getContentPage } from '@/lib/content/pages';
import { buildMetadata } from '@/lib/metadata';

type Params = { slug: string[] };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return getContentIndex().map((entry) => ({ slug: entry.slug.split('/') }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const page = getContentPage(slug.join('/'));
  if (!page) return {};
  return buildMetadata(page);
}

/**
 * Static content pages (blog, landing pages, legal pages). The markup of the original build
 * is rendered verbatim; the page stylesheets are hoisted into <head> by React.
 */
export default async function ContentPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const page = getContentPage(slug.join('/'));
  if (!page) notFound();
  return (
    <>
      {page.stylesheets.map((href) => (
        <link key={href} rel="stylesheet" href={href.replace('/_astro/', '/styles/')} precedence="default" />
      ))}
      <PageEffects lang={page.lang} />
      <JsonLd blocks={page.jsonLd} />
      <div className={page.bodyClass || undefined} data-content-page dangerouslySetInnerHTML={{ __html: page.html }} />
      <ContentEnhancements features={page.features} />
    </>
  );
}
