import { randomInt } from 'node:crypto';
import {
  toMinutes,
  fromMinutes,
  isValidDate,
  isValidTime,
  addDays,
  weekday,
  nowInZone,
} from './time.js';

export const STATUSES = ['confirmed', 'arrived', 'cancelled', 'no_show'];
export const SOURCES = ['web', 'phone', 'walkin'];
// 席を使っている状態。キャンセル・無断キャンセルは席を空ける。
const OCCUPYING = new Set(['confirmed', 'arrived']);
// 読み間違えやすい I・O・0・1 を除いた32文字
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export const DEFAULT_SETTINGS = {
  storeName: 'cafe ハッピーロード',
  storePhone: '',
  openTime: '10:00',
  closeTime: '18:00',
  slotMinutes: 30, // 予約を受け付ける時間の間隔
  stayMinutes: 90, // 1組あたりの利用時間
  maxPartySize: 6, // Web予約できる最大人数
  bookingDaysAhead: 60, // 何日先まで予約できるか
  minNoticeMinutes: 60, // 当日予約は何分前まで受け付けるか
  closedWeekdays: [], // 定休日（0=日曜 … 6=土曜）
};

const SLOT_CHOICES = [5, 10, 15, 20, 30, 60];

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- 入力チェック ---------------------------------------------------------

function text(value, { field, max, required = false }) {
  const s = value == null ? '' : String(value).trim();
  if (required && !s) throw new AppError(`${field}を入力してください`);
  if (s.length > max) throw new AppError(`${field}は${max}文字以内で入力してください`);
  return s;
}

function integer(value, { field, min, max }) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(`${field}は${min}〜${max}の数字で入力してください`);
  }
  return n;
}

function date(value, field = '日付') {
  if (!isValidDate(value)) throw new AppError(`${field}の形式が正しくありません`);
  return value;
}

function time(value, field = '時刻') {
  if (!isValidTime(value)) throw new AppError(`${field}の形式が正しくありません`);
  return value;
}

/** 全角数字や全角ハイフンを半角にそろえる */
function normalizeWidth(value) {
  return String(value ?? '').normalize('NFKC').replace(/[‐‑‒–—―ー−]/g, '-');
}

function digitsOnly(value) {
  return normalizeWidth(value).replace(/\D/g, '');
}

function phone(value, { required }) {
  const s = text(normalizeWidth(value), { field: '電話番号', max: 20, required });
  if (!s) return '';
  if (!/^[0-9+\-() ]+$/.test(s) || !/^\d{10,15}$/.test(digitsOnly(s))) {
    throw new AppError('電話番号の形式が正しくありません');
  }
  return s;
}

function email(value) {
  const s = text(value, { field: 'メールアドレス', max: 254 });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw new AppError('メールアドレスの形式が正しくありません');
  }
  return s;
}

function overlaps(r, start, end) {
  return toMinutes(r.start_time) < end && start < toMinutes(r.end_time);
}

function toReservation(row) {
  return {
    id: row.id,
    code: row.code,
    date: row.date,
    time: row.start_time,
    endTime: row.end_time,
    partySize: row.party_size,
    tableId: row.table_id,
    tableName: row.table_name ?? null,
    name: row.name,
    phone: row.phone,
    email: row.email,
    note: row.note,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** お客様に見せてよい項目だけ */
function toPublicReservation(row) {
  return {
    code: row.code,
    date: row.date,
    time: row.start_time,
    partySize: row.party_size,
    name: row.name,
    status: row.status,
  };
}

function toTable(row) {
  return {
    id: row.id,
    name: row.name,
    seats: row.seats,
    active: row.active === 1,
    sortOrder: row.sort_order,
  };
}

// ---- ストア本体 -----------------------------------------------------------

export function createStore(db, { now = () => new Date(), timezone = 'Asia/Tokyo' } = {}) {
  const clock = () => nowInZone(timezone, now());
  const timestamp = () => new Date(now()).toISOString();

  const sql = {
    settings: db.prepare('SELECT key, value FROM settings'),
    upsertSetting: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    allTables: db.prepare('SELECT * FROM tables ORDER BY sort_order, id'),
    activeTablesBySize: db.prepare(
      'SELECT * FROM tables WHERE active = 1 ORDER BY seats, sort_order, id',
    ),
    table: db.prepare('SELECT * FROM tables WHERE id = ?'),
    maxSortOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM tables'),
    insertTable: db.prepare('INSERT INTO tables (name, seats, active, sort_order) VALUES (?, ?, 1, ?)'),
    updateTable: db.prepare('UPDATE tables SET name = ?, seats = ?, active = ?, sort_order = ? WHERE id = ?'),
    deleteTable: db.prepare('DELETE FROM tables WHERE id = ?'),
    tableUsage: db.prepare('SELECT COUNT(*) AS count FROM reservations WHERE table_id = ?'),
    closure: db.prepare('SELECT * FROM closures WHERE date = ?'),
    closuresFrom: db.prepare('SELECT * FROM closures WHERE date >= ? ORDER BY date'),
    upsertClosure: db.prepare(
      'INSERT INTO closures (date, reason) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason',
    ),
    deleteClosure: db.prepare('DELETE FROM closures WHERE date = ?'),
    reservationsOnDate: db.prepare('SELECT * FROM reservations WHERE date = ?'),
    reservationsForDay: db.prepare(`
      SELECT r.*, t.name AS table_name FROM reservations r
      LEFT JOIN tables t ON t.id = r.table_id
      WHERE r.date = ? ORDER BY r.start_time, t.sort_order, r.id`),
    reservation: db.prepare(`
      SELECT r.*, t.name AS table_name FROM reservations r
      LEFT JOIN tables t ON t.id = r.table_id WHERE r.id = ?`),
    reservationByCode: db.prepare('SELECT * FROM reservations WHERE code = ?'),
    search: db.prepare(`
      SELECT r.*, t.name AS table_name FROM reservations r
      LEFT JOIN tables t ON t.id = r.table_id
      WHERE r.name LIKE :text ESCAPE '\\' OR r.code = :code
         OR (:digits <> '' AND REPLACE(REPLACE(REPLACE(r.phone, '-', ''), ' ', ''), '+', '') LIKE :digitsLike)
      ORDER BY r.date DESC, r.start_time DESC LIMIT 100`),
    insertReservation: db.prepare(`
      INSERT INTO reservations
        (code, date, start_time, end_time, party_size, table_id, name, phone, email, note, status, source, created_at, updated_at)
      VALUES
        (:code, :date, :start, :end, :partySize, :tableId, :name, :phone, :email, :note, :status, :source, :now, :now)`),
    updateReservation: db.prepare(`
      UPDATE reservations SET
        date = :date, start_time = :start, end_time = :end, party_size = :partySize, table_id = :tableId,
        name = :name, phone = :phone, email = :email, note = :note, status = :status, source = :source,
        updated_at = :now
      WHERE id = :id`),
    setStatus: db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?'),
    deleteReservation: db.prepare('DELETE FROM reservations WHERE id = ?'),
  };

  function transaction(fn) {
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

  // ---- 設定 ----

  function getSettings() {
    const settings = structuredClone(DEFAULT_SETTINGS);
    for (const { key, value } of sql.settings.all()) {
      if (key in DEFAULT_SETTINGS) settings[key] = JSON.parse(value);
    }
    return settings;
  }

  function updateSettings(patch = {}) {
    const next = { ...getSettings() };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    const s = {
      storeName: text(next.storeName, { field: '店名', max: 50, required: true }),
      storePhone: text(normalizeWidth(next.storePhone), { field: 'お店の電話番号', max: 20 }),
      openTime: time(next.openTime, '開店時刻'),
      closeTime: time(next.closeTime, '閉店時刻'),
      slotMinutes: integer(next.slotMinutes, { field: '予約の間隔', min: 5, max: 60 }),
      stayMinutes: integer(next.stayMinutes, { field: '利用時間', min: 15, max: 600 }),
      maxPartySize: integer(next.maxPartySize, { field: 'Web予約の最大人数', min: 1, max: 50 }),
      bookingDaysAhead: integer(next.bookingDaysAhead, { field: '予約受付期間', min: 0, max: 365 }),
      minNoticeMinutes: integer(next.minNoticeMinutes, { field: '当日予約の締切', min: 0, max: 2880 }),
      closedWeekdays: next.closedWeekdays,
    };
    if (!SLOT_CHOICES.includes(s.slotMinutes)) {
      throw new AppError(`予約の間隔は ${SLOT_CHOICES.join('・')} 分から選んでください`);
    }
    if (toMinutes(s.openTime) >= toMinutes(s.closeTime)) {
      throw new AppError('閉店時刻は開店時刻より後にしてください');
    }
    if (s.stayMinutes > toMinutes(s.closeTime) - toMinutes(s.openTime)) {
      throw new AppError('利用時間が営業時間より長くなっています');
    }
    if (
      !Array.isArray(s.closedWeekdays) ||
      !s.closedWeekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    ) {
      throw new AppError('定休日の指定が正しくありません');
    }
    s.closedWeekdays = [...new Set(s.closedWeekdays)].sort();

    transaction(() => {
      for (const [key, value] of Object.entries(s)) sql.upsertSetting.run(key, JSON.stringify(value));
    });
    return s;
  }

  // ---- テーブル（席） ----

  function listTables() {
    return sql.allTables.all().map(toTable);
  }

  function getTableRow(id) {
    const row = sql.table.get(Number(id));
    if (!row) throw new AppError('テーブルが見つかりません', 404);
    return row;
  }

  function createTable(input = {}) {
    const name = text(input.name, { field: 'テーブル名', max: 30, required: true });
    const seats = integer(input.seats, { field: '席数', min: 1, max: 50 });
    const { max } = sql.maxSortOrder.get();
    const { lastInsertRowid } = sql.insertTable.run(name, seats, max + 1);
    return toTable(sql.table.get(lastInsertRowid));
  }

  function updateTable(id, input = {}) {
    const row = getTableRow(id);
    const name = text(input.name ?? row.name, { field: 'テーブル名', max: 30, required: true });
    const seats = integer(input.seats ?? row.seats, { field: '席数', min: 1, max: 50 });
    const active = input.active === undefined ? row.active : input.active ? 1 : 0;
    const sortOrder = integer(input.sortOrder ?? row.sort_order, { field: '並び順', min: 0, max: 9999 });
    sql.updateTable.run(name, seats, active, sortOrder, row.id);
    return toTable(sql.table.get(row.id));
  }

  function deleteTable(id) {
    const row = getTableRow(id);
    if (sql.tableUsage.get(row.id).count > 0) {
      throw new AppError('予約の記録があるテーブルは削除できません。「使う」のチェックを外してください', 409);
    }
    sql.deleteTable.run(row.id);
  }

  // ---- 休業日 ----

  function listClosures({ from } = {}) {
    return sql.closuresFrom.all(from ?? clock().date).map((r) => ({ date: r.date, reason: r.reason }));
  }

  function addClosure(input = {}) {
    const d = date(input.date);
    const reason = text(input.reason, { field: '理由', max: 50 });
    sql.upsertClosure.run(d, reason);
    return { date: d, reason };
  }

  function removeClosure(d) {
    sql.deleteClosure.run(date(d));
  }

  function closedReason(d, settings) {
    if (settings.closedWeekdays.includes(weekday(d))) return '定休日です';
    const closure = sql.closure.get(d);
    if (closure) return closure.reason ? `臨時休業日です（${closure.reason}）` : '臨時休業日です';
    return null;
  }

  // ---- 空き状況 ----

  function slotStarts(settings) {
    const open = toMinutes(settings.openTime);
    const close = toMinutes(settings.closeTime);
    const starts = [];
    for (let t = open; t + settings.stayMinutes <= close; t += settings.slotMinutes) starts.push(t);
    return starts;
  }

  /** 条件に合って空いているテーブル。席数が少ない順（ぴったりの席から埋める） */
  function freeTables({ tables, reservations, start, end, partySize, excludeId = null }) {
    return tables.filter(
      (t) =>
        t.seats >= partySize &&
        !reservations.some(
          (r) => r.id !== excludeId && r.table_id === t.id && OCCUPYING.has(r.status) && overlaps(r, start, end),
        ),
    );
  }

  /** Web予約できない日ならその理由を返す */
  function publicDateProblem(d, settings, today) {
    if (d < today) return '過去の日付は予約できません';
    if (d > addDays(today, settings.bookingDaysAhead)) {
      return `ご予約は${settings.bookingDaysAhead}日先まで受け付けています`;
    }
    return closedReason(d, settings);
  }

  function tooSoon(d, start, settings, now) {
    return d === now.date && start < now.minutes + settings.minNoticeMinutes;
  }

  function availability(d, partySizeInput) {
    const settings = getSettings();
    date(d);
    const partySize = integer(partySizeInput, { field: '人数', min: 1, max: 99 });
    const now = clock();
    let reason = publicDateProblem(d, settings, now.date);
    if (!reason && partySize > settings.maxPartySize) {
      reason = `${settings.maxPartySize + 1}名様以上のご予約はお電話でお問い合わせください`;
    }
    if (reason) return { date: d, partySize, open: false, reason, slots: [] };

    const tables = sql.activeTablesBySize.all();
    const reservations = sql.reservationsOnDate.all(d);
    const slots = slotStarts(settings).map((start) => ({
      time: fromMinutes(start),
      available:
        !tooSoon(d, start, settings, now) &&
        freeTables({ tables, reservations, start, end: start + settings.stayMinutes, partySize }).length > 0,
    }));
    return { date: d, partySize, open: true, slots };
  }

  function publicInfo() {
    const s = getSettings();
    const today = clock().date;
    const lastBookableDate = addDays(today, s.bookingDaysAhead);
    return {
      storeName: s.storeName,
      storePhone: s.storePhone,
      openTime: s.openTime,
      closeTime: s.closeTime,
      stayMinutes: s.stayMinutes,
      maxPartySize: s.maxPartySize,
      closedWeekdays: s.closedWeekdays,
      closedDates: listClosures({ from: today })
        .filter((c) => c.date <= lastBookableDate)
        .map((c) => c.date),
      today,
      lastBookableDate,
    };
  }

  // ---- 予約 ----

  function newCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!sql.reservationByCode.get(code)) return code;
    }
    throw new AppError('予約番号を作れませんでした。もう一度お試しください', 500);
  }

  function insert(data) {
    const { lastInsertRowid } = sql.insertReservation.run({
      code: newCode(),
      date: data.date,
      start: fromMinutes(data.start),
      end: fromMinutes(data.end),
      partySize: data.partySize,
      tableId: data.tableId,
      name: data.name,
      phone: data.phone,
      email: data.email,
      note: data.note,
      status: data.status,
      source: data.source,
      now: timestamp(),
    });
    return sql.reservation.get(lastInsertRowid);
  }

  /** お客様のWeb予約 */
  function createPublicReservation(input = {}) {
    const settings = getSettings();
    const d = date(input.date);
    const start = toMinutes(time(input.time, '時間'));
    const partySize = integer(input.partySize, { field: '人数', min: 1, max: settings.maxPartySize });
    const data = {
      date: d,
      start,
      end: start + settings.stayMinutes,
      partySize,
      name: text(input.name, { field: 'お名前', max: 50, required: true }),
      phone: phone(input.phone, { required: true }),
      email: email(input.email),
      note: text(input.note, { field: 'ご要望', max: 500 }),
      status: 'confirmed',
      source: 'web',
    };
    const now = clock();
    const problem = publicDateProblem(d, settings, now.date);
    if (problem) throw new AppError(problem);
    if (!slotStarts(settings).includes(start)) throw new AppError('この時間は選べません');
    if (tooSoon(d, start, settings, now)) throw new AppError('この時間の受付は終了しました');

    const row = transaction(() => {
      const free = freeTables({
        tables: sql.activeTablesBySize.all(),
        reservations: sql.reservationsOnDate.all(d),
        start: data.start,
        end: data.end,
        partySize,
      });
      if (free.length === 0) {
        throw new AppError('申し訳ありません。この時間は満席になりました。別の時間をお選びください', 409);
      }
      return insert({ ...data, tableId: free[0].id });
    });
    return toPublicReservation(row);
  }

  function findOwnReservation(code, phoneInput) {
    const normalized = normalizeWidth(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const digits = digitsOnly(phoneInput);
    const row = normalized ? sql.reservationByCode.get(normalized) : null;
    if (!row || !digits || digitsOnly(row.phone) !== digits) {
      throw new AppError('予約が見つかりません。予約番号と電話番号をご確認ください', 404);
    }
    return row;
  }

  function lookupReservation({ code, phone: phoneInput } = {}) {
    return toPublicReservation(findOwnReservation(code, phoneInput));
  }

  function cancelByCustomer({ code, phone: phoneInput } = {}) {
    const row = findOwnReservation(code, phoneInput);
    if (row.status === 'cancelled') throw new AppError('この予約はすでにキャンセルされています', 409);
    if (row.status !== 'confirmed') throw new AppError('この予約はキャンセルできません', 409);
    const now = clock();
    if (row.date < now.date || (row.date === now.date && toMinutes(row.start_time) <= now.minutes)) {
      throw new AppError('予約時間を過ぎているためキャンセルできません。お店にご連絡ください', 409);
    }
    sql.setStatus.run('cancelled', timestamp(), row.id);
    return toPublicReservation(sql.reservationByCode.get(row.code));
  }

  /** 管理画面からの入力を、既存の予約（編集時）に重ねて組み立てる */
  function buildStaffReservation(input, settings, existing = null) {
    const pick = (key, fallback) => (input[key] !== undefined ? input[key] : fallback);
    const d = date(pick('date', existing?.date));
    const start = toMinutes(time(pick('time', existing?.time), '開始時刻'));

    let end;
    if (input.endTime) {
      end = toMinutes(time(input.endTime, '終了時刻'));
    } else if (existing) {
      end = start + (toMinutes(existing.endTime) - toMinutes(existing.time));
    } else {
      end = start + settings.stayMinutes;
    }
    if (end <= start) throw new AppError('終了時刻は開始時刻より後にしてください');
    if (end >= 24 * 60) throw new AppError('終了時刻が日付をまたいでいます');

    const status = pick('status', existing?.status ?? 'confirmed');
    if (!STATUSES.includes(status)) throw new AppError('状態の指定が正しくありません');
    const source = pick('source', existing?.source ?? 'phone');
    if (!SOURCES.includes(source)) throw new AppError('受付方法の指定が正しくありません');

    const tableInput = pick('tableId', existing?.tableId);
    const tableId = tableInput == null || tableInput === '' || tableInput === 'auto' ? null : Number(tableInput);

    return {
      date: d,
      start,
      end,
      partySize: integer(pick('partySize', existing?.partySize), { field: '人数', min: 1, max: 99 }),
      tableId,
      name: text(pick('name', existing?.name), { field: 'お名前', max: 50, required: true }),
      phone: phone(pick('phone', existing?.phone), { required: false }),
      email: email(pick('email', existing?.email)),
      note: text(pick('note', existing?.note), { field: 'メモ', max: 500 }),
      status,
      source,
    };
  }

  /** テーブルを決める。指定がなければ空いている一番小さいテーブルを使う */
  function resolveTable(data, excludeId = null) {
    const reservations = sql.reservationsOnDate.all(data.date);
    if (data.tableId == null) {
      const free = freeTables({
        tables: sql.activeTablesBySize.all(),
        reservations,
        start: data.start,
        end: data.end,
        partySize: data.partySize,
        excludeId,
      });
      if (free.length === 0) throw new AppError('この時間に人数に合う空きテーブルがありません', 409);
      return free[0].id;
    }

    const table = getTableRow(data.tableId);
    // キャンセルなど席を使わない状態なら、席数や重なりは問わない
    if (!OCCUPYING.has(data.status)) return table.id;
    if (table.seats < data.partySize) {
      throw new AppError(`${table.name}は${table.seats}席です。人数に合うテーブルを選んでください`);
    }
    const clash = reservations.find(
      (r) => r.id !== excludeId && r.table_id === table.id && OCCUPYING.has(r.status) && overlaps(r, data.start, data.end),
    );
    if (clash) {
      throw new AppError(
        `${table.name}は ${clash.start_time}〜${clash.end_time} に${clash.name}様の予約が入っています`,
        409,
      );
    }
    return table.id;
  }

  function getReservation(id) {
    const row = sql.reservation.get(Number(id));
    if (!row) throw new AppError('予約が見つかりません', 404);
    return toReservation(row);
  }

  function listReservations(d) {
    return sql.reservationsForDay.all(date(d)).map(toReservation);
  }

  function searchReservations(query) {
    const q = text(query, { field: '検索語', max: 50 });
    if (!q) return [];
    const digits = digitsOnly(q);
    return sql.search
      .all({
        text: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
        code: normalizeWidth(q).toUpperCase(),
        digits: digits.length >= 3 ? digits : '',
        digitsLike: `%${digits}%`,
      })
      .map(toReservation);
  }

  function createStaffReservation(input = {}) {
    const data = buildStaffReservation(input, getSettings());
    return transaction(() => {
      const row = insert({ ...data, tableId: resolveTable(data) });
      return toReservation(sql.reservation.get(row.id));
    });
  }

  function updateStaffReservation(id, input = {}) {
    const existing = getReservation(id);
    const data = buildStaffReservation(input, getSettings(), existing);
    return transaction(() => {
      const tableId = resolveTable(data, existing.id);
      sql.updateReservation.run({
        id: existing.id,
        date: data.date,
        start: fromMinutes(data.start),
        end: fromMinutes(data.end),
        partySize: data.partySize,
        tableId,
        name: data.name,
        phone: data.phone,
        email: data.email,
        note: data.note,
        status: data.status,
        source: data.source,
        now: timestamp(),
      });
      return getReservation(existing.id);
    });
  }

  function deleteReservation(id) {
    const existing = getReservation(id);
    sql.deleteReservation.run(existing.id);
  }

  return {
    today: () => clock().date,
    getSettings,
    updateSettings,
    publicInfo,
    listTables,
    createTable,
    updateTable,
    deleteTable,
    listClosures,
    addClosure,
    removeClosure,
    availability,
    createPublicReservation,
    lookupReservation,
    cancelByCustomer,
    getReservation,
    listReservations,
    searchReservations,
    createStaffReservation,
    updateStaffReservation,
    deleteReservation,
  };
}
