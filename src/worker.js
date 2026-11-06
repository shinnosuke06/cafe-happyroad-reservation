// Cloudflare Workers（無料プラン）で動かすときの入り口。
// データベースは Cloudflare D1、ページ（public/）は Workers の静的ファイル配信を使う。
import { connect } from 'cloudflare:sockets';
import { createApp, securityHeaders } from './app.js';
import { d1Database } from './adapters/d1.js';
import { createNotifier } from './notify.js';

const PAGE_ALIASES = { '/': '/index.html', '/admin': '/admin.html', '/admin/': '/admin.html', '/unsubscribe': '/unsubscribe.html' };

/** メールサーバーにつなぐソケット（Cloudflare 用） */
async function connectCloudflareSocket({ host, port, secure }) {
  const socket = connect(
    { hostname: host, port },
    { secureTransport: secure === 'ssl' ? 'on' : secure === 'starttls' ? 'starttls' : 'off' },
  );
  await socket.opened;
  return wrap(socket);
}

function wrap(socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : value;
    },
    write: (text) => writer.write(encoder.encode(text)),
    async startTls() {
      reader.releaseLock();
      writer.releaseLock();
      return wrap(socket.startTls());
    },
    close: () => socket.close(),
  };
}

let appPromise = null;
function getApp(env, origin) {
  appPromise ??= createApp({
    db: d1Database(env.DB),
    adminPassword: env.ADMIN_PASSWORD,
    timezone: env.STORE_TIMEZONE || 'Asia/Tokyo',
    notifier: createNotifier(env, { connectSocket: connectCloudflareSocket }),
    publicUrl: env.PUBLIC_URL || origin,
    pepper: env.PASSWORD_PEPPER || '',
  }).catch((err) => {
    appPromise = null;
    throw err;
  });
  return appPromise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
      let app;
      try {
        app = await getApp(env, url.origin);
      } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: 'サーバーの準備ができていません。お店の方は設定（ADMIN_PASSWORD）をご確認ください' }), {
          status: 503,
          headers: securityHeaders(request, { 'Content-Type': 'application/json; charset=utf-8' }),
        });
      }
      return app.fetch(request, {
        clientIp: request.headers.get('cf-connecting-ip') ?? '',
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
    }

    // ページ（HTML・CSS・JS・画像）
    const alias = PAGE_ALIASES[url.pathname];
    const assetRequest = alias ? new Request(new URL(alias, url), request) : request;
    const asset = await env.ASSETS.fetch(assetRequest);
    const headers = securityHeaders(request, Object.fromEntries(asset.headers));
    if (asset.status === 404) {
      return new Response('ページが見つかりません', { status: 404, headers: securityHeaders(request, { 'Content-Type': 'text/plain; charset=utf-8' }) });
    }
    return new Response(asset.body, { status: asset.status, headers });
  },
};
