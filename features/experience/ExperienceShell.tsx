import type { ReactNode } from 'react';
import HeaderEn from '@/components/experience/generated/HeaderEn';
import NavEn from '@/components/experience/generated/NavEn';
import LoaderEn from '@/components/experience/generated/LoaderEn';
import InteractionButtonEn from '@/components/experience/generated/InteractionButtonEn';
import { ExperienceRuntime } from './ExperienceRuntime';

/**
 * Persistent chrome of the experience: header, menu, loader, interaction button, the
 * scroll spacer (`#app`) and the loading video. Rendered once per full page load; page views
 * are swapped inside `[data-taxi]` by client-side transitions.
 *
 * The site is English only, so there is a single set of chrome components.
 */
export function ExperienceShell({ children }: { children: ReactNode }) {
  return (
    <ExperienceRuntime>
      <HeaderEn />
      <NavEn />
      <div className="gyro-activate"></div>
      <LoaderEn />
      <main>
        <div data-taxi>{children}</div>
        <InteractionButtonEn />
        <div id="app"></div>
      </main>
      <video className="ll-video abs-center z1" autoPlay loop muted playsInline>
        <source src="/top/loading.mp4" type="video/mp4" />
        <source src="/top/loading.webm" type="video/webm" />
      </video>
    </ExperienceRuntime>
  );
}
