/** v1の固定契約。変更時は保存データとQRの互換性を確認すること。 */
export const DW = 960;
export const DH = 720;
export const PALETTE = ['#000000', '#D55E00', '#E69F00', '#009E73', '#56B4E9', '#0072B2', '#CC79A7', '#EAB505'] as const;
export const WIDTHS = [4, 9, 16] as const;
export type Point = [number, number];
export interface Stroke { c: number; w: number; pts: Point[] }
export interface Work { id: string; ts: number; data: string; approved: boolean }
/** 入力層だけで座標変換を済ませ、正像の論理座標を渡す。 */
export interface DrawingInput {
  begin(x: number, y: number): void;
  move(x: number, y: number): void;
  end(): void;
}
export interface CameraOptions {
  video: HTMLVideoElement;
  input: DrawingInput;
  status(message: string): void;
  dot(x: number, y: number, on: boolean): void;
  dotOff(): void;
  debug(ratio: number, on: boolean): void;
}
export interface CameraController {
  start(): Promise<void>;
  stop(): void;
  readonly running: boolean;
}
