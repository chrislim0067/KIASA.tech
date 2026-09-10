/**
 * Top page helpers: interaction area headline show/hide (`ci`), pagination reveal (`sn`),
 * intro completion (`_n`), headline extraction and worker localisation (`Ln`, `li`).
 */
import { events } from '../events';
import { store } from '../store';
import { unlockScroll } from '../scroll/scroll-lock';

export class InteractionAreasController {
  private animTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly off: () => void;

  constructor() {
    this.off = events.on<{ value: boolean; area: string }>('isInteracting', this.onIsInteracting);
  }

  private onIsInteracting = ({ value, area }: { value: boolean; area: string }): void => {
    if (value) this.show(area);
    else this.hide(area);
    store.apiOrNull?.trigger({ name: 'sectionInteraction' }, { slowMo: value, zoomInteraction: value });
  };

  private show(area: string): void {
    const isSection2 = area === 'section2';
    if (this.animTimeout) clearTimeout(this.animTimeout);
    const container = document.querySelector<HTMLElement>(`.${area} .top-section-cont`);
    if (!container) return;
    this.animTimeout = setTimeout(() => container.classList.add('show'), isSection2 ? 500 : 1200);
    container.classList.remove('hide');
  }

  private hide(area: string): void {
    const container = document.querySelector<HTMLElement>(`.${area} .top-section-cont`);
    if (this.animTimeout) clearTimeout(this.animTimeout);
    if (!container) return;
    container.classList.add('hide');
    container.classList.remove('show');
  }

  kill(): void {
    if (this.animTimeout) clearTimeout(this.animTimeout);
    this.off();
  }
}

const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
const later = (fn: () => void, ms: number): void => {
  const timer = setTimeout(() => {
    pendingTimers.delete(timer);
    fn();
  }, ms);
  pendingTimers.add(timer);
};
export const clearTopPageTimers = (): void => {
  pendingTimers.forEach((t) => clearTimeout(t));
  pendingTimers.clear();
};

/** Shows the pagination dots after a delay (port of `sn`). */
export const showPagination = (delay = 1200): void => {
  later(() => document.querySelector('.section-pag')?.classList.add('show'), delay);
};

/** Intro completion sequence after the website started (port of `_n`). */
export const completeIntro = (): void => {
  const { websiteStarted, introCheetahSeen, inSubpage } = store.state;
  if (!websiteStarted) return;
  if (introCheetahSeen) {
    showPagination(10);
    return;
  }
  if (inSubpage) return;
  later(() => document.querySelector('.headline-section1')?.classList.add('intro-completed'), 2200);
  showPagination();
  later(() => unlockScroll(), 2500);
};

/** Collects the headline markup for the worker's 3D text (port of `Ln`). */
export const collectHeadlines = (): string[] =>
  Array.from(document.querySelectorAll('.headline')).map((el) => el.innerHTML);

/** Sends the headlines to the worker when the language changed (port of `li`). */
export const feedLocalization = (): void => {
  const lang = 'en';
  if (store.state.currentLang === lang) return;
  store.apiOrNull?.trigger({ name: 'feedLocalizationToCanvas' }, { headlines: collectHeadlines() });
  store.state.currentLang = lang;
};
