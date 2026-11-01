import { describe, expect, it, vi } from 'vitest';
import type { Stroke } from '../domain/drawing';
import {
  buildShareUrl,
  evaluateMeter,
  isCapacityOverflowError,
  renderWorkQr,
} from './qrService';

function createFakeQrCanvas() {
  const clearRect = vi.fn();
  return {
    width: 320,
    height: 320,
    clearRect,
    getContext: vi.fn(() => ({ clearRect })),
  } as unknown as HTMLCanvasElement & { clearRect: ReturnType<typeof vi.fn> };
}

const sampleStrokes: Stroke[] = [
  { c: 0, w: 1, pts: [[10, 20], [50, 60]] },
];

describe('qrService', () => {
  it('strips only the URL fragment when building share URLs', () => {
    expect(
      buildShareUrl('https://example.github.io/air-drawing-board/?k=1#old-fragment', 'DATA123')
    ).toBe('https://example.github.io/air-drawing-board/?k=1#d=DATA123');
  });

  it('evaluates meter thresholds at 700 and 1200 characters', () => {
    const base = 'https://example.com/';
    const shortEvaluation = evaluateMeter(base, 'a'.repeat(100));
    expect(shortEvaluation.level).toBe('ok');
    expect(shortEvaluation.label).toBe('QRで持ち帰れる見込み');

    const warnEvaluation = evaluateMeter(base, 'a'.repeat(800));
    expect(warnEvaluation.level).toBe('warn');
    expect(warnEvaluation.label).toBe('QRで持ち帰れる見込み');

    const overEvaluation = evaluateMeter(base, 'a'.repeat(1300));
    expect(overEvaluation.level).toBe('over');
    expect(overEvaluation.label).toBe('描画量が多め（QRに入らない可能性）');
  });

  it('identifies QR capacity overflow errors accurately without matching generic capacity/size errors', () => {
    expect(
      isCapacityOverflowError(new Error('The amount of data is too big to be stored in a QR Code'))
    ).toBe(true);
    expect(
      isCapacityOverflowError(new Error('The chosen QR Code version cannot contain this amount of data.'))
    ).toBe(true);
    expect(isCapacityOverflowError(new Error('Canvas context unavailable'))).toBe(false);
    expect(isCapacityOverflowError(new Error('Canvas too large to render'))).toBe(false);
    expect(isCapacityOverflowError(new Error('Internal buffer capacity error'))).toBe(false);
  });

  it('renders QR with level M and width 640 on first attempt', async () => {
    const canvas = createFakeQrCanvas();
    const toCanvas = vi.fn().mockResolvedValue(undefined);
    const encodeDrawing = vi.fn();

    const res = await renderWorkQr({
      canvas,
      currentUrl: 'https://example.com/air-drawing-board/#d=prev',
      initialData: 'INITIAL_DATA',
      strokes: sampleStrokes,
      encodeDrawing,
      toCanvas,
    });

    expect(res).toEqual({
      status: 'ok',
      url: 'https://example.com/air-drawing-board/#d=INITIAL_DATA',
      data: 'INITIAL_DATA',
      message: '',
      isError: false,
    });
    expect(toCanvas).toHaveBeenCalledOnce();
    expect(toCanvas).toHaveBeenCalledWith(
      canvas,
      'https://example.com/air-drawing-board/#d=INITIAL_DATA',
      { errorCorrectionLevel: 'M', width: 640, margin: 2 }
    );
    expect(encodeDrawing).not.toHaveBeenCalled();
  });

  it('retries once with thinDist=7 and quant=3 only on capacity overflow', async () => {
    const canvas = createFakeQrCanvas();
    const toCanvas = vi
      .fn()
      .mockRejectedValueOnce(new Error('The amount of data is too big to be stored in a QR Code'))
      .mockResolvedValueOnce(undefined);
    const encodeDrawing = vi.fn().mockResolvedValue('SIMPLIFIED_DATA');

    const res = await renderWorkQr({
      canvas,
      currentUrl: 'https://example.com/air-drawing-board/',
      initialData: 'HUGE_DATA',
      strokes: sampleStrokes,
      encodeDrawing,
      toCanvas,
    });

    expect(encodeDrawing).toHaveBeenCalledOnce();
    expect(encodeDrawing).toHaveBeenCalledWith(sampleStrokes, 7, 3);
    expect(toCanvas).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('simplified');
    expect(res.isError).toBe(false);
    expect(res.message).toContain('簡略化しました');
  });

  it('clears canvas and reports capacity exceeded when simplified retry also overflows', async () => {
    const canvas = createFakeQrCanvas();
    const toCanvas = vi
      .fn()
      .mockRejectedValue(new Error('The amount of data is too big to be stored in a QR Code'));
    const encodeDrawing = vi.fn().mockResolvedValue('STILL_TOO_BIG');

    const res = await renderWorkQr({
      canvas,
      currentUrl: 'https://example.com/air-drawing-board/',
      initialData: 'HUGE_DATA',
      strokes: sampleStrokes,
      encodeDrawing,
      toCanvas,
    });

    expect(encodeDrawing).toHaveBeenCalledOnce();
    expect(res.status).toBe('capacity_exceeded');
    expect(res.isError).toBe(true);
    expect(res.message).toContain('描画量が多くQRに入りませんでした');
    expect(canvas.clearRect).toHaveBeenCalledWith(0, 0, 320, 320);
  });

  it('does not retry and does not misreport as capacity overflow on general QR errors', async () => {
    const canvas = createFakeQrCanvas();
    const toCanvas = vi.fn().mockRejectedValue(new Error('2d context failure'));
    const encodeDrawing = vi.fn();

    const res = await renderWorkQr({
      canvas,
      currentUrl: 'https://example.com/air-drawing-board/',
      initialData: 'NORMAL_DATA',
      strokes: sampleStrokes,
      encodeDrawing,
      toCanvas,
    });

    expect(encodeDrawing).not.toHaveBeenCalled();
    expect(toCanvas).toHaveBeenCalledOnce();
    expect(res.status).toBe('error');
    expect(res.isError).toBe(true);
    expect(res.message).not.toContain('描画量が多く');
    expect(res.message).toContain('作品を全画面で見る');
    expect(canvas.clearRect).toHaveBeenCalledWith(0, 0, 320, 320);
  });
});
