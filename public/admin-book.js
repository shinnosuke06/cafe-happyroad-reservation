// 予約台帳：日ごとの予約（タイムライン・リスト）、予約の追加と変更、予約の検索
import {
  h,
  icon,
  formatDate,
  formatShortDate,
  addDays,
  weekdayOf,
  toMinutes,
  fromMinutes,
  toast,
  telHref,
  STATUS_LABELS,
  SOURCE_LABELS,
} from './common.js';
import { $, state, call, registerPanel, modal, closeButton, field, loadMenu } from './admin-core.js';

const OCCUPYING = new Set(['confirmed', 'arrived']);
const VIEW_KEY = 'happyroad.admin.view';
const LATEST_END = 23 * 60 + 59;

const book = {
  date: null,
  view: readView(),
  reservations: [],
  searching: false,
};

function readView() {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'list' || saved === 'timeline') return saved;
  } catch {
    /* 保存できない環境でも動かす */
  }
  return window.matchMedia('(max-width: 760px)').matches ? 'list' : 'timeline';
}

function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* 何もしない */
  }
}

// =========================================================
// 画面の骨組み
// =========================================================

function buildPanel() {
  const panel = $('panel-book');
  panel.replaceChildren(
    h(
      'div',
      { class: 'day-toolbar' },
      h('div', { class: 'day-heading' }, h('h2', { id: 'day-title' }), h('span', { class: 'badge', id: 'day-tag', hidden: true })),
      h(
        'div',
        { class: 'day-nav' },
        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '前の日', onclick: () => setDate(addDays(book.date, -1)) }, '‹'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setDate(state.today) }, '今日'),
        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': '次の日', onclick: () => setDate(addDays(book.date, 1)) }, '›'),
        h('input', { type: 'date', id: 'day-picker', 'aria-label': '日付を選ぶ', onchange: (e) => setDate(e.currentTarget.value) }),
      ),
      h(
        'div',
        { class: 'toolbar-actions' },
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': '表示' },
          ['timeline', 'list'].map((v) =>
            h(
              'button',
              {
                type: 'button',
                dataset: { view: v },
                'aria-pressed': String(book.view === v),
                onclick: () => {
                  book.view = v;
                  saveView(v);
                  applyView();
                },
              },
              v === 'timeline' ? 'タイムライン' : 'リスト',
            ),
          ),
        ),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openReservation(null) }, '＋ 予約を追加'),
      ),
    ),
    h(
      'form',
      {
        class: 'search-box',
        role: 'search',
        onsubmit: (e) => {
          e.preventDefault();
          runSearch();
        },
      },
      h(
        'div',
        { class: 'search-row' },
        h('input', { type: 'search', id: 'search-input', maxlength: 50, placeholder: '名前・電話・予約番号で探す', 'aria-label': '予約を探す（お名前・電話番号・予約番号）' }),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn' }, icon('search'), '探す'), h('button', { type: 'button', class: 'btn', id: 'search-clear', hidden: true, onclick: clearSearch }, '日ごとの表示に戻る')),
      ),
    ),
    h('div', { id: 'search-results', class: 'res-list', hidden: true }),
    h(
      'div',
      { id: 'day-view' },
      h('div', { class: 'banner', id: 'day-banner', hidden: true }),
      h('div', { class: 'banner danger', id: 'clash-banner', hidden: true }),
      h('div', { class: 'stats', id: 'day-stats' }),
      h('div', { class: 'prep card', id: 'day-prep', hidden: true }),
      h('div', { id: 'timeline-view' }, h('div', { class: 'timeline', id: 'timeline' }), h('p', { class: 'timeline-note', id: 'timeline-note' })),
      h('div', { class: 'res-list', id: 'list-view', hidden: true }),
    ),
  );
  applyView();
}

function applyView() {
  $('timeline-view').hidden = book.view !== 'timeline';
  $('list-view').hidden = book.view !== 'list';
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === book.view));
  }
}

// =========================================================
// 日ごとの表示
// =========================================================

function setDate(date) {
  if (!date) return;
  book.date = date;
  clearSearch();
  renderHeader();
  loadDay();
}

export async function loadDay() {
  const { date } = book;
  try {
    const data = await call(`/api/admin/reservations?date=${encodeURIComponent(date)}`);
    if (date !== book.date) return;
    book.reservations = data.reservations;
    renderDay();
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

function closedReasonFor(date) {
  if (state.settings.closedWeekdays.includes(weekdayOf(date))) return '定休日';
  const closure = state.closures.find((c) => c.date === date);
  if (closure) return closure.reason ? `臨時休業（${closure.reason}）` : '臨時休業';
  return null;
}

function renderHeader() {
  const { date } = book;
  const { today } = state;
  $('day-title').textContent = formatDate(date, { year: date.slice(0, 4) !== today.slice(0, 4) });
  $('day-picker').value = date;
  const relative = { [today]: '今日', [addDays(today, 1)]: '明日', [addDays(today, -1)]: '昨日' }[date];
  const tag = $('day-tag');
  tag.hidden = !relative;
  tag.textContent = relative ?? '';
  tag.className = `badge${relative === '今日' ? ' status-confirmed' : ''}`;
  const closed = closedReasonFor(date);
  $('day-banner').hidden = !closed;
  $('day-banner').textContent = closed ? `${closed}のため、この日はWeb予約を受け付けていません。` : '';
}

/** 同じテーブルで時間が重なっている予約の ID */
function findClashes(list) {
  const ids = new Set();
  const active = list.filter((r) => OCCUPYING.has(r.status));
  for (const a of active) {
    for (const b of active) {
      if (a.id < b.id && a.tableId === b.tableId && toMinutes(a.time) < toMinutes(b.endTime) && toMinutes(b.time) < toMinutes(a.endTime)) {
        ids.add(a.id);
        ids.add(b.id);
      }
    }
  }
  return ids;
}

function renderDay() {
  renderHeader();
  const clashes = findClashes(book.reservations);
  $('clash-banner').hidden = clashes.size === 0;
  $('clash-banner').textContent = clashes.size
    ? `同じテーブルで時間が重なっている予約が ${clashes.size}件 あります（赤い枠）。テーブルか時間を変えてください。`
    : '';
  renderStats();
  renderPrep();
  renderTimeline(clashes);
  renderList(clashes);
}

function renderStats() {
  const all = book.reservations;
  const active = all.filter((r) => OCCUPYING.has(r.status));
  const stat = (label, value, unit) =>
    h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value, h('small', {}, unit)));
  $('day-stats').replaceChildren(
    stat('予約', active.length, '組'),
    stat('人数', active.reduce((sum, r) => sum + r.partySize, 0), '名'),
    stat('来店済', all.filter((r) => r.status === 'arrived').length, '組'),
    stat('キャンセル', all.length - active.length, '件'),
  );
}

/** この日に予約で選ばれたメニューの合計（仕込みの目安） */
function renderPrep() {
  const totals = new Map();
  for (const r of book.reservations.filter((x) => OCCUPYING.has(x.status))) {
    for (const item of r.items) totals.set(item.name, (totals.get(item.name) ?? 0) + item.quantity);
  }
  const box = $('day-prep');
  box.hidden = totals.size === 0;
  box.replaceChildren(
    h('h3', {}, 'この日の予約メニュー（仕込みの目安）'),
    h('ul', {}, [...totals].map(([name, n]) => h('li', {}, `${name} × ${n}`))),
  );
}

function renderTimeline(clashes) {
  const s = state.settings;
  const active = book.reservations.filter((r) => OCCUPYING.has(r.status));
  const open = toMinutes(s.openTime);
  const close = toMinutes(s.closeTime);
  let start = Math.floor(open / 60) * 60;
  let end = Math.ceil(close / 60) * 60;
  for (const r of active) {
    start = Math.min(start, Math.floor(toMinutes(r.time) / 60) * 60);
    end = Math.max(end, Math.ceil(toMinutes(r.endTime) / 60) * 60);
  }
  const total = end - start;
  const percent = (m) => ((m - start) / total) * 100;
  const grid = h('div', { class: 'tl-grid' });
  grid.style.setProperty('--hours', String(total / 60));

  const hourLabels = [];
  for (let m = start; m < end; m += 60) {
    const label = h('span', {}, `${m / 60}:00`);
    label.style.left = `${percent(m)}%`;
    hourLabels.push(label);
  }
  grid.append(h('div', { class: 'tl-head' }, h('div', { class: 'tl-label' }, 'テーブル'), h('div', { class: 'tl-hours' }, hourLabels)));

  // 30分ごとに、お店にいる人数
  const step = 30;
  const counts = [];
  for (let m = start; m < end; m += step) {
    const n = active.filter((r) => toMinutes(r.time) <= m && m < toMinutes(r.endTime)).reduce((sum, r) => sum + r.partySize, 0);
    const max = s.maxGuestsPerSlot;
    const cell = h(
      'span',
      { class: max && n > max ? 'over' : max && n >= max * 0.8 ? 'busy' : '', title: `${fromMinutes(m)} ごろ ${n}名${max ? `（上限${max}名）` : ''}` },
      n ? `${n}名` : '',
    );
    cell.style.left = `calc(${percent(m)}% + 2px)`;
    cell.style.width = `calc(${(step / total) * 100}% - 4px)`;
    counts.push(cell);
  }
  grid.append(
    h(
      'div',
      { class: 'tl-count' },
      h('div', { class: 'tl-label' }, s.maxGuestsPerSlot ? `人数（上限${s.maxGuestsPerSlot}）` : 'お店の人数'),
      h('div', { class: 'tl-counts' }, counts),
    ),
  );

  const tables = state.tables.filter((t) => t.active || active.some((r) => r.tableId === t.id));
  for (const table of tables) {
    const track = h('div', { class: 'tl-track', title: `${table.name}に予約を追加` });
    track.addEventListener('click', (event) => {
      if (event.target !== track) return;
      const rect = track.getBoundingClientRect();
      const raw = start + ((event.clientX - rect.left) / rect.width) * total;
      const snapped = Math.min(Math.max(Math.floor(raw / s.slotMinutes) * s.slotMinutes, start), end - s.slotMinutes);
      openReservation(null, { tableId: table.id, time: fromMinutes(snapped) });
    });
    if (open > start) {
      const shade = h('div', { class: 'tl-closed' });
      shade.style.left = '0';
      shade.style.width = `${percent(open)}%`;
      track.append(shade);
    }
    if (close < end) {
      const shade = h('div', { class: 'tl-closed' });
      shade.style.left = `${percent(close)}%`;
      shade.style.right = '0';
      track.append(shade);
    }
    for (const r of active.filter((x) => x.tableId === table.id)) {
      const extras = [r.items.length ? 'メニューあり' : '', r.note ? 'メモあり' : ''].filter(Boolean).join('・');
      const block = h(
        'button',
        {
          type: 'button',
          class: `tl-block status-${r.status}${clashes.has(r.id) ? ' clash' : ''}`,
          title: `${r.time}〜${r.endTime}　${r.name}様　${r.partySize}名${r.note ? `\n${r.note}` : ''}`,
          onclick: () => openReservation(r),
        },
        h('strong', {}, `${r.name} 様`),
        h('span', {}, `${r.time}〜 ${r.partySize}名${extras ? ` ・${extras}` : ''}`),
      );
      const left = percent(toMinutes(r.time));
      block.style.left = `calc(${left}% + 2px)`;
      block.style.width = `calc(${percent(toMinutes(r.endTime)) - left}% - 4px)`;
      track.append(block);
    }
    grid.append(
      h(
        'div',
        { class: 'tl-row' },
        h(
          'div',
          { class: `tl-label${table.active ? '' : ' inactive'}` },
          h('strong', {}, table.name),
          h('small', {}, `${table.seats}席${table.area ? `・${table.area}` : ''}`),
        ),
        track,
      ),
    );
  }

  if (book.date === state.today) {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (minutes >= start && minutes <= end) {
      const line = h('div', { class: 'tl-now', 'aria-hidden': 'true' });
      line.style.setProperty('--pos', String((minutes - start) / total));
      grid.append(line);
    }
  }
  $('timeline').replaceChildren(grid);
  const hidden = book.reservations.length - active.length;
  $('timeline-note').textContent = [
    tables.length ? '空いている所を押すと、そのテーブルと時間で予約を追加できます。' : 'テーブルがありません。「設定」から追加してください。',
    hidden ? `キャンセル・無断キャンセル ${hidden}件はリスト表示で見られます。` : '',
  ].join(' ');
}

function reservationItem(r, { showDate = false, clash = false } = {}) {
  return h(
    'article',
    {
      class: `res-item${OCCUPYING.has(r.status) ? '' : ' is-off'}${clash ? ' clash' : ''}`,
      tabindex: '0',
      'aria-label': `${r.date} ${r.time} ${r.name}様 ${r.partySize}名 ${STATUS_LABELS[r.status]}`,
      onclick: () => openReservation(r),
      onkeydown: (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openReservation(r);
        }
      },
    },
    h(
      'div',
      { class: 'res-time' },
      showDate ? h('span', { class: 'res-date' }, formatShortDate(r.date)) : null,
      r.time,
      h('small', {}, `〜${r.endTime}`),
    ),
    h(
      'div',
      { class: 'res-main' },
      h('div', { class: 'res-name' }, `${r.name} 様`, h('span', { class: 'badge' }, SOURCE_LABELS[r.source])),
      h(
        'div',
        { class: 'res-meta' },
        h('span', {}, `${r.partySize}名`),
        h('span', {}, `${r.tableName ?? '—'}${r.seatRequest ? `（希望：${r.seatRequest}）` : ''}`),
        r.phone ? h('a', { href: telHref(r.phone), onclick: (event) => event.stopPropagation() }, r.phone) : null,
        h('span', {}, `No.${r.code}`),
      ),
      r.items.length ? h('div', { class: 'res-items' }, r.items.map((i) => h('span', {}, `${i.name}×${i.quantity}`))) : null,
      r.note ? h('div', { class: 'res-note' }, r.note) : null,
    ),
    h(
      'div',
      { class: 'res-side' },
      h('span', { class: `badge status-${r.status}` }, STATUS_LABELS[r.status]),
      r.status === 'confirmed'
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm',
              onclick: (event) => {
                event.stopPropagation();
                quickStatus(r, 'arrived');
              },
            },
            '来店',
          )
        : null,
    ),
  );
}

function renderList(clashes) {
  const items = book.reservations.map((r) => reservationItem(r, { clash: clashes.has(r.id) }));
  $('list-view').replaceChildren(...(items.length ? items : [h('p', { class: 'empty card' }, 'この日の予約はまだありません')]));
}

async function quickStatus(r, status) {
  try {
    await call(`/api/admin/reservations/${r.id}`, { method: 'PATCH', body: { status } });
    toast(`${r.name}様を「${STATUS_LABELS[status]}」にしました`);
    refresh();
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

// =========================================================
// 予約を探す
// =========================================================

async function runSearch() {
  const q = $('search-input').value.trim();
  if (!q) return clearSearch();
  book.searching = true;
  $('day-view').hidden = true;
  $('search-clear').hidden = false;
  const box = $('search-results');
  box.hidden = false;
  box.replaceChildren(h('p', { class: 'empty' }, '探しています…'));
  try {
    const { reservations } = await call(`/api/admin/reservations?q=${encodeURIComponent(q)}`);
    box.replaceChildren(
      h('p', { class: 'hint' }, `「${q}」の検索結果：${reservations.length}件`),
      ...(reservations.length ? reservations.map((r) => reservationItem(r, { showDate: true })) : [h('p', { class: 'empty card' }, '見つかりませんでした')]),
    );
  } catch (err) {
    box.replaceChildren(h('p', { class: 'empty' }, err.message));
  }
  return undefined;
}

function clearSearch() {
  book.searching = false;
  if (!$('search-results')) return;
  $('search-results').hidden = true;
  $('search-clear').hidden = true;
  $('day-view').hidden = false;
  $('search-input').value = '';
}

export function refresh() {
  if (book.searching) runSearch();
  else loadDay();
}

// =========================================================
// 予約の追加・変更ダイアログ
// =========================================================

function suggestTime() {
  const s = state.settings;
  const open = toMinutes(s.openTime);
  if (book.date !== state.today) return s.openTime;
  const now = new Date();
  const next = Math.ceil((now.getHours() * 60 + now.getMinutes()) / s.slotMinutes) * s.slotMinutes;
  return fromMinutes(Math.min(Math.max(next, open), 23 * 60));
}

function formatCreated(iso) {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export async function openReservation(reservation, defaults = {}) {
  if (state.menu.length === 0) {
    try {
      await loadMenu();
    } catch {
      /* メニューが読めなくても予約はできる */
    }
  }
  const s = state.settings;
  const v = reservation
    ? { ...reservation }
    : {
        date: book.date ?? state.today,
        time: defaults.time ?? suggestTime(),
        partySize: 2,
        tableId: defaults.tableId ?? '',
        status: 'confirmed',
        source: 'phone',
        items: [],
        seatRequest: '',
      };
  v.endTime ??= fromMinutes(Math.min(toMinutes(v.time) + s.stayMinutes, LATEST_END));

  const input = (name, attrs = {}) => h('input', { name, value: v[name] ?? '', ...attrs });
  const select = (name, options, value) =>
    h('select', { name }, options.map(([val, label]) => h('option', { value: val, selected: String(val) === String(value ?? '') }, label)));

  const timeInput = input('time', { type: 'time', step: 300, required: true });
  const endInput = input('endTime', { type: 'time', step: 300, required: true });
  let previousStart = v.time;
  timeInput.addEventListener('input', () => {
    if (previousStart && timeInput.value && endInput.value) {
      const duration = toMinutes(endInput.value) - toMinutes(previousStart);
      if (duration > 0) endInput.value = fromMinutes(Math.min(toMinutes(timeInput.value) + duration, LATEST_END));
    }
    if (timeInput.value) previousStart = timeInput.value;
  });

  // 予約メニュー（数を入れる）
  const qty = new Map(v.items.filter((i) => i.menuItemId != null).map((i) => [i.menuItemId, i.quantity]));
  const menuChoices = state.menu.filter((m) => m.active || qty.has(m.id));
  const itemInputs = menuChoices.map((m) => {
    const box = h('input', { type: 'number', min: 0, max: 50, value: qty.get(m.id) ?? 0, 'aria-label': `${m.name}の数`, dataset: { menuId: m.id } });
    const row = h('div', { class: `item-row${qty.get(m.id) ? ' chosen' : ''}` }, h('span', {}, `${m.name}（${m.price.toLocaleString('ja-JP')}円）`), box);
    box.addEventListener('input', () => row.classList.toggle('chosen', Number(box.value) > 0));
    return { box, row };
  });
  const orphanItems = v.items.filter((i) => i.menuItemId == null); // 削除されたメニュー
  const chosenCount = v.items.length;

  const error = h('p', { class: 'form-error', role: 'alert' });
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, '保存');

  const tableOptions = [
    ['', '自動で選ぶ'],
    ...state.tables
      .filter((t) => t.active || t.id === v.tableId)
      .map((t) => [t.id, `${t.name}（${t.seats}席${t.area ? `・${t.area}` : ''}）${t.active ? '' : '・休止中'}`]),
  ];

  const { form, close } = modal({
    title: reservation ? '予約の内容' : '予約を追加',
    meta: reservation
      ? ['予約番号 ', h('span', { class: 'code' }, reservation.code), ` ・ ${SOURCE_LABELS[reservation.source]}受付 ${formatCreated(reservation.createdAt)}`]
      : 'テーブルを「自動」にすると、空いている席を選びます',
    body: [
      h('div', { class: 'grid-2' }, field('日付', input('date', { type: 'date', required: true })), field('状態', select('status', Object.entries(STATUS_LABELS), v.status))),
      h('div', { class: 'grid-2' }, field('開始', timeInput), field('終了', endInput)),
      h('div', { class: 'grid-2' }, field('人数', input('partySize', { type: 'number', min: 1, max: 99, required: true })), field('テーブル', select('tableId', tableOptions, v.tableId))),
      reservation?.seatRequest ? h('p', { class: 'hint' }, `お客様の席の希望：${reservation.seatRequest}`) : null,
      h('div', { class: 'grid-2' }, field('お名前', input('name', { maxlength: 50, required: true }), h('em', { class: 'req' }, '必須')), field('電話番号', input('phone', { type: 'tel', maxlength: 20 }))),
      h('div', { class: 'grid-2' }, field('メールアドレス', input('email', { type: 'email', maxlength: 254 })), field('受付方法', select('source', Object.entries(SOURCE_LABELS), v.source))),
      menuChoices.length
        ? h(
            'details',
            { class: 'more', open: chosenCount > 0 },
            h('summary', {}, `予約メニュー${chosenCount ? `（${chosenCount}品）` : ''}`),
            h('div', { class: 'item-rows' }, itemInputs.map((x) => x.row)),
            orphanItems.length ? h('p', { class: 'hint' }, `削除済みのメニュー：${orphanItems.map((i) => `${i.name}×${i.quantity}`).join('、')}`) : null,
          )
        : null,
      field('メモ・ご要望', h('textarea', { name: 'note', maxlength: 500 }, v.note ?? '')),
      error,
    ],
    actions: [
      reservation
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-danger spacer',
              onclick: async () => {
                if (!confirm(`${reservation.name}様の予約（${formatShortDate(reservation.date)} ${reservation.time}〜）を削除しますか？\n記録を残したいときは、削除せずに状態を「キャンセル」にしてください。`)) return;
                try {
                  await call(`/api/admin/reservations/${reservation.id}`, { method: 'DELETE' });
                  close();
                  toast('予約を削除しました');
                  refresh();
                } catch (err) {
                  error.textContent = err.message;
                }
              },
            },
            '削除',
          )
        : null,
      closeButton(),
      save,
    ],
    onSubmit: async (f) => {
      const e = f.elements;
      const body = {
        date: e.date.value,
        time: e.time.value,
        endTime: e.endTime.value,
        partySize: Number(e.partySize.value),
        tableId: e.tableId.value === '' ? 'auto' : Number(e.tableId.value),
        name: e.name.value,
        phone: e.phone.value,
        email: e.email.value,
        note: e.note.value,
        status: e.status.value,
        source: e.source.value,
      };
      if (menuChoices.length) {
        body.items = [
          ...itemInputs.map((x) => ({ menuItemId: Number(x.box.dataset.menuId), quantity: Number(x.box.value) || 0 })).filter((x) => x.quantity > 0),
        ];
      }
      if (!body.name.trim()) {
        error.textContent = 'お名前を入力してください';
        return;
      }
      save.disabled = true;
      error.textContent = '';
      try {
        const saved = await sendReservation(reservation, body);
        if (!saved) return;
        close();
        toast(reservation ? '予約を保存しました' : `予約を追加しました（${saved.tableName}）`);
        if (!book.searching && saved.date !== book.date) {
          book.date = saved.date;
          renderHeader();
        }
        refresh();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    },
  });
  form.elements.date.focus();
}

/** 保存する。最大人数をこえるときは確かめてから保存する */
async function sendReservation(existing, body) {
  const send = (extra = {}) =>
    existing
      ? call(`/api/admin/reservations/${existing.id}`, { method: 'PATCH', body: { ...body, ...extra } })
      : call('/api/admin/reservations', { method: 'POST', body: { ...body, ...extra } });
  try {
    return (await send()).reservation;
  } catch (err) {
    if (err.code !== 'over_capacity') throw err;
    if (!confirm(`${err.message}\n\nそれでも登録しますか？`)) return null;
    return (await send({ allowOverCapacity: true })).reservation;
  }
}

// =========================================================
// 登録
// =========================================================

let built = false;
registerPanel('book', {
  label: '予約台帳',
  iconName: 'calendar',
  show: () => {
    if (!built) {
      buildPanel();
      built = true;
    }
    book.date ??= state.today;
    renderHeader();
    refresh();
  },
});

export function goToDate(date) {
  book.date = date;
}
