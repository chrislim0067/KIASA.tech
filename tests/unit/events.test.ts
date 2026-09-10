import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/features/experience/runtime/events';

describe('EventBus', () => {
  it('calls a handler exactly once per trigger (the original registered handlers twice)', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('scroll', handler);
    bus.trigger({ name: 'scroll' }, { progress: 0.5 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ progress: 0.5 });
  });

  it('removes handlers with off() and the returned disposer', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on('x', a);
    bus.on('x', b);
    offA();
    bus.off('x', b);
    bus.trigger('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('supports once() and keeps the last payload', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.once('ready', handler);
    bus.trigger('ready', 1);
    bus.trigger('ready', 2);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.data.get('ready')).toBe(2);
  });

  it('isolates handler errors', () => {
    const bus = new EventBus();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    bus.on('e', () => {
      throw new Error('boom');
    });
    bus.on('e', ok);
    bus.trigger('e');
    expect(ok).toHaveBeenCalled();
    spy.mockRestore();
  });
});
