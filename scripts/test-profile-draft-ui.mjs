/**
 * The candidate-facing résumé and profile-draft screens, offline.
 *
 *   npm run test:draft:ui
 *
 * WHAT THIS IS FOR
 *
 * Milestone 2E proved that a model cannot express an invented employer and
 * cannot carry a value the résumé does not contain. This suite proves the other
 * half: that the SCREENS in front of that contract behave — that a file is
 * screened before anything is spent on it, that no box is ticked on the
 * candidate's behalf when ticking it would lose something, that a rejection
 * accepts nothing, that a stale draft is refused, that every way a worker can
 * be unavailable is named rather than collapsed into "something went wrong",
 * and that not one of those paths reaches for a hosted provider instead.
 *
 * Everything here is exercised as FUNCTIONS from the modules the components
 * import — `lib/resume/upload.ts`, `lib/profile/review.ts`,
 * `lib/profile/confirm.ts` — not by reading JSX. Where a property is genuinely
 * about a file rather than a function (a page's gate, a component's markup) the
 * check reads the source, with comments stripped first: this repository has
 * been caught three times by a scan that matched the comment EXPLAINING the
 * property rather than the property.
 *
 * RLS, leases and the confirmation route against real Postgres are proved in
 * scripts/test-worker-db-boundary.mjs. Nothing here talks to a database, a
 * provider, or a real Claude.
 *
 * FIXTURES ARE SYNTHETIC. No real person, employer, résumé or contact detail
 * appears in this file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

let passed = 0;
let failed = 0;
const section = (s) => console.log(`\n=== ${s} ===`);
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

const U = await import('../lib/resume/upload.ts');
const R = await import('../lib/profile/review.ts');
const C = await import('../lib/profile/confirm.ts');
const D = await import('../lib/profile/draft.ts');
const P = await import('../lib/resume/paths.ts');

const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

/**
 * Source with comments removed.
 *
 * Three separate checks in this repository have passed on the comment that
 * explained the property rather than on the property. Stripping first is the
 * fix, and it is applied to every source scan below.
 */
const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ------------------------------------------------------------- fixtures */

/** A fictional candidate. No real person, employer or contact detail. */
const FACTS = {
  legal_first_name: 'Ada',
  legal_middle_name: null,
  legal_last_name: 'Verity',
  preferred_name: null,
  contact_email: 'ada@example.test',
  phone_e164: '+6591234567',
  city: 'Singapore',
  state_region: null,
  country_code: 'SG',
  linkedin_url: 'https://www.linkedin.com/in/ada-verity',
  github_url: null,
  portfolio_url: null,
  work_experiences: [],
  education_entries: [],
  skills: [],
  unreadable_sections: [],
};

/**
 * The profile snapshot a task carries.
 *
 * ALL TWELVE KEYS, ALWAYS. `DraftTaskInput.current` is a `z.record` over the
 * field enum, which in Zod 4 requires every member — a partial snapshot is not
 * a valid input, and the request route builds it from `PROFILE_DRAFT_FIELDS`
 * for exactly that reason.
 */
const snapshot = (overrides = {}) =>
  Object.fromEntries(D.PROFILE_DRAFT_FIELDS.map((f) => [f, overrides[f] ?? null]));

/** Build one proposal. `requires_confirmation` is a property of the FIELD. */
const proposal = (field, value, extra = {}) => ({
  field,
  value,
  source_facts: value === null ? [] : [field],
  requires_confirmation: D.EXPLICIT_CONFIRMATION_FIELDS.includes(field),
  warnings: [],
  ...extra,
});

const draftOf = (fields, warnings = []) => ({
  schema_version: D.PROFILE_DRAFT_SCHEMA_VERSION,
  fields,
  warnings,
});

const DRAFT_ID = '11111111-2222-4333-8444-555555555555';

/* ==================================================================== */
section('1. A chosen file is screened before anything is spent on it');

{
  const pdf = { name: 'resume.pdf', type: 'application/pdf', size: 4096 };
  check('an ordinary PDF is accepted', U.screenResumeFile(pdf).ok);

  const wrongType = U.screenResumeFile({
    name: 'resume.docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 4096,
  });
  check('a .docx is refused', wrongType.ok === false && wrongType.reason === 'wrong_type');

  const noExtension = U.screenResumeFile({ name: 'resume', type: 'text/plain', size: 10 });
  check('a text file with no extension is refused',
    noExtension.ok === false && noExtension.reason === 'wrong_type');

  /*
   * A PDF WHOSE TYPE THE BROWSER DID NOT WORK OUT IS STILL A PDF.
   *
   * Some browsers and operating systems hand over an empty `type`. Refusing
   * those would turn a platform quirk into "KIASA cannot read my résumé", and
   * the bucket's own MIME rule still stands behind this.
   */
  check('a PDF with no reported MIME type is accepted on its name',
    U.screenResumeFile({ name: 'Resume.PDF', type: '', size: 4096 }).ok,
    'the bucket enforces the real rule');

  const empty = U.screenResumeFile({ name: 'resume.pdf', type: 'application/pdf', size: 0 });
  check('an empty file is refused', empty.ok === false && empty.reason === 'empty');
  check('  and is not called "too large"', empty.reason !== 'too_large',
    'an empty file is a different mistake and gets its own sentence');

  const oversize = U.screenResumeFile({
    name: 'scan.pdf', type: 'application/pdf', size: P.RESUME_MAX_BYTES + 1,
  });
  check('one byte over the ceiling is refused',
    oversize.ok === false && oversize.reason === 'too_large');
  check('  and exactly the ceiling is accepted',
    U.screenResumeFile({
      name: 'scan.pdf', type: 'application/pdf', size: P.RESUME_MAX_BYTES,
    }).ok,
    'the boundary is inclusive, matching the bucket');

  check('every rejection has a sentence a person can act on',
    ['wrong_type', 'empty', 'too_large'].every(
      (r) => typeof U.FILE_REJECTION_TEXT[r] === 'string' && U.FILE_REJECTION_TEXT[r].length > 10));
  check('  and none of them names a bucket, a policy or an error code',
    !Object.values(U.FILE_REJECTION_TEXT).some(
      (t) => /bucket|rls|policy|postgres|supabase|storage|error code/i.test(t)));
}

/* ==================================================================== */
section('2. The upload component uses that screen, and accepts only PDFs');

{
  const code = stripComments(read('components', 'resume', 'ResumeUpload.tsx'));
  check('it calls the shared screen rather than repeating the rules',
    /screenResumeFile\(file\)/.test(code));
  check('  and holds no size or type comparison of its own',
    !/file\.size\s*[<>=]/.test(code) && !/file\.type\s*[!=]==/.test(code),
    'one copy of a rule is one place for it to be wrong');
  check('the file input accepts only PDFs',
    /accept="application\/pdf,\.pdf"/.test(code));
  check('the control is disabled while busy', /disabled=\{busy\}/.test(code));
  check('a failure is announced, not just coloured', /role="alert"/.test(code));
  check('the reading stage says nothing is saved yet',
    /Nothing is added to your profile yet/.test(code));
}

/* ==================================================================== */
section('3. No box is ticked for the candidate if ticking it could lose something');

{
  const empty = {};
  check('a field the résumé answered, empty on the profile, starts ticked',
    R.startsTicked(proposal('city', 'Singapore'), null) === true);

  check('a field that already has a value starts UNTICKED',
    R.startsTicked(proposal('city', 'Singapore'), 'Jakarta') === false,
    'replacing what someone wrote is a decision, not a default');

  check('  and an empty string counts as empty, not as a value',
    R.startsTicked(proposal('city', 'Singapore'), '') === true);

  for (const field of D.EXPLICIT_CONFIRMATION_FIELDS) {
    check(`  "${field}" starts unticked even on an empty profile`,
      R.startsTicked(proposal(field, 'anything'), null) === false,
      'identity is never accepted by default');
  }

  check('a proposal carrying a warning starts unticked',
    R.startsTicked(proposal('city', 'Singapore', { warnings: ['This looked ambiguous.'] }), null)
      === false,
    'a warning is the model saying it is unsure, which is exactly a thing to read');

  check('an unknown value is never ticked',
    R.startsTicked(proposal('city', null), null) === false);

  const draft = draftOf([
    proposal('city', 'Singapore'),
    proposal('country_code', 'SG'),
    proposal('legal_first_name', 'Ada'),
    proposal('state_region', null),
  ]);
  const initial = R.initialDecisions(draft, empty);
  check('on a blank profile only the non-identity answered fields start ticked',
    Object.entries(initial).filter(([, d]) => d.accepted).map(([f]) => f).join(',') === 'city',
    Object.entries(initial).filter(([, d]) => d.accepted).map(([f]) => f).join(',') || 'none');
  check('  and no decision starts with an edit',
    Object.values(initial).every((d) => d.edited === null));

  check('every field this screen can show has a human label',
    R.ALL_DRAFT_FIELDS.every((f) => typeof R.FIELD_LABEL[f] === 'string' && R.FIELD_LABEL[f]));
  check('  and no label is the column name',
    R.ALL_DRAFT_FIELDS.every((f) => R.FIELD_LABEL[f] !== f));
}

/* ==================================================================== */
section('4. What the review screen sends, and what it refuses to send');

{
  const draft = draftOf([
    proposal('city', 'Singapore'),
    proposal('country_code', 'SG'),
    proposal('state_region', null),
  ]);

  const none = R.buildConfirmBody(DRAFT_ID, draft, {}, 'confirm');
  check('nothing ticked sends an empty accept list', none.accept.length === 0);

  const ticked = {
    city: { accepted: true, edited: null },
    country_code: { accepted: false, edited: null },
  };
  const one = R.buildConfirmBody(DRAFT_ID, draft, ticked, 'confirm');
  check('only ticked fields are sent',
    one.accept.length === 1 && one.accept[0].field === 'city');
  check('  and an untouched proposal is sent as a bare field name',
    one.accept[0].edited_value === undefined,
    'the server writes what IT validated, not what a browser echoed back');

  const edited = R.buildConfirmBody(DRAFT_ID, draft,
    { city: { accepted: true, edited: 'Singapore City' } }, 'confirm');
  check('an edit travels as edited_value', edited.accept[0].edited_value === 'Singapore City');

  const sameText = R.buildConfirmBody(DRAFT_ID, draft,
    { city: { accepted: true, edited: 'Singapore' } }, 'confirm');
  check('  but typing the same text back does not become an "edit"',
    sameText.accept[0].edited_value === undefined,
    'clicking into a box and out again is not a candidate rewriting a value');

  const unknownTicked = R.buildConfirmBody(DRAFT_ID, draft,
    { state_region: { accepted: true, edited: null } }, 'confirm');
  check('a field the résumé did not answer is never sent, even if ticked',
    unknownTicked.accept.length === 0,
    'there is nothing there to accept');

  /*
   * A REJECTION ACCEPTS NOTHING. `ConfirmRequest` refuses a rejection carrying
   * accepted fields, so a body built any other way could only ever be refused.
   */
  const rejection = R.buildConfirmBody(DRAFT_ID, draft,
    { city: { accepted: true, edited: 'Singapore City' } }, 'reject');
  check('a rejection accepts nothing, whatever was ticked',
    rejection.action === 'reject' && rejection.accept.length === 0);
  check('  and the schema agrees that is the only valid shape',
    C.ConfirmRequest.safeParse(rejection).success &&
      C.ConfirmRequest.safeParse({ ...rejection, accept: [{ field: 'city' }] }).success === false);

  check('every body this screen builds satisfies the route schema',
    [none, one, edited, sameText, unknownTicked, rejection]
      .every((b) => C.ConfirmRequest.safeParse(b).success));
}

/* ==================================================================== */
section('5. Nothing is written before confirmation, and stale drafts are refused');

{
  const now = new Date('2026-09-10T12:00:00.000Z');
  const version = '2026-09-01T00:00:00.000Z';
  const stored = {
    id: DRAFT_ID,
    user_id: 'a',
    status: 'drafted',
    profile_version: version,
    expires_at: '2026-09-17T00:00:00.000Z',
    input: { schema_version: D.PROFILE_DRAFT_SCHEMA_VERSION, facts: FACTS, current: snapshot() },
    result: draftOf([
      proposal('city', 'Singapore'),
      proposal('country_code', 'SG'),
      proposal('contact_email', 'ada@example.test'),
    ]),
  };

  const confirmNothing = C.planConfirmation(
    stored, { draft_id: DRAFT_ID, action: 'confirm', accept: [] }, version, now);
  check('confirming with nothing accepted writes nothing',
    confirmNothing.ok === false && confirmNothing.reason === 'nothing_accepted');

  const rejected = C.planConfirmation(
    stored, { draft_id: DRAFT_ID, action: 'reject', accept: [] }, version, now);
  check('a rejection produces no writes at all',
    rejected.ok === true && rejected.action === 'reject' && rejected.writes === undefined);

  const accepted = C.planConfirmation(
    stored, { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city' }] }, version, now);
  check('an accepted field produces exactly one write',
    accepted.ok === true && Object.keys(accepted.writes).join(',') === 'city');
  check('  and an unaccepted field is not in it',
    accepted.ok === true && accepted.writes.contact_email === undefined,
    'existing values are unchanged unless explicitly accepted');

  /* STALENESS. */
  const stale = C.planConfirmation(
    stored, { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city' }] },
    '2026-09-09T00:00:00.000Z', now);
  check('a draft written against an older profile is refused',
    stale.ok === false && stale.reason === 'profile_changed',
    'applying it would put older proposals over newer work');

  const expired = C.planConfirmation(
    { ...stored, expires_at: '2026-09-01T00:00:00.000Z' },
    { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city' }] }, version, now);
  check('an expired draft is refused', expired.ok === false && expired.reason === 'draft_expired');

  const pending = C.planConfirmation(
    { ...stored, status: 'pending', result: null },
    { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city' }] }, version, now);
  check('a draft the worker has not answered yet is refused',
    pending.ok === false && pending.reason === 'draft_not_ready');

  /* IDEMPOTENCY. */
  const again = C.planConfirmation(
    { ...stored, status: 'confirmed' },
    { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city' }] }, version, now);
  check('confirming an already-confirmed draft writes nothing a second time',
    again.ok === true && Object.keys(again.writes).length === 0,
    'a refresh, a double click and a retried request all land here');
  const rejectedTwice = C.planConfirmation(
    { ...stored, status: 'rejected' },
    { draft_id: DRAFT_ID, action: 'reject', accept: [] }, version, now);
  check('  and re-rejecting is the same answer again, not an error',
    rejectedTwice.ok === true && rejectedTwice.action === 'reject');

  /* FABRICATION, ONCE MORE, AT THE LAST GATE. */
  const invented = C.planConfirmation(
    { ...stored, result: draftOf([{ ...proposal('city', 'Atlantis'), source_facts: ['city'] }]) },
    { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city' }] }, version, now);
  check('a value the stored facts do not support is refused at confirmation',
    invented.ok === false && invented.reason === 'unsupported_claim');

  const notProposed = C.planConfirmation(
    stored,
    { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'github_url' }] }, version, now);
  check('accepting a field the draft never proposed is refused',
    notProposed.ok === false && notProposed.reason === 'unsupported_claim',
    'a review screen is not a second profile form');

  const longEdit = C.planConfirmation(
    stored,
    { draft_id: DRAFT_ID, action: 'confirm',
      accept: [{ field: 'country_code', edited_value: 'SGP' }] },
    version, now);
  check('a candidate edit that will not fit its column is refused',
    longEdit.ok === false && longEdit.reason === 'value_too_long',
    'a person may correct a proposal, but not past what the column holds');

  const goodEdit = C.planConfirmation(
    stored,
    { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city', edited_value: 'Jakarta' }] },
    version, now);
  check('  while an edit the facts never mentioned IS accepted',
    goodEdit.ok === true && goodEdit.writes.city === 'Jakarta',
    'the candidate is the source for their own corrections; no fact has to support them');

  const clearedEdit = C.planConfirmation(
    stored,
    { draft_id: DRAFT_ID, action: 'confirm', accept: [{ field: 'city', edited_value: null }] },
    version, now);
  check('  and a candidate may deliberately blank a field they accepted',
    clearedEdit.ok === true && clearedEdit.writes.city === null,
    '"leave this unknown" is a real answer, not an absence');
}

/* ==================================================================== */
section('6. Every way a worker can be unavailable is named');

{
  const online = { status: 'online', slot_readiness: 'ready', pause_reason: null, stop_reason: null };

  check('a running, ready worker may be asked', R.describeWorker(online).ready === true);
  check('  and it is not told to go to the worker page for no reason',
    R.describeWorker(online).offerWorkerPage === false);

  const busy = R.describeWorker({ ...online, slot_readiness: 'working' });
  check('a worker busy with something else may still be asked', busy.ready === true);

  for (const [status, note] of [
    ['not_paired', 'there is no worker to ask'],
    ['stale', 'a closed laptop is not a failure, and is not a revocation'],
    ['revoked', 'said as itself, not as "offline"'],
    ['expired', 'distinct from revoked, because the fix is different'],
  ]) {
    const s = R.describeWorker({ ...online, status });
    check(`"${status}" refuses the request`, s.ready === false, note);
    check(`  and says what to do about it`,
      s.headline.length > 10 && s.detail.length > 10 && s.offerWorkerPage === true);
  }

  const noStatus = R.describeWorker(null);
  check('a status KIASA could not validate fails CLOSED',
    noStatus.ready === false,
    'no request is sent from a state that cannot be described');
  check('  and it does not blame the candidate’s computer',
    /cannot tell/i.test(noStatus.headline));

  for (const readiness of ['paused', 'stopping', 'stopped', 'crashed', 'initializing']) {
    const s = R.describeWorker({ ...online, slot_readiness: readiness });
    check(`an online worker that is "${readiness}" cannot be asked`, s.ready === false);
  }

  check('a readiness that has never been reported cannot be asked',
    R.describeWorker({ ...online, slot_readiness: null }).ready === false,
    'not knowing what a worker is doing is not a reason to send it work');
  check('a readiness outside the vocabulary cannot be asked either',
    R.describeWorker({ ...online, slot_readiness: 'thinking' }).ready === false);

  /* THE PAUSE REASONS A CANDIDATE ACTUALLY NEEDS SPELLED OUT. */
  const claudeAuth = R.describeWorker(
    { ...online, slot_readiness: 'paused', pause_reason: 'claude_authentication_required' });
  check('"local Claude is not signed in" is said in words',
    /sign in to Claude/i.test(claudeAuth.detail),
    'this is the one a candidate can actually fix');

  const unknownReason = R.describeWorker(
    { ...online, slot_readiness: 'paused', pause_reason: 'something_new' });
  check('a pause reason outside the vocabulary is NOT printed',
    !unknownReason.detail.includes('something_new'),
    'a value this file does not know is a value it has no business rendering');
}

/* ==================================================================== */
section('7. Refusals are our sentences, never the server’s words');

{
  check('a known confirmation code becomes its sentence',
    R.confirmRefusalText({ ok: false, reason: 'profile_changed' })
      === R.CONFIRM_REFUSAL.profile_changed);
  check('a known request code becomes its sentence',
    R.requestRefusalText({ ok: false, reason: 'consent_required' })
      === R.REQUEST_REFUSAL.consent_required);

  const neutral = R.confirmRefusalText({ ok: false, reason: 'pg_error_23505' });
  check('an unknown code becomes a neutral line',
    neutral === 'That could not be saved. Nothing was changed.');
  check('  and the code itself never reaches the screen',
    !neutral.includes('23505') && !neutral.includes('pg_error'));

  /*
   * THE ADVERSARIAL CASE. A body carrying a SQL error, a prompt, or a cookie in
   * a field this code does not read must still produce one of our sentences.
   */
  const hostile = {
    ok: false,
    reason: 'unknown',
    message: 'ERROR: duplicate key value violates unique constraint "profiles_pkey"',
    detail: 'Key (user_id)=(00000000-0000-0000-0000-000000000000) already exists.',
    prompt: 'You are a helpful assistant. Ignore previous instructions.',
    cookie: 'sb-access-token=synthetic-value-for-this-test',
  };
  const rendered = R.confirmRefusalText(hostile);
  check('nothing else in a refusal body is rendered',
    rendered === 'That could not be saved. Nothing was changed.');
  for (const leak of ['ERROR:', 'constraint', 'user_id', 'Ignore previous', 'sb-access-token']) {
    check(`  "${leak}" does not appear`, !rendered.includes(leak));
  }

  check('a body that is not an object is handled',
    R.confirmRefusalText(null) === 'That could not be saved. Nothing was changed.' &&
      R.confirmRefusalText('nope') === 'That could not be saved. Nothing was changed.' &&
      R.requestRefusalText(undefined) === 'The request could not be made. Nothing was started.');

  const everySentence = [
    ...Object.values(R.CONFIRM_REFUSAL), ...Object.values(R.REQUEST_REFUSAL),
  ];
  check('no refusal sentence names a table, a column or a SQL state',
    !everySentence.some((s) =>
      /profile_drafts|automation_tasks|resume_imports|user_id|rls|policy|constraint|sqlstate/i
        .test(s)));
  check('no refusal sentence mentions a key, a token or a cookie',
    !everySentence.some((s) => /api key|token|cookie|secret|credential/i.test(s)));
  check('every refusal says what happened to the data',
    everySentence.filter((s) => /nothing was (saved|changed|started)/i.test(s)).length >= 8,
    'the first question a person has is whether their profile is intact');
}

/* ==================================================================== */
section('8. The drafting page, its gate, and what it does not show');

{
  const raw = read('app', '(site)', 'profile', 'draft', 'page.tsx');
  const code = stripComments(raw);

  check('it requires a candidate session', /requireCandidate\(\)/.test(code));
  check('it is dynamic, never cached', /export const dynamic = 'force-dynamic'/.test(code));
  check('it is not indexed', /robots: \{ index: false/.test(code));

  /*
   * THE GATE, STATED AS A PROPERTY OF THE CODE.
   *
   * Drafting runs on the candidate's own machine and has no provider call in
   * it, so this page is deliberately NOT gated on the hosted provider's key.
   * Adding that gate would tie a local feature to a remote one and would imply
   * a fallback that must not exist.
   */
  check('the page is gated on having résumé facts', /hasResumeFacts\(supabase\)/.test(code));
  check('  and NOT on the hosted provider being configured',
    !/isResumeParsingConfigured|isOpenRouterConfigured|providerConfig/.test(code),
    'drafting never calls a provider, so a provider key cannot be its gate');
  check('the whole page holds no provider reference at all',
    !/openrouter\.ai|from '[^']*openrouter|OPENROUTER_API_KEY|ANTHROPIC_API_KEY/.test(code));

  check('a request that has not been answered is distinguished from one that failed',
    /taskStatus === 'failed'/.test(code) && /taskStatus === 'processing'/.test(code),
    'a single spinner would hide the difference');
  check('a draft that will not parse is shown as unusable, not rendered',
    /active\.draft === null/.test(code));
  check('a stale profile version is said BEFORE the button is pressed',
    /active\.profile_version !== profile\.updated_at/.test(code));

  /*
   * IDENTIFIERS ARE PASSED, NOT PRINTED.
   *
   * The draft id has to reach the review component — it is what the
   * confirmation route is called with. What must not happen is any of these
   * ending up as text on the page, because an identifier on a screen is an
   * identifier in a screenshot. So: the id appears exactly once, as a prop, and
   * the task status and correlation id appear nowhere renderable.
   */
  check('the draft id appears only as a prop, never as text',
    (code.match(/active\.id/g) || []).length === 1 && /draftId=\{active\.id\}/.test(code));
  check('the task status is used as a branch, never printed',
    /taskStatus=\{active\.task_status\}/.test(code) && !/>\s*\{taskStatus\}/.test(code));
  check('no correlation id is anywhere near this page', !/correlation/i.test(code));
}

/* ==================================================================== */
section('9. The review screen writes nothing, and says so');

{
  const code = stripComments(read('components', 'profile', 'DraftReview.tsx'));

  check('the only network call is the confirmation route',
    (code.match(/fetch\(/g) || []).length === 1 &&
      /fetch\('\/api\/profile\/draft\/confirm'/.test(code));
  check('  and it is the only place an action is decided',
    /buildConfirmBody\(draftId, draft, decisions, action\)/.test(code));
  check('there is no server action, so no form can post on its own',
    !/useActionState|action=\{/.test(code));

  check('the reject control is always available',
    /disabled=\{busy !== null\}/.test(code),
    'a person must be able to say no without first ticking something');
  check('the save control is unavailable while nothing is ticked',
    /acceptedCount === 0/.test(code));

  check('it tells the candidate nothing is saved yet',
    /Nothing is\s+saved until you press/.test(code.replace(/\s+/g, ' ')) ||
      /Nothing is saved until you press/.test(code.replace(/\s+/g, ' ')));
  check('it says what an unticked field means',
    /stays exactly as it is now/.test(code.replace(/\s+/g, ' ')));
  check('a field the résumé did not answer says so in words',
    /does not say, so this is left unknown/.test(code.replace(/\s+/g, ' ')));

  /*
   * PROVENANCE IS A PATH, AND THE RÉSUMÉ IS NOT IN SCOPE HERE.
   *
   * `source_facts` is a reference INTO the facts — `contact_email`,
   * `work_experiences[0].employer` — which the draft schema's regex admits and
   * a quotation does not. This component never receives the facts themselves,
   * so there is no résumé prose available to render even by mistake.
   */
  check('provenance is rendered from the cited paths', /source_facts\.map/.test(code));
  check('  and the résumé itself is never handed to this component',
    !/ResumeExtraction|resume\/schema|\bextracted\b|\bfacts\b\s*[:=]/.test(code),
    'there is no résumé text here to leak');
}

/* ==================================================================== */
section('10. The request screen, consent, and the absent fallback');

{
  const code = stripComments(read('components', 'profile', 'DraftRequest.tsx'));

  check('the button is unavailable until consent is ticked', /!consented/.test(code));
  check('  and until the worker can actually take the work',
    /!situation\.ready/.test(code));
  check('consent is stated in the request that uses it',
    /local_consent: true/.test(code));
  check('the mode is the local one, named explicitly',
    /mode: 'claude_max_assisted'/.test(code));

  /*
   * A HOST AND AN IMPORT, NOT A WORD. The résumé suite has twice been fooled by
   * a check for "openrouter" matching the sentence that PROMISES there is no
   * OpenRouter path. Comments are stripped above; this matches the things that
   * would actually constitute a fallback.
   */
  check('there is no second provider to fall back to',
    !/openrouter\.ai|from '[^']*openrouter|OPENROUTER_|ANTHROPIC_|api\.anthropic\.com/.test(code));
  check('  and no branch retries anywhere else on failure',
    !/fetch\('\/api\/(resume|ai|gateway)/.test(code));
  check('the only network calls are the draft route and the status it was given',
    (code.match(/fetch\(/g) || []).length === 1 &&
      /fetch\('\/api\/profile\/draft'/.test(code));

  check('the honest alternative is offered rather than hidden',
    /shortcut, not a requirement/.test(code.replace(/\s+/g, ' ')));
}

/* ==================================================================== */
section('11. Re-importing and re-drafting are additive, and idempotent');

{
  const draftRoute = stripComments(read('app', 'api', 'profile', 'draft', 'route.ts'));

  check('a second request for the same résumé and profile collides on a key',
    /idempotency_key: idempotencyKey/.test(draftRoute) &&
      /profile-draft:\$\{latest\.id\}:\$\{Date\.parse\(profile\.updated_at\)\}/.test(draftRoute),
    'asking twice produces one task, not two worker runs');
  check('  and the collision is reported as already-requested, not as a failure',
    /return refuse\('already_requested', 409\)/.test(draftRoute));

  check('the task carries no job, because a profile draft has no posting',
    /job_id: null/.test(draftRoute));
  check('  and is born with the profile-drafting kind',
    /kind: 'candidate_profile_drafting'/.test(draftRoute));

  check('the request route writes nothing to a profile table',
    !/from\('profiles'\)[\s\S]{0,200}\.(insert|update|upsert|delete)/.test(draftRoute),
    'it reads the profile for a version and a snapshot, and writes a task and a draft');

  const confirmRoute = stripComments(read('app', 'api', 'profile', 'draft', 'confirm', 'route.ts'));
  check('confirmation writes through the same upsert the profile forms use',
    /upsertProfile\(supabase, user\.id, plan\.writes\)/.test(confirmRoute),
    'every column constraint, policy and trigger applies exactly as it does by hand');
  check('  under the candidate’s own session, with no elevated client',
    !/createAdminClient|SUPABASE_SECRET_KEY|service_role/.test(confirmRoute));
  check('  and only when the plan says to write',
    /if \(fields\.length > 0\)/.test(confirmRoute));

  const resumePage = stripComments(read('app', '(site)', 'profile', 'resume', 'page.tsx'));
  check('the résumé page still promises that importing again removes nothing',
    /Importing again never removes anything/.test(resumePage.replace(/\s+/g, ' ')));
  check('  and now offers the drafting page as the next step',
    /PROFILE_DRAFT_ROUTE/.test(resumePage));
}

/* ==================================================================== */
section('12. One candidate cannot reach another’s imports or drafts');

{
  const drafts = stripComments(read('lib', 'profile', 'drafts.ts'));

  check('every read goes through the candidate’s own client',
    !/createAdminClient|SUPABASE_SECRET_KEY|service_role/.test(drafts),
    'RLS is the check, and there is no client here that could bypass it');
  check('no query filters on a user id supplied by anything',
    !/\.eq\('user_id'/.test(drafts),
    'ownership comes from the session, never from a parameter');

  const draftRoute = stripComments(read('app', 'api', 'profile', 'draft', 'route.ts'));
  const confirmRoute = stripComments(read('app', 'api', 'profile', 'draft', 'confirm', 'route.ts'));
  for (const [name, code] of [['request', draftRoute], ['confirm', confirmRoute]]) {
    check(`the ${name} route takes its user from the verified session`,
      /await supabase\.auth\.getUser\(\)/.test(code));
    check(`  and never from the request body`,
      !/body[\s\S]{0,40}user_id|payload\?\.user_id|parsed\.data\.user_id/.test(code));
  }
  check('the confirm route also compares ownership explicitly',
    /draft\.user_id !== user\.id/.test(confirmRoute),
    'a second layer, and the one that would catch a policy edited wrongly later');

  /*
   * The database half of this — that RLS actually returns nothing for another
   * candidate's row — is proved against real Postgres in
   * scripts/test-worker-db-boundary.mjs. What is proved here is that no code
   * path in front of it could reach past RLS even if it wanted to.
   */
}

/* ==================================================================== */
section('13. The résumé page keeps its own gate, and names it');

{
  const code = stripComments(read('app', '(site)', 'profile', 'resume', 'page.tsx'));

  check('the upload path is still gated',
    /const configured = isResumeParsingConfigured\(\) && isAdminConfigured\(\)/.test(code),
    'reading a PDF is a hosted model call and stays behind its key');
  check('the disabled path offers the manual route instead of a dead end',
    /not switched on yet/.test(code.replace(/\s+/g, ' ')) &&
      /fill in your profile by hand/.test(code.replace(/\s+/g, ' ')));
  check('the enabled path renders the upload control',
    /<ResumeUpload userId=\{user\.id\} action=\{startResumeImport\} \/>/.test(code));

  const actions = stripComments(read('lib', 'resume', 'actions.ts'));
  check('and the server refuses independently of what the page rendered',
    /if \(!isResumeParsingConfigured\(\) \|\| !isAdminConfigured\(\)\)/.test(actions),
    'a hidden button is not a control');
}

console.log(`\n${'='.repeat(56)}`);
if (failed === 0) {
  console.log(`ALL ${passed} PROFILE-DRAFT-UI CHECKS PASSED`);
  process.exit(0);
}
console.error(`${failed} FAILED of ${passed + failed}`);
process.exit(1);
