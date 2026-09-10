import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { ExperienceShell } from '@/features/experience/ExperienceShell';
import { detectLangFromPath } from '@/features/experience/runtime/lang';
import '@/styles/experience.css';

/**
 * Layout of the WebGL experience pages. The language of the *first* requested page decides
 * the loader / interaction-button copy; client-side navigations keep this shell mounted.
 */
export default async function ExperienceLayout({ children }: { children: ReactNode }) {
  const pathname = (await headers()).get('x-kiasa-pathname') ?? '/';
  const lang = detectLangFromPath(pathname);
  return <ExperienceShell lang={lang}>{children}</ExperienceShell>;
}
