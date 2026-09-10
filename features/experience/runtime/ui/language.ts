/**
 * Navigation link setup (port of `tn` and `kn`).
 *
 * The site is English only. The language toggle that used to swap between English, Japanese
 * and French is hidden, and the Japanese company link with it. The letter-split label
 * rendering is kept because the Works link still uses it.
 */
export type Lang = 'en';

const LINKS = {
  works: { label: 'Works', href: 'https://works.utsubo.com/' },
} as const;

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rebuilds a label as one animated span per character (port of `En`). */
export const setLetterLabel = (element: HTMLElement, label: string): void => {
  const spans = [...label]
    .map((char, i) => {
      const cls = `ht-${(i % 12) + 1}`;
      if (char === ' ') return '<span class="ha-itm"><span>&nbsp;</span></span>';
      const text = escapeHtml(char);
      const attr = escapeHtml(char.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
      return `<span class="ha-itm"><span class="ha-txt ha-txto ${cls}">${text}</span><span class="ha-txtb ha-txto ${cls}" aria-hidden="true" style="--char: '${attr}'"></span></span>`;
    })
    .join('');
  element.innerHTML = `<span class="flx ">${spans}</span>`;
};

const setLink = (link: HTMLAnchorElement | null, data: { label: string; href: string }): void => {
  if (!link) return;
  link.href = data.href;
  setLetterLabel(link, data.label);
};

export const detectLang = (): Lang => 'en';

/** Updates every navigation link (port of `kn`). */
export const updateNavigationLinks = (): void => {
  const pathname = window.location.pathname;
  const contactHeader = document.getElementById('contact-nav') as HTMLAnchorElement | null;
  contactHeader?.classList.toggle('active', pathname.includes('/contact'));

  if (contactHeader) contactHeader.href = '/contact';
  (document.getElementById('nav-contact') as HTMLAnchorElement | null)?.setAttribute('href', '/contact');
  (document.getElementById('nav-about') as HTMLAnchorElement | null)?.setAttribute('href', '/about');
  ['.nav-logo-link', '.logotext-header', '.logomark-header'].forEach((selector) => {
    const el = document.querySelector<HTMLAnchorElement>(selector);
    if (el) el.href = '/';
  });

  const blog = document.getElementById('nav-lang-blog') as HTMLAnchorElement | null;
  if (blog) blog.href = '/blog';
  setLink(document.getElementById('nav-lang-works') as HTMLAnchorElement | null, LINKS.works);

  // Locale-only links have no destination in an English-only site.
  document.getElementById('nav-lang-toggle')?.classList.add('is-hidden');
  document.getElementById('nav-lang-company')?.classList.add('is-hidden');
};
