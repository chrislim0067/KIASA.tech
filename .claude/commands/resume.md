---
description: Read a résumé PDF into KIASA's import format, ready to paste into the console
argument-hint: <path to a résumé PDF>
allowed-tools: Read, Bash, Glob
---

Read the résumé at `$ARGUMENTS` and turn it into the JSON the KIASA import console
accepts. This uses the operator's own Claude subscription rather than the
platform's API key, so it costs nothing per résumé.

## 1. Get the schema

Read `lib/resume/schema.ts` in this repository. It is the ONLY authority for the
field names, the vocabularies and the length limits — they mirror the database's
own CHECK constraints, so a draft that satisfies it is one the profile tables
will accept. Do not work from memory of this file, and do not rely on the
summary below where the two disagree.

Note in particular:

- every field is nullable, and `null` is the expected value for anything the
  résumé does not state
- `work_experiences`, `education_entries`, `skills` and `unreadable_sections`
  are arrays, `[]` when there is nothing
- the enums (`employment_type`, `work_mode`, `proficiency`) accept only the
  listed values
- dates are `YYYY-MM-DD`, with a matching `*_precision` of `day`, `month` or
  `year` saying how precise the page actually was

## 2. Read the PDF

Read `$ARGUMENTS` with the Read tool. If no path was given, ask for one. If the
file is not a PDF, say so and stop.

If it is longer than 20 pages, read it in batches with the `pages` parameter and
combine the result.

## 3. Transcribe it

You are transcribing, not interpreting. The candidate will be shown exactly what
you produce and asked to confirm it, so anything invented either wastes their
time or gets confirmed unnoticed and then stated on their behalf in a real job
application.

1. **If the document does not say it, use `null`.** Not a guess, not a sensible
   default, not an inference. A city does not tell you a country. An area code
   does not tell you a country. A job title does not tell you an employment
   type. A list of technologies does not tell you a proficiency level.
2. **Do not improve the writing.** Copy descriptions across as written, one
   bullet per line. Do not summarise, condense or re-word — this is the
   candidate's own account of their work.
3. **Reformat only where the schema demands it** — a phone number into E.164, a
   date into `YYYY-MM-DD`, a country into a two-letter code. If the information
   the format needs is not on the page, use `null` instead.
4. **Transcribe every role, qualification and listed skill**, even where they
   repeat or overlap in time. It is not your job to tidy someone's history.
5. **Say what defeated you** in `unreadable_sections` rather than producing a
   thin result that looks complete.

## 4. Check it before handing it over

Re-read your JSON against the schema and confirm, explicitly:

- every enum value is one of the permitted strings
- every `*_precision` is `day`, `month`, `year`, or `null` when its date is null
- no string exceeds its limit
- country codes are two uppercase letters
- no field was invented — each non-null value is traceable to something printed
  on the page

Fix anything that fails before continuing.

## 5. Put it on the clipboard

Write the JSON — and nothing else: no fence, no commentary — to a file in the
scratchpad directory, then put it on the clipboard with PowerShell:

```
Get-Content "<the file you just wrote>" -Raw | Set-Clipboard
```

Piping through a file rather than passing the JSON as a command argument is
deliberate: a résumé contains quotes, apostrophes and non-ASCII characters that
a shell will mangle, and `-Raw` preserves the text exactly.

Leave the file in the scratchpad — it is the fallback if the clipboard is
cleared before they paste. Tell them where it is.

## 6. Tell them what to do next

Report, briefly:

- what was found — how many roles, qualifications and skills
- anything in `unreadable_sections`
- anything you had to leave `null` that they would probably expect to be filled,
  and why the page did not support it

Then: **it is on your clipboard — open kiasa.tech/profile, click "Import your
résumé", and paste into box 2.** Nothing reaches their profile until they review
it and confirm.
