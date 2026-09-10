import { describe, expect, it } from 'vitest';
import { buildMetadata } from '@/lib/metadata';

describe('buildMetadata', () => {
  it('maps the original head tags onto Next metadata', () => {
    const metadata = buildMetadata({
      slug: 'blog/x',
      lang: 'en',
      title: 'Post | Kiasa',
      meta: [
        { name: 'description', content: 'Desc' },
        { name: 'keywords', content: 'a, b' },
        { property: 'og:title', content: 'Post' },
        { property: 'og:type', content: 'article' },
        { property: 'og:image', content: 'https://www.utsubo.com/share/ogp.png' },
        { property: 'og:image:width', content: '1200' },
        { property: 'article:published_time', content: '2026-01-01' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:image', content: 'https://www.utsubo.com/share/twitter.png' },
      ],
      links: [
        { rel: 'canonical', href: 'https://www.utsubo.com/blog/x' },
        { rel: 'alternate', hreflang: 'en', href: 'https://www.utsubo.com/blog/x' },
        { rel: 'alternate', type: 'application/rss+xml', title: 'Kiasa', href: '/rss.xml' },
      ],
      jsonLd: [],
    });
    expect(metadata.title).toBe('Post | Kiasa');
    expect(metadata.description).toBe('Desc');
    expect(metadata.alternates?.canonical).toBe('https://www.utsubo.com/blog/x');
    expect(metadata.alternates?.languages).toEqual({ en: 'https://www.utsubo.com/blog/x' });
    expect(metadata.openGraph).toMatchObject({ title: 'Post', type: 'article', publishedTime: '2026-01-01' });
    expect((metadata.openGraph?.images as Array<{ url: string; width?: number }>)[0]).toMatchObject({ url: 'https://www.utsubo.com/share/ogp.png', width: 1200 });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
  });
});
