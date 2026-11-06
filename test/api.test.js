import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openNodeDatabase } from '../src/adapters/node-sqlite.js';
import { startServer } from '../server.js';

const PASSWORD = 'test-pass-1234';
const LINE_SECRET = 'line-secret';
const BASE = 'https://happyroad.example.jp';
const sent = { emails: [], line: [], replies: [] };

// 本物の送信はせず、送った内容を記録するだけ
const fakeNotifier = {
  status: () => ({ email: true, line: true, lineWebhook: true }),
  async sendEmails(list) {
    sent.emails.push(...list);
    return list.map((m) => (m.to.startsWith('bad') ? { ok: false, error: '宛先エラー' } : { ok: true, error: '' }));
  },
  async sendLine(ids, text) {
    sent.line.push({ ids, text });
    return ids.map(() => ({ ok: true, error: '' }));
  },
  async replyLine(token, text) {
    sent.replies.push(text);
  },
  async verifyLineSignature(raw, sig) {
    return sig === createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
  },
};

let app;
const pending = [];

before(async () => {
  app = await createApp({
    db: openNodeDatabase(':memory:'),
    adminPassword: PASSWORD,
    now: () => new Date('2026-11-06T01:00:00Z'),
    notifier: fakeNotifier,
    publicUrl: BASE,
    pepper: 'test-pepper',
  });
});

/** アプリに直接リクエストを送る（Cloudflare でも Node でも同じ入り口） */
async function call(path, { method = 'GET', body, cookie, headers = {}, ip = '203.0.113.1' } = {}) {
  const h = new Headers(headers);
  if (body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
  if (cookie) h.set('Cookie', cookie);
  const payload = body === undefined || body instanceof Uint8Array ? body : JSON.stringify(body);
  const res = await app.fetch(new Request(BASE + path, { method, headers: h, body: payload }), {
    clientIp: ip,
    waitUntil: (p) => pending.push(p),
  });
  return res;
}

async function login() {
  const res = await call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

describe('お客様向け', () => {
  test('店舗情報・カレンダー・メニューを返し、セキュリティヘッダーが付く', async () => {
    const res = await call('/api/info');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
    const info = await res.json();
    assert.equal(info.storeName, 'cafe ハッピーロード');
    assert.equal(info.areas.length, 4);
    const cal = await (await call('/api/calendar?month=2026-11&party=2')).json();
    assert.equal(cal.days.length, 30);
    assert.equal((await call('/api/menu?date=2026-11-07')).status, 200);
  });

  test('ページのリクエストはアプリでは扱わない（入り口が配信する）', async () => {
    assert.equal(await app.fetch(new Request(`${BASE}/index.html`)), null);
  });

  test('Web予約すると確認メールが届く', async () => {
    sent.emails.length = 0;
    const res = await call('/api/reservations', {
      method: 'POST',
      body: { date: '2026-11-07', time: '13:00', partySize: 3, name: '中村', phone: '080-1111-2222', email: 'naka@example.com' },
    });
    assert.equal(res.status, 201);
    const { reservation } = await res.json();
    await Promise.all(pending);
    assert.equal(sent.emails.length, 1);
    assert.match(sent.emails[0].subject, new RegExp(reservation.code));
    assert.match(sent.emails[0].text, /11月7日\(土\) 13:00〜/);
  });

  test('機械による送信（見えない入力欄）は受け付けない', async () => {
    const res = await call('/api/reservations', {
      method: 'POST',
      body: { date: '2026-11-07', time: '15:00', partySize: 2, name: 'bot', phone: '080-1111-9999', website: 'http://spam' },
    });
    assert.equal(res.status, 400);
  });

  test('同じ相手からの予約の送りすぎは止める', async () => {
    const ip = '198.51.100.7';
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const res = await call('/api/reservations', { method: 'POST', body: { date: 'bad' }, ip });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 6), [400, 400, 400, 400, 400, 400]);
    assert.deepEqual(statuses.slice(6), [429, 429]);
  });
});

describe('セキュリティ', () => {
  test('管理APIはログインが必要で、パスワードはハッシュで保存される', async () => {
    assert.equal((await call('/api/admin/reservations')).status, 401);
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
    const cookie = await login();
    assert.match(cookie, /^hr_session=[0-9a-f]{64}$/);
    assert.equal((await call('/api/admin/reservations?date=2026-11-07', { cookie })).status, 200);
    await call('/api/admin/logout', { method: 'POST', body: {}, cookie });
    assert.equal((await call('/api/admin/reservations', { cookie })).status, 401);
  });

  test('ログインを5回まちがえるとロックする', async () => {
    const ip = '192.0.2.50';
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await call('/api/admin/login', { method: 'POST', body: { password: 'wrong' }, ip })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  });

  test('ほかのサイトからの書き込みは断る', async () => {
    const res = await call('/api/reservations', {
      method: 'POST',
      body: { date: '2026-11-07', time: '15:00', partySize: 2, name: 'x', phone: '080-1111-3333' },
      headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403);
  });

  test('JSON 以外の送信ははじく', async () => {
    const res = await call('/api/reservations', { method: 'POST', body: 'name=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(res.status, 415);
  });

  test('パスワードを変えると、ほかの端末はログアウトする', async () => {
    const other = await login();
    const mine = await login();
    const weak = await call('/api/admin/password', { method: 'POST', cookie: mine, body: { current: PASSWORD, next: 'short' } });
    assert.equal(weak.status, 400);
    const res = await call('/api/admin/password', { method: 'POST', cookie: mine, body: { current: PASSWORD, next: 'new-password-5678' } });
    assert.equal(res.status, 200);
    const fresh = res.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await call('/api/admin/menu', { cookie: other })).status, 401);
    assert.equal((await call('/api/admin/menu', { cookie: fresh })).status, 200);
    await call('/api/admin/password', { method: 'POST', cookie: fresh, body: { current: 'new-password-5678', next: PASSWORD } });
  });

  test('写真は中身が画像のときだけ受け付け、データベースから配信する', async () => {
    const cookie = await login();
    const fake = await call('/api/admin/uploads', {
      method: 'POST',
      cookie,
      body: new TextEncoder().encode('<script>alert(1)</script>'),
      headers: { 'Content-Type': 'image/png' },
    });
    assert.equal(fake.status, 415);
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0),
    );
    const ok = await call('/api/admin/uploads', { method: 'POST', cookie, body: png, headers: { 'Content-Type': 'image/png' } });
    assert.equal(ok.status, 201);
    const { photo, photoUrl } = await ok.json();
    const img = await call(photoUrl);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await img.arrayBuffer()), png);

    const created = await (await call('/api/admin/menu', { method: 'POST', cookie, body: { name: 'ラテ', price: 500, photo } })).json();
    assert.equal(created.item.photoUrl, photoUrl);
    await call(`/api/admin/menu/${created.item.id}`, { method: 'DELETE', cookie });
    assert.equal((await call(photoUrl)).status, 404); // 使われなくなった写真は消える
    assert.equal((await call('/uploads/..%2F..%2Fsecrets')).status, 404);
  });

  test('操作の記録が残り、バックアップを保存できる', async () => {
    const cookie = await login();
    const { entries } = await (await call('/api/admin/audit', { cookie })).json();
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes('ログイン失敗'));
    assert.ok(actions.includes('パスワードを変更'));
    assert.ok(actions.includes('不審な予約をブロック'));
    const backup = await call('/api/admin/backup', { cookie });
    assert.equal(backup.status, 200);
    const data = await backup.json(); // Cloudflare 向け（JSON）。Node では SQLite のファイルになる
    assert.ok(Array.isArray(data.reservations));
    assert.equal(data.secrets, undefined);
    assert.equal(data.sessions, undefined);
  });
});

describe('スタッフ操作', () => {
  test('予約を作成・変更・削除できる', async () => {
    const cookie = await login();
    const created = await call('/api/admin/reservations', {
      method: 'POST',
      cookie,
      body: { date: '2026-11-06', time: '14:00', partySize: 2, name: '電話の小林', phone: '090-2222-3333' },
    });
    assert.equal(created.status, 201);
    const { reservation } = await created.json();
    const patched = await call(`/api/admin/reservations/${reservation.id}`, { method: 'PATCH', cookie, body: { status: 'arrived' } });
    assert.equal((await patched.json()).reservation.status, 'arrived');
    assert.equal((await call(`/api/admin/reservations/${reservation.id}`, { method: 'DELETE', cookie })).status, 200);
  });

  test('最大人数をこえると code: over_capacity が返る', async () => {
    const cookie = await login();
    await call('/api/admin/settings', { method: 'PUT', cookie, body: { maxGuestsPerSlot: 4 } });
    const res = await call('/api/admin/reservations', { method: 'POST', cookie, body: { date: '2026-11-07', time: '13:00', partySize: 2, name: '超過' } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'over_capacity');
    await call('/api/admin/settings', { method: 'PUT', cookie, body: { maxGuestsPerSlot: 0 } });
  });

  test('臨時休業日を入れると、その日に予約のあるお客様がわかる', async () => {
    const cookie = await login();
    const data = await (await call('/api/admin/closures', { method: 'POST', cookie, body: { date: '2026-11-07', reason: '設備点検' } })).json();
    assert.equal(data.closure.reservations, 1);
    assert.equal(data.customerIds.length, 1);
    await call('/api/admin/closures/2026-11-07', { method: 'DELETE', cookie });
  });
});

describe('お知らせ', () => {
  test('希望した人全員・選んだ人にメールとLINEで送れる', async () => {
    const cookie = await login();
    await call('/api/reservations', {
      method: 'POST',
      ip: '203.0.113.20',
      body: { date: '2026-11-08', time: '12:00', partySize: 2, name: '希望あり', phone: '090-5555-0001', email: 'yes@example.com', notifyEmail: true },
    });
    await call('/api/reservations', {
      method: 'POST',
      ip: '203.0.113.21',
      body: { date: '2026-11-08', time: '12:00', partySize: 2, name: '希望なし', phone: '090-5555-0002', email: 'bad@example.com' },
    });
    await Promise.all(pending);
    sent.emails.length = 0;
    const all = await call('/api/admin/messages', {
      method: 'POST',
      cookie,
      body: { subject: '年末年始のお休み', body: '12/31〜1/3はお休みです', channels: ['email'], target: 'all' },
    });
    assert.equal(all.status, 201);
    assert.deepEqual((await all.json()).summary.email, { sent: 1, failed: 0 });
    assert.equal(sent.emails[0].to, 'yes@example.com');
    assert.match(sent.emails[0].text, /配信の停止：https:\/\/happyroad\.example\.jp\/unsubscribe\.html#[a-f0-9]{32}/);

    const { customers } = await (await call(`/api/admin/customers?q=${encodeURIComponent('希望なし')}`, { cookie })).json();
    const selected = await (
      await call('/api/admin/messages', {
        method: 'POST',
        cookie,
        body: { subject: 'ご予約について', body: '本文', channels: ['email'], target: 'selected', customerIds: [customers[0].id] },
      })
    ).json();
    assert.deepEqual(selected.summary.email, { sent: 0, failed: 1 });
    assert.equal(selected.failures[0].name, '希望なし');
    assert.equal((await (await call('/api/admin/messages', { cookie })).json()).messages.length, 2);
  });

  test('配信停止リンクでメールのお知らせを止められる', async () => {
    const token = sent.emails.find((m) => m.to === 'yes@example.com').text.match(/#([a-f0-9]{32})/)[1];
    assert.equal((await call('/api/unsubscribe', { method: 'POST', body: { token } })).status, 200);
    const cookie = await login();
    const again = await call('/api/admin/messages', { method: 'POST', cookie, body: { subject: 'テスト', body: '本文', channels: ['email'], target: 'all' } });
    assert.equal(again.status, 400);
  });

  test('LINEで予約番号を送ると、そのお客様とLINEがつながる', async () => {
    const { reservation } = await (
      await call('/api/reservations', {
        method: 'POST',
        ip: '203.0.113.30',
        body: { date: '2026-11-09', time: '12:00', partySize: 2, name: 'ライン太郎', phone: '090-7777-0001' },
      })
    ).json();
    const userId = `U${'a'.repeat(32)}`;
    const payload = JSON.stringify({
      events: [{ type: 'message', replyToken: 't', source: { type: 'user', userId }, message: { type: 'text', text: `予約番号は ${reservation.code.toLowerCase()} です` } }],
    });
    const bytes = new TextEncoder().encode(payload);
    const forged = await call('/api/line/webhook', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'bad' } });
    assert.equal(forged.status, 401);
    const signature = createHmac('sha256', LINE_SECRET).update(payload).digest('base64');
    const ok = await call('/api/line/webhook', { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signature } });
    assert.equal(ok.status, 200);
    await Promise.all(pending);
    assert.match(sent.replies.at(-1), /ライン太郎様、LINEでのお知らせを登録しました/);

    const cookie = await login();
    const res = await (
      await call('/api/admin/messages', { method: 'POST', cookie, body: { subject: '臨時休業', body: '11/20はお休みです', channels: ['line'], target: 'all' } })
    ).json();
    assert.deepEqual(res.summary.line, { sent: 1, failed: 0 });
    assert.deepEqual(sent.line.at(-1).ids, [userId]);
  });
});

describe('Node で動かす入り口（server.js）', () => {
  let running;
  let base;
  before(async () => {
    running = await startServer({ PORT: '0', HOST: '127.0.0.1', DB_PATH: ':memory:', ADMIN_PASSWORD: PASSWORD, NO_SIGNAL_HANDLERS: '1' });
    base = `http://127.0.0.1:${running.server.address().port}`;
  });
  after(() => running.close());

  test('ページと API を配信し、public の外は読めない', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /ご予約/);
    assert.equal((await fetch(`${base}/admin`)).status, 200);
    assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
    assert.equal((await (await fetch(`${base}/api/info`)).json()).storeName, 'cafe ハッピーロード');
  });

  test('ログインの Cookie が届き、Node ではバックアップが SQLite のファイルになる', async () => {
    const res = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = res.headers.getSetCookie()[0].split(';')[0];
    const backup = await fetch(`${base}/api/admin/backup`, { headers: { Cookie: cookie } });
    const bytes = new Uint8Array(await backup.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), 'SQLite format 3');
  });
});
