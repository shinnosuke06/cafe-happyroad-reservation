import { createServer } from 'node:http';
import { createApp } from './src/app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const dbPath = process.env.DB_PATH || 'data/happyroad.db';

let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = 'happyroad';
  console.warn('⚠ ADMIN_PASSWORD が設定されていないため、仮のパスワード "happyroad" を使います。お店で使う前に必ず設定してください。');
}

const app = createApp({
  dbPath,
  adminPassword,
  timezone: process.env.STORE_TIMEZONE || 'Asia/Tokyo',
});

const server = createServer(app.handler);
server.listen(port, host, () => {
  console.log(`cafe ハッピーロード 予約管理システムを起動しました`);
  console.log(`  予約ページ : http://localhost:${port}/`);
  console.log(`  管理画面   : http://localhost:${port}/admin`);
  console.log(`  データ     : ${dbPath}`);
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
