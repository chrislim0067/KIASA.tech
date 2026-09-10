/**
 * Contact form handling on the content pages (port of `ContactForm.astro` script).
 * Validation, reCAPTCHA v3 token, attribution merge, JSON POST to the form action and the
 * `generate_lead` dataLayer event are identical to the original.
 */
interface ContactFormOptions {
  recaptchaSiteKey?: string;
  messages?: Record<string, string>;
  scrollOffset?: number;
  onSuccess?(result: unknown): void;
  onError?(result: { error?: string }): void;
}

interface GrecaptchaLike {
  ready(cb: () => void): void;
  execute(key: string, options: { action: string }): Promise<string>;
}

const DEFAULT_MESSAGES: Record<string, string> = {
  recaptcha_failed: 'Security check failed. If you use an ad blocker, please disable it for this page and try again.',
  spam_detected: 'Your submission was flagged as spam. Please try again.',
  server_error: 'Server error. Please try again later.',
  network: 'Network error. Check your connection.',
  default: 'There was an issue sending your message. Please try again.',
};

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const readStore = (store: 'sessionStorage' | 'localStorage', key: string): unknown => {
  try {
    return JSON.parse(window[store].getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

class ContactForm {
  private readonly options: Required<Pick<ContactFormOptions, 'scrollOffset'>> & ContactFormOptions;
  private readonly messages: Record<string, string>;
  private readonly globalError: HTMLElement | null;
  private readonly globalSuccess: HTMLElement | null;
  private readonly submitBtn: HTMLButtonElement | null;
  private isSubmitting = false;
  private leadEventFired = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly form: HTMLFormElement,
    options: ContactFormOptions = {},
  ) {
    this.options = { scrollOffset: 100, ...options };
    this.messages = { ...DEFAULT_MESSAGES, ...(options.messages ?? {}) };
    this.globalError = form.querySelector('[data-form-global-error]');
    this.globalSuccess = form.querySelector('[data-form-global-success]');
    this.submitBtn = form.querySelector('[type="submit"]');
    const onSubmit = (e: Event): void => void this.handleSubmit(e);
    form.addEventListener('submit', onSubmit);
    this.cleanups.push(() => form.removeEventListener('submit', onSubmit));
    form.querySelectorAll<Field>('input, textarea, select').forEach((field) => {
      const onBlur = (): void => void this.validateField(field);
      const onInput = (): void => {
        if (field.closest('.has-error')) this.validateField(field);
      };
      field.addEventListener('blur', onBlur);
      field.addEventListener('input', onInput);
      this.cleanups.push(() => {
        field.removeEventListener('blur', onBlur);
        field.removeEventListener('input', onInput);
      });
    });
    if (this.options.recaptchaSiteKey) this.loadRecaptcha();
  }

  private loadRecaptcha(): void {
    if (document.querySelector('script[src*="recaptcha"]')) return;
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${this.options.recaptchaSiteKey}`;
    script.async = true;
    document.head.appendChild(script);
  }

  private async getRecaptchaToken(): Promise<string> {
    const key = this.options.recaptchaSiteKey;
    if (!key) return '';
    const w = window as Window & { grecaptcha?: GrecaptchaLike };
    for (let i = 0; i < 30 && !w.grecaptcha; i++) await new Promise((r) => setTimeout(r, 100));
    if (!w.grecaptcha) return '';
    try {
      const g = w.grecaptcha;
      await new Promise<void>((resolve) => g.ready(resolve));
      return await g.execute(key, { action: 'submit' });
    } catch {
      return '';
    }
  }

  private getAttribution(): Record<string, string> {
    const out: Record<string, string> = { referrer: '', landing_page: '', utm_source: '', utm_medium: '', utm_campaign: '', journey: '', visit_count: '', first_visit: '' };
    const ttl = 720 * 60 * 60 * 1000;
    const keys = ['referrer', 'landing_page', 'utm_source', 'utm_medium', 'utm_campaign'];
    const apply = (rec: Record<string, unknown>): void => {
      keys.forEach((k) => {
        if (typeof rec[k] === 'string') out[k] = (rec[k] as string).slice(0, 300);
      });
    };
    const meaningful = (rec: Record<string, unknown> | null): boolean => !!rec && !!(rec.referrer || rec.utm_source || rec.utm_medium || rec.utm_campaign);
    const session = readStore('sessionStorage', 'utsubo_attr') as Record<string, unknown> | null;
    const local = readStore('localStorage', 'utsubo_attr') as Record<string, unknown> | null;
    const age = local && Number.isFinite(local.ts as number) ? Date.now() - (local.ts as number) : -1;
    const localValid = age >= 0 && age < ttl;
    if (meaningful(session)) apply(session!);
    else if (localValid && meaningful(local)) apply(local!);
    else if (session) apply(session);
    else if (localValid) apply(local!);
    if (localValid && local) {
      const visits = local.visits as number;
      out.visit_count = String(Number.isFinite(visits) && visits > 0 ? visits : 1);
      const first = new Date(local.ts as number);
      if (!Number.isNaN(first.getTime())) out.first_visit = first.toISOString().slice(0, 10);
    }
    const journey = readStore('sessionStorage', 'utsubo_journey');
    if (Array.isArray(journey)) out.journey = journey.filter((j): j is string => typeof j === 'string').slice(-10).map((j) => j.slice(0, 120)).join(' → ');
    return out;
  }

  private async handleSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.isSubmitting) return;
    this.hideMessages();
    if (!this.validate()) return;
    this.isSubmitting = true;
    this.setLoading(true);
    try {
      const token = await this.getRecaptchaToken();
      const tokenField = this.form.querySelector<HTMLInputElement>('[name="g-recaptcha-response"]');
      if (tokenField) tokenField.value = token;
      const data = new FormData(this.form);
      const payload: Record<string, unknown> = { ...Object.fromEntries(data.entries()), ...this.getAttribution() };
      const response = await fetch(this.form.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (result.ok) {
        if (!this.leadEventFired) {
          this.leadEventFired = true;
          window.dataLayer = window.dataLayer ?? [];
          window.dataLayer.push({
            event: 'generate_lead',
            event_id: window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            page_location: window.location.href,
            page_path: window.location.pathname,
            lead_landing_page: payload.page ?? window.location.pathname,
            lead_project_type: payload.projectType ?? '',
            lead_budget: payload.budget ?? '',
            lead_institution_type: payload.institutionType ?? '',
            lead_cta_source: payload.cta_source ?? '',
          });
        }
        this.showSuccess();
        this.form.reset();
        this.options.onSuccess?.(result);
      } else {
        this.showError(result.error);
        this.options.onError?.(result);
      }
    } catch {
      this.showError('network');
    } finally {
      this.isSubmitting = false;
      this.setLoading(false);
    }
  }

  private validate(): boolean {
    let valid = true;
    let firstInvalid: Field | null = null;
    this.getValidatableFields().forEach((field) => {
      if (!this.validateField(field)) {
        valid = false;
        firstInvalid = firstInvalid ?? field;
      }
    });
    if (!valid && firstInvalid) this.scrollToField(firstInvalid);
    return valid;
  }

  private scrollToField(field: Field): void {
    const top = (field.closest('.form-field') ?? field).getBoundingClientRect().top + window.scrollY - this.options.scrollOffset;
    window.scrollTo({ top, behavior: 'smooth' });
    setTimeout(() => field.focus(), 300);
  }

  private getValidatableFields(): NodeListOf<Field> {
    return this.form.querySelectorAll<Field>('input:not([type="hidden"]), textarea, select');
  }

  private validateField(field: Field): boolean {
    const name = field.getAttribute('name');
    if (!name) return true;
    const wrapper = field.closest('.form-field') ?? field.parentElement;
    const error = this.form.querySelector(`[data-error-for="${name}"]`);
    let valid = true;
    const input = field as HTMLInputElement;
    if (field.required && !String(field.value ?? '').trim()) valid = false;
    else if (input.type === 'email' && input.value) valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value.trim());
    else if (input.type === 'tel' && input.value && input.pattern) valid = new RegExp(input.pattern).test(input.value.trim());
    else if ('minLength' in field && field.minLength > 0 && field.value.length < field.minLength) valid = false;
    wrapper?.classList.toggle('has-error', !valid);
    error?.classList.toggle('show', !valid);
    return valid;
  }

  private setLoading(loading: boolean): void {
    this.submitBtn?.classList.toggle('is-loading', loading);
    if (this.submitBtn) this.submitBtn.disabled = loading;
  }

  private hideMessages(): void {
    this.globalError?.classList.remove('show');
    this.globalSuccess?.classList.remove('show');
  }

  private showError(code?: string): void {
    if (!this.globalError) return;
    this.globalError.textContent = (code && this.messages[code]) || this.messages.server_error || this.messages.default || '';
    this.globalError.classList.add('show');
  }

  private showSuccess(): void {
    this.globalSuccess?.classList.add('show');
  }

  dispose(): void {
    this.cleanups.forEach((c) => c());
  }
}

/** Installs the contact form + CTA scroll behaviour of a content page. Returns a disposer. */
export function installContactForm(): () => void {
  const form = document.querySelector<HTMLFormElement>('#contact-form');
  if (!form) return () => {};
  const key = form.getAttribute('data-recaptcha-key') ?? undefined;
  let messages: Record<string, string> | undefined;
  const messagesEl = form.querySelector('[data-form-messages]');
  if (messagesEl) {
    try {
      messages = JSON.parse(messagesEl.textContent ?? '{}') as Record<string, string>;
    } catch {
      messages = undefined;
    }
  }
  const controller = new ContactForm(form, {
    recaptchaSiteKey: key,
    messages,
    onSuccess: () => console.log('Form submitted successfully'),
    onError: (r) => console.error('Form error:', r.error),
  });
  const cleanups: Array<() => void> = [() => controller.dispose()];
  const nav = document.getElementById('contact-nav');
  if (nav) {
    const onNav = (e: Event): void => {
      e.preventDefault();
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    nav.addEventListener('click', onNav);
    cleanups.push(() => nav.removeEventListener('click', onNav));
  }
  const cta = document.getElementById('article-cta-link');
  if (cta) {
    const onCta = (e: Event): void => {
      e.preventDefault();
      window.dataLayer = window.dataLayer ?? [];
      window.dataLayer.push({ event: 'cta_click', cta_id: 'mid_article', page_path: window.location.pathname });
      let source = form.querySelector<HTMLInputElement>('input[name="cta_source"]');
      if (!source) {
        source = document.createElement('input');
        source.type = 'hidden';
        source.name = 'cta_source';
        form.appendChild(source);
      }
      source.setAttribute('value', 'mid_article');
      source.value = 'mid_article';
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    cta.addEventListener('click', onCta);
    cleanups.push(() => cta.removeEventListener('click', onCta));
  }
  return () => cleanups.forEach((c) => c());
}
