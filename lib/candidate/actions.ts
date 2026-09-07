'use server';

import { revalidatePath } from 'next/cache';

import { requireCandidate } from '@/lib/candidate/session';
import {
  upsertProfile,
  upsertJobPreferences,
  workAuthorizations,
  workExperiences,
  skills,
} from '@/lib/profile';
import type { DataLayerError } from '@/lib/profile';
import type { FormState } from '@/lib/candidate/form-state';

/**
 * Server actions behind the candidate profile forms.
 *
 * Every one of them re-authenticates through `requireCandidate()`. A server
 * action is a POST endpoint with a generated name — being reachable only from a
 * page that rendered it is NOT a security property, so each action checks for
 * itself rather than trusting the page that offered it.
 *
 * They return a `FormState` rather than throwing, so a failure re-renders the
 * form with a message and the user's typing intact instead of hitting an error
 * boundary and losing it.
 *
 * All validation is the data layer's. Nothing here restates a length or a
 * vocabulary: `lib/profile` already mirrors the database constraints and is
 * covered by 127 validation-parity checks, so duplicating the rules in the UI
 * would create exactly the drift those tests exist to prevent.
 */

/** Trim, and treat an empty box as "not stated" rather than as an empty string. */
function text(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function bool(form: FormData, key: string): boolean {
  return form.get(key) === 'on' || form.get(key) === 'true';
}

function num(form: FormData, key: string): number | null {
  const raw = text(form, key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Comma-separated box -> array, blanks dropped. */
function list(form: FormData, key: string): string[] {
  const raw = text(form, key);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Every checked box of a repeated checkbox group. */
function multi(form: FormData, key: string): string[] {
  return form.getAll(key).filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * Turn a data-layer failure into something a person can act on.
 *
 * The layer's categories are stable values, so this maps them rather than
 * parsing prose. `constraint_violation` carries the database's own message,
 * which is the most specific thing available and is written for a developer —
 * so it is shown only as a fallback.
 */
function toState(error: DataLayerError): FormState {
  switch (error.category) {
    case 'invalid_input':
    case 'constraint_violation':
      // The layer attributes a failure to one field when it can. Its `message`
      // is documented as display-safe — free of SQL, constraint names and table
      // names — so it can be shown as-is.
      return {
        ok: false,
        message: error.field ? undefined : error.message,
        issues: error.field ? { [error.field]: error.message } : undefined,
      };
    case 'conflict':
      return { ok: false, message: 'That is already recorded.' };
    case 'unauthenticated':
    case 'forbidden':
      return { ok: false, message: 'Your session has expired. Sign in again.' };
    case 'unavailable':
      return { ok: false, message: 'Could not reach the database. Try again in a moment.' };
    default:
      return { ok: false, message: 'That could not be saved. Try again.' };
  }
}

/* ------------------------------------------------------------------ about */

export async function saveAbout(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  const result = await upsertProfile(supabase, user.id, {
    legal_first_name: text(form, 'legal_first_name'),
    legal_middle_name: text(form, 'legal_middle_name'),
    legal_last_name: text(form, 'legal_last_name'),
    preferred_name: text(form, 'preferred_name'),
    contact_email: text(form, 'contact_email'),
    phone_e164: text(form, 'phone_e164'),
    city: text(form, 'city'),
    state_region: text(form, 'state_region'),
    country_code: text(form, 'country_code')?.toUpperCase() ?? null,
    linkedin_url: text(form, 'linkedin_url'),
    github_url: text(form, 'github_url'),
    portfolio_url: text(form, 'portfolio_url'),
  });

  if (!result.ok) return toState(result.error);

  revalidatePath('/profile');
  return { ok: true, message: 'Saved.' };
}

/* --------------------------------------------------------- authorization */

export async function saveAuthorization(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  const country = text(form, 'country_code')?.toUpperCase();
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    return { ok: false, issues: { country_code: 'Use a two-letter country code, e.g. GB.' } };
  }

  /**
   * All three booleans are sent every time.
   *
   * They are NOT NULL in the schema precisely so a half-specified row cannot
   * exist — an unchecked box is a stated "no", not an omission. That is the
   * difference between "this person does not need sponsorship" and "we never
   * asked", and the whole authorization model rests on not confusing the two.
   */
  const result = await workAuthorizations.set(supabase, user.id, {
    country_code: country,
    is_authorized: bool(form, 'is_authorized'),
    sponsorship_required_now: bool(form, 'sponsorship_required_now'),
    sponsorship_required_future: bool(form, 'sponsorship_required_future'),
    basis: text(form, 'basis'),
  });

  if (!result.ok) return toState(result.error);

  revalidatePath('/profile');
  return { ok: true, message: `Authorization recorded for ${country}.` };
}

/**
 * The remove actions take a bare FormData and return void.
 *
 * They are used in plain <form action={...}> elements next to each row, not in
 * ProfileForm — a delete has nothing to re-render on success, because the row
 * it concerned is gone. React requires a void-returning action there, and a
 * FormState-returning one is a type error rather than something that silently
 * half-works.
 *
 * A failure is logged and the page re-renders unchanged, which is the honest
 * outcome: the row is still listed because it is still there.
 */
export async function removeAuthorization(form: FormData): Promise<void> {
  const { supabase, user } = await requireCandidate();
  const id = text(form, 'id');
  if (!id) return;

  const result = await workAuthorizations.remove(supabase, user.id, id);
  if (!result.ok) console.error('removeAuthorization failed:', result.error.code);

  revalidatePath('/profile/authorization');
  revalidatePath('/profile');
}

/* ------------------------------------------------------------ experience */

export async function addExperience(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  const isCurrent = bool(form, 'is_current');

  // NOT NULL in the schema, so they are checked here rather than sent as null
  // and bounced back as a constraint violation the person cannot act on.
  const company = text(form, 'company_name');
  const title = text(form, 'job_title');
  if (!company) return { ok: false, issues: { company_name: 'Enter the company name.' } };
  if (!title) return { ok: false, issues: { job_title: 'Enter your job title.' } };

  const result = await workExperiences.create(supabase, user.id, {
    company_name: company,
    job_title: title,
    employment_type: text(form, 'employment_type'),
    work_mode: text(form, 'work_mode'),
    location_city: text(form, 'location_city'),
    location_country_code: text(form, 'location_country_code')?.toUpperCase() ?? null,
    start_date: text(form, 'start_date'),
    // A current role must not carry an end date; the schema enforces it, and
    // sending one anyway would produce a constraint error rather than a form
    // message.
    end_date: isCurrent ? null : text(form, 'end_date'),
    is_current: isCurrent,
    description: text(form, 'description'),
  });

  if (!result.ok) return toState(result.error);

  revalidatePath('/profile');
  return { ok: true, message: 'Role added.' };
}

export async function removeExperience(form: FormData): Promise<void> {
  const { supabase, user } = await requireCandidate();
  const id = text(form, 'id');
  if (!id) return;

  const result = await workExperiences.remove(supabase, user.id, id);
  if (!result.ok) console.error('removeExperience failed:', result.error.code);

  revalidatePath('/profile/experience');
  revalidatePath('/profile');
}

/* ----------------------------------------------------------- preferences */

export async function savePreferences(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  const result = await upsertJobPreferences(supabase, user.id, {
    desired_titles: list(form, 'desired_titles'),
    desired_locations: list(form, 'desired_locations'),
    work_modes: multi(form, 'work_modes'),
    employment_types: multi(form, 'employment_types'),
    desired_min_salary: num(form, 'desired_min_salary'),
    salary_currency: text(form, 'salary_currency')?.toUpperCase() ?? null,
    salary_period: text(form, 'salary_period'),
    willing_to_relocate: bool(form, 'willing_to_relocate'),
    desired_experience_level: text(form, 'desired_experience_level'),
  });

  if (!result.ok) return toState(result.error);

  revalidatePath('/profile');
  return { ok: true, message: 'Preferences saved.' };
}

/* ---------------------------------------------------------------- skills */

export async function addSkill(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  const name = text(form, 'name');
  if (!name) return { ok: false, issues: { name: 'Enter a skill.' } };

  const result = await skills.create(supabase, user.id, {
    name,
    proficiency: text(form, 'proficiency'),
    years_experience: num(form, 'years_experience'),
  });

  if (!result.ok) {
    // Skills are unique per user case-insensitively, so this is the expected
    // failure rather than an exceptional one.
    if (result.error.category === 'conflict') {
      return { ok: false, issues: { name: `You already have "${name}".` } };
    }
    return toState(result.error);
  }

  revalidatePath('/profile');
  return { ok: true, message: 'Skill added.' };
}

export async function removeSkill(form: FormData): Promise<void> {
  const { supabase, user } = await requireCandidate();
  const id = text(form, 'id');
  if (!id) return;

  const result = await skills.remove(supabase, user.id, id);
  if (!result.ok) console.error('removeSkill failed:', result.error.code);

  revalidatePath('/profile/skills');
  revalidatePath('/profile');
}
