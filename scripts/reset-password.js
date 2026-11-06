// 管理画面のパスワードを忘れたとき用。サーバーのパソコンで実行する。
//   npm run reset-password -- 新しいパスワード
import { openDatabase } from '../src/db.js';
import { hashPassword, checkPasswordStrength } from '../src/auth.js';

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

const db = openDatabase(process.env.DB_PATH || 'data/happyroad.db');
db.prepare(
  'INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run('adminPasswordHash', await hashPassword(password));
db.exec('DELETE FROM sessions');
db.prepare('INSERT INTO audit_log (at, action, detail, ip) VALUES (?, ?, ?, ?)').run(
  new Date().toISOString(),
  'パスワードを再設定',
  'reset-password スクリプト',
  'server',
);
db.close();
console.log('パスワードを変更しました。すべての端末がログアウトしました。');
