import { RESUME_MIME, RESUME_MAX_BYTES } from '@/lib/resume/paths';

/**
 * Screening a chosen file before anything is spent on it.
 *
 * THIS IS A COURTESY, NOT A BOUNDARY. The `resumes` bucket enforces its own
 * `file_size_limit` and its own allowed MIME type, and the server action checks
 * again before it pays for a model call. What this adds is that an obvious
 * mistake — a .docx, an empty file, a 40 MB scan — is answered instantly and in
 * words, instead of after an upload and a failure with no explanation.
 *
 * Deliberately free of `server-only` and of any Node import: it runs in the
 * browser, in the same handler as the file picker.
 *
 * It is a separate function rather than four `if`s inside a component because
 * this is the part with rules in it, and rules that cannot be tested without a
 * browser tend not to be.
 */

export type FileRejection = 'wrong_type' | 'empty' | 'too_large';

/** Only what the check actually reads. Anything `File`-shaped satisfies it. */
export interface ChosenFile {
  name: string;
  type: string;
  size: number;
}

export const FILE_REJECTION_TEXT: Record<FileRejection, string> = {
  wrong_type: 'KIASA reads PDFs. Export your résumé as a PDF and try again.',
  empty: 'That file is empty.',
  too_large: 'That PDF is larger than 10 MB. Export a smaller copy and try again.',
};

export function screenResumeFile(
  file: ChosenFile
): { ok: true } | { ok: false; reason: FileRejection; message: string } {
  const refuse = (reason: FileRejection) => ({
    ok: false as const,
    reason,
    message: FILE_REJECTION_TEXT[reason],
  });

  /*
   * THE NAME IS ACCEPTED AS A FALLBACK, AND ONLY AS A FALLBACK.
   *
   * Some browsers and some operating systems hand over an empty `type` for a
   * file they cannot identify, including for perfectly ordinary PDFs. Refusing
   * those would turn a browser quirk into "KIASA cannot read my résumé". A
   * wrong extension gets the file no further than the bucket's own MIME rule.
   */
  if (file.type !== RESUME_MIME && !file.name.toLowerCase().endsWith('.pdf')) {
    return refuse('wrong_type');
  }

  // Ordered before the size ceiling: an empty file is a different mistake from
  // a large one and deserves its own sentence.
  if (file.size === 0) return refuse('empty');
  if (file.size > RESUME_MAX_BYTES) return refuse('too_large');

  return { ok: true };
}
