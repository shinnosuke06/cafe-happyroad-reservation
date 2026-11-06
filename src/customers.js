// お客様の連絡先と、メール・LINE でのお知らせ送信
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

// 予約の回数・前回・次回（? には今日の日付が2回入る）
const STATS = `
  (SELECT COUNT(*) FROM reservations r WHERE r.customer_id = c.id AND r.status IN ('confirmed', 'arrived')) AS reservation_count,
  (SELECT MAX(date) FROM reservations r WHERE r.customer_id = c.id AND r.status IN ('confirmed', 'arrived') AND r.date <= ?) AS last_date,
  (SELECT MIN(date) FROM reservations r WHERE r.customer_id = c.id AND r.status = 'confirmed' AND r.date >= ?) AS next_date`;

export function createCustomers(db, { now = () => new Date(), today, store, notifier, publicUrl = '' }) {
  const timestamp = () => new Date(now()).toISOString();

  async function getRow(id) {
    const t = today();
    const row = await db.get(`SELECT c.*, ${STATS} FROM customers c WHERE c.id = ?`, [t, t, Number(id)]);
    if (!row) throw new AppError('お客様が見つかりません', 404);
    return row;
  }

  async function listCustomers(query = '') {
    const q = text(query, { field: '検索語', max: 50 });
    const digits = digitsOnly(q);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const t = today();
    const rows = await db.all(
      `SELECT c.*, ${STATS} FROM customers c
       WHERE ? = '' OR c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\'
          OR (? = 1 AND c.phone_digits LIKE ?)
       ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`,
      [t, t, q, like, like, digits.length >= 3 ? 1 : 0, `%${digits}%`],
    );
    return rows.map(toCustomer);
  }

  async function getCustomer(id) {
    const row = await getRow(id);
    return { customer: toCustomer(row), reservations: await store.customerReservations(row.id) };
  }

  async function updateCustomer(id, input = {}) {
    const row = await getRow(id);
    const mail = input.email !== undefined ? email(input.email) : row.email;
    const notifyEmail = input.notifyEmail !== undefined ? bool(input.notifyEmail) : row.notify_email === 1;
    const notifyLine = input.notifyLine !== undefined ? bool(input.notifyLine) : row.notify_line === 1;
    if (notifyEmail && !mail) throw new AppError('メールでお知らせするには、メールアドレスが必要です');
    if (notifyLine && row.line_user_id == null) {
      throw new AppError('LINEでお知らせするには、お客様にLINEで予約番号を送ってもらう必要があります');
    }
    await db.run('UPDATE customers SET name = ?, email = ?, notify_email = ?, notify_line = ?, memo = ?, updated_at = ? WHERE id = ?', [
      text(input.name ?? row.name, { field: 'お名前', max: 50, required: true }),
      mail,
      notifyEmail ? 1 : 0,
      notifyLine ? 1 : 0,
      text(input.memo ?? row.memo, { field: 'メモ', max: 500, multiline: true }),
      timestamp(),
      row.id,
    ]);
    return toCustomer(await getRow(row.id));
  }

  async function deleteCustomer(id) {
    const row = await getRow(id);
    await db.run('DELETE FROM customers WHERE id = ?', [row.id]);
    return toCustomer(row);
  }

  /** その日に予約が入っているお客様（休みのお知らせ用） */
  async function customerIdsOn(date) {
    const rows = await db.all(
      "SELECT DISTINCT customer_id FROM reservations WHERE date = ? AND status = 'confirmed' AND customer_id IS NOT NULL",
      [date],
    );
    return rows.map((r) => r.customer_id);
  }

  // ---- メールの配信停止 ----

  async function unsubscribe(token) {
    const t = String(token ?? '');
    const row = /^[a-f0-9]{32}$/.test(t) ? await db.get('SELECT * FROM customers WHERE unsubscribe_token = ?', [t]) : null;
    if (!row) throw new AppError('配信停止のリンクが正しくありません', 404);
    await db.run('UPDATE customers SET notify_email = 0, updated_at = ? WHERE id = ?', [timestamp(), row.id]);
    return { name: row.name };
  }

  function unsubscribeUrl(row) {
    return publicUrl ? `${publicUrl.replace(/\/$/, '')}/unsubscribe.html#${row.unsubscribe_token}` : '';
  }

  // ---- LINE のつなぎ込み ----

  /** LINE で送られた文から予約番号を探し、その予約のお客様と LINE をつなぐ */
  async function linkLineByMessage(userId, messageText) {
    const match = /(?<![A-Z0-9])[A-HJ-NP-Z2-9]{6}(?![A-Z0-9])/.exec(normalizeWidth(messageText).toUpperCase());
    if (!match) return { linked: false, reason: 'no_code' };
    const reservation = await db.get('SELECT customer_id FROM reservations WHERE code = ?', [match[0]]);
    if (!reservation || reservation.customer_id == null) return { linked: false, reason: 'not_found' };
    const nowIso = timestamp();
    await db.batch([
      ['UPDATE customers SET line_user_id = NULL, notify_line = 0, updated_at = ? WHERE line_user_id = ?', [nowIso, userId]],
      ['UPDATE customers SET line_user_id = ?, notify_line = 1, updated_at = ? WHERE id = ?', [userId, nowIso, reservation.customer_id]],
    ]);
    return { linked: true, name: (await getRow(reservation.customer_id)).name };
  }

  async function unlinkLine(userId) {
    await db.run('UPDATE customers SET line_user_id = NULL, notify_line = 0, updated_at = ? WHERE line_user_id = ?', [timestamp(), userId]);
  }

  async function isLineLinked(userId) {
    return Boolean(await db.get('SELECT 1 AS found FROM customers WHERE line_user_id = ?', [userId]));
  }

  // ---- お知らせを送る ----

  async function footer(row, channel) {
    const s = await store.getSettings();
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
      selected = await db.all('SELECT * FROM customers WHERE id IN (SELECT value FROM json_each(?))', [
        JSON.stringify(ids.map((id) => integer(id, { field: 'お客様', min: 1, max: 2 ** 31 }))),
      ]);
    }

    const recipients = {
      email:
        target === 'all'
          ? await db.all("SELECT * FROM customers WHERE notify_email = 1 AND email <> ''")
          : selected.filter((c) => c.email),
      line:
        target === 'all'
          ? await db.all('SELECT * FROM customers WHERE notify_line = 1 AND line_user_id IS NOT NULL')
          : selected.filter((c) => c.line_user_id != null),
    };
    const total = channels.reduce((n, c) => n + recipients[c].length, 0);
    if (total === 0) {
      throw new AppError(
        target === 'all'
          ? 'お知らせの受け取りを希望しているお客様がまだいません'
          : '選んだお客様には、メールアドレスもLINEの登録もありません',
      );
    }

    const { lastRowId: messageId } = await db.run(
      'INSERT INTO messages (subject, body, channels, target, created_at) VALUES (?, ?, ?, ?, ?)',
      [subject, body, JSON.stringify(channels), target, timestamp()],
    );
    const summary = { email: { sent: 0, failed: 0 }, line: { sent: 0, failed: 0 } };
    const deliveries = [];

    if (channels.includes('email')) {
      const list = recipients.email;
      const messages = [];
      for (const c of list) messages.push({ to: c.email, subject, text: `${c.name} 様\n\n${body}\n${await footer(c, 'email')}` });
      const results = await notifier.sendEmails(messages);
      results.forEach((r, i) => deliveries.push({ customer: list[i], channel: 'email', ...r }));
    }
    if (channels.includes('line')) {
      const list = recipients.line;
      const results = await notifier.sendLine(
        list.map((c) => c.line_user_id),
        `【${subject}】\n${body}\n${await footer(null, 'line')}`,
      );
      results.forEach((r, i) => deliveries.push({ customer: list[i], channel: 'line', ...r }));
    }

    for (const d of deliveries) summary[d.channel][d.ok ? 'sent' : 'failed'] += 1;
    const statements = deliveries.map((d) => [
      'INSERT INTO message_deliveries (message_id, customer_id, channel, status, error) VALUES (?, ?, ?, ?, ?)',
      [messageId, d.customer.id, d.channel, d.ok ? 'sent' : 'failed', d.error ?? ''],
    ]);
    statements.push([
      'UPDATE messages SET sent_count = ?, failed_count = ? WHERE id = ?',
      [summary.email.sent + summary.line.sent, summary.email.failed + summary.line.failed, messageId],
    ]);
    for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));

    const failures = await db.all(
      `SELECT d.channel, d.error, c.name FROM message_deliveries d LEFT JOIN customers c ON c.id = d.customer_id
       WHERE d.message_id = ? AND d.status = 'failed' LIMIT 20`,
      [messageId],
    );
    return { id: messageId, summary, failures };
  }

  async function listMessages() {
    return (await db.all('SELECT * FROM messages ORDER BY id DESC LIMIT 50')).map(toMessage);
  }

  return {
    listCustomers,
    getCustomer,
    updateCustomer,
    deleteCustomer,
    customerIdsOn,
    unsubscribe,
    linkLineByMessage,
    unlinkLine,
    isLineLinked,
    sendMessage,
    listMessages,
  };
}
