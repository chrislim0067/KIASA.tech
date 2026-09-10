/**
 * Typed contract with the vendored render worker (`public/engine/offscreen-CCfMP6GY.js`).
 * The worker exposes itself through Comlink; these are the methods the orchestration uses.
 */
import type { TriggerOptions } from './events';

export interface WorkerEvent {
  name: string;
  data: unknown;
}

export interface WorkerEngine {
  initOffscreen(
    canvas: OffscreenCanvas,
    isWebGPU: boolean,
    isOffscreen: boolean,
    isIOS: boolean,
    isSafari: boolean,
    isFirefox: boolean,
    isMobileOrTablet: boolean,
    lowSpeedVendor: boolean,
    dpr: number,
  ): Promise<void>;
  subscribeToAllEvents(callback: (event: WorkerEvent) => void): Promise<void>;
  trigger(options: TriggerOptions, data?: unknown): Promise<void>;
  processVideoFrame(frame: ImageData): Promise<void>;
}

/**
 * Fire-and-forget facade used by every controller. Calls are not awaited (as in the
 * original) but rejections are caught so a dead worker can never surface as an unhandled
 * promise rejection on the main thread.
 */
export interface EngineApi {
  trigger(options: TriggerOptions, data?: unknown): void;
  processVideoFrame(frame: ImageData, transferables: Transferable[]): Promise<void>;
  /** Terminates the worker and releases the canvas. */
  dispose(): void;
  readonly alive: boolean;
}
