/**
 * Converts the <head> data extracted from the original build into a Next.js `Metadata`
 * object, so every tag (title, description, canonical, hreflang, Open Graph, Twitter,
 * article data) is emitted as before.
 */
import type { Metadata } from 'next';

export interface HeadData {
  slug: string;
  lang: string;
  title: string;
  meta: Record<string, string>[];
  links: Record<string, string>[];
  jsonLd: string[];
}

const HANDLED_NAMES = new Set(['description', 'keywords', 'robots', 'theme-color', 'format-detection', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:creator', 'twitter:site', 'twitter:image:alt', 'author', 'generator']);

export function buildMetadata(head: HeadData): Metadata {
  const byName = new Map<string, string>();
  const byProperty = new Map<string, string[]>();
  const other: Record<string, string | string[]> = {};
  for (const m of head.meta) {
    if (m.name !== undefined) {
      byName.set(m.name, m.content ?? '');
      if (!HANDLED_NAMES.has(m.name)) other[m.name] = m.content ?? '';
    } else if (m.property !== undefined) {
      const list = byProperty.get(m.property) ?? [];
      list.push(m.content ?? '');
      byProperty.set(m.property, list);
    }
  }
  const prop = (p: string): string | undefined => byProperty.get(p)?.[0];
  const canonical = head.links.find((l) => l.rel === 'canonical')?.href;
  const languages: Record<string, string> = {};
  head.links.filter((l) => l.rel === 'alternate' && l.hreflang && l.href).forEach((l) => {
    languages[l.hreflang!] = l.href!;
  });
  const rss = head.links.find((l) => l.rel === 'alternate' && l.type === 'application/rss+xml');
  const ogImage = prop('og:image');
  const ogType = prop('og:type');
  const twitterImage = byName.get('twitter:image');

  const openGraph: NonNullable<Metadata['openGraph']> = {
    title: prop('og:title'),
    description: prop('og:description'),
    url: prop('og:url'),
    siteName: prop('og:site_name'),
    locale: prop('og:locale'),
    alternateLocale: byProperty.get('og:locale:alternate'),
    images: ogImage
      ? [{ url: ogImage, width: prop('og:image:width') ? Number(prop('og:image:width')) : undefined, height: prop('og:image:height') ? Number(prop('og:image:height')) : undefined, alt: prop('og:image:alt') }]
      : undefined,
  };
  if (ogType === 'article') {
    Object.assign(openGraph, {
      type: 'article',
      publishedTime: prop('article:published_time'),
      modifiedTime: prop('article:modified_time'),
      authors: byProperty.get('article:author'),
      section: prop('article:section'),
      tags: byProperty.get('article:tag'),
    });
  } else if (ogType) {
    Object.assign(openGraph, { type: ogType });
  }

  const metadata: Metadata = {
    title: head.title,
    description: byName.get('description'),
    keywords: byName.get('keywords'),
    robots: byName.get('robots'),
    authors: byName.get('author') ? [{ name: byName.get('author')! }] : undefined,
    alternates: {
      canonical,
      languages: Object.keys(languages).length ? languages : undefined,
      types: rss ? { 'application/rss+xml': [{ url: rss.href!, title: rss.title }] } : undefined,
    },
    openGraph,
    twitter: {
      card: (byName.get('twitter:card') as 'summary_large_image' | 'summary' | undefined) ?? undefined,
      title: byName.get('twitter:title'),
      description: byName.get('twitter:description'),
      images: twitterImage ? [{ url: twitterImage, alt: byName.get('twitter:image:alt') }] : undefined,
      creator: byName.get('twitter:creator'),
      site: byName.get('twitter:site'),
    },
    formatDetection: { telephone: false },
    other: Object.keys(other).length ? other : undefined,
  };
  return metadata;
}
