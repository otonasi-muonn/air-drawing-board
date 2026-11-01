import './styles.css';
import { decodeDrawing, encodeDrawing } from './codec/drawingCodec';
import { mountApp } from './ui/appController';

mountApp({
  encodeDrawing,
  decodeDrawing,
  loadCameraModule: () => import('./input/cameraInput'),
});
