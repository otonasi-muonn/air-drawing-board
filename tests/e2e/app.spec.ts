import { test, expect, chromium, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { decodeDrawing } from '../../src/codec/drawingCodec';
import vectors from '../fixtures/test-vectors-v1.json' with { type: 'json' };

const key = 'airboard.works.v1';
const sample = vectors.validCases[1].encoded;
const reference = readFileSync(new URL('../../reference/index-v2.html', import.meta.url), 'utf8');
const legacyRenderer = reference.slice(reference.indexOf('function renderStroke('), reference.indexOf('function renderBase('));

async function draw(page: Page) {
  await page.locator('#activeCanvas').scrollIntoViewIfNeeded();
  const box = await page.locator('#activeCanvas').boundingBox();
  if (!box) throw new Error('描画Canvasが表示されていません');
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5, { steps: 12 });
  await page.mouse.up();
}

async function ink(page: Page) {
  return page.locator('#drawCanvas').evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] && Math.min(data[i], data[i + 1], data[i + 2]) < 200) count++;
    return count;
  });
}

test('サブパスで起動し、カメラ未起動ではCDNもモデルも読まない', async ({ page }, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', r => requests.push(r.url()));
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./');
  await expect(page.locator('#viewDraw')).toBeVisible();
  await expect(page.locator('#activeCanvas')).toHaveAttribute('width', '960');
  await expect(page.locator('#activeCanvas')).toHaveAttribute('height', '720');
  await draw(page);
  await expect.poll(() => ink(page)).toBeGreaterThan(0);
  expect(requests.every(url => url.startsWith('http://127.0.0.1:4173/air-drawing-board/'))).toBe(true);
  expect(requests.some(url => /wasm|hand_landmarker|cameraInput/.test(url))).toBe(false);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
});

test('描画・キーボード取り消し・全消去', async ({ page }) => {
  await page.goto('./');
  await draw(page);
  expect(await ink(page)).toBeGreaterThan(0);
  await page.keyboard.press('Control+z');
  expect(await ink(page)).toBe(0);
  await draw(page);
  await page.locator('#clearBtn').click();
  expect(await ink(page)).toBe(0);
});

test('タッチ入力も論理Canvasへ描画される', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173/air-drawing-board/');
  await page.locator('#activeCanvas').tap({ position: { x: 50, y: 60 } });
  expect(await ink(page)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
  await context.close();
});

test('空投稿禁止、二重投稿防止、QR前の保存と承認状態', async ({ page }) => {
  page.on('dialog', d => d.dismiss());
  await page.goto('./');
  await page.locator('#postBtn').click({ force: true });
  expect(await page.evaluate(k => localStorage.getItem(k), key)).toBeNull();
  await draw(page);
  await page.locator('#postBtn').evaluate(el => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); });
  await expect(page.locator('#viewDone')).toBeVisible();
  const works = await page.evaluate(k => JSON.parse(localStorage.getItem(k)!), key);
  expect(works).toHaveLength(1);
  expect(works[0].approved).toBe(false);
  expect(works[0].data).toMatch(/^[A-Za-z0-9_-]+$/);
  await expect(page.locator('#qrCanvas')).toHaveAttribute('width', '640');
  await page.locator('#fullBtn').click();
  await expect(page.locator('#fullImg')).toHaveAttribute('src', /^data:image\/png/);
});

test('保存容量不足でも編集中の作品を保持する', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
  });
  page.on('dialog', d => d.dismiss());
  await page.goto('./');
  await draw(page);
  const before = await ink(page);
  await page.locator('#postBtn').click();
  await expect(page.locator('#postBtn')).toBeEnabled();
  await expect(page.locator('#viewDraw')).toBeVisible();
  expect(await ink(page)).toBe(before);
  expect(await page.evaluate(k => localStorage.getItem(k), key)).toBeNull();
});

test('ブラウザが保存領域へのアクセスを拒否しても描画と失敗案内が動く', async ({ page }) => {
  const notices: string[] = [];
  page.on('dialog', async dialog => { notices.push(dialog.message()); await dialog.dismiss(); });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('storage denied', 'SecurityError'); },
    });
  });
  await page.goto('./');
  await draw(page);
  const before = await ink(page);
  expect(before).toBeGreaterThan(0);
  await page.locator('#postBtn').click();
  await expect(page.locator('#postBtn')).toBeEnabled();
  await expect(page.locator('#viewDraw')).toBeVisible();
  expect(await ink(page)).toBe(before);
  expect(notices.some(message => message.includes('保存に失敗'))).toBe(true);
});

test('描画中の線を含む同じ作品を保存しQRへ渡す', async ({ page }) => {
  await page.goto('./');
  await draw(page);
  const box = await page.locator('#activeCanvas').boundingBox();
  if (!box) throw new Error('Canvas missing');
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .4);
  // カメラのピンチ継続中と同様、線が確定する前に完成操作を行う。
  await page.locator('#postBtn').evaluate(el => (el as HTMLButtonElement).click());
  await expect(page.locator('#viewDone')).toBeVisible();
  const works = await page.evaluate(k => JSON.parse(localStorage.getItem(k)!), key);
  expect(await decodeDrawing(works[0].data)).toHaveLength(2);
  await page.mouse.up();
});

test('現行保存JSONを読み承認・非表示・削除・バックアップできる', async ({ page }) => {
  await page.addInitScript(({ key, data }) => {
    localStorage.setItem(key, JSON.stringify([
      { id: 'old-approved', ts: 1, data, approved: true },
      { id: 'old-pending', ts: 2, data, approved: false },
    ]));
  }, { key, data: sample });
  await page.goto('./');
  await page.locator('#tabBoard').click();
  await expect(page.locator('#boardGrid img')).toHaveCount(1);
  await page.locator('#adminBtn').click();
  await expect(page.locator('#boardGrid img')).toHaveCount(2);
  await page.getByRole('button', { name: '承認して表示', exact: true }).click();
  expect(await page.evaluate(k => JSON.parse(localStorage.getItem(k)!).every((w: { approved: boolean }) => w.approved), key)).toBe(true);
  await page.getByRole('button', { name: '非表示にする', exact: true }).first().click();
  const download = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  expect((await download).suggestedFilename()).toBe('airboard-backup.json');
  page.on('dialog', d => d.accept());
  await page.getByRole('button', { name: '完全に削除', exact: true }).first().click();
  expect(await page.evaluate(k => JSON.parse(localStorage.getItem(k)!).length, key)).toBe(1);
});

test('保存作品はページ再読込後にも残る', async ({ page }) => {
  await page.goto('./');
  await draw(page);
  await page.locator('#postBtn').click();
  await expect(page.locator('#viewDone')).toBeVisible();
  const before = await page.evaluate(k => localStorage.getItem(k), key);
  await page.reload();
  expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe(before);
});

test('検証用Chromiumを終了・再起動しても保存作品が残る', async ({}, testInfo) => {
  const profile = testInfo.outputPath('profile');
  let context = await chromium.launchPersistentContext(profile, { headless: true });
  let page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4173/air-drawing-board/');
    await draw(page);
    await page.locator('#postBtn').click();
    await expect(page.locator('#viewDone')).toBeVisible();
    const saved = await page.evaluate(k => localStorage.getItem(k), key);
    expect(JSON.parse(saved!)).toHaveLength(1);
    await context.close();
    context = await chromium.launchPersistentContext(profile, { headless: true });
    page = await context.newPage();
    await page.goto('http://127.0.0.1:4173/air-drawing-board/');
    expect(await page.evaluate(k => localStorage.getItem(k), key)).toBe(saved);
    await page.locator('#tabBoard').click();
    await page.locator('#adminBtn').click();
    await expect(page.locator('#boardGrid img')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('v1の量子化3を復元しPNG画像とダウンロードを表示する', async ({ page }) => {
  await page.goto(`./#d=${vectors.validCases[2].encoded}`);
  await expect(page.locator('#viewRestore')).toBeVisible();
  await expect(page.locator('#restoreImg')).toHaveAttribute('src', /^data:image\/png/);
  await expect(page.locator('#dlLink')).toHaveAttribute('href', /^data:image\/png/);
  expect(await page.locator('#restoreImg').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(960);
  expect(new URL(page.url()).hash).toBe(`#d=${vectors.validCases[2].encoded}`);
});

test('全有効ベクトルのPNGが現行レンダラーとピクセル単位で一致する', async ({ page }) => {
  for (const vector of vectors.validCases) {
    await page.goto(`./#d=${vector.encoded}`);
    await expect(page.locator('#restoreImg')).toHaveAttribute('src', /^data:image\/png/);
    const expected = await page.evaluate(({ source, strokes, palette, widths }) => {
      // リポジトリ内の参照実装だけを評価し、ブラウザ共通条件で描画結果を比較する。
      const render = new Function('DW', 'DH', 'PALETTE', 'WIDTHS', `${source}; return renderAll;`)(960, 720, palette, widths);
      const canvas = document.createElement('canvas');
      canvas.width = 960; canvas.height = 720;
      render(canvas.getContext('2d'), strokes);
      return canvas.toDataURL('image/png');
    }, { source: legacyRenderer, strokes: vector.expectedDecoded, palette: vectors.palette, widths: vectors.widths });
    expect(await page.locator('#restoreImg').getAttribute('src'), vector.name).toBe(expected);
  }
});

test('破損フラグメントを部分表示せずエラーにする', async ({ page }) => {
  await page.goto('./#d=AAAA');
  await expect(page.locator('#restoreErr')).not.toBeEmpty();
  await expect(page.locator('#restoreImg')).not.toHaveAttribute('src', /^data:/);
});

test('空画面90秒で誘引、編集作品を保持、完了120秒で次の人へ', async ({ page }) => {
  await page.clock.install();
  await page.goto('./');
  await page.clock.fastForward(96_000);
  await expect(page.locator('#attract')).toBeVisible();
  await page.locator('#attract').click();
  await draw(page);
  const before = await ink(page);
  await page.clock.fastForward(130_000);
  await expect(page.locator('#attract')).toBeHidden();
  expect(await ink(page)).toBe(before);
  await page.locator('#postBtn').click();
  await expect(page.locator('#viewDone')).toBeVisible();
  await page.clock.fastForward(126_000);
  await expect(page.locator('#viewDraw')).toBeVisible();
  expect(await ink(page)).toBe(0);
});

test('カメラモジュール取得失敗でも描画・投稿・QRが動く', async ({ page }) => {
  await page.route('**/*cameraInput*', route => route.abort());
  await page.goto('./');
  await page.locator('#camBtn').click();
  await expect(page.locator('#camStatus')).not.toBeEmpty();
  await draw(page);
  await page.locator('#postBtn').click();
  await expect(page.locator('#viewDone')).toBeVisible();
  await expect(page.locator('#qrCanvas')).toHaveAttribute('width', '640');
});

test('カメラ遅延読込中の連打と画面離脱後には開始しない', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const requests: string[] = [];
  page.on('request', r => requests.push(r.url()));
  await page.route('**/*cameraInput*', async route => { entered = true; await gate; await route.continue(); });
  try {
    await page.goto('./');
    await page.locator('#camBtn').click();
    await expect.poll(() => entered).toBe(true);
    await page.locator('#camBtn').evaluate(el => (el as HTMLButtonElement).click());
    await page.locator('#tabBoard').click();
    release();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#viewBoard')).toBeVisible();
    expect(await page.locator('#camPreview').evaluate(el => (el as HTMLVideoElement).srcObject)).toBeNull();
    expect(requests.some(url => /\/models\/|\/wasm\//.test(url))).toBe(false);
  } finally {
    release();
  }
});

test('合成カメラで同一オリジンのモデルとWASMを読んで停止できる', async ({ page }) => {
  test.setTimeout(60_000);
  const requests: string[] = [];
  page.on('request', r => requests.push(r.url()));
  await page.goto('./');
  await page.locator('#camBtn').click();
  await expect(page.locator('#camPreview')).toBeVisible();
  await expect(page.locator('#camStatus')).toContainText('カメラ動作中', { timeout: 40_000 });
  expect(requests.some(url => url.includes('/models/hand_landmarker.task'))).toBe(true);
  expect(requests.some(url => url.includes('/wasm/') && url.includes('.wasm'))).toBe(true);
  expect(requests.every(url => url.startsWith('http://127.0.0.1:4173/air-drawing-board/'))).toBe(true);
  await page.locator('#camBtn').click();
  await expect(page.locator('#camPreview')).toBeHidden();
  expect(await page.locator('#camPreview').evaluate(el => {
    const stream = (el as HTMLVideoElement).srcObject as MediaStream | null;
    return !stream || stream.getTracks().every(track => track.readyState === 'ended');
  })).toBe(true);
});

test('モデル取得失敗を映像取得失敗と区別し本体を維持する', async ({ page }) => {
  await page.route('**/models/hand_landmarker.task', route => route.abort());
  await page.goto('./');
  await page.locator('#camBtn').click();
  await expect(page.locator('#camPreview')).toBeVisible();
  await expect(page.locator('#camStatus')).toContainText('認識を読み込めませんでした', { timeout: 30_000 });
  await draw(page);
  expect(await ink(page)).toBeGreaterThan(0);
  await page.locator('#camBtn').click();
});
