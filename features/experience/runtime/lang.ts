import type { Lang } from './ui/language';

/**
 * Language of an experience route. The site is English only, so this is constant; it is kept
 * as a function so the layout keeps a single place to change if locales return.
 */
export const detectLangFromPath = (_pathname: string): Lang => 'en';
