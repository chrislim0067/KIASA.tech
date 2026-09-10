# Résumé import

Upload a PDF, have it read, check what was found, then confirm. Nothing reaches
the profile tables until a person has seen it and pressed the button.

## Why not autofill

The obvious version of this feature reads the PDF and announces "your profile is
complete". That is a worse product built on a worse idea: it turns a model's
reading of a document into claims the candidate will make to real employers,
without the candidate ever having agreed to them. A résumé that says "2019 –
Present" becomes a date. A phone number without a country code becomes a country.
A skills section becomes a set of proficiency levels nobody stated.

The whole KIASA data layer already refuses that distinction — a missing row means
*unknown*, never *no* — and résumé import is the single place where it would be
easiest to break. So:

| Step | What happens | Where |
|---|---|---|
| Upload | Browser → private `resumes` bucket, under the candidate's own session | `components/resume/ResumeUpload.tsx` |
| Extract | PDF text read **on this server**; the file never leaves it | `lib/resume/pdf-text.ts` |
| Parse | One OpenRouter call carrying only the extracted text | `lib/resume/openrouter.ts` |
| Draft | Stored in `resume_imports.extracted` — a proposal, not a fact | `lib/resume/imports.ts` |
| Review | Everything shown, everything editable, everything droppable | `components/resume/ReviewForm.tsx` |
| Confirm | Written through the candidate's own session and the ordinary data layer | `lib/resume/apply.ts` |

## Provenance

Only `verified_answers` carries a `source` column, and migration 9 reserves
`imported_from_resume` there for non-API roles. The profile tables — `profiles`,
`work_experiences`, `education_entries`, `skills` — have no provenance column,
so there is nowhere on those rows to record that a PDF suggested them.

That is the right outcome rather than a gap. Under parse → review → confirm the
data *is* user-entered by the time it lands, because a human asserted it. What a
model proposed and what a human accepted stay separable anyway: the
`resume_imports` row keeps the draft, the file, the model that read it and the
instant of confirmation.

The consequence worth knowing: **the confirm step needs no elevated role**. It
writes as the candidate, under the same RLS as the profile forms. Résumé import
adds no new path by which the secret key touches candidate data.

## What the confirm step will and will not do

1. **A null never overwrites.** Null means the résumé did not say, so it leaves
   whatever is on the profile alone. Importing a résumé with no phone number
   does not erase a phone number typed last week.
2. **Nothing is ever deleted.** Entries are added. A résumé that omits a job is
   not a statement that the job did not happen.
3. **Duplicates are skipped, not merged.** Matching is an exact match on the
   identifying fields — company + title + start date, institution + degree +
   start date, skill name case-insensitively. Wrongly merging two real roles at
   one employer is worse than listing one twice: a duplicate can be deleted, a
   merged-away role cannot be recovered.

## The provider, and what it receives

**OpenRouter is the only AI API this application may call.** There is no second
provider and no fallback — a fallback is a second thing to secure, a second
billing surface, and a second set of failure modes that only appear when the
first provider is already having a bad day. Direct Anthropic API use is
intentionally unsupported. Claude Max, if it is ever used, remains a separate
capability the user drives on their own computer; there is no backend path to it
and there must not be one.

**The PDF never leaves this server.** The earlier implementation base64-encoded
the file into the request, because that provider read PDFs natively. It worked,
and it meant a third party received the whole document — the embedded
photograph, the producer metadata, the revision history a PDF quietly carries.
Now `lib/resume/pdf-text.ts` extracts the text layer locally with `unpdf`
(2 MB, zero dependencies, no native module, no worker thread — the smallest
thing that runs on a Vercel Node runtime), and only that text is sent.

Local extraction also makes the failure modes honest. A scanned résumé has no
text layer; extracting here lets the product *say so* and offer the paste path,
instead of sending an empty document to a model and receiving a fluent,
entirely invented career history back.

Bounded before anything is sent: 10 MB file, 30 pages, 80 000 characters, a
20-second parse timeout, and a 200-character floor below which the document is
treated as a scan.

## Configuration

```
OPENROUTER_API_KEY=       # server-side only, never NEXT_PUBLIC_
OPENROUTER_BASE_URL=      # optional; defaults to https://openrouter.ai/api/v1
OPENROUTER_RESUME_MODEL=  # optional; defaults to google/gemini-2.5-flash
SUPABASE_SECRET_KEY=      # already required by the admin surface
```

The key is read in exactly one module (`lib/resume/openrouter.ts`), which begins
with `import 'server-only'` — so the build fails if anything reachable from a
client component imports it.

With `OPENROUTER_API_KEY` unset, `/profile/resume` says import is not switched on
and the profile can still be filled in by hand. Nothing else degrades.

On Vercel, add it as a plain (non-public) environment variable and redeploy.

**Both variables are required for the upload path, and neither has a default.**
`OPENROUTER_BASE_URL` and `OPENROUTER_RESUME_MODEL` do have defaults and may be
left unset. If `/profile/resume` says "not switched on yet" in an environment,
that is configuration rather than a code fault: one or both of
`OPENROUTER_API_KEY` and `SUPABASE_SECRET_KEY` is absent from it.

Two neighbouring paths need less. The paste console on `/profile` needs only
`SUPABASE_SECRET_KEY`, and `/profile/draft` — which runs on the candidate's own
computer — needs neither OpenRouter variable. See
`docs/PROFILE-DRAFTING-DESIGN.md` §5 for why those gates are deliberately
different.

## Migration

`supabase/migrations/20260908000020_resume_imports.sql` creates the
`resume_imports` table and the private `resumes` bucket, and ends with the usual
self-verifying `DO` block.

The security rules it encodes, all enforced by the database rather than by
application code:

- `authenticated` holds **SELECT and UPDATE only**. A candidate cannot create an
  import — that is the server's decision, because it commits us to a paid call.
- UPDATE is allowed only while the row is `parsed` or `failed`, and only into
  `parsed` or `discarded`. **A client cannot mark an import confirmed**, because
  "confirmed" asserts that rows were written to four other tables and only the
  writer can know that. A trigger says the same thing again for `current_user`.
- `user_id` and `storage_path` are immutable, so a reviewed draft cannot be
  repointed at a different upload.
- The bucket is **private**, PDF-only, 10 MB, and laid out as
  `<user id>/<import id>.pdf` — the first path segment is the owner, which is
  what all three storage policies compare against.

## Verification

`scripts/test-resume-import.mjs` runs against the local stack and checks all of
the above behaviourally with throwaway users: refused inserts, cross-user reads
and writes, self-confirmation, subject pinning, and — over plain HTTP, not by
reading a flag — that an uploaded résumé is not fetchable without a session.

It also checks `ResumeImportRow` in `lib/resume/imports.ts` against
`information_schema.columns` in both directions.

That type is no longer hand-written. `resume_imports` is present in the
generated `lib/supabase/database.types.ts`, and the row type is projected from
it:

```ts
type ResumeImportTable = Database['public']['Tables']['resume_imports'];

export interface ResumeImportRow
  extends Omit<ResumeImportTable['Row'], 'source_kind' | 'status' | 'failure_class'> {
  source_kind: 'upload' | 'pasted';
  status: ResumeImportStatus;
  failure_class: ExtractFailureClass | null;
}
```

Three columns are narrowed past what the generator can express: Postgres CHECK
constraints restrict them to a fixed vocabulary, and a CHECK is not a type the
generator can read, so it emits `string`. Those three are exactly what the
`information_schema` comparison in the test still guards. Nothing in that file
uses `as never` any more — a misspelled column is a compile error.

### Regenerating the types

```bash
npm run db:types
```

That is the only supported way, and it is not a convenience wrapper. It runs
the **pinned** Supabase CLI (an exact devDependency, asserted by
`npm run check:cli`), generates into a temporary file, validates the result,
and replaces the committed file only after that validation passes — so a failed
generation leaves the existing types untouched.

Do not generate types by redirecting a CLI into the file. A shell truncates the
target the moment it opens it, before the command has run at all, so a failure
leaves an empty `database.types.ts` and a broken build. For the same reason,
never invoke the CLI through `npx`: that downloads whatever the registry
currently calls latest instead of the version the migrations were proven
against. `scripts/test-docs-commands.mjs` fails the build if either pattern
reappears in documentation.
