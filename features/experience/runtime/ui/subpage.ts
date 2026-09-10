/**
 * About / Contact sub-page controllers: tabs (`ri`), scroll container sizing (`oi`),
 * contact links analytics (`ii`), hover SFX (`Cn`) and the enter animations (`bn`, `wn`).
 */
import { analytics } from '@/lib/analytics';
import { audioCommands } from '@/lib/audio/events';
import { SFX } from '@/lib/audio/manifest';
import { hasTouch } from '../device';
import { animateMask, resetMask } from './masks';

export class TabsController {
  private readonly page: 'about' | 'contact';
  private readonly tabNavButtons: HTMLElement[];
  private readonly tabContentItems: HTMLElement[];
  private currentTab: HTMLElement | null = null;
  private handlers: Array<{ button: HTMLElement; handler: () => void }> = [];
  private showTimeout: ReturnType<typeof setTimeout> | null = null;
  private raf: number | null = null;

  constructor() {
    this.page = window.location.pathname.includes('/about') ? 'about' : 'contact';
    this.tabNavButtons = Array.from(document.querySelectorAll<HTMLElement>('.tab-nav-item button'));
    this.tabContentItems = Array.from(document.querySelectorAll<HTMLElement>('.tab-cnt-item'));
    this.init();
  }

  private init(): void {
    if (this.tabNavButtons.length === 0) return;
    this.currentTab = this.tabContentItems[0] ?? null;
    this.tabNavButtons.forEach((button, index) => {
      const handler = (): void => this.activateTab(button, index);
      button.addEventListener('click', handler);
      this.handlers.push({ button, handler });
    });
  }

  private activateTab(button: HTMLElement, index: number): void {
    this.tabNavButtons.forEach((b) => b.classList.remove('active'));
    this.tabContentItems.forEach((c) => c.classList.remove('show', 'anim'));
    analytics.tabNavigation(this.page, button.id);
    if (this.currentTab) {
      const mask = this.currentTab.querySelector('.mask-anim');
      if (mask) {
        this.currentTab.querySelector('.anim-mask-grp')?.classList.remove('show');
        resetMask(mask);
      } else {
        this.currentTab.querySelector('.tnv-anim')?.classList.remove('show');
      }
    }
    button.blur();
    button.classList.add('active');
    const next = document.querySelector<HTMLElement>(`.tabcntitm-${index + 1}`);
    this.currentTab = next;
    if (!next) return;
    next.classList.add('show');
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => next.classList.add('anim'));
    const mask = next.querySelector('.mask-anim');
    if (mask) animateMask(mask, 0);
    else {
      const anim = next.querySelector('.tnv-anim');
      if (anim) {
        if (this.showTimeout) clearTimeout(this.showTimeout);
        this.showTimeout = setTimeout(() => anim.classList.add('show'), 1);
      }
    }
  }

  kill(): void {
    this.handlers.forEach(({ button, handler }) => button.removeEventListener('click', handler));
    this.handlers = [];
    if (this.showTimeout) clearTimeout(this.showTimeout);
    if (this.raf) cancelAnimationFrame(this.raf);
  }
}

export class ScrollContainerController {
  private readonly container: HTMLElement | null;

  constructor() {
    this.container = document.querySelector<HTMLElement>('.scroll-container');
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  private onResize = (): void => {
    if (!this.container) return;
    const height = this.container.clientHeight;
    const child = this.container.firstElementChild;
    if (child && child.clientHeight > height) this.container.classList.add('align-start');
    else this.container.classList.remove('align-start');
  };

  kill(): void {
    window.removeEventListener('resize', this.onResize);
  }
}

export class ContactLinksController {
  private readonly mapLink: HTMLElement | null;
  private snsLinks: HTMLElement[] = [];
  private mails: HTMLElement[] = [];
  private hoverTimeout = false;
  private readonly enableHover: boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.mapLink = document.getElementById('map-link');
    this.enableHover = !hasTouch();
    if (!this.mapLink) return;
    this.snsLinks = Array.from(document.querySelectorAll<HTMLElement>('.sns-item'));
    this.mails = Array.from(document.querySelectorAll<HTMLElement>('.mail'));
    this.mapLink.addEventListener('click', this.trackMap);
    this.snsLinks.forEach((el) => el.addEventListener('click', this.trackSns));
    this.mails.forEach((el) => {
      el.addEventListener('click', this.trackMail);
      if (this.enableHover) el.addEventListener('mouseenter', this.handleMailHover);
    });
  }

  private trackMap = (): void => analytics.buttonClick('address', 'map');
  private trackSns = (event: Event): void => analytics.buttonClick((event.currentTarget as HTMLElement).id, 'sns');
  private trackMail = (event: Event): void => analytics.buttonClick((event.currentTarget as HTMLElement).id, 'email');

  private handleMailHover = (event: Event): void => {
    if (this.hoverTimeout) return;
    const target = event.currentTarget as HTMLElement;
    resetMask(target);
    animateMask(target, 0);
    this.hoverTimeout = true;
    this.timer = setTimeout(() => {
      this.hoverTimeout = false;
    }, 100);
  };

  kill(): void {
    if (!this.mapLink) return;
    this.mapLink.removeEventListener('click', this.trackMap);
    this.snsLinks.forEach((el) => el.removeEventListener('click', this.trackSns));
    this.mails.forEach((el) => {
      el.removeEventListener('click', this.trackMail);
      el.removeEventListener('mouseenter', this.handleMailHover);
    });
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Simple hover in/out sounds on a list of elements (port of `Cn`). */
export class HoverSfxController {
  private readonly enableHover: boolean;
  private items: Element[] | null = null;
  private readonly suppressionTimers = new Map<Element, ReturnType<typeof setTimeout>>();
  private readonly handlers = new Map<Element, { enter: EventListener; leave: EventListener }>();

  constructor(items: Array<Element | null>) {
    this.enableHover = !hasTouch();
    const list = items.filter((i): i is Element => !!i);
    if (!this.enableHover || list.length === 0) return;
    this.items = list;
    list.forEach((el) => {
      const enter: EventListener = (e) => this.handleMouseEnter(e);
      const leave: EventListener = (e) => this.handleMouseLeave(e);
      el.addEventListener('mouseenter', enter);
      el.addEventListener('mouseleave', leave);
      this.handlers.set(el, { enter, leave });
    });
  }

  private handleMouseEnter(event: Event): void {
    const target = event.currentTarget as Element;
    if (!this.suppressionTimers.has(target)) audioCommands.playSound(SFX.SIMPLE_HOVER);
  }

  private handleMouseLeave(event: Event): void {
    const target = event.currentTarget as Element;
    if (this.suppressionTimers.has(target)) return;
    audioCommands.playSound(SFX.SIMPLE_OUT);
    const timer = setTimeout(() => this.suppressionTimers.delete(target), 100);
    this.suppressionTimers.set(target, timer);
  }

  dispose(): void {
    if (!this.enableHover || !this.items) return;
    this.items.forEach((el) => {
      const h = this.handlers.get(el);
      if (h) {
        el.removeEventListener('mouseenter', h.enter);
        el.removeEventListener('mouseleave', h.leave);
      }
      const timer = this.suppressionTimers.get(el);
      if (timer) clearTimeout(timer);
    });
    this.handlers.clear();
    this.suppressionTimers.clear();
    this.items = null;
  }
}

/** About page enter animation (port of `bn`). */
export const animateAboutEnter = (): (() => void) => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const about = document.querySelector<HTMLElement>('.about');
  if (about) {
    about.classList.remove('hide');
    timers.push(setTimeout(() => about.classList.add('enter-complete'), 1200));
  }
  const title = document.querySelector<HTMLElement>('.about-ttl');
  if (title) {
    animateMask(title);
    document.querySelector('.about-txtc')?.classList.add('show');
  }
  return () => timers.forEach((t) => clearTimeout(t));
};

/** Contact page enter animation (port of `wn`). */
export const animateContactEnter = (): void => {
  const first = document.querySelector<HTMLElement>('.contact-mail .tabcntitm-1');
  if (!first) return;
  document.querySelector('.contact')?.classList.remove('hide');
  first.querySelector('.anim-mask-grp')?.classList.add('show');
  animateMask(first);
};
