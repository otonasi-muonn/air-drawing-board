import { DH, DW, type DrawingInput, type Point } from '../domain/drawing';

export interface ClientCoordEvent {
  clientX: number;
  clientY: number;
  pointerId?: number;
  getCoalescedEvents?: () => ClientCoordEvent[];
}

export interface ElementRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 論理座標 (960x720) の範囲へクランプする。
 */
export function clampLogicalCoord(x: number, y: number): Point {
  const safeX = Number.isFinite(x) ? Math.min(DW, Math.max(0, x)) : 0;
  const safeY = Number.isFinite(y) ? Math.min(DH, Math.max(0, y)) : 0;
  return [safeX, safeY];
}

/**
 * クライアント座標を論理座標 (960x720) へ変換しクランプする。
 */
export function toLogicalPoint(event: ClientCoordEvent, rect: ElementRectLike): Point {
  const width = rect.width > 0 ? rect.width : DW;
  const height = rect.height > 0 ? rect.height : DH;
  const rawX = ((event.clientX - rect.left) * DW) / width;
  const rawY = ((event.clientY - rect.top) * DH) / height;
  return clampLogicalCoord(rawX, rawY);
}

/**
 * ポインタ入力を監視し、getCoalescedEvents とフォールバックで DrawingInput へ論理座標を渡す。
 */
export function attachPointerInput(
  element: HTMLElement,
  input: DrawingInput,
  onActivity?: () => void
): () => void {
  let activePointerId: number | null = null;
  let drawing = false;

  const handlePointerDown = (e: PointerEvent) => {
    if (drawing) return;
    onActivity?.();
    activePointerId = typeof e.pointerId === 'number' ? e.pointerId : null;
    drawing = true;
    if (typeof element.setPointerCapture === 'function' && typeof e.pointerId === 'number') {
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        // 合成イベント等でpointerIdが無効な場合は無視して継続
      }
    }
    const [x, y] = toLogicalPoint(e, element.getBoundingClientRect());
    input.begin(x, y);
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!drawing) return;
    if (activePointerId !== null && typeof e.pointerId === 'number' && e.pointerId !== activePointerId) {
      return;
    }
    onActivity?.();
    const rect = element.getBoundingClientRect();
    const coalesced =
      typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : undefined;
    const events: ClientCoordEvent[] =
      coalesced && coalesced.length > 0 ? coalesced : [e];
    for (const ev of events) {
      const [x, y] = toLogicalPoint(ev, rect);
      input.move(x, y);
    }
  };

  const finishStroke = (e?: PointerEvent) => {
    if (!drawing) return;
    if (
      e &&
      activePointerId !== null &&
      typeof e.pointerId === 'number' &&
      e.pointerId !== activePointerId
    ) {
      return;
    }
    drawing = false;
    activePointerId = null;
    input.end();
  };

  element.addEventListener('pointerdown', handlePointerDown);
  element.addEventListener('pointermove', handlePointerMove);
  element.addEventListener('pointerup', finishStroke);
  element.addEventListener('pointercancel', finishStroke);
  element.addEventListener('lostpointercapture', finishStroke);

  return () => {
    element.removeEventListener('pointerdown', handlePointerDown);
    element.removeEventListener('pointermove', handlePointerMove);
    element.removeEventListener('pointerup', finishStroke);
    element.removeEventListener('pointercancel', finishStroke);
    element.removeEventListener('lostpointercapture', finishStroke);
  };
}
