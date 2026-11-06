import { createServer } from 'node:http';
import { createApp } from './src/app.js';
import { createNotifier } from './src/notify.js';
import { checkPasswordStrength } from './src/auth.js';

const env = process.env;
const production = env.NODE_ENV === 'production';
const port = Number(env.PORT) || 3000;
const host = env.HOST || '0.0.0.0';
const dbPath = env.DB_PATH || 'data/happyroad.db';

// 管理画面のパスワード（最初の起動のときだけ使い、ハッシュにして保存する）
let adminPassword = env.ADMIN_PASSWORD;
if (adminPassword) {
  try {
    checkPasswordStrength(adminPassword);
  } catch (err) {
    if (production) {
      console.error(`ADMIN_PASSWORD: ${err.message}`);
      process.exit(1);
    }
    console.warn(`⚠ ADMIN_PASSWORD: ${err.message}（お店で使うときは必ず直してください）`);
  }
} else if (!production) {
  adminPassword = 'happyroad-dev';
}

let app;
try {
  app = await createApp({
    dbPath,
    adminPassword,
    timezone: env.STORE_TIMEZONE || 'Asia/Tokyo',
    notifier: createNotifier(env),
    trustProxy: env.TRUST_PROXY === '1',
    publicUrl: env.PUBLIC_URL || '',
  });
} catch (err) {
  console.error(err.message);
  console.error('例）ADMIN_PASSWORD=長くて推測されにくいパスワード npm start');
  process.exit(1);
}
if (app.passwordCreated && !env.ADMIN_PASSWORD) {
  console.warn('⚠ 開発用の仮パスワード "happyroad-dev" で始めました。お店で使う前に、管理画面の「設定」でパスワードを変えてください。');
}

const server = createServer(app.handler);
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
server.listen(port, host, () => {
  console.log('cafe ハッピーロード 予約管理システムを起動しました');
  console.log(`  予約ページ : http://localhost:${port}/`);
  console.log(`  管理画面   : http://localhost:${port}/admin`);
  console.log(`  データ     : ${dbPath}`);
  const notify = createNotifier(env).status();
  console.log(`  メール送信 : ${notify.email ? '設定済み' : '未設定'}　LINE送信 : ${notify.line ? '設定済み' : '未設定'}`);
});

function shutdown() {
  server.close(() => {
    app.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
