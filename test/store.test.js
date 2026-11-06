import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
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

function rejects(fn, status, pattern) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof AppError, `AppError ではありません: ${err}`);
    if (status) assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

let db;
let store;
let content;
const book = (overrides) => store.createPublicReservation(guest(overrides)).publicView;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = createStore(db, { now: () => NOW });
  content = createContent(db, { now: () => NOW, today: store.today });
});

describe('空き状況', () => {
  test('営業時間と利用時間から予約枠を作る', () => {
    const { open, slots, status } = store.availability(TOMORROW, 2);
    assert.equal(open, true);
    assert.equal(status, 'open');
    assert.equal(slots[0].time, '10:00');
    assert.equal(slots.at(-1).time, '16:30'); // 16:30 + 90分 = 18:00 閉店
    assert.equal(slots.length, 14);
    assert.ok(slots.every((s) => s.available));
  });

  test('当日は締切（60分前）より前の枠を選べない', () => {
    const byTime = Object.fromEntries(store.availability(TODAY, 2).slots.map((s) => [s.time, s.available]));
    assert.equal(byTime['10:30'], false);
    assert.equal(byTime['11:00'], true);
  });

  test('過去・受付期間外・人数オーバーは理由を返す', () => {
    assert.match(store.availability('2026-11-05', 2).reason, /過去/);
    assert.match(store.availability('2027-02-01', 2).reason, /60日先/);
    const big = store.availability(TOMORROW, 7);
    assert.equal(big.status, 'phone');
    assert.match(big.reason, /7名様以上.*お電話/);
  });

  test('定休日と臨時休業日は予約できない', () => {
    store.updateSettings({ closedWeekdays: [6] }); // 土曜
    assert.match(store.availability(TOMORROW, 2).reason, /定休日/);
    const closure = store.addClosure({ date: '2026-11-09', reason: '店内改装' });
    assert.equal(closure.reservations, 0);
    assert.match(store.availability('2026-11-09', 2).reason, /臨時休業（店内改装）/);
    rejects(() => book(), 400, /定休日/);
  });

  test('満席の時間は空きなしになり、時間がずれれば空く', () => {
    for (let i = 0; i < 6; i += 1) book({ name: `客${i}` });
    const byTime = Object.fromEntries(store.availability(TOMORROW, 2).slots.map((s) => [s.time, s.available]));
    assert.equal(byTime['10:30'], true);
    assert.equal(byTime['11:00'], false);
    assert.equal(byTime['13:00'], false);
    assert.equal(byTime['13:30'], true);
    rejects(() => book(), 409, /満席/);
  });

  test('席の希望（窓際・ソファなど）で空きを絞り込める', () => {
    assert.deepEqual(
      store.listAreas().map((a) => a.name),
      ['窓際', 'テーブル', 'テラス', 'ソファ'],
    );
    book({ seatRequest: 'ソファ', partySize: 2 });
    const sofa = Object.fromEntries(store.availability(TOMORROW, 2, 'ソファ').slots.map((s) => [s.time, s.available]));
    assert.equal(sofa['12:00'], false);
    assert.equal(sofa['14:00'], true);
    assert.equal(store.availability(TOMORROW, 2).slots.find((s) => s.time === '12:00').available, true);
    rejects(() => book({ seatRequest: 'ソファ' }), 409, /ソファ/);
    rejects(() => store.availability(TOMORROW, 2, '屋上'), 400, /選べない席/);
    const r = store.listReservations(TOMORROW)[0];
    assert.equal(r.tableName, 'ソファ6');
    assert.equal(r.seatRequest, 'ソファ');
  });

  test('同じ時間の最大人数をこえる予約は受け付けない', () => {
    store.updateSettings({ maxGuestsPerSlot: 8 });
    book({ partySize: 4 });
    book({ partySize: 3, time: '12:30' });
    // 12:30〜13:30 は 7名いるので 2名は入れない、1名なら入れる
    const two = Object.fromEntries(store.availability(TOMORROW, 2).slots.map((s) => [s.time, s.available]));
    assert.equal(two['12:00'], false);
    assert.equal(two['13:30'], true); // 12:00の組が帰ったあと
    assert.equal(store.availability(TOMORROW, 1).slots.find((s) => s.time === '12:30').available, true);
    rejects(() => book({ time: '12:00' }), 409, /満席/);
  });

  test('カレンダーは日ごとに ◯（open）△（few）×（full）休（closed）を返す', () => {
    store.updateSettings({ closedWeekdays: [2] }); // 火曜
    store.addClosure({ date: '2026-11-20', reason: '' });
    store.updateSettings({ openTime: '10:00', closeTime: '13:00', stayMinutes: 60, slotMinutes: 60 }); // 1日3枠
    const { days } = store.calendar('2026-11', 2);
    const status = Object.fromEntries(days.map((d) => [d.date, d.status]));
    assert.equal(days.length, 30);
    assert.equal(status['2026-11-05'], 'past');
    assert.equal(status['2026-11-10'], 'closed'); // 火曜
    assert.equal(status['2026-11-20'], 'closed');
    assert.equal(status['2026-11-07'], 'few'); // 3枠しかない
    for (let i = 0; i < 6; i += 1) {
      for (const t of ['10:00', '11:00', '12:00']) book({ date: '2026-11-12', time: t, name: `客${i}` });
    }
    assert.equal(store.calendar('2026-11', 2).days.find((d) => d.date === '2026-11-12').status, 'full');
    rejects(() => store.calendar('2026-13', 2), 400);
  });
});

describe('Web予約', () => {
  test('人数にぴったりのテーブルから埋め、お客様の連絡先を登録する', () => {
    book();
    book();
    book();
    book({ partySize: 5, phone: '080-0000-1111', email: 'a@example.com', notifyEmail: true });
    const list = store.listReservations(TOMORROW);
    assert.deepEqual(list.map((r) => r.tableName), ['窓際1', '窓際2', 'テーブル3', 'ソファ6']);
    assert.equal(list[0].customerId, list[1].customerId); // 同じ電話番号は同じお客様
    const row = db.prepare('SELECT * FROM customers WHERE phone_digits = ?').get('08000001111');
    assert.equal(row.notify_email, 1);
  });

  test('予約番号は6文字で、お客様向けの項目だけ返す', () => {
    const r = book({ email: 'hanako@example.com', note: '窓際希望' });
    assert.match(r.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'date', 'items', 'name', 'partySize', 'seatRequest', 'status', 'time']);
  });

  test('入力のまちがいをはじく', () => {
    rejects(() => book({ name: '  ' }), 400, /お名前/);
    rejects(() => book({ phone: '123' }), 400, /電話番号/);
    rejects(() => book({ email: 'abc' }), 400, /メール/);
    rejects(() => book({ time: '12:10' }), 400, /選べません/);
    rejects(() => book({ date: '2026-13-01' }), 400, /日付/);
    rejects(() => book({ partySize: 0 }), 400, /人数/);
    rejects(() => book({ date: TODAY, time: '10:30' }), 400, /受付は終了/);
  });

  test('予約時にメニューを選べる（曜日限定・予約不可のものは選べない）', () => {
    const latte = content.createMenuItem({ name: 'カフェラテ', price: 500, category: 'ドリンク' });
    const weekend = content.createMenuItem({ name: '週末パンケーキ', price: 1200, weekdays: [0, 6] });
    const weekday = content.createMenuItem({ name: '平日ランチ', price: 1100, weekdays: [1, 2, 3, 4, 5] });
    const counter = content.createMenuItem({ name: '店頭販売のクッキー', price: 300, preorder: false });

    const r = book({
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
    rejects(() => book({ items: [{ menuItemId: weekday.id, quantity: 1 }] }), 400, /この曜日にはありません/);
    rejects(() => book({ items: [{ menuItemId: counter.id, quantity: 1 }] }), 400, /予約では選べません/);

    // メニューの値段を変えても、予約した時の値段が残る
    content.updateMenuItem(latte.id, { price: 600 });
    const saved = store.listReservations(TOMORROW)[0];
    assert.equal(saved.items[0].price, 500);

    // 土曜のメニュー一覧に平日ランチは出ない（予約で選べないものも、メニューには載る）
    const menu = content.publicMenu(TOMORROW).items;
    assert.deepEqual(menu.map((i) => i.name), ['カフェラテ', '週末パンケーキ', '店頭販売のクッキー']);
    assert.equal(menu.find((i) => i.name === '店頭販売のクッキー').preorder, false);
  });

  test('予約番号と電話番号で確認・キャンセルできる（全角入力も可）', () => {
    const { code } = book();
    const found = store.lookupReservation({ code: code.toLowerCase(), phone: '０９０１２３４５６７８' });
    assert.equal(found.code, code);
    rejects(() => store.lookupReservation({ code, phone: '090-0000-0000' }), 404);
    assert.equal(store.cancelByCustomer({ code, phone: '09012345678' }).status, 'cancelled');
    rejects(() => store.cancelByCustomer({ code, phone: '09012345678' }), 409, /すでに/);
  });
});

describe('スタッフ操作', () => {
  test('電話予約を作ると利用時間ぶんの終了時刻が入る', () => {
    const r = store.createStaffReservation({ date: TODAY, time: '10:15', partySize: 3, name: '佐藤' });
    assert.equal(r.endTime, '11:45');
    assert.equal(r.tableName, 'テーブル3');
    assert.equal(r.customerId, null); // 電話番号がなければお客様登録しない
  });

  test('テーブル指定で重なると、だれの予約と重なるか教える', () => {
    const sofa = store.listTables().find((t) => t.name === 'ソファ6');
    store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 4, name: '鈴木', tableId: sofa.id });
    rejects(
      () => store.createStaffReservation({ date: TOMORROW, time: '13:00', partySize: 2, name: '田中', tableId: sofa.id }),
      409,
      /鈴木様/,
    );
  });

  test('最大人数をこえるときは確認つきで登録できる', () => {
    store.updateSettings({ maxGuestsPerSlot: 5 });
    store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 4, name: 'A' });
    assert.throws(
      () => store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'B' }),
      (err) => err.code === 'over_capacity' && /最大5名/.test(err.message),
    );
    const r = store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'B', allowOverCapacity: true });
    assert.equal(r.name, 'B');
  });

  test('時間を変えると利用時間の長さを保つ。メニューも変えられる', () => {
    const cake = content.createMenuItem({ name: 'ケーキ', price: 600 });
    const r = store.createStaffReservation({ date: TOMORROW, time: '12:00', endTime: '14:00', partySize: 2, name: '高橋' });
    const moved = store.updateStaffReservation(r.id, { time: '15:00', items: [{ menuItemId: cake.id, quantity: 2 }] });
    assert.equal(moved.endTime, '17:00');
    assert.equal(moved.items[0].quantity, 2);
    const statusOnly = store.updateStaffReservation(r.id, { status: 'arrived' });
    assert.equal(statusOnly.items.length, 1); // メニューを送らなければそのまま
  });

  test('名前・電話番号・予約番号で検索できる', () => {
    const r = book({ name: '伊藤 誠', phone: '03-5555-1234' });
    assert.equal(store.searchReservations('伊藤')[0].code, r.code);
    assert.equal(store.searchReservations('5555')[0].code, r.code);
    assert.equal(store.searchReservations(r.code)[0].name, '伊藤 誠');
    assert.deepEqual(store.searchReservations('%'), []);
  });

  test('予約の記録があるテーブルは削除できない', () => {
    const t = store.createTable({ name: 'カウンター', seats: 1, area: 'カウンター' });
    store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 1, name: '渡辺', tableId: t.id });
    rejects(() => store.deleteTable(t.id), 409);
    assert.equal(store.updateTable(t.id, { active: false }).active, false);
  });
});

describe('設定', () => {
  test('おかしな設定ははじく', () => {
    rejects(() => store.updateSettings({ openTime: '18:00', closeTime: '10:00' }), 400, /閉店時刻/);
    rejects(() => store.updateSettings({ stayMinutes: 600 }), 400, /利用時間/);
    rejects(() => store.updateSettings({ slotMinutes: 25 }), 400, /間隔/);
    rejects(() => store.updateSettings({ closedWeekdays: [7] }), 400, /定休日/);
    rejects(() => store.updateSettings({ lineFriendUrl: 'javascript:alert(1)' }), 400, /https/);
    assert.equal(store.updateSettings({ lineFriendUrl: 'https://lin.ee/abc' }).lineFriendUrl, 'https://lin.ee/abc');
  });
});
