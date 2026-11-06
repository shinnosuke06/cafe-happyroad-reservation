// お客様の連絡先と、メール・LINE でのお知らせ送信
import { transaction } from './db.js';
import { AppError, text, integer, bool, email, normalizeWidth, digitsOnly } from './validate.js';

const CHANNELS = ['email', 'line'];
const CHANNEL_LABELS = { email: 'メール', line: 'LINE' };

function toCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    lineLinked: row.line_user_id != null,
    notifyEmail: row.notify_email === 1,
    notifyLine: row.notify_line === 1,
    memo: row.memo,
    reservationCount: row.reservation_count ?? 0,
    lastDate: row.last_date ?? null,
    nextDate: row.next_date ?? null,
    createdAt: row.created_at,
  };
}

function toMessage(row) {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    channels: JSON.parse(row.channels),
    target: row.target,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    createdAt: row.created_at,
  };
}

export function createCustomers(db, { now = () => new Date(), today, store, notifier, publicUrl = '' }) {
  const timestamp = () => new Date(now()).toISOString();

  const STATS = `
    (SELECT COUNT(*) FROM reservations r WHERE r.customer_id = c.id AND r.status IN ('confirmed', 'arrived')) AS reservation_count,
    (SELECT MAX(date) FROM reservations r WHERE r.customer_id = c.id AND r.status IN ('confirmed', 'arrived') AND r.date <= :today) AS last_date,
    (SELECT MIN(date) FROM reservations r WHERE r.customer_id = c.id AND r.status = 'confirmed' AND r.date >= :today) AS next_date`;

  const sql = {
    list: db.prepare(`
      SELECT c.*, ${STATS} FROM customers c
      WHERE :q = '' OR c.name LIKE :like ESCAPE '\\' OR c.email LIKE :like ESCAPE '\\'
         OR (:digits <> '' AND c.phone_digits LIKE :digitsLike)
      ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`),
    get: db.prepare(`SELECT c.*, ${STATS} FROM customers c WHERE c.id = :id`),
    byIds: db.prepare('SELECT * FROM customers WHERE id IN (SELECT value FROM json_each(?))'),
    emailSubscribers: db.prepare("SELECT * FROM customers WHERE notify_email = 1 AND email <> ''"),
    lineSubscribers: db.prepare('SELECT * FROM customers WHERE notify_line = 1 AND line_user_id IS NOT NULL'),
    update: db.prepare(`
      UPDATE customers SET name = :name, email = :email, notify_email = :notifyEmail, notify_line = :notifyLine,
        memo = :memo, updated_at = :now WHERE id = :id`),
    remove: db.prepare('DELETE FROM customers WHERE id = ?'),
    byToken: db.prepare('SELECT * FROM customers WHERE unsubscribe_token = ?'),
    unsubscribe: db.prepare('UPDATE customers SET notify_email = 0, updated_at = ? WHERE id = ?'),
    byLine: db.prepare('SELECT * FROM customers WHERE line_user_id = ?'),
    clearLine: db.prepare('UPDATE customers SET line_user_id = NULL, notify_line = 0, updated_at = ? WHERE line_user_id = ?'),
    setLine: db.prepare('UPDATE customers SET line_user_id = ?, notify_line = 1, updated_at = ? WHERE id = ?'),
    reservationByCode: db.prepare('SELECT * FROM reservations WHERE code = ?'),
    customerIdsOn: db.prepare(
      "SELECT DISTINCT customer_id FROM reservations WHERE date = ? AND status = 'confirmed' AND customer_id IS NOT NULL",
    ),
    insertMessage: db.prepare(
      'INSERT INTO messages (subject, body, channels, target, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    finishMessage: db.prepare('UPDATE messages SET sent_count = ?, failed_count = ? WHERE id = ?'),
    insertDelivery: db.prepare(
      'INSERT INTO message_deliveries (message_id, customer_id, channel, status, error) VALUES (?, ?, ?, ?, ?)',
    ),
    messages: db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 50'),
    failures: db.prepare(`
      SELECT d.channel, d.error, c.name FROM message_deliveries d LEFT JOIN customers c ON c.id = d.customer_id
      WHERE d.message_id = ? AND d.status = 'failed' LIMIT 20`),
  };

  function getRow(id) {
    const row = sql.get.get({ id: Number(id), today: today() });
    if (!row) throw new AppError('お客様が見つかりません', 404);
    return row;
  }

  function listCustomers(query = '') {
    const q = text(query, { field: '検索語', max: 50 });
    const digits = digitsOnly(q);
    return sql.list
      .all({
        q,
        like: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
        digits: digits.length >= 3 ? digits : '',
        digitsLike: `%${digits}%`,
        today: today(),
      })
      .map(toCustomer);
  }

  function getCustomer(id) {
    const row = getRow(id);
    return { customer: toCustomer(row), reservations: store.customerReservations(row.id) };
  }

  function updateCustomer(id, input = {}) {
    const row = getRow(id);
    const mail = input.email !== undefined ? email(input.email) : row.email;
    const notifyEmail = input.notifyEmail !== undefined ? bool(input.notifyEmail) : row.notify_email === 1;
    const notifyLine = input.notifyLine !== undefined ? bool(input.notifyLine) : row.notify_line === 1;
    if (notifyEmail && !mail) throw new AppError('メールでお知らせするには、メールアドレスが必要です');
    if (notifyLine && row.line_user_id == null) {
      throw new AppError('LINEでお知らせするには、お客様にLINEで予約番号を送ってもらう必要があります');
    }
    sql.update.run({
      id: row.id,
      name: text(input.name ?? row.name, { field: 'お名前', max: 50, required: true }),
      email: mail,
      notifyEmail: notifyEmail ? 1 : 0,
      notifyLine: notifyLine ? 1 : 0,
      memo: text(input.memo ?? row.memo, { field: 'メモ', max: 500, multiline: true }),
      now: timestamp(),
    });
    return toCustomer(getRow(row.id));
  }

  function deleteCustomer(id) {
    const row = getRow(id);
    sql.remove.run(row.id);
    return toCustomer(row);
  }

  /** その日に予約が入っているお客様（休みのお知らせ用） */
  function customerIdsOn(date) {
    return sql.customerIdsOn.all(date).map((r) => r.customer_id);
  }

  // ---- メールの配信停止 ----

  function unsubscribe(token) {
    const t = String(token ?? '');
    const row = /^[a-f0-9]{32}$/.test(t) ? sql.byToken.get(t) : null;
    if (!row) throw new AppError('配信停止のリンクが正しくありません', 404);
    sql.unsubscribe.run(timestamp(), row.id);
    return { name: row.name };
  }

  function unsubscribeUrl(row) {
    return publicUrl ? `${publicUrl.replace(/\/$/, '')}/unsubscribe.html#${row.unsubscribe_token}` : '';
  }

  // ---- LINE のつなぎ込み ----

  /** LINE で送られた文から予約番号を探し、その予約のお客様と LINE をつなぐ */
  function linkLineByMessage(userId, messageText) {
    const match = /(?<![A-Z0-9])[A-HJ-NP-Z2-9]{6}(?![A-Z0-9])/.exec(normalizeWidth(messageText).toUpperCase());
    if (!match) return { linked: false, reason: 'no_code' };
    const reservation = sql.reservationByCode.get(match[0]);
    if (!reservation || reservation.customer_id == null) return { linked: false, reason: 'not_found' };
    return transaction(db, () => {
      sql.clearLine.run(timestamp(), userId);
      sql.setLine.run(userId, timestamp(), reservation.customer_id);
      return { linked: true, name: getRow(reservation.customer_id).name };
    });
  }

  function unlinkLine(userId) {
    sql.clearLine.run(timestamp(), userId);
  }

  function isLineLinked(userId) {
    return Boolean(sql.byLine.get(userId));
  }

  // ---- お知らせを送る ----

  function footer(row, channel) {
    const s = store.getSettings();
    const lines = ['', '――――――――――', s.storeName];
    if (s.storePhone) lines.push(`電話：${s.storePhone}`);
    if (channel === 'email') {
      lines.push('このメールは、お知らせの受け取りを希望された方にお送りしています。');
      const link = unsubscribeUrl(row);
      lines.push(link ? `配信の停止：${link}` : '配信を止めたい方は、お店までご連絡ください。');
    }
    return lines.join('\n');
  }

  /**
   * target = "all"      … お知らせの受け取りを希望した方全員
   * target = "selected" … 選んだお客様（予約のご連絡など。メールアドレスか LINE がある方）
   */
  async function sendMessage(input = {}) {
    const subject = text(input.subject, { field: '件名', max: 60, required: true });
    const body = text(input.body, { field: '本文', max: 2000, required: true, multiline: true });
    const channels = Array.isArray(input.channels) ? [...new Set(input.channels)] : [];
    if (channels.length === 0 || !channels.every((c) => CHANNELS.includes(c))) {
      throw new AppError('送り方（メール・LINE）を選んでください');
    }
    const target = input.target === 'selected' ? 'selected' : 'all';
    const status = notifier.status();
    for (const c of channels) {
      if (!status[c]) {
        throw new AppError(`${CHANNEL_LABELS[c]}の送信設定がまだです。README の「お知らせの送信設定」をご覧ください`);
      }
    }

    let selected = [];
    if (target === 'selected') {
      const ids = Array.isArray(input.customerIds) ? input.customerIds : [];
      if (ids.length === 0) throw new AppError('送る相手を選んでください');
      if (ids.length > 2000) throw new AppError('一度に選べるのは2000人までです');
      selected = sql.byIds.all(JSON.stringify(ids.map((id) => integer(id, { field: 'お客様', min: 1, max: 2 ** 31 }))));
    }

    const recipients = {
      email: target === 'all' ? sql.emailSubscribers.all() : selected.filter((c) => c.email),
      line: target === 'all' ? sql.lineSubscribers.all() : selected.filter((c) => c.line_user_id != null),
    };
    const total = channels.reduce((n, c) => n + recipients[c].length, 0);
    if (total === 0) {
      throw new AppError(
        target === 'all'
          ? 'お知らせの受け取りを希望しているお客様がまだいません'
          : '選んだお客様には、メールアドレスもLINEの登録もありません',
      );
    }

    const { lastInsertRowid } = sql.insertMessage.run(subject, body, JSON.stringify(channels), target, timestamp());
    const messageId = Number(lastInsertRowid);
    const summary = { email: { sent: 0, failed: 0 }, line: { sent: 0, failed: 0 } };
    const deliveries = [];

    if (channels.includes('email')) {
      const list = recipients.email;
      const results = await notifier.sendEmails(
        list.map((c) => ({ to: c.email, subject, text: `${c.name} 様\n\n${body}\n${footer(c, 'email')}` })),
      );
      results.forEach((r, i) => deliveries.push({ customer: list[i], channel: 'email', ...r }));
    }
    if (channels.includes('line')) {
      const list = recipients.line;
      const results = await notifier.sendLine(
        list.map((c) => c.line_user_id),
        `【${subject}】\n${body}\n${footer(null, 'line')}`,
      );
      results.forEach((r, i) => deliveries.push({ customer: list[i], channel: 'line', ...r }));
    }

    transaction(db, () => {
      for (const d of deliveries) {
        summary[d.channel][d.ok ? 'sent' : 'failed'] += 1;
        sql.insertDelivery.run(messageId, d.customer.id, d.channel, d.ok ? 'sent' : 'failed', d.error ?? '');
      }
      const sent = summary.email.sent + summary.line.sent;
      const failed = summary.email.failed + summary.line.failed;
      sql.finishMessage.run(sent, failed, messageId);
    });
    return { id: messageId, summary, failures: sql.failures.all(messageId) };
  }

  function listMessages() {
    return sql.messages.all().map(toMessage);
  }

  return {
    listCustomers,
    getCustomer,
    updateCustomer,
    deleteCustomer,
    customerIdsOn,
    unsubscribe,
    unsubscribeUrl: (id) => unsubscribeUrl(getRow(id)),
    linkLineByMessage,
    unlinkLine,
    isLineLinked,
    sendMessage,
    listMessages,
  };
}
