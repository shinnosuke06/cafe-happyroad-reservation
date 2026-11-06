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
import { randomHex, randomIndex } from './random.js';

export { AppError };

export const STATUSES = ['confirmed', 'arrived', 'cancelled', 'no_show'];
export const SOURCES = ['web', 'phone', 'walkin'];
// 席を使っている状態。キャンセル・無断キャンセルは席を空ける。
const OCCUPYING = new Set(['confirmed', 'arrived']);
const OCCUPYING_SQL = "('confirmed', 'arrived')";
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
  return { id: row.id, name: row.name, seats: row.seats, area: row.area, active: row.active === 1, sortOrder: row.sort_order };
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

const RESERVATION_SELECT = `
  SELECT r.*, t.name AS table_name, t.area AS table_area FROM reservations r
  LEFT JOIN tables t ON t.id = r.table_id`;

// 同じテーブル・重なる時間に、席を使っている予約がないときだけ書き込む（同時に予約が来ても二重にならない）
const NO_CLASH = `NOT EXISTS (
  SELECT 1 FROM reservations o
  WHERE o.table_id = ? AND o.date = ? AND o.id <> ? AND o.status IN ${OCCUPYING_SQL}
    AND o.start_time < ? AND ? < o.end_time)`;

export function createStore(db, { now = () => new Date(), timezone = 'Asia/Tokyo' } = {}) {
  const clock = () => nowInZone(timezone, now());
  const timestamp = () => new Date(now()).toISOString();

  // ---- 設定 ----

  async function getSettings() {
    const settings = structuredClone(DEFAULT_SETTINGS);
    for (const { key, value } of await db.all('SELECT key, value FROM settings')) {
      if (key in DEFAULT_SETTINGS) settings[key] = JSON.parse(value);
    }
    return settings;
  }

  async function updateSettings(patch = {}) {
    const next = await getSettings();
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
    await db.batch(
      Object.entries(s).map(([key, value]) => [
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)],
      ]),
    );
    return s;
  }

  // ---- テーブル（席） ----

  async function listTables() {
    return (await db.all('SELECT * FROM tables ORDER BY sort_order, id')).map(toTable);
  }

  const activeTablesBySize = () => db.all('SELECT * FROM tables WHERE active = 1 ORDER BY seats, sort_order, id');

  async function listAreas() {
    const rows = await db.all(
      "SELECT area, MAX(seats) AS max_seats FROM tables WHERE active = 1 AND area <> '' GROUP BY area ORDER BY MIN(sort_order)",
    );
    return rows.map((r) => ({ name: r.area, maxSeats: r.max_seats }));
  }

  async function getTableRow(id) {
    const row = await db.get('SELECT * FROM tables WHERE id = ?', [Number(id)]);
    if (!row) throw new AppError('テーブルが見つかりません', 404);
    return row;
  }

  async function createTable(input = {}) {
    const name = text(input.name, { field: 'テーブル名', max: 30, required: true });
    const seats = integer(input.seats, { field: '席数', min: 1, max: 50 });
    const area = text(input.area, { field: '席の種類', max: 20 });
    const { max } = await db.get('SELECT COALESCE(MAX(sort_order), 0) AS max FROM tables');
    const { lastRowId } = await db.run('INSERT INTO tables (name, seats, area, active, sort_order) VALUES (?, ?, ?, 1, ?)', [
      name,
      seats,
      area,
      max + 1,
    ]);
    return toTable(await getTableRow(lastRowId));
  }

  async function updateTable(id, input = {}) {
    const row = await getTableRow(id);
    const name = text(input.name ?? row.name, { field: 'テーブル名', max: 30, required: true });
    const seats = integer(input.seats ?? row.seats, { field: '席数', min: 1, max: 50 });
    const area = text(input.area ?? row.area, { field: '席の種類', max: 20 });
    const active = input.active === undefined ? row.active : bool(input.active) ? 1 : 0;
    const sortOrder = integer(input.sortOrder ?? row.sort_order, { field: '並び順', min: 0, max: 9999 });
    await db.run('UPDATE tables SET name = ?, seats = ?, area = ?, active = ?, sort_order = ? WHERE id = ?', [
      name,
      seats,
      area,
      active,
      sortOrder,
      row.id,
    ]);
    return toTable(await getTableRow(row.id));
  }

  async function deleteTable(id) {
    const row = await getTableRow(id);
    const { count } = await db.get('SELECT COUNT(*) AS count FROM reservations WHERE table_id = ?', [row.id]);
    if (count > 0) {
      throw new AppError('予約の記録があるテーブルは削除できません。「使う」のチェックを外してください', 409);
    }
    await db.run('DELETE FROM tables WHERE id = ?', [row.id]);
  }

  // ---- 休業日 ----

  async function listClosures({ from } = {}) {
    const rows = await db.all('SELECT * FROM closures WHERE date >= ? ORDER BY date', [from ?? clock().date]);
    return rows.map((r) => ({ date: r.date, reason: r.reason }));
  }

  async function addClosure(input = {}) {
    const d = date(input.date);
    const reason = text(input.reason, { field: '理由', max: 50 });
    await db.run(
      'INSERT INTO closures (date, reason) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET reason = excluded.reason',
      [d, reason],
    );
    const { count } = await db.get(
      `SELECT COUNT(*) AS count FROM reservations WHERE date = ? AND status IN ${OCCUPYING_SQL}`,
      [d],
    );
    return { date: d, reason, reservations: count };
  }

  async function removeClosure(d) {
    await db.run('DELETE FROM closures WHERE date = ?', [date(d)]);
  }

  function closedReason(d, settings, closures) {
    if (settings.closedWeekdays.includes(weekday(d))) return '定休日';
    const closure = closures.get(d);
    if (closure !== undefined) return closure ? `臨時休業（${closure}）` : '臨時休業';
    return null;
  }

  /** from〜to の休業日と予約をまとめて読む（1日ずつ読むと遅いため） */
  async function loadRange(from, to) {
    const [closureRows, reservationRows] = await Promise.all([
      db.all('SELECT date, reason FROM closures WHERE date BETWEEN ? AND ?', [from, to]),
      db.all('SELECT * FROM reservations WHERE date BETWEEN ? AND ?', [from, to]),
    ]);
    const byDate = new Map();
    for (const r of reservationRows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    return { closures: new Map(closureRows.map((c) => [c.date, c.reason])), byDate };
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
  function publicDateProblem(d, settings, today, closures) {
    if (d < today) return { status: 'past', reason: '過去の日付は予約できません' };
    if (d > addDays(today, settings.bookingDaysAhead)) {
      return { status: 'outside', reason: `ご予約は${settings.bookingDaysAhead}日先まで受け付けています` };
    }
    const closed = closedReason(d, settings, closures);
    if (closed) return { status: 'closed', reason: `${closed}のためお休みです` };
    return null;
  }

  function tooSoon(d, start, settings, now) {
    return d === now.date && start < now.minutes + settings.minNoticeMinutes;
  }

  async function seatArea(value) {
    const area = text(value, { field: '席の希望', max: 20 });
    if (area && !(await listAreas()).some((a) => a.name === area)) throw new AppError('選べない席です');
    return area;
  }

  /** その日の時間ごとの空き。日付の問題があれば理由を返す */
  function computeSlots(d, partySize, area, { settings, now, tables, closures, reservations }) {
    const problem = publicDateProblem(d, settings, now.date, closures);
    if (problem) return { ...problem, slots: [] };
    if (partySize > settings.maxPartySize) {
      return {
        status: 'phone',
        reason: `${settings.maxPartySize + 1}名様以上のご予約はお電話でお問い合わせください`,
        slots: [],
      };
    }
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

  async function availability(d, partySizeInput, areaInput = '') {
    date(d);
    const partySize = integer(partySizeInput, { field: '人数', min: 1, max: 99 });
    const area = await seatArea(areaInput);
    const [settings, tables, range] = await Promise.all([getSettings(), activeTablesBySize(), loadRange(d, d)]);
    const result = computeSlots(d, partySize, area, {
      settings,
      now: clock(),
      tables,
      closures: range.closures,
      reservations: range.byDate.get(d) ?? [],
    });
    return { date: d, partySize, area, open: result.slots.length > 0, ...result };
  }

  /** 1か月分の ◯△×休 */
  async function calendar(month, partySizeInput, areaInput = '') {
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new AppError('月の指定が正しくありません');
    }
    const partySize = integer(partySizeInput, { field: '人数', min: 1, max: 99 });
    const area = await seatArea(areaInput);
    const [settings, tables, range] = await Promise.all([
      getSettings(),
      activeTablesBySize(),
      loadRange(`${month}-01`, `${month}-31`),
    ]);
    const now = clock();
    const days = [];
    for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) {
      const { status, reason } = computeSlots(d, partySize, area, {
        settings,
        now,
        tables,
        closures: range.closures,
        reservations: range.byDate.get(d) ?? [],
      });
      days.push({ date: d, status, reason });
    }
    return { month, partySize, area, today: now.date, days };
  }

  async function publicInfo() {
    const s = await getSettings();
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
      closures: (await listClosures({ from: today })).filter((c) => c.date <= addDays(today, 90)),
      areas: await listAreas(),
      today,
      lastBookableDate,
    };
  }

  // ---- お客様（連絡先） ----

  /** 電話番号でお客様を探し、なければ作る。お知らせの希望は「はい」の時だけ上書きする */
  async function upsertCustomer({ name, phone: phoneValue, email: emailValue, notifyEmail }) {
    const digits = digitsOnly(phoneValue);
    if (!digits) return null;
    const nowIso = timestamp();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await db.get('SELECT * FROM customers WHERE phone_digits = ?', [digits]);
      if (existing) {
        const mail = emailValue || existing.email;
        await db.run('UPDATE customers SET name = ?, phone = ?, email = ?, notify_email = ?, updated_at = ? WHERE id = ?', [
          name,
          phoneValue,
          mail,
          existing.notify_email || (notifyEmail && mail ? 1 : 0),
          nowIso,
          existing.id,
        ]);
        return existing.id;
      }
      try {
        const { lastRowId } = await db.run(
          `INSERT INTO customers (name, phone, phone_digits, email, notify_email, unsubscribe_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [name, phoneValue, digits, emailValue, notifyEmail && emailValue ? 1 : 0, randomHex(16), nowIso, nowIso],
        );
        return lastRowId;
      } catch (err) {
        // 同じ電話番号の予約がほぼ同時に来たとき。もう一度探し直す
        if (attempt === 1 || !/UNIQUE/i.test(String(err?.message))) throw err;
      }
    }
    return null;
  }

  // ---- 予約 ----

  async function itemsByReservation(ids) {
    const map = new Map(ids.map((id) => [id, []]));
    if (ids.length === 0) return map;
    const rows = await db.all(
      'SELECT * FROM reservation_items WHERE reservation_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
      [JSON.stringify(ids)],
    );
    for (const row of rows) map.get(row.reservation_id)?.push(toItem(row));
    return map;
  }

  async function withItems(rows, mapper = toReservation) {
    const items = await itemsByReservation(rows.map((r) => r.id));
    return rows.map((r) => mapper(r, items.get(r.id)));
  }

  /** 予約で選んだメニューを確かめる。お客様は「予約で選べる」かつ「その曜日にある」ものだけ */
  async function resolveItems(input, d, { staff }) {
    if (input == null) return [];
    if (!Array.isArray(input) || input.length > 30) throw new AppError('メニューの指定が正しくありません');
    const merged = new Map();
    for (const entry of input) {
      const id = integer(entry?.menuItemId, { field: 'メニュー', min: 1, max: 2 ** 31 });
      const quantity = integer(entry?.quantity, { field: 'メニューの数', min: 0, max: 50 });
      if (quantity > 0) merged.set(id, Math.min((merged.get(id) ?? 0) + quantity, 50));
    }
    if (merged.size === 0) return [];
    const rows = await db.all('SELECT * FROM menu_items WHERE id IN (SELECT value FROM json_each(?))', [
      JSON.stringify([...merged.keys()]),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const day = weekday(d);
    return [...merged].map(([id, quantity]) => {
      const row = byId.get(id);
      if (!row) throw new AppError('選んだメニューが見つかりません。もう一度選び直してください');
      if (!staff) {
        if (!row.active || !row.preorder) throw new AppError(`「${row.name}」は予約では選べません`);
        const days = JSON.parse(row.weekdays);
        if (days.length > 0 && !days.includes(day)) throw new AppError(`「${row.name}」はこの曜日にはありません`);
      }
      return { menuItemId: id, name: row.name, price: row.price, quantity };
    });
  }

  async function newCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_CHARS[randomIndex(CODE_CHARS.length)];
      if (!(await db.get('SELECT 1 AS found FROM reservations WHERE code = ?', [code]))) return code;
    }
    throw new AppError('予約番号を作れませんでした。もう一度お試しください', 500);
  }

  const itemInsert = (code, it) => [
    'INSERT INTO reservation_items (reservation_id, menu_item_id, name, price, quantity) SELECT id, ?, ?, ?, ? FROM reservations WHERE code = ?',
    [it.menuItemId, it.name, it.price, it.quantity, code],
  ];

  /** 席がまだ空いていれば、予約とメニューをまとめて書き込む。空いていなければ null */
  async function tryInsert(data, { guard }) {
    const code = await newCode();
    const nowIso = timestamp();
    const start = fromMinutes(data.start);
    const end = fromMinutes(data.end);
    const [inserted] = await db.batch([
      [
        `INSERT INTO reservations
           (code, date, start_time, end_time, party_size, table_id, customer_id, seat_request,
            name, phone, email, note, status, source, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ? = 0 OR ${NO_CLASH}`,
        [
          code,
          data.date,
          start,
          end,
          data.partySize,
          data.tableId,
          data.customerId,
          data.seatRequest,
          data.name,
          data.phone,
          data.email,
          data.note,
          data.status,
          data.source,
          nowIso,
          nowIso,
          guard ? 1 : 0,
          data.tableId,
          data.date,
          -1,
          end,
          start,
        ],
      ],
      ...data.items.map((it) => itemInsert(code, it)),
    ]);
    if (inserted.changes === 0) return null;
    return db.get(`${RESERVATION_SELECT} WHERE r.code = ?`, [code]);
  }

  /** お客様のWeb予約 */
  async function createPublicReservation(input = {}) {
    const settings = await getSettings();
    const d = date(input.date);
    const start = toMinutes(time(input.time, '時間'));
    const partySize = integer(input.partySize, { field: '人数', min: 1, max: settings.maxPartySize });
    const area = await seatArea(input.seatRequest);
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
    data.items = await resolveItems(input.items, d, { staff: false });
    const notifyEmail = bool(input.notifyEmail);

    const now = clock();
    const { closures } = await loadRange(d, d);
    const problem = publicDateProblem(d, settings, now.date, closures);
    if (problem) throw new AppError(problem.reason);
    if (!slotStarts(settings).includes(start)) throw new AppError('この時間は選べません');
    if (tooSoon(d, start, settings, now)) throw new AppError('この時間の受付は終了しました');

    const full = () => new AppError('申し訳ありません。この時間は満席になりました。別の時間をお選びください', 409);
    let customerId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reservations = await db.all('SELECT * FROM reservations WHERE date = ?', [d]);
      if (overCapacity(settings, reservations, data.start, data.end, partySize) !== null) throw full();
      const free = freeTables({
        tables: await activeTablesBySize(),
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
      customerId ??= await upsertCustomer({ name: data.name, phone: data.phone, email: data.email, notifyEmail });
      // 小さい席から順に試す。ほぼ同時に埋まった席は飛ばして次の席へ
      for (const table of free) {
        const row = await tryInsert({ ...data, tableId: table.id, customerId }, { guard: true });
        if (row) {
          const [reservation] = await withItems([row]);
          return { publicView: toPublicReservation(row, reservation.items), reservation };
        }
      }
    }
    throw full();
  }

  async function findOwnReservation(code, phoneInput) {
    const normalized = normalizeWidth(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const digits = digitsOnly(phoneInput);
    const row = normalized ? await db.get('SELECT * FROM reservations WHERE code = ?', [normalized]) : null;
    if (!row || !digits || digitsOnly(row.phone) !== digits) {
      throw new AppError('予約が見つかりません。予約番号と電話番号をご確認ください', 404);
    }
    return row;
  }

  async function lookupReservation({ code, phone: phoneInput } = {}) {
    return (await withItems([await findOwnReservation(code, phoneInput)], toPublicReservation))[0];
  }

  async function cancelByCustomer({ code, phone: phoneInput } = {}) {
    const row = await findOwnReservation(code, phoneInput);
    if (row.status === 'cancelled') throw new AppError('この予約はすでにキャンセルされています', 409);
    if (row.status !== 'confirmed') throw new AppError('この予約はキャンセルできません', 409);
    const now = clock();
    if (row.date < now.date || (row.date === now.date && toMinutes(row.start_time) <= now.minutes)) {
      throw new AppError('予約時間を過ぎているためキャンセルできません。お店にお電話ください', 409);
    }
    await db.run("UPDATE reservations SET status = 'cancelled', updated_at = ? WHERE id = ?", [timestamp(), row.id]);
    return (await withItems([await db.get('SELECT * FROM reservations WHERE id = ?', [row.id])], toPublicReservation))[0];
  }

  /** 管理画面からの入力を、既存の予約（編集時）に重ねて組み立てる */
  async function buildStaffReservation(input, settings, existing = null) {
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
      items: input.items !== undefined ? await resolveItems(input.items, d, { staff: true }) : (existing?.items ?? []),
    };
  }

  /** テーブルを決める。指定がなければ空いている一番小さいテーブルを使う */
  async function resolveTable(data, settings, { excludeId = null, allowOverCapacity = false } = {}) {
    const reservations = await db.all('SELECT * FROM reservations WHERE date = ?', [data.date]);
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
        tables: await activeTablesBySize(),
        reservations,
        start: data.start,
        end: data.end,
        partySize: data.partySize,
        excludeId,
      });
      if (free.length === 0) throw new AppError('この時間に人数に合う空きテーブルがありません', 409);
      return free[0].id;
    }

    const table = await getTableRow(data.tableId);
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

  const clashError = () => new AppError('ほかの方がちょうど同じ席に予約を入れました。もう一度保存してください', 409);

  async function getReservation(id) {
    const row = await db.get(`${RESERVATION_SELECT} WHERE r.id = ?`, [Number(id)]);
    if (!row) throw new AppError('予約が見つかりません', 404);
    return (await withItems([row]))[0];
  }

  async function listReservations(d) {
    return withItems(
      await db.all(`${RESERVATION_SELECT} WHERE r.date = ? ORDER BY r.start_time, t.sort_order, r.id`, [date(d)]),
    );
  }

  async function customerReservations(customerId) {
    return withItems(
      await db.all(`${RESERVATION_SELECT} WHERE r.customer_id = ? ORDER BY r.date DESC, r.start_time DESC LIMIT 200`, [
        customerId,
      ]),
    );
  }

  async function searchReservations(query) {
    const q = text(query, { field: '検索語', max: 50 });
    if (!q) return [];
    const digits = digitsOnly(q);
    const usePhone = digits.length >= 3;
    const rows = await db.all(
      `${RESERVATION_SELECT}
       WHERE r.name LIKE ? ESCAPE '\\' OR r.code = ?
          OR (? = 1 AND REPLACE(REPLACE(REPLACE(r.phone, '-', ''), ' ', ''), '+', '') LIKE ?)
       ORDER BY r.date DESC, r.start_time DESC LIMIT 100`,
      [`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, normalizeWidth(q).toUpperCase(), usePhone ? 1 : 0, `%${digits}%`],
    );
    return withItems(rows);
  }

  async function createStaffReservation(input = {}) {
    const settings = await getSettings();
    const data = await buildStaffReservation(input, settings);
    const tableId = await resolveTable(data, settings, { allowOverCapacity: bool(input.allowOverCapacity) });
    const customerId = data.phone
      ? await upsertCustomer({ name: data.name, phone: data.phone, email: data.email, notifyEmail: false })
      : null;
    const row = await tryInsert({ ...data, tableId, customerId }, { guard: OCCUPYING.has(data.status) });
    if (!row) throw clashError();
    return getReservation(row.id);
  }

  async function updateStaffReservation(id, input = {}) {
    const existing = await getReservation(id);
    const settings = await getSettings();
    const data = await buildStaffReservation(input, settings, existing);
    const tableId = await resolveTable(data, settings, {
      excludeId: existing.id,
      allowOverCapacity: bool(input.allowOverCapacity),
    });
    const contactChanged = data.phone !== existing.phone || data.name !== existing.name || data.email !== existing.email;
    let customerId = null;
    if (data.phone) {
      customerId =
        contactChanged || !existing.customerId
          ? await upsertCustomer({ name: data.name, phone: data.phone, email: data.email, notifyEmail: false })
          : existing.customerId;
    }
    const start = fromMinutes(data.start);
    const end = fromMinutes(data.end);
    const statements = [
      [
        `UPDATE reservations SET
           date = ?, start_time = ?, end_time = ?, party_size = ?, table_id = ?, customer_id = ?, seat_request = ?,
           name = ?, phone = ?, email = ?, note = ?, status = ?, source = ?, updated_at = ?
         WHERE id = ? AND (? = 0 OR ${NO_CLASH})`,
        [
          data.date,
          start,
          end,
          data.partySize,
          tableId,
          customerId,
          data.seatRequest,
          data.name,
          data.phone,
          data.email,
          data.note,
          data.status,
          data.source,
          timestamp(),
          existing.id,
          OCCUPYING.has(data.status) ? 1 : 0,
          tableId,
          data.date,
          existing.id,
          end,
          start,
        ],
      ],
    ];
    const [updated] = await db.batch(statements);
    if (updated.changes === 0) throw clashError();
    if (input.items !== undefined) {
      await db.batch([
        ['DELETE FROM reservation_items WHERE reservation_id = ?', [existing.id]],
        ...data.items.map((it) => itemInsert(existing.code, it)),
      ]);
    }
    return getReservation(existing.id);
  }

  async function deleteReservation(id) {
    const existing = await getReservation(id);
    await db.run('DELETE FROM reservations WHERE id = ?', [existing.id]);
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
