import { describe, expect, it, vi } from 'vitest';
import type { CameraController, Stroke, Work } from '../domain/drawing';
import { createAppController, type CameraModule } from './appController';
import { createLocalStorageWorkStore } from '../storage/workStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function store() {
  let raw = '[]';
  return createLocalStorageWorkStore({ getItem: () => raw, setItem: (_, value) => { raw = value; } });
}
const stroke: Stroke = { c: 0, w: 1, pts: [[100, 100]] };

describe('非同期処理と作品の一貫性', () => {
  it('プレビュー開始後、モデル読込中でもカメラを停止できる', async () => {
    const loading = deferred<void>();
    let running = false;
    const stop = vi.fn(() => { running = false; });
    const app = createAppController({ workStore: store(), encodeDrawing: async () => '', decodeDrawing: async () => [],
      loadCameraModule: async () => ({ createCameraInput: () => ({
        get running() { return running; },
        start() { running = true; return loading.promise; }, stop,
      }) }),
    });
    const starting = app.toggleCamera({} as HTMLVideoElement);
    await vi.waitFor(() => expect(app.isCameraRunning).toBe(true));
    const stopping = app.toggleCamera({} as HTMLVideoElement);
    expect(stop).toHaveBeenCalledOnce();
    loading.resolve();
    await Promise.all([starting, stopping]);
    expect(app.isCameraRunning).toBe(false);
  });
  it('カメラimportを一度に制限し、画面離脱と停止後に開始しない', async () => {
    const module = deferred<CameraModule>();
    const start = vi.fn(async () => {});
    const stop = vi.fn();
    const create = vi.fn((): CameraController => ({ start, stop, running: false }));
    const load = vi.fn(() => module.promise);
    const app = createAppController({ workStore: store(), encodeDrawing: async () => '', decodeDrawing: async () => [], loadCameraModule: load });
    const first = app.toggleCamera({} as HTMLVideoElement);
    const second = app.toggleCamera({} as HTMLVideoElement);
    expect(load).toHaveBeenCalledTimes(1);
    app.showView('board');
    app.stopCamera();
    module.resolve({ createCameraInput: create });
    await Promise.all([first, second]);
    expect(create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('描画中の線を確定し、保存とQRと失敗PNGへ同じdeep snapshotを渡す', async () => {
    const encoded = deferred<string>();
    let captured: Stroke[] = [];
    let qrStrokes: readonly Stroke[] = [];
    let pngStrokes: readonly Stroke[] = [];
    const order: string[] = [];
    const workStore = store();
    const originalAdd = workStore.addWork;
    workStore.addWork = (data: string): Work => { order.push('save'); return originalAdd(data); };
    const app = createAppController({ workStore,
      encodeDrawing: list => { captured = list; return encoded.promise; }, decodeDrawing: async () => [],
      renderQr: async options => { order.push('qr'); qrStrokes = options.strokes; return { status: 'error', message: 'QR failure', isError: true }; },
      renderStrokesToPng: list => { pngStrokes = list; return 'PNG'; },
    });
    app.pointerInput.begin(100, 100); app.pointerInput.end();
    app.cameraInput.begin(200, 200);
    const posting = app.postCurrentDrawing();
    expect(captured).toHaveLength(2);
    app.session.strokes[0].pts[0][0] = 900;
    app.session.clear();
    encoded.resolve('DATA');
    await posting;
    expect(captured[0].pts[0][0]).toBe(100);
    expect(qrStrokes).toEqual(captured);
    expect(pngStrokes).toEqual(captured);
    expect(order).toEqual(['save', 'qr']);
  });

  it('復元が逆順に完了しても最新URLの画像とリンクを保持する', async () => {
    const older = deferred<Stroke[]>();
    const app = createAppController({ workStore: store(), encodeDrawing: async () => '',
      decodeDrawing: data => data === 'OLD' ? older.promise : Promise.resolve([{ ...stroke, c: 5 }]),
      renderStrokesToPng: list => `PNG-${list[0].c}`,
    });
    const first = app.restoreFromHash('#d=OLD');
    await app.restoreFromHash('#d=NEW');
    older.resolve([stroke]); await first;
    expect(app.restoreState.imageUrl).toBe('PNG-5');
  });
});
