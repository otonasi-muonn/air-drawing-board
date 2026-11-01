import { describe, expect, it, vi } from 'vitest';
import type { DrawingInput } from '../domain/drawing';
import { attachPointerInput, clampLogicalCoord, toLogicalPoint } from './pointerInput';

function createFakeCanvas(rect = { left: 100, top: 50, width: 480, height: 360 }) {
  const listeners = new Map<string, Set<(ev: any) => void>>();
  return {
    getBoundingClientRect: () => rect,
    setPointerCapture: vi.fn(),
    addEventListener: vi.fn((type: string, fn: (ev: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (ev: any) => void) => {
      listeners.get(type)?.delete(fn);
    }),
    emit(type: string, ev: any) {
      listeners.get(type)?.forEach(fn => fn(ev));
    },
  };
}

describe('pointerInput', () => {
  it('converts client coordinates to 960x720 logical coordinates and clamps out-of-range inputs', () => {
    const rect = { left: 100, top: 50, width: 480, height: 360 };
    expect(toLogicalPoint({ clientX: 340, clientY: 230 }, rect)).toEqual([480, 360]);
    expect(toLogicalPoint({ clientX: 10, clientY: -20 }, rect)).toEqual([0, 0]);
    expect(toLogicalPoint({ clientX: 900, clientY: 800 }, rect)).toEqual([960, 720]);
    expect(clampLogicalCoord(-5, 999)).toEqual([0, 720]);
  });

  it('uses getCoalescedEvents when available and falls back to single event', () => {
    const canvas = createFakeCanvas();
    const input: DrawingInput = {
      begin: vi.fn(),
      move: vi.fn(),
      end: vi.fn(),
    };
    const onActivity = vi.fn();
    attachPointerInput(canvas as unknown as HTMLElement, input, onActivity);

    canvas.emit('pointerdown', { pointerId: 1, clientX: 100, clientY: 50 });
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(1);
    expect(input.begin).toHaveBeenCalledWith(0, 0);

    // Coalesced events present
    canvas.emit('pointermove', {
      pointerId: 1,
      clientX: 340,
      clientY: 230,
      getCoalescedEvents: () => [
        { clientX: 220, clientY: 140 },
        { clientX: 340, clientY: 230 },
      ],
    });
    expect(input.move).toHaveBeenCalledTimes(2);
    expect(input.move).toHaveBeenNthCalledWith(1, 240, 180);
    expect(input.move).toHaveBeenNthCalledWith(2, 480, 360);

    // Fallback when getCoalescedEvents is absent or empty
    canvas.emit('pointermove', {
      pointerId: 1,
      clientX: 580,
      clientY: 410,
      getCoalescedEvents: () => [],
    });
    expect(input.move).toHaveBeenCalledTimes(3);
    expect(input.move).toHaveBeenNthCalledWith(3, 960, 720);

    canvas.emit('pointerup', { pointerId: 1 });
    expect(input.end).toHaveBeenCalledTimes(1);

    // Move after pointerup is ignored
    canvas.emit('pointermove', { pointerId: 1, clientX: 200, clientY: 100 });
    expect(input.move).toHaveBeenCalledTimes(3);
  });

  it('ends active stroke on pointercancel or lostpointercapture', () => {
    const canvas = createFakeCanvas();
    const input: DrawingInput = {
      begin: vi.fn(),
      move: vi.fn(),
      end: vi.fn(),
    };
    attachPointerInput(canvas as unknown as HTMLElement, input);

    canvas.emit('pointerdown', { pointerId: 2, clientX: 150, clientY: 100 });
    canvas.emit('pointercancel', { pointerId: 2 });
    expect(input.end).toHaveBeenCalledTimes(1);

    canvas.emit('pointerdown', { pointerId: 3, clientX: 150, clientY: 100 });
    canvas.emit('lostpointercapture', { pointerId: 3 });
    expect(input.end).toHaveBeenCalledTimes(2);
  });

  it('ignores a second finger pointerdown/move/up while the first pointer is drawing', () => {
    const canvas = createFakeCanvas();
    const input: DrawingInput = {
      begin: vi.fn(),
      move: vi.fn(),
      end: vi.fn(),
    };
    attachPointerInput(canvas as unknown as HTMLElement, input);

    canvas.emit('pointerdown', { pointerId: 1, clientX: 100, clientY: 50 });
    expect(input.begin).toHaveBeenCalledTimes(1);
    expect(input.begin).toHaveBeenCalledWith(0, 0);

    // Second finger touches down mid-stroke -> ignored
    canvas.emit('pointerdown', { pointerId: 2, clientX: 340, clientY: 230 });
    expect(input.begin).toHaveBeenCalledTimes(1);

    // Second finger moves and lifts -> ignored
    canvas.emit('pointermove', { pointerId: 2, clientX: 400, clientY: 300 });
    canvas.emit('pointerup', { pointerId: 2 });
    expect(input.move).not.toHaveBeenCalled();
    expect(input.end).not.toHaveBeenCalled();

    // First finger continues and lifts -> completes stroke normally
    canvas.emit('pointermove', { pointerId: 1, clientX: 340, clientY: 230 });
    canvas.emit('pointerup', { pointerId: 1 });
    expect(input.move).toHaveBeenCalledTimes(1);
    expect(input.move).toHaveBeenCalledWith(480, 360);
    expect(input.end).toHaveBeenCalledTimes(1);
  });
});
