import type { ReactNode } from 'react';
import { ExperienceShell } from '@/features/experience/ExperienceShell';
import '@/styles/experience.css';

/** Layout of the WebGL experience pages. The shell persists across client-side navigations. */
export default function ExperienceLayout({ children }: { children: ReactNode }) {
  return <ExperienceShell>{children}</ExperienceShell>;
}
