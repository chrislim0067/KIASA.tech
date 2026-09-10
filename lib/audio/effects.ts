/**
 * Web Audio effect chains shared by several sounds (ports of `on`, `Ti`, `yi`, `bi`).
 */
import { Howler } from 'howler';
import type { ManagedSound } from './ManagedSound';

export interface AudioEffect {
  createNode(ctx: AudioContext): AudioNode | null;
  disconnect(): void;
}

/** Routes the source nodes of its sounds through an effect chain before the master gain. */
export class AudioGroup {
  private readonly ctx: AudioContext;
  private readonly sounds = new Map<ManagedSound, Array<() => void>>();
  private readonly connected = new WeakSet<AudioNode>();
  private effectNodes: AudioNode[] = [];
  private groupGain: GainNode | null;
  private outputNode: AudioNode | null = null;

  constructor(private readonly effects: AudioEffect[] = []) {
    this.ctx = Howler.ctx as AudioContext;
    this.groupGain = this.ctx.createGain();
    this.groupGain.gain.value = 1;
    this.buildChain();
    this.outputNode?.connect(Howler.masterGain as GainNode);
  }

  private buildChain(): void {
    let last: AudioNode = this.groupGain!;
    this.effectNodes = [];
    for (const effect of this.effects) {
      const node = effect.createNode(this.ctx);
      if (node) {
        last.connect(node);
        last = node;
        this.effectNodes.push(node);
      }
    }
    this.outputNode = last;
  }

  addSound(sound: ManagedSound): void {
    if (this.sounds.has(sound)) return;
    const onPlay = (): void => this.attach(sound);
    const onStop = (): void => this.detach(sound);
    this.sounds.set(sound, [sound.on('play', onPlay), sound.on('stop', onStop), sound.on('end', onStop)]);
  }

  private attach(sound: ManagedSound): void {
    if (!this.groupGain) return;
    for (const node of sound.sourceNodes) {
      try {
        node.disconnect();
        node.connect(this.groupGain);
        this.connected.add(node);
      } catch (error) {
        console.error('Error connecting sound to group:', error);
      }
    }
  }

  private detach(sound: ManagedSound): void {
    for (const node of sound.sourceNodes) {
      if (!this.connected.has(node)) continue;
      try {
        node.disconnect();
        node.connect(Howler.masterGain as GainNode);
        this.connected.delete(node);
      } catch (error) {
        console.error('Error disconnecting sound from group:', error);
      }
    }
  }

  removeSound(sound: ManagedSound): void {
    const offs = this.sounds.get(sound);
    if (!offs) return;
    offs.forEach((off) => off());
    this.sounds.delete(sound);
    this.detach(sound);
  }

  dispose(): void {
    Array.from(this.sounds.keys()).forEach((s) => this.removeSound(s));
    this.effects.forEach((e) => e.disconnect());
    this.effectNodes.forEach((n) => n.disconnect());
    this.effectNodes = [];
    this.groupGain?.disconnect();
    this.groupGain = null;
    this.outputNode = null;
  }
}

/** Two chained low-pass filters (port of `Ti`). */
export class LowPassEffect implements AudioEffect {
  lowPassFilter1: BiquadFilterNode | null = null;
  lowPassFilter2: BiquadFilterNode | null = null;
  private readonly initialFrequency: number;
  private readonly filterQ: number;

  constructor(options: { initialFrequency?: number; filterQ?: number } = {}) {
    this.initialFrequency = options.initialFrequency ?? 1000;
    this.filterQ = options.filterQ ?? 1;
  }

  createNode(ctx: AudioContext): AudioNode {
    this.lowPassFilter1 = ctx.createBiquadFilter();
    this.lowPassFilter1.type = 'lowpass';
    this.lowPassFilter1.frequency.value = this.initialFrequency;
    this.lowPassFilter1.Q.value = this.filterQ;
    this.lowPassFilter2 = ctx.createBiquadFilter();
    this.lowPassFilter2.type = 'lowpass';
    this.lowPassFilter2.frequency.value = this.initialFrequency;
    this.lowPassFilter2.Q.value = this.filterQ;
    this.lowPassFilter1.connect(this.lowPassFilter2);
    return this.lowPassFilter1;
  }

  /*
   * Routing note: the original chain used the first filter as the group output (the second
   * filter is connected but not audible). The same routing is kept on purpose so the logo loop
   * sounds exactly as before.
   */

  updateFrequency(frequency: number): void {
    if (!this.lowPassFilter1 || !this.lowPassFilter2) return;
    const now = this.lowPassFilter1.context.currentTime;
    this.lowPassFilter1.frequency.linearRampToValueAtTime(frequency, now + 0.1);
    this.lowPassFilter2.frequency.linearRampToValueAtTime(frequency, now + 0.1);
  }

  rampTo(frequency: number, seconds: number): void {
    if (!this.lowPassFilter1 || !this.lowPassFilter2) return;
    const now = this.lowPassFilter1.context.currentTime;
    this.lowPassFilter1.frequency.linearRampToValueAtTime(frequency, now + seconds);
    this.lowPassFilter2.frequency.linearRampToValueAtTime(frequency, now + seconds);
  }

  disconnect(): void {
    this.lowPassFilter2?.disconnect();
    this.lowPassFilter1?.disconnect();
  }
}

/** Convolution reverb with dry/wet mix (port of `yi`). */
export class ReverbEffect implements AudioEffect {
  private convolver: ConvolverNode | null = null;
  private wetGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private inputNode: GainNode | null = null;
  private outputNode: GainNode | null = null;

  constructor(private readonly options: { mix?: number; irAudioBuffer?: AudioBuffer | null } = {}) {}

  createNode(ctx: AudioContext): AudioNode {
    const { mix = 0.25, irAudioBuffer = null } = this.options;
    this.convolver = ctx.createConvolver();
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain.gain.value = mix;
    this.dryGain.gain.value = 1 - mix;
    if (irAudioBuffer) this.convolver.buffer = irAudioBuffer;
    this.inputNode = ctx.createGain();
    this.inputNode.connect(this.dryGain);
    this.inputNode.connect(this.convolver);
    this.convolver.connect(this.wetGain);
    this.outputNode = ctx.createGain();
    this.wetGain.connect(this.outputNode);
    this.dryGain.connect(this.outputNode);
    return this.inputNode;
  }

  /*
   * Routing note: as in the original, the input gain is the node returned to the group, so the
   * dry signal reaches the master gain directly. Kept identical to preserve the mix.
   */

  disconnect(): void {
    this.outputNode?.disconnect();
    this.wetGain?.disconnect();
    this.dryGain?.disconnect();
    this.convolver?.disconnect();
    this.inputNode?.disconnect();
  }
}

export async function loadImpulseResponse(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch impulse response (${response.status})`);
  const buffer = await response.arrayBuffer();
  return ctx.decodeAudioData(buffer);
}
