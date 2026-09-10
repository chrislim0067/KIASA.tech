import {
  routingTable,
  type AiCapability,
  type LocalClaudeAvailability,
} from '@/lib/agent/ai-mode';
import type { AutomationMode } from '@/lib/agent/contracts';
import { SAFE_BASELINE, evaluateSafety, type SafetyResult } from '@/lib/agent/safety';
import { canSlotSubmit } from '@/lib/agent/worker-state';
import type { AgentState } from '@/lib/agent/state-machine';
import type { SlotState, SupervisorLifecycle } from '@/lib/agent/contracts';
import { draftableFields, type ObservedField, type PageObservation } from '@/lib/worker/fixture';
import {
  outcomeRequiresHuman,
  type LocalClaudeOutcome,
  type LocalClaudeTransport,
} from '@/lib/local-claude/transport';

/**
 * ONE SLOT, ONE TASK, END TO END.
 *
 * Pure orchestration: every dependency is injected, nothing here opens a
 * socket or a browser, and the clock arrives as a parameter. That is what lets
 * the whole flow be asserted deterministically — including the paths that must
 * NOT happen.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER
 *
 *   1. observe        read the page into tri-states. Reporting, not judging.
 *   2. evaluate       lib/agent/safety.ts decides. FAILS CLOSED.
 *   3. stop or go     any stop reason ends it here. Nothing is typed.
 *   4. fill routine   only fields naming a VERIFIED fact.
 *   5. draft          only the free-text field, only via the routed
 *                     destination, and the result is validated before use.
 *   6. gate submit    four checks, and this fixture never actually submits.
 *
 * Safety is evaluated BEFORE anything is filled, not after. A worker that
 * fills first and checks later has already typed a candidate's email into a
 * login form by the time it notices.
 *
 * NOTHING IS EVER SUBMITTED TO A REAL EMPLOYER. `runSlice` reaches the submit
 * gate and reports its verdict; the act itself is not implemented, and the
 * fixture is a local file.
 */

export interface SliceInputs {
  mode: AutomationMode;
  availability: LocalClaudeAvailability;
  observation: PageObservation;
  /** Verified facts only. An unverified fact must never reach a form. */
  verifiedFacts: Readonly<Record<string, string>>;
  transport: LocalClaudeTransport;
  lifecycle: SupervisorLifecycle;
  slotState: SlotState;
  agentState: AgentState;
  lease: {
    lease: { slot_id: string; expires_at: string; fence_token: number } | null;
    current_fence_token: number;
    slot_id: string;
    now: Date;
  };
  /** Quota and limit context, passed through to the evaluator. */
  limits?: Partial<typeof SAFE_BASELINE>;
}

export interface FilledField {
  name: string;
  factKey: string;
  /** The value is present so a demo can show it; it came from a verified fact. */
  value: string;
}

export type SliceOutcome =
  | {
      status: 'stopped';
      safety: SafetyResult;
      filled: readonly [];
      drafted: null;
      submitGate: null;
      candidateAssisted: boolean;
    }
  | {
      status: 'drafting_failed';
      safety: SafetyResult;
      filled: readonly FilledField[];
      drafted: LocalClaudeOutcome;
      submitGate: null;
      candidateAssisted: boolean;
    }
  | {
      status: 'ready_for_review';
      safety: SafetyResult;
      filled: readonly FilledField[];
      drafted: LocalClaudeOutcome | null;
      submitGate: ReturnType<typeof canSlotSubmit>;
      candidateAssisted: boolean;
    };

/**
 * Build the observation into the evaluator's input.
 *
 * Note what is NOT mapped optimistically. `login_wall_present: 'yes'` becomes
 * `employer_authenticated: 'no'`, and an `unknown` wall becomes an `unknown`
 * session — never `'yes'`. The whole file is written so that the only way to
 * get a `proceed` is for every hazard to have been positively ruled out.
 */
export function toSafetyInput(
  inputs: SliceInputs
): Parameters<typeof evaluateSafety>[0] {
  const o = inputs.observation;
  const tri = (v: 'yes' | 'no' | 'unknown') => v;

  const employerAuthenticated =
    o.login_wall_present === 'yes' ? 'no' : o.login_wall_present === 'no' ? 'yes' : 'unknown';

  // A question we hold no verified fact for is one we may not answer.
  const unverified = o.fields
    .filter((f) => f.factKey !== null && !(f.factKey in inputs.verifiedFacts))
    .map((f) => f.factKey as string);

  return {
    ...SAFE_BASELINE,
    ...inputs.limits,
    mode: inputs.mode,
    captcha_present: tri(o.captcha_present),
    mfa_required: tri(o.mfa_required),
    sensitive_information_requested: tri(o.sensitive_information_requested),
    page_recognised: tri(o.page_recognised),
    site_supported: tri(o.site_supported),
    employer_authenticated: employerAuthenticated,
    /*
     * The Claude session only matters in assisted mode, and only when the
     * local capability is not usable — a working local adapter IS the proof
     * that the session exists, so re-asking would stop a flow that is fine.
     */
    claude_max_authenticated:
      inputs.mode === 'claude_max_assisted' && inputs.availability.status === 'supported'
        ? 'yes'
        : inputs.mode === 'claude_max_assisted'
          ? 'unknown'
          : 'no',
    unverified_required_facts: unverified,
  };
}

/** The prompt for a drafted field. Verified facts only, and it says so. */
export function buildDraftPrompt(
  field: ObservedField,
  question: string,
  verifiedFacts: Readonly<Record<string, string>>
): string {
  const facts = Object.entries(verifiedFacts)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  /*
   * The rules are stated to the model AND enforced afterwards. Asking nicely
   * is not a control: `used_fact_keys` is checked against the supplied keys by
   * the caller, and `uncertain` sends the answer to a human regardless of what
   * the prose says.
   */
  return `You draft one application answer for a job candidate.

VERIFIED CANDIDATE FACTS — the only facts you may use:
${facts || '  (none)'}

QUESTION FROM THE EMPLOYER (field "${field.name}"):
  ${question}

Return ONLY minified JSON, no prose and no code fence, matching exactly:
{"answer":string,"used_fact_keys":string[],"uncertain":boolean}

Rules:
- Use only the facts listed above. Invent nothing.
- If answering needs a fact that is not listed, set "uncertain" to true.
- List in "used_fact_keys" exactly the keys you relied on.
- Keep the answer under 200 words.`;
}

/**
 * Run the slice.
 *
 * Never throws. A worker that throws mid-task leaves a lease held until it
 * expires, and a task nobody can pick up.
 */
export async function runSlice(inputs: SliceInputs): Promise<SliceOutcome> {
  const table = routingTable(inputs.mode, inputs.availability);
  const candidateAssisted = Object.values(table).some((r) => r.attended);

  // 1-3. Evaluate BEFORE touching anything.
  const safety = evaluateSafety(toSafetyInput(inputs));
  if (safety.action === 'stop') {
    return { status: 'stopped', safety, filled: [], drafted: null, submitGate: null, candidateAssisted };
  }

  // 4. Routine fields only, and only from verified facts.
  const filled: FilledField[] = [];
  for (const field of inputs.observation.fillable) {
    const key = field.factKey;
    if (!key) continue;
    const value = inputs.verifiedFacts[key];
    // Defensive: the evaluator already stops on an unverified required fact,
    // so reaching here with a missing value would be a bug. Skip rather than
    // invent, and let the submit gate refuse an incomplete form.
    if (value === undefined) continue;
    filled.push({ name: field.name, factKey: key, value });
  }

  // 5. Draft the free-text field, if there is one.
  let drafted: LocalClaudeOutcome | null = null;
  const toDraft = draftableFields(inputs.observation);
  if (toDraft.length > 0) {
    const capability: AiCapability = 'application_answer_generation';
    const routing = table[capability];

    // The paste console is a HUMAN step. The slice does not pretend to
    // complete it; it stops for the candidate, which is what `attended` means.
    if (routing.destination !== 'local_claude' && routing.destination !== 'openrouter') {
      return {
        status: 'stopped',
        safety: { action: 'stop', reasons: ['unknown_candidate_fact'], requires_human: true },
        filled: [],
        drafted: null,
        submitGate: null,
        candidateAssisted,
      };
    }

    const field = toDraft[0];
    drafted = await inputs.transport.run({
      request_id: '00000000-0000-4000-8000-000000000001',
      candidate_id: '00000000-0000-4000-8000-000000000002',
      task_id: '00000000-0000-4000-8000-000000000003',
      capability: 'application_answer_generation',
      model:
        inputs.availability.status === 'supported' ? inputs.availability.model : 'sonnet',
      prompt: buildDraftPrompt(
        field,
        'Briefly describe your experience with TypeScript.',
        inputs.verifiedFacts
      ),
      timeout_ms: 120_000,
    });

    if (outcomeRequiresHuman(drafted)) {
      return { status: 'drafting_failed', safety, filled, drafted, submitGate: null, candidateAssisted };
    }

    /*
     * A cited fact key we never supplied means the answer did not come from
     * the candidate's data. Treated as a drafting failure rather than a
     * lower-confidence answer, because the failure mode is an invented claim
     * asserted to an employer as the candidate's own.
     */
    if (drafted.status === 'ok' && 'used_fact_keys' in drafted.output) {
      const invented = drafted.output.used_fact_keys.filter(
        (k) => !(k in inputs.verifiedFacts)
      );
      if (invented.length > 0) {
        return {
          status: 'drafting_failed',
          safety,
          filled,
          drafted: {
            status: 'invalid_output',
            request_id: drafted.request_id,
            detail: `cited ${invented.length} unsupplied fact key(s)`,
          },
          submitGate: null,
          candidateAssisted,
        };
      }
    }
  }

  // 6. The submit gate. Reached, reported, never acted on here.
  const submitGate = canSlotSubmit({
    lifecycle: inputs.lifecycle,
    slotState: inputs.slotState,
    agentState: inputs.agentState,
    lease: inputs.lease,
  });

  return { status: 'ready_for_review', safety, filled, drafted, submitGate, candidateAssisted };
}
