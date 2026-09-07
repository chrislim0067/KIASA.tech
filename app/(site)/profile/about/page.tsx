import type { Metadata } from 'next';

import ProfileShell from '@/components/profile/ProfileShell';
import ProfileForm from '@/components/profile/ProfileForm';
import { requireCandidate } from '@/lib/candidate/session';
import { saveAbout } from '@/lib/candidate/actions';
import { getProfile, TEXT_LIMITS } from '@/lib/profile';

/**
 * /profile/about — legal identity and contact.
 *
 * Three fields here block automation: legal first name, legal last name and
 * contact email. They are marked, and the reason is stated rather than left as
 * a red asterisk — a person filling in a form deserves to know why something is
 * demanded of them.
 *
 * `maxLength` on each input comes from TEXT_LIMITS, which mirrors the database
 * CHECK constraints. The database is still the authority; this only stops
 * someone typing 300 characters into a 100-character column and losing the
 * lot on submit.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'About you | KIASA',
  robots: { index: false, follow: false },
};

export default async function AboutPage() {
  const { supabase, user } = await requireCandidate();
  const result = await getProfile(supabase, user.id);
  const p = result.ok ? result.data : null;
  const L = TEXT_LIMITS.profiles;

  return (
    <ProfileShell
      title="About you"
      lede="Your legal name and contact details, as they should appear on an application."
      email={user.email ?? null}
      back
    >
      <ProfileForm action={saveAbout}>
        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Legal name</legend>
          <p className="kprof__hint" style={{ marginBottom: '0.9rem' }}>
            As it appears on your passport or right-to-work document — application forms ask for
            the legal name, not a preferred one.
          </p>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="legal_first_name">
                First name <span className="kprof__req">· required</span>
              </label>
              <input
                id="legal_first_name"
                name="legal_first_name"
                className="kprof__input"
                maxLength={L.legal_first_name}
                defaultValue={p?.legal_first_name ?? ''}
                autoComplete="given-name"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="legal_middle_name">
                Middle name
              </label>
              <input
                id="legal_middle_name"
                name="legal_middle_name"
                className="kprof__input"
                maxLength={L.legal_middle_name}
                defaultValue={p?.legal_middle_name ?? ''}
                autoComplete="additional-name"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="legal_last_name">
                Last name <span className="kprof__req">· required</span>
              </label>
              <input
                id="legal_last_name"
                name="legal_last_name"
                className="kprof__input"
                maxLength={L.legal_last_name}
                defaultValue={p?.legal_last_name ?? ''}
                autoComplete="family-name"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="preferred_name">
                Preferred name
              </label>
              <input
                id="preferred_name"
                name="preferred_name"
                className="kprof__input"
                maxLength={L.preferred_name}
                defaultValue={p?.preferred_name ?? ''}
                placeholder="What you like to be called"
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Contact</legend>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="contact_email">
                Contact email <span className="kprof__req">· required</span>
              </label>
              <input
                id="contact_email"
                name="contact_email"
                type="email"
                className="kprof__input"
                maxLength={L.contact_email}
                defaultValue={p?.contact_email ?? ''}
                autoComplete="email"
              />
              <span className="kprof__hint">
                Can differ from your sign-in address ({user.email}) — this is the one that goes on
                applications.
              </span>
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="phone_e164">
                Phone
              </label>
              <input
                id="phone_e164"
                name="phone_e164"
                className="kprof__input"
                defaultValue={p?.phone_e164 ?? ''}
                placeholder="+447700900123"
                autoComplete="tel"
              />
              <span className="kprof__hint">
                International format, starting with +. Rejected otherwise.
              </span>
            </div>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Where you are</legend>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="city">
                City
              </label>
              <input
                id="city"
                name="city"
                className="kprof__input"
                maxLength={L.city}
                defaultValue={p?.city ?? ''}
                autoComplete="address-level2"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="state_region">
                State or region
              </label>
              <input
                id="state_region"
                name="state_region"
                className="kprof__input"
                maxLength={L.state_region}
                defaultValue={p?.state_region ?? ''}
                autoComplete="address-level1"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="country_code">
                Country
              </label>
              <input
                id="country_code"
                name="country_code"
                className="kprof__input"
                maxLength={2}
                defaultValue={p?.country_code ?? ''}
                placeholder="GB"
                style={{ textTransform: 'uppercase' }}
              />
              <span className="kprof__hint">Two-letter code, e.g. GB, US, SG.</span>
            </div>
          </div>
        </fieldset>

        <fieldset className="kprof__fieldset">
          <legend className="kprof__legend">Links</legend>
          <div className="kprof__grid">
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="linkedin_url">
                LinkedIn
              </label>
              <input
                id="linkedin_url"
                name="linkedin_url"
                type="url"
                className="kprof__input"
                defaultValue={p?.linkedin_url ?? ''}
                placeholder="https://linkedin.com/in/…"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="github_url">
                GitHub
              </label>
              <input
                id="github_url"
                name="github_url"
                type="url"
                className="kprof__input"
                defaultValue={p?.github_url ?? ''}
                placeholder="https://github.com/…"
              />
            </div>
            <div className="kprof__field">
              <label className="kprof__label" htmlFor="portfolio_url">
                Portfolio
              </label>
              <input
                id="portfolio_url"
                name="portfolio_url"
                type="url"
                className="kprof__input"
                defaultValue={p?.portfolio_url ?? ''}
                placeholder="https://…"
              />
            </div>
          </div>
        </fieldset>
      </ProfileForm>
    </ProfileShell>
  );
}
