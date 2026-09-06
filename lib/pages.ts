import 'server-only';

import fs from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';

import { pages } from '@/lib/generated/pages';
import type { PageEntry } from '@/types/page';

const CONTENT = path.join(process.cwd(), 'content', 'pages');

/** Meta names/properties that Next's `metadata` export already emits for us. */
const HANDLED = new Set([
  'description',
  'keywords',
  'author',
  'robots',
  'viewport',
  'og:title',
  'og:description',
  'og:image',
  'og:url',
  'og:type',
  'og:site_name',
  'og:locale',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
]);

export function getPage(key: string): PageEntry {
  const page = pages[key];
  if (!page) throw new Error(`Unknown page key: ${key}`);
  return page;
}

/**
 * Resolve a page family (`/service`, `/blog-post`, …) to a concrete variant.
 * Falls back to the bare page when the query value is absent or unknown, which
 * mirrors how the PHP version degrades.
 */
export function resolveKey(segment: string, param?: string): string {
  if (param) {
    const withParam = `${segment}__${param}`;
    if (pages[withParam]) return withParam;
  }
  if (pages[segment]) return segment;
  const first = Object.values(pages).find((p) => p.segment === segment);
  if (!first) throw new Error(`No page for segment "${segment}"`);
  return first.key;
}

export function readMarkup(key: string): string {
  return fs.readFileSync(path.join(CONTENT, `${key}.html`), 'utf8');
}

export function readJsonLd(key: string): string[] {
  const file = path.join(CONTENT, `${key}.jsonld.json`);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
}

/** Head <meta> tags the Next metadata export does not already cover. */
export function extraMeta(page: PageEntry) {
  return page.metaAll.filter((m) => {
    const id = (m.property ?? m.name ?? '').toLowerCase();
    return id && !HANDLED.has(id) && id !== 'charset';
  });
}

export function buildMetadata(key: string): Metadata {
  const { meta } = getPage(key);
  const md: Metadata = {
    title: meta.title,
    description: meta.description,
  };
  if (meta.canonical) md.alternates = { canonical: meta.canonical };
  if (meta.ogTitle || meta.ogImage || meta.description) {
    md.openGraph = {
      title: meta.ogTitle ?? meta.title,
      description: meta.description,
      images: meta.ogImage ? [meta.ogImage] : undefined,
      url: meta.canonical,
    };
    md.twitter = {
      card: 'summary_large_image',
      title: meta.ogTitle ?? meta.title,
      description: meta.description,
      images: meta.ogImage ? [meta.ogImage] : undefined,
    };
  }
  return md;
}
