/**
 * Generates app/ route files from the extraction manifest.
 *
 * Two root layouts via route groups: (site) is en/ltr, (ar) is ar/rtl. Nested
 * layouts cannot own <html>, and a client-side lang/dir swap would flash LTR
 * before flipping — route groups give the correct direction server-rendered.
 *
 * Re-runnable; overwrites only the generated page.tsx files.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'generated', 'pages.json'), 'utf8'));

const write = (rel, body) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

/* ------------------------------------------------------------- root layouts */

const layout = (lang, dir, group) => `import type { Metadata, Viewport } from 'next';
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

/** Root layout for the ${group} pages (lang="${lang}", dir="${dir}"). */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="${lang}" dir="${dir}">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
`;

write('app/(site)/layout.tsx', layout('en', 'ltr', 'English'));
write('app/(ar)/layout.tsx', layout('ar', 'rtl', 'Arabic'));

/* -------------------------------------------------------------------- pages */

// route -> variants
const byRoute = new Map();
for (const p of Object.values(manifest)) {
  if (!byRoute.has(p.route)) byRoute.set(p.route, []);
  byRoute.get(p.route).push(p);
}

let simple = 0;
let families = 0;

for (const [route, variants] of byRoute) {
  const isAr = route.startsWith('/ar/');
  const group = isAr ? '(ar)' : '(site)';
  const dir = route === '/' ? '' : route.replace(/^\//, '');
  const file = `app/${group}${dir ? '/' + dir : ''}/page.tsx`;

  const withParam = variants.filter((v) => v.param);

  if (withParam.length === 0) {
    const key = variants[0].key;
    simple++;
    write(
      file,
      `import type { Metadata } from 'next';
import LegacyPage from '@/components/legacy/LegacyPage';
import { buildMetadata } from '@/lib/pages';

const KEY = ${JSON.stringify(key)};

export const metadata: Metadata = buildMetadata(KEY);

export default function Page() {
  return <LegacyPage pageKey={KEY} />;
}
`
    );
    continue;
  }

  // ?s= / ?slug= family: one route, variant chosen from the query string,
  // exactly as the PHP page did with $_GET.
  const paramName = withParam[0].param.name;
  const segment = variants[0].segment;
  families++;
  write(
    file,
    `import type { Metadata } from 'next';
import LegacyPage from '@/components/legacy/LegacyPage';
import { buildMetadata, resolveKey } from '@/lib/pages';

const SEGMENT = ${JSON.stringify(segment)};
const PARAM = ${JSON.stringify(paramName)};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function pick(sp: Record<string, string | string[] | undefined>): string {
  const raw = sp[PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return resolveKey(SEGMENT, value);
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  return buildMetadata(pick(await searchParams));
}

export default async function Page({ searchParams }: Props) {
  return <LegacyPage pageKey={pick(await searchParams)} />;
}
`
  );
}

console.log(`layouts=2  simpleRoutes=${simple}  paramRoutes=${families}  total=${simple + families}`);
for (const [route, variants] of [...byRoute].sort()) {
  console.log('  ' + route.padEnd(30) + (variants.length > 1 ? variants.length + ' variants' : ''));
}
