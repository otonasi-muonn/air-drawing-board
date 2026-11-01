import { PALETTE, WIDTHS, type DrawingInput, type Stroke } from '../domain/drawing';
import { clampLogicalCoord } from '../input/pointerInput';

export interface DrawingSessionCallbacks {
  onBaseChange?: (strokes: readonly Stroke[]) => void;
  onActiveChange?: (current: Stroke | null) => void;
  onMeterUpdate?: (strokes: readonly Stroke[]) => void;
}

export interface DrawingSession extends DrawingInput {
  readonly strokes: readonly Stroke[];
  readonly current: Stroke | null;
  readonly colorIndex: number;
  readonly widthIndex: number;
  setColor(index: number): void;
  setWidth(index: number): void;
  undo(): void;
  clear(): void;
  hasContent(): boolean;
}

const MIN_POINT_DISTANCE = 1.5;

/**
 * 描画状態（確定ストローク・描画中ストローク・色・太さ・Undo/Clear）を管理する。
 */
export function createDrawingSession(callbacks: DrawingSessionCallbacks = {}): DrawingSession {
  let strokes: Stroke[] = [];
  let current: Stroke | null = null;
  let colorIndex = 0;
  let widthIndex = 1;

  function begin(x: number, y: number): void {
    const [cx, cy] = clampLogicalCoord(x, y);
    current = {
      c: colorIndex,
      w: widthIndex,
      pts: [[cx, cy]],
    };
    callbacks.onActiveChange?.(current);
  }

  function move(x: number, y: number): void {
    if (!current) return;
    const [cx, cy] = clampLogicalCoord(x, y);
    const last = current.pts[current.pts.length - 1];
    if (last && Math.hypot(cx - last[0], cy - last[1]) < MIN_POINT_DISTANCE) {
      return;
    }
    current.pts.push([cx, cy]);
    callbacks.onActiveChange?.(current);
  }

  function end(): void {
    if (!current) return;
    if (current.pts.length > 0) {
      strokes.push(current);
    }
    current = null;
    callbacks.onBaseChange?.(strokes);
    callbacks.onActiveChange?.(null);
    callbacks.onMeterUpdate?.(strokes);
  }

  function setColor(index: number): void {
    if (index >= 0 && index < PALETTE.length) {
      colorIndex = index;
    }
  }

  function setWidth(index: number): void {
    if (index >= 0 && index < WIDTHS.length) {
      widthIndex = index;
    }
  }

  function undo(): void {
    strokes.pop();
    callbacks.onBaseChange?.(strokes);
    callbacks.onMeterUpdate?.(strokes);
  }

  function clear(): void {
    strokes = [];
    current = null;
    callbacks.onBaseChange?.(strokes);
    callbacks.onActiveChange?.(null);
    callbacks.onMeterUpdate?.(strokes);
  }

  function hasContent(): boolean {
    return strokes.length > 0 || current !== null;
  }

  return {
    get strokes() {
      return strokes;
    },
    get current() {
      return current;
    },
    get colorIndex() {
      return colorIndex;
    },
    get widthIndex() {
      return widthIndex;
    },
    begin,
    move,
    end,
    setColor,
    setWidth,
    undo,
    clear,
    hasContent,
  };
}
