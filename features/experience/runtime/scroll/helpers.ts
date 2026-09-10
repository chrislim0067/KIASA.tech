/**
 * Small scroll-related controllers: cheetah "anger" (port of `Gs`), section 1 helper
 * (`Xs`), keyboard scrolling (`Ks`), DOM headlines (`Js`) and analytics tracking (`Qs`).
 */
import { analytics } from '@/lib/analytics';
import { events } from '../events';
import { isFirefox, isMobileOrTablet } from '../device';
import type { SectionConfig } from '../sections';
import { store, type LenisLike } from '../store';

const triggerAnger = (active: boolean): void => {
  store.apiOrNull?.trigger({ name: 'triggerAnger' }, { active });
};

/** Mouse/touch down at the very top makes the cheetah angry (port of `Gs`). */
export class CheetahAngerController {
  private readonly cooldown = 150;
  private readonly angerDuration = 350;
  private canTriggerAnger = true;
  private angerActiveSince: number | null = null;
  private cooldownTimeout: ReturnType<typeof setTimeout> | null = null;
  private angerTimeout: ReturnType<typeof setTimeout> | null = null;
  private attached = false;

  constructor() {
    this.addEventListeners();
  }

  private trigger = (): void => {
    const now = Date.now();
    if (!this.canTriggerAnger) return;
    triggerAnger(true);
    this.angerActiveSince = now;
    if (this.angerTimeout) clearTimeout(this.angerTimeout);
    this.angerTimeout = setTimeout(() => {
      this.canTriggerAnger = true;
      this.angerActiveSince = null;
    }, this.angerDuration);
    this.canTriggerAnger = false;
    if (this.cooldownTimeout) clearTimeout(this.cooldownTimeout);
    this.cooldownTimeout = setTimeout(() => {
      if (!this.angerActiveSince || Date.now() - this.angerActiveSince >= this.angerDuration) this.canTriggerAnger = true;
    }, this.cooldown);
  };

  private release = (): void => {
    triggerAnger(false);
  };

  toggleListeners(enabled: boolean): void {
    if (enabled && !this.attached) this.addEventListeners();
    else if (!enabled && this.attached) this.removeEventListeners();
  }

  private addEventListeners(): void {
    this.attached = true;
    document.body.addEventListener('mousedown', this.trigger);
    document.body.addEventListener('touchstart', this.trigger, { passive: true });
    document.body.addEventListener('mouseup', this.release);
    document.body.addEventListener('touchend', this.release);
    document.body.addEventListener('touchcancel', this.release);
    document.body.addEventListener('mouseleave', this.release);
  }

  private removeEventListeners(): void {
    this.attached = false;
    document.body.removeEventListener('mousedown', this.trigger);
    document.body.removeEventListener('touchstart', this.trigger);
    document.body.removeEventListener('mouseup', this.release);
    document.body.removeEventListener('touchend', this.release);
    document.body.removeEventListener('touchcancel', this.release);
    document.body.removeEventListener('mouseleave', this.release);
  }

  dispose(): void {
    this.removeEventListeners();
    if (this.angerTimeout) clearTimeout(this.angerTimeout);
    if (this.cooldownTimeout) clearTimeout(this.cooldownTimeout);
  }
}

/** Shows the section 1 description a while after the start (port of `Xs`). */
export class Section1Helper {
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private timerHelper: ReturnType<typeof setTimeout> | null = null;
  private hasBeenShown = false;
  private element: HTMLElement | null = null;

  init(delay = 2500): void {
    this.element = document.querySelector<HTMLElement>('.section1');
    if (!this.element || this.timerId !== null || this.element.classList.contains('show')) return;
    this.hasBeenShown = false;
    this.timerId = setTimeout(() => {
      this.hasBeenShown = true;
      this.timerId = null;
      this.element?.classList.add('show');
    }, delay);
    this.timerHelper = setTimeout(() => {
      this.element?.querySelector('.small-txt')?.classList.add('fadeinout');
    }, delay + 5000);
  }

  passedSection1(passed: boolean): void {
    if (passed && this.timerHelper) clearTimeout(this.timerHelper);
    if (this.hasBeenShown) this.element?.classList.toggle('hide', passed);
    else if (passed) {
      this.stop();
      this.element?.classList.add('show', 'hide');
      this.hasBeenShown = true;
    }
  }

  stop(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  releaseViewReferences(): void {
    this.element = null;
  }

  dispose(): void {
    this.hasBeenShown = false;
    this.stop();
    if (this.timerHelper) clearTimeout(this.timerHelper);
    this.timerHelper = null;
    this.element = null;
  }
}

/** Arrow / page / space keys (port of `Ks`). */
export class KeyboardScrollController {
  scrollStep = 1;
  disable = false;

  constructor(private readonly lenis: LenisLike) {
    window.addEventListener('keydown', this.handleKeydown);
  }

  private scrollUp(): void {
    this.lenis.scrollTo(this.lenis.targetScroll - this.scrollStep);
  }

  private scrollDown(): void {
    this.lenis.scrollTo(this.lenis.targetScroll + this.scrollStep);
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (this.disable || document.body.hasAttribute('data-lenis-prevent')) return;
    const key = event.key;
    if (key === 'ArrowUp' || key === 'PageUp') this.scrollUp();
    else if (key === 'ArrowDown' || key === 'PageDown') this.scrollDown();
    else if (key === ' ') {
      if (event.shiftKey) this.scrollUp();
      else this.scrollDown();
    }
  };

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeydown);
  }
}

/** DOM headlines shown on devices without 3D text (port of `Js`). */
export class HeadlineController {
  private headlineDomsActive: boolean;
  private currentHeadline: string | null = null;
  private enteringFromSubPage = false;
  private headlinesContainer: HTMLElement | null = null;
  private headlinesSections: SectionConfig[] = [];
  private offLowSpeed: (() => void) | null = null;
  private enterTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.headlineDomsActive = isMobileOrTablet() || isFirefox() || store.getSettings().lowSpeedVendor;
    if (!this.headlineDomsActive) {
      this.offLowSpeed = events.on('isLowSpeedVendor', () => {
        this.headlineDomsActive = true;
        this.init();
        this.offLowSpeed?.();
        this.offLowSpeed = null;
      });
      return;
    }
    this.init();
  }

  private init(): void {
    document.body.classList.add('sp-txt');
    this.enteringFromSubPage = false;
    this.updateSectionList();
    this.updateDom();
  }

  updateDom(): void {
    this.headlinesContainer = document.querySelector<HTMLElement>('.sections-headlines');
  }

  private enteredBackFromSubPage(): void {
    this.enteringFromSubPage = true;
    if (this.enterTimeout) clearTimeout(this.enterTimeout);
    this.enterTimeout = setTimeout(() => {
      this.enteringFromSubPage = false;
      if (this.currentHeadline) this.toggleHeadline(this.currentHeadline, true);
    }, 500);
    this.headlinesContainer?.querySelector('.headline-section1')?.classList.add('intro-completed');
  }

  enteredTopPage(progress: number, fromSubpage: boolean): void {
    this.currentHeadline = null;
    this.updateDom();
    if (fromSubpage) this.enteredBackFromSubPage();
    this.update(progress);
  }

  private updateSectionList(): void {
    this.headlinesSections = store.state.sectionsDom.filter((s) => s.dom);
  }

  private toggleHeadline(id: string, show: boolean): void {
    if (show && this.enteringFromSubPage) return;
    this.headlinesContainer?.querySelector(`.headline-${id}`)?.classList.toggle('show', show);
  }

  update(progress: number): void {
    if (!this.headlineDomsActive || !this.headlinesContainer) return;
    if (this.headlinesSections.length === 0) this.updateSectionList();
    let next: string | null = null;
    for (const section of this.headlinesSections) {
      if ((section.headlineFrom ?? 0) <= progress && (section.headlineTo ?? 0) >= progress) {
        next = section.id;
        break;
      }
    }
    if (this.currentHeadline === next) return;
    if (next) this.toggleHeadline(next, true);
    if (this.currentHeadline) this.toggleHeadline(this.currentHeadline, false);
    this.currentHeadline = next;
  }

  releaseViewReferences(): void {
    this.headlinesContainer = null;
  }

  dispose(): void {
    this.offLowSpeed?.();
    if (this.enterTimeout) clearTimeout(this.enterTimeout);
    this.headlinesContainer = null;
  }
}

/** Time spent per section, pushed to GTM (port of `Qs`). All timers are cleaned up. */
export class SectionsAnalytics {
  private interval: ReturnType<typeof setInterval> | null = null;
  private sectionTracking: Record<string, { current: boolean; time_spent: number }> = {};
  private trackUpdateProgress = 0;
  private pauseTracking = false;
  private inSubpage: boolean;
  private observer: MutationObserver | null = null;
  private offStartWebsite: (() => void) | null = null;

  constructor(private currentSection: string) {
    this.inSubpage = (document.querySelector('.contact') ?? document.querySelector('.about')) !== null;
    store.state.sectionsDom.filter((s) => s.analytics).forEach((s) => {
      this.sectionTracking[s.id] = { current: false, time_spent: 0 };
    });
    const current = this.sectionTracking[this.currentSection];
    if (current) current.current = true;
    this.addEventListeners();
  }

  private checkToStartTrackingSection = (): void => {
    if (!this.interval && store.state.websiteStarted) {
      this.startTracking();
      this.offStartWebsite?.();
      this.offStartWebsite = null;
    }
  };

  private onSubpageEntered = (): void => {
    this.inSubpage = true;
  };

  private onTopEntered = (): void => {
    this.checkToStartTrackingSection();
    this.inSubpage = false;
  };

  private addEventListeners(): void {
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    document.addEventListener('menuOpen', this.onMenuOpen);
    this.offStartWebsite = events.on('startWebsite', this.checkToStartTrackingSection);
    document.addEventListener('subpage-entered', this.onSubpageEntered);
    document.addEventListener('top-entered', this.onTopEntered);
    if (this.inSubpage) return;
    const loader = document.getElementById('loader');
    if (!loader) return;
    if (loader.classList.contains('hide')) {
      this.startTracking();
      return;
    }
    this.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'class' && loader.classList.contains('hide')) {
          this.startTracking();
          this.observer?.disconnect();
          this.observer = null;
          break;
        }
      }
    });
    this.observer.observe(loader, { attributes: true });
  }

  private startTracking(): void {
    if (this.interval) return;
    this.interval = setInterval(this.updateTracking, 100);
  }

  changeCurrentSection(section: string): void {
    if (this.currentSection === section) return;
    this.currentSection = section;
    analytics.sectionChange(section);
  }

  private updateTracking = (): void => {
    if (this.pauseTracking || this.inSubpage) return;
    const entry = this.sectionTracking[this.currentSection];
    if (entry) entry.time_spent += 0.1;
    this.trackUpdateProgress += 1;
    if (this.trackUpdateProgress >= 140) {
      this.trackUpdateProgress = 0;
      this.pushTracking();
    }
  };

  private pushTracking = (): void => {
    Object.keys(this.sectionTracking)
      .filter((id) => this.sectionTracking[id]!.time_spent > 0)
      .forEach((id) => {
        analytics.sectionTimeSpent(id, this.sectionTracking[id]!.time_spent);
        this.sectionTracking[id]!.time_spent = 0;
      });
  };

  private handleVisibilityChange = (): void => {
    this.pauseTracking = document.visibilityState === 'hidden';
  };

  private handleBeforeUnload = (): void => {
    this.pushTracking();
  };

  private onMenuOpen = (event: Event): void => {
    this.pauseTracking = (event as CustomEvent<{ open: boolean }>).detail.open;
  };

  dispose(): void {
    this.pushTracking();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.observer?.disconnect();
    this.observer = null;
    this.offStartWebsite?.();
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    document.removeEventListener('menuOpen', this.onMenuOpen);
    document.removeEventListener('subpage-entered', this.onSubpageEntered);
    document.removeEventListener('top-entered', this.onTopEntered);
  }
}
