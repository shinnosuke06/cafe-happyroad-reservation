import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.js';

let app;
let server;
let base;

before(async () => {
  app = createApp({ adminPassword: 'test-pass', now: () => new Date('2026-11-06T01:00:00Z') });
  server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  app.close();
});

function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function login() {
  const res = await call('/api/admin/login', { method: 'POST', body: { password: 'test-pass' } });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('お客様向けページと店舗情報を返す', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /ご予約/);

  const info = await (await call('/api/info')).json();
  assert.equal(info.storeName, 'cafe ハッピーロード');
  assert.equal(info.today, '2026-11-06');
  assert.equal(info.lastBookableDate, '2027-01-05');
});

test('public フォルダの外のファイルは読めない', async () => {
  const res = await call('/..%2Fpackage.json');
  assert.equal(res.status, 404);
});

test('Web予約して、確認できる', async () => {
  const res = await call('/api/reservations', {
    method: 'POST',
    body: { date: '2026-11-07', time: '13:00', partySize: 3, name: '中村', phone: '080-1111-2222' },
  });
  assert.equal(res.status, 201);
  const { reservation } = await res.json();

  const lookup = await call('/api/reservations/lookup', {
    method: 'POST',
    body: { code: reservation.code, phone: '08011112222' },
  });
  assert.equal((await lookup.json()).reservation.name, '中村');
});

test('JSON 以外の送信と存在しない API ははじく', async () => {
  const res = await fetch(`${base}/api/reservations`, { method: 'POST', body: 'name=x' });
  assert.equal(res.status, 415);
  assert.equal((await call('/api/nothing')).status, 404);
  assert.equal((await call('/api/info', { method: 'DELETE' })).status, 405);
});

test('管理APIはログインが必要', async () => {
  assert.equal((await call('/api/admin/reservations')).status, 401);
  const wrong = await call('/api/admin/login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(wrong.status, 401);

  const cookie = await login();
  assert.match(cookie, /^hr_session=[0-9a-f]{64}$/);
  const session = await (await call('/api/admin/session', { cookie })).json();
  assert.equal(session.loggedIn, true);

  const list = await (await call('/api/admin/reservations?date=2026-11-07', { cookie })).json();
  assert.ok(list.reservations.some((r) => r.name === '中村'));

  await call('/api/admin/logout', { method: 'POST', body: {}, cookie });
  assert.equal((await call('/api/admin/reservations', { cookie })).status, 401);
});

test('スタッフが予約を作成・変更・削除できる', async () => {
  const cookie = await login();
  const created = await call('/api/admin/reservations', {
    method: 'POST',
    cookie,
    body: { date: '2026-11-06', time: '14:00', partySize: 2, name: '電話の小林', source: 'phone' },
  });
  assert.equal(created.status, 201);
  const { reservation } = await created.json();

  const patched = await call(`/api/admin/reservations/${reservation.id}`, {
    method: 'PATCH',
    cookie,
    body: { status: 'arrived' },
  });
  assert.equal((await patched.json()).reservation.status, 'arrived');

  const removed = await call(`/api/admin/reservations/${reservation.id}`, { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  assert.equal((await call(`/api/admin/reservations/${reservation.id}`, { cookie })).status, 404);
});

test('設定・テーブル・休業日を管理できる', async () => {
  const cookie = await login();
  const saved = await call('/api/admin/settings', { method: 'PUT', cookie, body: { closedWeekdays: [2] } });
  assert.deepEqual((await saved.json()).settings.closedWeekdays, [2]);

  const closure = await call('/api/admin/closures', {
    method: 'POST',
    cookie,
    body: { date: '2026-12-31', reason: '年末休み' },
  });
  assert.equal(closure.status, 201);

  const table = await call('/api/admin/tables', { method: 'POST', cookie, body: { name: 'カウンター', seats: 1 } });
  assert.equal(table.status, 201);

  const all = await (await call('/api/admin/settings', { cookie })).json();
  assert.ok(all.tables.some((t) => t.name === 'カウンター'));
  assert.deepEqual(all.closures, [{ date: '2026-12-31', reason: '年末休み' }]);

  await call('/api/admin/closures/2026-12-31', { method: 'DELETE', cookie });
  const after = await (await call('/api/admin/settings', { cookie })).json();
  assert.deepEqual(after.closures, []);
});
