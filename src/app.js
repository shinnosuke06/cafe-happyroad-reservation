// API の本体。Web 標準の Request / Response で書いているので、Node でも Cloudflare でも動く。
// ページ（HTML・CSS・JS）の配信は、それぞれの入り口（server.js / worker.js）が受け持つ。
import { migrate } from './db.js';
import { createStore } from './store.js';
import { createContent, MAX_IMAGE_BYTES } from './content.js';
import { createCustomers } from './customers.js';
import { createAuth } from './auth.js';
import { createRateLimiter, createAudit } from './guard.js';
import { createNotifier } from './notify.js';
import { AppError } from './validate.js';
import { formatDateJa } from './time.js';

const MAX_JSON_BYTES = 64 * 1024;

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

/** HTTPS のときは HSTS も付ける */
export function securityHeaders(request, extra = {}) {
  const headers = new Headers({ ...SECURITY_HEADERS, ...extra });
  if (new URL(request.url).protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');
  return headers;
}

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

async function readBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > maxBytes) throw new AppError('送信データが大きすぎます', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maxBytes) throw new AppError('送信データが大きすぎます', 413);
  return bytes;
}

function parseJson(bytes, contentType) {
  if (bytes.length === 0) return {};
  if (!(contentType ?? '').includes('application/json')) {
    throw new AppError('Content-Type は application/json にしてください', 415);
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new AppError('送信データの形式が正しくありません');
  }
}

/**
 * db         … 共通の形のデータベース（adapters/ を参照）
 * pepper     … パスワードのハッシュに混ぜる秘密の文字列（変えるとログインできなくなる）
 * backupFile … バックアップ用にデータベースを1つのファイルにまとめる関数（Node のみ）
 */
export async function createApp({
  db,
  adminPassword,
  timezone = 'Asia/Tokyo',
  now = () => new Date(),
  notifier = createNotifier({}),
  publicUrl = '',
  pepper = '',
  backupFile = null,
} = {}) {
  await migrate(db);
  const isHttps = (request) => new URL(request.url).protocol === 'https:';
  const ipOf = new WeakMap(); // リクエストごとのお客様の IP
  const store = createStore(db, { now, timezone });
  const content = createContent(db, { now, today: store.today });
  const customers = createCustomers(db, { now, today: store.today, store, notifier, publicUrl });
  const audit = createAudit(db, { now });
  const auth = createAuth(db, {
    now: () => new Date(now()).getTime(),
    isHttps,
    clientIp: (request) => ipOf.get(request) ?? '',
    pepper,
  });

  const passwordCreated = !(await auth.hasPassword());
  if (passwordCreated) {
    if (!adminPassword) throw new Error('最初の起動では管理画面のパスワード（ADMIN_PASSWORD）が必要です');
    await auth.setPassword(adminPassword);
  }

  const limit = (name, count, windowMs) =>
    createRateLimiter(db, { name, limit: count, windowMs, now: () => new Date(now()).getTime() });
  const limiters = {
    book: limit('book', 6, 10 * 60_000),
    lookup: limit('lookup', 15, 10 * 60_000),
    upload: limit('upload', 60, 10 * 60_000),
    line: limit('line', 10, 60 * 60_000),
  };

  // ---- 予約確認メール（送れなくても予約は成立させる） ----
  async function sendConfirmation(r) {
    if (!r.email || !notifier.status().email) return;
    const s = await store.getSettings();
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
    lines.push('', '予約の確認・キャンセルは、予約ページの「予約の確認・キャンセル」から、予約番号と電話番号で行えます。');
    if (publicUrl) lines.push(`予約ページ：${publicUrl}`);
    lines.push('', '――――――――――', s.storeName);
    if (s.storePhone) lines.push(`電話：${s.storePhone}`);
    try {
      const [result] = await notifier.sendEmails([
        { to: r.email, subject: `【${s.storeName}】ご予約ありがとうございます（${r.code}）`, text: lines.join('\n') },
      ]);
      if (!result.ok) await audit.log('確認メールの送信に失敗', `${r.code} ${result.error}`);
    } catch (err) {
      await audit.log('確認メールの送信に失敗', `${r.code} ${err.message}`);
    }
  }

  async function replyLine(token, message) {
    if (!token || !message) return;
    try {
      await notifier.replyLine(token, message);
    } catch (err) {
      await audit.log('LINEの返信に失敗', err.message);
    }
  }

  const describe = (r) => `${r.date} ${r.time} ${r.name}様 ${r.partySize}名`;
  const ok = { ok: true };

  // [メソッド, パス, 処理, オプション]
  // オプション: staff = ログインが必要 / status = 成功時のコード / body = 'raw' / limit = 回数制限
  const routes = [
    // ---------- お客様向け ----------
    [
      'GET',
      '/api/info',
      async () => ({ ...(await store.publicInfo()), announcements: await content.activeAnnouncements(), emailEnabled: notifier.status().email }),
    ],
    ['GET', '/api/calendar', ({ query }) => store.calendar(query.get('month'), query.get('party'), query.get('area') ?? '')],
    ['GET', '/api/availability', ({ query }) => store.availability(query.get('date'), query.get('party'), query.get('area') ?? '')],
    ['GET', '/api/menu', ({ query }) => content.publicMenu(query.get('date'))],
    [
      'POST',
      '/api/reservations',
      async ({ body, ip, background }) => {
        // 人には見えない入力欄。機械が入力したら受け付けない
        if (body.website) {
          await audit.log('不審な予約をブロック', '', ip);
          throw new AppError('送信できませんでした。お電話でご予約ください');
        }
        const { publicView, reservation } = await store.createPublicReservation(body);
        background(sendConfirmation(reservation));
        return { reservation: publicView };
      },
      { status: 201, limit: 'book' },
    ],
    ['POST', '/api/reservations/lookup', async ({ body }) => ({ reservation: await store.lookupReservation(body) }), { limit: 'lookup' }],
    [
      'POST',
      '/api/reservations/cancel',
      async ({ body, ip }) => {
        const reservation = await store.cancelByCustomer(body);
        await audit.log('お客様がキャンセル', `${reservation.code} ${reservation.date} ${reservation.time} ${reservation.name}様`, ip);
        return { reservation };
      },
      { limit: 'lookup' },
    ],
    ['POST', '/api/unsubscribe', ({ body }) => customers.unsubscribe(body.token), { limit: 'lookup' }],
    [
      'POST',
      '/api/line/webhook',
      async ({ request, raw, background }) => {
        if (!(await notifier.verifyLineSignature(raw, request.headers.get('x-line-signature')))) {
          throw new AppError('署名が正しくありません', 401);
        }
        let payload;
        try {
          payload = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          throw new AppError('形式が正しくありません');
        }
        const storeName = (await store.getSettings()).storeName;
        for (const event of Array.isArray(payload.events) ? payload.events : []) {
          const userId = event.source?.type === 'user' ? event.source.userId : null;
          if (typeof userId !== 'string' || !/^U[0-9a-f]{32}$/.test(userId)) continue;
          if (event.type === 'unfollow') {
            await customers.unlinkLine(userId);
          } else if (event.type === 'follow') {
            background(
              replyLine(
                event.replyToken,
                `${storeName}です。友だち追加ありがとうございます。\nご予約のときの「予約番号（6文字）」をこのトークに送っていただくと、お休みやお知らせをLINEでお届けします。`,
              ),
            );
          } else if (event.type === 'message' && event.message?.type === 'text') {
            if (!(await limiters.line.allow(userId))) continue;
            const result = await customers.linkLineByMessage(userId, String(event.message.text).slice(0, 200));
            if (result.linked) {
              await audit.log('LINEの登録', `${result.name}様`);
              background(replyLine(event.replyToken, `${result.name}様、LINEでのお知らせを登録しました。ありがとうございます。`));
            } else if (result.reason === 'not_found') {
              background(replyLine(event.replyToken, '予約番号が見つかりませんでした。6文字の予約番号をもう一度お確かめください。'));
            } else if (!(await customers.isLineLinked(userId))) {
              background(replyLine(event.replyToken, 'お知らせを受け取るには、ご予約のときの予約番号（6文字）を送ってください。'));
            }
          }
        }
        return ok;
      },
      { body: 'raw', maxBytes: 1024 * 1024, skipOriginCheck: true },
    ],

    // ---------- スタッフのログイン ----------
    ['GET', '/api/admin/session', async ({ request }) => ({ loggedIn: await auth.isLoggedIn(request) })],
    [
      'POST',
      '/api/admin/login',
      async ({ request, body, headers, ip }) => {
        try {
          headers.set('Set-Cookie', await auth.login(request, body.password));
        } catch (err) {
          if (err.audit) await audit.log(err.audit, '', ip);
          throw err;
        }
        await audit.log('ログイン', '', ip);
        return { loggedIn: true };
      },
    ],
    [
      'POST',
      '/api/admin/logout',
      async ({ request, headers, ip }) => {
        headers.set('Set-Cookie', await auth.logout(request));
        await audit.log('ログアウト', '', ip);
        return { loggedIn: false };
      },
    ],
    [
      'POST',
      '/api/admin/password',
      async ({ request, body, headers, ip }) => {
        headers.set('Set-Cookie', await auth.changePassword(request, body.current, body.next));
        await audit.log('パスワードを変更', 'ほかの端末はログアウトしました', ip);
        return ok;
      },
      { staff: true },
    ],

    // ---------- 予約 ----------
    [
      'GET',
      '/api/admin/reservations',
      async ({ query }) => {
        if (query.has('q')) return { reservations: await store.searchReservations(query.get('q')) };
        const date = query.get('date') || store.today();
        return { date, reservations: await store.listReservations(date) };
      },
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/reservations',
      async ({ body, ip }) => {
        const reservation = await store.createStaffReservation(body);
        await audit.log('予約を追加', describe(reservation), ip);
        return { reservation };
      },
      { staff: true, status: 201 },
    ],
    ['GET', '/api/admin/reservations/:id', async ({ params }) => ({ reservation: await store.getReservation(params.id) }), { staff: true }],
    [
      'PATCH',
      '/api/admin/reservations/:id',
      async ({ params, body, ip }) => {
        const reservation = await store.updateStaffReservation(params.id, body);
        await audit.log('予約を変更', describe(reservation), ip);
        return { reservation };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/reservations/:id',
      async ({ params, ip }) => {
        const removed = await store.deleteReservation(params.id);
        await audit.log('予約を削除', describe(removed), ip);
        return ok;
      },
      { staff: true },
    ],

    // ---------- 設定・テーブル・休業日 ----------
    [
      'GET',
      '/api/admin/settings',
      async () => ({
        settings: await store.getSettings(),
        tables: await store.listTables(),
        areas: await store.listAreas(),
        closures: await store.listClosures(),
        today: store.today(),
        notify: { ...notifier.status(), unsubscribeLink: Boolean(publicUrl) },
      }),
      { staff: true },
    ],
    [
      'PUT',
      '/api/admin/settings',
      async ({ body, ip }) => {
        const settings = await store.updateSettings(body);
        await audit.log('設定を変更', '', ip);
        return { settings };
      },
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/tables',
      async ({ body, ip }) => {
        const table = await store.createTable(body);
        await audit.log('テーブルを追加', `${table.name}（${table.seats}席）`, ip);
        return { table };
      },
      { staff: true, status: 201 },
    ],
    [
      'PATCH',
      '/api/admin/tables/:id',
      async ({ params, body, ip }) => {
        const table = await store.updateTable(params.id, body);
        await audit.log('テーブルを変更', `${table.name}（${table.seats}席・${table.active ? '使う' : '休止'}）`, ip);
        return { table };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/tables/:id',
      async ({ params, ip }) => {
        await store.deleteTable(params.id);
        await audit.log('テーブルを削除', `ID ${params.id}`, ip);
        return ok;
      },
      { staff: true },
    ],
    [
      'POST',
      '/api/admin/closures',
      async ({ body, ip }) => {
        const closure = await store.addClosure(body);
        await audit.log('臨時休業日を追加', `${closure.date} ${closure.reason}`, ip);
        return { closure, customerIds: await customers.customerIdsOn(closure.date) };
      },
      { staff: true, status: 201 },
    ],
    [
      'DELETE',
      '/api/admin/closures/:date',
      async ({ params, ip }) => {
        await store.removeClosure(params.date);
        await audit.log('臨時休業日を取り消し', params.date, ip);
        return ok;
      },
      { staff: true },
    ],

    // ---------- メニュー ----------
    ['GET', '/api/admin/menu', async () => ({ items: await content.listMenu() }), { staff: true }],
    [
      'POST',
      '/api/admin/menu',
      async ({ body, ip }) => {
        const item = await content.createMenuItem(body);
        await audit.log('メニューを追加', item.name, ip);
        return { item };
      },
      { staff: true, status: 201 },
    ],
    [
      'PATCH',
      '/api/admin/menu/:id',
      async ({ params, body, ip }) => {
        const item = await content.updateMenuItem(params.id, body);
        await audit.log('メニューを変更', item.name, ip);
        return { item };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/menu/:id',
      async ({ params, ip }) => {
        const item = await content.deleteMenuItem(params.id);
        await audit.log('メニューを削除', item.name, ip);
        return ok;
      },
      { staff: true },
    ],
    ['POST', '/api/admin/menu/:id/move', async ({ params, body }) => ({ items: await content.moveMenuItem(params.id, body.direction) }), { staff: true }],
    [
      'POST',
      '/api/admin/uploads',
      async ({ raw, ip }) => {
        const photo = await content.savePhoto(raw);
        if (!photo) throw new AppError('写真は JPEG・PNG・WebP の画像にしてください', 415);
        await audit.log('写真をアップロード', photo, ip);
        return { photo, photoUrl: `/uploads/${photo}` };
      },
      { staff: true, status: 201, body: 'raw', maxBytes: MAX_IMAGE_BYTES, limit: 'upload' },
    ],

    // ---------- お客様・お知らせ ----------
    ['GET', '/api/admin/customers', async ({ query }) => ({ customers: await customers.listCustomers(query.get('q') ?? '') }), { staff: true }],
    ['GET', '/api/admin/customers/:id', ({ params }) => customers.getCustomer(params.id), { staff: true }],
    [
      'PATCH',
      '/api/admin/customers/:id',
      async ({ params, body, ip }) => {
        const customer = await customers.updateCustomer(params.id, body);
        await audit.log('お客様情報を変更', customer.name, ip);
        return { customer };
      },
      { staff: true },
    ],
    [
      'DELETE',
      '/api/admin/customers/:id',
      async ({ params, ip }) => {
        const customer = await customers.deleteCustomer(params.id);
        await audit.log('お客様情報を削除', customer.name, ip);
        return ok;
      },
      { staff: true },
    ],
    ['GET', '/api/admin/messages', async () => ({ messages: await customers.listMessages() }), { staff: true }],
    [
      'POST',
      '/api/admin/messages',
      async ({ body, ip }) => {
        const result = await customers.sendMessage(body);
        const { email, line } = result.summary;
        await audit.log(
          'お知らせを送信',
          `${String(body.subject).slice(0, 40)}（メール${email.sent}件・LINE${line.sent}件、失敗${email.failed + line.failed}件）`,
          ip,
        );
        return result;
      },
      { staff: true, status: 201 },
    ],
    ['GET', '/api/admin/announcements', async () => ({ announcements: await content.listAnnouncements() }), { staff: true }],
    [
      'POST',
      '/api/admin/announcements',
      async ({ body, ip }) => {
        const announcement = await content.createAnnouncement(body);
        await audit.log('お知らせを掲載', announcement.title, ip);
        return { announcement };
      },
      { staff: true, status: 201 },
    ],
    [
      'DELETE',
      '/api/admin/announcements/:id',
      async ({ params, ip }) => {
        const announcement = await content.deleteAnnouncement(params.id);
        await audit.log('お知らせを削除', announcement.title, ip);
        return ok;
      },
      { staff: true },
    ],

    // ---------- 記録・バックアップ ----------
    ['GET', '/api/admin/audit', async () => ({ entries: await audit.list(200) }), { staff: true }],
    [
      'GET',
      '/api/admin/backup',
      async ({ request, ip }) => {
        const day = store.today();
        let bytes;
        let type;
        let filename;
        if (backupFile) {
          bytes = await backupFile();
          type = 'application/vnd.sqlite3';
          filename = `happyroad-backup-${day}.db`;
        } else {
          bytes = new TextEncoder().encode(JSON.stringify(await exportData(), null, 1));
          type = 'application/json; charset=utf-8';
          filename = `happyroad-backup-${day}.json`;
        }
        await audit.log('バックアップを保存', '', ip);
        return new Response(bytes, {
          headers: securityHeaders(request, {
            'Content-Type': type,
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
          }),
        });
      },
      { staff: true },
    ],
  ].map(([method, pattern, handle, options = {}]) => ({ method, handle, ...compile(pattern), ...options }));

  /** 写真・パスワード・ログイン状態を除いた、全データの書き出し */
  async function exportData() {
    const tables = ['settings', 'tables', 'closures', 'customers', 'reservations', 'reservation_items', 'menu_items', 'announcements', 'messages', 'message_deliveries'];
    const data = { exportedAt: new Date(now()).toISOString() };
    for (const name of tables) data[name] = await db.all(`SELECT * FROM ${name}`);
    return data;
  }

  function json(request, status, data, headers = new Headers()) {
    const out = securityHeaders(request, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    for (const [k, v] of headers) out.append(k, v);
    return new Response(JSON.stringify(data), { status, headers: out });
  }

  /** 別のサイトから送られてきた書き込みを断る */
  function sameOrigin(request) {
    const origin = request.headers.get('origin');
    if (!origin) return true;
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }

  async function handleApi(request, url, ip, background) {
    const candidates = routes.map((route) => ({ route, match: route.regex.exec(url.pathname) })).filter((c) => c.match);
    if (candidates.length === 0) return json(request, 404, { error: '見つかりません' });
    const found = candidates.find(({ route }) => route.method === request.method);
    if (!found) return json(request, 405, { error: 'このメソッドは使えません' });

    const { route, match } = found;
    const writes = !['GET', 'HEAD'].includes(request.method);
    if (writes && !route.skipOriginCheck && !sameOrigin(request)) {
      return json(request, 403, { error: 'このページからは送信できません' });
    }
    if (route.staff && !(await auth.isLoggedIn(request))) return json(request, 401, { error: 'ログインしてください' });
    if (route.limit && !(await limiters[route.limit].allow(ip || 'unknown'))) {
      return json(request, 429, { error: 'アクセスが集中しています。少し時間をおいてお試しください' });
    }

    let params;
    try {
      params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
    } catch {
      return json(request, 400, { error: 'アドレスが正しくありません' });
    }
    let body = {};
    let raw = null;
    if (writes) {
      raw = await readBody(request, route.maxBytes ?? MAX_JSON_BYTES);
      if (route.body !== 'raw') body = parseJson(raw, request.headers.get('content-type'));
    }
    const headers = new Headers();
    const result = await route.handle({ request, params, query: url.searchParams, body, raw, headers, ip, background });
    if (result instanceof Response) return result;
    return json(request, route.status ?? 200, result, headers);
  }

  async function servePhoto(request, name) {
    const photo = await content.getPhoto(name);
    if (!photo) return new Response('Not Found', { status: 404, headers: securityHeaders(request, { 'Content-Type': 'text/plain; charset=utf-8' }) });
    return new Response(request.method === 'HEAD' ? null : photo.data, {
      headers: securityHeaders(request, {
        'Content-Type': photo.mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'",
      }),
    });
  }

  /**
   * API と写真のリクエストに答える。それ以外（ページ）は null を返すので、呼び出し側が配信する。
   * clientIp   … お客様の IP（回数制限と記録に使う）
   * waitUntil  … 返事のあとも続ける処理（確認メールなど）を登録する関数
   */
  async function fetchHandler(request, { clientIp = '', waitUntil } = {}) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    const isApi = url.pathname.startsWith('/api/');
    const isPhoto = url.pathname.startsWith('/uploads/');
    if (!isApi && !isPhoto) return null;
    ipOf.set(request, clientIp);
    const background = (promise) => {
      const safe = Promise.resolve(promise).catch((err) => console.error(err));
      if (waitUntil) waitUntil(safe);
    };
    try {
      if (isPhoto) {
        if (!['GET', 'HEAD'].includes(request.method)) return json(request, 405, { error: 'このメソッドは使えません' });
        return await servePhoto(request, url.pathname.slice('/uploads/'.length));
      }
      return await handleApi(request, url, clientIp, background);
    } catch (err) {
      if (err instanceof AppError) {
        return json(request, err.status, err.code ? { error: err.message, code: err.code } : { error: err.message });
      }
      console.error(err);
      return json(request, 500, { error: 'サーバーでエラーが起きました' });
    }
  }

  return { fetch: fetchHandler, store, content, customers, auth, audit, passwordCreated };
}
