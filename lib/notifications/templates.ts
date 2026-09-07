import 'server-only';

import type { OutboundEmail } from '@/lib/notifications/email';

/**
 * Notification templates.
 *
 * Written as plain strings rather than a rendering library: two emails do not
 * justify a dependency, and inline-styled HTML with a table layout is what
 * actually survives Outlook and Gmail. Every message ships text alongside HTML.
 *
 * Tone: these go to a real person who has been waiting on a decision. The
 * approval is warm and tells them what to do next; the rejection is short,
 * clear, and does not pad a "no" with false encouragement.
 */

/** Escape anything interpolated into the HTML body. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shell every message shares.
 *
 * Dark to match the product, but with an explicit background on the outer table
 * — several clients ignore body styling, and a dark-on-dark email that renders
 * as black-on-white is unreadable.
 */
function shell(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f6;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0b0b12;border:1px solid #2a2038;border-radius:4px;">
        <tr><td style="padding:28px 28px 8px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:4px;color:#d8b4fe;font-weight:bold;">KIASA</div>
        </td></tr>
        <tr><td style="padding:8px 28px 4px;">
          <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;color:#ffffff;">${esc(heading)}</h1>
        </td></tr>
        <tr><td style="padding:12px 28px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#c8cbd9;">
          ${bodyHtml}
        </td></tr>
      </table>
      <div style="max-width:520px;margin:14px auto 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#8a8f9e;text-align:center;">
        You are receiving this because an account was created at kiasa.tech with this address.
      </div>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px;">
    <tr><td style="background:#d8b4fe;border-radius:3px;">
      <a href="${esc(href)}" style="display:inline-block;padding:11px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#12001f;text-decoration:none;letter-spacing:1px;">${esc(label)}</a>
    </td></tr>
  </table>`;
}

export function approvedEmail(params: {
  readonly to: string;
  readonly siteUrl: string;
  readonly name?: string | null;
}): OutboundEmail {
  const greeting = params.name ? `Hi ${params.name},` : 'Hi,';
  const signInUrl = `${params.siteUrl.replace(/\/$/, '')}/login`;

  return {
    to: params.to,
    subject: 'Your KIASA account is approved',
    text: [
      greeting,
      '',
      'Your KIASA account has been approved. You can sign in now:',
      signInUrl,
      '',
      'If you already have KIASA open, the page will update on its own.',
      '',
      '— KIASA',
    ].join('\n'),
    html: shell(
      'Your account is approved',
      `<p style="margin:0 0 14px;">${esc(greeting)}</p>
       <p style="margin:0 0 14px;">Your KIASA account has been approved. You can sign in and start using it now.</p>
       ${button(signInUrl, 'Sign in to KIASA')}
       <p style="margin:16px 0 0;font-size:13px;color:#8a8f9e;">If you already have KIASA open in a tab, it will update on its own — no need to reload.</p>`
    ),
  };
}

export function rejectedEmail(params: {
  readonly to: string;
  readonly siteUrl: string;
  readonly name?: string | null;
  readonly reason?: string | null;
}): OutboundEmail {
  const greeting = params.name ? `Hi ${params.name},` : 'Hi,';
  const reason = params.reason?.trim();

  return {
    to: params.to,
    subject: 'About your KIASA account',
    text: [
      greeting,
      '',
      'Your request to join KIASA was not approved.',
      ...(reason ? ['', `Reason: ${reason}`] : []),
      '',
      'If you think this is a mistake, reply to this email and a person will look at it.',
      '',
      '— KIASA',
    ].join('\n'),
    html: shell(
      'About your KIASA account',
      `<p style="margin:0 0 14px;">${esc(greeting)}</p>
       <p style="margin:0 0 14px;">Your request to join KIASA was not approved.</p>
       ${
         reason
           ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;">
                <tr><td style="padding:12px 14px;background:#150f1e;border-left:3px solid #ff8fa3;">
                  <div style="font-size:11px;letter-spacing:2px;color:#8a8f9e;text-transform:uppercase;margin-bottom:5px;">Reason</div>
                  <div style="color:#e6e8f0;">${esc(reason)}</div>
                </td></tr>
              </table>`
           : ''
       }
       <p style="margin:0;font-size:13px;color:#8a8f9e;">If you think this is a mistake, reply to this email and a person will look at it.</p>`
    ),
  };
}
