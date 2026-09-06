import { extraMeta, getPage, readJsonLd, readMarkup } from '@/lib/pages';
import LegacyRuntime from '@/components/legacy/LegacyRuntime';

const WRAPPER_ID = '__legacy_root';

/**
 * Renders one extracted page.
 *
 * Markup is emitted server-side byte-for-byte, so the DOM the original scripts
 * query is identical to the DOM they were written against. Stylesheets are
 * linked rather than bundled to keep the original cascade order intact —
 * including for the ?s= / ?slug= families, where the stylesheet varies per
 * request and a static import could not.
 */
export default function LegacyPage({ pageKey }: { pageKey: string }) {
  const page = getPage(pageKey);
  const markup = readMarkup(pageKey);
  const jsonLd = readJsonLd(pageKey);

  return (
    <>
      {/* React 19 hoists these into <head>, preserving order. */}
      {page.stylesheets.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      {page.hasCss && <link rel="stylesheet" href={`/generated/${pageKey}/page.css`} />}
      {extraMeta(page).map((m, i) => (
        <meta
          key={`${m.name ?? m.property}-${i}`}
          {...(m.name ? { name: m.name } : { property: m.property })}
          content={m.content}
        />
      ))}
      {jsonLd.map((block, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: block }} />
      ))}

      {/*
        Must be in the document before any module script resolves a bare
        specifier. LegacyRuntime injects the module scripts after hydration, so
        server-rendering the map here is early enough; without it every
        `import ... from 'three'` throws and the WebGL scenes never start.
      */}
      {page.importMap && <script type="importmap" dangerouslySetInnerHTML={{ __html: page.importMap }} />}

      {/* Dissolved by LegacyRuntime before any legacy script runs — see that file. */}
      <div id={WRAPPER_ID} dangerouslySetInnerHTML={{ __html: markup }} />

      <LegacyRuntime scripts={page.scripts} wrapperId={WRAPPER_ID} />
    </>
  );
}
