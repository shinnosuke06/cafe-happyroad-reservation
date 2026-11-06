import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { createStore, AppError } from './store.js';
import { createAuth } from './auth.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const PAGE_ALIASES = { '/': '/index.html', '/admin': '/admin.html', '/admin/': '/admin.html' };

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

async function readJson(req) {
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) {
    throw new AppError('Content-Type は application/json にしてください', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError('送信データが大きすぎます', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new AppError('送信データの形式が正しくありません');
  }
}

/** "/api/admin/tables/:id" のようなパターンを正規表現にする */
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

export function createApp({
  dbPath = ':memory:',
  adminPassword,
  timezone = 'Asia/Tokyo',
  now = () => new Date(),
  publicDir = join(ROOT, 'public'),
} = {}) {
  if (!adminPassword) throw new Error('adminPassword が必要です');
  const db = openDatabase(dbPath);
  const store = createStore(db, { now, timezone });
  const auth = createAuth({ password: adminPassword });

  // [メソッド, パス, 処理, { staff: スタッフのみ, status: 成功時のステータス }]
  const routes = [
    // お客様向け
    ['GET', '/api/info', () => store.publicInfo()],
    ['GET', '/api/availability', ({ query }) => store.availability(query.get('date'), query.get('party'))],
    ['POST', '/api/reservations', ({ body }) => ({ reservation: store.createPublicReservation(body) }), { status: 201 }],
    ['POST', '/api/reservations/lookup', ({ body }) => ({ reservation: store.lookupReservation(body) })],
    ['POST', '/api/reservations/cancel', ({ body }) => ({ reservation: store.cancelByCustomer(body) })],

    // スタッフ用ログイン
    ['GET', '/api/admin/session', ({ req }) => ({ loggedIn: auth.isLoggedIn(req) })],
    [
      'POST',
      '/api/admin/login',
      ({ req, body, headers }) => {
        headers['Set-Cookie'] = auth.login(req, body.password);
        return { loggedIn: true };
      },
    ],
    [
      'POST',
      '/api/admin/logout',
      ({ req, headers }) => {
        headers['Set-Cookie'] = auth.logout(req);
        return { loggedIn: false };
      },
    ],

    // スタッフ用（ログインが必要）
    [
      'GET',
      '/api/admin/reservations',
      ({ query }) =>
        query.has('q')
          ? { reservations: store.searchReservations(query.get('q')) }
          : { date: query.get('date') ?? store.today(), reservations: store.listReservations(query.get('date') ?? store.today()) },
      { staff: true },
    ],
    ['POST', '/api/admin/reservations', ({ body }) => ({ reservation: store.createStaffReservation(body) }), { staff: true, status: 201 }],
    ['GET', '/api/admin/reservations/:id', ({ params }) => ({ reservation: store.getReservation(params.id) }), { staff: true }],
    ['PATCH', '/api/admin/reservations/:id', ({ params, body }) => ({ reservation: store.updateStaffReservation(params.id, body) }), { staff: true }],
    [
      'DELETE',
      '/api/admin/reservations/:id',
      ({ params }) => {
        store.deleteReservation(params.id);
        return { ok: true };
      },
      { staff: true },
    ],
    [
      'GET',
      '/api/admin/settings',
      () => ({ settings: store.getSettings(), tables: store.listTables(), closures: store.listClosures(), today: store.today() }),
      { staff: true },
    ],
    ['PUT', '/api/admin/settings', ({ body }) => ({ settings: store.updateSettings(body) }), { staff: true }],
    ['POST', '/api/admin/tables', ({ body }) => ({ table: store.createTable(body) }), { staff: true, status: 201 }],
    ['PATCH', '/api/admin/tables/:id', ({ params, body }) => ({ table: store.updateTable(params.id, body) }), { staff: true }],
    [
      'DELETE',
      '/api/admin/tables/:id',
      ({ params }) => {
        store.deleteTable(params.id);
        return { ok: true };
      },
      { staff: true },
    ],
    ['POST', '/api/admin/closures', ({ body }) => ({ closure: store.addClosure(body) }), { staff: true, status: 201 }],
    [
      'DELETE',
      '/api/admin/closures/:date',
      ({ params }) => {
        store.removeClosure(params.date);
        return { ok: true };
      },
      { staff: true },
    ],
  ].map(([method, pattern, handle, options = {}]) => ({ method, handle, ...compile(pattern), ...options }));

  async function handleApi(req, res, url) {
    const candidates = routes
      .map((route) => ({ route, match: route.regex.exec(url.pathname) }))
      .filter(({ match }) => match);
    if (candidates.length === 0) return sendJson(res, 404, { error: '見つかりません' });
    const found = candidates.find(({ route }) => route.method === req.method);
    if (!found) return sendJson(res, 405, { error: 'このメソッドは使えません' });

    const { route, match } = found;
    if (route.staff && !auth.isLoggedIn(req)) {
      return sendJson(res, 401, { error: 'ログインしてください' });
    }
    const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    const headers = {};
    const result = await route.handle({ req, params, query: url.searchParams, body, headers });
    return sendJson(res, route.status ?? 200, result, headers);
  }

  async function serveStatic(req, res, pathname) {
    let relative;
    try {
      relative = decodeURIComponent(PAGE_ALIASES[pathname] ?? pathname);
    } catch {
      return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    const filePath = normalize(join(publicDir, relative));
    if (!filePath.startsWith(publicDir + sep)) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    try {
      const data = await readFile(filePath);
      return send(res, 200, req.method === 'HEAD' ? undefined : data, {
        'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
    } catch {
      return send(res, 404, 'ページが見つかりません', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err instanceof AppError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      return sendJson(res, 500, { error: 'サーバーでエラーが起きました' });
    }
  }

  return { handler, store, close: () => db.close() };
}
