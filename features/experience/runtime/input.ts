/**
 * Forwards pointer / mouse / wheel events and the viewport size to the worker
 * (ports of `Yn` and the resize handler). Every listener is removed on dispose.
 */
import type { EngineApi } from './engine-api';
import { store } from './store';

const FORWARDED_EVENTS: Array<[keyof DocumentEventMap, boolean]> = [
  ['click', false],
  ['contextmenu', false],
  ['dblclick', false],
  ['wheel', true],
  ['pointerdown', true],
  ['pointerup', true],
  ['pointerleave', true],
  ['pointermove', true],
  ['pointercancel', true],
  ['lostpointercapture', true],
];

type AnyPointerEvent = MouseEvent & Partial<PointerEvent> & Partial<WheelEvent> & { touches?: TouchList; changedTouches?: TouchList };

const serialize = (name: string, e: AnyPointerEvent) => ({
  eventName: name,
  type: name,
  shiftKey: e.shiftKey,
  clientX: e.clientX,
  clientY: e.clientY,
  offsetX: e.offsetX,
  offsetY: e.offsetY,
  x: e.x,
  y: e.y,
  touches: undefined,
  changedTouches: undefined,
  pointerType: e.pointerType,
  button: e.button,
  pointerId: e.pointerId,
  deltaY: e.deltaY,
  deltaX: e.deltaX,
  pageX: e.pageX,
  pageY: e.pageY,
  pressure: e.pressure,
  width: e.width,
  height: e.height,
  tiltX: e.tiltX,
  tiltY: e.tiltY,
  isPrimary: e.isPrimary,
  pointer: undefined,
});

export function forwardInputEvents(api: EngineApi): () => void {
  const listeners: Array<[string, EventListener, AddEventListenerOptions]> = [];
  for (const [name, passive] of FORWARDED_EVENTS) {
    const listener: EventListener = (event) => {
      api.trigger({ name, fireAtStart: true, fireVirtualEvents: true }, serialize(name, event as AnyPointerEvent));
    };
    const options: AddEventListenerOptions = { passive };
    document.addEventListener(name, listener, options);
    listeners.push([name, listener, options]);
  }
  return () => {
    listeners.forEach(([name, listener, options]) => document.removeEventListener(name, listener, options));
  };
}

export function forwardResize(api: EngineApi): () => void {
  const onResize = (): void => {
    const size = {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: Math.min(store.getSettings().dpr, window.devicePixelRatio),
      ratio: window.innerWidth / window.innerHeight,
    };
    store.setSettings({ canvasSize: size });
    api.trigger({ name: 'resize', fireAtStart: true }, size);
  };
  window.addEventListener('resize', onResize);
  onResize();
  return () => window.removeEventListener('resize', onResize);
}
