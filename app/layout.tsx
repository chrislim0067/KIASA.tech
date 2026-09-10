import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GoogleTagManagerNoScript, GoogleTagManagerScript } from '@/components/GoogleTagManager';

export const metadata: Metadata = {
  metadataBase: new URL('https://www.utsubo.com'),
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/icons/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  manifest: '/icons/site.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#000203',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <GoogleTagManagerNoScript />
        {children}
        <GoogleTagManagerScript />
      </body>
    </html>
  );
}
