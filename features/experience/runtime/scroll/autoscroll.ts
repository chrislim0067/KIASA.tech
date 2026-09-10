/**
 * Automatic scrolling through section 3 / the end of section 2 (port of `pi`).
 * Driven from the shared rAF loop through `store.state.autoscroll`.
 */
import { supportsFractionalScroll, hasTouch } from '../device';
import { events } from '../events';
import { damp, easeInOutQuad, lerp } from '../math';
import { store, type AutoscrollLike, type LenisLike } from '../store';
import { lockScroll, unlockScroll } from './scroll-lock';

export class Autoscroll implements AutoscrollLike {
  lenis: LenisLike | null = null;
  direction: 1 | -1 = 1;
  started = false;
  enableUserScroll = true;
  private readonly supportsFractionalScroll: boolean;
  private lastTouchY = 0;
  private scrollEnableSmooth = 1;
  private readonly isTouchDevice: boolean;
  private readonly thresholdDirection: number;
  private readonly transition1ScrollIncrease: number;
  private scrollAccumulator = 0;
  private speedBaseScroll = 2;
  private keyboardExtraSpeed = 0;
  private backSlowDownSection1 = 0;
  private blockScrollTransition = false;
  private isSlowingDown = false;
  private scrollMultiplier = 1;
  private targetMultiplier = 1;
  private readonly targetMultiplierSlow = 0.2;
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.supportsFractionalScroll = supportsFractionalScroll();
    this.isTouchDevice = hasTouch();
    this.thresholdDirection = this.isTouchDevice ? 3 : 0;
    this.transition1ScrollIncrease = this.isTouchDevice ? 9 : 6;
    if (this.isTouchDevice) document.addEventListener('pointerdown', this.handleTouchStart);
  }

  start(direction: 1 | -1 = 1): void {
    this.started = true;
    this.isSlowingDown = false;
    this.scrollAccumulator = 0;
    this.scrollMultiplier = 1;
    this.targetMultiplier = 1;
    this.direction = direction;
    this.addDirectionEventListener();
    window.scrollBy(0, this.direction);
  }

  private addDirectionEventListener(): void {
    if (this.isTouchDevice) {
      document.addEventListener('touchmove', this.handleTouchMove, { passive: true });
      document.addEventListener('touchend', this.handleTouchEnd);
    } else {
      window.addEventListener('keydown', this.handleKeyDown);
      window.addEventListener('keyup', this.handleKeyUp);
      window.addEventListener('mousedown', this.handleMouseDown);
      window.addEventListener('mouseup', this.handleMouseUp);
    }
  }

  private removeDirectionEventListener(): void {
    if (this.isTouchDevice) {
      document.removeEventListener('touchmove', this.handleTouchMove);
      document.removeEventListener('touchend', this.handleTouchEnd);
    } else {
      window.removeEventListener('keydown', this.handleKeyDown);
      window.removeEventListener('keyup', this.handleKeyUp);
      window.removeEventListener('mousedown', this.handleMouseDown);
      window.removeEventListener('mouseup', this.handleMouseUp);
    }
  }

  private handleTouchStart = (event: PointerEvent): void => {
    this.lastTouchY = event.clientY;
  };

  private handleTouchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY ?? this.lastTouchY;
    const delta = this.lastTouchY - y;
    if (Math.abs(delta) < this.thresholdDirection) return;
    this.updateDirection(delta > 0 ? 1 : -1);
  };

  private handleTouchEnd = (): void => {
    this.lastTouchY = 0;
  };

  private releaseSpeed(): void {
    if (this.holdTimeout) {
      clearTimeout(this.holdTimeout);
      this.holdTimeout = null;
    }
    if (this.isSlowingDown) this.speedUp();
  }

  private handleMouseDown = (): void => {
    this.holdTimeout = setTimeout(() => this.slowDown(), 50);
  };

  private handleMouseUp = (): void => {
    this.releaseSpeed();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === ' ') {
      this.updateDirection(event.key !== 'ArrowUp' ? 1 : -1);
      this.keyboardExtraSpeed = 5;
    }
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === ' ') this.keyboardExtraSpeed = 0;
  };

  private updateDirection(direction: 1 | -1): void {
    this.direction = direction;
  }

  isStarted(): boolean {
    return this.started;
  }

  stop(): void {
    this.scrollAccumulator = 0;
    this.started = false;
    this.isSlowingDown = false;
    this.scrollMultiplier = 1;
    this.targetMultiplier = 1;
    this.removeDirectionEventListener();
    this.keyboardExtraSpeed = 0;
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    this.holdTimeout = null;
  }

  private slowDown(): void {
    if (this.isSlowingDown) return;
    this.isSlowingDown = true;
    this.targetMultiplier = this.targetMultiplierSlow;
  }

  private speedUp(): void {
    this.isSlowingDown = false;
    this.targetMultiplier = 1;
  }

  private getScrollAmount(amount: number): number {
    if (this.supportsFractionalScroll) return amount;
    if (Math.abs(amount) >= 1) {
      this.scrollAccumulator = 0;
      return amount;
    }
    this.scrollAccumulator += amount;
    const whole = Math.trunc(this.scrollAccumulator);
    this.scrollAccumulator -= whole;
    return whole;
  }

  private checkIfLockScroll(lock = false): void {
    if (lock) {
      if (!this.blockScrollTransition) {
        lockScroll();
        this.blockScrollTransition = true;
      }
    } else if (this.blockScrollTransition) {
      unlockScroll();
      this.blockScrollTransition = false;
    }
  }

  onRaf({ delta }: { delta: number }): void {
    if (!this.started || store.state.inSubpage) return;
    const step = 150 * Math.min(0.1, delta);
    const { sections } = store.state;
    const twoEnd = sections.twoEndProgress.value;
    const one = sections.oneProgress.value;
    const twoIntro = sections.twoIntroProgress.value;
    const three = sections.threeProgress.value;
    const transition1 = easeInOutQuad(one - twoIntro);
    const transition1Factor = 1 + transition1 * (this.transition1ScrollIncrease - this.backSlowDownSection1);
    this.backSlowDownSection1 = damp(this.backSlowDownSection1, this.direction === 1 ? 0 : 3, 2, delta);
    this.checkIfLockScroll(transition1 > 0.05);
    const twoEndFactor = twoEnd === 1 ? 1 : 1 + twoEnd * 6;
    const nearEndOfThree = three > 0.7;
    const extraBase = three < 0.1 ? 1 : 0;
    this.speedBaseScroll = three > 0 && three < 1 ? 1 : 2;
    const userFactor = 0.05 + 0.5 * twoEnd + Math.min(0.45, three * 1.3);
    const smoothBoost = twoEnd < 1 ? 1 - twoEnd : nearEndOfThree ? (three - 0.7) * 6 : 0;
    this.scrollEnableSmooth = damp(this.scrollEnableSmooth, this.enableUserScroll ? 1 : 0, 4 + smoothBoost * 40, delta);
    const virtual = this.blockScrollTransition ? 0 : store.state.virtualScroll * 0.6;
    if (virtual !== 0 && !this.blockScrollTransition) {
      if (!this.isTouchDevice) this.updateDirection(virtual > 0 ? 1 : -1);
      store.state.virtualScroll = 0;
    }
    if (this.blockScrollTransition) store.state.virtualScroll = 0;
    this.scrollMultiplier = lerp(this.scrollMultiplier, this.targetMultiplier, delta * 3);
    this.scrollMultiplier = Math.max(0, Math.min(1, this.scrollMultiplier));
    const base = this.direction * (this.speedBaseScroll + extraBase) * this.scrollMultiplier * transition1Factor * twoEndFactor * step;
    const keyboard = this.direction * this.keyboardExtraSpeed * this.scrollMultiplier;
    const user = virtual * userFactor * this.scrollMultiplier;
    const amount = this.getScrollAmount(this.isTouchDevice ? base : base + (keyboard + user) * this.scrollEnableSmooth);
    if (amount === 0) return;
    const payload: { target: number; options: { lock: boolean; immediate: boolean } } = {
      target: window.scrollY + amount,
      options: { lock: false, immediate: true },
    };
    if (this.isTouchDevice) {
      const velocity = this.lenis?.velocity ?? 0;
      if (Math.abs(velocity) < 1 || this.blockScrollTransition) payload.options.lock = true;
      else return;
    }
    events.trigger({ name: 'lenis:scrollTo' }, payload);
  }

  dispose(): void {
    this.stop();
    if (this.isTouchDevice) document.removeEventListener('pointerdown', this.handleTouchStart);
    this.checkIfLockScroll(false);
  }
}
