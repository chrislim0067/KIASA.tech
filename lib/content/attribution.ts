/**
 * Visit attribution stored for the contact forms (port of the inline `utsubo_attr` script
 * that ran on every page of the original build).
 */
const ATTR_KEY = 'utsubo_attr';
const JOURNEY_KEY = 'utsubo_journey';
const ATTR_TTL = 30 * 24 * 60 * 60 * 1000;

type Store = 'sessionStorage' | 'localStorage';

const read = (store: Store, key: string): unknown => {
  try {
    return JSON.parse(window[store].getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

const write = (store: Store, key: string, value: unknown): boolean => {
  try {
    window[store].setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const referrerOrigin = (): string => {
  try {
    if (!document.referrer) return '';
    const ref = new URL(document.referrer);
    return ref.host === location.host ? '' : ref.origin;
  } catch {
    return '';
  }
};

const campaignValue = (params: URLSearchParams, key: string): string => (params.get(key) ?? '').slice(0, 150);

export function captureAttribution(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(location.search);
  const rec: Record<string, unknown> = {
    referrer: referrerOrigin(),
    landing_page: location.pathname.slice(0, 300),
    utm_source: campaignValue(params, 'utm_source'),
    utm_medium: campaignValue(params, 'utm_medium'),
    utm_campaign: campaignValue(params, 'utm_campaign'),
  };
  const meaningful = rec.referrer || rec.utm_source || rec.utm_medium || rec.utm_campaign;
  const session = read('sessionStorage', ATTR_KEY);
  const newSession = !session || typeof session !== 'object';
  if (newSession) write('sessionStorage', ATTR_KEY, rec);

  let journey = read('sessionStorage', JOURNEY_KEY);
  if (!Array.isArray(journey)) journey = [];
  const currentPath = location.pathname.slice(0, 120);
  const list = journey as string[];
  if (list[list.length - 1] !== currentPath) {
    list.push(currentPath);
    write('sessionStorage', JOURNEY_KEY, list.slice(-10));
  }

  const local = read('localStorage', ATTR_KEY) as Record<string, unknown> | null;
  const localAge = local && Number.isFinite(local.ts as number) ? Date.now() - (local.ts as number) : -1;
  const localValid = localAge >= 0 && localAge < ATTR_TTL;
  const localMeaningful = localValid && local && (local.referrer || local.utm_source || local.utm_medium || local.utm_campaign);
  if (!localValid || (!localMeaningful && meaningful)) {
    rec.ts = localValid && local ? local.ts : Date.now();
    const visits = localValid && local && Number.isFinite(local.visits as number) ? (local.visits as number) : 0;
    rec.visits = visits + (newSession ? 1 : 0) || 1;
    write('localStorage', ATTR_KEY, rec);
  } else if (newSession && local) {
    local.visits = (Number.isFinite(local.visits as number) ? (local.visits as number) : 0) + 1;
    write('localStorage', ATTR_KEY, local);
  }
}
