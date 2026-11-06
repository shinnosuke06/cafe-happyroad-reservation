import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openNodeDatabase } from '../src/adapters/node-sqlite.js';
import { migrate } from '../src/db.js';
import { createStore, AppError } from '../src/store.js';
import { createContent } from '../src/content.js';

// 2026-11-06(金) 10:00（日本時間）として動かす
const NOW = new Date('2026-11-06T01:00:00Z');
const TODAY = '2026-11-06';
const TOMORROW = '2026-11-07'; // 土曜

const guest = (overrides = {}) => ({
  date: TOMORROW,
  time: '12:00',
  partySize: 2,
  name: '山田 花子',
  phone: '090-1234-5678',
  ...overrides,
});

async function rejects(promiseOrFn, status, pattern) {
  await assert.rejects(typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn, (err) => {
    assert.ok(err instanceof AppError, `AppError ではありません: ${err}`);
    if (status) assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

let db;
let store;
let content;
const book = async (overrides) => (await store.createPublicReservation(guest(overrides))).publicView;
const slotMap = async (...args) => Object.fromEntries((await store.availability(...args)).slots.map((s) => [s.time, s.available]));

beforeEach(async () => {
  db = openNodeDatabase(':memory:');
  await migrate(db);
  store = createStore(db, { now: () => NOW });
  content = createContent(db, { now: () => NOW, today: store.today });
});

describe('空き状況', () => {
  test('営業時間と利用時間から予約枠を作る', async () => {
    const { open, slots, status } = await store.availability(TOMORROW, 2);
    assert.equal(open, true);
    assert.equal(status, 'open');
    assert.equal(slots[0].time, '10:00');
    assert.equal(slots.at(-1).time, '16:30'); // 16:30 + 90分 = 18:00 閉店
    assert.equal(slots.length, 14);
    assert.ok(slots.every((s) => s.available));
  });

  test('当日は締切（60分前）より前の枠を選べない', async () => {
    const byTime = await slotMap(TODAY, 2);
    assert.equal(byTime['10:30'], false);
    assert.equal(byTime['11:00'], true);
  });

  test('過去・受付期間外・人数オーバーは理由を返す', async () => {
    assert.match((await store.availability('2026-11-05', 2)).reason, /過去/);
    assert.match((await store.availability('2027-02-01', 2)).reason, /60日先/);
    const big = await store.availability(TOMORROW, 7);
    assert.equal(big.status, 'phone');
    assert.match(big.reason, /7名様以上.*お電話/);
  });

  test('定休日と臨時休業日は予約できない', async () => {
    await store.updateSettings({ closedWeekdays: [6] }); // 土曜
    assert.match((await store.availability(TOMORROW, 2)).reason, /定休日/);
    const closure = await store.addClosure({ date: '2026-11-09', reason: '店内改装' });
    assert.equal(closure.reservations, 0);
    assert.match((await store.availability('2026-11-09', 2)).reason, /臨時休業（店内改装）/);
    await rejects(book(), 400, /定休日/);
  });

  test('満席の時間は空きなしになり、時間がずれれば空く', async () => {
    for (let i = 0; i < 6; i += 1) await book({ name: `客${i}` });
    const byTime = await slotMap(TOMORROW, 2);
    assert.equal(byTime['10:30'], true);
    assert.equal(byTime['11:00'], false);
    assert.equal(byTime['13:00'], false);
    assert.equal(byTime['13:30'], true);
    await rejects(book(), 409, /満席/);
  });

  test('同時に同じ枠へ予約が来ても、席の数より多くは入らない', async () => {
    const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => book({ name: `同時${i}` })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 6);
    const tables = (await store.listReservations(TOMORROW)).map((r) => r.tableId);
    assert.equal(new Set(tables).size, 6); // 同じテーブルに2組入っていない
  });

  test('席の希望（窓際・ソファなど）で空きを絞り込める', async () => {
    assert.deepEqual(
      (await store.listAreas()).map((a) => a.name),
      ['窓際', 'テーブル', 'テラス', 'ソファ'],
    );
    await book({ seatRequest: 'ソファ', partySize: 2 });
    const sofa = await slotMap(TOMORROW, 2, 'ソファ');
    assert.equal(sofa['12:00'], false);
    assert.equal(sofa['14:00'], true);
    assert.equal((await slotMap(TOMORROW, 2))['12:00'], true);
    await rejects(book({ seatRequest: 'ソファ' }), 409, /ソファ/);
    await rejects(store.availability(TOMORROW, 2, '屋上'), 400, /選べない席/);
    const [r] = await store.listReservations(TOMORROW);
    assert.equal(r.tableName, 'ソファ6');
    assert.equal(r.seatRequest, 'ソファ');
  });

  test('同じ時間の最大人数をこえる予約は受け付けない', async () => {
    await store.updateSettings({ maxGuestsPerSlot: 8 });
    await book({ partySize: 4 });
    await book({ partySize: 3, time: '12:30' });
    const two = await slotMap(TOMORROW, 2);
    assert.equal(two['12:00'], false);
    assert.equal(two['13:30'], true);
    assert.equal((await slotMap(TOMORROW, 1))['12:30'], true);
    await rejects(book({ time: '12:00' }), 409, /満席/);
  });

  test('カレンダーは日ごとに ◯（open）△（few）×（full）休（closed）を返す', async () => {
    await store.updateSettings({ closedWeekdays: [2] }); // 火曜
    await store.addClosure({ date: '2026-11-20', reason: '' });
    await store.updateSettings({ openTime: '10:00', closeTime: '13:00', stayMinutes: 60, slotMinutes: 60 }); // 1日3枠
    const { days } = await store.calendar('2026-11', 2);
    const status = Object.fromEntries(days.map((d) => [d.date, d.status]));
    assert.equal(days.length, 30);
    assert.equal(status['2026-11-05'], 'past');
    assert.equal(status['2026-11-10'], 'closed');
    assert.equal(status['2026-11-20'], 'closed');
    assert.equal(status['2026-11-07'], 'few');
    for (let i = 0; i < 6; i += 1) {
      for (const t of ['10:00', '11:00', '12:00']) await book({ date: '2026-11-12', time: t, name: `客${i}` });
    }
    assert.equal((await store.calendar('2026-11', 2)).days.find((d) => d.date === '2026-11-12').status, 'full');
    await rejects(store.calendar('2026-13', 2), 400);
  });
});

describe('Web予約', () => {
  test('人数にぴったりのテーブルから埋め、お客様の連絡先を登録する', async () => {
    await book();
    await book();
    await book();
    await book({ partySize: 5, phone: '080-0000-1111', email: 'a@example.com', notifyEmail: true });
    const list = await store.listReservations(TOMORROW);
    assert.deepEqual(list.map((r) => r.tableName), ['窓際1', '窓際2', 'テーブル3', 'ソファ6']);
    assert.equal(list[0].customerId, list[1].customerId);
    const row = await db.get('SELECT * FROM customers WHERE phone_digits = ?', ['08000001111']);
    assert.equal(row.notify_email, 1);
  });

  test('予約番号は6文字で、お客様向けの項目だけ返す', async () => {
    const r = await book({ email: 'hanako@example.com', note: '窓際希望' });
    assert.match(r.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'date', 'items', 'name', 'partySize', 'seatRequest', 'status', 'time']);
  });

  test('入力のまちがいをはじく', async () => {
    await rejects(book({ name: '  ' }), 400, /お名前/);
    await rejects(book({ phone: '123' }), 400, /電話番号/);
    await rejects(book({ email: 'abc' }), 400, /メール/);
    await rejects(book({ time: '12:10' }), 400, /選べません/);
    await rejects(book({ date: '2026-13-01' }), 400, /日付/);
    await rejects(book({ partySize: 0 }), 400, /人数/);
    await rejects(book({ date: TODAY, time: '10:30' }), 400, /受付は終了/);
  });

  test('予約時にメニューを選べる（曜日限定・予約不可のものは選べない）', async () => {
    const latte = await content.createMenuItem({ name: 'カフェラテ', price: 500, category: 'ドリンク' });
    const weekend = await content.createMenuItem({ name: '週末パンケーキ', price: 1200, weekdays: [0, 6] });
    const weekday = await content.createMenuItem({ name: '平日ランチ', price: 1100, weekdays: [1, 2, 3, 4, 5] });
    const counter = await content.createMenuItem({ name: '店頭販売のクッキー', price: 300, preorder: false });

    const r = await book({
      items: [
        { menuItemId: latte.id, quantity: 2 },
        { menuItemId: weekend.id, quantity: 1 },
        { menuItemId: latte.id, quantity: 1 },
      ],
    });
    assert.deepEqual(r.items, [
      { name: 'カフェラテ', quantity: 3 },
      { name: '週末パンケーキ', quantity: 1 },
    ]);
    await rejects(book({ items: [{ menuItemId: weekday.id, quantity: 1 }] }), 400, /この曜日にはありません/);
    await rejects(book({ items: [{ menuItemId: counter.id, quantity: 1 }] }), 400, /予約では選べません/);

    await content.updateMenuItem(latte.id, { price: 600 });
    const [saved] = await store.listReservations(TOMORROW);
    assert.equal(saved.items[0].price, 500); // 予約した時の値段が残る

    const menu = (await content.publicMenu(TOMORROW)).items;
    assert.deepEqual(menu.map((i) => i.name), ['カフェラテ', '週末パンケーキ', '店頭販売のクッキー']);
    assert.equal(menu.find((i) => i.name === '店頭販売のクッキー').preorder, false);
  });

  test('予約番号と電話番号で確認・キャンセルできる（全角入力も可）', async () => {
    const { code } = await book();
    const found = await store.lookupReservation({ code: code.toLowerCase(), phone: '０９０１２３４５６７８' });
    assert.equal(found.code, code);
    await rejects(store.lookupReservation({ code, phone: '090-0000-0000' }), 404);
    assert.equal((await store.cancelByCustomer({ code, phone: '09012345678' })).status, 'cancelled');
    await rejects(store.cancelByCustomer({ code, phone: '09012345678' }), 409, /すでに/);
  });
});

describe('スタッフ操作', () => {
  test('電話予約を作ると利用時間ぶんの終了時刻が入る', async () => {
    const r = await store.createStaffReservation({ date: TODAY, time: '10:15', partySize: 3, name: '佐藤' });
    assert.equal(r.endTime, '11:45');
    assert.equal(r.tableName, 'テーブル3');
    assert.equal(r.customerId, null);
  });

  test('テーブル指定で重なると、だれの予約と重なるか教える', async () => {
    const sofa = (await store.listTables()).find((t) => t.name === 'ソファ6');
    await store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 4, name: '鈴木', tableId: sofa.id });
    await rejects(
      store.createStaffReservation({ date: TOMORROW, time: '13:00', partySize: 2, name: '田中', tableId: sofa.id }),
      409,
      /鈴木様/,
    );
  });

  test('最大人数をこえるときは確認つきで登録できる', async () => {
    await store.updateSettings({ maxGuestsPerSlot: 5 });
    await store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 4, name: 'A' });
    await assert.rejects(
      store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'B' }),
      (err) => err.code === 'over_capacity' && /最大5名/.test(err.message),
    );
    const r = await store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'B', allowOverCapacity: true });
    assert.equal(r.name, 'B');
  });

  test('時間を変えると利用時間の長さを保つ。メニューも変えられる', async () => {
    const cake = await content.createMenuItem({ name: 'ケーキ', price: 600 });
    const r = await store.createStaffReservation({ date: TOMORROW, time: '12:00', endTime: '14:00', partySize: 2, name: '高橋' });
    const moved = await store.updateStaffReservation(r.id, { time: '15:00', items: [{ menuItemId: cake.id, quantity: 2 }] });
    assert.equal(moved.endTime, '17:00');
    assert.equal(moved.items[0].quantity, 2);
    const statusOnly = await store.updateStaffReservation(r.id, { status: 'arrived' });
    assert.equal(statusOnly.items.length, 1);
  });

  test('キャンセル済みの予約を戻すときも重なりを確認する', async () => {
    const sofa = (await store.listTables()).find((t) => t.name === 'ソファ6');
    const a = await store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'A', tableId: sofa.id });
    await store.updateStaffReservation(a.id, { status: 'cancelled' });
    await store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'B', tableId: sofa.id });
    await rejects(store.updateStaffReservation(a.id, { status: 'confirmed' }), 409, /B様/);
  });

  test('名前・電話番号・予約番号で検索できる', async () => {
    const r = await book({ name: '伊藤 誠', phone: '03-5555-1234' });
    assert.equal((await store.searchReservations('伊藤'))[0].code, r.code);
    assert.equal((await store.searchReservations('5555'))[0].code, r.code);
    assert.equal((await store.searchReservations(r.code))[0].name, '伊藤 誠');
    assert.deepEqual(await store.searchReservations('%'), []);
  });

  test('予約の記録があるテーブルは削除できない', async () => {
    const t = await store.createTable({ name: 'カウンター', seats: 1, area: 'カウンター' });
    await store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 1, name: '渡辺', tableId: t.id });
    await rejects(store.deleteTable(t.id), 409);
    assert.equal((await store.updateTable(t.id, { active: false })).active, false);
  });
});

describe('設定', () => {
  test('おかしな設定ははじく', async () => {
    await rejects(store.updateSettings({ openTime: '18:00', closeTime: '10:00' }), 400, /閉店時刻/);
    await rejects(store.updateSettings({ stayMinutes: 600 }), 400, /利用時間/);
    await rejects(store.updateSettings({ slotMinutes: 25 }), 400, /間隔/);
    await rejects(store.updateSettings({ closedWeekdays: [7] }), 400, /定休日/);
    await rejects(store.updateSettings({ lineFriendUrl: 'javascript:alert(1)' }), 400, /https/);
    assert.equal((await store.updateSettings({ lineFriendUrl: 'https://lin.ee/abc' })).lineFriendUrl, 'https://lin.ee/abc');
  });

  test('データベースの準備は何度呼んでも安全', async () => {
    await migrate(db);
    await migrate(db);
    assert.equal((await store.listTables()).length, 6);
  });
});
