/**
 * "Hold to interact" cursor button of sections 2 and 4 (port of `Ys`).
 *
 * Desktop: the button follows the cursor (throttled mousemove), a 150 ms hold starts the
 * interaction, a 250 ms ring shows the hold progress and a 4 s locked ring the extended
 * interaction. Touch: the button is static, a tap starts the interaction and a
 * "tap anywhere to close" button appears after 1.5 s.
 */
import { analytics } from '@/lib/analytics';
import { audioCommands } from '@/lib/audio/events';
import { isMobileOrTablet } from '../device';
import { events } from '../events';
import { store } from '../store';
import { activateFollowingSections } from './pagination';
import { lockScroll, unlockScroll } from './scroll-lock';

type Throttled = ((event?: MouseEvent) => void) & { cancel(): void };

const throttle = (fn: (event?: MouseEvent) => void, limit: number): Throttled => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: number | null = null;
  const throttled = ((event?: MouseEvent) => {
    if (last) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => {
          if (Date.now() - (last ?? 0) >= limit) {
            fn(event);
            last = Date.now();
          }
        },
        Math.max(limit - (Date.now() - last), 0),
      );
    } else {
      fn(event);
      last = Date.now();
    }
  }) as Throttled;
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return throttled;
};

export class InteractionButton {
  private main: HTMLElement;
  private header: HTMLElement;
  private element: HTMLElement;
  private pagination: HTMLElement | null;
  private body: HTMLElement;
  private closeButton: HTMLElement | null = null;
  private progressCircle: SVGCircleElement;
  private progressCircleLocked: SVGCircleElement;
  private readonly circumference: number;
  private readonly touchDevice: boolean;
  private readonly holdThreshold = 150;
  private readonly extendedDuration = 4000;
  private readonly holdProgress = 250;

  private timeout: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private throttleLimit = 500;
  private interactionArea: string | false = false;
  private interacting = false;
  private forceHide = false;
  private currentUserIndicator: HTMLElement | null = null;
  private clientX = 0;
  private clientY = 0;
  private timeInteractionStarted = 0;
  private listenersAdded = false;
  private holdStartTime: number | null = null;
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;
  private extendedInteractionTimeout: ReturnType<typeof setTimeout> | null = null;
  private mouseReleased = false;
  private progressStartTime: number | null = null;
  private progressAnimationFrame: number | null = null;
  private lockedProgressAnimationFrame: number | null = null;
  private lockStartTime = 0;
  private inSubpage = false;
  private wasActiveOnEnteringTopPage = false;
  private debounceTransitionSoundIn: ReturnType<typeof setTimeout> | null = null;
  private debounceTransitionSoundOut: ReturnType<typeof setTimeout> | null = null;
  private addHiddenClassTimeout: ReturnType<typeof setTimeout> | null = null;
  private showButtonCloseTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentSectionCompleted = false;
  private interactionStarted: number | false = false;
  private firstInteractionHoldTimingCompleted = false;
  private throttledMouseMove: Throttled | null = null;
  private offInSubpage: (() => void) | null = null;

  constructor() {
    this.main = document.querySelector('main')!;
    this.header = document.querySelector('header')!;
    this.element = document.querySelector<HTMLElement>('.htibtn')!;
    this.pagination = document.querySelector<HTMLElement>('.section-pag');
    this.body = document.body;
    this.touchDevice = isMobileOrTablet();
    this.progressCircle = this.element.querySelector<SVGCircleElement>('.progress-circle-fill')!;
    this.progressCircleLocked = this.element.querySelector<SVGCircleElement>('.pcf-locked')!;
    const radius = this.progressCircle.r.baseVal.value;
    this.circumference = 2 * Math.PI * radius;
    this.progressCircle.style.strokeDasharray = `${this.circumference}`;
    this.progressCircle.style.strokeDashoffset = `${this.circumference}`;
    this.progressCircleLocked.style.strokeDasharray = `${this.circumference}`;
    this.progressCircleLocked.style.strokeDashoffset = `${this.circumference}`;
    if (this.touchDevice) {
      this.closeButton = document.querySelector<HTMLElement>('.htibtn-close');
      this.element.classList.add('mobile');
    } else {
      this.centerOnScreen();
      this.throttledMouseMove = throttle(this.onMouseMove, this.throttleLimit);
      document.addEventListener('mousemove', this.throttledMouseMove);
    }
    document.addEventListener('top-entered', this.onTopEntered);
  }

  private initMobileUI(): void {
    document.querySelectorAll('.user-step').forEach((el) => el.classList.add('mobile'));
  }

  private onTopEntered = (): void => {
    this.pagination = document.querySelector<HTMLElement>('.section-pag');
    if (this.active) {
      this.currentUserIndicator = document.querySelector<HTMLElement>(`.${this.interactionArea} .user-step`);
      setTimeout(() => this.showElement(), 100);
    }
    if (!this.touchDevice) return;
    const hold = document.querySelector('.hold-tr');
    const tap = document.querySelector('.tap-tr');
    hold?.classList.add('dnone');
    hold?.setAttribute('aria-hidden', 'true');
    tap?.classList.remove('dnone');
    tap?.setAttribute('aria-hidden', 'false');
    const click = document.querySelector('.click-tr');
    if (click) {
      click.classList.add('dnone');
      click.setAttribute('aria-hidden', 'true');
    }
    this.initMobileUI();
  };

  init(area: string): void {
    if (this.active) return;
    this.interactionArea = area;
    this.currentSectionCompleted = this.isSectionInteractionCompleted();
    this.interactionStarted = false;
    this.firstInteractionHoldTimingCompleted = false;
    this.currentUserIndicator = document.querySelector<HTMLElement>(`.${area} .user-step`);
    this.active = true;
    this.initListeners();
    this.show();
  }

  private show(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.showElement();
  }

  private showElement(): void {
    if (this.forceHide) return;
    this.body.classList.add('interactive');
    if (this.addHiddenClassTimeout) clearTimeout(this.addHiddenClassTimeout);
    this.element.classList.remove('vhidden');
    this.element.classList.add('show');
    this.currentUserIndicator?.classList.add('show');
    if (this.touchDevice) this.element.classList.remove('hide');
    else {
      this.updateThrottleLimit(30);
      this.onMouseMove();
    }
  }

  private hide(): void {
    this.active = false;
    if (this.interacting) this.stopIsInteracting();
    this.body.classList.remove('interactive');
    this.hideElement();
  }

  private hideElement(keepIndicator?: boolean): void {
    this.element.classList.remove('show');
    this.addHiddenClassTimeout = setTimeout(() => this.element.classList.add('vhidden'), 400);
    if (!keepIndicator) this.currentUserIndicator?.classList.remove('show');
    if (!this.touchDevice) this.updateThrottleLimit(400);
  }

  private initListeners(): void {
    if (this.listenersAdded) return;
    this.listenersAdded = true;
    document.addEventListener('menuOpen', this.onMenuOpen);
    this.offInSubpage = events.on<{ inSubpage: boolean }>('inSubPage', this.handleInSubpage);
    if (this.touchDevice) {
      this.element.addEventListener('click', this.triggerIsInteracting, { passive: true });
    } else {
      document.addEventListener('mousedown', this.onMouseDown);
      document.addEventListener('mouseup', this.onMouseUp);
      document.addEventListener('mouseleave', this.onMouseLeave);
      document.addEventListener('mouseenter', this.onMouseEnter);
    }
  }

  private stopListeners = (): void => {
    this.listenersAdded = false;
    document.removeEventListener('menuOpen', this.onMenuOpen);
    this.offInSubpage?.();
    this.offInSubpage = null;
    if (this.touchDevice) {
      this.element.removeEventListener('click', this.triggerIsInteracting);
      this.closeTouchInteraction();
    } else {
      document.removeEventListener('mousedown', this.onMouseDown);
      document.removeEventListener('mouseup', this.onMouseUp);
      document.removeEventListener('mouseleave', this.onMouseLeave);
      document.removeEventListener('mouseenter', this.onMouseEnter);
    }
  };

  private triggerSoundInteractions(active: boolean, elapsed = 0): void {
    if ((active && this.debounceTransitionSoundIn) || (!active && this.debounceTransitionSoundOut)) return;
    const area = this.interactionArea as string;
    audioCommands.interactionLoop(area, active);
    if (!active && elapsed < 0.35) {
      if (elapsed < 0.2) audioCommands.stopInteraction(area, true);
      return;
    }
    audioCommands.playInteraction(area, active);
    if (active) {
      this.debounceTransitionSoundIn = setTimeout(() => {
        this.debounceTransitionSoundIn = null;
      }, 400);
    } else {
      this.debounceTransitionSoundOut = setTimeout(() => {
        this.debounceTransitionSoundOut = null;
      }, 400);
    }
  }

  private handleInSubpage = ({ inSubpage }: { inSubpage: boolean }): void => {
    this.inSubpage = inSubpage;
    if (this.inSubpage && this.active) {
      this.element.classList.add('hide');
      this.body.classList.remove('interactive');
      this.wasActiveOnEnteringTopPage = true;
      this.active = false;
    } else if (!this.inSubpage && this.wasActiveOnEnteringTopPage) {
      this.wasActiveOnEnteringTopPage = false;
      this.active = true;
      setTimeout(() => this.toggleVisibilityBasedOnPosition(), 1);
      this.body.classList.add('interactive');
    }
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (!this.active || this.touchDevice || this.isTriggeringOnOtherElement(event.target)) return;
    this.timeInteractionStarted = Date.now();
    this.progressStartTime = Date.now();
    this.mouseReleased = false;
    if (this.currentSectionCompleted || this.firstInteractionHoldTimingCompleted) {
      this.triggerIsInteracting(event);
      return;
    }
    this.firstInteractionHoldTimingCompleted = false;
    this.initInteraction();
    this.active = true;
    this.holdStartTime = Date.now();
    this.holdTimeout = setTimeout(() => {
      this.firstInteractionHoldTimingCompleted = true;
      if (!this.mouseReleased) {
        this.triggerIsInteracting(event);
        this.startExtendedInteraction();
      }
    }, this.holdThreshold);
  };

  private onMouseUp = (): void => {
    if (!this.active || this.touchDevice) return;
    this.mouseReleased = true;
    if (this.firstInteractionHoldTimingCompleted && this.holdStartTime && Date.now() - this.holdStartTime < this.holdThreshold) {
      this.clearInteractionTimers();
      return;
    }
    if (!this.extendedInteractionTimeout) {
      if (this.holdTimeout) clearTimeout(this.holdTimeout);
      this.stopIsInteracting();
      this.resetProgress();
    }
  };

  private updateProgress = (): void => {
    if (this.mouseReleased || !this.progressStartTime) {
      this.resetProgress();
      return;
    }
    const elapsed = Date.now() - this.progressStartTime;
    const ratio = Math.min(elapsed / this.holdProgress, 1);
    this.progressCircle.style.strokeDashoffset = `${this.circumference - ratio * this.circumference}`;
    if (ratio < 1) this.progressAnimationFrame = requestAnimationFrame(this.updateProgress);
  };

  private resetProgress = (): void => {
    this.progressCircle.style.strokeDashoffset = `${this.circumference}`;
    if (this.progressAnimationFrame) {
      cancelAnimationFrame(this.progressAnimationFrame);
      this.progressAnimationFrame = null;
    }
  };

  private lockedCircleProgressStart = (): void => {
    const elapsed = Date.now() - this.lockStartTime;
    const ratio = Math.min(elapsed / this.extendedDuration, 1);
    this.progressCircleLocked.style.strokeDashoffset = `${this.circumference - ratio * this.circumference}`;
    if (ratio < 1) this.lockedProgressAnimationFrame = requestAnimationFrame(this.lockedCircleProgressStart);
    else this.lockedProgressAnimationFrame = null;
  };

  private resetLockedCircleProgress = (): void => {
    this.progressCircleLocked.style.strokeDashoffset = `${this.circumference}`;
    if (this.lockedProgressAnimationFrame) {
      cancelAnimationFrame(this.lockedProgressAnimationFrame);
      this.lockedProgressAnimationFrame = null;
    }
  };

  private startExtendedInteraction(): void {
    this.lockStartTime = Date.now();
    this.lockedCircleProgressStart();
    this.extendedInteractionTimeout = setTimeout(() => {
      this.extendedInteractionTimeout = null;
      setTimeout(() => this.resetLockedCircleProgress(), 120);
      if (this.mouseReleased) {
        this.stopIsInteracting();
        this.resetProgress();
      }
    }, this.extendedDuration);
  }

  private clearInteractionTimers(): void {
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    if (this.extendedInteractionTimeout) clearTimeout(this.extendedInteractionTimeout);
    this.holdTimeout = null;
    this.extendedInteractionTimeout = null;
    this.holdStartTime = null;
  }

  private isTriggeringOnOtherElement(target: EventTarget | null): boolean {
    if (this.touchDevice || !(target instanceof Element)) return false;
    return !!(target.closest('.right-header') || target.closest('.logomark-header') || target.closest('.logotext-header') || target.closest('.section-pag'));
  }

  private triggerIsInteracting = (event?: Event): void => {
    if (!this.active || this.isTriggeringOnOtherElement(event?.target ?? null)) return;
    if (this.extendedInteractionTimeout === null) this.triggerSoundInteractions(true);
    this.main.classList.add('interacting');
    if (this.touchDevice) {
      this.header.classList.add('hide');
      this.closeButton?.addEventListener('click', this.stopIsInteracting, { once: true });
      this.showButtonCloseTimeout = setTimeout(() => this.closeButton?.classList.add('show'), 1500);
    } else if (!this.lockedProgressAnimationFrame) {
      this.updateProgress();
    }
    this.initInteraction();
  };

  private initInteraction(): void {
    this.interacting = true;
    store.apiOrNull?.trigger({ name: 'isInteracting' }, { value: true, area: this.interactionArea });
    this.interactionStarted = Date.now();
    analytics.sectionInteraction(this.interactionArea as string, true, undefined);
    this.element.classList.add('hide', 'interacting');
    this.pagination?.classList.add('hide');
    this.currentUserIndicator?.classList.remove('show');
    lockScroll();
  }

  private isSectionInteractionCompleted(): boolean {
    return store.state.sectionsDom.find((s) => s.id === this.interactionArea)?.interactionCompleted ?? false;
  }

  private interactionCompleted(): void {
    if (this.currentSectionCompleted) return;
    const section = store.state.sectionsDom.find((s) => s.id === this.interactionArea);
    if (section) {
      this.currentSectionCompleted = true;
      section.interactionCompleted = true;
      activateFollowingSections(this.interactionArea as string);
    }
    try {
      localStorage.setItem(`section-interaction-${this.interactionArea}`, 'true');
    } catch {
      /* storage unavailable */
    }
    this.currentUserIndicator?.classList.add('completed');
    document.dispatchEvent(new CustomEvent('interactionCompleted', { detail: { area: this.interactionArea } }));
  }

  private stopIsInteracting = (): void => {
    if (this.interactionStarted) {
      const seconds = (Date.now() - this.interactionStarted) / 1000;
      if (seconds > 1.1) this.interactionCompleted();
      analytics.sectionInteraction(this.interactionArea as string, false, seconds);
    }
    const elapsed = (Date.now() - this.timeInteractionStarted) / 1000;
    this.interactionStarted = false;
    const { anchorScrolling } = store.getSettings();
    if (!anchorScrolling && this.interacting && this.extendedInteractionTimeout === null) this.triggerSoundInteractions(false, elapsed);
    this.interacting = false;
    store.apiOrNull?.trigger({ name: 'isInteracting' }, { value: false, area: this.interactionArea });
    this.pagination?.classList.remove('hide');
    this.currentUserIndicator?.classList.add('show');
    this.main.classList.remove('interacting');
    this.closeTouchInteraction();
    if (!this.shouldHideElement()) this.element.classList.remove('hide', 'interacting');
    if (!this.body.classList.contains('autoscroll') && this.active) unlockScroll();
  };

  private closeTouchInteraction(): void {
    if (!this.touchDevice) return;
    this.header.classList.remove('hide');
    if (this.showButtonCloseTimeout) clearTimeout(this.showButtonCloseTimeout);
    this.closeButton?.classList.remove('show');
    this.closeButton?.removeEventListener('click', this.stopIsInteracting);
  }

  private shouldHideElement(): boolean {
    if (this.touchDevice) return false;
    const centerX = window.innerWidth / 2;
    const nearCenter = this.clientX > centerX - 150 && this.clientX < centerX + 150;
    const nearBottom = this.clientY > window.innerHeight - 90;
    const nearRight = this.clientX > window.innerWidth - 120;
    return this.clientY < 115 || this.interacting || (nearBottom && nearCenter) || nearRight;
  }

  private toggleVisibilityBasedOnPosition(): void {
    this.element.classList.toggle('hide', this.shouldHideElement());
  }

  private onMouseMove = (event?: MouseEvent): void => {
    if (event) {
      this.clientX = event.clientX;
      this.clientY = event.clientY;
    }
    this.element.style.transform = `translate3d(${this.clientX}px, ${this.clientY - 15}px, 0)`;
    if (this.active) this.toggleVisibilityBasedOnPosition();
  };

  private onMenuOpen = (event: Event): void => {
    this.forceHide = (event as CustomEvent<{ open: boolean }>).detail.open;
    if (this.forceHide) this.hideElement();
    else if (this.active) this.showElement();
    this.toggleVisibilityBasedOnPosition();
  };

  private onMouseLeave = (): void => {
    if (this.active) this.hideElement(true);
  };

  private onMouseEnter = (): void => {
    if (this.active) this.showElement();
  };

  private centerOnScreen(): void {
    this.element.style.transform = `translate3d(${window.innerWidth / 2}px, ${window.innerHeight / 2}px, 0)`;
  }

  /** Called when the page view is left; the elements are re-queried on `top-entered`. */
  releaseViewReferences(): void {
    this.pagination = null;
    this.currentUserIndicator = null;
  }

  kill(): void {
    if (!this.active) return;
    this.currentSectionCompleted = false;
    this.active = false;
    this.stopIsInteracting();
    this.interactionArea = false;
    this.hide();
    this.timeout = setTimeout(this.stopListeners, 200);
  }

  private updateThrottleLimit(limit: number): void {
    if (this.throttleLimit === limit) return;
    this.throttleLimit = limit;
    if (this.throttledMouseMove) {
      document.removeEventListener('mousemove', this.throttledMouseMove);
      this.throttledMouseMove.cancel();
    }
    this.throttledMouseMove = throttle(this.onMouseMove, this.throttleLimit);
    document.addEventListener('mousemove', this.throttledMouseMove);
  }

  dispose(): void {
    this.kill();
    if (this.timeout) clearTimeout(this.timeout);
    this.stopListeners();
    this.clearInteractionTimers();
    this.resetProgress();
    this.resetLockedCircleProgress();
    [this.debounceTransitionSoundIn, this.debounceTransitionSoundOut, this.addHiddenClassTimeout, this.showButtonCloseTimeout].forEach((t) => t && clearTimeout(t));
    if (this.throttledMouseMove) {
      document.removeEventListener('mousemove', this.throttledMouseMove);
      this.throttledMouseMove.cancel();
    }
    document.removeEventListener('top-entered', this.onTopEntered);
  }
}
