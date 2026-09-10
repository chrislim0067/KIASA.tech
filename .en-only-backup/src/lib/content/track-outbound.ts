/** Outbound link analytics (port of `track-outbound.js`, loaded on every page). */
const localeOf = (pathname: string): 'ja' | 'fr' | 'en' =>
  pathname.startsWith('/ja/') || pathname === '/ja' ? 'ja' : pathname.startsWith('/fr/') || pathname === '/fr' ? 'fr' : 'en';

const emailContext = (anchor: HTMLAnchorElement): string => {
  const withId = anchor.closest('[id]');
  if (withId?.id) return withId.id;
  return (anchor.getAttribute('href') ?? '').replace('mailto:', '') || 'unknown';
};

const onClick = (event: Event): void => {
  const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  const locale = localeOf(window.location.pathname);
  window.dataLayer = window.dataLayer ?? [];
  if (href.includes('cal.com/utsubo')) {
    let source = window.location.pathname;
    try {
      source = new URL(href, window.location.origin).searchParams.get('source_url') ?? source;
    } catch {
      /* invalid url */
    }
    window.dataLayer.push({ event: 'cal_click', source_url: source, locale });
    return;
  }
  if (href.startsWith('mailto:')) {
    window.dataLayer.push({ event: 'email_click', email_context: emailContext(anchor), locale });
  }
};

let installed = 0;

export function installOutboundTracking(): () => void {
  if (installed++ === 0) document.addEventListener('click', onClick, { capture: true });
  return () => {
    if (--installed === 0) document.removeEventListener('click', onClick, { capture: true });
  };
}
