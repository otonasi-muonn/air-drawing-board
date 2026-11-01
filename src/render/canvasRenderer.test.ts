import { describe, expect, it, vi } from 'vitest';
import { DH, DW, PALETTE, WIDTHS, type Stroke } from '../domain/drawing';
import {
  createThumbnailCache,
  renderActive,
  renderAll,
  renderStroke,
} from './canvasRenderer';

function createMockContext() {
  return {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '' as CanvasLineCap,
    lineJoin: '' as CanvasLineJoin,
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('canvasRenderer', () => {
  it('ignores empty stroke points', () => {
    const ctx = createMockContext();
    renderStroke(ctx, { c: 0, w: 1, pts: [] });
    expect(ctx.beginPath).not.toHaveBeenCalled();
  });

  it('renders a single-point stroke as a filled circle', () => {
    const ctx = createMockContext();
    renderStroke(ctx, { c: 2, w: 2, pts: [[120, 240]] });
    expect(ctx.fillStyle).toBe(PALETTE[2]);
    expect(ctx.lineWidth).toBe(WIDTHS[2]);
    expect(ctx.beginPath).toHaveBeenCalledOnce();
    expect(ctx.arc).toHaveBeenCalledWith(120, 240, WIDTHS[2] / 2, 0, expect.any(Number));
    expect(ctx.fill).toHaveBeenCalledOnce();
  });

  it('renders multi-point strokes with quadratic curves', () => {
    const ctx = createMockContext();
    const stroke: Stroke = {
      c: 4,
      w: 0,
      pts: [
        [10, 20],
        [30, 40],
        [50, 60],
      ],
    };
    renderStroke(ctx, stroke);
    expect(ctx.strokeStyle).toBe(PALETTE[4]);
    expect(ctx.lineWidth).toBe(WIDTHS[0]);
    expect(ctx.moveTo).toHaveBeenCalledWith(10, 20);
    expect(ctx.quadraticCurveTo).toHaveBeenCalledWith(30, 40, 40, 50);
    expect(ctx.lineTo).toHaveBeenCalledWith(50, 60);
    expect(ctx.stroke).toHaveBeenCalledOnce();
  });

  it('renders all confirmed strokes over a 960x720 white background', () => {
    const ctx = createMockContext();
    renderAll(ctx, [{ c: 0, w: 1, pts: [[5, 5]] }]);
    expect(ctx.save).toHaveBeenCalledOnce();
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, DW, DH);
    expect(ctx.arc).toHaveBeenCalledOnce();
    expect(ctx.restore).toHaveBeenCalledOnce();
  });

  it('clears and renders active overlay layer', () => {
    const ctx = createMockContext();
    renderActive(ctx, null);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, DW, DH);
    expect(ctx.beginPath).not.toHaveBeenCalled();

    renderActive(ctx, { c: 1, w: 1, pts: [[10, 10]] });
    expect(ctx.clearRect).toHaveBeenCalledTimes(2);
    expect(ctx.beginPath).toHaveBeenCalledOnce();
  });

  it('caches decoded thumbnail PNGs and rejects invalid data without caching', async () => {
    const decode = vi.fn(async (data: string): Promise<Stroke[]> => {
      if (data === 'bad') throw new Error('corrupt');
      return [{ c: 0, w: 1, pts: [[10, 20]] }];
    });
    const mockCtx = createMockContext();
    const createCanvas = vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: () => mockCtx,
      toDataURL: () => 'data:image/png;base64,MOCK',
    }) as unknown as HTMLCanvasElement);

    const cache = createThumbnailCache(decode, createCanvas);
    const url1 = await cache.get('valid-1');
    const url2 = await cache.get('valid-1');
    expect(url1).toBe('data:image/png;base64,MOCK');
    expect(url2).toBe('data:image/png;base64,MOCK');
    expect(decode).toHaveBeenCalledTimes(1);
    expect(createCanvas).toHaveBeenCalledTimes(1);

    await expect(cache.get('bad')).rejects.toThrow('corrupt');
    expect(cache.size).toBe(1);
  });
});
