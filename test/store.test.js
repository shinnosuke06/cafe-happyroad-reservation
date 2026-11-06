import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createStore, AppError } from '../src/store.js';

// 2026-11-06(金) 10:00（日本時間）として動かす
const NOW = new Date('2026-11-06T01:00:00Z');
const TODAY = '2026-11-06';
const TOMORROW = '2026-11-07';

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

let store;
beforeEach(() => {
  store = createStore(openDatabase(':memory:'), { now: () => NOW });
});

describe('空き状況', () => {
  test('営業時間と利用時間から予約枠を作る', () => {
    const { open, slots } = store.availability(TOMORROW, 2);
    assert.equal(open, true);
    assert.equal(slots[0].time, '10:00');
    assert.equal(slots.at(-1).time, '16:30'); // 16:30 + 90分 = 18:00 閉店
    assert.equal(slots.length, 14);
    assert.ok(slots.every((s) => s.available));
  });

  test('当日は締切（60分前）より前の枠を選べない', () => {
    const { slots } = store.availability(TODAY, 2);
    const byTime = Object.fromEntries(slots.map((s) => [s.time, s.available]));
    assert.equal(byTime['10:00'], false);
    assert.equal(byTime['10:30'], false);
    assert.equal(byTime['11:00'], true);
  });

  test('過去の日付・受付期間外・人数オーバーは理由を返す', () => {
    assert.match(store.availability('2026-11-05', 2).reason, /過去/);
    assert.match(store.availability('2027-02-01', 2).reason, /60日先/);
    assert.match(store.availability(TOMORROW, 7).reason, /7名様以上/);
  });

  test('定休日と臨時休業日は予約できない', () => {
    store.updateSettings({ closedWeekdays: [6] }); // 土曜
    assert.match(store.availability(TOMORROW, 2).reason, /定休日/);
    store.addClosure({ date: '2026-11-09', reason: '店内改装' });
    assert.match(store.availability('2026-11-09', 2).reason, /臨時休業日です（店内改装）/);
    rejects(() => store.createPublicReservation(guest()), 400, /定休日/);
  });

  test('満席の時間は空きなしになり、時間がずれれば空く', () => {
    for (let i = 0; i < 6; i += 1) store.createPublicReservation(guest({ name: `客${i}` }));
    const byTime = Object.fromEntries(store.availability(TOMORROW, 2).slots.map((s) => [s.time, s.available]));
    assert.equal(byTime['10:30'], true); // 10:30〜12:00 は重ならない
    assert.equal(byTime['11:00'], false);
    assert.equal(byTime['12:00'], false);
    assert.equal(byTime['13:00'], false);
    assert.equal(byTime['13:30'], true);
    rejects(() => store.createPublicReservation(guest()), 409, /満席/);
  });
});

describe('Web予約', () => {
  test('人数にぴったりのテーブルから埋める', () => {
    store.createPublicReservation(guest());
    store.createPublicReservation(guest());
    store.createPublicReservation(guest());
    store.createPublicReservation(guest({ partySize: 5 }));
    const tables = store.listReservations(TOMORROW).map((r) => r.tableName);
    assert.deepEqual(tables, ['窓際1', '窓際2', 'テーブル3', 'ソファ6']);
  });

  test('予約番号は6文字で、お客様向けの項目だけ返す', () => {
    const r = store.createPublicReservation(guest({ email: 'hanako@example.com', note: '窓際希望' }));
    assert.match(r.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.deepEqual(Object.keys(r).sort(), ['code', 'date', 'name', 'partySize', 'status', 'time']);
    assert.equal(r.status, 'confirmed');
  });

  test('入力のまちがいをはじく', () => {
    rejects(() => store.createPublicReservation(guest({ name: '  ' })), 400, /お名前/);
    rejects(() => store.createPublicReservation(guest({ phone: '123' })), 400, /電話番号/);
    rejects(() => store.createPublicReservation(guest({ email: 'abc' })), 400, /メール/);
    rejects(() => store.createPublicReservation(guest({ time: '12:10' })), 400, /選べません/);
    rejects(() => store.createPublicReservation(guest({ time: '17:00' })), 400, /選べません/);
    rejects(() => store.createPublicReservation(guest({ date: '2026-13-01' })), 400, /日付/);
    rejects(() => store.createPublicReservation(guest({ partySize: 0 })), 400, /人数/);
    rejects(() => store.createPublicReservation(guest({ date: TODAY, time: '10:30' })), 400, /受付は終了/);
  });

  test('予約番号と電話番号で確認・キャンセルできる（全角入力も可）', () => {
    const { code } = store.createPublicReservation(guest());
    const found = store.lookupReservation({ code: code.toLowerCase(), phone: '０９０１２３４５６７８' });
    assert.equal(found.code, code);
    rejects(() => store.lookupReservation({ code, phone: '090-0000-0000' }), 404);

    const cancelled = store.cancelByCustomer({ code, phone: '09012345678' });
    assert.equal(cancelled.status, 'cancelled');
    rejects(() => store.cancelByCustomer({ code, phone: '09012345678' }), 409, /すでに/);
  });

  test('キャンセルすると席が空く', () => {
    const codes = [];
    for (let i = 0; i < 6; i += 1) codes.push(store.createPublicReservation(guest()).code);
    rejects(() => store.createPublicReservation(guest()), 409);
    store.cancelByCustomer({ code: codes[0], phone: '09012345678' });
    assert.ok(store.createPublicReservation(guest()));
  });
});

describe('スタッフ操作', () => {
  test('電話予約を作ると利用時間ぶんの終了時刻が入る', () => {
    const r = store.createStaffReservation({ date: TODAY, time: '10:15', partySize: 3, name: '佐藤' });
    assert.equal(r.endTime, '11:45');
    assert.equal(r.tableName, 'テーブル3');
    assert.equal(r.source, 'phone');
    assert.equal(r.phone, '');
  });

  test('テーブル指定で重なると、だれの予約と重なるか教える', () => {
    const tables = store.listTables();
    const sofa = tables.find((t) => t.name === 'ソファ6');
    store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 4, name: '鈴木', tableId: sofa.id });
    rejects(
      () => store.createStaffReservation({ date: TOMORROW, time: '13:00', partySize: 2, name: '田中', tableId: sofa.id }),
      409,
      /鈴木様/,
    );
    const window1 = tables.find((t) => t.name === '窓際1');
    rejects(
      () => store.createStaffReservation({ date: TOMORROW, time: '15:00', partySize: 3, name: '田中', tableId: window1.id }),
      400,
      /2席/,
    );
  });

  test('時間を変えると利用時間の長さを保つ。状態の変更もできる', () => {
    const r = store.createStaffReservation({ date: TOMORROW, time: '12:00', endTime: '14:00', partySize: 2, name: '高橋' });
    const moved = store.updateStaffReservation(r.id, { time: '15:00' });
    assert.equal(moved.time, '15:00');
    assert.equal(moved.endTime, '17:00');
    assert.equal(moved.tableId, r.tableId);
    assert.equal(store.updateStaffReservation(r.id, { status: 'arrived' }).status, 'arrived');
    rejects(() => store.updateStaffReservation(r.id, { status: 'unknown' }), 400);
  });

  test('キャンセル済みの予約を戻すときも重なりを確認する', () => {
    const sofa = store.listTables().find((t) => t.name === 'ソファ6');
    const a = store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'A', tableId: sofa.id });
    store.updateStaffReservation(a.id, { status: 'cancelled' });
    store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 2, name: 'B', tableId: sofa.id });
    rejects(() => store.updateStaffReservation(a.id, { status: 'confirmed' }), 409, /B様/);
  });

  test('名前・電話番号・予約番号で検索できる', () => {
    const r = store.createPublicReservation(guest({ name: '伊藤 誠', phone: '03-5555-1234' }));
    assert.equal(store.searchReservations('伊藤')[0].code, r.code);
    assert.equal(store.searchReservations('5555')[0].code, r.code);
    assert.equal(store.searchReservations(r.code)[0].name, '伊藤 誠');
    assert.deepEqual(store.searchReservations('存在しない'), []);
    assert.deepEqual(store.searchReservations('%'), []);
  });

  test('予約の記録があるテーブルは削除できない', () => {
    const t = store.createTable({ name: 'カウンター', seats: 1 });
    store.createStaffReservation({ date: TOMORROW, time: '12:00', partySize: 1, name: '渡辺', tableId: t.id });
    rejects(() => store.deleteTable(t.id), 409);
    assert.equal(store.updateTable(t.id, { active: false }).active, false);
    const unused = store.createTable({ name: '予備', seats: 2 });
    store.deleteTable(unused.id);
    assert.ok(!store.listTables().some((x) => x.id === unused.id));
  });
});

describe('設定', () => {
  test('保存した設定が予約枠に反映される', () => {
    store.updateSettings({ openTime: '11:00', closeTime: '15:00', slotMinutes: 60, stayMinutes: 120 });
    assert.deepEqual(
      store.availability(TOMORROW, 2).slots.map((s) => s.time),
      ['11:00', '12:00', '13:00'],
    );
  });

  test('おかしな設定ははじく', () => {
    rejects(() => store.updateSettings({ openTime: '18:00', closeTime: '10:00' }), 400, /閉店時刻/);
    rejects(() => store.updateSettings({ stayMinutes: 600 }), 400, /利用時間/);
    rejects(() => store.updateSettings({ slotMinutes: 25 }), 400, /間隔/);
    rejects(() => store.updateSettings({ closedWeekdays: [7] }), 400, /定休日/);
    rejects(() => store.updateSettings({ storeName: '' }), 400, /店名/);
  });
});
