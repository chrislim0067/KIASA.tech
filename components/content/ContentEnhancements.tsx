'use client';

import { useEffect } from 'react';
import { installContactForm } from '@/lib/content/contact-form';
import { installCopyBlocks, installFaq, installXPosts } from '@/lib/content/enhancements';
import { installOutboundTracking } from '@/lib/content/track-outbound';

/**
 * Re-attaches the behaviours of the static content pages (they were inline scripts in the
 * original build) and removes them again when the page unmounts.
 */
export function ContentEnhancements({ features }: { features: string[] }) {
  useEffect(() => {
    const disposers: Array<() => void> = [installOutboundTracking()];
    if (features.includes('contact-form')) disposers.push(installContactForm());
    if (features.includes('copy-blocks')) disposers.push(installCopyBlocks());
    if (features.includes('faq')) disposers.push(installFaq());
    if (features.includes('x-posts')) disposers.push(installXPosts());
    document.documentElement.setAttribute('data-content-ready', '');
    return () => {
      document.documentElement.removeAttribute('data-content-ready');
      disposers.forEach((d) => d());
    };
  }, [features]);
  return null;
}
