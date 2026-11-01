import type { HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { DH, DW, type CameraController, type CameraOptions, type Point } from '../domain/drawing';
import { OneEuroFilter } from './oneEuroFilter';

/** object-fit:cover と同じ切り取り。鏡像への変換は呼び出し側で一度だけ行う。 */
export function coverCoordinates(x: number, y: number, width: number, height: number): Point {
  const videoAspect = width / height, canvasAspect = DW / DH;
  if (videoAspect > canvasAspect) {
    const fraction = canvasAspect / videoAspect;
    x = (x - (1 - fraction) / 2) / fraction;
  } else {
    const fraction = videoAspect / canvasAspect;
    y = (y - (1 - fraction) / 2) / fraction;
  }
  return [x, y];
}

export function nextPinchState(pinching: boolean, ratio: number): boolean {
  return Number.isFinite(ratio) && ratio >= 0 && ratio < (pinching ? 0.55 : 0.38);
}

function cameraError(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  switch (name) {
    case 'NotAllowedError': return 'カメラの許可が得られませんでした。サイトの設定からカメラを「許可」に変えて、もう一度押してください。';
    case 'NotFoundError': case 'OverconstrainedError': return '使えるカメラが見つかりませんでした。接続を確認してください。描画はタッチ/マウスでできます。';
    case 'NotReadableError': return 'カメラが他のアプリに使用中のようです。そのアプリを閉じてからもう一度押してください。';
    case 'SecurityError': return 'この開き方ではカメラを使えません。HTTPSのページから開いてください。';
    default: return 'カメラを使えませんでした。描画はタッチ/マウスでできます。';
  }
}

function validHand(points: NormalizedLandmark[] | undefined): points is NormalizedLandmark[] {
  return !!points && [0, 4, 8, 9].every(index => {
    const point = points[index];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  });
}

/** 作成時には権限要求・モデル読込・イベント登録を行わない。 */
export function createCameraInput(options: CameraOptions): CameraController {
  const { video, input } = options;
  const fx = new OneEuroFilter(1.2, 0.02), fy = new OneEuroFilter(1.2, 0.02);
  let generation = 0;
  let running = false;
  let starting: Promise<void> | null = null;
  let stream: MediaStream | null = null;
  let landmarker: HandLandmarker | null = null;
  let frame: number | null = null;
  let pinching = false;

  const endGesture = (): void => {
    if (pinching) { pinching = false; input.end(); }
    options.dotOff();
    fx.reset(); fy.reset();
  };

  const stop = (): void => {
    generation++;
    running = false;
    starting = null;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (landmarker) {
      const previous = landmarker;
      landmarker = null;
      try { previous.close(); } catch { /* 他のリソース解放は続行する。 */ }
    }
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    video.pause();
    video.srcObject = null;
    video.style.display = 'none';
    window.removeEventListener('pagehide', stop);
    endGesture();
    options.status('');
  };

  const initialize = async (session: number): Promise<void> => {
    if (globalThis.isSecureContext === false || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      options.status(cameraError({ name: 'SecurityError' }));
      return;
    }
    window.addEventListener('pagehide', stop);
    options.status('カメラの許可を確認中…（ブラウザのダイアログで「許可」を押してください）');
    let acquired: MediaStream;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    } catch (error) {
      if (session === generation) { stop(); options.status(cameraError(error)); }
      return;
    }
    if (session !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    video.srcObject = acquired;
    video.style.display = 'block';
    try { await video.play(); } catch { /* 参照実装と同様、映像取得済みなら認識準備を続ける。 */ }
    if (session !== generation) return;
    running = true;
    options.status('手の認識モデルを読み込み中…');
    try {
      const mp = await import('@mediapipe/tasks-vision');
      if (session !== generation) return;
      const vision = await mp.FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}wasm`);
      if (session !== generation) return;
      const modelOptions = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`, delegate },
        runningMode: 'VIDEO' as const,
        numHands: 1,
      });
      let loaded: HandLandmarker;
      try { loaded = await mp.HandLandmarker.createFromOptions(vision, modelOptions('GPU')); }
      catch (error) {
        if (session !== generation) return;
        loaded = await mp.HandLandmarker.createFromOptions(vision, modelOptions('CPU'));
      }
      if (session !== generation) { loaded.close(); return; }
      landmarker = loaded;
      options.status('カメラ動作中：つまむと描画、離すと停止');
    } catch {
      if (session === generation) options.status('カメラ映像は表示していますが、手の認識を読み込めませんでした。描画はタッチ/マウスでできます。');
      return;
    }

    let lastVideoTime = -1, lastInference = -Infinity, lastDebug = -Infinity;
    const loop: FrameRequestCallback = now => {
      if (session !== generation || !running) return;
      frame = requestAnimationFrame(loop);
      if (!landmarker || !video.videoWidth || !video.videoHeight || video.currentTime === lastVideoTime || now - lastInference < 1000 / 30) return;
      lastVideoTime = video.currentTime;
      lastInference = now;
      let points: NormalizedLandmark[] | undefined;
      try { points = landmarker.detectForVideo(video, now).landmarks[0]; }
      catch { endGesture(); return; }
      if (!validHand(points)) { endGesture(); return; }
      const [nx, ny] = coverCoordinates(points[8].x, points[8].y, video.videoWidth, video.videoHeight);
      const x = Math.min(DW - 1, Math.max(0, (1 - fx.filter(nx, now / 1000)) * DW));
      const y = Math.min(DH - 1, Math.max(0, fy.filter(ny, now / 1000) * DH));
      const distance = (a: NormalizedLandmark, b: NormalizedLandmark) => Math.hypot(a.x - b.x, a.y - b.y);
      const ratio = distance(points[4], points[8]) / Math.max(1e-6, distance(points[0], points[9]));
      const on = nextPinchState(pinching, ratio);
      if (now - lastDebug >= 200) { lastDebug = now; options.debug(ratio, on); }
      options.dot(x, y, on);
      if (on && !pinching) { pinching = true; input.begin(x, y); }
      else if (on) input.move(x, y);
      else if (pinching) { pinching = false; input.end(); }
    };
    frame = requestAnimationFrame(loop);
  };

  return {
    get running() { return running; },
    start(): Promise<void> {
      if (starting) return starting;
      if (running) return Promise.resolve();
      const pending = initialize(++generation).finally(() => { if (starting === pending) starting = null; });
      starting = pending;
      return pending;
    },
    stop,
  };
}
