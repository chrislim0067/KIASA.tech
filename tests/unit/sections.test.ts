import { beforeEach, describe, expect, it } from 'vitest';
import { SectionsController, getSections } from '@/features/experience/runtime/sections';
import { store } from '@/features/experience/runtime/store';

describe('SectionsController', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    store.reset();
  });

  it('sizes the scroll spacer to 12.5 screens and derives the section ranges', () => {
    const controller = new SectionsController();
    expect(document.getElementById('app')?.style.height).toBe('1250vh');
    const s2 = controller.sections.find((s) => s.id === 'section2')!;
    expect(s2.from).toBeCloseTo(0.12, 5);
    expect(s2.to).toBeCloseTo(0.4, 5);
    expect(s2.interactionFrom).toBeCloseTo(0.24, 5);
    const s4 = controller.sections.find((s) => s.id === 'section4')!;
    expect(s4.from).toBeCloseTo(0.525, 3);
    const magnet = controller.sections.find((s) => s.id === 'sectionEndMagnet')!;
    expect(magnet.scrollTo).toBe(1);
  });

  it('updates the progress uniforms and current section', () => {
    const controller = new SectionsController();
    controller.addToStore();
    controller.updateProgress(0);
    expect(store.state.sections.current).toBe('section1');
    controller.updateProgress(0.3);
    expect(store.state.sections.current).toBe('section2');
    expect(store.state.sections.twoProgress.value).toBeGreaterThan(0);
    expect(store.state.sections.twoProgress.value).toBeLessThan(1);
    controller.updateProgress(1);
    expect(store.state.sections.fiveProgress.value).toBe(1);
  });

  it('keeps the original section table', () => {
    const ids = getSections().map((s) => s.id);
    expect(ids).toEqual(['section1', 'section2', 'section3', 'section4', 'section5', 'section1End', 'section2Intro', 'section2End', 'section1Magnet', 'sectionEndMagnet']);
  });
});
