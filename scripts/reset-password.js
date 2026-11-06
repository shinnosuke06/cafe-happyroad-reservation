// 管理画面のパスワードを忘れたとき用（Node で動かしている場合）。サーバーのパソコンで実行する。
//   npm run reset-password -- 新しいパスワード
// Cloudflare で動かしている場合は README の「パスワードを忘れたら」を見てください。
import { openNodeDatabase } from '../src/adapters/node-sqlite.js';
import { migrate } from '../src/db.js';
import { hashPassword, checkPasswordStrength } from '../src/auth.js';
import { loadPepper } from '../server.js';

const password = process.argv[2];
if (!password) {
  console.error('使い方: npm run reset-password -- 新しいパスワード');
  process.exit(1);
}
try {
  checkPasswordStrength(password);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const dbPath = process.env.DB_PATH || 'data/happyroad.db';
const db = openNodeDatabase(dbPath);
await migrate(db);
const hash = await hashPassword(password, await loadPepper(dbPath, process.env));
await db.batch([
  ["INSERT INTO secrets (key, value) VALUES ('adminPasswordHash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [hash]],
  ['DELETE FROM sessions'],
  ['INSERT INTO audit_log (at, action, detail, ip) VALUES (?, ?, ?, ?)', [new Date().toISOString(), 'パスワードを再設定', 'reset-password スクリプト', 'server']],
]);
db.close();
console.log('パスワードを変更しました。すべての端末がログアウトしました。');
