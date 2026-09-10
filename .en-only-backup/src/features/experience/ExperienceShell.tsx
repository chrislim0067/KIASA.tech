import type { ReactNode } from 'react';
import HeaderEn from '@/components/experience/generated/HeaderEn';
import NavEn from '@/components/experience/generated/NavEn';
import LoaderEn from '@/components/experience/generated/LoaderEn';
import LoaderJa from '@/components/experience/generated/LoaderJa';
import LoaderFr from '@/components/experience/generated/LoaderFr';
import InteractionButtonEn from '@/components/experience/generated/InteractionButtonEn';
import InteractionButtonJa from '@/components/experience/generated/InteractionButtonJa';
import InteractionButtonFr from '@/components/experience/generated/InteractionButtonFr';
import { ExperienceRuntime } from './ExperienceRuntime';
import type { Lang } from './runtime/ui/language';

const LOADERS = { en: LoaderEn, ja: LoaderJa, fr: LoaderFr } as const;
const BUTTONS = { en: InteractionButtonEn, ja: InteractionButtonJa, fr: InteractionButtonFr } as const;

/**
 * Persistent chrome of the experience: header, menu, loader, interaction button, the
 * scroll spacer (`#app`) and the loading video. Rendered once per full page load; page views
 * are swapped inside `[data-taxi]` by client-side transitions.
 *
 * The header and menu markup is language independent — the language specific labels and
 * hrefs are set at runtime by `updateNavigationLinks()` exactly like the original.
 */
export function ExperienceShell({ lang, children }: { lang: Lang; children: ReactNode }) {
  const Loader = LOADERS[lang];
  const InteractionButton = BUTTONS[lang];
  return (
    <ExperienceRuntime>
      <HeaderEn />
      <NavEn />
      <div className="gyro-activate"></div>
      <Loader />
      <main>
        <div data-taxi>{children}</div>
        <InteractionButton />
        <div id="app"></div>
      </main>
      <video className="ll-video abs-center z1" autoPlay loop muted playsInline>
        <source src="/top/loading.mp4" type="video/mp4" />
        <source src="/top/loading.webm" type="video/webm" />
      </video>
    </ExperienceRuntime>
  );
}
