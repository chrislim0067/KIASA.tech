import { z } from 'zod';

import { ResumeExtraction } from '@/lib/resume/schema';

/**
 * The instruction a candidate hands to Claude themselves.
 *
 * WHY THIS IS GENERATED, NOT WRITTEN
 *
 * The JSON shape below comes out of the same Zod object the application
 * validates against. Writing the shape by hand would create two descriptions of
 * one contract, and the failure mode is nasty and quiet: the prompt asks for a
 * field the app has renamed, the person pastes a perfectly good answer, and the
 * console rejects it for reasons neither of them can see. Generating it means
 * the instruction is always exactly what the paste box will accept.
 *
 * Computed on the server and passed to the console as a string, so `zod` and
 * the schema stay out of the JavaScript a candidate downloads.
 */

/** The transcription rules. Identical in substance to the API path's system prompt. */
const RULES = `You are transcribing a résumé into a structured record for a job-application platform.

You are transcribing, not interpreting. The person will be shown exactly what you produce and asked to confirm it, so anything you invent either wastes their time or gets confirmed without being noticed and then stated on their behalf in a real job application.

1. If the document does not say it, use null. Not a guess, not a sensible default, not an inference. A city does not tell you a country. An area code does not tell you a country. A job title does not tell you an employment type. A list of technologies does not tell you a proficiency level. null is the correct answer for anything the page does not state.

2. Do not improve the writing. Copy job descriptions across as written, one bullet per line. Do not summarise, condense or re-word.

3. Reformat only where the shape demands it — a phone number into E.164, a date into YYYY-MM-DD, a country into a two-letter code. If the information needed for the format is not on the page, use null instead.

4. Transcribe every role, every qualification and every listed skill, even where they repeat or overlap.

5. Where the document defeats you, say so in unreadable_sections rather than producing a thin result that looks complete.

Reply with the JSON object and nothing else — no explanation, no markdown fence.`;

/**
 * The full text to paste into Claude, alongside the résumé.
 *
 * `z.toJSONSchema` carries every `.describe()` from the schema through into the
 * output, so the per-field instructions travel with the shape rather than being
 * summarised into prose that drifts away from it.
 */
export function buildResumePrompt(): string {
  const schema = z.toJSONSchema(ResumeExtraction, { io: 'output' });
  return `${RULES}\n\nReturn JSON matching this schema:\n\n${JSON.stringify(schema, null, 2)}`;
}
