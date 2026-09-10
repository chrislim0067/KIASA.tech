/**
 * Plays the scene transition stems according to the scroll progress (port of `wi`).
 */
import { audioCommands } from '@/lib/audio/events';
import { AUDIO_EVENTS } from '@/lib/audio/events';
import { TRANSITIONS } from '@/lib/audio/manifest';
import { events } from './events';
import { rangeProgress } from './math';
import { store } from './store';

type Timer = ReturnType<typeof setTimeout> | null;

export class AudioTransitionsController {
  private transitionScene3To4Played = false;
  private isInSection3 = false;
  private isInSection4 = false;
  private preventSpamTransitionScene3To4 = false;
  private isPlayingTransition2 = false;
  private isPlayingTransition1 = false;
  private isPlayingTransitionFinal = false;
  private wasInScene4 = false;
  private progress1 = 0;
  private progress2 = 0;
  private progress2End = 0;
  private progress3 = 0;
  private progress = 0;
  private anchorScrolling = false;
  private timeoutSpamScene1To2: Timer = null;
  private timeoutSpamScene2To3: Timer = null;
  private timeoutSpamScene3To4: Timer = null;
  private checkUserBackOnSection1: Timer = null;
  private checkUserBackOnSection2: Timer = null;
  private checkUserBackOnSection2DoubleCheck: Timer = null;
  private checkUserBackOnSection3: Timer = null;
  private finalTimeout: Timer = null;
  private readonly offScroll: () => void;

  constructor() {
    this.offScroll = events.on<{ progress: number; direction: number }>('scroll', this.listenProgress);
    document.addEventListener('section2InteractionArea', this.enteredSection2InteractionArea);
    document.addEventListener(AUDIO_EVENTS.PLAY_TRANSITION_ANCHOR, this.playTransitionAnchor);
  }

  private enteredSection2InteractionArea = (): void => {
    if (!this.checkUserBackOnSection2) this.isPlayingTransition2 = false;
  };

  private section2To3Transition(forward: boolean): void {
    if (!this.isPlayingTransition2 && this.progress2End > 0.01 && forward && !this.timeoutSpamScene2To3) {
      this.isPlayingTransition2 = true;
      audioCommands.playTransition(TRANSITIONS.TRANSITION_SCENE_2_TO_3);
      this.timeoutSpamScene2To3 = setTimeout(() => {
        this.timeoutSpamScene2To3 = null;
      }, 700);
      this.checkUserBackOnSection2 = setTimeout(() => {
        this.checkUserBackOnSection2 = null;
        if (this.progress2End < 0.01 + 0.5) audioCommands.stopTransition(TRANSITIONS.TRANSITION_SCENE_2_TO_3, 300);
      }, 600);
      this.checkUserBackOnSection2DoubleCheck = setTimeout(() => {
        this.checkUserBackOnSection2DoubleCheck = null;
        if (this.progress2End < 0.01 + 0.8) audioCommands.stopTransition(TRANSITIONS.TRANSITION_SCENE_2_TO_3, 300);
      }, 900);
    }
    if (this.progress2End === 0 && this.isPlayingTransition2) {
      this.isPlayingTransition2 = false;
      audioCommands.stopTransition(TRANSITIONS.TRANSITION_SCENE_2_TO_3, 200);
      if (this.checkUserBackOnSection2) clearTimeout(this.checkUserBackOnSection2);
      if (this.checkUserBackOnSection2DoubleCheck) clearTimeout(this.checkUserBackOnSection2DoubleCheck);
    }
  }

  private section3To4Transition(forward: boolean): void {
    if (!this.preventSpamTransitionScene3To4 && !this.transitionScene3To4Played && this.isInSection3 && this.progress3 > 0.7 && forward) {
      this.preventSpamTransitionScene3To4 = true;
      audioCommands.playTransition(TRANSITIONS.TRANSITION_SCENE_3_TO_4);
      this.transitionScene3To4Played = true;
      this.timeoutSpamScene3To4 = setTimeout(() => {
        this.preventSpamTransitionScene3To4 = false;
      }, 700);
      this.checkUserBackOnSection3 = setTimeout(() => {
        if (this.progress3 < 0.7 + 0.02) audioCommands.stopTransition(TRANSITIONS.TRANSITION_SCENE_3_TO_4, 700);
      }, 500);
    }
    if (this.transitionScene3To4Played && this.progress3 < 0.7 - 0.05) {
      this.transitionScene3To4Played = false;
      audioCommands.stopTransition(TRANSITIONS.TRANSITION_SCENE_3_TO_4, 200);
      if (this.checkUserBackOnSection3) clearTimeout(this.checkUserBackOnSection3);
    }
  }

  private section1To2Transition(forward: boolean, anchor = false): void {
    if (this.progress1 > 0.02 && this.progress1 < 0.1 && forward && !this.isPlayingTransition1 && this.timeoutSpamScene1To2 === null) {
      audioCommands.playTransition(TRANSITIONS.TRANSITION_SCENE_1_TO_2);
      this.isPlayingTransition1 = true;
      this.timeoutSpamScene1To2 = setTimeout(() => {
        this.timeoutSpamScene1To2 = null;
      }, 700);
    } else if (this.progress2 > 0.4) {
      this.isPlayingTransition1 = false;
    }
    if (this.isPlayingTransition1 && !anchor) {
      this.checkUserBackOnSection1 = setTimeout(() => {
        this.checkUserBackOnSection1 = null;
        if (this.progress1 < 0.1) {
          audioCommands.stopTransition(TRANSITIONS.TRANSITION_SCENE_1_TO_2, 400);
          this.isPlayingTransition1 = false;
        }
      }, 400);
    }
  }

  private playTransitionAnchor = (event: Event): void => {
    const { transition } = (event as CustomEvent<{ transition: string }>).detail;
    if (transition === TRANSITIONS.TRANSITION_SCENE_1_TO_2) this.section1To2Transition(true, true);
    else if (transition === TRANSITIONS.TRANSITION_SCENE_4_TO_5) this.playTransitionFinal();
  };

  private playTransitionFinal(): void {
    if (this.isPlayingTransitionFinal) return;
    this.isPlayingTransitionFinal = true;
    audioCommands.playTransition(TRANSITIONS.TRANSITION_SCENE_4_TO_5);
    this.finalTimeout = setTimeout(() => {
      this.isPlayingTransitionFinal = false;
    }, 700);
  }

  private listenProgress = ({ progress, direction }: { progress: number; direction: number }): void => {
    const { sections } = store.state;
    this.anchorScrolling = store.getSettings().anchorScrolling;
    this.progress1 = sections.oneProgress.value;
    this.progress2End = sections.twoEndProgress.value;
    this.progress2 = sections.twoProgress.value;
    this.progress3 = sections.threeProgress.value;
    const four = sections.fourthProgress.value;
    const five = sections.fiveProgress.value;
    this.isInSection3 = this.progress3 > 0 && four === 0;
    this.isInSection4 = four > 0 && five === 0;
    if (this.progress < 0.2) {
      this.transitionScene3To4Played = false;
      this.isPlayingTransition2 = false;
      this.checkUserBackOnSection2 = null;
    }
    this.progress = progress;
    if (this.anchorScrolling) {
      if (this.progress3 > 0) this.isPlayingTransition2 = true;
    } else {
      const forward = direction === 1;
      this.section1To2Transition(forward);
      this.section2To3Transition(forward);
      this.section3To4Transition(forward);
    }
    if (this.isInSection4) {
      this.wasInScene4 = true;
      audioCommands.scene4Progress(rangeProgress(0.1, 0.5, four));
    } else if (this.wasInScene4) {
      this.wasInScene4 = false;
      audioCommands.scene4Progress(-1);
    }
  };

  dispose(): void {
    this.offScroll();
    document.removeEventListener('section2InteractionArea', this.enteredSection2InteractionArea);
    document.removeEventListener(AUDIO_EVENTS.PLAY_TRANSITION_ANCHOR, this.playTransitionAnchor);
    [
      this.timeoutSpamScene1To2,
      this.timeoutSpamScene2To3,
      this.timeoutSpamScene3To4,
      this.checkUserBackOnSection1,
      this.checkUserBackOnSection2,
      this.checkUserBackOnSection2DoubleCheck,
      this.checkUserBackOnSection3,
      this.finalTimeout,
    ].forEach((t) => t && clearTimeout(t));
  }
}
