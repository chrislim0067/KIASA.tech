'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireCandidate } from '@/lib/candidate/session';
import { createAdminClient, isAdminConfigured } from '@/lib/supabase/admin';
import { extractResume, isResumeParsingConfigured, MAX_RESUME_BYTES } from '@/lib/resume/extract';
import {
  createImport,
  markParsed,
  markFailed,
  markConfirmed,
  getImport,
  discardImport,
  saveDraft,
} from '@/lib/resume/imports';
import { applyExtraction, describeOutcome } from '@/lib/resume/apply';
import { recordProviderUsage } from '@/lib/ai/usage-writer';
import { ResumeExtraction, parseExtraction } from '@/lib/resume/schema';
import { RESUME_BUCKET, RESUME_ROUTE, storagePathFor } from '@/lib/resume/paths';
import type { FormState } from '@/lib/candidate/form-state';

/**
 * The résumé import, as three server actions: parse, correct, confirm.
 *
 * Every one re-authenticates through `requireCandidate()`. A server action is a
 * POST endpoint with a generated name; being reachable only from a page that
 * rendered it is not a security property.
 *
 * The uploaded file never passes through here. The browser puts it straight
 * into the private `resumes` bucket under the candidate's own session, and this
 * code is handed a path — which it then treats as untrusted, because a path in
 * a form field is exactly as trustworthy as anything else a client sends.
 */

/* ------------------------------------------------------------------- helpers */

function text(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------- parse */

/**
 * Read a résumé that has already been uploaded.
 *
 * The path is checked against the one shape this feature ever produces —
 * `<caller's own id>/<uuid>.pdf` — before anything is fetched. Storage RLS
 * would refuse another user's folder anyway; this refuses to ask, so a crafted
 * path cannot even be used to probe which files exist.
 */
export async function startResumeImport(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  if (!isResumeParsingConfigured() || !isAdminConfigured()) {
    return { ok: false, message: 'Résumé import is not switched on yet.' };
  }

  const objectId = text(form, 'object_id');
  const fileName = text(form, 'file_name');
  const rawSize = text(form, 'file_size');

  if (!objectId || !UUID.test(objectId)) {
    return { ok: false, message: 'That upload could not be identified. Try again.' };
  }

  const path = storagePathFor(user.id, objectId);

  const size = rawSize === null ? null : Number(rawSize);
  if (size !== null && (!Number.isFinite(size) || size <= 0 || size > MAX_RESUME_BYTES)) {
    return { ok: false, message: 'That PDF is larger than 10 MB. Export a smaller copy.' };
  }

  // Downloaded with the CANDIDATE'S session, so storage RLS re-checks ownership
  // even though the path was just constructed from their own id.
  const download = await supabase.storage.from(RESUME_BUCKET).download(path);
  if (download.error || !download.data) {
    return { ok: false, message: 'That file could not be found. Upload it again.' };
  }

  const bytes = new Uint8Array(await download.data.arrayBuffer());

  const admin = createAdminClient();
  const importId = await createImport(admin, user.id, {
    sourceKind: 'upload',
    storagePath: path,
    // Only ever displayed, but a filename comes from the user's disk, so it is
    // length-capped here rather than trusted to be reasonable.
    fileName: fileName ? fileName.slice(0, 300) : null,
    fileSizeBytes: size,
  });

  if (!importId) {
    return { ok: false, message: 'The import could not be started. Try again.' };
  }

  const result = await extractResume(bytes, importId);

  /*
   * ONE USAGE ROW PER PROVIDER CALL, SUCCESS OR FAILURE.
   *
   * `result.usage` is present only when a call was actually attempted, so a
   * locally decided failure — an empty file, a scan with no text layer —
   * records nothing and correctly reports no provider activity.
   *
   * This is deliberately not a duplicate of the import row. The import says
   * what the candidate saw; this says what the call cost, how long it took, how
   * many attempts it needed and exactly how it ended. `recordProviderUsage`
   * validates the record against a `.strict()` schema before it touches the
   * database, and the record has no field that could carry résumé text, a
   * prompt or a provider message.
   *
   * It fails soft, by design: a metrics insert must never be the reason a
   * candidate's import fails. The result is deliberately not awaited into the
   * control flow beyond this line.
   */
  if (result.usage) {
    await recordProviderUsage(result.usage, user.id);
  }

  if (!result.ok) {
    await markFailed(
      admin,
      importId,
      result.failureClass,
      result.failureCode,
      result.providerCode,
      result.providerDetail
    );
    revalidatePath(RESUME_ROUTE);
    return { ok: false, message: result.message };
  }

  await markParsed(admin, importId, result.data, result.model);

  revalidatePath(RESUME_ROUTE);
  redirect(`${RESUME_ROUTE}/${importId}`);
}

/* -------------------------------------------------------------------- paste */

/**
 * Take a draft the candidate produced in Claude themselves.
 *
 * The console validated this in the browser already. That counts for nothing
 * here: browser validation is for fast feedback, and a server action is a POST
 * endpoint anyone can call. The same bytes go through the same schema again,
 * and only then does a row exist.
 *
 * No API key, no cost per résumé, and — because the schema is the database's
 * constraints in another form — no lower a standard than the upload path.
 */
export async function importPastedResume(_prev: FormState, form: FormData): Promise<FormState> {
  const { user } = await requireCandidate();

  if (!isAdminConfigured()) {
    return { ok: false, message: 'Résumé import is not switched on yet.' };
  }

  const raw = text(form, 'draft');
  if (!raw) return { ok: false, message: 'Nothing was pasted.' };

  // Bounded before parsing: JSON.parse on an unbounded string from a POST body
  // is an easy way to spend a lot of memory on nothing.
  if (raw.length > 400_000) {
    return { ok: false, message: 'That is far larger than a résumé. Paste just the JSON.' };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'That is not valid JSON.' };
  }

  const draft = parseExtraction(value);
  if (!draft) {
    return {
      ok: false,
      message: 'That draft does not match what a profile can hold. Check the console for details.',
    };
  }

  const admin = createAdminClient();
  const importId = await createImport(admin, user.id, {
    sourceKind: 'pasted',
    storagePath: null,
    fileName: null,
    fileSizeBytes: null,
  });

  if (!importId) {
    return { ok: false, message: 'The import could not be started. Try again.' };
  }

  await markParsed(admin, importId, draft, 'pasted-by-candidate');

  revalidatePath(RESUME_ROUTE);
  redirect(`${RESUME_ROUTE}/${importId}`);
}

/* ------------------------------------------------------------------ discard */

export async function discardResumeImport(form: FormData): Promise<void> {
  const { supabase } = await requireCandidate();
  const importId = text(form, 'import_id');
  if (!importId || !UUID.test(importId)) return;

  await discardImport(supabase, importId);

  revalidatePath(RESUME_ROUTE);
  redirect(RESUME_ROUTE);
}

/* ------------------------------------------------------- review and confirm */

/**
 * Rebuild the draft from what the review form actually shows.
 *
 * The form is the authority, not the stored extraction: whatever the person
 * corrected is what gets confirmed, and any entry they unticked is simply
 * absent from the result. Rebuilding rather than patching means an entry cannot
 * survive being deselected because of a missed index.
 *
 * The rebuilt object goes back through the Zod schema before it is used, so a
 * hand-crafted POST is held to exactly the same constraints as the model's
 * output — which are the database's constraints.
 */
function draftFromForm(form: FormData): ResumeExtraction | null {
  const str = (name: string) => text(form, name);
  const included = (prefix: string, i: number) => form.get(`${prefix}.${i}.include`) === 'on';
  const count = (name: string) => {
    const n = Number(text(form, name) ?? '0');
    return Number.isInteger(n) && n >= 0 && n <= 200 ? n : 0;
  };

  const experiences = [];
  for (let i = 0; i < count('experience_count'); i++) {
    if (!included('exp', i)) continue;
    const company = str(`exp.${i}.company_name`);
    const title = str(`exp.${i}.job_title`);
    if (!company || !title) continue;

    const isCurrent = form.get(`exp.${i}.is_current`) === 'on';
    experiences.push({
      company_name: company,
      job_title: title,
      employment_type: str(`exp.${i}.employment_type`),
      work_mode: str(`exp.${i}.work_mode`),
      location_city: str(`exp.${i}.location_city`),
      location_country_code: str(`exp.${i}.location_country_code`)?.toUpperCase() ?? null,
      start_date: str(`exp.${i}.start_date`),
      start_date_precision: str(`exp.${i}.start_date_precision`),
      end_date: isCurrent ? null : str(`exp.${i}.end_date`),
      end_date_precision: isCurrent ? null : str(`exp.${i}.end_date_precision`),
      is_current: isCurrent,
      description: str(`exp.${i}.description`),
    });
  }

  const education = [];
  for (let i = 0; i < count('education_count'); i++) {
    if (!included('edu', i)) continue;
    const institution = str(`edu.${i}.institution_name`);
    if (!institution) continue;

    const isCurrent = form.get(`edu.${i}.is_current`) === 'on';
    education.push({
      institution_name: institution,
      degree: str(`edu.${i}.degree`),
      field_of_study: str(`edu.${i}.field_of_study`),
      location_city: str(`edu.${i}.location_city`),
      location_country_code: str(`edu.${i}.location_country_code`)?.toUpperCase() ?? null,
      start_date: str(`edu.${i}.start_date`),
      start_date_precision: str(`edu.${i}.start_date_precision`),
      end_date: isCurrent ? null : str(`edu.${i}.end_date`),
      end_date_precision: isCurrent ? null : str(`edu.${i}.end_date_precision`),
      is_current: isCurrent,
      grade: str(`edu.${i}.grade`),
    });
  }

  const skillList = [];
  for (let i = 0; i < count('skill_count'); i++) {
    if (!included('skill', i)) continue;
    const name = str(`skill.${i}.name`);
    if (!name) continue;

    const years = str(`skill.${i}.years_experience`);
    skillList.push({
      name,
      proficiency: str(`skill.${i}.proficiency`),
      years_experience: years === null ? null : Number(years),
    });
  }

  return parseExtraction({
    legal_first_name: str('legal_first_name'),
    legal_middle_name: str('legal_middle_name'),
    legal_last_name: str('legal_last_name'),
    preferred_name: str('preferred_name'),
    contact_email: str('contact_email'),
    phone_e164: str('phone_e164'),
    city: str('city'),
    state_region: str('state_region'),
    country_code: str('country_code')?.toUpperCase() ?? null,
    linkedin_url: str('linkedin_url'),
    github_url: str('github_url'),
    portfolio_url: str('portfolio_url'),
    work_experiences: experiences,
    education_entries: education,
    skills: skillList,
    unreadable_sections: [],
  });
}

/**
 * The confirm step.
 *
 * This is the only place an import reaches the profile tables, and it happens
 * only here because a person pressed a button having seen every field. The
 * writes go through the candidate's own session and the ordinary data layer, so
 * they are subject to precisely the rules that govern the profile forms.
 */
export async function confirmResumeImport(_prev: FormState, form: FormData): Promise<FormState> {
  const { supabase, user } = await requireCandidate();

  const importId = text(form, 'import_id');
  if (!importId || !UUID.test(importId)) {
    return { ok: false, message: 'That import could not be identified.' };
  }

  // Read through the candidate's session: RLS is the ownership check, so an id
  // belonging to someone else simply does not resolve.
  const record = await getImport(supabase, importId);
  if (!record) return { ok: false, message: 'That import no longer exists.' };
  if (record.status !== 'parsed') {
    return { ok: false, message: 'That import has already been dealt with.' };
  }

  const draft = draftFromForm(form);
  if (!draft) {
    return {
      ok: false,
      message:
        'Some of those details could not be saved as they are — check the dates, ' +
        'the email address and the two-letter country codes.',
    };
  }

  // Persist the corrections before applying them, so a failure part-way through
  // leaves the reviewed version on the record rather than the model's original.
  await saveDraft(supabase, importId, draft);

  const outcome = await applyExtraction(supabase, user.id, draft);

  if (outcome.errors.length > 0 && outcome.experiencesAdded + outcome.educationAdded + outcome.skillsAdded === 0 && !outcome.profileUpdated) {
    return { ok: false, message: outcome.errors[0] };
  }

  // Only now — the claim "confirmed" is a claim about the profile tables, and
  // it is made by the code that just wrote them.
  await markConfirmed(createAdminClient(), importId);

  revalidatePath('/profile');
  revalidatePath(RESUME_ROUTE);

  const summary = describeOutcome(outcome);
  const failures = outcome.errors.length > 0 ? ` ${outcome.errors.length} entr${outcome.errors.length === 1 ? 'y' : 'ies'} could not be added; you can add ${outcome.errors.length === 1 ? 'it' : 'them'} by hand.` : '';

  redirect(`/profile?imported=${encodeURIComponent(summary + failures)}`);
}
