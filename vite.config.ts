import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: '/air-drawing-board/',
  // 0.10.33はexportsに条件とサブパスが混在するため実体へ解決する。
  resolve: { alias: [{ find: /^@mediapipe\/tasks-vision$/, replacement: fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url)) }] },
});
