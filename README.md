# Flick

開いた瞬間にメモでき、フリックで状態を動かすタスク管理 Web アプリ。iPhone / Android / PC 対応。

- **開いた瞬間メモ**：メモ欄は HTML に最初から入っていて、読み込みを待たずに入力・追加できる。書きかけも残る
- **フリックで状態管理**：右へ弾くと「未着手 → 進行中 → 完了」、左へ弾くと戻す（未着手で左は削除）。必ず「取り消す」が出る
- **AI で分ける**：走り書きのメモを Workers AI が行動単位のタスクに分ける
- **Google ログインのみ**：ログインすると端末間で同期。ログイン前のメモもログイン後に引き継ぐ
- **Liquid Glass UI**：白ベース、Apple HIG のシステムカラー、浮いたガラスのタブバー
- **全画面スケルトン**：起動中はタイトル・アカウント・一覧・件数をスケルトン表示（メモ欄だけは本物）

## 操作

| 操作 | スマホ | PC |
|---|---|---|
| 追加 | 入力して送信（Enter） | Enter（Shift+Enter で改行） |
| 進める／戻す | 右／左にフリック | ホバーで出る矢印、または ← → キー |
| 完了 | 丸をタップ | 丸をクリック |
| 編集 | タップ | クリック／Enter |
| 削除 | 未着手で左にフリック | ゴミ箱、または Delete キー |

## 技術構成と選定理由

| 層 | 採用 | 理由 |
|---|---|---|
| 実行基盤 | **Cloudflare Workers**（Static Assets 付き） | 画面ファイルと API を 1 つの Worker で配信できる。世界中の拠点から返るので初回表示が速い。無料枠が大きく、サーバー管理が要らない |
| データベース | **Cloudflare D1** | Workers から直接使える SQLite。タスクのような小さな表データに十分で、SQL で同期処理（後勝ちの上書き）を 1 文で書ける |
| AI | **Workers AI**（`@cf/meta/llama-3.3-70b-instruct-fp8-fast`） | 指定どおり。外部 API キーが要らず、Worker のバインディング 1 行で呼べる。JSON スキーマ指定で出力を固定できる。モデル名は `AI_MODEL` 変数で差し替え可能 |
| API | **Hono** | Workers 向けに作られた軽量ルーター（約 14KB）。Cookie・リダイレクトの道具が揃っていて、Express 風に書ける |
| 認証 | **自前の OAuth 2.0（認可コード + PKCE）** | Google だけなので、認証ライブラリや外部認証サービスを足すより短く安全に書ける。セッションは乱数トークンを `HttpOnly; Secure; SameSite=Lax` の `__Host-` Cookie に入れ、DB には SHA-256 だけを保存 |
| 画面 | **素の TypeScript + CSS**（フレームワークなし） | 「開いた瞬間」を最優先。React 等を入れると JS が数十 KB 増えて起動が遅れる。現在 JS は gzip 約 7KB、CSS 約 4KB |
| ビルド | **Vite** | TS の変換と、ファイル名へのハッシュ付与（長期キャッシュ用）のためだけに使用。設定ほぼゼロ |
| アニメーション | **CSS のばね曲線 + Web Animations API** | ライブラリ不要で 60fps。並び替えは FLIP、フリックは指に追従＋速さ判定、`prefers-reduced-motion` で控えめに切り替え |
| 端末内保存 | **localStorage**（ローカルファースト） | 電波がなくても即保存・即表示。変更は「未送信」として持ち、ログイン中なら裏で同期 |
| オフライン起動 | **Service Worker**（外枠だけ保存） | HTML はネット優先で 1.5 秒以内に返らなければ保存分を表示。中身が変わらないハッシュ付きファイルだけを保存するので、古い画面が残り続けない |
| フォント | **システムフォント**（SF Pro / ヒラギノ / Noto） | Apple の見た目に最も近く、Web フォントの読み込み待ちがゼロ |
| テスト | **Playwright** | 実ブラウザで iPhone・Android・PC の 3 環境を再現。タッチのフリックも本物のタッチイベントで再現できる |
| CI/CD | **GitHub Actions** | push ごとに型チェックとブラウザテスト、main への push で Cloudflare へ自動公開 |

## 公開手順（Cloudflare）

1. Cloudflare の D1 を作る
   ```bash
   npx wrangler d1 create flicktask
   ```
   表示された `database_id` を `wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` と差し替える。
2. Google Cloud Console で OAuth クライアント（ウェブアプリケーション）を作る
   - 承認済みのリダイレクト URI：`https://<公開先のドメイン>/auth/google/callback`
3. 秘密情報を登録
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```
4. DB を作って公開
   ```bash
   npm ci
   npm run db:migrate:remote
   npm run deploy
   ```

### GitHub から自動公開する場合

リポジトリの Settings → Secrets and variables → Actions に次を登録すると、`main` への push で自動公開される（`.github/workflows/deploy.yml`）。

- `CLOUDFLARE_API_TOKEN`（権限：Workers Scripts 編集、D1 編集、Workers AI 読み取り）
- `CLOUDFLARE_ACCOUNT_ID`

あわせて Variables に `DEPLOY_ENABLED` = `true` を登録する（未登録の間は公開ジョブを飛ばす）。

## 開発・テスト

```bash
npm ci
npm run typecheck
npx playwright test      # ビルド → ローカル D1 → wrangler dev を自動で起動して 3 環境でテスト
```

- テストは `wrangler.jsonc` の `e2e` 環境で動く。ここでは疑似ログイン（`/auth/dev-login`、`DEV_LOGIN=1` のときだけ存在）を使い、Workers AI はローカルで動かないため外している（AI 部分は区切り文字での簡易分割に切り替わる。本番の AI が落ちたときも同じ）。
- 本番設定には `DEV_LOGIN` を入れないこと。

## 既知の制約

- iPhone の Safari は、ユーザーが画面に触れるまでキーボードを出さない仕様。メモ欄にはフォーカスが当たっているので、1 回タップすれば即入力できる（Android・PC は開いた瞬間に入力できる）。
- ブラウザテストは Chromium で iPhone / Android の画面サイズとタッチを再現している。実機の Safari（WebKit）での確認はまだ。
- Workers AI の実際の応答は、Cloudflare アカウントでの公開後に確認が必要。
