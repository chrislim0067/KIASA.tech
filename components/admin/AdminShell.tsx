import Link from 'next/link';
import { Rajdhani, Syncopate } from 'next/font/google';
import type { ReactNode } from 'react';

import LivePulse from '@/components/admin/LivePulse';
import '@/styles/admin.css';

/**
 * The same two faces AuthShell loads, through next/font so they are self-hosted
 * and preloaded. Exposed under the --kadmin-* variable names styles/admin.css
 * consumes, with the family names kept as fallbacks.
 */
const syncopate = Syncopate({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--kadmin-font-head',
});

const rajdhani = Rajdhani({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--kadmin-font-body',
});

export interface AdminNavItem {
  readonly href: string;
  readonly label: string;
}

const NAV: readonly AdminNavItem[] = Object.freeze([
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/audit', label: 'Audit' },
]);

/**
 * Frame for every administrator screen.
 *
 * Rendering this shell is NOT an authorization decision. It is only ever
 * reached from a page that has already awaited `requireAdmin()`; the navigation
 * it draws is a convenience for someone who is already permitted, and hiding it
 * from anyone else would protect nothing on its own.
 */
export default function AdminShell({
  title,
  lede,
  actorEmail,
  currentPath,
  children,
}: {
  title: string;
  lede?: ReactNode;
  actorEmail: string | null;
  currentPath: string;
  children: ReactNode;
}) {
  const classes = ['kadmin', syncopate.variable, rajdhani.variable].join(' ');

  /** `/admin` must not light up while you are on `/admin/users`. */
  const isCurrent = (href: string) =>
    href === '/admin' ? currentPath === '/admin' : currentPath.startsWith(href);

  return (
    <div className={classes}>
      <header className="kadmin__bar">
        {/*
          Plain <a>, not next/link, for the same reason AuthShell uses one: the
          marketing pages only initialise on a real document load, so a
          client-side navigation out of /admin would leave them inert.
        */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="kadmin__brand">
          KIASA
        </a>
        <span className="kadmin__tag">Admin</span>

        <nav className="kadmin__nav" aria-label="Administrator">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="kadmin__navLink"
              aria-current={isCurrent(item.href) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="kadmin__who">
          {/* Polls a four-integer endpoint and refreshes the page when the
              approval queue changes. See components/admin/LivePulse.tsx. */}
          <LivePulse />
          <span>{actorEmail ?? 'Signed in'}</span>
          <Link href="/dashboard" className="kadmin__navLink">
            Exit
          </Link>
        </div>
      </header>

      <main className="kadmin__main">
        <h1 className="kadmin__heading">{title}</h1>
        {lede ? <p className="kadmin__lede">{lede}</p> : null}
        {children}
      </main>
    </div>
  );
}
