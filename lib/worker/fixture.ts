import type { Tri } from '@/lib/agent/safety';

/**
 * Reading a page into the structured observation the control plane evaluates.
 *
 * PURE, and NO BROWSER IS DRIVEN. This reads the local development fixture in
 * `scripts/fixtures/employer-form.html` with bounded scanning and produces the
 * same `PageObservation` shape a real adapter would. Browser automation is a
 * later, separately reviewed milestone; what is proven here is the CONTROL
 * PLANE's half — that each page kind produces the right verdict — which is the
 * half that decides whether anything gets typed anywhere.
 *
 * THE ONE RULE
 *
 * A reader reports; it never judges. Every field below is a tri-state and
 * `unknown` is a real answer, because a reader that cannot describe a page
 * must say so rather than defaulting to "nothing alarming here". The judgement
 * belongs to `lib/agent/safety.ts`, where it fails closed.
 *
 * WHY THE FIXTURE HAS FIVE HAZARD PAGES
 *
 * A login wall, a challenge, an MFA prompt and a document-details form all
 * render inputs, labels and a submit button. They are indistinguishable from
 * an ordinary application form by shape alone, which is exactly how a naive
 * worker types a candidate's details into a login attempt.
 */

export type FixturePage = 'ordinary' | 'login' | 'captcha' | 'mfa' | 'sensitive' | 'unknown';

/** A field the worker could fill, and what it would need to fill it. */
export interface ObservedField {
  name: string;
  /** The verified candidate fact that answers it, when one does. */
  factKey: string | null;
  /** Set when the field asks for something no machine may supply. */
  sensitiveKind: string | null;
  /** Set when the field needs writing rather than looking up. */
  requiresDraft: boolean;
  kind: 'text' | 'email' | 'number' | 'date' | 'file' | 'password' | 'textarea';
}

/**
 * What a reader saw. Tri-states throughout, deliberately.
 */
export interface PageObservation {
  page: FixturePage;
  /** Did this look like an application form we recognise? */
  page_recognised: Tri;
  /** Is the site one an adapter supports? */
  site_supported: Tri;
  login_wall_present: Tri;
  captcha_present: Tri;
  mfa_required: Tri;
  sensitive_information_requested: Tri;
  fields: ObservedField[];
  /** Fields we could fill from verified facts. */
  fillable: ObservedField[];
}

const SECTION = (html: string, page: FixturePage): string | null => {
  const open = html.indexOf(`data-page="${page}"`);
  if (open === -1) return null;
  const start = html.lastIndexOf('<section', open);
  const end = html.indexOf('</section>', open);
  return start === -1 || end === -1 ? null : html.slice(start, end);
};

/** Every `<input>` and `<textarea>` in a section, with its annotations. */
function readFields(section: string): ObservedField[] {
  const fields: ObservedField[] = [];
  const tag = /<(input|textarea)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(section)) !== null) {
    const attrs = m[2];
    const attr = (name: string) => {
      const a = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return a ? a[1] : null;
    };
    const type = m[1] === 'textarea' ? 'textarea' : (attr('type') ?? 'text');
    fields.push({
      name: attr('name') ?? attr('id') ?? '(unnamed)',
      factKey: attr('data-fact'),
      sensitiveKind: attr('data-sensitive'),
      requiresDraft: attr('data-requires') === 'drafted_answer',
      kind: type as ObservedField['kind'],
    });
  }
  return fields;
}

/**
 * Read one page of the fixture.
 *
 * An unparseable or missing page returns EVERYTHING UNKNOWN rather than
 * throwing or returning an empty-but-clean observation. That is the whole
 * difference between failing closed and failing open: `unknown` stops in the
 * evaluator, an empty observation proceeds.
 */
export function readFixturePage(html: string, page: FixturePage): PageObservation {
  const section = SECTION(html, page);
  if (!section) {
    return {
      page,
      page_recognised: 'unknown',
      site_supported: 'unknown',
      login_wall_present: 'unknown',
      captcha_present: 'unknown',
      mfa_required: 'unknown',
      sensitive_information_requested: 'unknown',
      fields: [],
      fillable: [],
    };
  }

  const kind = section.match(/data-kind="([a-z_]+)"/)?.[1] ?? 'unknown';
  const fields = readFields(section);

  const isForm = kind === 'application_form';
  const hasSensitive = fields.some((f) => f.sensitiveKind !== null);

  const observation: PageObservation = {
    page,
    // Recognised ONLY when it is an application form. A login wall is a page we
    // successfully identified — as something else.
    page_recognised: isForm ? 'yes' : 'no',
    // The fixture is a supported adapter by definition; a real reader would
    // answer from its adapter registry.
    site_supported: 'yes',
    login_wall_present: kind === 'login_wall' ? 'yes' : 'no',
    captcha_present: kind === 'challenge' ? 'yes' : 'no',
    mfa_required: kind === 'mfa_prompt' ? 'yes' : 'no',
    sensitive_information_requested: hasSensitive ? 'yes' : 'no',
    fields,
    // FILLABLE MEANS: it names a verified fact, is not sensitive, and does not
    // need drafting. Everything else is either looked up elsewhere or stopped.
    fillable: fields.filter(
      (f) => f.factKey !== null && f.sensitiveKind === null && !f.requiresDraft
    ),
  };
  return observation;
}

/**
 * The fields on this page that need a model to write them.
 *
 * Separated from `fillable` because they take a different route: a routine
 * field is looked up from a verified fact, while these go to the candidate's
 * own Claude (or the paste console) and come back to be validated.
 */
export const draftableFields = (o: PageObservation): ObservedField[] =>
  o.fields.filter((f) => f.requiresDraft);
