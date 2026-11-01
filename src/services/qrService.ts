import QRCode, { type QRCodeRenderersOptions } from 'qrcode';
import type { Stroke } from '../domain/drawing';

export interface MeterEvaluation {
  url: string;
  length: number;
  level: 'ok' | 'warn' | 'over';
  label: string;
  html: string;
}

export type QrRenderStatus = 'ok' | 'simplified' | 'capacity_exceeded' | 'error';

export interface QrRenderResult {
  status: QrRenderStatus;
  url?: string;
  data?: string;
  message: string;
  isError: boolean;
}

export interface RenderWorkQrOptions {
  canvas: HTMLCanvasElement;
  currentUrl: string;
  initialData: string;
  strokes: readonly Stroke[];
  encodeDrawing: (strokes: Stroke[], thinDist?: number, quant?: number) => Promise<string>;
  toCanvas?: (
    canvas: HTMLCanvasElement,
    text: string,
    options: QRCodeRenderersOptions
  ) => Promise<void>;
}

const QR_OPTIONS: QRCodeRenderersOptions = {
  errorCorrectionLevel: 'M',
  width: 640,
  margin: 2,
};

/**
 * 現在URLのフラグメント (#...) のみを除き、#d= 付きURLを生成する。
 */
export function buildShareUrl(currentUrl: string, encodedData: string): string {
  const baseUrl = currentUrl.split('#')[0];
  return `${baseUrl}#d=${encodedData}`;
}

/**
 * QR用データの文字数メーター表示値を算出する。
 */
export function evaluateMeter(currentUrl: string, encodedData: string): MeterEvaluation {
  const url = buildShareUrl(currentUrl, encodedData);
  const length = url.length;
  const level = length <= 700 ? 'ok' : length <= 1200 ? 'warn' : 'over';
  const label =
    length <= 1200
      ? 'QRで持ち帰れる見込み'
      : '描画量が多め（QRに入らない可能性）';
  const html = `QR用データ: <b class="${level}">${length}文字</b> ${label}`;
  return { url, length, level, label, html };
}

/**
 * エラーが qrcode@1.5.4 のデータ容量超過によるものかを判定する。
 * Canvas too large 等の汎用エラーを容量超過と誤判定しないよう、qrcode が投げる2種のメッセージに限定する。
 */
export function isCapacityOverflowError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return (
    message.includes('The amount of data is too big to be stored in a QR Code') ||
    message.includes('The chosen QR Code version cannot contain this amount of data.')
  );
}

function defaultToCanvas(
  canvas: HTMLCanvasElement,
  text: string,
  options: QRCodeRenderersOptions
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    QRCode.toCanvas(canvas, text, options, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function clearQrCanvas(canvas: HTMLCanvasElement): void {
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (ctx && typeof ctx.clearRect === 'function') {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

/**
 * 作品データをQRコードとして描画する。
 * 容量超過時のみ thinDist=7, quant=3 で1回だけ再試行し、一般エラーは容量超過と誤表示しない。
 */
export async function renderWorkQr(options: RenderWorkQrOptions): Promise<QrRenderResult> {
  const {
    canvas,
    currentUrl,
    initialData,
    strokes,
    encodeDrawing,
    toCanvas = defaultToCanvas,
  } = options;

  const initialUrl = buildShareUrl(currentUrl, initialData);
  try {
    await toCanvas(canvas, initialUrl, QR_OPTIONS);
    return {
      status: 'ok',
      url: initialUrl,
      data: initialData,
      message: '',
      isError: false,
    };
  } catch (firstErr) {
    if (!isCapacityOverflowError(firstErr)) {
      clearQrCanvas(canvas);
      return {
        status: 'error',
        message:
          'QRコードを生成できませんでした。「作品を全画面で見る」から写真で持ち帰ってください。',
        isError: true,
      };
    }

    try {
      const simplifiedData = await encodeDrawing([...strokes], 7, 3);
      const simplifiedUrl = buildShareUrl(currentUrl, simplifiedData);
      await toCanvas(canvas, simplifiedUrl, QR_OPTIONS);
      return {
        status: 'simplified',
        url: simplifiedUrl,
        data: simplifiedData,
        message: '※ QR用に線を少し簡略化しました（掲示板には元の作品が残っています）',
        isError: false,
      };
    } catch (retryErr) {
      clearQrCanvas(canvas);
      if (isCapacityOverflowError(retryErr)) {
        return {
          status: 'capacity_exceeded',
          message:
            '描画量が多くQRに入りませんでした。「作品を全画面で見る」から写真で持ち帰ってください。',
          isError: true,
        };
      }
      return {
        status: 'error',
        message:
          'QRコードを生成できませんでした。「作品を全画面で見る」から写真で持ち帰ってください。',
        isError: true,
      };
    }
  }
}
