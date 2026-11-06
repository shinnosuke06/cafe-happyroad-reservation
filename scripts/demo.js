// お試し用：見本のメニュー・予約・お知らせを入れて起動する（本番のデータには触れません）
//   npm run demo
import { rm, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createNotifier } from '../src/notify.js';
import { saveImage } from '../src/uploads.js';
import { addDays, weekday } from '../src/time.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEMO_DIR = join(ROOT, 'data', 'demo');
const dbPath = join(DEMO_DIR, 'happyroad.db');
const password = process.env.ADMIN_PASSWORD || 'happyroad-demo';

await rm(DEMO_DIR, { recursive: true, force: true });
const app = await createApp({ dbPath, adminPassword: password, notifier: createNotifier({}) });
const { store, content } = app;
const today = store.today();

store.updateSettings({
  storePhone: '03-1234-5678',
  storeAddress: '東京都〇〇区〇〇 1-2-3（見本）',
  closedWeekdays: [2],
  maxGuestsPerSlot: 20,
});

const photo = async (name) => (name ? saveImage(app.uploadDir, await readFile(join(ROOT, 'demo', 'photos', `${name}.jpg`))) : '');
const MENU = [
  ['ブレンドコーヒー', 'ドリンク', 480, 'coffee', '深煎りの豆を、一杯ずつ丁寧にいれています。'],
  ['カフェラテ', 'ドリンク', 550, 'latte', 'ミルクたっぷりの、やさしい味わいです。'],
  ['クリームソーダ', 'ドリンク', 600, 'soda', 'なつかしいメロンソーダに、バニラアイスをのせて。'],
  ['紅茶（ポット）', 'ドリンク', 600, '', 'ダージリンをポットでどうぞ。2杯分あります。'],
  ['日替わりランチ', 'ランチ', 1100, 'lunch', 'ハンバーグ・サラダ・ごはん・スープのセットです（内容は日によって変わります）。', [1, 2, 3, 4, 5]],
  ['ナポリタン', 'ランチ', 1000, 'napolitan', 'ケチャップで炒めた、昔ながらの味です。'],
  ['ホットサンド', 'ランチ', 900, 'hotsand', 'ハムとチーズをはさんで、こんがり焼きました。'],
  ['季節のフルーツパンケーキ', 'スイーツ', 1200, 'pancake', '土日だけの人気メニュー。数に限りがあるので、ご予約がおすすめです。', [0, 6]],
  ['自家製チーズケーキ', 'スイーツ', 600, 'cheesecake', 'しっとり濃厚。お誕生日のプレートもご相談ください。'],
  ['本日のケーキ', 'スイーツ', 550, '', '店頭のショーケースからお選びください。', [], false],
];
const menu = {};
for (const [name, category, price, photoName, description, weekdays = [], preorder = true] of MENU) {
  menu[name] = content.createMenuItem({ name, category, price, description, weekdays, preorder, photo: await photo(photoName) });
}
const item = (name, quantity) => ({ menuItemId: menu[name].id, quantity });

store.addClosure({ date: addDays(today, 12), reason: '設備点検' });
content.createAnnouncement({
  title: '年末年始の営業について',
  body: '12月31日から1月3日まではお休みをいただきます。1月4日から通常どおり営業いたします。',
  startsOn: today,
  endsOn: addDays(today, 60),
});

// 今日の予約（スタッフが入れたもの・Webで入ったもの）
const staff = (time, partySize, name, phone, extra = {}) =>
  store.createStaffReservation({ date: today, time, partySize, name, phone, ...extra });
staff('10:00', 2, '山田 花子', '090-1234-5678', { source: 'web', status: 'arrived', items: [item('カフェラテ', 2)] });
staff('10:30', 4, '佐藤 健', '080-2222-3333', { note: 'ベビーカーあり', status: 'arrived' });
staff('11:00', 2, '鈴木 美咲', '070-4444-5555', { source: 'web', items: [item('日替わりランチ', 2)], seatRequest: '窓際' });
staff('12:00', 5, '高橋 一郎', '090-6666-7777', { note: 'お誕生日のお祝い。ケーキにプレートをお願いします', items: [item('自家製チーズケーキ', 1)] });
staff('12:30', 2, '田中 由美', '03-1234-0000', { source: 'web', seatRequest: '窓際' });
staff('13:00', 3, '伊藤 誠', '', { source: 'walkin' });
staff('14:00', 2, '渡辺 さくら', '080-1111-0000', { source: 'web', items: [item('クリームソーダ', 2)] });
staff('15:00', 4, '中村 大輔', '090-3333-1111');
staff('15:30', 1, '小林 葵', '070-5555-6666', { source: 'web', status: 'cancelled' });

// これから先の予約（お客様がWebで入れたもの）
let added = 0;
for (let i = 1; added < 3 && i < 10; i += 1) {
  const date = addDays(today, i);
  if (weekday(date) === 2) continue; // 定休日
  const weekend = [0, 6].includes(weekday(date));
  const web = (time, partySize, name, phone, extra = {}) =>
    store.createPublicReservation({ date, time, partySize, name, phone, ...extra });
  web('11:00', 2, '加藤 翔', '090-0000-1111', {
    email: 'kato@example.com',
    notifyEmail: true,
    items: [item(weekend ? '季節のフルーツパンケーキ' : 'ナポリタン', 2)],
  });
  web('12:00', 3, '松本 陽菜', '090-9876-5432', { seatRequest: 'テラス', note: '杖を使っています' });
  web('13:30', 2, '吉田 恵', '080-7777-2222', { email: 'yoshida@example.com', notifyEmail: true, items: [item('カフェラテ', 1), item('自家製チーズケーキ', 2)] });
  added += 1;
}
app.close();

console.log('見本のデータを作りました（data/demo）。');
console.log(`管理画面のパスワード：${password}`);
process.env.DB_PATH = dbPath;
process.env.ADMIN_PASSWORD = password;
await import('../server.js');
