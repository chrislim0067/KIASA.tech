import 'server-only';

/**
 * Outbound notification email.
 *
 * Sends through Resend's HTTP API with `fetch` — no npm dependency, because a
 * mail SDK would be several hundred kilobytes of serverless bundle to build one
 * JSON request. Swapping providers means changing `deliver()` and nothing else.
 *
 * THREE RULES, and each exists because of how this gets used.
 *
 * 1. NEVER THROWS. Approving a candidate is the important part; telling them
 *    about it is secondary. If the mail provider is down, the approval must
 *    still succeed — an administrator retrying a failed approval because the
 *    email bounced would be a worse outcome than a missing email.
 *
 * 2. NEVER BLOCKS the decision. Callers await it, but a slow provider cannot
 *    hold the request open indefinitely: there is a hard timeout below.
 *
 * 3. DEGRADES HONESTLY. With no API key configured it does not pretend to
 *    send — it returns `not_configured`, the caller records that in the audit
 *    log, and the admin UI can say "approved, but no email was sent". Silently
 *    doing nothing is how you end up believing users were notified when they
 *    were not.
 */

export const EMAIL_API_KEY_VAR = 'RESEND_API_KEY';
export const EMAIL_FROM_VAR = 'EMAIL_FROM';

/** Sending must not hold a serverless invocation open. */
const SEND_TIMEOUT_MS = 8_000;

export type EmailResult =
  | { readonly sent: true; readonly id: string | null }
  | { readonly sent: false; readonly reason: 'not_configured' | 'rejected' | 'timeout' | 'error' };

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  /** Plain text. Always sent — some clients prefer it, and it is the accessible fallback. */
  readonly text: string;
  readonly html: string;
}

/**
 * Deliver one message.
 *
 * The recipient address is never logged: a log aggregator should not slowly
 * become a list of who was rejected. Only the domain and the outcome are
 * recorded, which is enough to diagnose a provider problem.
 */
export async function sendEmail(message: OutboundEmail): Promise<EmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) return { sent: false, reason: 'not_configured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(
        JSON.stringify({
          level: 'error',
          scope: 'email',
          event: 'rejected',
          status: response.status,
          // Domain only — never the address.
          recipient_domain: message.to.split('@')[1] ?? null,
          detail: detail.slice(0, 300),
          at: new Date().toISOString(),
        })
      );
      return { sent: false, reason: 'rejected' };
    }

    const body: { id?: string } = await response.json().catch(() => ({}));
    return { sent: true, id: body.id ?? null };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    console.error(
      JSON.stringify({
        level: 'error',
        scope: 'email',
        event: aborted ? 'timeout' : 'error',
        recipient_domain: message.to.split('@')[1] ?? null,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      })
    );
    return { sent: false, reason: aborted ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timeout);
  }
}
