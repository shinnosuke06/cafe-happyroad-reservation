// データベースの形（Node の SQLite でも Cloudflare D1 でも同じ）。
// 使い方は db.all / db.get / db.run / db.batch（パラメータは ? の順番で渡す）。

// 初回起動時に入れておくテーブル（席）。管理画面の「設定」から変更できる。
export const DEFAULT_TABLES = [
  { name: '窓際1', seats: 2, area: '窓際' },
  { name: '窓際2', seats: 2, area: '窓際' },
  { name: 'テーブル3', seats: 4, area: 'テーブル' },
  { name: 'テーブル4', seats: 4, area: 'テーブル' },
  { name: 'テラス5', seats: 4, area: 'テラス' },
  { name: 'ソファ6', seats: 6, area: 'ソファ' },
];

const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // パスワードのハッシュなど、画面に出さない値
  `CREATE TABLE IF NOT EXISTS secrets (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tables (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    seats      INTEGER NOT NULL CHECK (seats > 0),
    area       TEXT    NOT NULL DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS closures (
    date   TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
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
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_digits) WHERE phone_digits <> ''",
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_line ON customers(line_user_id) WHERE line_user_id IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS reservations (
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
  )`,
  'CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(date, start_time)',
  'CREATE INDEX IF NOT EXISTS idx_reservations_customer ON reservations(customer_id)',
  `CREATE TABLE IF NOT EXISTS menu_items (
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
  )`,
  // 予約で選んだメニュー。名前と値段は予約した時点のものを残す
  `CREATE TABLE IF NOT EXISTS reservation_items (
    reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    menu_item_id   INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
    name           TEXT    NOT NULL,
    price          INTEGER NOT NULL,
    quantity       INTEGER NOT NULL CHECK (quantity > 0)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_reservation_items ON reservation_items(reservation_id)',
  // メニューの写真（ファイルではなくデータベースに入れる）
  `CREATE TABLE IF NOT EXISTS photos (
    name       TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // 予約ページに載せるお知らせ
  `CREATE TABLE IF NOT EXISTS announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    starts_on  TEXT,
    ends_on    TEXT,
    created_at TEXT NOT NULL
  )`,
  // メール・LINEで送ったお知らせ
  `CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject       TEXT    NOT NULL,
    body          TEXT    NOT NULL,
    channels      TEXT    NOT NULL,
    target        TEXT    NOT NULL,
    sent_count    INTEGER NOT NULL DEFAULT 0,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS message_deliveries (
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    channel     TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    error       TEXT    NOT NULL DEFAULT ''
  )`,
  'CREATE INDEX IF NOT EXISTS idx_message_deliveries ON message_deliveries(message_id)',
  // スタッフのログイン状態（トークンはハッシュにして保存）
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    ip         TEXT    NOT NULL DEFAULT ''
  )`,
  // 送信回数の制限（いたずら・総当たり対策）
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key          TEXT    PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL
  )`,
  // だれが・いつ・何をしたかの記録
  `CREATE TABLE IF NOT EXISTS audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    ip     TEXT NOT NULL DEFAULT ''
  )`,
];

/** まだ作っていなければ、テーブルを作って初期データを入れる（何度呼んでも安全） */
export async function migrate(db) {
  await db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = await db.get("SELECT value FROM meta WHERE key = 'schema_version'");
  if (Number(row?.value ?? 0) >= 1) return;
  const values = DEFAULT_TABLES.map(() => '(?, ?, ?, ?)').join(', ');
  await db.batch([
    ...SCHEMA_V1.map((sql) => [sql]),
    [
      `INSERT INTO tables (name, seats, area, sort_order)
       SELECT * FROM (VALUES ${values}) WHERE NOT EXISTS (SELECT 1 FROM tables)`,
      DEFAULT_TABLES.flatMap((t, i) => [t.name, t.seats, t.area, i + 1]),
    ],
    ["INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')"],
  ]);
}
