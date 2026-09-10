/**
 * Scroll section configuration and progress computation (port of the `It` class).
 * The page height is `sum(screenHeight) * 100vh`; every section maps a 0..1 progress
 * range onto one of the worker uniforms.
 */
import { rangeProgress } from './math';
import { store, type SectionProgressKey } from './store';
import { TRANSITIONS } from '@/lib/audio/manifest';

export interface SectionConfig {
  id: string;
  progress: 'one' | 'two' | 'oneEnd' | 'twoEnd' | 'three' | 'fourth' | 'five' | 'oneMagnet' | 'endMagnet' | 'twoIntro';
  from?: number;
  to?: number | string;
  screenHeight?: number;
  fromOffset?: number;
  relativeTo?: 'one' | 'two';
  analytics?: boolean;
  dom?: boolean;
  main?: boolean;
  interactionArea?: boolean;
  interactionFrom?: number;
  interactionTo?: number;
  interactionFromOffset?: number;
  interactionToOffset?: number;
  interactionCompleted?: boolean;
  maxScroll?: number;
  autoScroll?: boolean;
  magnet?: boolean;
  scrollFrom?: number;
  scrollTo?: number | string;
  duration?: number;
  backDuration?: number;
  scrollEase?: string;
  transition?: string;
  transitions?: { in?: string; inDelay?: number };
  headlineFromPercent?: number;
  headlineToPercent?: number;
  headlineFrom?: number;
  headlineTo?: number;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export const getSections = (): SectionConfig[] => [
  { id: 'section1', progress: 'one', from: 0, screenHeight: 1.5, analytics: true, dom: true, headlineFromPercent: 0, headlineToPercent: 0.01 },
  { id: 'section2', progress: 'two', screenHeight: 3.5, interactionArea: true, interactionFromOffset: 0.16, maxScroll: 0.38, interactionTo: 0.32, analytics: true, dom: true, headlineFromPercent: 0.42, headlineToPercent: 0.715 },
  { id: 'section3', progress: 'three', screenHeight: 2, autoScroll: true, analytics: true, dom: true, main: true, headlineFromPercent: 0.04, headlineToPercent: 0.73 },
  { id: 'section4', progress: 'fourth', screenHeight: 3.5, fromOffset: -0.44, interactionArea: true, interactionFrom: 0.56, interactionToOffset: 0.08, maxScroll: 0.56, analytics: true, dom: true, headlineFromPercent: 0.1, headlineToPercent: 0.72 },
  { id: 'section5', progress: 'five', screenHeight: 2, to: 1, analytics: true },
  { id: 'section1End', progress: 'oneEnd', from: 0.08, to: 0.3, relativeTo: 'one' },
  { id: 'section2Intro', progress: 'twoIntro', from: 0.12, to: 0.24 },
  { id: 'section2End', progress: 'twoEnd', autoScroll: true, from: 0.32, to: 'section3' },
  { id: 'section1Magnet', progress: 'oneMagnet', autoScroll: true, from: 0, to: 0.24 },
  { id: 'sectionEndMagnet', progress: 'endMagnet', from: 0.73, scrollFrom: 0.7, magnet: true, scrollTo: 1, to: 0.95, duration: 7, backDuration: 5, scrollEase: 'sine.inOut', transition: TRANSITIONS.TRANSITION_SCENE_4_TO_5 },
];

export class SectionsController {
  readonly sections: SectionConfig[];

  constructor() {
    this.sections = getSections();
    this.updateDomHeight();
  }

  addToStore(): void {
    store.state.sectionsDom = this.sections;
  }

  /** Computes the from/to ranges and sets the scrollable height of `#app`. */
  updateDomHeight(): void {
    let totalScreens = 0;
    this.sections.forEach((s) => {
      if (s.screenHeight) totalScreens += s.screenHeight;
    });
    const app = document.getElementById('app');
    if (app) app.style.height = `${totalScreens * 100}vh`;

    let cursor = 0;
    this.sections.forEach((s) => {
      if (s.from === undefined) s.from = cursor;
      if (s.fromOffset) s.from = round3(cursor + s.fromOffset / totalScreens);
      if (s.to === undefined) s.to = round3(s.from + (s.screenHeight ?? 0) / totalScreens);
      if (typeof s.to === 'string') {
        const target = this.sections.find((o) => o.id === s.to);
        s.to = Math.max(target?.from ?? 0, s.from + 0.01);
      }
      const to = s.to;
      if (s.interactionArea) {
        if (!s.interactionFrom) s.interactionFrom = to - (s.interactionFromOffset ?? 0.01);
        if (!s.interactionTo) s.interactionTo = round3(to - (s.interactionToOffset ?? 0));
      }
      if (typeof s.scrollTo === 'string') {
        const target = this.sections.find((o) => o.id === s.scrollTo);
        s.scrollTo = target?.from;
      }
      if (s.headlineFromPercent !== undefined) {
        const span = to - s.from;
        s.headlineFrom = round3(s.from + s.headlineFromPercent * span);
        s.headlineTo = round3(s.from + (s.headlineToPercent ?? 0) * span);
      }
      cursor = to;
    });
  }

  /** Called with the smoothed Lenis progress every frame. */
  updateProgress(progress: number): void {
    let current: string | null = null;
    const { sections } = store.state;
    this.sections.forEach((s, index) => {
      if (!s.id) return;
      const key = `${s.progress}Progress` as SectionProgressKey;
      const base = s.relativeTo ? sections[`${s.relativeTo}Progress` as SectionProgressKey].value : progress;
      const value = rangeProgress(s.from ?? 0, s.to as number, base);
      sections[key].value = value;
      if (index < 5 && value > 0 && value <= 1) current = s.id;
    });
    if (progress === 0) current = 'section1';
    sections.current = current;
    const progressValues = this.sections.map((s) => ({
      id: `${s.progress}Progress`,
      progress: sections[`${s.progress}Progress` as SectionProgressKey].value,
    }));
    store.apiOrNull?.trigger({ name: 'sectionProgress' }, { progressValues, currentSection: current });
  }
}
