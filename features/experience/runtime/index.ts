/**
 * Experience runtime entry point (port of the original `Li` + `rn` bootstrap).
 *
 * `startExperience()` boots the render worker, then installs every controller in the same
 * order as the original. The returned handle disposes everything: worker, audio, scroll,
 * UI listeners, timers and the rAF loop. Booting is abortable so React Strict Mode's
 * double-invocation and route changes never leave two runtimes alive.
 */
import { analytics } from '@/lib/analytics';
import { AudioManager } from '@/lib/audio/AudioManager';
import { audioCommands } from '@/lib/audio/events';
import { SFX } from '@/lib/audio/manifest';
import { installOutboundTracking } from '@/lib/content/track-outbound';
import { AudioTransitionsController } from './audio-transitions';
import { startConsoleBanner } from './banner';
import { isMobileOrTablet, prefersReducedMotion } from './device';
import { bootEngine, describeHardware, EngineUnsupportedError, type BootResult } from './engine';
import { events } from './events';
import { setupGyroscope } from './gyro';
import { ExperienceNavigation, type RouterLike } from './navigation';
import { Autoscroll } from './scroll/autoscroll';
import { setupLenis } from './scroll/lenis';
import { MainScrollController } from './scroll/main-scroll';
import { ANCHOR_EVENTS } from './scroll/pagination';
import { SectionsController } from './sections';
import { store } from './store';
import { ticker } from './ticker';
import { updateNavigationLinks } from './ui/language';
import { MenuController } from './ui/menu';
import { SoundButton } from './ui/sound-button';
import { animateAboutEnter, animateContactEnter } from './ui/subpage';
import { clearTopPageTimers, collectHeadlines, completeIntro } from './ui/top-page';

export interface ExperienceRuntime {
  readonly navigation: ExperienceNavigation;
  readonly audio: AudioManager | null;
  dispose(): void;
}

export interface StartOptions {
  router: RouterLike;
  onStatus?(status: 'booting' | 'ready' | 'started' | 'unsupported' | 'error', detail?: unknown): void;
  /** Called synchronously with the navigation controller, before the engine boots. */
  onNavigationCreated?(navigation: ExperienceNavigation): void;
}

/** Shows the loading UI (port of `Rs`). */
const showLoadingUI = (): void => {
  document.querySelector('.loading-logo')?.classList.add('show');
  document.querySelector('.ll-video')?.classList.add('show');
  document.querySelector('header')?.classList.add('show');
  document.querySelector('.loading-cnt')?.classList.add('show');
};

export async function startExperience(options: StartOptions): Promise<ExperienceRuntime> {
  const disposers: Array<() => void> = [];
  let disposed = false;
  let boot: BootResult | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!disposed) fn();
    }, ms);
    timers.add(t);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    clearTopPageTimers();
    disposers.splice(0).reverse().forEach((d) => {
      try {
        d();
      } catch (error) {
        console.error('[experience] dispose failed', error);
      }
    });
    boot?.dispose();
    boot = null;
    events.clear();
    ticker.dispose();
    store.reset();
    document.body.classList.remove('interactive', 'sp-txt', 'autoscroll');
    document.body.removeAttribute('data-lenis-prevent');
    document.body.style.overflow = '';
  };

  const startTime = Date.now();
  options.onStatus?.('booting');
  const navigation = new ExperienceNavigation(options.router);
  disposers.push(() => navigation.dispose());
  options.onNavigationCreated?.(navigation);
  // Language specific labels/hrefs of the shared header markup (port of `kn`, run early so
  // the menu is correct even before the engine finished loading).
  updateNavigationLinks();

  const runtime: ExperienceRuntime = {
    navigation,
    get audio() {
      return audio;
    },
    dispose,
  };
  let audio: AudioManager | null = null;

  try {
    boot = await bootEngine();
  } catch (error) {
    if (error instanceof EngineUnsupportedError) options.onStatus?.('unsupported', error.message);
    else options.onStatus?.('error', error);
    console.error('[experience] engine boot failed', error);
    // Keep the page usable: header + navigation still work without the 3D scene.
    showLoadingUI();
    document.getElementById('loader')?.classList.add('complete', 'close', 'hide');
    document.getElementById('head')?.classList.add('active');
    navigation.init();
    disposers.push(installOutboundTracking());
    return runtime;
  }
  if (disposed) {
    boot.dispose();
    return runtime;
  }
  const { api } = boot;

  // ---- port of `rn` -------------------------------------------------------------------
  navigation.init();
  showLoadingUI();
  disposers.push(setupGyroscope(api));
  audio = new AudioManager({
    isTouchDevice: isMobileOrTablet(),
    isWebsiteStarted: () => store.state.websiteStarted,
    on: (name, handler) => events.on(name, handler as (data: unknown) => void),
    onRenderedReady: (handler) => events.on('renderedReady', handler),
    onAnchorScrollStarted: (handler) => {
      const listener = (event: Event): void => handler((event as CustomEvent<{ section: string }>).detail.section);
      document.addEventListener(ANCHOR_EVENTS.STARTED, listener);
      return () => document.removeEventListener(ANCHOR_EVENTS.STARTED, listener);
    },
  });
  const audioRef = audio;
  disposers.push(() => audioRef.dispose());
  const transitions = new AudioTransitionsController();
  disposers.push(() => transitions.dispose());

  const menu = new MenuController(api);
  disposers.push(() => menu.dispose());
  const soundButton = new SoundButton();
  disposers.push(() => soundButton.dispose());

  const sections = new SectionsController();
  sections.addToStore();
  sections.updateDomHeight();
  const autoscroll = new Autoscroll();
  store.state.autoscroll = autoscroll;
  disposers.push(() => autoscroll.dispose());
  disposers.push(setupLenis(api));
  const mainScroll = new MainScrollController(store.state.lenis!, autoscroll);
  disposers.push(() => mainScroll.dispose());
  const onSmoothScroll = (event: Event): void => sections.updateProgress((event as CustomEvent<number>).detail);
  document.addEventListener('lenis:scroll', onSmoothScroll);
  disposers.push(() => document.removeEventListener('lenis:scroll', onSmoothScroll));
  const onResize = (): void => sections.updateDomHeight();
  window.addEventListener('resize', onResize);
  disposers.push(() => window.removeEventListener('resize', onResize));

  const clickTrackers: Array<[Element | null, () => void]> = [
    [document.querySelector('.logomark-header'), () => analytics.buttonClick('logo', 'navigation', 'click', 'home')],
    [document.querySelector('.logotext-header'), () => analytics.buttonClick('logo-text', 'navigation', 'click', 'home')],
    [document.getElementById('contact-nav'), () => analytics.buttonClick('contact-nav', 'navigation', 'click', 'contact')],
  ];
  document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
    clickTrackers.push([btn, () => analytics.buttonClick(btn.id, 'navigation', 'click')]);
  });
  clickTrackers.forEach(([el, fn]) => {
    el?.addEventListener('click', fn);
    disposers.push(() => el?.removeEventListener('click', fn));
  });
  disposers.push(installOutboundTracking());

  // ---- port of `Li` -------------------------------------------------------------------
  disposers.push(
    events.on('introCheetahSeen', () => {
      store.state.introCheetahSeen = true;
    }),
  );
  let launchTime = 0;
  disposers.push(
    events.once<{ threadType: string; renderBackend: string; hardwareInfo: string }>('debugInfos', ({ threadType, renderBackend, hardwareInfo }) => {
      analytics.setUserProperties({ threadType, renderBackend, launchTime, hardwareInfo });
      disposers.push(startConsoleBanner(threadType, renderBackend));
    }),
  );
  // The worker only reports its backend in debug mode; report ours for analytics.
  void describeHardware(boot.isWebGPU).then((info) => {
    if (!disposed && !events.data.has('debugInfos')) {
      events.trigger({ name: 'debugInfos' }, { threadType: 'WORKER THREAD (OffScreenCanvas)', renderBackend: boot?.isWebGPU ? 'WebGPU' : 'WebGL', hardwareInfo: info });
    }
  });

  const loadingText = document.getElementById('loading');
  const startButton = document.getElementById('start');
  const loader = document.getElementById('loader');
  const loadingLogo = document.querySelector('.loading-logo');
  const loadingVideo = document.querySelector('.ll-video');
  let lastFps = 0;
  let ready = false;

  disposers.push(
    events.on<{ progress: number }>('loadProgress', ({ progress }) => {
      if (loadingText) loadingText.innerHTML = `${Math.round(progress)}%`;
    }),
  );
  disposers.push(
    events.on<{ fps: number }>('collectFps', ({ fps }) => {
      if (lastFps !== fps) {
        analytics.userFps(fps);
        lastFps = fps;
      }
    }),
  );

  const startWebsite = (): void => {
    if (disposed || store.state.websiteStarted) return;
    analytics.enterButtonClick();
    audioCommands.playSound(SFX.OPEN_WEBSITE);
    document.querySelector('.htibtn_cont_pulsar')?.classList.add('loaded');
    store.state.websiteStarted = true;
    api.trigger({ name: 'startWebsite' }, { initial: true });
    events.trigger({ name: 'startWebsite' });
    completeIntro();
    loader?.classList.add('close');
    document.getElementById('head')?.classList.add('active');
    later(() => loader?.classList.add('hide'), 700);
    animateAboutEnter();
    animateContactEnter();
    options.onStatus?.('started');
  };

  const onStartClick = (): void => startWebsite();
  disposers.push(
    events.on('renderedReady', () => {
      if (ready || disposed) return;
      ready = true;
      launchTime = Date.now() - startTime;
      api.trigger({ name: 'feedLocalizationToCanvas' }, { headlines: collectHeadlines() });
      if (startButton) startButton.style.display = 'block';
      loader?.classList.add('complete');
      loadingLogo?.classList.add('hide');
      loadingVideo?.classList.add('hide');
      later(() => loadingVideo?.classList.add('disable'), 1000);
      analytics.pageFullyLoaded();
      options.onStatus?.('ready');
      if (window.innerWidth < 767) startWebsite();
      else {
        startButton?.addEventListener('click', onStartClick, { once: true });
        disposers.push(() => startButton?.removeEventListener('click', onStartClick));
      }
    }),
  );

  // Pause the main-thread loop while the tab is hidden; the worker throttles itself.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') ticker.pause();
    else ticker.resume();
  };
  document.addEventListener('visibilitychange', onVisibility);
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibility));

  if (prefersReducedMotion()) document.documentElement.classList.add('reduced-motion');

  return runtime;
}
