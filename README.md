# 空中お絵描き掲示板（モジュール分割版）

現行の単一HTML版をVite + TypeScript・通常のDOMへ分割する開発ブランチです。公開リポジトリは `otonasi-muonn/air-drawing-board`、展示とスマホの正規URLは https://otonasi-muonn.github.io/air-drawing-board/ です。展示切替条件を満たすまで、mainと公開サイトは現行版を維持します。

## 開発と検証

Node.js 22.12以降（検証環境22.21）を使います。

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

開発・previewのパスも `/air-drawing-board/` です。`npm run preview` は本番ビルドをHTTPで検査する開発用経路です。展示・QR・カメラの実機確認は必ずPages URLで行います。HTMLを直接開く運用はしません。

ビルドは `dist/` を出力します。`scripts/prepare-assets.mjs` が固定版MediaPipe 0.10.33のWASM/ローダーをnpm依存からコピーし、同梱モデルのSHA-256を検査します。モデルがない・改変されている場合はビルドを失敗させます。ビルド時・実行時のモデル取得をCDNへフォールバックしません。依存インストールと初回のPages読込にはネットワークが必要です。Service Workerは導入していません。

MediaPipe 0.10.33のpackage.jsonには条件付きexportsとサブパスの混在があり、Nodeが通常解決できないため、Vite/Vitestでは同じパッケージ内の `vision_bundle.mjs` へ名前を厳密一致で解決し、型検査は同梱 `vision.d.ts` を参照します。npmパッケージ自体は書き換えていません。

## モジュールと契約

| ファイル | 責務 |
| --- | --- |
| `index.html`, `src/main.ts` | DOMの骨格、起動と依存の結線 |
| `src/domain/drawing.ts` | 960×720、現行8色、線幅4/9/16、Stroke/Workと入力契約 |
| `src/codec/drawingCodec.ts` | v1の間引き・量子化・差分・deflate・base64urlと完全検証 |
| `src/render/canvasRenderer.ts` | 確定層・描画中層・PNGで共通のCanvas描画 |
| `src/input/pointerInput.ts` | マウス/タッチ/ペン、coalesced events、座標変換 |
| `src/input/cameraInput.ts`, `oneEuroFilter.ts` | 明示開始、映像取得後の遅延モデル読込、追跡・平滑化・終了処理 |
| `src/storage/workStore.ts` | 差替可能な保存インターフェースとlocalStorage実装 |
| `src/services/qrService.ts` | M/640pxのQR、容量超過のみ一度簡略化再試行、失敗理由の区別 |
| `src/ui/` | 画面状態、編集・投稿・運営操作・復元と無操作タイマー |
| `tests/fixtures/test-vectors-v1.json` | 参照資料から無変更で取り込んだ互換性データ |
| `tests/e2e/` | 本番ビルドのブラウザ回帰検査。合成カメラは実機確認に含めない |

`#d=` は描画データ専用で、画面遷移は内部状態で管理します。QRは現在のURLからフラグメントだけ除いて作ります。localStorageキーは `airboard.works.v1`、作品形は `{ id, ts, data, approved }` を維持します。掲示板は端末・ブラウザ内の保存で、端末間同期はありません。運営モードは展示PCでの操作切替で、認証機能ではありません。

カメラプレビューは鏡像です。カメラ入力層で一度だけ座標を反転し、保存・PNG・掲示板・QRには同じ正像座標を渡します。映像/音声の保存・アップロードは行いません。取得要求は映像のみです。

## 現行版との振る舞い差分

| 項目 | 意図した差分・理由 |
| --- | --- |
| ビルド/依存 | 単一HTML/CDNから、Vite・固定npm依存・同一オリジンのWASM/モデルへ移行 |
| 入力検証 | 破損データの末尾余剰や非正規表現を拒否し、途中作品を返さない。正規のv1出力は維持 |
| QR失敗 | ライブラリ・描画処理の失敗を容量超過と分離。容量超過のみ間引き7・量子化3で一度再試行 |
| カメラの終了 | 画面離脱/停止/非同期読込中の停止で線とリソースを終了し、掲示板等への誤入力を防ぐ |
| 無操作 | ポインタ・キーボード・カメラの描画操作を活動として扱い、編集中の作品を保持 |
| 同時タッチ | 別の指によるpointerdownで描画中の線を上書きしないよう、入力中のポインタを保持 |
| 保存領域の拒否 | localStorageへのアクセス自体が拒否されても描画を起動し、投稿時に保存失敗を案内 |
| 投稿の確定 | カメラ等で描画中の線も確定し、保存・QR再試行・写真用PNGへ同じ作品を渡す |
| 復元の競合 | 連続して別のフラグメントを開いた場合、最新のURLに対応する作品だけを表示 |

描画形式v2、クラウド保存、認証、SNS共有等は追加していません。未検証の環境差分は次項の切替条件として残します。

## 展示切替条件と検証記録

現時点で新版への切替は不可です。ローカル自動検査の結果と、Pages・実機検証は別に記録します。以下をすべて満たすまでmainへ統合しません。

| 確認 | 状態・残リスク |
| --- | --- |
| Gate 0 | 参照3資料配置、現行HTMLとreferenceのSHA-256一致、型/API/担当境界固定、fixture取込済み |
| Gate 1 | 有効4件の厳密復号・同条件往復、不正3件拒否を確認。追加境界検査も実施 |
| Gate 2 | 描画/タッチ模擬/取り消し/消去/投稿/承認/非表示/削除/バックアップ/PNG復元をブラウザ検査。QR容量超過の一度だけの再試行と一般エラー分離は単体検査 |
| Gate 3 | カメラモジュール取得失敗でも本体動作、モデル失敗でもプレビュー維持、合成カメラで同一オリジンの実モデル/WASM読込・停止を検査。GPU→CPU・30fps・手消失・ピンチ/平滑化は単体検査。実機追跡は未検証 |
| Gate 4 | Windows/Node 22.21でtypecheck成功、単体131件成功、本番build成功、Chromium E2E18件成功。サブパスのJS/CSS/モデル/WASMと外部CDN要求なしを検査 |
| Windows + Chromeで本番新版の起動・描画 | 未実施。新版は未公開。本番固有のパス・権限・キャッシュを要確認 |
| iPhone/Android各1台で同じQRを展示距離から3回連続読取 | 未実施。本セッションでは対象の実機を操作していない。密度・画面反射・距離による読み取りとPNG保存を要確認 |
| 実カメラのピンチ開始/終了と手消失時の線切断 | 未実施。合成映像・ランドマークの検査は会場の照明/距離/追跡精度を保証しない |
| ブラウザ再起動後の保存 | 検証用Chromiumの永続プロファイルで実際の終了・再起動後の保持を確認。展示PCのChromeと本番URLでは未実施のため、その保存設定を要確認 |
| Pages再デプロイと公開URL確認 | 未実施。main統合/リモート書込は行っていない |

全実機条件を満たした後の統合では、Actionsが型検査・単体テスト・ビルドを通し、`dist/` だけをPagesへ配信します。開発ブランチの手動実行/PRからはデプロイしません。デプロイ成功と公開URLでの確認が終わるまで切替完了とは扱いません。

2026-11-02の自動検証では有効4ベクトルのPNGが参照レンダラーと完全一致しました。カメラ開始競合・投稿snapshot・復元逆順完了・保存領域拒否の回帰検査も成功し、自動検証範囲で未解消の意図しない差分はありません。未実施の実機条件を自動検証の成功で代替しません。GitHub Actions上の実行は未実施です。

## 参照資料と同梱モデル

`reference/index-v2.html` と `reference/README-v2.md` は動く仕様書として保存し、変更しません。テストベクトルも原本を変更しません。

モデルは[公式Hand Landmarker配布](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task)のfloat16/1を同梱します。SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`。更新時はモデルとハッシュを一緒にレビューします。[公式ガイド](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js)と[モデルカード](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf)を参照してください。

MediaPipeおよび手認識モデルのApache 2.0ライセンスと、qrcodeのMITライセンスは `public/licenses/` に同梱します。[qrcode API](https://github.com/soldair/node-qrcode)、[Viteのbase設定](https://vite.dev/config/shared-options.html#base)も参照しています。Neldaのコードは使用していません。
