/**
 * Modulates the logo-loop low-pass filter with the cursor speed while the menu is open
 * (port of `mi`).
 */
import type { LowPassEffect } from './effects';

export class MenuSoundController {
  private menuIsOpen = false;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastTimestamp: number | null = null;
  private movementTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly normalFrequency = 100;
  private readonly minFrequency = 100;
  private readonly maxFrequency = 3000;
  private readonly movementDelay = 10;
  private logoElement: HTMLElement | null;

  constructor(private readonly lowPass: LowPassEffect) {
    this.logoElement = document.querySelector<HTMLElement>('.nav-logo-link');
    document.addEventListener('menuOpen', this.onMenuOpenEvent);
  }

  private onMenuOpenEvent = (event: Event): void => {
    const { open } = (event as CustomEvent<{ open: boolean }>).detail;
    if (this.menuIsOpen === open) return;
    this.menuIsOpen = open;
    if (open) this.onMenuOpen();
    else this.onMenuClose();
  };

  private onMenuOpen(): void {
    this.logoElement = document.querySelector<HTMLElement>('.nav-logo-link');
    this.logoElement?.addEventListener('mousemove', this.onMouseMove);
  }

  private onMenuClose(): void {
    this.logoElement?.removeEventListener('mousemove', this.onMouseMove);
    this.resetFrequency();
    this.lastTimestamp = null;
    if (this.movementTimeout) clearTimeout(this.movementTimeout);
  }

  private onMouseMove = (event: MouseEvent): void => {
    const now = performance.now();
    const { clientX, clientY } = event;
    if (this.lastTimestamp !== null) {
      const dt = (now - this.lastTimestamp) / 1000;
      const dx = clientX - this.lastMouseX;
      const dy = clientY - this.lastMouseY;
      const speed = Math.sqrt(dx ** 2 + dy ** 2) / dt;
      this.lowPass.updateFrequency(this.mapSpeedToFrequency(speed));
    }
    this.lastMouseX = clientX;
    this.lastMouseY = clientY;
    this.lastTimestamp = now;
    if (this.movementTimeout) clearTimeout(this.movementTimeout);
    this.movementTimeout = setTimeout(this.resetFrequency, this.movementDelay);
  };

  private mapSpeedToFrequency(speed: number): number {
    const t = (Math.min(Math.max(speed, 100), 2000) - 100) / 1900;
    return this.minFrequency + t * (this.maxFrequency - this.minFrequency);
  }

  private resetFrequency = (): void => {
    this.lowPass.rampTo(this.normalFrequency, 0.5);
  };

  dispose(): void {
    document.removeEventListener('menuOpen', this.onMenuOpenEvent);
    this.onMenuClose();
  }
}
