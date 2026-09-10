/** Header mute button (port of `ni`). Labels come from the button's data attributes. */
import { analytics } from '@/lib/analytics';
import { audioCommands } from '@/lib/audio/events';

export class SoundButton {
  private readonly button: HTMLElement;
  private readonly muteLabel: string;
  private readonly unmuteLabel: string;

  constructor() {
    this.button = document.querySelector<HTMLElement>('.sound-button')!;
    this.muteLabel = this.button.dataset.muteLabel ?? 'Mute Sound';
    this.unmuteLabel = this.button.dataset.unmuteLabel ?? 'Unmute Sound';
    this.button.addEventListener('click', this.switchSound);
    let muted = false;
    try {
      muted = localStorage.getItem('isMuted') === 'true';
    } catch {
      /* storage unavailable */
    }
    if (muted) this.toggleSound(false, false);
  }

  private switchSound = (): void => {
    const on = !this.button.classList.contains('off');
    this.toggleSound(!on);
  };

  toggleSound(on: boolean, notify = true): void {
    const off = !on;
    this.button.classList.toggle('off', off);
    this.button.setAttribute('aria-label', off ? this.unmuteLabel : this.muteLabel);
    if (notify) {
      audioCommands.mute(off);
      analytics.buttonClick('sound_button', 'navigation', 'toggle', off ? 'off' : 'on');
    }
  }

  dispose(): void {
    this.button.removeEventListener('click', this.switchSound);
  }
}
