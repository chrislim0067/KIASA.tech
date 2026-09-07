/**
 * Public surface of the candidate-profile data-access layer.
 *
 * Every export takes an authenticated Supabase client and the `userId` returned
 * by `supabase.auth.getUser()`, and returns a `Result` rather than throwing.
 * A UI route handler and an agent runtime use this identically.
 *
 * Usage from a Server Component or Route Handler:
 *
 *   const supabase = await createClient();
 *   const { data: { user } } = await supabase.auth.getUser();
 *   if (!user) return;                       // getUser(), never getSession()
 *   await ensureProfile(supabase, user.id);
 *   const report = await getCompletenessReport(supabase, user.id);
 *   if (report.ok && report.data.status === 'needs_human') { ... }
 */
export {
  ensureProfile,
  getProfile, getJobPreferences, getAutomationSettings,
  listWorkAuthorizations, listWorkExperiences, listEducationEntries, listSkills,
  listCertifications, listProjects, listLanguages, listVerifiedAnswers,
  getCandidateSnapshot,
  upsertProfile, upsertJobPreferences, upsertAutomationSettings,
  workExperiences, educationEntries, skills, certifications, projects, languages,
  workAuthorizations,
  saveVerifiedAnswer, setAnswerVerification, setAnswerLock, recordAnswerUsage,
  deleteVerifiedAnswer,
} from './operations';

export { buildCompletenessReport, getCompletenessReport } from './completeness';
export type { CompletenessReport, FactReport, FactStatus } from './completeness';

export { isBlankOrInvisible, INVISIBLE_CODE_POINTS } from './invisible';
export { validateWrite, validateTextArray, validateOtherLinks } from './validation';
export type { ValidationIssue } from './validation';

export type { DataLayerError, ErrorCategory, PostgrestLikeError, Result } from './errors';
export { HUMAN_ESCALATION_CATEGORIES, RETRYABLE_CATEGORIES } from './errors';
/**
 * Exported so a caller that runs its own query can classify the failure the
 * same way the layer does, and so tests can feed it errors captured from a real
 * database rather than asserting against a hand-written fake.
 */
export { mapPostgrestError } from './errors';

export type {
  CandidateSnapshot, CreateInput, UpdateInput, OtherLink, ProfileClient, Row, TableName,
  ProfileRow, JobPreferencesRow, AutomationSettingsRow, WorkAuthorizationRow,
  WorkExperienceRow, EducationEntryRow, SkillRow, CertificationRow, ProjectRow,
  LanguageRow, VerifiedAnswerRow,
} from './types';

export {
  ALL_TABLES, SINGLETON_TABLES, COLLECTION_TABLES, NATURAL_KEYS,
  SENSITIVITIES, WORK_MODES, EMPLOYMENT_TYPES, SALARY_PERIODS, ANSWER_TYPES,
  ARRAY_LIMITS, TEXT_LIMITS, OTHER_LINKS_LIMITS, PATTERNS, COLLECTION_ORDER,
} from './schema';
