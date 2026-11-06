import { randomInt, randomBytes } from 'node:crypto';
import { transaction } from './db.js';
import { toMinutes, fromMinutes, addDays, weekday, nowInZone } from './time.js';
import {
  AppError,
  text,
  integer,
  bool,
  date,
  time,
  phone,
  email,
  url,
  weekdays,
  normalizeWidth,
  digitsOnly,
} from './validate.js';

export { AppError };

export const STATUSES = ['confirmed', 'arrived', 'cancelled', 'no_show'];
export const SOURCES = ['web', 'phone', 'walkin'];
// 席を使っている状態。キャンセル・無断キャンセルは席を空ける。
const OCCUPYING = new Set(['confirmed', 'arrived']);
// 読み間違えやすい I・O・0・1 を除いた32文字
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
// 空き時間がこの数以下なら「残りわずか（△）」
const FEW_SLOTS = 3;

export const DEFAULT_SETTINGS = {
  storeName: 'cafe ハッピーロード',
  storePhone: '',
  storeAddress: '',
  lineFriendUrl: '', // LINE公式アカウントの友だち追加URL
  openTime: '10:00',
  closeTime: '18:00',
  slotMinutes: 30, // 予約を受け付ける時間の間隔
  stayMinutes: 90, // 1組あたりの利用時間
  maxPartySize: 6, // Web予約できる最大人数
  maxGuestsPerSlot: 0, // 同じ時間にお店にいられる最大人数（0 = 制限なし）
  bookingDaysAhead: 60, // 何日先まで予約できるか
  minNoticeMinutes: 60, // 当日予約は何分前まで受け付けるか
  closedWeekdays: [], // 定休日（0=日曜 … 6=土曜）
};

const SLOT_CHOICES = [5, 10, 15, 20, 30, 60];

function overlaps(r, start, end) {
  return toMinutes(r.start_time) < end && start < toMinutes(r.end_time);
}

/** 予約が重なる時間帯の、お店にいる人数の最大値 */
function peakGuests(reservations, start, end, excludeId = null) {
  const active = reservations.filter((r) => r.id !== excludeId && OCCUPYING.has(r.status) && overlaps(r, start, end));
  const points = [start, ...active.map((r) => Math.max(start, toMinutes(r.start_time)))];
  let peak = 0;
  for (const p of points) {
    const guests = active
      .filter((r) => toMinutes(r.start_time) <= p && p < toMinutes(r.end_time))
      .reduce((sum, r) => sum + r.party_size, 0);
    peak = Math.max(peak, guests);
  }
  return peak;
}

function toTable(row) {
  return {
    id: row.id,
    name: row.name,
    seats: row.seats,
    area: row.area,
    active: row.active === 1,
    sortOrder: row.sort_order,
  };
}

function toItem(row) {
  return { menuItemId: row.menu_item_id, name: row.name, price: row.price, quantity: row.quantity };
}

function toReservation(row, items = []) {
  return {
    id: row.id,
    code: row.code,
    date: row.date,
    time: row.start_time,
    endTime: row.end_time,
    partySize: row.party_size,
    tableId: row.table_id,
    tableName: row.table_name ?? null,
    tableArea: row.table_area ?? null,
    customerId: row.customer_id,
    seatRequest: row.seat_request,
    name: row.name,
    phone: row.phone,
    email: row.email,
    note: row.note,
    status: row.status,
    source: row.source,
    items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** お客様に見せてよい項目だけ */
function toPublicReservation(row, items = []) {
  return {
    code: row.code,
    date: row.date,
    time: row.start_time,
    partySize: row.party_size,
    seatRequest: row.seat_request,
    name: row.name,
    status: row.status,
    items: items.map(({ name, quantity }) => ({ name, quantity })),
  };
}

export function createStore(db, { now = () => new Date(), timezone = 'Asia/Tokyo' } = {}) {
  const clock = () => nowInZone(timezone, now());
  const timestamp = () => new Date(now()).toISOString();
  const tx = (fn) => transaction(db, fn);

  const RESERVATION_SELECT = `
    SELECT r.*, t.name AS table_name, t.area AS table_area FROM reservations r
    LEFT JOIN tables t ON t.id = r.table_id`;

  const sql = {
    settings: db.prepare('SELECT key, value FROM settings'),
    upsertSetting: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    allTables: db.prepare('SELECT * FROM tables ORDER BY sort_order, id'),
    activeTablesBySize: db.prepare('SELECT * FROM tables WHERE active = 1 ORDER BY seats, sort_order, id'),
    areas: db.prepare(
      "SELECT area, MAX(seats) AS max_seats FROM tables WHERE active = 1 AND area <> '' GROUP BY area ORDER BY MIN(sort_order)",
    ),
    table: db.prepare('SELECT * FROM tables WHERE id = ?'),
    maxSortOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM tables'),
    insertTable: db.prepare('INSERT INTO tables (name, seats, area, active, sort_order) VALUES (?, ?, ?, 1, ?)'),
    updateTable: db.prepare('UPDATE tables SET name = ?, seats = ?, area = ?, active = ?, sort_order = ? WHERE id = ?'),
    deleteTable: db.prepare('DELETE FROM tables WHERE id = ?'),
    tableUsage: db.prepare('SELECT COUNT(*) AS count FROM reservations WHERE table_id = ?'),
    closure: db.prepare('SELECT * FROM closures WHERE date = ?'),
    closuresFrom: db.prepare('SELECT * FROM closures WHERE date >= ? ORDER BY date'),
    upsertClosure: db.prepare(
      'INSERT INTO closures (date, reason) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason',
    ),
    deleteClosure: db.prepare('DELETE FROM closures WHERE date = ?'),
    reservationsOnDate: db.prepare('SELECT * FROM reservations WHERE date = ?'),
    reservationsForDay: db.prepare(`${RESERVATION_SELECT} WHERE r.date = ? ORDER BY r.start_time, t.sort_order, r.id`),
    reservation: db.prepare(`${RESERVATION_SELECT} WHERE r.id = ?`),
    reservationByCode: db.prepare('SELECT * FROM reservations WHERE code = ?'),
    reservationsOfCustomer: db.prepare(
      `${RESERVATION_SELECT} WHERE r.customer_id = ? ORDER BY r.date DESC, r.start_time DESC LIMIT 200`,
    ),
    search: db.prepare(`
      ${RESERVATION_SELECT}
      WHERE r.name LIKE :text ESCAPE '\\' OR r.code = :code
         OR (:digits <> '' AND REPLACE(REPLACE(REPLACE(r.phone, '-', ''), ' ', ''), '+', '') LIKE :digitsLike)
      ORDER BY r.date DESC, r.start_time DESC LIMIT 100`),
    itemsFor: db.prepare(
      'SELECT * FROM reservation_items WHERE reservation_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
    ),
    insertItem: db.prepare(
      'INSERT INTO reservation_items (reservation_id, menu_item_id, name, price, quantity) VALUES (?, ?, ?, ?, ?)',
    ),
    deleteItems: db.prepare('DELETE FROM reservation_items WHERE reservation_id = ?'),
    menuItem: db.prepare('SELECT * FROM menu_items WHERE id = ?'),
    insertReservation: db.prepare(`
      INSERT INTO reservations
        (code, date, start_time, end_time, party_size, table_id, customer_id, seat_request,
         name, phone, email, note, status, source, created_at, updated_at)
      VALUES
        (:code, :date, :start, :end, :partySize, :tableId, :customerId, :seatRequest,
         :name, :phone, :email, :note, :status, :source, :now, :now)`),
    updateReservation: db.prepare(`
      UPDATE reservations SET
        date = :date, start_time = :start, end_time = :end, party_size = :partySize, table_id = :tableId,
        customer_id = :customerId, seat_request = :seatRequest,
        name = :name, phone = :phone, email = :email, note = :note, status = :status, source = :source,
        updated_at = :now
      WHERE id = :id`),
    setStatus: db.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?'),
    deleteReservation: db.prepare('DELETE FROM reservations WHERE id = ?'),
    customerByDigits: db.prepare('SELECT * FROM customers WHERE phone_digits = ?'),
    insertCustomer: db.prepare(`
      INSERT INTO customers (name, phone, phone_digits, email, notify_email, unsubscribe_token, created_at, updated_at)
      VALUES (:name, :phone, :digits, :email, :notifyEmail, :token, :now, :now)`),
    updateCustomerContact: db.prepare(`
      UPDATE customers SET name = :name, phone = :phone, email = :email, notify_email = :notifyEmail, updated_at = :now
      WHERE id = :id`),
  };

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
      storeAddress: text(next.storeAddress, { field: '住所', max: 100 }),
      lineFriendUrl: url(next.lineFriendUrl, 'LINEの友だち追加URL'),
      openTime: time(next.openTime, '開店時刻'),
      closeTime: time(next.closeTime, '閉店時刻'),
      slotMinutes: integer(next.slotMinutes, { field: '予約の間隔', min: 5, max: 60 }),
      stayMinutes: integer(next.stayMinutes, { field: '利用時間', min: 15, max: 600 }),
      maxPartySize: integer(next.maxPartySize, { field: 'Web予約の最大人数', min: 1, max: 50 }),
      maxGuestsPerSlot: integer(next.maxGuestsPerSlot, { field: '同じ時間の最大人数', min: 0, max: 500 }),
      bookingDaysAhead: integer(next.bookingDaysAhead, { field: '予約受付期間', min: 0, max: 365 }),
      minNoticeMinutes: integer(next.minNoticeMinutes, { field: '当日予約の締切', min: 0, max: 2880 }),
      closedWeekdays: weekdays(next.closedWeekdays, '定休日'),
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
    tx(() => {
      for (const [key, value] of Object.entries(s)) sql.upsertSetting.run(key, JSON.stringify(value));
    });
    return s;
  }

  // ---- テーブル（席） ----

  function listTables() {
    return sql.allTables.all().map(toTable);
  }

  function listAreas() {
    return sql.areas.all().map((r) => ({ name: r.area, maxSeats: r.max_seats }));
  }

  function getTableRow(id) {
    const row = sql.table.get(Number(id));
    if (!row) throw new AppError('テーブルが見つかりません', 404);
    return row;
  }

  function createTable(input = {}) {
    const name = text(input.name, { field: 'テーブル名', max: 30, required: true });
    const seats = integer(input.seats, { field: '席数', min: 1, max: 50 });
    const area = text(input.area, { field: '席の種類', max: 20 });
    const { max } = sql.maxSortOrder.get();
    const { lastInsertRowid } = sql.insertTable.run(name, seats, area, max + 1);
    return toTable(sql.table.get(lastInsertRowid));
  }

  function updateTable(id, input = {}) {
    const row = getTableRow(id);
    const name = text(input.name ?? row.name, { field: 'テーブル名', max: 30, required: true });
    const seats = integer(input.seats ?? row.seats, { field: '席数', min: 1, max: 50 });
    const area = text(input.area ?? row.area, { field: '席の種類', max: 20 });
    const active = input.active === undefined ? row.active : bool(input.active) ? 1 : 0;
    const sortOrder = integer(input.sortOrder ?? row.sort_order, { field: '並び順', min: 0, max: 9999 });
    sql.updateTable.run(name, seats, area, active, sortOrder, row.id);
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
    return { date: d, reason, reservations: countActiveOn(d) };
  }

  function removeClosure(d) {
    sql.deleteClosure.run(date(d));
  }

  function countActiveOn(d) {
    return sql.reservationsOnDate.all(d).filter((r) => OCCUPYING.has(r.status)).length;
  }

  function closedReason(d, settings) {
    if (settings.closedWeekdays.includes(weekday(d))) return '定休日';
    const closure = sql.closure.get(d);
    if (closure) return closure.reason ? `臨時休業（${closure.reason}）` : '臨時休業';
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
  function freeTables({ tables, reservations, start, end, partySize, area = '', excludeId = null }) {
    return tables.filter(
      (t) =>
        t.seats >= partySize &&
        (!area || t.area === area) &&
        !reservations.some(
          (r) => r.id !== excludeId && r.table_id === t.id && OCCUPYING.has(r.status) && overlaps(r, start, end),
        ),
    );
  }

  function overCapacity(settings, reservations, start, end, partySize, excludeId = null) {
    if (!settings.maxGuestsPerSlot) return null;
    const peak = peakGuests(reservations, start, end, excludeId);
    return peak + partySize > settings.maxGuestsPerSlot ? peak : null;
  }

  /** Web予約できない日ならその理由を返す */
  function publicDateProblem(d, settings, today) {
    if (d < today) return { status: 'past', reason: '過去の日付は予約できません' };
    if (d > addDays(today, settings.bookingDaysAhead)) {
      return { status: 'outside', reason: `ご予約は${settings.bookingDaysAhead}日先まで受け付けています` };
    }
    const closed = closedReason(d, settings);
    if (closed) return { status: 'closed', reason: `${closed}のためお休みです` };
    return null;
  }

  function tooSoon(d, start, settings, now) {
    return d === now.date && start < now.minutes + settings.minNoticeMinutes;
  }

  function seatArea(value) {
    const area = text(value, { field: '席の希望', max: 20 });
    if (area && !listAreas().some((a) => a.name === area)) throw new AppError('選べない席です');
    return area;
  }

  /** その日の時間ごとの空き。日付の問題があれば理由を返す */
  function computeSlots(d, partySize, area, settings, now) {
    const problem = publicDateProblem(d, settings, now.date);
    if (problem) return { ...problem, slots: [] };
    if (partySize > settings.maxPartySize) {
      return {
        status: 'phone',
        reason: `${settings.maxPartySize + 1}名様以上のご予約はお電話でお問い合わせください`,
        slots: [],
      };
    }
    const tables = sql.activeTablesBySize.all();
    const reservations = sql.reservationsOnDate.all(d);
    const slots = slotStarts(settings).map((start) => {
      const end = start + settings.stayMinutes;
      const available =
        !tooSoon(d, start, settings, now) &&
        overCapacity(settings, reservations, start, end, partySize) === null &&
        freeTables({ tables, reservations, start, end, partySize, area }).length > 0;
      return { time: fromMinutes(start), available };
    });
    const open = slots.filter((s) => s.available).length;
    return { status: open === 0 ? 'full' : open <= FEW_SLOTS ? 'few' : 'open', reason: null, slots };
  }

  function availability(d, partySizeInput, areaInput = '') {
    date(d);
    const partySize = integer(partySizeInput, { field: '人数', min: 1, max: 99 });
    const area = seatArea(areaInput);
    const result = computeSlots(d, partySize, area, getSettings(), clock());
    return { date: d, partySize, area, open: result.slots.length > 0, ...result };
  }

  /** 1か月分の ◯△×休 */
  function calendar(month, partySizeInput, areaInput = '') {
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new AppError('月の指定が正しくありません');
    }
    const partySize = integer(partySizeInput, { field: '人数', min: 1, max: 99 });
    const area = seatArea(areaInput);
    const settings = getSettings();
    const now = clock();
    const days = [];
    for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) {
      const { status, reason } = computeSlots(d, partySize, area, settings, now);
      days.push({ date: d, status, reason });
    }
    return { month, partySize, area, today: now.date, days };
  }

  function publicInfo() {
    const s = getSettings();
    const today = clock().date;
    const lastBookableDate = addDays(today, s.bookingDaysAhead);
    return {
      storeName: s.storeName,
      storePhone: s.storePhone,
      storeAddress: s.storeAddress,
      lineFriendUrl: s.lineFriendUrl,
      openTime: s.openTime,
      closeTime: s.closeTime,
      stayMinutes: s.stayMinutes,
      maxPartySize: s.maxPartySize,
      closedWeekdays: s.closedWeekdays,
      closures: listClosures({ from: today }).filter((c) => c.date <= addDays(today, 90)),
      areas: listAreas(),
      today,
      lastBookableDate,
    };
  }

  // ---- お客様（連絡先） ----

  /** 電話番号でお客様を探し、なければ作る。お知らせの希望は「はい」の時だけ上書きする */
  function upsertCustomer({ name, phone: phoneValue, email: emailValue, notifyEmail }) {
    const digits = digitsOnly(phoneValue);
    if (!digits) return null;
    const existing = sql.customerByDigits.get(digits);
    const nowIso = timestamp();
    if (existing) {
      const mail = emailValue || existing.email;
      sql.updateCustomerContact.run({
        id: existing.id,
        name,
        phone: phoneValue,
        email: mail,
        notifyEmail: existing.notify_email || (notifyEmail && mail ? 1 : 0),
        now: nowIso,
      });
      return existing.id;
    }
    const { lastInsertRowid } = sql.insertCustomer.run({
      name,
      phone: phoneValue,
      digits,
      email: emailValue,
      notifyEmail: notifyEmail && emailValue ? 1 : 0,
      token: randomBytes(16).toString('hex'),
      now: nowIso,
    });
    return Number(lastInsertRowid);
  }

  // ---- 予約 ----

  function itemsByReservation(ids) {
    const map = new Map(ids.map((id) => [id, []]));
    if (ids.length === 0) return map;
    for (const row of sql.itemsFor.all(JSON.stringify(ids))) map.get(row.reservation_id)?.push(toItem(row));
    return map;
  }

  function withItems(rows, mapper = toReservation) {
    const items = itemsByReservation(rows.map((r) => r.id));
    return rows.map((r) => mapper(r, items.get(r.id)));
  }

  /** 予約で選んだメニューを確かめる。お客様は「予約で選べる」かつ「その曜日にある」ものだけ */
  function resolveItems(input, d, { staff }) {
    if (input == null) return [];
    if (!Array.isArray(input) || input.length > 30) throw new AppError('メニューの指定が正しくありません');
    const merged = new Map();
    for (const entry of input) {
      const id = integer(entry?.menuItemId, { field: 'メニュー', min: 1, max: 2 ** 31 });
      const quantity = integer(entry?.quantity, { field: 'メニューの数', min: 0, max: 50 });
      if (quantity > 0) merged.set(id, Math.min((merged.get(id) ?? 0) + quantity, 50));
    }
    const day = weekday(d);
    return [...merged].map(([id, quantity]) => {
      const row = sql.menuItem.get(id);
      if (!row) throw new AppError('選んだメニューが見つかりません。もう一度選び直してください');
      if (!staff) {
        if (!row.active || !row.preorder) throw new AppError(`「${row.name}」は予約では選べません`);
        const days = JSON.parse(row.weekdays);
        if (days.length > 0 && !days.includes(day)) throw new AppError(`「${row.name}」はこの曜日にはありません`);
      }
      return { menuItemId: id, name: row.name, price: row.price, quantity };
    });
  }

  function newCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
      if (!sql.reservationByCode.get(code)) return code;
    }
    throw new AppError('予約番号を作れませんでした。もう一度お試しください', 500);
  }

  function saveItems(reservationId, items) {
    sql.deleteItems.run(reservationId);
    for (const it of items) sql.insertItem.run(reservationId, it.menuItemId, it.name, it.price, it.quantity);
  }

  function insert(data) {
    const { lastInsertRowid } = sql.insertReservation.run({
      code: newCode(),
      date: data.date,
      start: fromMinutes(data.start),
      end: fromMinutes(data.end),
      partySize: data.partySize,
      tableId: data.tableId,
      customerId: data.customerId,
      seatRequest: data.seatRequest,
      name: data.name,
      phone: data.phone,
      email: data.email,
      note: data.note,
      status: data.status,
      source: data.source,
      now: timestamp(),
    });
    saveItems(Number(lastInsertRowid), data.items);
    return Number(lastInsertRowid);
  }

  /** お客様のWeb予約 */
  function createPublicReservation(input = {}) {
    const settings = getSettings();
    const d = date(input.date);
    const start = toMinutes(time(input.time, '時間'));
    const partySize = integer(input.partySize, { field: '人数', min: 1, max: settings.maxPartySize });
    const area = seatArea(input.seatRequest);
    const data = {
      date: d,
      start,
      end: start + settings.stayMinutes,
      partySize,
      seatRequest: area,
      name: text(input.name, { field: 'お名前', max: 50, required: true }),
      phone: phone(input.phone, { required: true }),
      email: email(input.email),
      note: text(input.note, { field: 'ご要望', max: 500, multiline: true }),
      status: 'confirmed',
      source: 'web',
    };
    data.items = resolveItems(input.items, d, { staff: false });
    const notifyEmail = bool(input.notifyEmail);

    const now = clock();
    const problem = publicDateProblem(d, settings, now.date);
    if (problem) throw new AppError(problem.reason);
    if (!slotStarts(settings).includes(start)) throw new AppError('この時間は選べません');
    if (tooSoon(d, start, settings, now)) throw new AppError('この時間の受付は終了しました');

    const id = tx(() => {
      const reservations = sql.reservationsOnDate.all(d);
      const full = () =>
        new AppError('申し訳ありません。この時間は満席になりました。別の時間をお選びください', 409);
      if (overCapacity(settings, reservations, data.start, data.end, partySize) !== null) throw full();
      const free = freeTables({
        tables: sql.activeTablesBySize.all(),
        reservations,
        start: data.start,
        end: data.end,
        partySize,
        area,
      });
      if (free.length === 0) {
        if (area) throw new AppError(`申し訳ありません。この時間は「${area}」の席が埋まりました`, 409);
        throw full();
      }
      const customerId = upsertCustomer({ name: data.name, phone: data.phone, email: data.email, notifyEmail });
      return insert({ ...data, tableId: free[0].id, customerId });
    });
    const row = sql.reservation.get(id);
    return { publicView: withItems([row], toPublicReservation)[0], reservation: withItems([row])[0] };
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
    return withItems([findOwnReservation(code, phoneInput)], toPublicReservation)[0];
  }

  function cancelByCustomer({ code, phone: phoneInput } = {}) {
    const row = findOwnReservation(code, phoneInput);
    if (row.status === 'cancelled') throw new AppError('この予約はすでにキャンセルされています', 409);
    if (row.status !== 'confirmed') throw new AppError('この予約はキャンセルできません', 409);
    const now = clock();
    if (row.date < now.date || (row.date === now.date && toMinutes(row.start_time) <= now.minutes)) {
      throw new AppError('予約時間を過ぎているためキャンセルできません。お店にお電話ください', 409);
    }
    sql.setStatus.run('cancelled', timestamp(), row.id);
    return withItems([sql.reservationByCode.get(row.code)], toPublicReservation)[0];
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
      seatRequest: text(pick('seatRequest', existing?.seatRequest), { field: '席の希望', max: 20 }),
      name: text(pick('name', existing?.name), { field: 'お名前', max: 50, required: true }),
      phone: phone(pick('phone', existing?.phone), { required: false }),
      email: email(pick('email', existing?.email)),
      note: text(pick('note', existing?.note), { field: 'メモ', max: 500, multiline: true }),
      status,
      source,
      items:
        input.items !== undefined
          ? resolveItems(input.items, d, { staff: true })
          : (existing?.items ?? []),
    };
  }

  /** テーブルを決める。指定がなければ空いている一番小さいテーブルを使う */
  function resolveTable(data, settings, { excludeId = null, allowOverCapacity = false } = {}) {
    const reservations = sql.reservationsOnDate.all(data.date);
    const occupying = OCCUPYING.has(data.status);

    if (occupying && !allowOverCapacity) {
      const peak = overCapacity(settings, reservations, data.start, data.end, data.partySize, excludeId);
      if (peak !== null) {
        throw new AppError(
          `この時間帯は最大${settings.maxGuestsPerSlot}名までです（すでに${peak}名の予約があります）`,
          409,
          { code: 'over_capacity' },
        );
      }
    }

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
    if (!occupying) return table.id;
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
    return withItems([row])[0];
  }

  function listReservations(d) {
    return withItems(sql.reservationsForDay.all(date(d)));
  }

  function customerReservations(customerId) {
    return withItems(sql.reservationsOfCustomer.all(customerId));
  }

  function searchReservations(query) {
    const q = text(query, { field: '検索語', max: 50 });
    if (!q) return [];
    const digits = digitsOnly(q);
    const rows = sql.search.all({
      text: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      code: normalizeWidth(q).toUpperCase(),
      digits: digits.length >= 3 ? digits : '',
      digitsLike: `%${digits}%`,
    });
    return withItems(rows);
  }

  function createStaffReservation(input = {}) {
    const settings = getSettings();
    const data = buildStaffReservation(input, settings);
    const id = tx(() => {
      const tableId = resolveTable(data, settings, { allowOverCapacity: bool(input.allowOverCapacity) });
      const customerId = data.phone
        ? upsertCustomer({ name: data.name, phone: data.phone, email: data.email, notifyEmail: false })
        : null;
      return insert({ ...data, tableId, customerId });
    });
    return getReservation(id);
  }

  function updateStaffReservation(id, input = {}) {
    const existing = getReservation(id);
    const settings = getSettings();
    const data = buildStaffReservation(input, settings, existing);
    return tx(() => {
      const tableId = resolveTable(data, settings, {
        excludeId: existing.id,
        allowOverCapacity: bool(input.allowOverCapacity),
      });
      const contactChanged = data.phone !== existing.phone || data.name !== existing.name || data.email !== existing.email;
      const customerId =
        data.phone && (contactChanged || !existing.customerId)
          ? upsertCustomer({ name: data.name, phone: data.phone, email: data.email, notifyEmail: false })
          : data.phone
            ? existing.customerId
            : null;
      sql.updateReservation.run({
        id: existing.id,
        date: data.date,
        start: fromMinutes(data.start),
        end: fromMinutes(data.end),
        partySize: data.partySize,
        tableId,
        customerId,
        seatRequest: data.seatRequest,
        name: data.name,
        phone: data.phone,
        email: data.email,
        note: data.note,
        status: data.status,
        source: data.source,
        now: timestamp(),
      });
      if (input.items !== undefined) saveItems(existing.id, data.items);
      return getReservation(existing.id);
    });
  }

  function deleteReservation(id) {
    const existing = getReservation(id);
    sql.deleteReservation.run(existing.id);
    return existing;
  }

  return {
    today: () => clock().date,
    clock,
    getSettings,
    updateSettings,
    publicInfo,
    listTables,
    listAreas,
    createTable,
    updateTable,
    deleteTable,
    listClosures,
    addClosure,
    removeClosure,
    availability,
    calendar,
    createPublicReservation,
    lookupReservation,
    cancelByCustomer,
    getReservation,
    listReservations,
    customerReservations,
    searchReservations,
    createStaffReservation,
    updateStaffReservation,
    deleteReservation,
    upsertCustomer,
  };
}
