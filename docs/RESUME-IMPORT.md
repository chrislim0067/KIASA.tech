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
| Parse | One Claude call, PDF sent inline as a base64 document block | `lib/resume/extract.ts` |
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

## Configuration

```
ANTHROPIC_API_KEY=      # server-side only, never NEXT_PUBLIC_
SUPABASE_SECRET_KEY=    # already required by the admin surface
```

Read in exactly one module (`lib/resume/extract.ts`), which begins with
`import 'server-only'` — so the build fails if anything reachable from a client
component imports it.

With `ANTHROPIC_API_KEY` unset, `/profile/resume` says import is not switched on
and the profile can still be filled in by hand. Nothing else degrades.

On Vercel, add it as a plain (non-public) environment variable and redeploy.

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
