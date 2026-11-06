import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 初回起動時に入れておくテーブル（席）。管理画面の「設定」から変更できる。
export const DEFAULT_TABLES = [
  { name: '窓際1', seats: 2, area: '窓際' },
  { name: '窓際2', seats: 2, area: '窓際' },
  { name: 'テーブル3', seats: 4, area: 'テーブル' },
  { name: 'テーブル4', seats: 4, area: 'テーブル' },
  { name: 'テラス5', seats: 4, area: 'テラス' },
  { name: 'ソファ6', seats: 6, area: 'ソファ' },
];

const SCHEMA_V1 = `
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- パスワードのハッシュなど、画面に出さない値
CREATE TABLE secrets (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tables (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  seats      INTEGER NOT NULL CHECK (seats > 0),
  area       TEXT    NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE closures (
  date   TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  phone             TEXT    NOT NULL DEFAULT '',
  phone_digits      TEXT    NOT NULL DEFAULT '',
  email             TEXT    NOT NULL DEFAULT '',
  line_user_id      TEXT,
  notify_email      INTEGER NOT NULL DEFAULT 0,
  notify_line       INTEGER NOT NULL DEFAULT 0,
  unsubscribe_token TEXT    NOT NULL UNIQUE,
  memo              TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_customers_phone ON customers(phone_digits) WHERE phone_digits <> '';
CREATE UNIQUE INDEX idx_customers_line ON customers(line_user_id) WHERE line_user_id IS NOT NULL;

CREATE TABLE reservations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,
  date         TEXT    NOT NULL,
  start_time   TEXT    NOT NULL,
  end_time     TEXT    NOT NULL,
  party_size   INTEGER NOT NULL CHECK (party_size > 0),
  table_id     INTEGER NOT NULL REFERENCES tables(id),
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  seat_request TEXT    NOT NULL DEFAULT '',
  name         TEXT    NOT NULL,
  phone        TEXT    NOT NULL DEFAULT '',
  email        TEXT    NOT NULL DEFAULT '',
  note         TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'confirmed',
  source       TEXT    NOT NULL DEFAULT 'web',
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
CREATE INDEX idx_reservations_date ON reservations(date, start_time);
CREATE INDEX idx_reservations_customer ON reservations(customer_id);

CREATE TABLE menu_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  category    TEXT    NOT NULL DEFAULT '',
  price       INTEGER NOT NULL DEFAULT 0,
  photo       TEXT    NOT NULL DEFAULT '',
  weekdays    TEXT    NOT NULL DEFAULT '[]',
  preorder    INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- 予約で選んだメニュー。名前と値段は予約した時点のものを残す
CREATE TABLE reservation_items (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  menu_item_id   INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  price          INTEGER NOT NULL,
  quantity       INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX idx_reservation_items ON reservation_items(reservation_id);

-- 予約ページに載せるお知らせ
CREATE TABLE announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  starts_on  TEXT,
  ends_on    TEXT,
  created_at TEXT NOT NULL
);

-- メール・LINEで送ったお知らせ
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject       TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  channels      TEXT    NOT NULL,
  target        TEXT    NOT NULL,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE message_deliveries (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  channel     TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  error       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_message_deliveries ON message_deliveries(message_id);

-- スタッフのログイン状態（トークンはハッシュにして保存）
CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip         TEXT    NOT NULL DEFAULT ''
);

-- だれが・いつ・何をしたかの記録
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip     TEXT NOT NULL DEFAULT ''
);
`;

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < 1) {
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA_V1);
      const insert = db.prepare('INSERT INTO tables (name, seats, area, sort_order) VALUES (?, ?, ?, ?)');
      DEFAULT_TABLES.forEach((t, i) => insert.run(t.name, t.seats, t.area, i + 1));
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** BEGIN〜COMMIT をまとめる。入れ子で呼ばれたら外側に任せる */
export function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
