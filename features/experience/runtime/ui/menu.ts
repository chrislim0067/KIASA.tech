/**
 * Header menu button, nav links, logos and language button (port of `ti`).
 */
import { analytics } from '@/lib/analytics';
import { audioCommands } from '@/lib/audio/events';
import { SFX } from '@/lib/audio/manifest';
import { hasTouch } from '../device';
import type { EngineApi } from '../engine-api';
import { anchorScrollTo } from '../scroll/pagination';
import { lockScroll, unlockScroll } from '../scroll/scroll-lock';
import { store } from '../store';
import { animateMask, resetMask } from './masks';

export const isTopPage = (pathname = window.location.pathname): boolean => pathname === '/';

/** Sets `inSubpage` and notifies the worker (port of `ht`). */
export const setInSubpage = (inSubpage: boolean): void => {
  store.state.inSubpage = inSubpage;
  store.apiOrNull?.trigger({ name: 'inSubPage' }, { inSubpage });
};

const triggerAnger = (active: boolean): void => {
  store.apiOrNull?.trigger({ name: 'triggerAnger' }, { active });
};

export class MenuController {
  private readonly navBtnLogo3d: HTMLElement;
  private readonly logoText: HTMLElement;
  private readonly logoMark: HTMLElement;
  private readonly menuButton: HTMLButtonElement;
  private readonly langButton: HTMLElement;
  private readonly contactHeader: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly main: HTMLElement;
  private readonly enableHover: boolean;
  private hoverTimeout = false;
  private isCooldown = false;
  private cleanMaskTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private navButtons: HTMLElement[] = [];

  constructor(private readonly api: EngineApi) {
    this.navBtnLogo3d = document.querySelector<HTMLElement>('.nav-logo-link')!;
    this.logoText = document.querySelector<HTMLElement>('.logotext-header')!;
    this.logoMark = document.querySelector<HTMLElement>('.logomark-header')!;
    this.menuButton = document.querySelector<HTMLButtonElement>('.menu-btn')!;
    this.langButton = document.querySelector<HTMLElement>('.lang-btn')!;
    this.contactHeader = document.getElementById('contact-nav')!;
    this.menu = document.querySelector<HTMLElement>('nav')!;
    this.main = document.querySelector<HTMLElement>('main')!;
    this.enableHover = !hasTouch();
    this.initEvents();
  }

  private playSoundSimpleHover = (): void => audioCommands.playSound(SFX.SIMPLE_HOVER);
  private playSoundSimpleOut = (): void => audioCommands.playSound(SFX.SIMPLE_OUT);
  private onMenuButtonEnter = (): void => {
    audioCommands.playSound(SFX.MENU_BTN_HOVER);
    triggerAnger(true);
  };
  private onMenuButtonLeave = (): void => {
    audioCommands.playSound(SFX.MENU_BTN_OUT);
    triggerAnger(false);
  };

  private initEvents(): void {
    this.menuButton.addEventListener('click', this.handleMenuButtonClick);
    this.navButtons = Array.from(document.querySelectorAll<HTMLElement>('.nav-btn'));
    this.navButtons.forEach((btn) => {
      btn.addEventListener('click', this.triggerSubpage);
      btn.addEventListener('mouseenter', this.handleNavBtnHover);
    });
    this.logoText.addEventListener('click', this.handleLogoClick);
    this.logoMark.addEventListener('click', this.handleLogoClick);
    this.navBtnLogo3d.addEventListener('click', this.handleLogoClick);
    if (this.enableHover) {
      this.menuButton.addEventListener('mouseenter', this.onMenuButtonEnter);
      this.menuButton.addEventListener('mouseleave', this.onMenuButtonLeave);
      this.contactHeader.addEventListener('mouseenter', this.playSoundSimpleHover);
      this.contactHeader.addEventListener('mouseleave', this.playSoundSimpleOut);
    }
  }

  private triggerSubpage = (): void => {
    setInSubpage(true);
    this.toggleMenu(false);
  };

  private handleMenuButtonClick = (): void => {
    if (this.isCooldown) return;
    const open = this.menuButton.classList.contains('active');
    analytics.buttonClick('menu', 'navigation', 'click', open ? 'close' : 'open');
    this.toggleMenu(!open);
  };

  isMenuOpen(): boolean {
    return this.menuButton.classList.contains('active');
  }

  private handleLogoClick = (): void => {
    const top = isTopPage();
    const open = this.isMenuOpen();
    if (open && !top) setInSubpage(false);
    if (!(open || window.scrollY === 0) && top) {
      anchorScrollTo('section1', 0, 0);
      analytics.buttonClick('logo', 'scroll', 'click', 'scrollToTop');
    }
  };

  private initMenuCloseListeners(): void {
    this.logoText.addEventListener('click', this.closeMenu, { once: true });
    this.navBtnLogo3d.addEventListener('click', this.closeMenu, { once: true });
    this.logoMark.addEventListener('click', this.closeMenu, { once: true });
    this.contactHeader.addEventListener('click', this.triggerSubpage, { once: true });
    document.addEventListener('CHANGE_PAGE', this.closeMenu);
    this.langButton.addEventListener('click', this.closeMenu, { once: true });
    if (this.enableHover) {
      this.langButton.addEventListener('mouseenter', this.playSoundSimpleHover);
      this.langButton.addEventListener('mouseleave', this.playSoundSimpleOut);
    }
  }

  private removeMenuCloseListeners(): void {
    this.logoText.removeEventListener('click', this.closeMenu);
    this.navBtnLogo3d.removeEventListener('click', this.closeMenu);
    this.logoMark.removeEventListener('click', this.closeMenu);
    this.contactHeader.removeEventListener('click', this.triggerSubpage);
    document.removeEventListener('CHANGE_PAGE', this.closeMenu);
    this.langButton.removeEventListener('click', this.closeMenu);
    if (this.enableHover) {
      this.langButton.removeEventListener('mouseenter', this.playSoundSimpleHover);
      this.langButton.removeEventListener('mouseleave', this.playSoundSimpleOut);
    }
  }

  private toggleMenuEvents(open: boolean): void {
    this.api.trigger({ name: 'menuOpen' }, { open });
    document.dispatchEvent(new CustomEvent('menuOpen', { detail: { open } }));
    audioCommands.playSound(open ? SFX.MENU_IN : SFX.MENU_OUT);
  }

  private closeMenu = (): void => {
    audioCommands.stopSound(SFX.LOGO_LOOP);
    this.menuButton.setAttribute('aria-label', 'Menu');
    this.removeMenuCloseListeners();
    this.menuButton.classList.remove('active');
    this.menu.classList.remove('show');
    this.main.classList.remove('menu-open');
    this.cleanMaskTimeout = setTimeout(() => resetMask(this.menu), 500);
    store.setSettings({ menuOpen: false });
    if (!document.querySelector('.contact') && !document.querySelector('.about')) unlockScroll();
    audioCommands.playSound(SFX.MENU_OUT);
    this.toggleMenuEvents(false);
    this.initiateCooldown();
  };

  toggleMenu(open: boolean): void {
    if (!open) {
      this.closeMenu();
      return;
    }
    if (this.cleanMaskTimeout) clearTimeout(this.cleanMaskTimeout);
    store.setSettings({ menuOpen: true });
    this.initMenuCloseListeners();
    audioCommands.playSound(SFX.LOGO_LOOP);
    this.menuButton.classList.add('active');
    this.menuButton.setAttribute('aria-label', 'Close Menu');
    this.menu.classList.add('show');
    this.main.classList.add('menu-open');
    animateMask(this.menu, 0.3);
    lockScroll();
    this.toggleMenuEvents(true);
  }

  private handleNavBtnHover = (event: Event): void => {
    if (this.hoverTimeout) return;
    const target = event.currentTarget as HTMLElement;
    audioCommands.playSound(target.id === 'nav-contact' ? SFX.CONTACT_HOVER : SFX.ABOUT_HOVER);
    this.hoverTimeout = true;
    resetMask(target);
    animateMask(target, 0);
    const timer = setTimeout(() => {
      this.hoverTimeout = false;
      this.timers.delete(timer);
    }, 100);
    this.timers.add(timer);
  };

  private initiateCooldown(): void {
    this.isCooldown = true;
    const timer = setTimeout(() => {
      this.isCooldown = false;
      this.menuButton.disabled = false;
      this.timers.delete(timer);
    }, 500);
    this.timers.add(timer);
  }

  dispose(): void {
    this.removeMenuCloseListeners();
    this.menuButton.removeEventListener('click', this.handleMenuButtonClick);
    this.navButtons.forEach((btn) => {
      btn.removeEventListener('click', this.triggerSubpage);
      btn.removeEventListener('mouseenter', this.handleNavBtnHover);
    });
    this.logoText.removeEventListener('click', this.handleLogoClick);
    this.logoMark.removeEventListener('click', this.handleLogoClick);
    this.navBtnLogo3d.removeEventListener('click', this.handleLogoClick);
    this.menuButton.removeEventListener('mouseenter', this.onMenuButtonEnter);
    this.menuButton.removeEventListener('mouseleave', this.onMenuButtonLeave);
    this.contactHeader.removeEventListener('mouseenter', this.playSoundSimpleHover);
    this.contactHeader.removeEventListener('mouseleave', this.playSoundSimpleOut);
    if (this.cleanMaskTimeout) clearTimeout(this.cleanMaskTimeout);
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }
}
