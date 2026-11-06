// Node.js で動かすときの入り口（パソコンや VPS で使う場合）
import { createServer } from 'node:http';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp, securityHeaders } from './src/app.js';
import { openNodeDatabase } from './src/adapters/node-sqlite.js';
import { connectNodeSocket } from './src/adapters/node-socket.js';
import { createNotifier } from './src/notify.js';
import { checkPasswordStrength } from './src/auth.js';
import { randomHex } from './src/random.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
const PAGE_ALIASES = { '/': '/index.html', '/admin': '/admin.html', '/admin/': '/admin.html', '/unsubscribe': '/unsubscribe.html' };

/** パスワードのハッシュに混ぜる秘密の文字列。データベースとは別のファイルに置く */
export async function loadPepper(dbPath, env) {
  if (env.PASSWORD_PEPPER) return env.PASSWORD_PEPPER;
  if (dbPath === ':memory:') return '';
  const file = join(dirname(resolve(dbPath)), 'pepper.txt');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    await mkdir(dirname(file), { recursive: true });
    const pepper = randomHex(32);
    await writeFile(file, pepper, { mode: 0o600, flag: 'wx' });
    return pepper;
  }
}

/** Node の req を Web 標準の Request にする */
async function toRequest(req, trustProxy) {
  const forwardedProto = trustProxy ? String(req.headers['x-forwarded-proto'] ?? '') : '';
  const proto = req.socket.encrypted || forwardedProto === 'https' ? 'https' : 'http';
  const url = `${proto}://${req.headers.host ?? 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, value);
  }
  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

async function writeResponse(res, response) {
  const headers = {};
  for (const [key, value] of response.headers) if (key !== 'set-cookie') headers[key] = value;
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

async function serveStatic(request, pathname) {
  const text = (status, body) => new Response(body, { status, headers: securityHeaders(request, { 'Content-Type': 'text/plain; charset=utf-8' }) });
  if (!['GET', 'HEAD'].includes(request.method)) return text(405, 'Method Not Allowed');
  let relative;
  try {
    relative = decodeURIComponent(PAGE_ALIASES[pathname] ?? pathname);
  } catch {
    return text(400, 'Bad Request');
  }
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR + sep)) return text(404, 'Not Found');
  try {
    const data = await readFile(filePath);
    return new Response(request.method === 'HEAD' ? null : data, {
      headers: securityHeaders(request, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }),
    });
  } catch {
    return text(404, 'ページが見つかりません');
  }
}

export async function startServer(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 3000;
  const host = env.HOST || '0.0.0.0';
  const dbPath = env.DB_PATH || 'data/happyroad.db';
  const trustProxy = env.TRUST_PROXY === '1';

  // 管理画面のパスワード（最初の起動のときだけ使い、ハッシュにして保存する）
  let adminPassword = env.ADMIN_PASSWORD;
  if (adminPassword) {
    try {
      checkPasswordStrength(adminPassword);
    } catch (err) {
      if (production) {
        console.error(`ADMIN_PASSWORD: ${err.message}`);
        process.exit(1);
      }
      console.warn(`⚠ ADMIN_PASSWORD: ${err.message}（お店で使うときは必ず直してください）`);
    }
  } else if (!production) {
    adminPassword = 'happyroad-dev';
  }

  const db = openNodeDatabase(dbPath);
  const notifier = createNotifier(env, { connectSocket: connectNodeSocket });
  let app;
  try {
    app = await createApp({
      db,
      adminPassword,
      timezone: env.STORE_TIMEZONE || 'Asia/Tokyo',
      notifier,
      publicUrl: env.PUBLIC_URL || '',
      pepper: await loadPepper(dbPath, env),
      backupFile: async () => {
        const file = join(tmpdir(), `happyroad-backup-${randomHex(8)}.db`);
        try {
          await db.backupTo(file);
          return await readFile(file);
        } finally {
          await rm(file, { force: true });
        }
      },
    });
  } catch (err) {
    console.error(err.message);
    console.error('例）ADMIN_PASSWORD=長くて推測されにくいパスワード npm start');
    process.exit(1);
  }
  if (app.passwordCreated && !env.ADMIN_PASSWORD) {
    console.warn('⚠ 開発用の仮パスワード "happyroad-dev" で始めました。お店で使う前に、管理画面の「設定」でパスワードを変えてください。');
  }

  const server = createServer(async (req, res) => {
    try {
      const request = await toRequest(req, trustProxy);
      if (!request) {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('送信データが大きすぎます');
        return;
      }
      const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
      const clientIp = forwarded || req.socket.remoteAddress || '';
      const response =
        (await app.fetch(request, { clientIp, waitUntil: () => {} })) ?? (await serveStatic(request, new URL(request.url).pathname));
      await writeResponse(res, response);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('サーバーでエラーが起きました');
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  await new Promise((done) => server.listen(port, host, done));
  const listening = server.address().port;
  console.log('cafe ハッピーロード 予約管理システムを起動しました');
  console.log(`  予約ページ : http://localhost:${listening}/`);
  console.log(`  管理画面   : http://localhost:${listening}/admin`);
  console.log(`  データ     : ${dbPath}`);
  const status = notifier.status();
  console.log(`  メール送信 : ${status.email ? '設定済み' : '未設定'}　LINE送信 : ${status.line ? '設定済み' : '未設定'}`);

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  if (!env.NO_SIGNAL_HANDLERS) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  return { server, close: () => new Promise((done) => server.close(() => (db.close(), done()))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startServer();
}
