import 'server-only';

/**
 * "What do we know, what is unknown, what needs a human" — as data.
 *
 * This is the input an autonomous agent uses to decide whether it may proceed
 * or must stop and ask. It is deliberately machine-readable: a scheduler reads
 * `blockers` and `status` and never parses prose.
 *
 * The governing product rule is that absence means UNKNOWN. This module never
 * reports a fact as "no" because a row is missing; a missing row is reported as
 * missing, and the decision is escalated.
 */
import { ok, type Result } from './errors';
import { getCandidateSnapshot } from './operations';
import { isBlankOrInvisible } from './invisible';
import type { CandidateSnapshot, ProfileClient } from './types';

export type FactStatus =
  /** Recorded and usable. */
  | 'present'
  /** Never recorded. UNKNOWN — never "no". */
  | 'missing'
  /** Recorded but awaiting an explicit human decision. */
  | 'unverified';

export interface FactReport {
  /** Stable dotted identifier, e.g. `profile.legal_last_name`. Safe to branch on. */
  readonly key: string;
  readonly status: FactStatus;
  /**
   * True when an agent must not proceed on this fact without a human. Set for
   * anything missing-and-required, and for anything unverified or sensitive.
   */
  readonly blocksAutomation: boolean;
  /** Machine-readable reason. Not prose to parse — a fixed vocabulary. */
  readonly reason:
    | 'recorded'
    | 'never_recorded'
    | 'awaiting_human_verification'
    | 'sensitive_requires_approval'
    | 'work_authorization_unknown';
}

export interface CompletenessReport {
  readonly userId: string;
  readonly capturedAt: string;
  /**
   * `ready` — nothing blocks automation.
   * `needs_human` — at least one blocker; an agent must stop and ask.
   */
  readonly status: 'ready' | 'needs_human';
  readonly facts: readonly FactReport[];
  /** The subset of `facts` with `blocksAutomation`. Empty iff `status` is `ready`. */
  readonly blockers: readonly FactReport[];
  readonly counts: {
    readonly present: number;
    readonly missing: number;
    readonly unverified: number;
    readonly blockers: number;
  };
  /**
   * Countries with a recorded authorization. Any country NOT listed is UNKNOWN
   * for this candidate — the caller must ask, never assume "not authorized".
   */
  readonly knownWorkAuthorizationCountries: readonly string[];
  /** Question keys whose `requires_human_approval` is true. */
  readonly answersNeedingApproval: readonly string[];
}

/**
 * The minimum identity a job application always asks for.
 *
 * ASSUMPTION, stated because the schema does not settle it: every column in
 * `profiles` is nullable, so the database expresses no opinion about which
 * facts are required. This is the smallest defensible set — the fields
 * essentially every application form demands — rather than an invented product
 * policy. Everything else is reported as `present`/`missing` without blocking.
 * Widen this only as a deliberate product decision.
 */
const REQUIRED_PROFILE_FIELDS = [
  'legal_first_name', 'legal_last_name', 'contact_email',
] as const;

/** A text fact counts as present only if it holds a visible character. */
const hasValue = (value: unknown): boolean =>
  typeof value === 'string' ? !isBlankOrInvisible(value) : value !== null && value !== undefined;

/**
 * Builds the report from an already-fetched snapshot. Pure and deterministic:
 * same snapshot in, same report out, no clock and no I/O. `capturedAt` is
 * carried over from the snapshot rather than re-read.
 */
export function buildCompletenessReport(snapshot: CandidateSnapshot): CompletenessReport {
  const facts: FactReport[] = [];

  const add = (key: string, status: FactStatus, blocksAutomation: boolean, reason: FactReport['reason']) => {
    facts.push({ key, status, blocksAutomation, reason });
  };

  // --- identity -----------------------------------------------------------
  for (const field of REQUIRED_PROFILE_FIELDS) {
    const value = snapshot.profile ? (snapshot.profile as Record<string, unknown>)[field] : null;
    if (hasValue(value)) add(`profile.${field}`, 'present', false, 'recorded');
    else add(`profile.${field}`, 'missing', true, 'never_recorded');
  }

  // --- evidence the candidate can actually be described --------------------
  if (snapshot.workExperiences.length > 0) add('history.work_experiences', 'present', false, 'recorded');
  else add('history.work_experiences', 'missing', true, 'never_recorded');

  for (const [key, list] of [
    ['history.education_entries', snapshot.educationEntries],
    ['history.skills', snapshot.skills],
    ['history.certifications', snapshot.certifications],
    ['history.projects', snapshot.projects],
    ['history.languages', snapshot.languages],
  ] as const) {
    // Non-blocking: a candidate can legitimately have none of these.
    if (list.length > 0) add(key, 'present', false, 'recorded');
    else add(key, 'missing', false, 'never_recorded');
  }

  // --- preferences and automation -----------------------------------------
  if (snapshot.jobPreferences) add('job_preferences', 'present', false, 'recorded');
  else add('job_preferences', 'missing', true, 'never_recorded');

  if (snapshot.automationSettings) add('automation_settings', 'present', false, 'recorded');
  else add('automation_settings', 'missing', false, 'never_recorded');

  // --- work authorization: the strictest rule ------------------------------
  // A missing row is UNKNOWN, and unknown authorization always blocks. It is
  // never downgraded to "not authorized", which would be a fabricated fact.
  const countries = snapshot.workAuthorizations.map((row) => row.country_code);
  if (countries.length === 0) {
    add('work_authorization', 'missing', true, 'work_authorization_unknown');
  } else {
    for (const row of snapshot.workAuthorizations) {
      // Recorded but never confirmed by a human still needs confirmation
      // before it is used in a legal attestation.
      if (row.verified_at) add(`work_authorization.${row.country_code}`, 'present', false, 'recorded');
      else add(`work_authorization.${row.country_code}`, 'unverified', true, 'awaiting_human_verification');
    }
  }

  // --- stored answers ------------------------------------------------------
  const answersNeedingApproval: string[] = [];
  for (const answer of snapshot.verifiedAnswers) {
    const key = `answer.${answer.question_key}`;
    if (answer.requires_human_approval) {
      answersNeedingApproval.push(answer.question_key);
      add(
        key,
        answer.is_verified ? 'present' : 'unverified',
        true,
        answer.sensitivity === 'normal' ? 'awaiting_human_verification' : 'sensitive_requires_approval',
      );
    } else {
      add(key, 'present', false, 'recorded');
    }
  }

  const blockers = facts.filter((f) => f.blocksAutomation);
  return {
    userId: snapshot.userId,
    capturedAt: snapshot.capturedAt,
    status: blockers.length === 0 ? 'ready' : 'needs_human',
    facts,
    blockers,
    counts: {
      present: facts.filter((f) => f.status === 'present').length,
      missing: facts.filter((f) => f.status === 'missing').length,
      unverified: facts.filter((f) => f.status === 'unverified').length,
      blockers: blockers.length,
    },
    knownWorkAuthorizationCountries: countries,
    answersNeedingApproval,
  };
}

/** Fetches a snapshot and reports on it. */
export async function getCompletenessReport(
  client: ProfileClient, userId: string,
): Promise<Result<CompletenessReport>> {
  const snapshot = await getCandidateSnapshot(client, userId);
  if (!snapshot.ok) return snapshot;
  return ok(buildCompletenessReport(snapshot.data));
}
