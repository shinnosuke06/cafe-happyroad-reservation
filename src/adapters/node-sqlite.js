// Node.js に組み込みの SQLite を、共通の形（all / get / run / batch）で使えるようにする
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openNodeDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  const cache = new Map();
  const statement = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  const result = (r) => ({ changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) });

  return {
    async all(sql, params = []) {
      return statement(sql).all(...clean(params));
    },
    async get(sql, params = []) {
      return statement(sql).get(...clean(params)) ?? null;
    },
    async run(sql, params = []) {
      return result(statement(sql).run(...clean(params)));
    },
    /** まとめて実行する。途中で失敗したら全部取り消す */
    async batch(list) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = list.map(([sql, params = []]) => result(statement(sql).run(...clean(params))));
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    /** バックアップ用：データベースを1つのファイルに書き出す */
    async backupTo(file) {
      raw.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    },
    close() {
      raw.close();
    },
  };
}
