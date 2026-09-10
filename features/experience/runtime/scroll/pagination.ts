/**
 * Section pagination dots and anchor scrolling (ports of `zs`, `Tn`, `Nt`, `yn`, `Ke`).
 */
import { audioCommands } from '@/lib/audio/events';
import { TRANSITIONS } from '@/lib/audio/manifest';
import { events } from '../events';
import { easeInOutCirc } from '../math';
import type { SectionConfig } from '../sections';
import { store, type LenisLike } from '../store';
import { unlockScroll } from './scroll-lock';

export const ANCHOR_EVENTS = {
  STARTED: 'anchorScrollStarted',
  COMPLETED: 'anchorScrollCompleted',
  UPDATE_PAGINATION: 'updatePagination',
} as const;

export const ANCHOR_DURATION = 3;

/** Marks the sections that follow an interaction as reachable (port of `Tn`). */
export const activateFollowingSections = (sectionId: string): void => {
  (sectionId === 'section2' ? ['section3'] : ['section4', 'section5']).forEach((id) => {
    document.getElementById(`pgn-${id}`)?.classList.add('active');
  });
};

/** Sets the current pagination link (port of `Nt`). */
export const setCurrentPagination = (sectionId: string, seen?: boolean): void => {
  const current = document.querySelector('.spgn-link.current');
  if (current && current.id !== `pgn-${sectionId}`) current.classList.remove('current', 'entered');
  else return;
  const link = document.getElementById(`pgn-${sectionId}`);
  if (!link) return;
  link.classList.add('current');
  if (!seen) link.classList.add('entered');
};

export interface AnchorScrollOptions {
  duration?: number;
  easing?: (t: number) => number;
  [key: string]: unknown;
}

/** Smoothly scrolls to a section (port of `yn`). */
export const anchorScrollTo = (
  sectionId: string,
  targetPixels: number,
  progress: number,
  passedSection2?: boolean | string,
  options: AnchorScrollOptions = {},
): void => {
  if (store.getSettings().anchorScrolling) events.trigger({ name: 'lenis:stop' });
  store.setSettings({ anchorScrolling: true });
  const direction = targetPixels > window.scrollY ? 1 : -1;
  document.dispatchEvent(new CustomEvent(ANCHOR_EVENTS.STARTED, { detail: { section: sectionId, direction } }));
  unlockScroll();
  events.trigger(
    { name: 'lenis:scrollTo' },
    {
      target: targetPixels,
      options: {
        immediate: false,
        duration: ANCHOR_DURATION,
        lock: true,
        onComplete: () => {
          store.setSettings({ anchorScrolling: false });
          document.dispatchEvent(
            new CustomEvent(ANCHOR_EVENTS.COMPLETED, { detail: { progress, direction, passedSection2 } }),
          );
        },
        ...options,
      },
    },
  );
};

export class PaginationController {
  private links: HTMLElement[] = [];
  private paginationChapterSeen: Record<string, boolean> = { section1: false, section2: false, section3: false, section4: false, section5: false };
  private showChapterLabelTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly lenis: LenisLike,
    private sections: SectionConfig[],
  ) {
    this.init();
  }

  private init(): void {
    this.setupSectionsEvents();
    document.addEventListener('top-entered', this.onTopEntered);
    document.addEventListener(ANCHOR_EVENTS.UPDATE_PAGINATION, this.onUpdatePagination);
  }

  private onUpdatePagination = (event: Event): void => {
    const { section } = (event as CustomEvent<{ section: string }>).detail;
    setCurrentPagination(section, this.paginationChapterSeen[section]);
    this.showLabelChapter();
  };

  private setupSectionsEvents(): void {
    this.links.forEach((l) => l.removeEventListener('click', this.handleLinkClick));
    this.links = [];
    const progress = this.lenis.progress;
    const scrolled = progress > 0;
    let current = 'section1';
    this.sections.slice(0, 5).forEach((section) => {
      const link = document.getElementById(`pgn-${section.id}`);
      if (!link) return;
      link.addEventListener('click', this.handleLinkClick);
      this.links.push(link);
      if (section.interactionCompleted) activateFollowingSections(section.id);
      if (scrolled && (section.from ?? 0) <= progress) current = section.id;
    });
    if (current !== 'section1') setCurrentPagination(current, this.paginationChapterSeen[current]);
  }

  private onTopEntered = (): void => {
    this.sections = store.state.sectionsDom;
    this.setupSectionsEvents();
  };

  private showLabelChapter(): void {
    const current = document.querySelector('.spgn-link.current');
    if (this.showChapterLabelTimeout) clearTimeout(this.showChapterLabelTimeout);
    this.showChapterLabelTimeout = setTimeout(() => {
      if (!current) return;
      current.classList.remove('entered');
      this.paginationChapterSeen[current.id.replace('pgn-', '')] = true;
    }, 2300);
  }

  private getCurrentSectionLinkId(): number | null {
    const current = document.querySelector('.spgn-link.current');
    return current ? Number(current.id.replace('pgn-section', '')) : null;
  }

  private handleLinkClick = (event: Event): void => {
    event.preventDefault();
    const id = (event.currentTarget as HTMLElement).id.replace('pgn-', '');
    const section = this.sections.find((s) => s.id === id);
    const currentIndex = this.getCurrentSectionLinkId() ?? 10;
    let targetIndex = 1;
    if (!section) return;
    const isSection2 = id === 'section2';
    let progress = 0;
    let options: AnchorScrollOptions = {};
    switch (id) {
      case 'section2':
        targetIndex = 2;
        progress = (section.from ?? 0) + 0.15;
        break;
      case 'section3':
        targetIndex = 3;
        progress = (section.from ?? 0) + 0.02;
        break;
      case 'section4':
        targetIndex = 4;
        progress = (section.from ?? 0) + 0.05;
        break;
      case 'section5':
        targetIndex = 5;
        progress = 1;
        break;
    }
    const distance = Math.min(4, Math.abs(targetIndex - currentIndex));
    options.duration = Math.min(ANCHOR_DURATION, distance * (ANCHOR_DURATION / 3));
    if (isSection2 && window.scrollY < 10) {
      audioCommands.playTransitionAnchor(TRANSITIONS.TRANSITION_SCENE_1_TO_2);
      options = { duration: ANCHOR_DURATION, easing: easeInOutCirc };
    } else if (id === 'section3') {
      options.easing = (t: number) => t;
    }
    setCurrentPagination(id);
    const passedSection2 = !isSection2 && id !== 'section1';
    const targetPixels = (document.body.scrollHeight - window.innerHeight) * progress;
    anchorScrollTo(id, targetPixels, progress, passedSection2, options);
  };

  releaseViewReferences(): void {
    this.links.forEach((l) => l.removeEventListener('click', this.handleLinkClick));
    this.links = [];
  }

  dispose(): void {
    this.links.forEach((l) => l.removeEventListener('click', this.handleLinkClick));
    this.links = [];
    if (this.showChapterLabelTimeout) clearTimeout(this.showChapterLabelTimeout);
    document.removeEventListener('top-entered', this.onTopEntered);
    document.removeEventListener(ANCHOR_EVENTS.UPDATE_PAGINATION, this.onUpdatePagination);
  }
}
