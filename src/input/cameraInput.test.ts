import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraOptions } from '../domain/drawing';
import { coverCoordinates, createCameraInput, nextPinchState } from './cameraInput';

const vision = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn() }));
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vision.resolve },
  HandLandmarker: { createFromOptions: vision.create },
}));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const hand = (ratio: number, x = 0.5, y = 0.5) => {
  const points = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  points[0] = { x: 0, y: 0, z: 0 };
  points[9] = { x: 1, y: 0, z: 0 };
  points[4] = { x: x + ratio, y, z: 0 };
  return { landmarks: [points] };
};

describe('camera geometry and hysteresis', () => {
  it('covers landscape and portrait images without applying a mirror', () => {
    expect(coverCoordinates(0.5, 0.5, 1280, 720)).toEqual([0.5, 0.5]);
    expect(coverCoordinates(0.125, 0, 1280, 720)).toEqual([0, 0]);
    expect(coverCoordinates(0.875, 1, 1280, 720)).toEqual([1, 1]);
    expect(coverCoordinates(0, 0.125, 720, 720)).toEqual([0, 0]);
    expect(coverCoordinates(1, 0.875, 720, 720)).toEqual([1, 1]);
  });
  it('uses strict ON < .38 and OFF >= .55 hysteresis', () => {
    expect(nextPinchState(false, 0.379)).toBe(true);
    expect(nextPinchState(false, 0.38)).toBe(false);
    expect(nextPinchState(true, 0.54)).toBe(true);
    expect(nextPinchState(true, 0.55)).toBe(false);
    expect(nextPinchState(false, 0.5)).toBe(false);
  });
});

describe('camera lifecycle and input', () => {
  let options: CameraOptions;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let trackStop: ReturnType<typeof vi.fn>;
  let detector: { close: ReturnType<typeof vi.fn>; detectForVideo: ReturnType<typeof vi.fn> };
  let callbacks: Map<number, FrameRequestCallback>;
  let frameId: number;
  let page: EventTarget;
  const tick = async (now: number) => {
    options.video.currentTime += 1 / 60;
    const scheduled = [...callbacks.values()];
    callbacks.clear();
    scheduled.forEach(callback => callback(now));
    await Promise.resolve();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = new Map(); frameId = 0; page = new EventTarget();
    trackStop = vi.fn();
    getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });
    detector = { close: vi.fn(), detectForVideo: vi.fn().mockReturnValue(hand(0.3)) };
    vision.resolve.mockResolvedValue({}); vision.create.mockResolvedValue(detector);
    options = {
      video: { srcObject: null, style: { display: 'none' }, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), videoWidth: 1280, videoHeight: 720, currentTime: 0 } as unknown as HTMLVideoElement,
      input: { begin: vi.fn(), move: vi.fn(), end: vi.fn() },
      status: vi.fn(), dot: vi.fn(), dotOff: vi.fn(), debug: vi.fn(),
    };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('window', page);
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { callbacks.set(++frameId, callback); return frameId; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates without effects, requests audio:false once, plays preview before loading the local model', async () => {
    const order: string[] = [];
    getUserMedia.mockImplementation(async () => { order.push('permission'); return { getTracks: () => [{ stop: trackStop }] }; });
    vi.mocked(options.video.play).mockImplementation(async () => { order.push('preview'); });
    vision.resolve.mockImplementation(async () => { order.push('model'); return {}; });
    const controller = createCameraInput(options);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(vision.resolve).not.toHaveBeenCalled();
    expect(controller.running).toBe(false);
    await Promise.all([controller.start(), controller.start()]);
    expect(order).toEqual(['permission', 'preview', 'model']);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: { width: 1280, height: 720 }, audio: false });
    expect(controller.running).toBe(true);
    expect(vision.resolve).toHaveBeenCalledWith(`${import.meta.env.BASE_URL}wasm`);
    expect(vision.create).toHaveBeenCalledWith({}, expect.objectContaining({ baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`, delegate: 'GPU' }, numHands: 1, runningMode: 'VIDEO' }));
    controller.stop();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(detector.close).toHaveBeenCalledOnce();
    expect(options.video.srcObject).toBeNull();
    expect(controller.running).toBe(false);
    expect(callbacks.size).toBe(0);
  });
  it('falls back from GPU to CPU', async () => {
    vision.create.mockRejectedValueOnce(new Error('GPU')).mockResolvedValueOnce(detector);
    const controller = createCameraInput(options);
    await controller.start();
    expect(vision.create.mock.calls.map(call => call[1].baseOptions.delegate)).toEqual(['GPU', 'CPU']);
    controller.stop();
  });
  it('retains preview and drawing input when the model fails', async () => {
    vision.resolve.mockRejectedValueOnce(new Error('network'));
    const controller = createCameraInput(options);
    await controller.start();
    expect(controller.running).toBe(true);
    expect(trackStop).not.toHaveBeenCalled();
    expect(options.video.srcObject).not.toBeNull();
    expect(options.status).toHaveBeenLastCalledWith(expect.stringContaining('手の認識'));
    expect(options.input.begin).not.toHaveBeenCalled();
    controller.stop();
  });
  it('retains preview when both GPU and CPU model creation fail', async () => {
    vision.create.mockRejectedValue(new Error('model'));
    const controller = createCameraInput(options);
    await controller.start();
    expect(vision.create).toHaveBeenCalledTimes(2);
    expect(controller.running).toBe(true);
    expect(trackStop).not.toHaveBeenCalled();
    controller.stop();
  });
  it.each([
    ['NotAllowedError', '許可'], ['NotFoundError', '見つかり'], ['OverconstrainedError', '見つかり'],
    ['NotReadableError', '他のアプリ'], ['SecurityError', 'HTTPS'], ['Error', '使えません'],
  ])('explains %s and does not load the model', async (name, message) => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error(), { name }));
    const controller = createCameraInput(options);
    await controller.start();
    expect(controller.running).toBe(false);
    expect(options.status).toHaveBeenLastCalledWith(expect.stringContaining(message));
    expect(vision.resolve).not.toHaveBeenCalled();
  });
  it('explains insecure origins without requesting permission', async () => {
    vi.stubGlobal('isSecureContext', false);
    await createCameraInput(options).start();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(options.status).toHaveBeenLastCalledWith(expect.stringContaining('HTTPS'));
  });
  it('explains unavailable media APIs without throwing', async () => {
    vi.stubGlobal('navigator', {});
    await expect(createCameraInput(options).start()).resolves.toBeUndefined();
    expect(options.status).toHaveBeenLastCalledWith(expect.stringContaining('HTTPS'));
  });
  it('stops a stream which arrives after stop, without starting preview or loading a model', async () => {
    const permission = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(permission.promise);
    const controller = createCameraInput(options);
    const starting = controller.start();
    controller.stop();
    permission.resolve({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    await starting;
    expect(trackStop).toHaveBeenCalledOnce();
    expect(options.video.play).not.toHaveBeenCalled();
    expect(vision.resolve).not.toHaveBeenCalled();
    expect(controller.running).toBe(false);
  });
  it('closes a model that arrives after leaving and preserves stopped state', async () => {
    const model = deferred<typeof detector>();
    vision.create.mockReturnValueOnce(model.promise);
    const controller = createCameraInput(options);
    const starting = controller.start();
    await vi.waitFor(() => expect(vision.create).toHaveBeenCalledOnce());
    page.dispatchEvent(new Event('pagehide'));
    model.resolve(detector);
    await starting;
    expect(detector.close).toHaveBeenCalledOnce();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(controller.running).toBe(false);
    expect(callbacks.size).toBe(0);
  });
  it('stops while play is pending and never loads a model for that session', async () => {
    const playing = deferred<void>();
    vi.mocked(options.video.play).mockReturnValueOnce(playing.promise);
    const controller = createCameraInput(options);
    const starting = controller.start();
    await vi.waitFor(() => expect(options.video.play).toHaveBeenCalledOnce());
    controller.stop();
    expect(trackStop).toHaveBeenCalledOnce();
    playing.resolve();
    await starting;
    expect(vision.resolve).not.toHaveBeenCalled();
    expect(controller.running).toBe(false);
  });
  it('does not start CPU fallback after a stopped GPU request rejects', async () => {
    const gpu = deferred<typeof detector>();
    vision.create.mockReturnValueOnce(gpu.promise);
    const controller = createCameraInput(options);
    const starting = controller.start();
    await vi.waitFor(() => expect(vision.create).toHaveBeenCalledOnce());
    controller.stop();
    gpu.reject(new Error('GPU'));
    await starting;
    expect(vision.create).toHaveBeenCalledOnce();
    expect(controller.running).toBe(false);
  });
  it('closes late CPU models without overwriting the restarted session', async () => {
    const cpu = deferred<typeof detector>();
    const lateDetector = { close: vi.fn(), detectForVideo: vi.fn() };
    vision.create.mockRejectedValueOnce(new Error('GPU')).mockReturnValueOnce(cpu.promise);
    const controller = createCameraInput(options);
    const first = controller.start();
    await vi.waitFor(() => expect(vision.create).toHaveBeenCalledTimes(2));
    controller.stop();
    await controller.start();
    cpu.resolve(lateDetector);
    await first;
    expect(lateDetector.close).toHaveBeenCalledOnce();
    expect(detector.close).not.toHaveBeenCalled();
    expect(controller.running).toBe(true);
    await tick(100);
    expect(detector.detectForVideo).toHaveBeenCalledOnce();
    controller.stop();
    controller.stop();
    expect(detector.close).toHaveBeenCalledOnce();
  });
  it('does not let a stale start overwrite a restarted camera', async () => {
    const oldStream = deferred<MediaStream>();
    const oldStop = vi.fn();
    getUserMedia.mockReturnValueOnce(oldStream.promise);
    const controller = createCameraInput(options);
    const first = controller.start();
    controller.stop();
    await controller.start();
    const currentStream = options.video.srcObject;
    oldStream.resolve({ getTracks: () => [{ stop: oldStop }] } as unknown as MediaStream);
    await first;
    expect(oldStop).toHaveBeenCalledOnce();
    expect(options.video.srcObject).toBe(currentStream);
    expect(controller.running).toBe(true);
    expect(trackStop).not.toHaveBeenCalled();
    controller.stop();
  });
  it('mirrors finger 8 exactly once, uses hysteresis and resets filters when a hand is lost', async () => {
    detector.detectForVideo.mockReturnValueOnce(hand(0.2, 0.125, 0)).mockReturnValueOnce(hand(0.5))
      .mockReturnValueOnce(hand(0.55)).mockReturnValueOnce(hand(0.5))
      .mockReturnValueOnce(hand(0.2)).mockReturnValueOnce({ landmarks: [] })
      .mockReturnValueOnce(hand(0.2, 0.875, 1));
    const controller = createCameraInput(options);
    await controller.start();
    await tick(100);
    expect(options.input.begin).toHaveBeenLastCalledWith(959, 0);
    await tick(140);
    expect(options.input.move).toHaveBeenCalledOnce();
    await tick(180);
    expect(options.input.end).toHaveBeenCalledOnce();
    await tick(220);
    expect(options.input.begin).toHaveBeenCalledOnce();
    await tick(260); await tick(300);
    expect(options.input.end).toHaveBeenCalledTimes(2);
    expect(options.dotOff).toHaveBeenCalled();
    await tick(340);
    expect(options.input.begin).toHaveBeenLastCalledWith(0, 719);
    controller.stop();
  });
  it('limits inference to 30fps and skips unchanged video frames', async () => {
    const controller = createCameraInput(options);
    await controller.start();
    for (let now = 0; now <= 1000; now += 1000 / 60) await tick(now);
    expect(detector.detectForVideo.mock.calls.length).toBeLessThanOrEqual(31);
    const current = [...callbacks.values()]; callbacks.clear();
    current.forEach(callback => callback(2000));
    const count = detector.detectForVideo.mock.calls.length;
    const unchanged = [...callbacks.values()]; callbacks.clear();
    unchanged.forEach(callback => callback(2040));
    expect(detector.detectForVideo).toHaveBeenCalledTimes(count);
    controller.stop();
  });
  it('ends an active stroke and resets after inference errors or malformed landmarks', async () => {
    detector.detectForVideo.mockReturnValueOnce(hand(0.2)).mockImplementationOnce(() => { throw new Error('inference'); })
      .mockReturnValueOnce(hand(0.2, 0.875, 1)).mockReturnValueOnce({ landmarks: [[{ x: NaN, y: 0 }]] });
    const controller = createCameraInput(options);
    await controller.start();
    await tick(100); await tick(140);
    expect(options.input.end).toHaveBeenCalledOnce();
    await tick(180);
    expect(options.input.begin).toHaveBeenLastCalledWith(0, 719);
    await tick(220);
    expect(options.input.end).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
