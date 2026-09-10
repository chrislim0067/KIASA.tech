import {
  EXPLICIT_CONFIRMATION_FIELDS,
  PROFILE_DRAFT_FIELDS,
  type FieldProposal,
  type ProfileDraft,
  type ProfileDraftField,
} from '@/lib/profile/draft';

/**
 * The decisions the review screen makes, without the screen.
 *
 * Everything here is pure, so the rules that matter — which boxes start
 * ticked, what a request body ends up containing, what a candidate is told when
 * something is refused — can be tested exhaustively instead of being asserted
 * about by reading JSX.
 *
 * Deliberately free of `server-only`: this runs in the browser, in the
 * components that import it.
 */

/* ----------------------------------------------------------------- labels */

/** Human labels for the twelve fields. Not derived — a label is a decision. */
export const FIELD_LABEL: Record<ProfileDraftField, string> = {
  legal_first_name: 'First name',
  legal_middle_name: 'Middle name',
  legal_last_name: 'Last name',
  preferred_name: 'Preferred name',
  contact_email: 'Contact email',
  phone_e164: 'Phone',
  city: 'City',
  state_region: 'State or region',
  country_code: 'Country',
  linkedin_url: 'LinkedIn',
  github_url: 'GitHub',
  portfolio_url: 'Portfolio',
};

export const requiresExplicitConfirmation = (field: ProfileDraftField): boolean =>
  EXPLICIT_CONFIRMATION_FIELDS.includes(field);

/* --------------------------------------------------------------- defaults */

/**
 * Does this proposal start ticked?
 *
 * `components/resume/ReviewForm.tsx` arrives with everything ticked, and it is
 * right to: those are facts read off the candidate's own document, being added
 * to an empty list. This screen is different in two ways that matter — the
 * values are a model's proposals rather than an extraction, and several of them
 * would REPLACE something the candidate has already written.
 *
 * So a box starts ticked only when accepting it cannot lose anything:
 *
 *   * the résumé actually answered it, and
 *   * the field is empty on the profile today, and
 *   * it is not identity — a legal name, an email address, a phone number or a
 *     country, which `EXPLICIT_CONFIRMATION_FIELDS` names, and
 *   * the proposal carries no warning of its own, because a warning is the
 *     model saying it is unsure and that is precisely a thing to read.
 *
 * Everything else starts unticked and has to be chosen. That is the difference
 * between a person agreeing to a value and a person not noticing it.
 */
export function startsTicked(
  proposal: FieldProposal,
  currentValue: string | null | undefined
): boolean {
  if (proposal.value === null) return false;
  if (requiresExplicitConfirmation(proposal.field)) return false;
  if (proposal.warnings.length > 0) return false;
  return (currentValue ?? '') === '';
}

/** What the candidate has decided about one proposal. */
export interface Decision {
  accepted: boolean;
  /** The candidate's own text. `null` means "exactly as proposed". */
  edited: string | null;
}

export function initialDecisions(
  draft: ProfileDraft,
  current: Partial<Record<ProfileDraftField, string | null>>
): Record<string, Decision> {
  return Object.fromEntries(
    draft.fields.map((proposal) => [
      proposal.field,
      { accepted: startsTicked(proposal, current[proposal.field]), edited: null },
    ])
  );
}

/* ---------------------------------------------------------------- the body */

export interface AcceptedField {
  field: ProfileDraftField;
  edited_value?: string;
}

export interface ConfirmBody {
  draft_id: string;
  action: 'confirm' | 'reject';
  accept: AcceptedField[];
}

/**
 * Turn the ticked boxes into the request the confirmation route expects.
 *
 * TWO PROPERTIES THIS FUNCTION EXISTS TO GUARANTEE:
 *
 *   * A REJECTION ACCEPTS NOTHING. `ConfirmRequest` refuses a rejection that
 *     carries accepted fields, so building one would be a request that could
 *     only ever be refused. The empty array is not defensive — it is the only
 *     correct value.
 *
 *   * AN UNTOUCHED PROPOSAL IS SENT AS A BARE FIELD NAME. The server then
 *     writes the value it validated against the stored résumé facts, rather
 *     than a value a browser echoed back at it. `edited_value` appears only
 *     when a person actually typed something different, and from that point it
 *     is treated as their own words rather than as something a model said.
 */
export function buildConfirmBody(
  draftId: string,
  draft: ProfileDraft,
  decisions: Record<string, Decision>,
  action: 'confirm' | 'reject'
): ConfirmBody {
  if (action === 'reject') return { draft_id: draftId, action, accept: [] };

  const accept: AcceptedField[] = [];
  for (const proposal of draft.fields) {
    const decision = decisions[proposal.field];
    if (!decision?.accepted) continue;
    // A field the résumé did not answer has nothing to accept, whatever the
    // local state says.
    if (proposal.value === null) continue;

    const edited = decision.edited;
    if (edited === null || edited === proposal.value) {
      accept.push({ field: proposal.field });
    } else {
      accept.push({ field: proposal.field, edited_value: edited });
    }
  }
  return { draft_id: draftId, action, accept };
}

/* ------------------------------------------------------------- refusals */

/**
 * What a candidate is told when the server says no.
 *
 * The server answers with a short code from a closed list. Each one gets a
 * sentence here, and anything unrecognised gets a neutral one. The code itself,
 * the HTTP status, and every other part of the response body stay off the
 * screen: a candidate has no use for `profile_write_failed`, and an error a
 * route did not intend to publish must not reach a page by default.
 */
export const CONFIRM_REFUSAL: Record<string, string> = {
  draft_not_found: 'That draft is no longer available. Ask for a new one.',
  draft_not_ready: 'That draft is not finished yet.',
  draft_expired: 'That draft has expired. Ask for a new one.',
  profile_changed:
    'Your profile changed after this draft was made, so none of it was applied. Ask for a new draft and it will be built from what your profile says now.',
  unsupported_claim: 'One of those values is not supported by your résumé, so nothing was saved.',
  value_too_long: 'One of those values is too long for the field it goes in.',
  nothing_accepted: 'Nothing was ticked, so nothing was saved.',
  profile_write_failed: 'Your profile could not be saved. Nothing was changed.',
  profile_missing: 'Fill in your profile once by hand before importing into it.',
  malformed_request: 'That request was not understood. Nothing was changed.',
  unauthenticated: 'Your session has ended. Sign in again and nothing will be lost.',
  unconfigured: 'This is not switched on yet. Nothing was changed.',
};

/** The same, for the route that asks a worker to start drafting. */
export const REQUEST_REFUSAL: Record<string, string> = {
  consent_required: 'Tick the box first — nothing runs on your computer without it.',
  mode_required: 'That request was not understood. Nothing was started.',
  no_resume_facts: 'Import a résumé first. There is nothing to draft from yet.',
  resume_facts_invalid:
    'Your imported résumé could not be read back. Importing it again usually fixes it.',
  profile_missing: 'Fill in your profile once by hand before drafting into it.',
  already_requested:
    'You have already asked for a draft of this résumé against this profile. It is on its way.',
  draft_not_created: 'The request could not be recorded. Nothing was started.',
  unauthenticated: 'Your session has ended. Sign in again and nothing will be lost.',
  unconfigured: 'This is not switched on yet.',
  malformed_request: 'That request was not understood. Nothing was started.',
};

const NEUTRAL_CONFIRM = 'That could not be saved. Nothing was changed.';
const NEUTRAL_REQUEST = 'The request could not be made. Nothing was started.';

/**
 * Read a refusal out of a response body without trusting it.
 *
 * The body is JSON from our own route, but the value that ends up on screen is
 * always one of OUR sentences, chosen by a lookup. A code this map does not
 * know produces the neutral line — never the code, never a message from the
 * body, and never anything a database or a model might have written.
 */
export function refusalText(
  payload: unknown,
  vocabulary: Record<string, string>,
  neutral: string
): string {
  const reason =
    payload !== null &&
    typeof payload === 'object' &&
    typeof (payload as { reason?: unknown }).reason === 'string'
      ? (payload as { reason: string }).reason
      : '';
  return vocabulary[reason] ?? neutral;
}

export const confirmRefusalText = (payload: unknown): string =>
  refusalText(payload, CONFIRM_REFUSAL, NEUTRAL_CONFIRM);

export const requestRefusalText = (payload: unknown): string =>
  refusalText(payload, REQUEST_REFUSAL, NEUTRAL_REQUEST);

/* --------------------------------------------------------- worker states */

/** Exactly the fields `GET /api/worker/status` returns that this screen reads. */
export interface WorkerSituationInput {
  status: 'not_paired' | 'online' | 'stale' | 'revoked' | 'expired';
  slot_readiness: string | null;
  pause_reason: string | null;
  stop_reason: string | null;
}

export interface Situation {
  tone: 'ok' | 'warn' | 'bad';
  headline: string;
  detail: string;
  /** Whether a draft may be requested from this state. */
  ready: boolean;
  /** Whether to offer the worker page — not useful when it is already fine. */
  offerWorkerPage: boolean;
}

/*
 * PAUSE AND STOP REASONS ARE VOCABULARY MEMBERS, NOT TEXT.
 *
 * The database constrains both columns to a closed list, and the status reader
 * validates them against that same list on the way out. So these are the only
 * values that can arrive, and each gets a phrase. An unrecognised one falls
 * through to a neutral line rather than being printed — a value this map does
 * not know is a value this screen has no business rendering.
 */
export const REASON_PHRASE: Record<string, string> = {
  employer_authentication_required: 'it is waiting for you to sign in to an employer site',
  claude_authentication_required:
    'it needs you to sign in to Claude on that computer before it can do this',
  captcha_detected: 'a site asked it to prove it is a person',
  anti_bot_challenge_detected: 'a site put a challenge in front of it',
  mfa_required: 'a site asked for a second factor only you can provide',
  sensitive_information_requested: 'a site asked for something it will not answer on your behalf',
  unknown_page: 'it reached a page it does not recognise',
  unknown_question: 'it was asked something you have not answered yet',
  unsupported_site: 'it reached a site it does not support',
  control_plane_paused: 'it was paused from here',
  candidate_requested: 'you asked it to stop',
  kill_switch: 'the stop switch was used',
  supervisor_shutdown: 'it was shut down',
  slot_crashed: 'it stopped unexpectedly',
  lease_lost: 'it lost its place in the queue',
  protocol_violation: 'it sent something unexpected and was stopped',
  update_required: 'it needs updating',
};

/**
 * What the candidate is told about their own worker, and whether they may ask.
 *
 * Every branch FAILS CLOSED. `ready` is true only for states where a worker
 * could plausibly pick the task up; anything KIASA cannot describe — including
 * a status object the outbound schema refused, which arrives here as `null` —
 * leaves the button unavailable rather than sending a request into the dark.
 *
 * And there is no branch that reaches for another provider. A candidate whose
 * laptop is asleep is told their laptop is asleep; their résumé does not get
 * sent to a hosted model instead because an error handler decided for them.
 */
export function describeWorker(worker: WorkerSituationInput | null): Situation {
  if (worker === null) {
    return {
      tone: 'warn',
      headline: 'KIASA cannot tell whether your worker is running.',
      detail:
        'Nothing has been requested. Reloading the page usually clears it, and everything here can still be typed by hand.',
      ready: false,
      offerWorkerPage: false,
    };
  }

  switch (worker.status) {
    case 'not_paired':
      return {
        tone: 'warn',
        headline: 'No worker is paired with this account.',
        detail:
          'Drafting runs on your own computer, so there has to be one. Pair it from the worker page first — it takes one code and about a minute.',
        ready: false,
        offerWorkerPage: true,
      };
    case 'revoked':
      return {
        tone: 'warn',
        headline: 'That worker was disconnected.',
        detail: 'Pair it again and it will pick this up.',
        ready: false,
        offerWorkerPage: true,
      };
    case 'expired':
      return {
        tone: 'warn',
        headline: 'That worker’s pairing has expired.',
        detail: 'Pair it again. Nothing on your profile is affected.',
        ready: false,
        offerWorkerPage: true,
      };
    case 'stale':
      return {
        tone: 'warn',
        headline: 'Your worker is paired but not running.',
        detail:
          'It has not checked in recently — a closed laptop or a stopped process is the usual cause. Start it and this page will let you ask.',
        ready: false,
        offerWorkerPage: true,
      };
    case 'online':
      break;
  }

  const reason = REASON_PHRASE[worker.pause_reason ?? worker.stop_reason ?? ''] ?? null;

  switch (worker.slot_readiness) {
    case 'paused':
      return {
        tone: 'warn',
        headline: 'Your worker is running but paused.',
        detail: reason
          ? `It is waiting because ${reason}. Clear that and it will carry on.`
          : 'It is waiting for you. Deal with whatever it is asking and it will carry on.',
        ready: false,
        offerWorkerPage: true,
      };
    case 'stopping':
    case 'stopped':
      return {
        tone: 'warn',
        headline: 'Your worker is shutting down.',
        detail: reason ? `It stopped because ${reason}.` : 'Start it again to ask for a draft.',
        ready: false,
        offerWorkerPage: true,
      };
    case 'crashed':
      return {
        tone: 'bad',
        headline: 'Your worker stopped unexpectedly.',
        detail: 'Start it again on that computer. Nothing on your profile was affected.',
        ready: false,
        offerWorkerPage: true,
      };
    case 'working':
      return {
        tone: 'ok',
        headline: 'Your worker is busy with something else.',
        detail: 'You can still ask — it will pick this up when it finishes.',
        ready: true,
        offerWorkerPage: false,
      };
    case 'initializing':
      return {
        tone: 'warn',
        headline: 'Your worker is still starting up.',
        detail: 'Give it a moment, then check again.',
        ready: false,
        offerWorkerPage: false,
      };
    case 'ready':
      return {
        tone: 'ok',
        headline: 'Your worker is running.',
        detail: 'It will pick this up within a few seconds of you asking.',
        ready: true,
        offerWorkerPage: false,
      };
    default:
      /*
       * A READINESS THIS FILE DOES NOT KNOW IS NOT A READINESS TO ACT ON.
       *
       * `slot_readiness` is null before a slot has ever reported, and could in
       * principle gain a member. Either way the honest answer is that KIASA
       * does not know what the worker is doing, and the honest response is to
       * not send it work.
       */
      return {
        tone: 'warn',
        headline: 'Your worker has not reported what it is doing yet.',
        detail: 'Give it a moment, then check again.',
        ready: false,
        offerWorkerPage: false,
      };
  }
}

/** Every field, so a test can walk the whole set rather than a sample. */
export const ALL_DRAFT_FIELDS = PROFILE_DRAFT_FIELDS;
