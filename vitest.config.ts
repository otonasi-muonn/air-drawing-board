import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: [{ find: /^@mediapipe\/tasks-vision$/, replacement: fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', import.meta.url)) }] },
  test: { include: ['src/**/*.test.ts'] },
});
