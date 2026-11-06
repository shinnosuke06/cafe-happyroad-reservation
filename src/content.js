// メニューとお知らせ（予約ページに載せる内容）
import { transaction } from './db.js';
import { weekday } from './time.js';
import { AppError, text, integer, bool, date, optionalDate, weekdays } from './validate.js';
import { isUploadName } from './uploads.js';

function toMenuItem(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    price: row.price,
    photo: row.photo,
    photoUrl: row.photo ? `/uploads/${row.photo}` : '',
    weekdays: JSON.parse(row.weekdays),
    preorder: row.preorder === 1,
    active: row.active === 1,
    sortOrder: row.sort_order,
  };
}

function toPublicMenuItem(row) {
  const { id, name, description, category, price, photoUrl, weekdays: days, preorder } = toMenuItem(row);
  return { id, name, description, category, price, photoUrl, weekdays: days, preorder };
}

function toAnnouncement(row) {
  return { id: row.id, title: row.title, body: row.body, startsOn: row.starts_on, endsOn: row.ends_on, createdAt: row.created_at };
}

export function createContent(db, { now = () => new Date(), today }) {
  const timestamp = () => new Date(now()).toISOString();

  const sql = {
    all: db.prepare('SELECT * FROM menu_items ORDER BY sort_order, id'),
    active: db.prepare('SELECT * FROM menu_items WHERE active = 1 ORDER BY sort_order, id'),
    get: db.prepare('SELECT * FROM menu_items WHERE id = ?'),
    maxSort: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max FROM menu_items'),
    insert: db.prepare(`
      INSERT INTO menu_items (name, description, category, price, photo, weekdays, preorder, active, sort_order, created_at, updated_at)
      VALUES (:name, :description, :category, :price, :photo, :weekdays, :preorder, :active, :sortOrder, :now, :now)`),
    update: db.prepare(`
      UPDATE menu_items SET name = :name, description = :description, category = :category, price = :price,
        photo = :photo, weekdays = :weekdays, preorder = :preorder, active = :active, updated_at = :now
      WHERE id = :id`),
    setSort: db.prepare('UPDATE menu_items SET sort_order = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM menu_items WHERE id = ?'),
    photoInUse: db.prepare('SELECT COUNT(*) AS count FROM menu_items WHERE photo = ?'),
    announcements: db.prepare('SELECT * FROM announcements ORDER BY COALESCE(starts_on, created_at) DESC, id DESC LIMIT 100'),
    activeAnnouncements: db.prepare(`
      SELECT * FROM announcements
      WHERE (starts_on IS NULL OR starts_on <= :today) AND (ends_on IS NULL OR ends_on >= :today)
      ORDER BY COALESCE(starts_on, created_at) DESC, id DESC LIMIT 10`),
    insertAnnouncement: db.prepare(
      'INSERT INTO announcements (title, body, starts_on, ends_on, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    announcement: db.prepare('SELECT * FROM announcements WHERE id = ?'),
    deleteAnnouncement: db.prepare('DELETE FROM announcements WHERE id = ?'),
  };

  function getRow(id) {
    const row = sql.get.get(Number(id));
    if (!row) throw new AppError('メニューが見つかりません', 404);
    return row;
  }

  function validate(input, existing) {
    const pick = (key, fallback) => (input[key] !== undefined ? input[key] : fallback);
    const photo = pick('photo', existing?.photo ?? '');
    if (photo !== '' && !isUploadName(photo)) throw new AppError('写真の指定が正しくありません');
    return {
      name: text(pick('name', existing?.name), { field: 'メニュー名', max: 40, required: true }),
      description: text(pick('description', existing?.description), { field: '説明', max: 300, multiline: true }),
      category: text(pick('category', existing?.category), { field: '分類', max: 20 }),
      price: integer(pick('price', existing?.price ?? 0), { field: '値段', min: 0, max: 1000000 }),
      photo,
      weekdays: JSON.stringify(weekdays(pick('weekdays', existing ? JSON.parse(existing.weekdays) : []))),
      preorder: bool(pick('preorder', existing ? existing.preorder === 1 : true)) ? 1 : 0,
      active: bool(pick('active', existing ? existing.active === 1 : true)) ? 1 : 0,
    };
  }

  function listMenu() {
    return sql.all.all().map(toMenuItem);
  }

  /** お客様向け。日付があればその曜日に出しているものだけ */
  function publicMenu(d) {
    const rows = sql.active.all();
    if (d == null || d === '') return { date: null, items: rows.map(toPublicMenuItem) };
    const day = weekday(date(d));
    const items = rows
      .filter((r) => {
        const days = JSON.parse(r.weekdays);
        return days.length === 0 || days.includes(day);
      })
      .map(toPublicMenuItem);
    return { date: d, items };
  }

  function createMenuItem(input = {}) {
    const data = validate(input, null);
    const { lastInsertRowid } = sql.insert.run({ ...data, sortOrder: sql.maxSort.get().max + 1, now: timestamp() });
    return toMenuItem(sql.get.get(lastInsertRowid));
  }

  /** 更新する。写真を差し替えたら古い写真の名前も返す（あとでファイルを消すため） */
  function updateMenuItem(id, input = {}) {
    const row = getRow(id);
    const data = validate(input, row);
    sql.update.run({ ...data, id: row.id, now: timestamp() });
    const replaced = row.photo && row.photo !== data.photo && sql.photoInUse.get(row.photo).count === 0 ? row.photo : null;
    return { item: toMenuItem(sql.get.get(row.id)), unusedPhoto: replaced };
  }

  function deleteMenuItem(id) {
    const row = getRow(id);
    sql.remove.run(row.id);
    const unusedPhoto = row.photo && sql.photoInUse.get(row.photo).count === 0 ? row.photo : null;
    return { item: toMenuItem(row), unusedPhoto };
  }

  /** 並び順を1つ上（-1）か下（+1）へ */
  function moveMenuItem(id, direction) {
    const step = direction === 'up' || Number(direction) < 0 ? -1 : 1;
    return transaction(db, () => {
      const rows = sql.all.all();
      rows.forEach((r, i) => sql.setSort.run(i + 1, r.id)); // 番号を振り直す
      const index = rows.findIndex((r) => r.id === Number(id));
      if (index === -1) throw new AppError('メニューが見つかりません', 404);
      const other = index + step;
      if (other >= 0 && other < rows.length) {
        sql.setSort.run(other + 1, rows[index].id);
        sql.setSort.run(index + 1, rows[other].id);
      }
      return listMenu();
    });
  }

  // ---- お知らせ（予約ページに掲載） ----

  function listAnnouncements() {
    return sql.announcements.all().map(toAnnouncement);
  }

  function activeAnnouncements() {
    return sql.activeAnnouncements.all({ today: today() }).map(({ id, title, body, starts_on: startsOn, ends_on: endsOn }) => ({
      id,
      title,
      body,
      startsOn,
      endsOn,
    }));
  }

  function createAnnouncement(input = {}) {
    const title = text(input.title, { field: 'お知らせの見出し', max: 60, required: true });
    const body = text(input.body, { field: 'お知らせの本文', max: 1000, multiline: true });
    const startsOn = optionalDate(input.startsOn, '掲載開始日');
    const endsOn = optionalDate(input.endsOn, '掲載終了日');
    if (startsOn && endsOn && endsOn < startsOn) throw new AppError('掲載終了日は開始日より後にしてください');
    const { lastInsertRowid } = sql.insertAnnouncement.run(title, body, startsOn, endsOn, timestamp());
    return toAnnouncement(sql.announcement.get(lastInsertRowid));
  }

  function deleteAnnouncement(id) {
    const row = sql.announcement.get(Number(id));
    if (!row) throw new AppError('お知らせが見つかりません', 404);
    sql.deleteAnnouncement.run(row.id);
    return toAnnouncement(row);
  }

  return {
    listMenu,
    publicMenu,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
    moveMenuItem,
    listAnnouncements,
    activeAnnouncements,
    createAnnouncement,
    deleteAnnouncement,
  };
}
