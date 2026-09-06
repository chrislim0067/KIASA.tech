export interface PageScript {
  kind: 'inline' | 'external';
  /** URL to load. Inline scripts are written to /generated/<key>/NN.js and referenced by src. */
  src: string;
  module: boolean;
  defer?: boolean;
  async?: boolean;
  inHead: boolean;
  /** GTM / GA4 / Meta Pixel. Held back unless NEXT_PUBLIC_WT_ANALYTICS=1. */
  analytics?: boolean;
}

export interface HeadMeta {
  name?: string;
  property?: string;
  content: string;
}

export interface PageMeta {
  title?: string;
  description?: string;
  canonical?: string;
  ogImage?: string;
  ogTitle?: string;
  lang: string;
  dir: string;
  bodyClass: string;
  bodyId: string;
}

export interface PageEntry {
  /** Next.js route this page is served at, e.g. "/" or "/service". */
  route: string;
  /** Storage key under content/pages and public/generated. */
  key: string;
  segment: string;
  /** Set for the ?s= / ?slug= page families. */
  param?: { name: 's' | 'slug'; value: string };
  meta: PageMeta;
  metaAll: HeadMeta[];
  stylesheets: string[];
  /** Raw JSON of the page's <script type="importmap">, or null. */
  importMap: string | null;
  jsonLdCount: number;
  hasCss: boolean;
  scripts: PageScript[];
}

export type PageManifest = Record<string, PageEntry>;
