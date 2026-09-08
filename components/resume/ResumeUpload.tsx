'use client';

import { useActionState, useRef, useState, useTransition } from 'react';

import { createClient } from '@/lib/supabase/client';
import { IDLE, type FormState } from '@/lib/candidate/form-state';
import { RESUME_BUCKET, RESUME_MIME, RESUME_MAX_BYTES, storagePathFor } from '@/lib/resume/paths';

/**
 * Picking a résumé and getting it read.
 *
 * THE FILE DOES NOT PASS THROUGH THE SERVER. The browser uploads it straight
 * into the private `resumes` bucket using the candidate's own session, and the
 * server action is then handed nothing but an id. Three reasons, in order of
 * how much they matter:
 *
 *   1. Storage RLS is the check. The bucket's policies allow a write only to a
 *      folder named after the caller's own user id, so the upload is authorised
 *      by the same session that owns the file rather than by our code
 *      remembering to compare two strings.
 *   2. A serverless function has a request body limit measured in single-digit
 *      megabytes. Routing a 10 MB PDF through one turns a large résumé into an
 *      opaque failure.
 *   3. It is one transfer instead of two.
 *
 * The two stages are shown separately because they fail differently and take
 * different amounts of time — an upload that stalls is a network problem the
 * person can retry immediately, while reading takes as long as it takes and
 * looks identical to a hang if nothing says so.
 */

export default function ResumeUpload({
  userId,
  action,
}: {
  userId: string;
  action: (prev: FormState, form: FormData) => Promise<FormState>;
}) {
  const [state, submit, reading] = useActionState(action, IDLE);
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The stage is derived, not stored.
   *
   * Only the upload half needs tracking: `useActionState` already reports
   * whether the parse is in flight, and it stops reporting it the moment the
   * action returns. Mirroring that into a `stage` variable meant an effect to
   * keep the two in sync — and an effect that resets state is exactly how a
   * failed parse ends up leaving the button disabled forever.
   */
  const stage = uploading ? 'uploading' : reading ? 'reading' : 'idle';

  async function onPick(file: File) {
    setLocalError(null);

    // Checked here so an obvious mistake costs nothing. The bucket enforces
    // both rules again server-side, which is what actually holds.
    if (file.type !== RESUME_MIME && !file.name.toLowerCase().endsWith('.pdf')) {
      setLocalError('KIASA reads PDFs. Export your résumé as a PDF and try again.');
      return;
    }
    if (file.size === 0) {
      setLocalError('That file is empty.');
      return;
    }
    if (file.size > RESUME_MAX_BYTES) {
      setLocalError('That PDF is larger than 10 MB. Export a smaller copy and try again.');
      return;
    }

    setUploading(true);

    const objectId = crypto.randomUUID();

    try {
      const supabase = createClient();
      const { error } = await supabase.storage
        .from(RESUME_BUCKET)
        .upload(storagePathFor(userId, objectId), file, {
          contentType: RESUME_MIME,
          // A fresh id every time, so an overwrite would mean something has
          // gone wrong rather than that the person is replacing a file.
          upsert: false,
        });

      if (error) {
        setUploading(false);
        setLocalError('That file could not be uploaded. Check your connection and try again.');
        return;
      }
    } catch {
      setUploading(false);
      setLocalError('That file could not be uploaded. Check your connection and try again.');
      return;
    }

    const form = new FormData();
    form.set('object_id', objectId);
    form.set('file_name', file.name);
    form.set('file_size', String(file.size));

    // Both in the same handler, so React batches them: the button goes from
    // "Uploading…" straight to "Reading your résumé…" with no frame in between
    // where it offers to choose a file again.
    setUploading(false);
    startTransition(() => submit(form));
  }

  const busy = stage !== 'idle';
  const message = localError ?? (!state.ok ? state.message : null);

  return (
    <div className="kresume__upload">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="kresume__file"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the same file twice after a failure still fires
          // a change event.
          e.target.value = '';
          if (file) void onPick(file);
        }}
      />

      <button
        type="button"
        className="kprof__button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {stage === 'uploading'
          ? 'Uploading…'
          : stage === 'reading'
            ? 'Reading your résumé…'
            : 'Choose a PDF'}
      </button>

      {stage === 'reading' ? (
        <p className="kprof__hint" role="status">
          This takes up to a minute. Nothing is added to your profile yet — you will see
          everything that was found and decide what to keep.
        </p>
      ) : null}

      {message ? (
        <p className="kprof__notice kprof__notice--bad" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
