import type { JobSummary } from '@/lib/jobboard/types';

/**
 * Display helpers for the job board.
 *
 * Every one of these takes possibly-null fields and returns either something
 * printable or `null` — never a placeholder like "N/A". A saved job is only as
 * complete as the page it came from, and the UI omits what is missing rather
 * than filling the screen with absences.
 *
 * Deliberately free of `server-only`: the list, the board and the detail page
 * all render these, and none of them needs anything but the strings.
 */

type SalaryFields = Pick<
  JobSummary,
  'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'
>;
type ExperienceFields = Pick<JobSummary, 'experience_min_years' | 'experience_max_years'>;

const PERIOD_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  hour: '/hr',
  day: '/day',
  week: '/wk',
  month: '/mo',
  year: '/yr',
});

export function formatSalary(job: SalaryFields): string | null {
  const { salary_min: min, salary_max: max, salary_currency: currency, salary_period: period } = job;
  if (min === null && max === null) return null;

  const compact = (value: number): string =>
    value >= 1000 ? `${Math.round(value / 1000).toString()}k` : value.toLocaleString();

  const amount =
    min !== null && max !== null && min !== max
      ? `${compact(min)}–${compact(max)}`
      : compact((min ?? max) as number);

  const prefix = currency === 'USD' ? '$' : currency ? `${currency} ` : '';
  return `${prefix}${amount}${period ? (PERIOD_SUFFIX[period] ?? '') : ''}`;
}

export function formatExperience(job: ExperienceFields): string | null {
  const { experience_min_years: min, experience_max_years: max } = job;
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min !== max) return `${min}–${max} years`;
  return `${(min ?? max) as number}+ years`;
}

/**
 * Human-readable age.
 *
 * Deliberately coarse. "3 days ago" is what someone scanning a column needs;
 * a timestamp to the minute is noise they have to parse. The detail page shows
 * the exact date, which is where precision belongs.
 */
export function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';

  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** The same format the rest of the admin surface uses for absolute dates. */
export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

/**
 * Reads a seniority band off the title.
 *
 * Derived, not extracted — and only from words the title actually contains, so
 * it never asserts a level the posting did not use. Returns nothing when the
 * title is not explicit, which is common and fine.
 */
export function seniorityOf(title: string | null): string | null {
  if (!title) return null;
  const text = title.toLowerCase();
  if (/\b(?:principal|distinguished|fellow)\b/u.test(text)) return 'Principal';
  if (/\bstaff\b/u.test(text)) return 'Staff';
  if (/\b(?:lead|head of)\b/u.test(text)) return 'Lead';
  if (/\b(?:senior|sr\.?)\b/u.test(text)) return 'Senior';
  if (/\b(?:junior|jr\.?|associate|entry)\b/u.test(text)) return 'Junior';
  if (/\bintern(?:ship)?\b/u.test(text)) return 'Intern';
  return null;
}

/** `full_time` reads as "full time" wherever an employment type is printed. */
export function humanise(value: string | null): string | null {
  return value ? value.replace(/_/gu, ' ') : null;
}
