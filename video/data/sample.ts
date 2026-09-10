/**
 * Sample data for the film. Every company and person here is FICTIONAL.
 *
 * The shapes mirror the product's own contracts so the cards say what the
 * product will say — field for field, enum for enum:
 *
 *   Job          lib/agent/contracts.ts  `NormalizedJob`
 *   Score        lib/agent/contracts.ts  `ScoreResult`, lib/ai/job-scoring.ts
 *   Application  lib/applications/state.ts `APPLICATION_STATUSES`
 *   Profile      lib/candidate/…, migrations 2–5
 *
 * They are restated rather than imported: the video is built by Remotion's own
 * bundler and must not reach into `lib/`, which imports `zod` and `server-only`.
 * If a contract changes, the comment above says where to look.
 */

export type Remote = 'yes' | 'no' | 'unknown';
export type EmploymentType =
  | 'full_time'
  | 'part_time'
  | 'contract'
  | 'internship'
  | 'temporary'
  | 'freelance';
export type Ats = 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'smartrecruiters' | 'other' | 'unknown';

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  remote: Remote;
  employment_type: EmploymentType;
  ats: Ats;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  /** Monthly unless the currency is USD, where the market quotes annual. */
  salary_period: 'month' | 'year' | 'hour';
}

export const JOBS: readonly Job[] = [
  { id: 'j1', title: 'Senior Product Designer', company: 'Northwind Labs', location: 'Singapore', remote: 'yes', employment_type: 'full_time', ats: 'greenhouse', salary_min: 9000, salary_max: 12000, salary_currency: 'SGD', salary_period: 'month' },
  { id: 'j2', title: 'Product Designer', company: 'Meridian Health', location: 'Singapore', remote: 'no', employment_type: 'full_time', ats: 'lever', salary_min: 7000, salary_max: 9000, salary_currency: 'SGD', salary_period: 'month' },
  { id: 'j3', title: 'Design Systems Lead', company: 'Halcyon', location: 'Remote · APAC', remote: 'yes', employment_type: 'contract', ats: 'ashby', salary_min: 90, salary_max: 110, salary_currency: 'USD', salary_period: 'hour' },
  { id: 'j4', title: 'UX Designer', company: 'Ferrous Robotics', location: 'Singapore', remote: 'no', employment_type: 'full_time', ats: 'workday', salary_min: 6500, salary_max: 8000, salary_currency: 'SGD', salary_period: 'month' },
  { id: 'j5', title: 'Staff Designer', company: 'Lumen Pay', location: 'Remote · US', remote: 'yes', employment_type: 'full_time', ats: 'greenhouse', salary_min: 150000, salary_max: 180000, salary_currency: 'USD', salary_period: 'year' },
  { id: 'j6', title: 'Product Designer II', company: 'Cobalt Analytics', location: 'Singapore', remote: 'unknown', employment_type: 'full_time', ats: 'smartrecruiters', salary_min: 8000, salary_max: 10000, salary_currency: 'SGD', salary_period: 'month' },
  { id: 'j7', title: 'Senior UX Designer', company: 'Tidewater', location: 'Kuala Lumpur', remote: 'yes', employment_type: 'full_time', ats: 'lever', salary_min: 14000, salary_max: 18000, salary_currency: 'MYR', salary_period: 'month' },
  { id: 'j8', title: 'Design Lead', company: 'Arclight Studio', location: 'Singapore', remote: 'no', employment_type: 'full_time', ats: 'other', salary_min: 11000, salary_max: 14000, salary_currency: 'SGD', salary_period: 'month' },
];

/** The one job the film follows through matching, preparation and applying. */
export const FOCUS_JOB = JOBS[0];

export const EMPLOYMENT_LABEL: Record<EmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
  temporary: 'Temporary',
  freelance: 'Freelance',
};

export const ATS_LABEL: Record<Ats, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workday: 'Workday',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  other: 'Careers site',
  unknown: '—',
};

/** `remote` is a tristate in the contract; `unknown` shows nothing, never a guess. */
export function remoteLabel(r: Remote): string | null {
  return r === 'yes' ? 'Remote' : r === 'no' ? 'On-site' : null;
}

export function salaryLabel(j: Job): string | null {
  if (j.salary_min == null || j.salary_max == null || !j.salary_currency) return null;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const range = `${k(j.salary_min)}–${k(j.salary_max)}`;
  const per = j.salary_period === 'hour' ? '/h' : j.salary_period === 'year' ? '/yr' : '';
  return `${j.salary_currency} ${range}${per}`;
}

/* ---------------------------------------------------------------- profile */

export const PROFILE = {
  initials: 'AC',
  name: 'Amara Chen',
  title: 'Product Designer',
  location: 'Singapore',
  email: 'amara.chen@example.com',
  skills: ['Figma', 'Design systems', 'Prototyping', 'User research', 'Accessibility', 'HTML / CSS'],
  experience: [
    { role: 'Senior Product Designer', company: 'Vantage Studio', span: '2022 – 2026', keep: true },
    { role: 'Design Lead', company: 'Orbital Labs', span: '2019 – 2022', keep: true },
    { role: 'Visual Designer', company: 'Freelance', span: '2017 – 2019', keep: false },
  ],
} as const;

/** What the focus job asks for. Order matters: matched ones are evaluated first. */
export const REQUIREMENTS = [
  { label: 'Figma', matches: 'Figma' },
  { label: 'Design systems', matches: 'Design systems' },
  { label: 'User research', matches: 'User research' },
  { label: 'Accessibility', matches: 'Accessibility' },
  { label: 'Motion design', matches: null },
  { label: 'B2B SaaS', matches: null },
] as const;

/** The score the film shows — `ScoreResult.score` and `.confidence`. */
export const SCORE = { score: 92, confidence: 0.91 } as const;

/* --------------------------------------------------------------- prepare */

/** Job-description fragments, with the phrases the tailoring picks out. */
export const JD_LINES = [
  { text: 'Own the design system across web and mobile', mark: 'design system' },
  { text: 'Champion accessibility to WCAG 2.2', mark: 'accessibility' },
  { text: 'Partner with engineering and product', mark: 'Partner with engineering' },
  { text: 'Prototype and test in Figma', mark: null },
  { text: 'Mentor designers across the team', mark: null },
] as const;

export const APPLICATION = {
  summary: 'Design-systems lead with seven years shipping accessible product at scale.',
  highlights: [
    'Built Vantage’s multi-platform design system',
    'Led a WCAG 2.2 accessibility programme',
  ],
  /** `allow_resume_tailoring` / `allow_cover_letter_generation` — migration 3. */
  toggles: [
    { label: 'Résumé tailoring', value: 'on' },
    { label: 'Cover letter', value: 'generated' },
  ],
} as const;

/* -------------------------------------------------------------- pipeline */

/**
 * Display labels for the pipeline board. Each is a real state:
 *
 *   Matched      task `scored`, no application row yet
 *   Queued       application `queued`
 *   Preparing    application `preparing`  (task `leased` / `processing`)
 *   Ready        task `ready_to_submit`   (application `submitting`)
 *   Applied      application `submitted` | `confirmed` — SUCCESS_STATUSES
 *   Needs review application `needs_intervention` (task `manual_review`)
 */
export type BoardStatus = 'Matched' | 'Queued' | 'Preparing' | 'Ready' | 'Applied' | 'Needs review';
export type Column = 0 | 1 | 2 | 3;

export interface BoardMove {
  /** Local frame within the automate scene. */
  at: number;
  card: string;
  col: Column;
  status: BoardStatus;
  /** A one-word reason, shown only for a stop. */
  note?: string;
}

/** The opening arrangement, then every change, in order. */
export const BOARD_START: readonly { card: string; col: Column; status: BoardStatus }[] = [
  { card: 'j2', col: 0, status: 'Matched' },
  { card: 'j3', col: 0, status: 'Matched' },
  { card: 'j6', col: 0, status: 'Matched' },
  { card: 'j1', col: 1, status: 'Matched' },
  { card: 'j4', col: 2, status: 'Preparing' },
  { card: 'j5', col: 3, status: 'Applied' },
];

export const BOARD_MOVES: readonly BoardMove[] = [
  { at: 30,  card: 'j1', col: 2, status: 'Queued' },
  { at: 60,  card: 'j1', col: 2, status: 'Preparing' },
  { at: 70,  card: 'j2', col: 1, status: 'Matched' },
  { at: 95,  card: 'j4', col: 2, status: 'Ready' },
  { at: 130, card: 'j4', col: 3, status: 'Applied' },
  { at: 140, card: 'j3', col: 1, status: 'Matched' },
  { at: 165, card: 'j2', col: 2, status: 'Queued' },
  { at: 190, card: 'j2', col: 2, status: 'Preparing' },
  { at: 200, card: 'j1', col: 2, status: 'Ready' },
  { at: 235, card: 'j1', col: 3, status: 'Applied' },
  // The safety stop: `stop_on_assessment` (migration 3). It stays put.
  { at: 250, card: 'j2', col: 2, status: 'Needs review', note: 'assessment' },
  { at: 262, card: 'j6', col: 1, status: 'Matched' },
  { at: 285, card: 'j3', col: 2, status: 'Queued' },
];
