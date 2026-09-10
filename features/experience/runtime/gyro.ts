/**
 * Device-orientation controls for touch devices (ports of `Fs`, `Ns`, `Bs`, `Ds`).
 * On iOS the permission prompt must follow a user gesture; the `.gyro-activate` overlay
 * captures the first tap, forwards it to the element underneath and requests permission.
 */
import type { EngineApi } from './engine-api';
import { isMobileOrTablet } from './device';
import { clamp, degToRad } from './math';

const SCREEN_ANGLES: Record<string, number> = {
  '270': degToRad(-90),
  '-90': degToRad(-90),
  '90': degToRad(90),
  '0': 0,
};

type DeviceOrientationEventWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

export class DeviceOrientationControls {
  enabled = false;
  private device = { alpha: 0, beta: 0, gamma: 0 };
  private screenOrientation = 0;
  private normalizedRotation = { x: 0, y: 0 };

  constructor(private readonly api: EngineApi | null) {}

  private onDeviceOrientation = (e: DeviceOrientationEvent): void => {
    if (e.alpha === null || e.beta === null || e.gamma === null) {
      this.device = { alpha: 0, beta: 0, gamma: 0 };
      return;
    }
    this.device.alpha = e.alpha;
    this.device.beta = e.beta;
    this.device.gamma = e.gamma;
    const tilt = this.device.beta - 90;
    this.normalizedRotation.y = clamp(-tilt / 30, -1, 1);
    this.normalizedRotation.x = clamp(-this.device.gamma / 30, -1, 1);
    this.api?.trigger(
      { name: 'deviceOrientationUpdate' },
      {
        data: {
          alpha: this.device.alpha,
          beta: this.device.beta,
          gamma: this.device.gamma,
          screenOrientation: this.screenOrientation,
          normalizedRotation: this.normalizedRotation,
        },
      },
    );
  };

  private onScreenOrientation = (): void => {
    if (screen.orientation) {
      this.screenOrientation = SCREEN_ANGLES[String(screen.orientation.angle)] ?? 0;
    } else {
      this.screenOrientation = 0;
    }
  };

  connect(): void {
    const DOE = (window as Window & { DeviceOrientationEvent?: DeviceOrientationEventWithPermission }).DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      DOE.requestPermission()
        .then((state) => {
          if (state === 'granted') this.addListeners();
        })
        .catch((error: unknown) => console.error('DeviceOrientationControlsEvents: Unable to use DeviceOrientation API:', error));
    } else {
      this.addListeners();
    }
    this.enabled = true;
  }

  private addListeners(): void {
    window.addEventListener('orientationchange', this.onScreenOrientation);
    window.addEventListener('deviceorientation', this.onDeviceOrientation);
  }

  disconnect(): void {
    window.removeEventListener('orientationchange', this.onScreenOrientation);
    window.removeEventListener('deviceorientation', this.onDeviceOrientation);
    this.enabled = false;
  }

  dispose(): void {
    this.disconnect();
  }
}

interface GyroCapabilities {
  hasGyroscope: boolean;
  needsPermission: boolean;
}

const detectGyroscope = (): Promise<GyroCapabilities> => {
  const none: GyroCapabilities = { hasGyroscope: false, needsPermission: false };
  if (!isMobileOrTablet()) return Promise.resolve(none);
  if (localStorage.getItem('gyroscopePermissionDenied') === 'true') return Promise.resolve(none);
  const DOE = (window as Window & { DeviceOrientationEvent?: DeviceOrientationEventWithPermission }).DeviceOrientationEvent;
  if (!DOE) return Promise.resolve(none);
  if (typeof DOE.requestPermission !== 'function') return Promise.resolve({ hasGyroscope: true, needsPermission: false });
  return DOE.requestPermission()
    .then((state) => {
      if (state === 'granted') return { hasGyroscope: true, needsPermission: false };
      if (state === 'denied') {
        localStorage.setItem('gyroscopePermissionDenied', 'true');
        return none;
      }
      return { hasGyroscope: true, needsPermission: true };
    })
    .catch(() => ({ hasGyroscope: true, needsPermission: true }));
};

const requestGyroscope = (): Promise<boolean> => {
  const DOE = (window as Window & { DeviceOrientationEvent?: DeviceOrientationEventWithPermission }).DeviceOrientationEvent;
  if (!DOE || typeof DOE.requestPermission !== 'function') return Promise.resolve(false);
  return DOE.requestPermission()
    .then((state) => state === 'granted')
    .catch(() => false);
};

/** Sets up gyroscope support; returns a disposer. */
export function setupGyroscope(api: EngineApi | null): () => void {
  let controls: DeviceOrientationControls | null = null;
  let disposed = false;
  const cleanups: Array<() => void> = [];

  void detectGyroscope().then(({ hasGyroscope, needsPermission }) => {
    if (disposed || !hasGyroscope) return;
    controls = new DeviceOrientationControls(api);
    if (needsPermission) {
      if (window.location.pathname.includes('/about')) return;
      const button = document.querySelector<HTMLElement>('.gyro-activate');
      if (!button) return;
      button.classList.add('show');
      const onClick = (event: MouseEvent): void => {
        button.classList.remove('show');
        const target = document.elementFromPoint(event.clientX, event.clientY);
        target?.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY }));
        requestGyroscope()
          .then((granted) => {
            if (granted) {
              api?.trigger({ name: 'deviceOrientationGranted' });
              controls?.connect();
            } else {
              localStorage.setItem('gyroscopePermissionDenied', 'true');
            }
          })
          .catch((error: unknown) => {
            console.error('Error requesting gyroscope permission:', error);
            localStorage.setItem('gyroscopePermissionDenied', 'true');
          });
      };
      button.addEventListener('click', onClick, { once: true });
      cleanups.push(() => button.removeEventListener('click', onClick));
    } else {
      const activate = (): void => {
        api?.trigger({ name: 'deviceOrientationGranted' });
        controls?.connect();
        document.removeEventListener('touchstart', activate);
        document.removeEventListener('click', activate);
      };
      document.addEventListener('touchstart', activate, { once: true, passive: true });
      document.addEventListener('click', activate, { once: true });
      cleanups.push(() => {
        document.removeEventListener('touchstart', activate);
        document.removeEventListener('click', activate);
      });
    }
  });

  return () => {
    disposed = true;
    cleanups.forEach((c) => c());
    controls?.dispose();
  };
}
