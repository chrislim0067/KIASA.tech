import Link from 'next/link';
import { Rajdhani, Syncopate } from 'next/font/google';
import type { ReactNode } from 'react';

import '@/styles/profile.css';

const syncopate = Syncopate({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--kprof-font-head',
});

const rajdhani = Rajdhani({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--kprof-font-body',
});

/**
 * Frame for the candidate profile screens.
 *
 * Rendering this is not an authorization decision — it is only ever reached
 * from a page that has already awaited `requireCandidate()`, which checks both
 * the session and the approval status.
 */
export default function ProfileShell({
  title,
  lede,
  email,
  back,
  children,
}: {
  title: string;
  lede?: ReactNode;
  email: string | null;
  /** Shown when this is a sub-page rather than the hub. */
  back?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`kprof ${syncopate.variable} ${rajdhani.variable}`}>
      <header className="kprof__bar">
        {/*
          Plain <a> for "/" only, matching AuthShell: the marketing pages
          initialise on a real document load, and a client-side navigation
          leaves their runtime inert.
        */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="kprof__brand">
          KIASA
        </a>

        <div className="kprof__who">
          <span>{email ?? 'Signed in'}</span>
          <Link href="/dashboard" className="kprof__back" style={{ margin: 0 }}>
            Dashboard
          </Link>
        </div>
      </header>

      <main className="kprof__main">
        {back ? (
          <Link href="/profile" className="kprof__back">
            ← Profile
          </Link>
        ) : null}
        <h1 className="kprof__heading">{title}</h1>
        {lede ? <p className="kprof__lede">{lede}</p> : null}
        {children}
      </main>
    </div>
  );
}
