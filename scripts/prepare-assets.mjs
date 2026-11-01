import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// ビルド時もモデルを取得しない。欠損した展示用ビルドを成功扱いにしない。
const root = new URL('../', import.meta.url);
const model = new URL('public/models/hand_landmarker.task', root);
if ((await stat(model)).size < 1_000_000) throw new Error('手認識モデルが欠損しています');
const hash = createHash('sha256').update(await readFile(model)).digest('hex');
const expected = (await readFile(new URL('public/models/hand_landmarker.task.sha256', root), 'utf8')).trim();
if (hash !== expected) throw new Error('手認識モデルのSHA-256が一致しません');
const pkgRoot = new URL('node_modules/@mediapipe/tasks-vision/', root);
const pkg = JSON.parse(await readFile(new URL('package.json', pkgRoot), 'utf8'));
if (pkg.version !== '0.10.33') throw new Error('MediaPipeの固定バージョンが一致しません');
const output = new URL('public/wasm/', root);
await mkdir(output, { recursive: true });
for (const name of ['vision_wasm_internal', 'vision_wasm_nosimd_internal', 'vision_wasm_module_internal']) {
  for (const ext of ['js', 'wasm']) await cp(new URL(`wasm/${name}.${ext}`, pkgRoot), new URL(`${name}.${ext}`, output));
}
console.log(`MediaPipe ${pkg.version}: ローカルWASMを準備、モデルSHA-256 ${hash}`);
