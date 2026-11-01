import { describe, expect, it, vi } from 'vitest';
import type { CameraController, CameraOptions, Stroke, Work } from '../domain/drawing';
import type { QrRenderResult } from '../services/qrService';
import type { WorkStore } from '../storage/workStore';
import { createAppController } from './appController';

function createMemoryStore(initial: Work[] = []): WorkStore & { works: Work[]; failSave: boolean } {
  const state = {
    works: [...initial],
    failSave: false,
    loadWorks() {
      return state.works.map(w => ({ ...w }));
    },
    saveWorks(next: readonly Work[]) {
      if (state.failSave) throw new Error('QuotaExceeded');
      state.works = next.map(w => ({ ...w }));
    },
    addWork(data: string, now = 1700000000000): Work {
      if (state.failSave) throw new Error('QuotaExceeded');
      const work: Work = {
        id: `${now.toString(36)}_${state.works.length}`,
        ts: now,
        data,
        approved: false,
      };
      state.works.push(work);
      return { ...work };
    },
    toggleApproval(id: string) {
      const target = state.works.find(w => w.id === id);
      if (!target) return undefined;
      target.approved = !target.approved;
      return { ...target };
    },
    deleteWork(id: string) {
      state.works = state.works.filter(w => w.id !== id);
    },
    exportJson() {
      return JSON.stringify(state.works, null, 2);
    },
  };
  return state;
}

describe('appController', () => {
  it('prevents empty post and double-submit, saves before QR, and preserves drawing on save failure', async () => {
    const store = createMemoryStore();
    const notices: string[] = [];
    const callOrder: string[] = [];

    let resolveEncode!: (val: string) => void;
    const encodeDrawing = vi.fn(
      () =>
        new Promise<string>(res => {
          callOrder.push('encode');
          resolveEncode = res;
        })
    );
    const decodeDrawing = vi.fn(async (): Promise<Stroke[]> => [
      { c: 0, w: 1, pts: [[10, 10]] },
    ]);
    const renderQr = vi.fn(async (): Promise<QrRenderResult> => {
      callOrder.push('qr');
      return {
        status: 'ok',
        url: 'https://example.com/#d=ENC',
        data: 'ENC',
        message: '',
        isError: false,
      };
    });

    const app = createAppController({
      workStore: store,
      encodeDrawing,
      decodeDrawing,
      renderQr,
      notify: msg => notices.push(msg),
      getCurrentUrl: () => 'https://example.com/air-drawing-board/',
    });

    // Empty post rejected
    await app.postCurrentDrawing();
    expect(notices).toEqual(['まだ何も描かれていません']);
    expect(store.works).toHaveLength(0);

    // Draw a stroke
    app.pointerInput.begin(100, 100);
    app.pointerInput.move(200, 200);
    app.pointerInput.end();
    expect(app.session.strokes).toHaveLength(1);

    // Trigger post and double-click while in flight
    const p1 = app.postCurrentDrawing();
    const p2 = app.postCurrentDrawing();
    expect(app.isPosting).toBe(true);
    expect(encodeDrawing).toHaveBeenCalledTimes(1);

    resolveEncode('ENC_1');
    await Promise.all([p1, p2]);

    expect(app.isPosting).toBe(false);
    expect(store.works).toHaveLength(1);
    expect(store.works[0].approved).toBe(false);
    expect(callOrder).toEqual(['encode', 'qr']);
    expect(app.currentView).toBe('done');

    // Reset to draw and test save failure keeps drawing
    app.resetToDraw();
    app.pointerInput.begin(50, 60);
    app.pointerInput.end();
    store.failSave = true;
    encodeDrawing.mockImplementationOnce(async () => 'ENC_2');

    await app.postCurrentDrawing();
    expect(app.currentView).toBe('draw');
    expect(app.session.strokes).toHaveLength(1);
    expect(notices[notices.length - 1]).toContain('保存に失敗しました');

    // When save succeeds but QR fails, fallback PNG image is prepared automatically
    store.failSave = false;
    encodeDrawing.mockImplementationOnce(async () => 'ENC_3');
    renderQr.mockImplementationOnce(async () => ({
      status: 'capacity_exceeded' as const,
      message: '描画量が多くQRに入りませんでした。',
      isError: true,
    }));
    const fallbackApp = createAppController({
      workStore: store,
      encodeDrawing,
      decodeDrawing,
      renderQr,
      renderStrokesToPng: () => 'data:image/png;base64,FALLBACK_PNG',
    });
    fallbackApp.pointerInput.begin(10, 20);
    fallbackApp.pointerInput.end();
    await fallbackApp.postCurrentDrawing();
    expect(fallbackApp.currentView).toBe('done');
    expect(fallbackApp.doneFallbackImageUrl).toBe('data:image/png;base64,FALLBACK_PNG');
  });

  it('restricts board approval, hide, and delete actions to admin mode only', () => {
    const store = createMemoryStore([
      { id: 'w1', ts: 1, data: 'd1', approved: false },
      { id: 'w2', ts: 2, data: 'd2', approved: true },
    ]);
    const app = createAppController({
      workStore: store,
      encodeDrawing: async () => 'ENC',
      decodeDrawing: async () => [],
    });

    expect(app.isAdmin).toBe(false);
    expect(app.getVisibleBoardWorks().map(w => w.id)).toEqual(['w2']);

    // Non-admin attempts are rejected
    expect(app.toggleWorkApproval('w1')).toBe(false);
    expect(app.deleteWork('w2')).toBe(false);
    expect(store.loadWorks()).toHaveLength(2);
    expect(store.loadWorks()[0].approved).toBe(false);

    // Enable admin mode
    app.toggleAdminMode();
    expect(app.isAdmin).toBe(true);
    expect(app.getVisibleBoardWorks().map(w => w.id)).toEqual(['w1', 'w2']);

    expect(app.toggleWorkApproval('w1')).toBe(true);
    expect(store.loadWorks()[0].approved).toBe(true);

    expect(app.deleteWork('w2')).toBe(true);
    expect(store.loadWorks().map(w => w.id)).toEqual(['w1']);
  });

  it('restores valid #d= hash to PNG and rejects invalid data completely without partial output', async () => {
    const store = createMemoryStore();
    const decodeDrawing = vi.fn(async (s: string): Promise<Stroke[]> => {
      if (s !== 'VALID_DATA') throw new Error('corrupt');
      return [{ c: 0, w: 1, pts: [[10, 20]] }];
    });

    const app = createAppController({
      workStore: store,
      encodeDrawing: async () => 'ENC',
      decodeDrawing,
      renderStrokesToPng: () => 'data:image/png;base64,RESTORED',
    });

    const ok = await app.restoreFromHash('#d=VALID_DATA');
    expect(ok).toBe(true);
    expect(app.currentView).toBe('restore');
    expect(app.restoreState).toEqual({
      imageUrl: 'data:image/png;base64,RESTORED',
      error: '',
    });

    const bad = await app.restoreFromHash('#d=INVALID_DATA');
    expect(bad).toBe(true);
    expect(app.currentView).toBe('restore');
    expect(app.restoreState).toEqual({
      imageUrl: '',
      error: 'データを読み取れませんでした（破損している可能性があります）。',
    });

    const badChars = await app.restoreFromHash('#d=!!!');
    expect(badChars).toBe(true);
    expect(app.currentView).toBe('restore');
    expect(app.restoreState.imageUrl).toBe('');
    expect(app.restoreState.error).toContain('データを読み取れませんでした');
  });

  it('loads camera only on button action, survives import failure, suppresses camera in non-draw views, and ends stroke on stop/leave', async () => {
    const store = createMemoryStore();
    let capturedOpts: CameraOptions | null = null;
    let running = false;

    const fakeController: CameraController = {
      async start() {
        running = true;
      },
      stop: vi.fn(() => {
        running = false;
      }),
      get running() {
        return running;
      },
    };

    const loadCameraModule = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValue({
        createCameraInput: (opts: CameraOptions) => {
          capturedOpts = opts;
          return fakeController;
        },
      });

    const app = createAppController({
      workStore: store,
      encodeDrawing: async () => 'ENC',
      decodeDrawing: async () => [],
      loadCameraModule,
    });

    // Camera is not imported until button is pressed
    expect(loadCameraModule).not.toHaveBeenCalled();

    // First attempt: import fails, but pointer drawing still works
    await app.toggleCamera({} as HTMLVideoElement);
    expect(app.cameraStatus).toContain('カメラを使えませんでした');
    app.pointerInput.begin(10, 10);
    app.pointerInput.end();
    expect(app.session.strokes).toHaveLength(1);
    app.session.clear();

    // Second attempt: camera starts
    await app.toggleCamera({} as HTMLVideoElement);
    expect(app.isCameraRunning).toBe(true);
    expect(capturedOpts).not.toBeNull();

    // Camera drawing in draw view works and updates idle timer
    capturedOpts!.input.begin(100, 100);
    capturedOpts!.input.move(150, 150);
    expect(app.session.current?.pts).toHaveLength(2);

    // Leaving draw view ends active stroke and suppresses subsequent camera inputs
    app.showView('board');
    expect(app.session.current).toBeNull();
    expect(app.session.strokes).toHaveLength(1);

    capturedOpts!.input.begin(300, 300);
    capturedOpts!.input.move(350, 350);
    capturedOpts!.input.end();
    expect(app.session.strokes).toHaveLength(1);

    // Return to draw view, start stroke, then stop camera -> ends stroke immediately
    app.showView('draw');
    expect(app.isCameraRunning).toBe(false);
    await app.toggleCamera({} as HTMLVideoElement);
    capturedOpts!.input.begin(400, 400);
    expect(app.session.current).not.toBeNull();

    await app.toggleCamera({} as HTMLVideoElement);
    expect(app.isCameraRunning).toBe(false);
    expect(app.session.current).toBeNull();
    expect(app.session.strokes).toHaveLength(2);
  });
});
