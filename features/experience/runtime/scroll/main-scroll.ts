/**
 * Main scroll orchestration of the top page (ports of `ei` and the magnet scroller `Zs`).
 * Owns every scroll-related controller and disposes all of them.
 */
import { gsap } from 'gsap';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';
import { analytics } from '@/lib/analytics';
import { audioCommands } from '@/lib/audio/events';
import { hasTouch } from '../device';
import { events } from '../events';
import type { SectionConfig } from '../sections';
import { store, type LenisLike } from '../store';
import type { Autoscroll } from './autoscroll';
import { CheetahAngerController, HeadlineController, KeyboardScrollController, Section1Helper, SectionsAnalytics } from './helpers';
import { InteractionButton } from './interaction-button';
import { ANCHOR_EVENTS, PaginationController } from './pagination';
import { lockScroll, unlockScroll } from './scroll-lock';

gsap.registerPlugin(ScrollToPlugin);

export interface ScrollPayload {
  progress: number;
  direction: number;
  dimensions?: { scrollHeight: number };
  passedSection2?: boolean | string;
}

/** Snaps the last section to the end / back (port of `Zs`). */
class MagnetScroll {
  private tween: gsap.core.Tween | null = null;

  constructor(private readonly mainScroll: MainScrollController) {}

  private getDuration(from: number, to: number, duration: number, target: number): number {
    const distance = Math.abs(from - to);
    const perUnit = duration / distance;
    const current = this.mainScroll.pixelsToProgress(window.scrollY);
    return Math.abs(current - target) * perUnit;
  }

  scrollTo(targetPixels: number, targetProgress: number, direction: number, section: SectionConfig): void {
    lockScroll();
    const { scrollEase = 'none', duration = 1.5, from = 0, scrollTo = 1, backDuration = 1.5 } = section;
    const y = targetPixels === -1 ? 0 : targetPixels;
    const time = direction === 1 ? duration : backDuration;
    const tweenDuration = this.getDuration(from, scrollTo as number, time, targetProgress);
    this.mainScroll.lenis.scrollTo(this.mainScroll.progressToScrollPixels(this.mainScroll.previousProgress), { immediate: true, lock: true });
    if (direction === 1 && section.transition) audioCommands.playTransitionAnchor(section.transition);
    this.tween?.kill();
    this.tween = gsap.to(window, {
      duration: tweenDuration,
      scrollTo: { y, autoKill: false },
      ease: scrollEase,
      onComplete: () => {
        this.mainScroll.isDuringMagnet = false;
        unlockScroll();
        this.mainScroll.keyboardScrollController.disable = false;
        this.mainScroll.handleScroll({ progress: targetProgress, direction });
      },
    });
  }

  dispose(): void {
    this.tween?.kill();
    this.tween = null;
  }
}

export class MainScrollController {
  readonly lenis: LenisLike;
  previousProgress = 0;
  isDuringMagnet = false;
  readonly keyboardScrollController: KeyboardScrollController;
  private frozeScroll = false;
  private passedSection2: boolean | string = false;
  private currentSection = 'section1';
  private previousSection = 'section1';
  private readonly isTouchDevice: boolean;
  private scrollDimensions = 0;
  private websiteStarted = false;
  private setupComplete = false;
  private autoScrollWasStarted = false;
  private sectionEnd: HTMLElement | null = null;
  private config: SectionConfig[];
  private readonly scrollHeadlineController: HeadlineController;
  private readonly section1Helper: Section1Helper;
  private readonly magnetScroll: MagnetScroll;
  private readonly interactionButton: InteractionButton;
  private readonly cheetahAngerController: CheetahAngerController;
  private readonly paginationController: PaginationController;
  private readonly sectionsAnalytics: SectionsAnalytics;
  private readonly disposers: Array<() => void> = [];
  private sectionEndClick: (() => void) | null = null;

  constructor(
    lenis: LenisLike,
    private readonly autoscroll: Autoscroll,
  ) {
    this.lenis = lenis;
    this.autoscroll.lenis = lenis;
    this.isTouchDevice = hasTouch();
    this.scrollHeadlineController = new HeadlineController();
    this.section1Helper = new Section1Helper();
    this.config = this.setupConfig();
    this.magnetScroll = new MagnetScroll(this);
    const onLenisScroll = (instance: LenisLike & { dimensions?: { scrollHeight: number }; direction: number }): void => {
      this.scrollDimensions = instance.dimensions?.scrollHeight ?? this.scrollDimensions;
      this.handleScroll({ progress: instance.progress, direction: instance.direction });
      this.previousProgress = instance.progress;
    };
    (lenis as LenisLike & { on(event: 'scroll', cb: typeof onLenisScroll): void }).on('scroll', onLenisScroll);
    this.disposers.push(() => (lenis as LenisLike & { off?(event: 'scroll', cb: typeof onLenisScroll): void }).off?.('scroll', onLenisScroll));
    this.interactionButton = new InteractionButton();
    this.cheetahAngerController = new CheetahAngerController();
    this.paginationController = new PaginationController(lenis, store.state.sectionsDom);
    this.sectionsAnalytics = new SectionsAnalytics(this.currentSection);
    this.enterTop();
    this.eventsStateListener();
    document.addEventListener('top-entered', this.enterTop);
    document.addEventListener('CHANGE_PAGE', this.releaseViewReferences);
    this.disposers.push(() => {
      document.removeEventListener('top-entered', this.enterTop);
      document.removeEventListener('CHANGE_PAGE', this.releaseViewReferences);
    });
    this.keyboardScrollController = new KeyboardScrollController(lenis);
    this.setupComplete = true;
  }

  private menuToggled = (event: Event): void => {
    const open = (event as CustomEvent<{ open: boolean }>).detail.open;
    this.frozeScroll = open;
    if (open) {
      if (this.autoscroll.isStarted()) {
        this.autoScrollWasStarted = true;
        this.autoscroll.stop();
      }
    } else if (this.autoScrollWasStarted) {
      this.autoScrollWasStarted = false;
      this.autoscroll.start(this.autoscroll.direction);
    }
  };

  private eventsStateListener(): void {
    document.addEventListener('menuOpen', this.menuToggled);
    const onStarted = (event: Event): void => {
      const { section } = (event as CustomEvent<{ section: string }>).detail;
      const started = this.autoscroll.isStarted();
      if (section !== 'section3') {
        if (started) this.autoscroll.stop();
      } else if (!started) this.autoscroll.start();
    };
    const onCompleted = (event: Event): void => {
      const detail = (event as CustomEvent<ScrollPayload>).detail;
      this.passedSection2 = detail.passedSection2 ?? false;
      store.state.scroll = detail.progress;
      this.handleScroll(detail);
    };
    document.addEventListener(ANCHOR_EVENTS.STARTED, onStarted);
    document.addEventListener(ANCHOR_EVENTS.COMPLETED, onCompleted);
    this.disposers.push(() => {
      document.removeEventListener('menuOpen', this.menuToggled);
      document.removeEventListener(ANCHOR_EVENTS.STARTED, onStarted);
      document.removeEventListener(ANCHOR_EVENTS.COMPLETED, onCompleted);
    });
  }

  private enterTop = (): void => {
    this.sectionEnd = document.querySelector<HTMLElement>('.end');
    if (!this.sectionEnd) {
      const off = events.on('startWebsite', () => {
        this.websiteStarted = true;
        off();
      });
      this.disposers.push(off);
      return;
    }
    if (this.sectionEndClick) this.sectionEndClick();
    const onEndClick = (): void => analytics.buttonClick('last-section-about-btn', 'navigation', 'click');
    this.sectionEnd.addEventListener('click', onEndClick, { once: true });
    const end = this.sectionEnd;
    this.sectionEndClick = () => end.removeEventListener('click', onEndClick);
    if (!this.setupComplete) return;
    if (store.state.introCheetahSeen) {
      this.section1Helper.dispose();
      this.section1Helper.init(10);
      this.scrollHeadlineController.enteredTopPage(this.lenis.progress, true);
      if (!this.autoscroll.isStarted()) unlockScroll();
    } else if (this.websiteStarted) {
      this.scrollHeadlineController.updateDom();
      this.section1Helper.init();
    } else {
      const off = events.on('startWebsite', () => {
        this.websiteStarted = true;
        this.section1Helper.init();
        this.scrollHeadlineController.enteredTopPage(this.lenis.progress, false);
        off();
      });
      this.disposers.push(off);
    }
    this.handleScroll({ progress: this.lenis.progress, direction: 0 }, true);
  };

  /** Drops references into the page view that is about to be removed (avoids retaining it). */
  private releaseViewReferences = (): void => {
    this.sectionEndClick?.();
    this.sectionEndClick = null;
    this.sectionEnd = null;
    this.interactionButton.releaseViewReferences();
    this.scrollHeadlineController.releaseViewReferences();
    this.section1Helper.releaseViewReferences();
    this.paginationController.releaseViewReferences();
  };

  private setupConfig(): SectionConfig[] {
    return store.state.sectionsDom.filter((s) => s.magnet || s.autoScroll || s.interactionArea || s.main);
  }

  progressToScrollPixels(progress: number): number {
    return (this.scrollDimensions - window.innerHeight) * progress;
  }

  pixelsToProgress(pixels: number): number {
    return pixels / (this.scrollDimensions - window.innerHeight);
  }

  private checkMagnet(section: SectionConfig, payload: ScrollPayload): boolean {
    if (payload.direction === 0) return false;
    const progress = payload.progress;
    if (progress > (section.from ?? 0) && progress < (section.to as number)) {
      const target = (payload.direction === 1 ? section.scrollTo : section.scrollFrom) as number;
      if (Math.abs(progress - target) < 0.01) return false;
      this.isDuringMagnet = true;
      this.keyboardScrollController.disable = true;
      const transitions = section.transitions;
      if (transitions && payload.direction === 1 && transitions.in) {
        const name = transitions.in;
        setTimeout(() => audioCommands.playTransition(name), transitions.inDelay ?? 0);
      }
      this.magnetScroll.scrollTo(this.progressToScrollPixels(target), target, payload.direction, section);
      return true;
    }
    return false;
  }

  private checkAutoScroll(section: SectionConfig, payload: ScrollPayload): boolean {
    const { id, from = 0 } = section;
    const to = section.to as number;
    const progress = payload.progress;
    if (!(progress > from && progress <= to)) return false;
    if (!this.autoscroll.isStarted()) this.autoscroll.start();
    if (!this.isTouchDevice) {
      if (id === 'section3') {
        this.autoscroll.enableUserScroll = !(progress < from + 0.02 || progress > to - 0.06);
      } else if (id === 'section2End') {
        if (progress > from + 0.3 && progress < to) {
          this.autoscroll.enableUserScroll = false;
          lockScroll();
        } else {
          this.autoscroll.enableUserScroll = true;
          unlockScroll();
        }
      } else {
        this.autoscroll.enableUserScroll = true;
      }
    }
    return true;
  }

  private updateCurrentSectionState(progress: number, anchorScrolling: boolean): void {
    const atStart = progress < 0.2;
    const atEnd = progress > 0.8;
    const isSection1 = this.currentSection === 'section1';
    const fallback = !atStart && isSection1 ? 'section2' : 'section1';
    if (this.currentSection !== this.previousSection || (atStart && !isSection1) || (atEnd && this.currentSection !== 'section5')) {
      if (atStart) this.currentSection = 'section1';
      else if (atEnd) this.currentSection = 'section5';
      document.dispatchEvent(new CustomEvent(ANCHOR_EVENTS.UPDATE_PAGINATION, { detail: { section: this.currentSection } }));
      this.previousSection = this.currentSection;
      if (!anchorScrolling) audioCommands.playMusic(this.currentSection !== 'section1' ? this.currentSection : fallback);
    }
  }

  handleScroll = (payload: ScrollPayload, force?: boolean): void => {
    if (this.frozeScroll && !force) return;
    const anchorScrolling = store.getSettings().anchorScrolling;
    const progress = payload.progress;
    let handled = false;
    let interactionArea: string | false = false;
    const autoscrollStarted = this.autoscroll.isStarted();
    const atTop = progress === 0;
    let sectionId = 'section1';
    if (progress === this.previousProgress && !force) return;
    this.previousProgress = progress;
    this.cheetahAngerController.toggleListeners(atTop);
    this.scrollHeadlineController.update(progress);
    for (const section of this.config) {
      this.sectionEnd?.classList.toggle('show', progress > 0.952);
      const inside = progress >= (section.from ?? 0) && progress <= (section.to as number);
      this.section1Helper.passedSection1(progress > 0);
      if (section.interactionArea && !interactionArea && progress >= (section.interactionFrom ?? 0) && progress <= (section.interactionTo ?? 0)) {
        interactionArea = section.id;
        if (section.id === 'section2') document.dispatchEvent(new CustomEvent('section2InteractionArea'));
      }
      if (this.isDuringMagnet || anchorScrolling) continue;
      this.keyboardScrollController.disable = false;
      if (section.analytics) {
        if (inside) sectionId = section.id;
        else if (progress > 0.7) sectionId = 'section5';
      }
      if (section.magnet && !autoscrollStarted) {
        if (this.checkMagnet(section, payload)) {
          handled = true;
          break;
        }
      } else if (section.autoScroll && this.checkAutoScroll(section, payload)) {
        handled = true;
        break;
      }
    }
    this.keyboardScrollController.scrollStep = this.currentSection === 'section4' || this.currentSection === 'section3' ? 60 : 1;
    if (interactionArea) this.interactionButton.init(interactionArea);
    else this.interactionButton.kill();
    if (!this.isDuringMagnet && !anchorScrolling) {
      if (!handled && this.autoscroll.isStarted()) {
        unlockScroll();
        this.autoscroll.stop();
      }
      if (this.currentSection !== sectionId) {
        this.currentSection = sectionId;
        this.sectionsAnalytics.changeCurrentSection(sectionId);
        if (this.currentSection === 'section2' && this.previousSection !== 'section2') this.passedSection2 = this.previousSection;
      }
    }
    this.updateCurrentSectionState(progress, anchorScrolling);
  };

  dispose(): void {
    this.disposers.splice(0).forEach((d) => d());
    this.sectionEndClick?.();
    this.magnetScroll.dispose();
    this.interactionButton.dispose();
    this.cheetahAngerController.dispose();
    this.paginationController.dispose();
    this.sectionsAnalytics.dispose();
    this.keyboardScrollController.dispose();
    this.section1Helper.dispose();
    this.scrollHeadlineController.dispose();
  }
}
