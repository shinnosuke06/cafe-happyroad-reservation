import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 初回起動時に入れておくテーブル（席）。管理画面の「設定」から変更できる。
export const DEFAULT_TABLES = [
  { name: '窓際1', seats: 2 },
  { name: '窓際2', seats: 2 },
  { name: 'テーブル3', seats: 4 },
  { name: 'テーブル4', seats: 4 },
  { name: 'テラス5', seats: 4 },
  { name: 'ソファ6', seats: 6 },
];

const SCHEMA_V1 = `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tables (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  seats      INTEGER NOT NULL CHECK (seats > 0),
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE closures (
  date   TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE reservations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  date       TEXT    NOT NULL,
  start_time TEXT    NOT NULL,
  end_time   TEXT    NOT NULL,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  name       TEXT    NOT NULL,
  phone      TEXT    NOT NULL DEFAULT '',
  email      TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  status     TEXT    NOT NULL DEFAULT 'confirmed',
  source     TEXT    NOT NULL DEFAULT 'web',
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);

CREATE INDEX idx_reservations_date ON reservations(date, start_time);
`;

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < 1) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA_V1);
      const insert = db.prepare('INSERT INTO tables (name, seats, sort_order) VALUES (?, ?, ?)');
      DEFAULT_TABLES.forEach((t, i) => insert.run(t.name, t.seats, i + 1));
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
