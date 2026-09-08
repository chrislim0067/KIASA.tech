import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { ResumeExtraction } from '@/lib/resume/schema';

/**
 * Reading a resume PDF into the candidate schema.
 *
 * This module is the ONLY place the platform sends a candidate's document to a
 * third party, and the only place the Anthropic key is read. It is
 * `server-only`, so importing it from a client component is a build error
 * rather than a leaked key.
 *
 * WHY THE PDF GOES STRAIGHT IN
 *
 * The document is sent as a base64 `document` block. Claude reads PDFs
 * natively, so there is no text-extraction library in the dependency tree, and
 * nothing to go wrong between the bytes and the model — a two-column layout, a
 * table of dates, a logo the text layer renders as gibberish are all handled by
 * the thing that also has to interpret them.
 *
 * It is sent inline rather than uploaded to the Files API on purpose. An
 * uploaded file persists on Anthropic's side until something deletes it; an
 * inline document exists for the duration of one request. For a document that
 * carries a person's full name, address, phone number and employment history,
 * the shorter life is the right default, and we only ever read each resume once.
 *
 * WHAT THIS FUNCTION WILL NOT DO
 *
 * It does not write anything. It returns a proposal, and the caller stores it
 * for the candidate to check. Nothing here reaches the profile tables.
 */

/** Model failures the caller can act on, matching `resume_imports.failure_class`. */
export type ExtractFailureClass = 'unreadable' | 'too_large' | 'model_error' | 'timeout';

export type ExtractResult =
  | { ok: true; data: ResumeExtraction; model: string }
  | {
      ok: false;
      failureClass: ExtractFailureClass;
      /** Stable, machine-readable, safe to store and to log. */
      failureCode: string;
      /** Written for the candidate, not for a developer. */
      message: string;
      /** Whether trying the same file again could plausibly succeed. */
      retryable: boolean;
    };

export const RESUME_MODEL = 'claude-opus-5';

/**
 * 10 MB, matching the `resumes` bucket's own limit.
 *
 * The API's PDF ceiling is far higher (32 MB, 600 pages). This is deliberately
 * lower: a resume that large is a scanned photo album, and the useful failure is
 * "this file is too big to be a resume", delivered before spending a request on
 * it.
 */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/**
 * Enough for a long career; not enough for the model to start narrating.
 *
 * The output is a fixed-shape JSON object, so the length is bounded by the
 * resume rather than by the model's inclination.
 */
const MAX_TOKENS = 16000;

/** Below the route's own budget, so a slow model produces a clean failure. */
const REQUEST_TIMEOUT_MS = 240_000;

const SYSTEM_PROMPT = `You transcribe résumés into a structured record for a job-application platform.

You are transcribing, not interpreting. The person whose résumé this is will be shown exactly what you return and asked to confirm it, and anything you get right saves them typing while anything you invent wastes their time or, worse, is confirmed without being noticed and then asserted on their behalf in a real job application.

The rules, in order of importance:

1. If the document does not say it, return null. Not a guess, not a sensible default, not an inference from context. A city does not tell you a country. An area code does not tell you a country. A job title does not tell you an employment type. A long list of technologies does not tell you a proficiency level. null is the correct, expected answer for anything the page does not state, and it is never a failure.

2. Do not improve the writing. Job descriptions and achievements are the candidate's own account of their work; copy them across as written, preserving each bullet on its own line. Do not summarise, condense, re-word, or make anything sound better.

3. Reformat only where the schema demands a specific format — a phone number into E.164, a date into YYYY-MM-DD, a country into a two-letter code. Reformatting is not the same as inferring: if the information needed for the format is not on the page, return null instead.

4. Transcribe every role, every qualification and every listed skill, even where entries repeat, overlap in time, or look inconsistent. It is not your job to tidy someone's history.

5. Where the document defeats you — a scanned image, a column that interleaves, a script you cannot read — say so in unreadable_sections rather than producing a thin result that looks complete.`;

/**
 * Turn an SDK failure into something with a class, a code and a sentence a
 * candidate can act on.
 *
 * The typed error chain is matched from most specific to least, because
 * `APIError` is the base of the others. Nothing derived from the resume's
 * content is ever put in a message or a code — a model error must not become a
 * channel through which a person's employment history reaches the logs.
 */
function classify(error: unknown): Extract<ExtractResult, { ok: false }> {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      ok: false,
      failureClass: 'timeout',
      failureCode: 'timeout',
      message: 'Reading the résumé took too long. Try again.',
      retryable: true,
    };
  }

  if (error instanceof Anthropic.RateLimitError) {
    return {
      ok: false,
      failureClass: 'model_error',
      failureCode: 'rate_limited',
      message: 'Too many résumés are being read right now. Try again in a minute.',
      retryable: true,
    };
  }

  if (error instanceof Anthropic.BadRequestError) {
    // A 400 on this request is almost always the document: encrypted,
    // corrupted, or not really a PDF despite its extension.
    return {
      ok: false,
      failureClass: 'unreadable',
      failureCode: 'rejected_document',
      message:
        'That PDF could not be read. If it is password-protected or a scan, ' +
        'try exporting a fresh copy from the original document.',
      retryable: false,
    };
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return {
      ok: false,
      failureClass: 'model_error',
      failureCode: 'connection_failed',
      message: 'Could not reach the résumé reader. Try again in a moment.',
      retryable: true,
    };
  }

  if (error instanceof Anthropic.APIError) {
    return {
      ok: false,
      failureClass: 'model_error',
      failureCode: `api_${error.status ?? 'unknown'}`,
      message: 'The résumé reader failed. Try again in a moment.',
      retryable: (error.status ?? 500) >= 500,
    };
  }

  return {
    ok: false,
    failureClass: 'model_error',
    failureCode: 'unexpected',
    message: 'Something went wrong reading the résumé. Try again.',
    retryable: true,
  };
}

/** Present and non-empty. Checked at call time so a missing key is a clean failure. */
export function isResumeParsingConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Read a résumé PDF.
 *
 * @param pdf the raw bytes, already known to be a PDF by the caller
 */
export async function extractResume(pdf: Uint8Array): Promise<ExtractResult> {
  if (!isResumeParsingConfigured()) {
    return {
      ok: false,
      failureClass: 'model_error',
      failureCode: 'not_configured',
      message: 'Résumé import is not switched on yet.',
      retryable: false,
    };
  }

  if (pdf.byteLength === 0) {
    return {
      ok: false,
      failureClass: 'unreadable',
      failureCode: 'empty_file',
      message: 'That file is empty.',
      retryable: false,
    };
  }

  if (pdf.byteLength > MAX_RESUME_BYTES) {
    return {
      ok: false,
      failureClass: 'too_large',
      failureCode: 'over_size_limit',
      message: 'That PDF is larger than 10 MB. Export a smaller copy and try again.',
      retryable: false,
    };
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    // One retry, and only for the failures the SDK already knows are transient.
    // Higher would multiply the wait a candidate is staring at.
    maxRetries: 1,
  });

  let response;
  try {
    response = await client.messages.parse({
      model: RESUME_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      output_config: { format: zodOutputFormat(ResumeExtraction) },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: Buffer.from(pdf).toString('base64'),
              },
            },
            {
              type: 'text',
              text:
                'Transcribe this résumé into the given structure. ' +
                'Anything the document does not state is null.',
            },
          ],
        },
      ],
    });
  } catch (error) {
    return classify(error);
  }

  // `parsed_output` is null when the response did not satisfy the schema. That
  // is not an exception — it is a document the model could not turn into this
  // shape, which is a different thing from the request failing.
  const parsed = response.parsed_output;
  if (!parsed) {
    return {
      ok: false,
      failureClass: 'unreadable',
      failureCode: 'no_structured_output',
      message:
        'That document could not be read as a résumé. If it is a scan or a ' +
        'photo, a text PDF works far better.',
      retryable: false,
    };
  }

  return { ok: true, data: parsed, model: RESUME_MODEL };
}
