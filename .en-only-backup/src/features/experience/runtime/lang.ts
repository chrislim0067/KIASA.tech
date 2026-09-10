import type { Lang } from './ui/language';

/** Language of an experience route, usable on the server. */
export const detectLangFromPath = (pathname: string): Lang => {
  if (pathname === '/ja' || pathname.startsWith('/ja/')) return 'ja';
  if (pathname === '/fr' || pathname.startsWith('/fr/')) return 'fr';
  return 'en';
};
