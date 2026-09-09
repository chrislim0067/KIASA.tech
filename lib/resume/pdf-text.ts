import 'server-only';

/**
 * Reading the text layer out of a résumé PDF, on our own server.
 *
 * `server-only` because this pulls in a PDF parser. Without it, a client
 * component could import this module and ship a megabyte of pdf.js — and a
 * candidate's résumé bytes — into the browser bundle.
 *
 * WHY THE PDF NO LONGER LEAVES THE SERVER
 *
 * The previous implementation sent the raw PDF, base64-encoded, to a model
 * that reads PDFs natively. That was a reasonable design for that provider and
 * a bad one for this project: the document carries a person's full name,
 * address, phone number and employment history, and the fewer systems that
 * receive the original file, the smaller the disclosure. Text extraction here
 * means the third party sees bounded text we have already inspected and
 * measured, never the file, never an embedded photograph, never the metadata a
 * PDF quietly carries about the machine that produced it.
 *
 * It also makes the failure modes honest. A scanned résumé has no text layer;
 * extracting locally lets us SAY that, instead of sending an empty document to
 * a model and receiving a fluent, entirely invented career history back.
 *
 * WHY unpdf
 *
 * 2 MB unpacked and ZERO dependencies, against 20 MB and a native canvas
 * binary for `pdf-parse`, or 33 MB for `pdfjs-dist` directly. It wraps a
 * serverless build of pdf.js that needs no worker thread and no native module,
 * which is what a Vercel Node runtime can actually run. The smallest thing
 * that does the job, as required.
 *
 * NOTHING HERE INTERPRETS THE RÉSUMÉ. It returns text and counts. Deciding
 * what the text means is the model's job, and deciding whether the model was
 * right is the candidate's.
 */

/**
 * 10 MB, matching the `resumes` storage bucket's own limit, so a file that
 * uploaded successfully cannot then be rejected here for its size.
 */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/**
 * A résumé is not a book. Thirty pages is already generous for an academic CV,
 * and the limit exists so a mistakenly uploaded 400-page document fails in
 * milliseconds instead of occupying the parser.
 */
export const MAX_PDF_PAGES = 30;

/**
 * Roughly 20k tokens of text. Past this the document is not a résumé, and
 * sending it would spend a request to be told the same thing.
 */
export const MAX_EXTRACTED_CHARS = 80_000;

/**
 * Below this, the "text layer" is not a résumé — it is a scanner's stray
 * artefacts, a cover page, or a couple of words in a header. Sending it
 * produces a confident invention, so it becomes manual review instead.
 */
export const MIN_EXTRACTED_CHARS = 200;

/** The parse itself is bounded, separately from the model request. */
export const PDF_PARSE_TIMEOUT_MS = 20_000;

export type PdfTextFailureCode =
  | 'empty_file'
  | 'over_size_limit'
  | 'not_a_pdf'
  | 'corrupt_pdf'
  | 'encrypted_pdf'
  | 'too_many_pages'
  | 'no_text_layer'
  | 'too_little_text'
  | 'text_too_long'
  | 'parse_timeout';

export type PdfTextResult =
  | { ok: true; text: string; pages: number; chars: number }
  | { ok: false; code: PdfTextFailureCode; pages?: number; chars?: number };

/**
 * Does this look like a PDF? Cheap, and catches a renamed .docx.
 *
 * The signature is searched for in the first kilobyte rather than required at
 * byte zero. Real PDFs in the wild carry a byte-order mark, a stray newline or
 * an HTTP preamble before `%PDF-`, and pdf.js accepts them; rejecting those as
 * "not a PDF" would be this check overruling the parser about a file the
 * parser can read perfectly well.
 */
const PDF_SIGNATURE_SEARCH_BYTES = 1024;

function looksLikePdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, PDF_SIGNATURE_SEARCH_BYTES);
  for (let i = 0; i + 4 < limit; i++) {
    if (
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Collapse the whitespace pdf.js emits between text runs.
 *
 * Line structure is preserved because a résumé's meaning is partly its layout
 * — one role per line, one bullet per line — and the extraction prompt asks
 * for bullets to be kept separate. Only runs of spaces and blank lines are
 * reduced.
 */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract the text layer.
 *
 * `bytes` is not consumed: pdf.js takes ownership of the buffer it is given
 * and detaches it, which would leave the caller holding a zero-length array.
 * A copy goes to the parser.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextResult> {
  if (bytes.byteLength === 0) return { ok: false, code: 'empty_file' };
  if (bytes.byteLength > MAX_RESUME_BYTES) return { ok: false, code: 'over_size_limit' };
  if (!looksLikePdf(bytes)) return { ok: false, code: 'not_a_pdf' };

  // Imported here rather than at module scope so the parser is only loaded
  // when a résumé is actually read.
  const { extractText, getDocumentProxy } = await import('unpdf');

  // The handle is kept so the timer can be cleared once the parse settles.
  // Left running, it would sit in the event loop for the full twenty seconds
  // after a parse that finished in milliseconds — harmless on a long-lived
  // server, wasteful in a function billed by duration.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('pdf_parse_timeout')), PDF_PARSE_TIMEOUT_MS);
    timer.unref?.();
  });

  interface ParseOutcome {
    pages: number;
    /** Undefined when the page count already disqualified the document. */
    text?: string;
  }

  let outcome: ParseOutcome;
  try {
    const parse = async (): Promise<ParseOutcome> => {
      const doc = await getDocumentProxy(new Uint8Array(bytes));
      if (doc.numPages > MAX_PDF_PAGES) return { pages: doc.numPages };
      const { text } = await extractText(doc, { mergePages: true });
      return { pages: doc.numPages, text: typeof text === 'string' ? text : String(text ?? '') };
    };
    outcome = await Promise.race([parse(), timeout]);
  } catch (error) {
    const name = (error as { name?: string })?.name ?? '';
    const message = String((error as { message?: string })?.message ?? '');
    if (message === 'pdf_parse_timeout') return { ok: false, code: 'parse_timeout' };
    if (name === 'PasswordException' || /password/i.test(message)) {
      return { ok: false, code: 'encrypted_pdf' };
    }
    // Anything else from the parser means the bytes are not a document it can
    // read. The reason is never surfaced verbatim: parser messages can quote
    // document content.
    return { ok: false, code: 'corrupt_pdf' };
  } finally {
    if (timer) clearTimeout(timer);
  }

  const { pages } = outcome;
  if (outcome.text === undefined) return { ok: false, code: 'too_many_pages', pages };

  const text = tidy(outcome.text);
  const chars = text.length;

  if (chars === 0) return { ok: false, code: 'no_text_layer', pages, chars };
  if (chars < MIN_EXTRACTED_CHARS) return { ok: false, code: 'too_little_text', pages, chars };
  if (chars > MAX_EXTRACTED_CHARS) return { ok: false, code: 'text_too_long', pages, chars };

  return { ok: true, text, pages, chars };
}
