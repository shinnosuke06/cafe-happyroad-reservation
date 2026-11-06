// メニュー・写真・お知らせ（予約ページに載せる内容）
import { weekday } from './time.js';
import { AppError, text, integer, bool, date, optionalDate, weekdays } from './validate.js';
import { randomHex } from './random.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const PHOTO_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
export const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export const isPhotoName = (name) => typeof name === 'string' && PHOTO_NAME.test(name);

/** ファイルの先頭のバイトから画像の種類を判定する（拡張子や Content-Type は信用しない） */
export function detectImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

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

  async function getRow(id) {
    const row = await db.get('SELECT * FROM menu_items WHERE id = ?', [Number(id)]);
    if (!row) throw new AppError('メニューが見つかりません', 404);
    return row;
  }

  async function validate(input, existing) {
    const pick = (key, fallback) => (input[key] !== undefined ? input[key] : fallback);
    const photo = pick('photo', existing?.photo ?? '');
    if (photo !== '' && !(isPhotoName(photo) && (await db.get('SELECT 1 AS found FROM photos WHERE name = ?', [photo])))) {
      throw new AppError('写真の指定が正しくありません。もう一度写真を選んでください');
    }
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

  /** どのメニューにも使われていない写真を消す */
  async function removePhotoIfUnused(name) {
    if (!name) return;
    await db.run('DELETE FROM photos WHERE name = ? AND NOT EXISTS (SELECT 1 FROM menu_items WHERE photo = ?)', [name, name]);
  }

  async function listMenu() {
    return (await db.all('SELECT * FROM menu_items ORDER BY sort_order, id')).map(toMenuItem);
  }

  /** お客様向け。日付があればその曜日に出しているものだけ */
  async function publicMenu(d) {
    const rows = await db.all('SELECT * FROM menu_items WHERE active = 1 ORDER BY sort_order, id');
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

  async function createMenuItem(input = {}) {
    const data = await validate(input, null);
    const { max } = await db.get('SELECT COALESCE(MAX(sort_order), 0) AS max FROM menu_items');
    const nowIso = timestamp();
    const { lastRowId } = await db.run(
      `INSERT INTO menu_items (name, description, category, price, photo, weekdays, preorder, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.name, data.description, data.category, data.price, data.photo, data.weekdays, data.preorder, data.active, max + 1, nowIso, nowIso],
    );
    return toMenuItem(await getRow(lastRowId));
  }

  async function updateMenuItem(id, input = {}) {
    const row = await getRow(id);
    const data = await validate(input, row);
    await db.run(
      `UPDATE menu_items SET name = ?, description = ?, category = ?, price = ?, photo = ?, weekdays = ?,
         preorder = ?, active = ?, updated_at = ? WHERE id = ?`,
      [data.name, data.description, data.category, data.price, data.photo, data.weekdays, data.preorder, data.active, timestamp(), row.id],
    );
    if (row.photo !== data.photo) await removePhotoIfUnused(row.photo);
    return toMenuItem(await getRow(row.id));
  }

  async function deleteMenuItem(id) {
    const row = await getRow(id);
    await db.run('DELETE FROM menu_items WHERE id = ?', [row.id]);
    await removePhotoIfUnused(row.photo);
    return toMenuItem(row);
  }

  /** 並び順を1つ上（up）か下（down）へ */
  async function moveMenuItem(id, direction) {
    const rows = await db.all('SELECT id FROM menu_items ORDER BY sort_order, id');
    const index = rows.findIndex((r) => r.id === Number(id));
    if (index === -1) throw new AppError('メニューが見つかりません', 404);
    const other = index + (direction === 'up' ? -1 : 1);
    if (other >= 0 && other < rows.length) [rows[index], rows[other]] = [rows[other], rows[index]];
    await db.batch(rows.map((r, i) => ['UPDATE menu_items SET sort_order = ? WHERE id = ?', [i + 1, r.id]]));
    return listMenu();
  }

  // ---- 写真 ----

  /** 中身が JPEG・PNG・WebP のときだけ保存して、名前を返す */
  async function savePhoto(bytes) {
    const ext = detectImage(bytes);
    if (!ext) return null;
    const name = `${randomHex(16)}.${ext}`;
    await db.run('INSERT INTO photos (name, mime, data, created_at) VALUES (?, ?, ?, ?)', [name, IMAGE_TYPES[ext], bytes, timestamp()]);
    // 保存したまま使われなかった古い写真を片づける（1日以上前のもの）
    await db.run(
      'DELETE FROM photos WHERE created_at < ? AND name NOT IN (SELECT photo FROM menu_items)',
      [new Date(new Date(now()).getTime() - 24 * 60 * 60 * 1000).toISOString()],
    );
    return name;
  }

  async function getPhoto(name) {
    if (!isPhotoName(name)) return null;
    const row = await db.get('SELECT mime, data FROM photos WHERE name = ?', [name]);
    if (!row) return null;
    const data = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
    return { mime: row.mime, data };
  }

  // ---- お知らせ（予約ページに掲載） ----

  async function listAnnouncements() {
    return (await db.all('SELECT * FROM announcements ORDER BY COALESCE(starts_on, created_at) DESC, id DESC LIMIT 100')).map(
      toAnnouncement,
    );
  }

  async function activeAnnouncements() {
    const t = today();
    const rows = await db.all(
      `SELECT * FROM announcements
       WHERE (starts_on IS NULL OR starts_on <= ?) AND (ends_on IS NULL OR ends_on >= ?)
       ORDER BY COALESCE(starts_on, created_at) DESC, id DESC LIMIT 10`,
      [t, t],
    );
    return rows.map(({ id, title, body, starts_on: startsOn, ends_on: endsOn }) => ({ id, title, body, startsOn, endsOn }));
  }

  async function createAnnouncement(input = {}) {
    const title = text(input.title, { field: 'お知らせの見出し', max: 60, required: true });
    const body = text(input.body, { field: 'お知らせの本文', max: 1000, multiline: true });
    const startsOn = optionalDate(input.startsOn, '掲載開始日');
    const endsOn = optionalDate(input.endsOn, '掲載終了日');
    if (startsOn && endsOn && endsOn < startsOn) throw new AppError('掲載終了日は開始日より後にしてください');
    const { lastRowId } = await db.run(
      'INSERT INTO announcements (title, body, starts_on, ends_on, created_at) VALUES (?, ?, ?, ?, ?)',
      [title, body, startsOn, endsOn, timestamp()],
    );
    return toAnnouncement(await db.get('SELECT * FROM announcements WHERE id = ?', [lastRowId]));
  }

  async function deleteAnnouncement(id) {
    const row = await db.get('SELECT * FROM announcements WHERE id = ?', [Number(id)]);
    if (!row) throw new AppError('お知らせが見つかりません', 404);
    await db.run('DELETE FROM announcements WHERE id = ?', [row.id]);
    return toAnnouncement(row);
  }

  return {
    listMenu,
    publicMenu,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
    moveMenuItem,
    savePhoto,
    getPhoto,
    listAnnouncements,
    activeAnnouncements,
    createAnnouncement,
    deleteAnnouncement,
  };
}
