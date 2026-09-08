'use client';

import { useActionState, useCallback, useRef, useState } from 'react';

import { IDLE, type FormState } from '@/lib/candidate/form-state';
import type { ResumeExtraction } from '@/lib/resume/schema';

/**
 * The import console.
 *
 * One modal, one channel, two moves: copy the instruction out, paste the answer
 * back. Both are a single click, because the manual route only earns its place
 * if the manual part is trivial — a person hand-copying a schema out of a
 * documentation page would rightly rather type their profile in.
 *
 * WHY A CONSOLE AND NOT A FORM
 *
 * A form implies the machine did something. Here the person is the one doing
 * it, and the console says so: every line is an event, in order, with what
 * actually happened. When a paste is rejected it names the field and the rule,
 * so the fix is obvious rather than a shrug. That honesty is the same reason
 * the whole feature is parse → review → confirm.
 *
 * WHAT IS TRUSTED
 *
 * Nothing pasted here. The text is validated against the same Zod schema the
 * API path uses — which mirrors the database's own constraints — and validating
 * in the browser is a convenience for fast feedback, never the boundary. The
 * server re-validates the same bytes before anything is stored.
 */

type Line = { kind: 'in' | 'out' | 'ok' | 'err' | 'note'; text: string };

const MARKS: Record<Line['kind'], string> = {
  in: '←',
  out: '→',
  ok: '✓',
  err: '✕',
  note: '·',
};

/**
 * Pull the JSON object out of whatever came back.
 *
 * Claude usually returns a bare object, but "here is the JSON:" and a ```json
 * fence are both common and both harmless. Recovering from them is a few lines;
 * making someone hand-edit their clipboard is a reason to give up on the
 * feature.
 */
function extractJson(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();

  if (body.startsWith('{') && body.endsWith('}')) return body;

  // Fall back to the outermost braces, which handles a preamble or a sign-off.
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  return first !== -1 && last > first ? body.slice(first, last + 1) : null;
}

export default function ImportConsole({
  prompt,
  action,
  uploadHref,
  triggerLabel = 'Import your résumé',
  triggerNote = 'Run it through Claude and check everything before it is saved.',
}: {
  prompt: string;
  /** Takes the validated draft and hands back a review screen. */
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  /** The upload route, for people who would rather not do this by hand. */
  uploadHref: string;
  triggerLabel?: string;
  triggerNote?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [state, submit, sending] = useActionState(action, IDLE);

  const [lines, setLines] = useState<Line[]>([
    { kind: 'note', text: 'ready. nothing is saved until you confirm.' },
  ]);
  const [draft, setDraft] = useState<ResumeExtraction | null>(null);
  const [checking, setChecking] = useState(false);

  const log = useCallback((kind: Line['kind'], text: string) => {
    setLines((prev) => [...prev, { kind, text }].slice(-40));
  }, []);

  const open = () => {
    dialogRef.current?.showModal();
  };

  const close = () => {
    dialogRef.current?.close();
  };

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      log('out', `instruction copied — ${prompt.length.toLocaleString()} characters`);
      log('note', 'open claude.ai, attach your résumé, paste this, send.');
    } catch {
      // Clipboard access is refused in some browsers without a user gesture, or
      // over plain HTTP. Selecting the text is the fallback that always works.
      log('err', 'the browser would not give access to the clipboard');
      log('note', 'select the instruction below and copy it manually.');
    }
  }

  /**
   * Validate a pasted answer.
   *
   * The schema is imported on demand rather than at module scope, so `zod` and
   * the field definitions are downloaded only by someone who actually opens the
   * console — not by every candidate who loads the profile page.
   */
  async function check(raw: string) {
    const json = extractJson(raw);
    if (!json) {
      setDraft(null);
      log('err', 'that does not look like JSON');
      return;
    }

    setChecking(true);
    try {
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        setDraft(null);
        log('err', 'the JSON is malformed — it may have been cut off part-way');
        return;
      }

      const { ResumeExtraction } = await import('@/lib/resume/schema');
      const result = ResumeExtraction.safeParse(value);

      if (!result.success) {
        setDraft(null);
        log('err', `rejected — ${result.error.issues.length} problem(s):`);
        // Named individually, because "invalid input" tells nobody anything.
        // The path is the field, so the fix is a one-word edit in Claude.
        for (const issue of result.error.issues.slice(0, 6)) {
          const where = issue.path.length ? issue.path.join('.') : '(root)';
          log('note', `${where}: ${issue.message}`);
        }
        if (result.error.issues.length > 6) {
          log('note', `…and ${result.error.issues.length - 6} more`);
        }
        return;
      }

      const d = result.data;
      setDraft(d);
      log('ok', 'accepted');
      log(
        'in',
        `${d.work_experiences.length} role(s), ${d.education_entries.length} qualification(s), ${d.skills.length} skill(s)`
      );
      if (d.unreadable_sections.length > 0) {
        log('note', `claude could not read: ${d.unreadable_sections.join('; ')}`);
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <button type="button" className="kprof__step kconsole__trigger" onClick={open}>
        <span className="kprof__stepMark" aria-hidden="true">
          ⌘
        </span>
        <span className="kprof__stepBody">
          <span className="kprof__stepTitle">{triggerLabel}</span>
          <span className="kprof__stepNote">{triggerNote}</span>
        </span>
      </button>

      {/* Native <dialog>: real focus trapping, Esc to close and an inert page
          behind it, none of which a div pretending to be a modal gets right. */}
      <dialog ref={dialogRef} className="kconsole" aria-label="Résumé import console">
        <header className="kconsole__bar">
          <span className="kconsole__title">résumé import</span>
          <button type="button" className="kconsole__close" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="kconsole__body">
          {/* ------------------------------------------------------ step one */}
          <section className="kconsole__step">
            <h3 className="kconsole__stepTitle">
              <span className="kconsole__num">1</span> Copy the instruction
            </h3>
            <p className="kconsole__hint">
              Open Claude, attach your résumé PDF, paste this, and send it.
            </p>
            <div className="kconsole__row">
              <button type="button" className="kprof__button" onClick={copyPrompt}>
                Copy instruction
              </button>
              <a
                className="kprof__button kprof__button--ghost"
                href="https://claude.ai/new"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Claude ↗
              </a>
            </div>
            <details className="kconsole__details">
              <summary>Show the instruction</summary>
              <pre className="kconsole__pre">{prompt}</pre>
            </details>
          </section>

          {/* ------------------------------------------------------ step two */}
          <section className="kconsole__step">
            <h3 className="kconsole__stepTitle">
              <span className="kconsole__num">2</span> Paste the answer back
            </h3>
            <textarea
              ref={areaRef}
              className="kconsole__input"
              rows={7}
              spellCheck={false}
              placeholder="Paste what Claude replied — the whole thing is fine."
              onPaste={(e) => {
                // Read the clipboard directly rather than waiting for a change
                // event, so a paste is checked the instant it lands.
                const text = e.clipboardData.getData('text');
                if (text.trim()) {
                  log('in', `pasted ${text.length.toLocaleString()} characters`);
                  void check(text);
                }
              }}
              onChange={(e) => {
                if (!e.target.value.trim()) setDraft(null);
              }}
            />
            <div className="kconsole__row">
              <button
                type="button"
                className="kprof__button kprof__button--ghost"
                disabled={checking}
                onClick={() => {
                  const text = areaRef.current?.value ?? '';
                  if (text.trim()) {
                    log('in', 'checking again');
                    void check(text);
                  }
                }}
              >
                Check again
              </button>
            </div>
          </section>

          {/* ------------------------------------------------------- channel */}
          <section className="kconsole__channel" aria-live="polite">
            {lines.map((line, i) => (
              <div key={i} className={`kconsole__line kconsole__line--${line.kind}`}>
                <span className="kconsole__mark" aria-hidden="true">
                  {MARKS[line.kind]}
                </span>
                <span>{line.text}</span>
              </div>
            ))}
          </section>
        </div>

        {/*
          A real form, so the draft is re-validated on the server before a row
          exists. The browser check above is for speed, never for trust.

          It carries the draft as JSON rather than as a field per value: the
          console has already proved this object satisfies the schema, and
          flattening it into form fields only to reassemble it would be a second
          place for the shape to go wrong.
        */}
        <form
          action={submit}
          className="kconsole__foot"
          onSubmit={() => log('out', 'sending the draft for review…')}
        >
          <input type="hidden" name="draft" value={draft ? JSON.stringify(draft) : ''} />

          <span className="kconsole__status">
            {!state.ok && state.message
              ? state.message
              : draft
                ? 'Ready to review'
                : 'Waiting for a valid paste'}
          </span>

          <div className="kconsole__row">
            {/* The other way in, kept visible. Someone whose résumé will not
                paste cleanly should not have to find the upload route by
                guessing at a URL. */}
            <a className="kprof__button kprof__button--ghost" href={uploadHref}>
              Upload a PDF instead
            </a>
            <button type="submit" className="kprof__button" disabled={!draft || sending}>
              {sending ? 'Sending…' : 'Continue to review →'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
