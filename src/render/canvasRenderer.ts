import { DH, DW, PALETTE, WIDTHS, type Stroke } from '../domain/drawing';

/**
 * 単一ストロークを2Dコンテキストへ描画する。
 */
export function renderStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  if (stroke.pts.length === 0) return;
  const color = PALETTE[stroke.c] ?? PALETTE[0];
  const width = WIDTHS[stroke.w] ?? WIDTHS[1];

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.pts.length === 1) {
    ctx.beginPath();
    ctx.arc(stroke.pts[0][0], stroke.pts[0][1], width / 2, 0, 7);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(stroke.pts[0][0], stroke.pts[0][1]);
  for (let i = 1; i < stroke.pts.length - 1; i++) {
    const mx = (stroke.pts[i][0] + stroke.pts[i + 1][0]) / 2;
    const my = (stroke.pts[i][1] + stroke.pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(stroke.pts[i][0], stroke.pts[i][1], mx, my);
  }
  const last = stroke.pts[stroke.pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

/**
 * 確定ストローク群をベースキャンバス（白背景 960x720）へ一括描画する。
 */
export function renderAll(targetCtx: CanvasRenderingContext2D, list: readonly Stroke[]): void {
  targetCtx.save();
  targetCtx.fillStyle = '#ffffff';
  targetCtx.fillRect(0, 0, DW, DH);
  for (const stroke of list) {
    renderStroke(targetCtx, stroke);
  }
  targetCtx.restore();
}

/**
 * 描画中ストロークをアクティブレイヤーへ描画する。
 */
export function renderActive(targetCtx: CanvasRenderingContext2D, current: Stroke | null): void {
  targetCtx.clearRect(0, 0, DW, DH);
  if (current) {
    renderStroke(targetCtx, current);
  }
}

/**
 * ストローク配列をオフスクリーンキャンバスへ描画し、PNG Data URLを返す。
 */
export function renderStrokesToDataUrl(
  strokes: readonly Stroke[],
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')
): string {
  const canvas = createCanvas();
  canvas.width = DW;
  canvas.height = DH;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D context unavailable');
  }
  renderAll(ctx, strokes);
  return canvas.toDataURL('image/png');
}

export interface ThumbnailCache {
  get(dataStr: string): Promise<string>;
  clear(): void;
  readonly size: number;
}

/**
 * デコード済み描画データからサムネイルPNGを生成・キャッシュする。
 * 不正データはdecode段階で拒否され、部分的な描画やキャッシュ汚染を起こさない。
 */
export function createThumbnailCache(
  decode: (dataStr: string) => Promise<Stroke[]>,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
  maxEntries = 300
): ThumbnailCache {
  const cache = new Map<string, string>();

  return {
    async get(dataStr: string): Promise<string> {
      const existing = cache.get(dataStr);
      if (existing !== undefined) {
        return existing;
      }
      const list = await decode(dataStr);
      const url = renderStrokesToDataUrl(list, createCanvas);
      if (cache.size > maxEntries) {
        cache.clear();
      }
      cache.set(dataStr, url);
      return url;
    },
    clear(): void {
      cache.clear();
    },
    get size(): number {
      return cache.size;
    },
  };
}
