/**
 * Shared mutable state of the experience.
 *
 * Port of the `q` (page state) and `Ft` (settings) objects of the original orchestration
 * bundle. The original stored Three.js TSL uniforms here because the same object was also
 * consumed by the (now removed) main-thread renderer; the worker only ever receives plain
 * numbers, so the values are kept as `{ value }` records.
 */
import type { EngineApi } from './engine-api';
import type { SectionConfig } from './sections';

export interface Uniform<T> {
  value: T;
}
export const uniform = <T>(value: T): Uniform<T> => ({ value });

export type SectionProgressKey =
  | 'oneProgress'
  | 'twoProgress'
  | 'oneEndProgress'
  | 'twoEndProgress'
  | 'threeProgress'
  | 'fourthProgress'
  | 'fiveProgress'
  | 'oneMagnetProgress'
  | 'endMagnetProgress'
  | 'twoIntroProgress';

export type SectionProgressState = Record<SectionProgressKey, Uniform<number>> & {
  current: string | null;
};

export interface AutoscrollLike {
  started: boolean;
  onRaf(payload: { delta: number }): void;
}

export interface LenisLike {
  progress: number;
  targetScroll: number;
  velocity: number;
  scrollTo(target: number | string | HTMLElement, options?: Record<string, unknown>): void;
  stop(): void;
  start(): void;
  raf(time: number): void;
}

export interface PageState {
  fourthAnimBreakPointStart: number;
  fourthAnimBreakPointEnd: number;
  spBreakPoint: number;
  websiteStarted: boolean;
  scroll: number;
  virtualScroll: number;
  inSubpage: boolean;
  introCheetahSeen: boolean;
  currentLang: string | null;
  sections: SectionProgressState;
  sectionsDom: SectionConfig[];
  lenis: LenisLike | null;
  autoscroll: AutoscrollLike | null;
}

export interface CanvasSize {
  width: number;
  height: number;
  dpr: number;
  ratio: number;
}

export interface Settings {
  dpr: number;
  anchorScrolling: boolean;
  menuOpen: boolean;
  pageTransition: boolean;
  navigateToSubPage: boolean;
  api: EngineApi | null;
  isWebGPU: boolean;
  isIOS: boolean;
  isSafari: boolean;
  isFirefox: boolean;
  isMobileOrTablet: boolean;
  lowSpeedVendor: boolean;
  isOffscreen: boolean;
  canvasSize: CanvasSize | null;
  /** Menu animation progress of the main-thread renderer. Always 0 with the worker renderer. */
  animMenu: Uniform<number>;
}

const createSectionProgress = (): SectionProgressState => ({
  oneProgress: uniform(0),
  twoProgress: uniform(0),
  oneEndProgress: uniform(0),
  twoEndProgress: uniform(0),
  threeProgress: uniform(0),
  fourthProgress: uniform(0),
  fiveProgress: uniform(0),
  oneMagnetProgress: uniform(0),
  endMagnetProgress: uniform(0),
  twoIntroProgress: uniform(0),
  current: 'section1',
});

export const createPageState = (): PageState => ({
  fourthAnimBreakPointStart: 0.7,
  fourthAnimBreakPointEnd: 0.95,
  spBreakPoint: 1024,
  websiteStarted: false,
  scroll: 0,
  virtualScroll: 0,
  inSubpage: false,
  introCheetahSeen: false,
  currentLang: null,
  sections: createSectionProgress(),
  sectionsDom: [],
  lenis: null,
  autoscroll: null,
});

export const createSettings = (): Settings => ({
  dpr: 1,
  anchorScrolling: false,
  menuOpen: false,
  pageTransition: false,
  navigateToSubPage: false,
  api: null,
  isWebGPU: true,
  isIOS: false,
  isSafari: false,
  isFirefox: false,
  isMobileOrTablet: false,
  lowSpeedVendor: false,
  isOffscreen: true,
  canvasSize: null,
  animMenu: uniform(0),
});

/** Singleton store — one experience runtime exists per document. */
export class Store {
  readonly state: PageState = createPageState();
  private settings: Settings = createSettings();

  getSettings(): Settings {
    return this.settings;
  }

  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
  }

  /** Engine API once the worker is initialised. Throws if used before boot. */
  get api(): EngineApi {
    const api = this.settings.api;
    if (!api) throw new Error('Experience engine is not initialised yet');
    return api;
  }

  get apiOrNull(): EngineApi | null {
    return this.settings.api;
  }

  reset(): void {
    Object.assign(this.state, createPageState());
    this.settings = createSettings();
  }
}

export const store = new Store();
