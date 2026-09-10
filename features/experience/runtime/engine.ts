/**
 * Boots the render worker (port of the original `Cs()` bootstrap).
 *
 * 1. creates the full-screen canvas and transfers it to a Worker (`OffscreenCanvas`),
 * 2. detects WebGPU / GPU tier to choose the device pixel ratio exactly like the original,
 * 3. wires the Comlink RPC, echoes every worker event onto the main-thread bus,
 * 4. starts the showreel video feed, SDF text generation, input forwarding and resize.
 */
import { wrap, proxy, transfer, releaseProxy, type Remote } from 'comlink';
import { getGPUTier } from 'detect-gpu';
import type { EngineApi, WorkerEngine, WorkerEvent } from './engine-api';
import { events, type TriggerOptions } from './events';
import { isFirefox, isIOS, isMobileOrTablet, isSafari } from './device';
import { forwardInputEvents, forwardResize } from './input';
import { store } from './store';
import { startVideoFeed } from './video';
import { setupTextRendering } from './text';

export const ENGINE_WORKER_URL = '/engine/offscreen-CCfMP6GY.js';

interface GPUAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}
interface GPUAdapterLike {
  info?: GPUAdapterInfoLike;
}
interface NavigatorGPULike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<GPUAdapterLike | null>;
}

export class EngineUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnsupportedError';
  }
}

export interface BootResult {
  api: EngineApi;
  canvas: HTMLCanvasElement;
  isWebGPU: boolean;
  dispose(): void;
}

/** Vendors that historically run the fur/particle shaders slowly (port of `Es`). */
const detectLowSpeedVendor = (vendor: string | undefined, gpu: string | undefined): boolean => {
  if ((!vendor && !gpu) || (typeof vendor !== 'string' && typeof gpu !== 'string')) return false;
  const v = vendor?.toLowerCase();
  const low = !!(v?.includes('intel') || v?.includes('amd') || gpu?.toLowerCase().includes('radeon pro rx'));
  if (low) events.trigger({ name: 'isLowSpeedVendor' });
  return low;
};

const createCanvas = (): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.setAttribute('style', 'width: 100%; height: 100%; display: block;');
  canvas.setAttribute('aria-hidden', 'true');
  // Note: the stylesheet rule `canvas[data-astro-cid-5hce7sga]` only applied to the removed
  // main-thread renderer; the worker canvas is unstyled (z-index auto) exactly as before.
  canvas.dataset.experienceCanvas = '';
  return canvas;
};

export async function bootEngine(): Promise<BootResult> {
  events.trigger({ name: 'loadProgress' }, { progress: 0 });
  document.documentElement.scrollTop = 0;

  const canvas = createCanvas();
  document.body.appendChild(canvas);

  if (typeof (canvas as { transferControlToOffscreen?: unknown }).transferControlToOffscreen !== 'function') {
    canvas.remove();
    throw new EngineUnsupportedError('OffscreenCanvas is not supported by this browser');
  }

  const safari = isSafari();
  const firefox = isFirefox();
  const ios = isIOS();
  const mobile = isMobileOrTablet();

  // WebGPU availability + vendor (the worker decides the backend from this flag).
  let hasWebGPU = false;
  let vendor: string | undefined;
  const gpu = (navigator as Navigator & { gpu?: NavigatorGPULike }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      hasWebGPU = adapter !== null;
      vendor = adapter?.info?.vendor;
    } catch {
      hasWebGPU = false;
    }
  }

  let tier = 2;
  let gpuName: string | undefined;
  try {
    const result = await getGPUTier();
    tier = result.tier;
    gpuName = result.gpu;
  } catch {
    // benchmark data unavailable (offline) — keep the medium tier
  }
  let dpr = tier === 3 ? 1.4 : 1.2 - (hasWebGPU ? 0 : 0.1);
  const lowSpeedVendor = detectLowSpeedVendor(vendor, gpuName);
  if (lowSpeedVendor) dpr = 1;
  store.setSettings({ dpr, isOffscreen: true, lowSpeedVendor, isWebGPU: hasWebGPU, isIOS: ios, isSafari: safari, isFirefox: firefox, isMobileOrTablet: mobile });

  const worker = new Worker(ENGINE_WORKER_URL, { type: 'module', name: 'kiasa-render' });
  (self as unknown as { _workerOffscreen?: Worker })._workerOffscreen = worker;
  const remote: Remote<WorkerEngine> = wrap<WorkerEngine>(worker);

  let alive = true;
  const disposers: Array<() => void> = [];
  const api: EngineApi = {
    get alive() {
      return alive;
    },
    trigger(options: TriggerOptions, data?: unknown) {
      if (!alive) return;
      remote.trigger(options, data).catch((error: unknown) => {
        if (alive) console.error(`[engine] trigger "${options.name}" failed`, error);
      });
    },
    processVideoFrame(frame: ImageData, transferables: Transferable[]) {
      if (!alive) return Promise.resolve();
      return remote.processVideoFrame(transfer(frame, transferables)).catch((error: unknown) => {
        if (alive) console.error('[engine] processVideoFrame failed', error);
      });
    },
    dispose() {
      if (!alive) return;
      alive = false;
      disposers.splice(0).forEach((d) => d());
      try {
        remote[releaseProxy]();
      } catch {
        /* proxy already released */
      }
      worker.terminate();
      canvas.remove();
      store.setSettings({ api: null });
    },
  };

  worker.addEventListener('error', (event) => {
    console.error('[engine] worker error', event.message);
    events.trigger({ name: 'engineError' }, { message: event.message });
  });

  // The video feed is started before the worker init (as in the original) so the first
  // frames are ready when the scene asks for them.
  disposers.push(startVideoFeed(api));

  const offscreen = canvas.transferControlToOffscreen();
  await remote.initOffscreen(
    transfer(offscreen, [offscreen]),
    hasWebGPU,
    true,
    ios,
    safari,
    firefox,
    mobile,
    lowSpeedVendor,
    Number(dpr),
  );

  await remote.subscribeToAllEvents(
    proxy(({ name, data }: WorkerEvent) => {
      events.trigger({ name, fireAtStart: true }, data);
    }),
  );

  if (!mobile && !firefox && !lowSpeedVendor) {
    disposers.push(setupTextRendering(api));
  }

  store.setSettings({ api });
  disposers.push(forwardInputEvents(api));
  disposers.push(forwardResize(api));

  return {
    api,
    canvas,
    isWebGPU: hasWebGPU,
    dispose: () => api.dispose(),
  };
}

/** Human readable GPU description for the console banner / analytics (port of `ks`). */
export async function describeHardware(isWebGPU: boolean): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: NavigatorGPULike }).gpu;
  if (isWebGPU && gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter === null) return 'Unable to create WebGPU adapter';
      const { vendor = '', architecture = '', device, description } = adapter.info ?? {};
      return `
        Vendor: ${vendor}
        Architecture: ${architecture}
  ${device ? `Device: ${device}` : ''}
  ${description ? `Description: ${description}` : ''}`;
    } catch (error) {
      return `Error getting WebGPU info: ${(error as Error).message}`;
    }
  }
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (!gl || !ext) return 'WebGL renderer info unavailable';
    return `
        Vendor: ${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)}
        Renderer: ${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}`;
  } catch (error) {
    return `Error getting WebGL info: ${(error as Error).message}`;
  }
}
