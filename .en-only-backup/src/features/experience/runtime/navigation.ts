/**
 * Client-side page transitions between the experience routes.
 *
 * Replaces Taxi.js. The lifecycle order is the same as Taxi's: `NAVIGATE_OUT` →
 * renderer.onLeave → transition.onLeave → (React swaps the view) → transition.onEnter →
 * renderer.onEnter → renderer.onEnterCompleted → `NAVIGATE_END`. Timings and DOM class
 * changes are ports of the original `si` (transition), `hi` (top renderer) and `nn`
 * (about/contact renderer).
 *
 * Links to any other page (blog, works, …) are left to the browser, exactly like before.
 */
import { analytics } from '@/lib/analytics';
import { audioCommands } from '@/lib/audio/events';
import { SFX } from '@/lib/audio/manifest';
import { getSections } from './sections';
import { store } from './store';
import { lockScroll } from './scroll/scroll-lock';
import { updateNavigationLinks } from './ui/language';
import { setInSubpage } from './ui/menu';
import { animateAboutEnter, animateContactEnter, ContactLinksController, HoverSfxController, ScrollContainerController, TabsController } from './ui/subpage';
import { InteractionAreasController, completeIntro, feedLocalization } from './ui/top-page';

export type ViewName = 'top' | 'about' | 'contact';

export const EXPERIENCE_ROUTES: Record<string, ViewName> = {
  '/': 'top',
  '/about': 'about',
  '/contact': 'contact',
  '/ja': 'top',
  '/ja/about': 'about',
  '/ja/contact': 'contact',
  '/fr': 'top',
  '/fr/about': 'about',
  '/fr/contact': 'contact',
};

export const normalizePath = (pathname: string): string => (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname);

export const viewForPath = (pathname: string): ViewName | null => EXPERIENCE_ROUTES[normalizePath(pathname)] ?? null;

export interface RouterLike {
  push(href: string): void;
}

interface Renderer {
  onEnter(): void;
  onEnterCompleted(): void;
  onLeave(): void;
  dispose(): void;
}

class TopRenderer implements Renderer {
  private interactionAreas: InteractionAreasController | null = null;
  private sfx: HoverSfxController | null = null;
  private topEnteredTimeout: ReturnType<typeof setTimeout> | null = null;

  onEnter(): void {
    setInSubpage(false);
  }

  onEnterCompleted(): void {
    if (store.state.websiteStarted) store.apiOrNull?.trigger({ name: 'startWebsite' });
    document.querySelector('header')?.classList.remove('page-transition');
    this.interactionAreas = new InteractionAreasController();
    this.sfx = new HoverSfxController([document.querySelector('.end-link')]);
    document.querySelector('.htibtn')?.classList.remove('disable');
    getSections()
      .filter((s) => s.dom)
      .forEach((s) => {
        const headline = document.querySelector<HTMLElement>(`.headline-${s.id}`);
        if (headline) headline.style.height = `${(s.screenHeight ?? 0) * 100}vh`;
      });
    this.topEnteredTimeout = setTimeout(() => document.dispatchEvent(new CustomEvent('top-entered')), 1);
    updateNavigationLinks();
    completeIntro();
    feedLocalization();
  }

  onLeave(): void {
    this.dispose();
    document.querySelector('.htibtn')?.classList.add('disable');
    document.querySelector('header')?.classList.add('page-transition');
    document.dispatchEvent(new CustomEvent('CHANGE_PAGE'));
  }

  dispose(): void {
    if (this.topEnteredTimeout) clearTimeout(this.topEnteredTimeout);
    this.interactionAreas?.kill();
    this.interactionAreas = null;
    this.sfx?.dispose();
    this.sfx = null;
  }
}

class SubpageRenderer implements Renderer {
  private tabs: TabsController | null = null;
  private scroll: ScrollContainerController | null = null;
  private contact: ContactLinksController | null = null;
  private sfx: HoverSfxController | null = null;

  onEnter(): void {
    setInSubpage(true);
  }

  onEnterCompleted(): void {
    this.tabs = new TabsController();
    this.scroll = new ScrollContainerController();
    this.contact = new ContactLinksController();
    const items: Array<Element | null> = [...document.querySelectorAll('.tab-nav-btn'), ...document.querySelectorAll('.sns-item')];
    items.push(document.querySelector('.schedule-call'));
    items.push(document.getElementById('map-link'));
    this.sfx = new HoverSfxController(items);
    document.querySelector('header')?.classList.remove('page-transition');
    document.querySelector('main')?.classList.remove('interacting');
    document.querySelector('.htibtn')?.classList.add('disable');
    document.dispatchEvent(new CustomEvent('subpage-entered'));
    lockScroll();
    updateNavigationLinks();
  }

  onLeave(): void {
    document.querySelector('header')?.classList.add('page-transition');
    this.dispose();
    document.dispatchEvent(new CustomEvent('CHANGE_PAGE'));
  }

  dispose(): void {
    this.tabs?.kill();
    this.scroll?.kill();
    this.contact?.kill();
    this.sfx?.dispose();
    this.tabs = null;
    this.scroll = null;
    this.contact = null;
    this.sfx = null;
  }
}

const createRenderer = (view: ViewName): Renderer => (view === 'top' ? new TopRenderer() : new SubpageRenderer());

/** Port of the default transition `si`. */
const transition = {
  leave(done: () => void): ReturnType<typeof setTimeout> {
    document.querySelector('.top-container')?.classList.add('hide');
    document.querySelector('.contact')?.classList.add('hide');
    document.querySelector('.about')?.classList.add('hide');
    document.querySelector('.sections-headlines')?.classList.add('hide');
    const settings = store.getSettings();
    const menuIdle = settings.animMenu.value === 0;
    const sameKind = store.state.inSubpage === settings.navigateToSubPage;
    const withMenu = menuIdle && !sameKind && store.state.websiteStarted;
    if (withMenu) {
      document.querySelector('main')?.classList.add('menu-open');
      store.setSettings({ pageTransition: true });
      store.apiOrNull?.trigger({ name: 'pageTransition' }, { pageTransition: true });
      store.apiOrNull?.trigger({ name: 'menuOpen' }, { open: true });
    }
    return setTimeout(done, withMenu ? 1000 : 600);
  },
  enter(done: () => void): ReturnType<typeof setTimeout> {
    document.querySelector('main')?.classList.remove('menu-open');
    store.apiOrNull?.trigger({ name: 'menuOpen' }, { open: false });
    analytics.pageView(window.location.pathname, document.title);
    store.apiOrNull?.trigger({ name: 'pageTransition' }, { pageTransition: false });
    done();
    return setTimeout(() => {
      document.querySelector('.top-container')?.classList.remove('hide');
      if (store.state.websiteStarted) {
        animateAboutEnter();
        animateContactEnter();
      }
    }, 10);
  },
};

export class ExperienceNavigation {
  private renderer: Renderer | null = null;
  private currentView: ViewName | null = null;
  private currentPath: string;
  private transitioning = false;
  private pendingHref: string | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private onNavigateEnd: Array<() => void> = [];
  private disposed = false;
  private initialized = false;

  constructor(private readonly router: RouterLike) {
    this.currentPath = normalizePath(window.location.pathname);
    document.addEventListener('click', this.onClick);
  }

  /**
   * Equivalent of Taxi's initial load: runs the current renderer's enter hooks. Until this
   * is called (after the engine booted) links behave like plain links, as in the original.
   */
  init(): void {
    this.initialized = true;
    this.currentPath = normalizePath(window.location.pathname);
    const view = viewForPath(this.currentPath);
    if (!view) return;
    this.currentView = view;
    this.renderer = createRenderer(view);
    this.renderer.onEnter();
    this.renderer.onEnterCompleted();
  }

  private track(timer: ReturnType<typeof setTimeout>): void {
    this.timers.add(timer);
  }

  private onClick = (event: MouseEvent): void => {
    if (!this.initialized) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
    if (!anchor || anchor.target || anchor.hasAttribute('data-taxi-ignore')) return;
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    let url: URL;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    const targetView = viewForPath(url.pathname);
    if (!targetView) return; // content pages: full navigation like the original
    event.preventDefault();
    if (normalizePath(url.pathname) === this.currentPath) return;
    this.navigateTo(url.pathname + url.search + url.hash);
  };

  navigateTo(href: string): void {
    if (this.disposed) return;
    if (this.transitioning) {
      console.warn('A transition is currently in progress');
      return;
    }
    const targetPath = normalizePath(new URL(href, window.location.href).pathname);
    const targetView = viewForPath(targetPath);
    if (!targetView) {
      window.location.href = href;
      return;
    }
    this.transitioning = true;
    this.pendingHref = targetPath;
    // NAVIGATE_OUT
    const toSubpage = targetPath.includes('contact') || targetPath.includes('about');
    store.setSettings({ navigateToSubPage: toSubpage });
    if (store.getSettings().menuOpen) setInSubpage(toSubpage);
    this.renderer?.onLeave();
    this.track(
      transition.leave(() => {
        if (this.disposed) return;
        this.renderer?.dispose();
        this.renderer = null;
        this.router.push(href);
      }),
    );
  }

  /**
   * Called by the React view when it has mounted. Completes a pending transition, or — for
   * browser back/forward — runs the leave/enter sequence immediately.
   */
  viewMounted(pathname: string): void {
    if (this.disposed) return;
    const path = normalizePath(pathname);
    const view = viewForPath(path);
    if (!view) return;
    if (!this.initialized) {
      // Initial render before the engine booted: `init()` will enter this view.
      this.currentPath = path;
      return;
    }
    if (path === this.currentPath && this.currentView === view && this.renderer) return;
    if (!this.transitioning) {
      // popstate / external route change: leave the previous view right away
      this.transitioning = true;
      const toSubpage = view !== 'top';
      store.setSettings({ navigateToSubPage: toSubpage });
      this.renderer?.onLeave();
      this.renderer?.dispose();
      this.renderer = null;
      document.querySelector('.top-container')?.classList.add('hide');
      document.querySelector('.sections-headlines')?.classList.add('hide');
    }
    this.currentPath = path;
    this.currentView = view;
    this.pendingHref = null;
    audioCommands.stopSound(SFX.LOGO_LOOP);
    // NAVIGATE_IN
    this.renderer = createRenderer(view);
    const renderer = this.renderer;
    this.track(
      transition.enter(() => {
        renderer.onEnter();
        renderer.onEnterCompleted();
        this.transitioning = false;
        window.dispatchEvent(new CustomEvent('kiasa:navigation'));
        this.onNavigateEnd.forEach((cb) => cb());
      }),
    );
  }

  get isTransitioning(): boolean {
    return this.transitioning;
  }

  dispose(): void {
    this.disposed = true;
    document.removeEventListener('click', this.onClick);
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.renderer?.dispose();
    this.renderer = null;
  }
}
