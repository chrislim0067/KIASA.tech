'use client';

import { useState } from 'react';

/**
 * The employer's logo, with a lettered fallback.
 *
 * A plain `<img>` rather than `next/image`, for two reasons. The source is an
 * arbitrary employer host that nobody can enumerate ahead of time, and
 * `next/image` would need every one declared in `remotePatterns` or it throws
 * at render; and this project already sets `images: { unoptimized: true }`, so
 * there is nothing to gain by routing a 40px logo through the optimiser.
 *
 * `onError` matters more than it looks. Logo URLs rot — postings come down,
 * CDNs expire, hotlinking gets blocked — and without this the row would show a
 * broken-image glyph forever. Falling back to the initial keeps it intact.
 */
export default function CompanyMark({
  src,
  name,
  className = 'kjobs__logo',
}: {
  src: string | null;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = (name.trim()[0] ?? '?').toUpperCase();

  if (!src || failed) {
    return (
      <span className={className} aria-hidden="true">
        {initial}
      </span>
    );
  }

  return (
    <span className={`${className} ${className}--image`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={`${name} logo`}
        loading="lazy"
        // Employer hosts do not need to know which of their postings an
        // administrator is reading, and some block foreign referers outright.
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </span>
  );
}
