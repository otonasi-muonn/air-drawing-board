import { describe, expect, it, vi } from 'vitest';
import { createDrawingSession } from './drawingSession';

describe('drawingSession', () => {
  it('records strokes, filters close points (<1.5), clamps coordinates, and supports undo/clear', () => {
    const onBaseChange = vi.fn();
    const onActiveChange = vi.fn();
    const onMeterUpdate = vi.fn();

    const session = createDrawingSession({
      onBaseChange,
      onActiveChange,
      onMeterUpdate,
    });

    expect(session.colorIndex).toBe(0);
    expect(session.widthIndex).toBe(1);
    expect(session.hasContent()).toBe(false);

    session.setColor(3);
    session.setWidth(2);

    session.begin(-20, 800);
    expect(session.hasContent()).toBe(true);
    expect(session.current).toEqual({
      c: 3,
      w: 2,
      pts: [[0, 720]],
    });

    // Too close (< 1.5), ignored
    session.move(0.5, 719.5);
    expect(session.current?.pts.length).toBe(1);

    // Far enough, clamped
    session.move(1000, -10);
    expect(session.current?.pts).toEqual([
      [0, 720],
      [960, 0],
    ]);

    session.end();
    expect(session.current).toBeNull();
    expect(session.strokes).toHaveLength(1);
    expect(session.strokes[0]).toEqual({
      c: 3,
      w: 2,
      pts: [
        [0, 720],
        [960, 0],
      ],
    });
    expect(onBaseChange).toHaveBeenCalled();
    expect(onMeterUpdate).toHaveBeenCalledTimes(1);

    // Undo removes last stroke
    session.undo();
    expect(session.strokes).toHaveLength(0);
    expect(session.hasContent()).toBe(false);

    // Clear resets strokes and active stroke
    session.begin(50, 50);
    session.clear();
    expect(session.current).toBeNull();
    expect(session.strokes).toHaveLength(0);
    expect(session.hasContent()).toBe(false);
  });
});
