import {
  DH,
  DW,
  PALETTE,
  type CameraController,
  type CameraOptions,
  type DrawingInput,
  type Stroke,
  type Work,
} from '../domain/drawing';
import { attachPointerInput } from '../input/pointerInput';
import {
  createThumbnailCache,
  renderActive,
  renderAll,
  renderStrokesToDataUrl,
  type ThumbnailCache,
} from '../render/canvasRenderer';
import {
  evaluateMeter,
  renderWorkQr,
  type QrRenderResult,
  type RenderWorkQrOptions,
} from '../services/qrService';
import { createLocalStorageWorkStore, type WorkStore } from '../storage/workStore';
import { createDrawingSession, type DrawingSession } from './drawingSession';
import { createIdleTimer, type IdleTimer, type ViewName } from './idleTimer';

export interface CameraModule {
  createCameraInput(options: CameraOptions): CameraController;
}

export interface RestoreState {
  imageUrl: string;
  error: string;
}

export interface AppControllerOptions {
  workStore?: WorkStore;
  encodeDrawing: (strokes: Stroke[], thinDist?: number, quant?: number) => Promise<string>;
  decodeDrawing: (str: string) => Promise<Stroke[]>;
  renderQr?: (options: RenderWorkQrOptions) => Promise<QrRenderResult>;
  renderStrokesToPng?: (strokes: readonly Stroke[]) => string;
  loadCameraModule?: () => Promise<CameraModule>;
  notify?: (message: string) => void;
  getCurrentUrl?: () => string;
  onViewChange?: (view: ViewName) => void;
  onBaseRender?: (strokes: readonly Stroke[]) => void;
  onActiveRender?: (current: Stroke | null) => void;
  onMeterRender?: ( strokes: readonly Stroke[]) => void;
  onBoardRender?: () => void;
  onAttractChange?: (visible: boolean) => void;
  onCameraStatusChange?: (message: string) => void;
  onCameraDebugChange?: (text: string) => void;
  onCameraDotChange?: (x: number, y: number, on: boolean) => void;
  onCameraDotOff?: () => void;
  onQrResult?: (result: QrRenderResult, fallbackImageUrl?: string) => void;
  onRestoreStateChange?: (state: RestoreState) => void;
  qrCanvas?: HTMLCanvasElement;
}

export interface AppController {
  readonly session: DrawingSession;
  readonly pointerInput: DrawingInput;
  readonly cameraInput: DrawingInput;
  readonly idleTimer: IdleTimer;
  readonly thumbCache: ThumbnailCache;
  readonly currentView: ViewName;
  readonly isAdmin: boolean;
  readonly isPosting: boolean;
  readonly isCameraRunning: boolean;
  readonly cameraStatus: string;
  readonly lastWork: Work | null;
  readonly doneFallbackImageUrl: string;
  readonly restoreState: RestoreState;
  showView(view: ViewName): void;
  resetToDraw(): void;
  postCurrentDrawing(): Promise<void>;
  toggleAdminMode(): boolean;
  getVisibleBoardWorks(): Work[];
  toggleWorkApproval(id: string): boolean;
  deleteWork(id: string): boolean;
  restoreFromHash(hash?: string): Promise<boolean>;
  toggleCamera(videoElement: HTMLVideoElement): Promise<void>;
  stopCamera(): void;
  poke(now?: number): void;
}

/**
 * アプリケーション状態・画面遷移・投稿/QR・掲示板・復元・カメラ制御を統合するコントローラ。
 */
export function createAppController(options: AppControllerOptions): AppController {
  const workStore = options.workStore ?? createLocalStorageWorkStore();
  const renderQr = options.renderQr ?? renderWorkQr;
  const renderStrokesToPng = options.renderStrokesToPng ?? ((s: readonly Stroke[]) => renderStrokesToDataUrl(s));
  const notify =
    options.notify ??
    ((msg: string) => {
      if (typeof globalThis.alert === 'function') {
        globalThis.alert(msg);
      }
    });
  const getCurrentUrl =
    options.getCurrentUrl ??
    (() => (typeof globalThis.location !== 'undefined' ? globalThis.location.href : 'http://localhost/'));

  const thumbCache = createThumbnailCache(options.decodeDrawing);

  let currentView: ViewName = 'draw';
  let isAdmin = false;
  let isPosting = false;
  let lastWork: Work | null = null;
  let doneFallbackImageUrl = '';
  let cameraController: CameraController | null = null;
  let cameraStatus = '';
  let restoreState: RestoreState = { imageUrl: '', error: '' };
  let cameraGeneration = 0;
  let cameraStart: Promise<void> | null = null;
  let restoreGeneration = 0;
  let postGeneration = 0;

  const session = createDrawingSession({
    onBaseChange: strokes => options.onBaseRender?.(strokes),
    onActiveChange: current => options.onActiveRender?.(current),
    onMeterUpdate: strokes => options.onMeterRender?.(strokes),
  });

  const idleTimer = createIdleTimer({
    getView: () => currentView,
    hasContent: () => session.hasContent(),
    onShowAttract: () => options.onAttractChange?.(true),
    onHideAttract: () => options.onAttractChange?.(false),
    onResetDone: () => resetToDraw(),
  });

  function poke(now?: number): void {
    idleTimer.poke(now);
  }

  const pointerInput: DrawingInput = {
    begin(x: number, y: number) {
      if (currentView !== 'draw' || isPosting) return;
      poke();
      session.begin(x, y);
    },
    move(x: number, y: number) {
      if (currentView !== 'draw' || isPosting) return;
      poke();
      session.move(x, y);
    },
    end() {
      session.end();
    },
  };

  // 非描画ビューではカメラからの描画入力を抑制し、描画ビュー中のみ受け付ける
  const cameraInput: DrawingInput = {
    begin(x: number, y: number) {
      if (currentView !== 'draw' || isPosting) return;
      poke();
      session.begin(x, y);
    },
    move(x: number, y: number) {
      if (currentView !== 'draw' || isPosting) return;
      poke();
      session.move(x, y);
    },
    end() {
      session.end();
    },
  };

  function showView(nextView: ViewName): void {
    if (isPosting) return;
    if (nextView !== 'restore') restoreGeneration++;
    if (currentView === 'draw' && nextView !== 'draw') {
      // 描画ビューからの離脱時は進行中のストロークを確定・終了しペンドットを消す
      stopCamera();
    }
    currentView = nextView;
    poke();
    options.onViewChange?.(nextView);
    if (nextView === 'board') {
      options.onBoardRender?.();
    }
  }

  function resetToDraw(): void {
    if (isPosting) return;
    postGeneration++;
    session.clear();
    showView('draw');
  }

  async function postCurrentDrawing(): Promise<void> {
    if (isPosting || currentView !== 'draw') return;
    stopCamera();
    session.end();
    if (session.strokes.length === 0) {
      notify('まだ何も描かれていません');
      return;
    }
    isPosting = true;
    const generation = ++postGeneration;
    const snapshot: Stroke[] = session.strokes.map(s => ({ c: s.c, w: s.w, pts: s.pts.map(([x, y]) => [x, y]) }));
    let encodedData: string;
    try {
      encodedData = await options.encodeDrawing(snapshot);
      lastWork = workStore.addWork(encodedData);
    } catch {
      isPosting = false;
      notify(
        '保存に失敗しました（ブラウザの保存容量がいっぱいの可能性があります）。作品は消えていないので、運営に声をかけてください。'
      );
      return;
    }

    isPosting = false;
    doneFallbackImageUrl = '';
    showView('done');

    const qrResult = await renderQr({
      canvas: options.qrCanvas ?? ({} as HTMLCanvasElement),
      currentUrl: getCurrentUrl(),
      initialData: encodedData,
      strokes: snapshot,
      encodeDrawing: options.encodeDrawing,
    });
    if (generation !== postGeneration) return;
    if (qrResult.isError && lastWork) {
      try {
        doneFallbackImageUrl = renderStrokesToPng(snapshot);
      } catch {
        try {
          doneFallbackImageUrl = await thumbCache.get(lastWork.data);
        } catch {
          doneFallbackImageUrl = '';
        }
      }
    }
    if (generation === postGeneration) options.onQrResult?.(qrResult, doneFallbackImageUrl);
  }

  function toggleAdminMode(): boolean {
    isAdmin = !isAdmin;
    options.onBoardRender?.();
    return isAdmin;
  }

  function getVisibleBoardWorks(): Work[] {
    const all = workStore.loadWorks();
    return isAdmin ? all : all.filter(w => w.approved);
  }

  function toggleWorkApproval(id: string): boolean {
    if (!isAdmin) return false;
    const updated = workStore.toggleApproval(id);
    if (!updated) return false;
    options.onBoardRender?.();
    return true;
  }

  function deleteWork(id: string): boolean {
    if (!isAdmin) return false;
    workStore.deleteWork(id);
    options.onBoardRender?.();
    return true;
  }

  async function restoreFromHash(hash: string = ''): Promise<boolean> {
    const generation = ++restoreGeneration;
    if (!hash.startsWith('#d=')) {
      return false;
    }
    const payload = hash.slice(3);
    showView('restore');
    restoreState = { imageUrl: '', error: '' };
    options.onRestoreStateChange?.(restoreState);

    try {
      if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
        throw new Error('invalid payload');
      }
      const list = await options.decodeDrawing(payload);
      if (generation !== restoreGeneration) return true;
      const imageUrl = renderStrokesToPng(list);
      restoreState = { imageUrl, error: '' };
    } catch {
      if (generation !== restoreGeneration) return true;
      restoreState = {
        imageUrl: '',
        error: 'データを読み取れませんでした（破損している可能性があります）。',
      };
    }
    options.onRestoreStateChange?.(restoreState);
    return true;
  }

  function setCameraStatus(msg: string): void {
    cameraStatus = msg;
    options.onCameraStatusChange?.(msg);
  }

  function stopCamera(): void {
    cameraGeneration++;
    cameraStart = null;
    const previous = cameraController;
    cameraController = null;
    previous?.stop();
    setCameraStatus('');
    session.end();
    options.onCameraDotOff?.();
    options.onCameraDebugChange?.('');
  }

  async function toggleCamera(videoElement: HTMLVideoElement): Promise<void> {
    if (currentView !== 'draw' || isPosting) return;
    if (cameraController && cameraController.running) {
      stopCamera();
      return;
    }
    if (cameraStart) return cameraStart;
    // 権限拒否等からの再試行も、今回の世代のコールバックで作り直す。
    if (cameraController) stopCamera();

    const generation = ++cameraGeneration;
    const pending = (async () => { try {
      if (!cameraController) {
        if (!options.loadCameraModule) {
          throw new Error('Camera module loader not configured');
        }
        const mod = await options.loadCameraModule();
        if (generation !== cameraGeneration || currentView !== 'draw') return;
        cameraController = mod.createCameraInput({
          video: videoElement,
          input: {
            begin: (x, y) => { if (generation === cameraGeneration) cameraInput.begin(x, y); },
            move: (x, y) => { if (generation === cameraGeneration) cameraInput.move(x, y); },
            end: () => { if (generation === cameraGeneration) cameraInput.end(); },
          },
          status: msg => { if (generation === cameraGeneration) setCameraStatus(msg); },
          dot: (x, y, on) => {
            if (generation !== cameraGeneration) return;
            if (currentView !== 'draw') {
              options.onCameraDotOff?.();
              return;
            }
            poke();
            options.onCameraDotChange?.(x, y, on);
          },
          dotOff: () => {
            if (generation === cameraGeneration) options.onCameraDotOff?.();
          },
          debug: (ratio, on) => {
            if (generation !== cameraGeneration || currentView !== 'draw') return;
            options.onCameraDebugChange?.(
              `pinch比 ${ratio.toFixed(2)}（ON<0.38 / OFF>0.55）${on ? ' 描画中' : ''}`
            );
          },
        });
      }
      await cameraController.start();
    } catch {
      if (generation !== cameraGeneration) return;
      session.end();
      options.onCameraDotOff?.();
      setCameraStatus(
        'カメラを使えませんでした（許可・接続・通信を確認）。マウス/タッチで描けます。'
      );
    } })();
    cameraStart = pending;
    try { await pending; } finally { if (cameraStart === pending) cameraStart = null; }
  }

  return {
    session,
    pointerInput,
    cameraInput,
    idleTimer,
    thumbCache,
    get currentView() {
      return currentView;
    },
    get isAdmin() {
      return isAdmin;
    },
    get isPosting() {
      return isPosting;
    },
    get isCameraRunning() {
      return Boolean(cameraController && cameraController.running);
    },
    get cameraStatus() {
      return cameraStatus;
    },
    get lastWork() {
      return lastWork;
    },
    get doneFallbackImageUrl() {
      return doneFallbackImageUrl;
    },
    get restoreState() {
      return restoreState;
    },
    showView,
    resetToDraw,
    postCurrentDrawing,
    toggleAdminMode,
    getVisibleBoardWorks,
    toggleWorkApproval,
    deleteWork,
    restoreFromHash,
    toggleCamera,
    stopCamera,
    poke,
  };
}

export interface MountDomDependencies {
  encodeDrawing: (strokes: Stroke[], thinDist?: number, quant?: number) => Promise<string>;
  decodeDrawing: (str: string) => Promise<Stroke[]>;
  loadCameraModule: () => Promise<CameraModule>;
  workStore?: WorkStore;
  rootDocument?: Document;
}

/**
 * ブラウザDOMへアプリケーションコントローラを結線する。
 */
export function mountApp(deps: MountDomDependencies): AppController {
  const doc = deps.rootDocument ?? document;

  const getEl = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`Missing required element #${id}`);
    return el as T;
  };

  const tabDraw = getEl<HTMLButtonElement>('tabDraw');
  const tabBoard = getEl<HTMLButtonElement>('tabBoard');
  const fsBtn = getEl<HTMLButtonElement>('fsBtn');

  const viewDraw = getEl<HTMLElement>('viewDraw');
  const viewBoard = getEl<HTMLElement>('viewBoard');
  const viewDone = getEl<HTMLElement>('viewDone');
  const viewRestore = getEl<HTMLElement>('viewRestore');

  const stage = getEl<HTMLElement>('stage');
  const drawCanvas = getEl<HTMLCanvasElement>('drawCanvas');
  const activeCanvas = getEl<HTMLCanvasElement>('activeCanvas');
  const attract = getEl<HTMLElement>('attract');
  const camPreview = getEl<HTMLVideoElement>('camPreview');
  const penDot = getEl<HTMLElement>('penDot');

  const paletteEl = getEl<HTMLElement>('palette');
  const undoBtn = getEl<HTMLButtonElement>('undoBtn');
  const clearBtn = getEl<HTMLButtonElement>('clearBtn');
  const camBtn = getEl<HTMLButtonElement>('camBtn');
  const camStatus = getEl<HTMLElement>('camStatus');
  const camDebug = getEl<HTMLElement>('camDebug');
  const postBtn = getEl<HTMLButtonElement>('postBtn');
  const meterEl = getEl<HTMLElement>('meter');

  const boardCount = getEl<HTMLElement>('boardCount');
  const adminBtn = getEl<HTMLButtonElement>('adminBtn');
  const exportBtn = getEl<HTMLButtonElement>('exportBtn');
  const backDrawBtn = getEl<HTMLButtonElement>('backDrawBtn');
  const boardGrid = getEl<HTMLElement>('boardGrid');
  const boardEmpty = getEl<HTMLElement>('boardEmpty');

  const qrCanvas = getEl<HTMLCanvasElement>('qrCanvas');
  const qrMsg = getEl<HTMLElement>('qrMsg');
  const fullBtn = getEl<HTMLButtonElement>('fullBtn');
  const nextBtn = getEl<HTMLButtonElement>('nextBtn');
  const fullImg = getEl<HTMLImageElement>('fullImg');

  const restoreImg = getEl<HTMLImageElement>('restoreImg');
  const dlLink = getEl<HTMLAnchorElement>('dlLink');
  const restoreErr = getEl<HTMLElement>('restoreErr');

  const baseCtx = drawCanvas.getContext('2d')!;
  const activeCtx = activeCanvas.getContext('2d')!;

  const workStore = deps.workStore ?? createLocalStorageWorkStore();

  let meterTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleMeterUpdate(strokes: readonly Stroke[]): void {
    if (meterTimer !== null) {
      clearTimeout(meterTimer);
      meterTimer = null;
    }
    if (strokes.length === 0) {
      meterEl.textContent = '';
      return;
    }
    const snapshot = strokes.map(s => ({ c: s.c, w: s.w, pts: [...s.pts] }));
    meterTimer = setTimeout(async () => {
      if (app.session.strokes.length === 0) {
        meterEl.textContent = '';
        return;
      }
      try {
        const encoded = await deps.encodeDrawing(snapshot);
        if (app.session.strokes.length === 0) {
          meterEl.textContent = '';
          return;
        }
        const evaluation = evaluateMeter(location.href, encoded);
        meterEl.innerHTML = evaluation.html;
      } catch {
        meterEl.textContent = '';
      }
    }, 250);
  }

  function renderBoardDom(): void {
    const allWorks = workStore.loadWorks();
    const approvedCount = allWorks.filter(w => w.approved).length;
    boardEmpty.style.display = approvedCount > 0 ? 'none' : 'block';
    boardCount.textContent = `作品 ${allWorks.length} 件（公開 ${approvedCount} 件）`;
    boardGrid.innerHTML = '';

    for (const w of allWorks) {
      if (!w.approved && !app.isAdmin) continue;
      const card = doc.createElement('div');
      card.className = 'card';

      const img = doc.createElement('img');
      img.alt = '作品';
      app.thumbCache
        .get(w.data)
        .then(url => {
          img.src = url;
        })
        .catch(() => {});

      card.appendChild(img);

      if (app.isAdmin) {
        const approveBtn = doc.createElement('button');
        approveBtn.className = 'del';
        approveBtn.textContent = w.approved ? '非表示にする' : '承認して表示';
        approveBtn.onclick = () => {
          app.toggleWorkApproval(w.id);
        };

        const deleteBtn = doc.createElement('button');
        deleteBtn.className = 'del';
        deleteBtn.style.background = '#555';
        deleteBtn.textContent = '完全に削除';
        deleteBtn.onclick = () => {
          app.deleteWork(w.id);
        };

        card.append(approveBtn, deleteBtn);
      }

      boardGrid.appendChild(card);
    }
  }

  const viewMap: Record<ViewName, HTMLElement> = {
    draw: viewDraw,
    board: viewBoard,
    done: viewDone,
    restore: viewRestore,
  };

  const app = createAppController({
    workStore,
    encodeDrawing: deps.encodeDrawing,
    decodeDrawing: deps.decodeDrawing,
    loadCameraModule: deps.loadCameraModule,
    qrCanvas,
    onViewChange(view) {
      for (const [k, el] of Object.entries(viewMap) as [ViewName, HTMLElement][]) {
        el.classList.toggle('show', k === view);
      }
      tabDraw.classList.toggle('active', view === 'draw');
      tabBoard.classList.toggle('active', view === 'board');
    },
    onBaseRender(strokes) {
      renderAll(baseCtx, strokes);
    },
    onActiveRender(current) {
      renderActive(activeCtx, current);
    },
    onMeterRender(strokes) {
      scheduleMeterUpdate(strokes);
    },
    onBoardRender() {
      renderBoardDom();
    },
    onAttractChange(visible) {
      attract.classList.toggle('show', visible);
    },
    onCameraStatusChange(msg) {
      camStatus.textContent = msg;
    },
    onCameraDebugChange(text) {
      camDebug.textContent = text;
    },
    onCameraDotChange(x, y, on) {
      const r = drawCanvas.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      penDot.style.display = 'block';
      penDot.style.left = `${r.left - sr.left + (x * r.width) / DW}px`;
      penDot.style.top = `${r.top - sr.top + (y * r.height) / DH}px`;
      penDot.style.background = on ? 'rgba(232,67,147,.5)' : 'transparent';
    },
    onCameraDotOff() {
      penDot.style.display = 'none';
    },
    onQrResult(result, fallbackImageUrl) {
      qrMsg.textContent = result.message;
      qrMsg.className = result.isError ? 'err' : '';
      if (result.isError && fallbackImageUrl) {
        fullImg.src = fallbackImageUrl;
        fullImg.style.display = 'block';
      } else {
        fullImg.style.display = 'none';
      }
    },
    onRestoreStateChange(state) {
      if (state.imageUrl) {
        restoreImg.src = state.imageUrl;
        restoreImg.style.display = '';
        dlLink.href = state.imageUrl;
      } else {
        restoreImg.removeAttribute('src');
        dlLink.removeAttribute('href');
      }
      restoreErr.textContent = state.error;
    },
  });

  // パレット生成
  paletteEl.innerHTML = '';
  PALETTE.forEach((col, idx) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `swatch${idx === 0 ? ' sel' : ''}`;
    btn.style.background = col;
    btn.title = col;
    btn.onclick = () => {
      app.session.setColor(idx);
      paletteEl.querySelectorAll('.swatch').forEach(el => el.classList.remove('sel'));
      btn.classList.add('sel');
    };
    paletteEl.appendChild(btn);
  });

  // 線幅ボタン
  const widthButtons = doc.querySelectorAll<HTMLButtonElement>('.wbtn');
  widthButtons.forEach(btn => {
    btn.onclick = () => {
      app.session.setWidth(Number(btn.dataset.w));
      widthButtons.forEach(el => el.classList.remove('sel'));
      btn.classList.add('sel');
    };
  });

  // 描画ツールボタン
  undoBtn.onclick = () => {
    if (app.isPosting) return;
    app.session.undo();
  };
  clearBtn.onclick = () => {
    if (app.isPosting) return;
    app.session.clear();
  };

  // Ctrl+Z / Cmd+Z ショートカット
  doc.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoBtn.click();
    }
  });

  // ポインタ入力結線
  attachPointerInput(activeCanvas, app.pointerInput, () => app.poke());

  // ナビゲーション・全画面
  tabDraw.onclick = () => app.showView('draw');
  tabBoard.onclick = () => app.showView('board');
  backDrawBtn.onclick = () => app.showView('draw');
  fsBtn.onclick = () => {
    if (doc.documentElement.requestFullscreen) {
      doc.documentElement.requestFullscreen().catch(() => {});
    }
  };

  // 掲示板管理・エクスポート
  adminBtn.onclick = () => {
    const admin = app.toggleAdminMode();
    doc.body.classList.toggle('admin', admin);
    adminBtn.textContent = admin ? '運営モード中（承認・削除可）' : '運営モード';
  };
  exportBtn.onclick = () => {
    const blob = new Blob([workStore.exportJson()], { type: 'application/json' });
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'airboard-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // 投稿・完了画面操作
  postBtn.onclick = async () => {
    if (app.isPosting) return;
    if (app.session.strokes.length === 0) {
      await app.postCurrentDrawing();
      return;
    }
    postBtn.disabled = true;
    fullImg.style.display = 'none';
    qrMsg.textContent = '';
    qrMsg.className = '';
    try {
      await app.postCurrentDrawing();
    } finally {
      postBtn.disabled = false;
    }
  };

  fullBtn.onclick = async () => {
    if (!app.lastWork) return;
    try {
      fullImg.src = await app.thumbCache.get(app.lastWork.data);
      fullImg.style.display = 'block';
      if (typeof fullImg.scrollIntoView === 'function') {
        fullImg.scrollIntoView({ behavior: 'smooth' });
      }
    } catch {
      // デコード失敗時は表示しない
    }
  };

  nextBtn.onclick = () => {
    app.resetToDraw();
  };

  // カメラ起動・停止（ボタン操作時のみ）
  camBtn.onclick = async () => {
    await app.toggleCamera(camPreview);
    camBtn.textContent = app.isCameraRunning ? '📷 カメラ停止' : '📷 カメラで描く';
  };

  // ページ非表示・フォーカス離脱時は進行中のストロークを安全に終了
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) {
      app.session.end();
      penDot.style.display = 'none';
    }
  });
  window.addEventListener('blur', () => {
    app.session.end();
  });

  // アトラクト・無操作タイマー監視
  doc.addEventListener('pointerdown', () => app.poke(), true);
  attract.addEventListener('pointerdown', e => {
    e.stopPropagation();
    app.poke();
  });
  attract.addEventListener('click', e => {
    e.stopPropagation();
    app.poke();
  });
  setInterval(() => {
    app.idleTimer.check();
  }, 1000);

  // 初期表示：#d= ハッシュがあれば復元、なければ描画ベースキャンバスを初期化
  const handleLocationHash = async () => {
    const restored = await app.restoreFromHash(location.hash);
    if (!restored) {
      renderAll(baseCtx, app.session.strokes);
    }
  };
  void handleLocationHash();
  window.addEventListener('hashchange', () => {
    void handleLocationHash();
  });

  return app;
}
