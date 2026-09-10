/**
 * Language-dependent navigation links (ports of `tt`, `en`, `En`, `ai`, `tn`, `kn`).
 * Runs on every top-page entry to keep hrefs and letter-split labels in sync.
 */
export type Lang = 'en' | 'ja' | 'fr';

const LANGS: Record<Lang, { next: Lang; label: string; prefix: string }> = {
  en: { next: 'ja', label: '日本語', prefix: '' },
  ja: { next: 'en', label: 'English', prefix: '/ja' },
  fr: { next: 'en', label: 'English', prefix: '/fr' },
};

const LINKS: Record<Lang, { works: { label: string; href: string }; company: { label: string; href: string; show: boolean } }> = {
  en: { works: { label: 'Works', href: 'https://works.utsubo.com/' }, company: { label: '会社概要', href: '/ja/company', show: false } },
  ja: { works: { label: '制作実績', href: 'https://works.utsubo.com/ja' }, company: { label: '会社概要', href: '/ja/company', show: true } },
  fr: { works: { label: 'Works', href: 'https://works.utsubo.com/' }, company: { label: '会社概要', href: '/ja/company', show: false } },
};

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

const setLanguageToggle = (button: HTMLElement, lang: Lang): void => {
  (Object.keys(LANGS) as Lang[]).forEach((l) => button.classList.remove(l));
  const next = LANGS[lang]?.next ?? 'en';
  setLetterLabel(button, LANGS[lang]?.label ?? 'English');
  button.classList.add(next);
};

const setLink = (link: HTMLAnchorElement | null, data: { label: string; href: string; show?: boolean } | undefined): void => {
  if (!link || !data) return;
  link.href = data.href;
  setLetterLabel(link, data.label);
  if (typeof data.show === 'boolean') link.classList.toggle('is-hidden', !data.show);
};

export const detectLang = (pathname = window.location.pathname): Lang => {
  for (const lang of ['ja', 'fr'] as Lang[]) {
    if (pathname.startsWith(`/${lang}`)) return lang;
  }
  return 'en';
};

/** Updates every navigation link for the current language (port of `kn`). */
export const updateNavigationLinks = (): void => {
  const pathname = window.location.pathname;
  const lang = detectLang(pathname);
  const toggle = (document.getElementById('nav-lang-toggle') ?? document.querySelector('.lang-btn')) as HTMLAnchorElement | null;
  const logo3d = document.querySelector<HTMLAnchorElement>('.nav-logo-link');
  const logoText = document.querySelector<HTMLAnchorElement>('.logotext-header');
  const logoMark = document.querySelector<HTMLAnchorElement>('.logomark-header');
  const navContact = document.getElementById('nav-contact') as HTMLAnchorElement | null;
  const navAbout = document.getElementById('nav-about') as HTMLAnchorElement | null;
  const contactHeader = document.getElementById('contact-nav') as HTMLAnchorElement | null;
  contactHeader?.classList.toggle('active', pathname.includes('/contact'));
  const next = LANGS[lang].next;
  const nextPrefix = LANGS[next].prefix;
  if (toggle) {
    if (lang !== 'en') {
      const stripped = pathname.replace(`/${lang}`, '');
      toggle.href = nextPrefix + (stripped.length === 0 ? '/' : stripped);
    } else {
      toggle.href = nextPrefix + pathname;
    }
  }
  const prefix = LANGS[lang].prefix;
  if (contactHeader) contactHeader.href = `${prefix}/contact`;
  if (navContact) navContact.href = `${prefix}/contact`;
  if (navAbout) navAbout.href = `${prefix}/about`;
  [logo3d, logoText, logoMark].forEach((el) => {
    if (el) el.href = prefix || '/';
  });
  const links = LINKS[lang] ?? LINKS.en;
  const blog = document.getElementById('nav-lang-blog') as HTMLAnchorElement | null;
  if (blog) blog.href = `${prefix}/blog`;
  setLink(document.getElementById('nav-lang-works') as HTMLAnchorElement | null, links.works);
  setLink(document.getElementById('nav-lang-company') as HTMLAnchorElement | null, links.company);
  if (toggle) setLanguageToggle(toggle, lang);
};
