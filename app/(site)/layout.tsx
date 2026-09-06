import type { Metadata, Viewport } from 'next';
import '@/app/globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#020204',
};

export const metadata: Metadata = {
  metadataBase: new URL('https://kiasa.tech'),
  icons: { icon: '/Assets/Favicon.png' },
  // The original carried a google-site-verification token belonging to the
  // previous brand's Search Console property. It is meaningless for this domain
  // and was removed rather than carried over — add KIASA's own token here.
};

/** Root layout for the English pages (lang="en", dir="ltr"). */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
