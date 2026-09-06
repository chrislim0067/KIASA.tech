import { Rajdhani, Syncopate } from 'next/font/google';
import type { ReactNode } from 'react';

import '@/styles/auth.css';

/**
 * The same two faces the marketing pages use, loaded through next/font so they
 * are self-hosted and preloaded rather than fetched from the Google CDN at
 * runtime. Exposed as CSS variables that styles/auth.css consumes, with the
 * family names kept as fallbacks so the pages still look right if the font
 * request fails.
 */
const syncopate = Syncopate({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--kauth-font-head',
});

const rajdhani = Rajdhani({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--kauth-font-body',
});

/** Shared frame for the auth screens and the temporary dashboard. */
export default function AuthShell({
  title,
  subtitle,
  children,
  variant = 'card',
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  variant?: 'card' | 'dashboard';
}) {
  const classes = [
    'kauth',
    variant === 'dashboard' ? 'kauth--dash' : '',
    syncopate.variable,
    rajdhani.variable,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <main className={classes}>
      <div className={variant === 'dashboard' ? 'kauth__panel' : 'kauth__card'}>
        {/*
          A plain <a>, not next/link, and it must stay that way. The marketing
          pages are a multi-page app that only initialises on a document load —
          a client-side navigation leaves their import map inert and the hero
          module unable to resolve "three". See app/auth/signout/route.ts.
        */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
            The rule assumes every route can be entered by client-side
            navigation. "/" cannot: following its advice here is what caused the
            stuck-loader bug this comment exists to prevent. */}
        <a href="/" className="kauth__brand">
          KIASA
        </a>
        <h1 className={variant === 'dashboard' ? 'kauth__welcome' : 'kauth__title'}>{title}</h1>
        {subtitle ? <p className="kauth__subtitle">{subtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}
