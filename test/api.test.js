import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';

const PASSWORD = 'test-pass-1234';
const LINE_SECRET = 'line-secret';
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
  verifyLineSignature(raw, sig) {
    return sig === createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
  },
};

let app;
let server;
let base;
let uploadDir;

before(async () => {
  uploadDir = await mkdtemp(join(tmpdir(), 'hr-test-'));
  app = await createApp({
    adminPassword: PASSWORD,
    now: () => new Date('2026-11-06T01:00:00Z'),
    uploadDir,
    notifier: fakeNotifier,
    publicUrl: 'https://happyroad.example.jp',
  });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  app.close();
  await rm(uploadDir, { recursive: true, force: true });
});

function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const payload = body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return fetch(base + path, { method, headers: h, body: payload });
}

async function login() {
  const res = await call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

describe('お客様向け', () => {
  test('ページ・店舗情報・カレンダー・メニューを返す', async () => {
    const page = await call('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const info = await (await call('/api/info')).json();
    assert.equal(info.storeName, 'cafe ハッピーロード');
    assert.equal(info.areas.length, 4);
    const cal = await (await call('/api/calendar?month=2026-11&party=2')).json();
    assert.equal(cal.days.length, 30);
    assert.equal((await call('/api/menu?date=2026-11-07')).status, 200);
  });

  test('Web予約すると確認メールが届く', async () => {
    sent.emails.length = 0;
    const res = await call('/api/reservations', {
      method: 'POST',
      body: { date: '2026-11-07', time: '13:00', partySize: 3, name: '中村', phone: '080-1111-2222', email: 'naka@example.com' },
    });
    assert.equal(res.status, 201);
    const { reservation } = await res.json();
    await new Promise((r) => setTimeout(r, 20));
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

  test('public フォルダの外や、知らない写真は読めない', async () => {
    assert.equal((await call('/..%2Fpackage.json')).status, 404);
    assert.equal((await call('/uploads/..%2F..%2Fpackage.json')).status, 404);
  });
});

describe('セキュリティ', () => {
  test('管理APIはログインが必要で、パスワードはハッシュで保存される', async () => {
    assert.equal((await call('/api/admin/reservations')).status, 401);
    assert.equal((await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
    const stored = app.auth && (await call('/api/admin/session')).status;
    assert.equal(stored, 200);
    const cookie = await login();
    assert.match(cookie, /^hr_session=[0-9a-f]{64}$/);
    assert.equal((await call('/api/admin/reservations?date=2026-11-07', { cookie })).status, 200);
    await call('/api/admin/logout', { method: 'POST', body: {}, cookie });
    assert.equal((await call('/api/admin/reservations', { cookie })).status, 401);
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
    const res = await fetch(`${base}/api/reservations`, { method: 'POST', body: 'name=x' });
    assert.equal(res.status, 415);
  });

  test('パスワードを変えると、ほかの端末はログアウトする', async () => {
    const other = await login();
    const mine = await login();
    const weak = await call('/api/admin/password', { method: 'POST', cookie: mine, body: { current: PASSWORD, next: 'short' } });
    assert.equal(weak.status, 400);
    const res = await call('/api/admin/password', {
      method: 'POST',
      cookie: mine,
      body: { current: PASSWORD, next: 'new-password-5678' },
    });
    assert.equal(res.status, 200);
    const fresh = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/admin/menu', { cookie: other })).status, 401);
    assert.equal((await call('/api/admin/menu', { cookie: fresh })).status, 200);
    // 元に戻す
    await call('/api/admin/password', { method: 'POST', cookie: fresh, body: { current: 'new-password-5678', next: PASSWORD } });
  });

  test('写真は中身が画像のときだけ受け付ける', async () => {
    const cookie = await login();
    const fake = await call('/api/admin/uploads', {
      method: 'POST',
      cookie,
      body: Buffer.from('<script>alert(1)</script>'),
      headers: { 'Content-Type': 'image/png' },
    });
    assert.equal(fake.status, 415);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const ok = await call('/api/admin/uploads', { method: 'POST', cookie, body: png, headers: { 'Content-Type': 'image/png' } });
    assert.equal(ok.status, 201);
    const { photo, photoUrl } = await ok.json();
    const img = await call(photoUrl);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');

    // メニューに付けて、メニューを消すと写真も消える
    const created = await (await call('/api/admin/menu', { method: 'POST', cookie, body: { name: 'ラテ', price: 500, photo } })).json();
    assert.equal(created.item.photoUrl, photoUrl);
    await call(`/api/admin/menu/${created.item.id}`, { method: 'DELETE', cookie });
    assert.deepEqual(await readdir(uploadDir), []);
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
    const bytes = Buffer.from(await backup.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 15), 'SQLite format 3');
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
    const res = await call('/api/admin/reservations', {
      method: 'POST',
      cookie,
      body: { date: '2026-11-07', time: '13:00', partySize: 2, name: '超過' },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'over_capacity');
    await call('/api/admin/settings', { method: 'PUT', cookie, body: { maxGuestsPerSlot: 0 } });
  });

  test('臨時休業日を入れると、その日に予約のあるお客様がわかる', async () => {
    const cookie = await login();
    const res = await call('/api/admin/closures', { method: 'POST', cookie, body: { date: '2026-11-07', reason: '設備点検' } });
    const data = await res.json();
    assert.equal(data.closure.reservations, 1);
    assert.equal(data.customerIds.length, 1);
    await call('/api/admin/closures/2026-11-07', { method: 'DELETE', cookie });
  });
});

describe('お知らせ', () => {
  test('希望した人全員・選んだ人にメールとLINEで送れる', async () => {
    const cookie = await login();
    // お知らせ希望ありのお客様を作る
    await call('/api/reservations', {
      method: 'POST',
      body: { date: '2026-11-08', time: '12:00', partySize: 2, name: '希望あり', phone: '090-5555-0001', email: 'yes@example.com', notifyEmail: true },
    });
    await call('/api/reservations', {
      method: 'POST',
      body: { date: '2026-11-08', time: '12:00', partySize: 2, name: '希望なし', phone: '090-5555-0002', email: 'bad@example.com' },
    });
    sent.emails.length = 0;
    const all = await call('/api/admin/messages', {
      method: 'POST',
      cookie,
      body: { subject: '年末年始のお休み', body: '12/31〜1/3はお休みです', channels: ['email'], target: 'all' },
    });
    assert.equal(all.status, 201);
    const result = await all.json();
    assert.deepEqual(result.summary.email, { sent: 1, failed: 0 });
    assert.equal(sent.emails[0].to, 'yes@example.com');
    assert.match(sent.emails[0].text, /配信の停止：https:\/\/happyroad\.example\.jp\/unsubscribe\.html#[a-f0-9]{32}/);

    // 選んだ人へ（予約の連絡なので、希望なしの人にも送る）
    const { customers } = await (await call('/api/admin/customers?q=希望なし', { cookie })).json();
    const selected = await (
      await call('/api/admin/messages', {
        method: 'POST',
        cookie,
        body: { subject: 'ご予約について', body: '本文', channels: ['email'], target: 'selected', customerIds: [customers[0].id] },
      })
    ).json();
    assert.deepEqual(selected.summary.email, { sent: 0, failed: 1 });
    assert.equal(selected.failures[0].name, '希望なし');

    const history = await (await call('/api/admin/messages', { cookie })).json();
    assert.equal(history.messages.length, 2);
  });

  test('配信停止リンクでメールのお知らせを止められる', async () => {
    const link = sent.emails.find((m) => m.to === 'yes@example.com')?.text.match(/#([a-f0-9]{32})/)[1];
    const res = await call('/api/unsubscribe', { method: 'POST', body: { token: link } });
    assert.equal(res.status, 200);
    const cookie = await login();
    const again = await call('/api/admin/messages', {
      method: 'POST',
      cookie,
      body: { subject: 'テスト', body: '本文', channels: ['email'], target: 'all' },
    });
    assert.equal(again.status, 400);
  });

  test('LINEで予約番号を送ると、そのお客様とLINEがつながる', async () => {
    const { reservation } = await (
      await call('/api/reservations', {
        method: 'POST',
        body: { date: '2026-11-09', time: '12:00', partySize: 2, name: 'ライン太郎', phone: '090-7777-0001' },
      })
    ).json();
    const userId = `U${'a'.repeat(32)}`;
    const payload = JSON.stringify({
      events: [{ type: 'message', replyToken: 't', source: { type: 'user', userId }, message: { type: 'text', text: `予約番号は ${reservation.code.toLowerCase()} です` } }],
    });
    const forged = await call('/api/line/webhook', { method: 'POST', body: Buffer.from(payload), headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'bad' } });
    assert.equal(forged.status, 401);
    const signature = createHmac('sha256', LINE_SECRET).update(payload).digest('base64');
    const ok = await call('/api/line/webhook', {
      method: 'POST',
      body: Buffer.from(payload),
      headers: { 'Content-Type': 'application/json', 'X-Line-Signature': signature },
    });
    assert.equal(ok.status, 200);
    assert.match(sent.replies.at(-1), /ライン太郎様、LINEでのお知らせを登録しました/);

    const cookie = await login();
    const res = await (
      await call('/api/admin/messages', {
        method: 'POST',
        cookie,
        body: { subject: '臨時休業', body: '11/20はお休みです', channels: ['line'], target: 'all' },
      })
    ).json();
    assert.deepEqual(res.summary.line, { sent: 1, failed: 0 });
    assert.deepEqual(sent.line.at(-1).ids, [userId]);
  });
});
