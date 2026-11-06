# cafe ハッピーロード 予約管理システム

cafe ハッピーロードの予約を受け付けて管理するWebアプリです。

- **お客様向けの予約ページ**（`/`）… 年配の方にも使いやすいよう、文字を大きく、1画面に1つの質問だけにしています
- **スタッフ用の管理画面**（`/admin`）… 予約台帳・メニュー・お客様・お知らせ・設定

**Cloudflare の無料プランで、費用0円で公開できます。** お店の方もお客様も、スマホやタブレットだけで使えます。
同じプログラムを、自分のパソコンや借りたサーバー（Node.js）で動かすこともできます。

---

## お客様ができること

| やりたいこと | 予約ページでできること |
| --- | --- |
| 予約が取れるか知りたい | 人数を選ぶと、カレンダーに **◯（空きあり）△（残りわずか）×（満席）休（お休み）** が出ます |
| 空いている時間を知りたい | 日にちを押すと、時間ごとに「◯ 空きあり」「× 満席」が出ます |
| 希望の席が空いているか | 「窓際」「テラス」「ソファ」など席の種類を選ぶと、その席の空きだけを表示します |
| 定休日・臨時休業を知りたい | カレンダーに「休」と出ます。「お店の情報」に臨時のお休みの一覧があります |
| メニューを見たい | 写真つきのメニュー。曜日を押すと、その曜日のメニュー（土日限定など）が出ます |
| 先にメニューを選びたい | 予約の途中で、数を「＋」「－」で選べます（選ばなくても予約できます） |
| 予約できないとき | どの画面にも「電話する」ボタンがあります（7名以上の予約もお電話で） |
| 予約を確かめたい・キャンセルしたい | 予約番号（6文字）と電話番号で確認・キャンセルできます |
| お知らせを受け取りたい | 予約のときに「メールで受け取る」を選ぶか、LINEで予約番号を送ると登録されます |

予約の流れ：**人数 → 日にち → 時間（と席の希望） → メニュー（任意） → お名前・電話番号 → 確認**

## スタッフができること

**予約台帳**
- 1日の予約を「タイムライン（テーブル×時間）」と「リスト」で表示。だれが何時に何名で来るか、席の希望・メニュー・メモも見られます
- **30分ごとにお店にいる人数**を表示。上限に近いと黄色、こえると赤
- **同じテーブルで時間が重なる予約**は登録できません（どなたの予約と重なるかを表示）。ほぼ同時に予約が来ても二重にはなりません
- **この日の予約メニューの合計**（仕込みの目安）
- 電話や来店の予約を追加。タイムラインの空いている所を押すと、そのテーブルと時間で追加できます
- 「来店」ボタン、予約の変更・キャンセル・削除、名前・電話番号・予約番号での検索

**メニュー** … 写真つきで追加・変更・削除（スマホで撮った写真を自動で小さくし、位置情報も消します）。値段・分類・説明・**出している曜日**・予約で選べるか・表示するかを設定。「↑」「↓」で並び順を変更

**お客様** … 電話番号ごとに、予約の回数・次回・前回・連絡先をまとめて表示。チェックを付けた方にだけお知らせを送れます

**お知らせ** … **お知らせを希望している方全員**、または**選んだ方だけ**に、メール・LINEで送れます。予約ページの「お知らせ」欄にも載せられます

**設定** … 店名・電話・住所・営業時間・予約の間隔・利用時間・1組の最大人数・**同じ時間の最大人数**・受付期間・定休日・臨時休業日・テーブル（席の種類・席数）・パスワードの変更・操作の記録・バックアップ

## セキュリティ

- 管理画面のパスワードは **PBKDF2 でハッシュ化**し、さらにサーバーだけが知る秘密の文字列（ペッパー）を混ぜて保存します。データベースだけが漏れても、パスワードはわかりません
- ログインは12時間で自動的に切れます。パスワードを変えると、ほかの端末はすべてログアウトします
- 5回まちがえると15分ロック
- ログインの Cookie は `HttpOnly`・`SameSite=Strict`・HTTPS では `Secure`。ほかのサイトからの送信は断ります
- 予約の送信・予約の確認・写真のアップロードは、同じ相手からの回数を制限（いたずら・総当たり対策）。機械による送信を見分ける仕組みも入っています
- すべての入力をサーバーで確認し、画面には文字として表示するので、HTML や JavaScript を埋め込まれません
- 写真は中身を確かめて JPEG・PNG・WebP だけを受け付けます
- Content-Security-Policy などのセキュリティヘッダー、HTTPS では HSTS
- ログイン・予約の変更・設定の変更・お知らせの送信などを「操作の記録」に残します
- お客様の連絡先は、管理画面にログインしたスタッフだけが見られます。お知らせのメールやLINEは1人ずつ送るので、ほかの方の宛先は見えません
- **GitHub にはプログラムだけが入り、お店やお客様のデータは入りません**

---

## 無料で公開する（Cloudflare）

### 費用と無料の範囲

Cloudflare の **Workers 無料プラン** と **D1（データベース）** を使います。クレジットカードの登録は不要で、上限をこえても請求はされません（その日の受付が止まるだけです）。

| 項目 | 無料の範囲 | お店の使い方の目安 |
| --- | --- | --- |
| アクセス | 1日 10万回 | 1組の予約で 20〜30回ほど |
| データベース | 5GB | 予約10万件でも数十MB |

アドレスは `https://cafe-happyroad.（自分で決める名前）.workers.dev` になります。

### お店の方がすること（スマホでできます）

1. **Cloudflare のアカウントを作る**：https://dash.cloudflare.com/sign-up でメールアドレスとパスワードを登録（無料）
2. **「Workers & Pages」を一度開く**：はじめての時は、`workers.dev` の前に付ける名前（例：`happyroad-cafe`）を決める画面が出ます
3. **作業用の鍵（API トークン）を作る**
   1. 右上の人のマーク →「プロフィール（My Profile）」→「API トークン（API Tokens）」→「トークンを作成する（Create Token）」
   2. テンプレート「**Cloudflare Workers を編集する（Edit Cloudflare Workers）**」の「テンプレートを使用する（Use template）」
   3. 「権限（Permissions）」に1行追加して「**アカウント（Account）**」「**D1**」「**編集（Edit）**」を選ぶ
   4. 「アカウント リソース（Account Resources）」で自分のアカウントを選ぶ →「概要に進む（Continue to summary）」→「トークンを作成する（Create Token）」
   5. 表示された長い文字列が鍵です。**チャットには貼らず**、作業をする人（Claude）が出す専用の入力欄に入れてください
   （画面の言葉は、英語の場合と日本語の場合があります）
4. 管理画面の最初のパスワードを決めて、作業をする人に伝える（10文字以上。あとで管理画面から変えられます）

### 公開の作業（作業をする人向け）

```bash
npm install
export CLOUDFLARE_API_TOKEN=…            # 上で作ったトークン
npx wrangler d1 create happyroad          # 表示された database_id を wrangler.toml に書く
npx wrangler secret put ADMIN_PASSWORD    # 最初の管理画面パスワード
npx wrangler secret put PASSWORD_PEPPER   # 長いランダムな文字列（例：openssl rand -hex 32）。一度決めたら変えない
npx wrangler deploy
```

データベースのテーブルは、最初にアクセスがあったときに自動で作られます。

**更新するとき**：`npx wrangler deploy` をもう一度実行するだけです（データはそのまま残ります）。

**パスワードを忘れたら**：

```bash
npx wrangler d1 execute happyroad --remote --command "DELETE FROM secrets WHERE key = 'adminPasswordHash'; DELETE FROM sessions;"
npx wrangler secret put ADMIN_PASSWORD    # 新しいパスワード。次のアクセスで登録されます
```

**バックアップ**：管理画面の「設定」→「データのバックアップを保存」で、写真以外の全データを JSON で保存できます。Cloudflare の D1 には、数日前までの状態に戻せる機能（Time Travel）もあります。

---

## 自分のパソコン・サーバーで動かす（Node.js）

Node.js **22.13 以上** が必要です。

### 試してみる（見本のデータ入り）

```bash
git clone https://github.com/shinnosuke06/cafe-happyroad-reservation.git
cd cafe-happyroad-reservation
npm run demo
```

- 予約ページ：http://localhost:3000/
- 管理画面：http://localhost:3000/admin （パスワード `happyroad-demo`）

見本のメニュー・予約・お知らせが入った状態で起動します（`data/demo` に作るので、本番のデータには触れません）。メニューの写真は見本のイラストです。

### お店で使う

```bash
ADMIN_PASSWORD='長くて推測されにくいパスワード' NODE_ENV=production npm start
```

- `ADMIN_PASSWORD` は**最初の起動のときだけ**使い、ハッシュにして保存します。そのあとは管理画面の「設定」から変えてください
- パスワードを忘れたら、サーバーで `npm run reset-password -- 新しいパスワード`
- データ（予約・お客様・メニュー・写真・設定）は `data/happyroad.db`、ペッパーは `data/pepper.txt` に入ります。`data/` は Git に入りません
- 必ず **HTTPS** で公開してください（nginx や Caddy を前に置き、`TRUST_PROXY=1`）

| 環境変数 | 内容 | 初期値 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 最初の管理画面パスワード（10文字以上） | 本番では必須 |
| `NODE_ENV` | `production` にすると、パスワードが弱いと起動しません | |
| `PORT` / `HOST` | 待ち受けるポート・アドレス | `3000` / `0.0.0.0` |
| `DB_PATH` | データベースファイル | `data/happyroad.db` |
| `PASSWORD_PEPPER` | ペッパー（なければ `data/pepper.txt` を自動で作る） | |
| `PUBLIC_URL` | 公開しているURL。確認メールと配信停止リンクに使います | |
| `TRUST_PROXY` | nginx などの後ろで動かすときは `1` | |
| `STORE_TIMEZONE` | お店のタイムゾーン | `Asia/Tokyo` |

---

## お知らせの送信設定（メール・LINE）

Cloudflare では `npx wrangler secret put 名前`、Node では環境変数で設定します。

**メール（SMTP）** … Gmail やお使いのメールサービスの送信サーバーを使います。

| 名前 | 例 |
| --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465`（SSL）または `587`（STARTTLS） |
| `SMTP_USER` | `shop@example.com` |
| `SMTP_PASS` | アプリ パスワード（Gmail は2段階認証をオンにして「アプリ パスワード」を作ります） |
| `MAIL_FROM` | `cafe ハッピーロード <shop@example.com>` |

設定すると、予約したお客様（メールアドレスを入れた方）に**予約確認メール**も届きます。Gmail の無料アカウントは1日に送れる数に上限があります（目安は数百通）。

**LINE** … LINE公式アカウント（無料プランあり）と Messaging API を使います。

1. [LINE Developers](https://developers.line.biz/) で Messaging API のチャネルを作る
2. 「チャネルアクセストークン」と「チャネルシークレット」を `LINE_CHANNEL_ACCESS_TOKEN`・`LINE_CHANNEL_SECRET` に入れる
3. Webhook URL に `https://（お店のアドレス）/api/line/webhook` を登録して「Webhookの利用」をオン
4. 管理画面の「設定」に、友だち追加URL（`https://lin.ee/…`）を入れる

お客様が友だち追加をして**予約番号を送ると**、そのお客様とLINEがつながり、お知らせが届くようになります。LINE公式アカウントの無料プランには、毎月送れるメッセージ数の上限があります。

> メールのお知らせは、ご本人が「受け取る」を選んだ方だけに送ります（特定電子メール法に沿って、配信停止のリンクも付けます）。
> 「選んだ方だけ」に送るのは、予約の変更や臨時休業のご連絡など、予約に関わる連絡に使ってください。

---

## 開発

```bash
npm install         # Cloudflare 用の道具（wrangler）が入ります
npm test            # テスト（予約のルール・API・セキュリティ・メール・LINE）
npm run dev         # Node で起動（ファイルを変えると自動で再起動）
npx wrangler dev    # Cloudflare と同じしくみで手元で起動（.dev.vars に ADMIN_PASSWORD と PASSWORD_PEPPER を書く）
```

```
server.js              Node で動かすときの入り口（ページの配信も）
wrangler.toml          Cloudflare の設定
scripts/
  demo.js              見本のデータで起動
  reset-password.js    パスワードの再設定（Node）
src/
  worker.js            Cloudflare で動かすときの入り口
  app.js               API の本体（Web 標準の Request / Response。どちらの入り口からも使う）
  store.js             予約のルール（空き・カレンダー・席・人数の上限・テーブルの割り当て）
  content.js           メニュー・写真・お知らせ（予約ページへの掲載）
  customers.js         お客様の連絡先、メール・LINEのお知らせ送信
  notify.js            メール（SMTP）と LINE の送信
  auth.js              パスワード（PBKDF2＋ペッパー）とログイン
  guard.js             送信回数の制限と操作の記録
  db.js                データベースの形（テーブルの作成）
  adapters/            Node の SQLite・Cloudflare D1・メール用ソケットのつなぎ
  validate.js, time.js, random.js
public/
  index.html, reserve.js    お客様向け予約ページ
  admin.html, admin*.js     管理画面
  unsubscribe.html          メール配信の停止
  styles.css                デザイン（大きな文字・ダークモード対応）
demo/photos/           見本のメニュー写真（イラスト）
test/                  テスト
```
