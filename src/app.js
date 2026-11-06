import { readFile, rm } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createStore } from './store.js';
import { createContent } from './content.js';
import { createCustomers } from './customers.js';
import { createAuth } from './auth.js';
import { createRateLimiter, createAudit } from './guard.js';
import { createNotifier } from './notify.js';
import { saveImage, removeImage, isUploadName, IMAGE_TYPES, MAX_IMAGE_BYTES } from './uploads.js';
import { AppError } from './validate.js';
import { formatDateJa } from './time.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_JSON_BYTES = 64 * 1024;
const RAW = Symbol('raw-response');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const PAGE_ALIASES = {
  '/': '/index.html',
  '/admin': '/admin.html',
  '/admin/': '/admin.html',
  '/unsubscribe': '/unsubscribe.html',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(
    `^${pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    })}$`,
  );
  return { regex, keys };
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) throw new AppError('送信データが大きすぎます', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError('送信データが大きすぎます', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buf, contentType = '') {
  if (buf.length === 0) return {};
  if (!contentType.includes('application/json')) {
    throw new AppError('Content-Type は application/json にしてください', 415);
  }
  try {
    const body = JSON.parse(buf.toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new AppError('送信データの形式が正しくありません');
  }
}

export async function createApp({
  dbPath = ':memory:',
  adminPassword,
  timezone = 'Asia/Tokyo',
  now = () => new Date(),
  publicDir = join(ROOT, 'public'),
  uploadDir,
  notifier = createNotifier({}),
  trustProxy = false,
  publicUrl = '',
} = {}) {
  const db = openDatabase(dbPath);
  const uploads =
    uploadDir ??
    (dbPath === ':memory:'
      ? join(tmpdir(), `happyroad-uploads-${randomBytes(6).toString('hex')}`)
      : join(dirname(resolve(dbPath)), 'uploads'));

  const clientIp = (req) => {
    const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return forwarded || req.socket.remoteAddress || '';
  };
  const isHttps = (req) => Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');

  const store = createStore(db, { now, timezone });
  const content = createContent(db, { now, today: store.today });
  const customers = createCustomers(db, { now, today: store.today, store, notifier, publicUrl });
  const audit = createAudit(db, { now });
  const auth = createAuth(db, { now: () => new Date(now()).getTime(), isHttps, clientIp });

  const passwordCreated = !auth.hasPassword();
  if (passwordCreated) {
    if (!adminPassword) throw new Error('最初の起動では管理画面のパスワード（ADMIN_PASSWORD）が必要です');
    await auth.setPassword(adminPassword);
  }

  const limiters = {
    read: createRateLimiter({ limit: 300, windowMs: 60_000 }),
    book: createRateLimiter({ limit: 6, windowMs: 10 * 60_000 }),
    lookup: createRateLimiter({ limit: 15, windowMs: 10 * 60_000 }),
    upload: createRateLimiter({ limit: 60, windowMs: 10 * 60_000 }),
    line: createRateLimiter({ limit: 10, windowMs: 60 * 60_000 }),
  };

  // ---- 予約確認メール（送れなくても予約は成立させる） ----
  function sendConfirmation(r) {
    if (!r.email || !notifier.status().email) return;
    const s = store.getSettings();
    const lines = [
      `${r.name} 様`,
      '',
      `${s.storeName}のご予約を承りました。ご来店をお待ちしております。`,
      '',
      `予約番号：${r.code}`,
      `日時　　：${formatDateJa(r.date)} ${r.time}〜`,
      `人数　　：${r.partySize}名様`,
    ];
    if (r.seatRequest) lines.push(`席の希望：${r.seatRequest}`);
    if (r.items.length) lines.push(`メニュー：${r.items.map((i) => `${i.name}×${i.quantity}`).join('、')}`);
    lines.push(
      '',
      '予約の確認・キャンセルは、予約ページの「予約の確認・キャンセル」から、予約番号と電話番号で行えます。',
    );
    if (publicUrl) lines.push(`予約ページ：${publicUrl}`);
    lines.push('', '――――――――――', s.storeName);
    if (s.storePhone) lines.push(`電話：${s.storePhone}`);
    notifier
      .sendEmails([{ to: r.email, subject: `【${s.storeName}】ご予約ありがとうございます（${r.code}）`, text: lines.join('\n') }])
      .then(([result]) => {
        if (!result.ok) audit.log('確認メールの送信に失敗', `${r.code} ${result.error}`);
      })
      .catch((err) => audit.log('確認メールの送信に失敗', `${r.code} ${err.message}`));
  }

  async function replyLine(token, message) {
    if (!token || !message) return;
    try {
      await notifier.replyLine(token, message);
    } catch (err) {
      audit.log('LINEの返信に失敗', err.message);
    }
  }

  const describe = (r) => `${r.date} ${r.time} ${r.name}様 ${r.partySize}名`;

  // [メソッド, パス, 処理, オプション]
  // オプション: staff = ログインが必要 / status = 成功時のコード / body = 'json' | 'raw' / limit = 回数制限
  const routes = [
    // ---------- お客様向け ----------
    [
      'GET',
      '/api/info',
      () => ({ ...store.publicInfo(), announcements: content.activeAnnouncements(), emailEnabled: notifier.status().email }),
      { limit: 'read' },
    ],
    [
      'GET',
      '/api/calendar',
      ({ query }) => store.calendar(query.get('month'), query.get('party'), query.get('area') ?? ''),
      { limit: 'read' },
    ],
    [
      'GET',
      '/api/availability',
      ({ query }) => store.availability(query.get('date'), query.get('party'), query.get('area') ?? ''),
      { limit: 'read' },
    ],
    ['GET', '/api/menu', ({ query }) => content.publicMenu(query.get('date')), { limit: 'read' }],
    [
      'POST',
      '/api/reservations',
      ({ body, ip }) => {
        // 人には見えない入力欄。機械が入力したら受け付けない
        if (body.website) {
          audit.log('不審な予約をブロック', '', ip);
          throw new AppError('送信できませんでした。お電話でご予約ください');
        }
        const { publicView, reservation } = store.createPublicReservation(body);
        sendConfirmation(reservation);
        return { reservation: publicView };
      },
      { status: 201, limit: 'book' },
    ],
    ['POST', '/api/reservations/lookup', ({ body }) => ({ reservation: store.lookupReservation(body) }), { limit: 'lookup' }],
    [
      'POST',
      '/api/reservations/cancel',
      ({ body, ip }) => {
        const reservation = store.cancelByCustomer(body);
        audit.log('お客様がキャンセル', `${reservation.code} ${reservation.date} ${reservation.time} ${reservation.name}様`, ip);
        return { reservation };
      },
      { limit: 'lookup' },
    ],
    ['POST', '/api/unsubscribe', ({ body }) => customers.unsubscribe(body.token), { limit: 'lookup' }],
    [
      'POST',
      '/api/line/webhook',
      async ({ req, raw }) => {
        if (!notifier.verifyLineSignature(raw, req.headers['x-line-signature'])) {
          throw new AppError('署名が正しくありません', 401);
        }
        let payload;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new AppError('形式が正しくありません');
        }
        const storeName = store.getSettings().storeName;
        for (const event of Array.isArray(payload.events) ? payload.events : []) {
          const userId = event.source?.type === 'user' ? event.source.userId : null;
          if (typeof userId !== 'string' || !/^U[0-9a-f]{32}$/.test(userId)) continue;
          if (event.type === 'unfollow') {
            customers.unlinkLine(userId);
          } else if (event.type === 'follow') {
            await replyLine(
              event.replyToken,
              `${storeName}です。友だち追加ありがとうございます。\nご予約のときの「予約番号（6文字）」をこのトークに送っていただくと、お休みやお知らせをLINEでお届けします。`,
            );
          } else if (event.type === 'message' && event.message?.type === 'text') {
            if (!limiters.line.allow(userId)) continue;
            const result = customers.linkLineByMessage(userId, String(event.message.text).slice(0, 200));
            if (result.linked) {
              audit.log('LINEの登録', `${result.name}様`);
              await replyLine(event.replyToken, `${result.name}様、LINEでのお知らせを登録しました。ありがとうございます。`);
            } else if (result.reason === 'not_found') {
              await replyLine(event.replyToken, '予約番号が見つかりませんでした。6文字の予約番号をもう一度お確かめください。');
            } else if (!customers.isLineLinked(userId)) {
              await replyLine(event.replyToken, 'お知らせを受け取るには、ご予約のときの予約番号（6文字）を送ってください。');
            }
          }
        }
        return { ok: true };
      },
      { body: 'raw', maxBytes: 1024 * 1024, skipOriginCheck: true },
    ],

    // ---------- スタッフのログイン ----------
    ['GET', '/api/admin/session', ({ req }) => ({ loggedIn: auth.isLoggedIn(req) })],
    [
      'POST',
      '/api/admin/login',
      async ({ req, body, headers, ip }) => {
        try {
          headers['Set-Cookie'] = await auth.login(req, body.password);
        } catch (err) {
          if (err.audit) audit.log(err.audit, '', ip);
          throw err;
        }
        audit.log('ログイン', '', ip);
        return { loggedIn: true };
      },
    ],
    [
      'POST',
      '/api/admin/logout',
      ({ req, headers, ip }) => {
        headers['Set-Cookie'] = auth.logout(req);
        audit.log('ログアウト', '', ip);
        return { loggedIn: false };
      },
    ],
    [
      'POST',
      '/api/admin/password',
      async ({ req, body, headers, ip }) => {
        headers['Set-Cookie'] = await auth.changePassword(req, body.current, body.next);
        audit.log('パスワードを変更', 'ほかの端末はログアウトしました', ip);
        return { ok: true };
      },
      { staff: true },
    ],

    // ---------- 予約 ----------
    [
      'GET',
      '/api/admin/reservations',
      ({ query }) => {
        if (query.has('q')) return { reservations: store.searchReservations(query.get('q')) };
        const date = query.get('date') || store.today();
        return { date, reservations: store.listReservations(date) };
      },
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/reservations',
      ({ body, ip }) => {
        const reservation = store.createStaffReservation(body);
        audit.log('予約を追加', describe(reservation), ip);
        return { reservation };
      },
      { staff: true, status: 201 },
    ],
    ['GET', '/api/admin/reservations/:id', ({ params }) => ({ reservation: store.getReservation(params.id) }), { staff: true }],
    [
      'PATCH',
      '/api/admin/reservations/:id',
      ({ params, body, ip }) => {
        const reservation = store.updateStaffReservation(params.id, body);
        audit.log('予約を変更', describe(reservation), ip);
        return { reservation };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/reservations/:id',
      ({ params, ip }) => {
        const removed = store.deleteReservation(params.id);
        audit.log('予約を削除', describe(removed), ip);
        return { ok: true };
      },
      { staff: true },
    ],

    // ---------- 設定・テーブル・休業日 ----------
    [
      'GET',
      '/api/admin/settings',
      () => ({
        settings: store.getSettings(),
        tables: store.listTables(),
        areas: store.listAreas(),
        closures: store.listClosures(),
        today: store.today(),
        notify: { ...notifier.status(), unsubscribeLink: Boolean(publicUrl) },
      }),
      { staff: true },
    ],
    [
      'PUT',
      '/api/admin/settings',
      ({ body, ip }) => {
        const settings = store.updateSettings(body);
        audit.log('設定を変更', '', ip);
        return { settings };
      },
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/tables',
      ({ body, ip }) => {
        const table = store.createTable(body);
        audit.log('テーブルを追加', `${table.name}（${table.seats}席）`, ip);
        return { table };
      },
      { staff: true, status: 201 },
    ],
    [
      'PATCH',
      '/api/admin/tables/:id',
      ({ params, body, ip }) => {
        const table = store.updateTable(params.id, body);
        audit.log('テーブルを変更', `${table.name}（${table.seats}席・${table.active ? '使う' : '休止'}）`, ip);
        return { table };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/tables/:id',
      ({ params, ip }) => {
        store.deleteTable(params.id);
        audit.log('テーブルを削除', `ID ${params.id}`, ip);
        return { ok: true };
      },
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/closures',
      ({ body, ip }) => {
        const closure = store.addClosure(body);
        audit.log('臨時休業日を追加', `${closure.date} ${closure.reason}`, ip);
        return { closure, customerIds: customers.customerIdsOn(closure.date) };
      },
      { staff: true, status: 201 },
    ],
    [
      'DELETE',
      '/api/admin/closures/:date',
      ({ params, ip }) => {
        store.removeClosure(params.date);
        audit.log('臨時休業日を取り消し', params.date, ip);
        return { ok: true };
      },
      { staff: true },
    ],

    // ---------- メニュー ----------
    ['GET', '/api/admin/menu', () => ({ items: content.listMenu() }), { staff: true }],
    [
      'POST',
      '/api/admin/menu',
      ({ body, ip }) => {
        const item = content.createMenuItem(body);
        audit.log('メニューを追加', item.name, ip);
        return { item };
      },
      { staff: true, status: 201 },
    ],
    [
      'PATCH',
      '/api/admin/menu/:id',
      async ({ params, body, ip }) => {
        const { item, unusedPhoto } = content.updateMenuItem(params.id, body);
        if (unusedPhoto) await removeImage(uploads, unusedPhoto);
        audit.log('メニューを変更', item.name, ip);
        return { item };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/menu/:id',
      async ({ params, ip }) => {
        const { item, unusedPhoto } = content.deleteMenuItem(params.id);
        if (unusedPhoto) await removeImage(uploads, unusedPhoto);
        audit.log('メニューを削除', item.name, ip);
        return { ok: true };
      },
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/menu/:id/move',
      ({ params, body }) => ({ items: content.moveMenuItem(params.id, body.direction) }),
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/uploads',
      async ({ raw, ip }) => {
        const photo = await saveImage(uploads, raw);
        if (!photo) throw new AppError('写真は JPEG・PNG・WebP の画像にしてください', 415);
        audit.log('写真をアップロード', photo, ip);
        return { photo, photoUrl: `/uploads/${photo}` };
      },
      { staff: true, status: 201, body: 'raw', maxBytes: MAX_IMAGE_BYTES, limit: 'upload' },
    ],

    // ---------- お客様・お知らせ ----------
    ['GET', '/api/admin/customers', ({ query }) => ({ customers: customers.listCustomers(query.get('q') ?? '') }), { staff: true }],
    ['GET', '/api/admin/customers/:id', ({ params }) => customers.getCustomer(params.id), { staff: true }],
    [
      'PATCH',
      '/api/admin/customers/:id',
      ({ params, body, ip }) => {
        const customer = customers.updateCustomer(params.id, body);
        audit.log('お客様情報を変更', customer.name, ip);
        return { customer };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/customers/:id',
      ({ params, ip }) => {
        const customer = customers.deleteCustomer(params.id);
        audit.log('お客様情報を削除', customer.name, ip);
        return { ok: true };
      },
      { staff: true },
    ],
    ['GET', '/api/admin/messages', () => ({ messages: customers.listMessages() }), { staff: true }],
    [
      'POST',
      '/api/admin/messages',
      async ({ body, ip }) => {
        const result = await customers.sendMessage(body);
        const { email, line } = result.summary;
        audit.log(
          'お知らせを送信',
          `${String(body.subject).slice(0, 40)}（メール${email.sent}件・LINE${line.sent}件、失敗${email.failed + line.failed}件）`,
          ip,
        );
        return result;
      },
      { staff: true, status: 201 },
    ],
    ['GET', '/api/admin/announcements', () => ({ announcements: content.listAnnouncements() }), { staff: true }],
    [
      'POST',
      '/api/admin/announcements',
      ({ body, ip }) => {
        const announcement = content.createAnnouncement(body);
        audit.log('お知らせを掲載', announcement.title, ip);
        return { announcement };
      },
      { staff: true, status: 201 },
    ],
    [
      'DELETE',
      '/api/admin/announcements/:id',
      ({ params, ip }) => {
        const announcement = content.deleteAnnouncement(params.id);
        audit.log('お知らせを削除', announcement.title, ip);
        return { ok: true };
      },
      { staff: true },
    ],

    // ---------- 記録・バックアップ ----------
    ['GET', '/api/admin/audit', () => ({ entries: audit.list(200) }), { staff: true }],
    [
      'GET',
      '/api/admin/backup',
      async ({ res, ip }) => {
        const file = join(tmpdir(), `happyroad-backup-${randomBytes(8).toString('hex')}.db`);
        try {
          db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
          const data = await readFile(file);
          audit.log('バックアップを保存', '', ip);
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'application/vnd.sqlite3',
            'Content-Disposition': `attachment; filename="happyroad-backup-${store.today()}.db"`,
            'Cache-Control': 'no-store',
          });
          res.end(data);
        } finally {
          await rm(file, { force: true });
        }
        return RAW;
      },
      { staff: true },
    ],
  ].map(([method, pattern, handle, options = {}]) => ({ method, handle, ...compile(pattern), ...options }));

  function headersFor(req, extra = {}) {
    const headers = { ...SECURITY_HEADERS, ...extra };
    if (isHttps(req)) headers['Strict-Transport-Security'] = 'max-age=31536000';
    return headers;
  }

  function send(req, res, status, body, headers = {}) {
    res.writeHead(status, headersFor(req, headers));
    res.end(body);
  }

  function sendJson(req, res, status, data, headers = {}) {
    send(req, res, status, JSON.stringify(data), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
  }

  /** 別のサイトから送られてきた書き込みを断る */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function handleApi(req, res, url) {
    const candidates = routes.map((route) => ({ route, match: route.regex.exec(url.pathname) })).filter((c) => c.match);
    if (candidates.length === 0) return sendJson(req, res, 404, { error: '見つかりません' });
    const found = candidates.find(({ route }) => route.method === req.method);
    if (!found) return sendJson(req, res, 405, { error: 'このメソッドは使えません' });

    const { route, match } = found;
    const ip = clientIp(req);
    const writes = !['GET', 'HEAD'].includes(req.method);
    if (writes && !route.skipOriginCheck && !sameOrigin(req)) {
      return sendJson(req, res, 403, { error: 'このページからは送信できません' });
    }
    if (route.staff && !auth.isLoggedIn(req)) return sendJson(req, res, 401, { error: 'ログインしてください' });
    if (route.limit && !limiters[route.limit].allow(ip)) {
      return sendJson(req, res, 429, { error: 'アクセスが集中しています。少し時間をおいてお試しください' });
    }

    let params;
    try {
      params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
    } catch {
      return sendJson(req, res, 400, { error: 'アドレスが正しくありません' });
    }
    let body = {};
    let raw = null;
    if (writes) {
      raw = await readBody(req, route.maxBytes ?? MAX_JSON_BYTES);
      if (route.body !== 'raw') body = parseJson(raw, req.headers['content-type']);
    }
    const headers = {};
    const result = await route.handle({ req, res, params, query: url.searchParams, body, raw, headers, ip });
    if (result === RAW) return undefined;
    return sendJson(req, res, route.status ?? 200, result, headers);
  }

  async function serveUpload(req, res, name) {
    if (!isUploadName(name)) return send(req, res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    try {
      const data = await readFile(join(uploads, name));
      return send(req, res, 200, req.method === 'HEAD' ? undefined : data, {
        'Content-Type': IMAGE_TYPES[name.split('.').pop()],
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'",
      });
    } catch {
      return send(req, res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }

  async function serveStatic(req, res, pathname) {
    let relative;
    try {
      relative = decodeURIComponent(PAGE_ALIASES[pathname] ?? pathname);
    } catch {
      return send(req, res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const filePath = normalize(join(publicDir, relative));
    if (!filePath.startsWith(publicDir + sep)) {
      return send(req, res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    try {
      const data = await readFile(filePath);
      return send(req, res, 200, req.method === 'HEAD' ? undefined : data, {
        'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
    } catch {
      return send(req, res, 404, 'ページが見つかりません', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }

  async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(req, res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(req, res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      if (url.pathname.startsWith('/uploads/')) return await serveUpload(req, res, url.pathname.slice('/uploads/'.length));
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof AppError) {
        return sendJson(req, res, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message });
      }
      console.error(err);
      return sendJson(req, res, 500, { error: 'サーバーでエラーが起きました' });
    }
  }

  return { handler, store, content, customers, auth, audit, passwordCreated, uploadDir: uploads, close: () => db.close() };
}
