import {
  api,
  h,
  formatDate,
  formatShortDate,
  addDays,
  weekdayOf,
  toMinutes,
  fromMinutes,
  toast,
  WEEKDAYS,
  STATUS_LABELS,
  SOURCE_LABELS,
} from './common.js';

const $ = (id) => document.getElementById(id);
const OCCUPYING = new Set(['confirmed', 'arrived']);
const VIEW_KEY = 'happyroad.admin.view';
const LATEST_END = 23 * 60 + 59;

const state = {
  today: null,
  date: null,
  tab: 'book',
  view: readView(),
  settings: null,
  tables: [],
  closures: [],
  reservations: [],
  editing: null,
};

function readView() {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'list' || saved === 'timeline') return saved;
  } catch {
    /* 保存できない環境でも動かす */
  }
  return window.matchMedia('(max-width: 720px)').matches ? 'list' : 'timeline';
}

function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* 何もしない */
  }
}

/** 管理APIを呼ぶ。ログインが切れていたらログイン画面に戻す */
async function call(path, options) {
  try {
    return await api(path, options);
  } catch (err) {
    if (err.status === 401) showLogin();
    throw err;
  }
}

function telHref(phone) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

// =========================================================
// ログイン
// =========================================================

function showLogin() {
  stopPolling();
  if (dialog.open) dialog.close();
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('login-form').elements.password.focus();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $('login-error').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: form.elements.password.value } });
    form.reset();
    await enterApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST', body: {} });
  } finally {
    showLogin();
  }
});

async function enterApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  await loadSettings();
  state.date ??= state.today;
  applyView();
  showTab(state.tab);
  startPolling();
}

async function loadSettings() {
  const data = await call('/api/admin/settings');
  state.settings = data.settings;
  state.tables = data.tables;
  state.closures = data.closures;
  state.today = data.today;
  for (const el of document.querySelectorAll('[data-store-name]')) el.textContent = data.settings.storeName;
}

// =========================================================
// タブ
// =========================================================

function showTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab;
  if (tab === 'book') {
    renderDayHeader();
    loadDay();
  } else if (tab === 'search') {
    $('search-input').focus();
    runSearch();
  } else if (tab === 'settings') {
    renderSettings();
  }
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

function refreshCurrent() {
  if (state.tab === 'search') runSearch();
  else if (state.tab === 'book') loadDay();
}

// =========================================================
// 予約台帳
// =========================================================

function setDate(date) {
  if (!date) return;
  state.date = date;
  renderDayHeader();
  loadDay();
}

$('prev-day').addEventListener('click', () => setDate(addDays(state.date, -1)));
$('next-day').addEventListener('click', () => setDate(addDays(state.date, 1)));
$('go-today').addEventListener('click', () => setDate(state.today));
$('day-picker').addEventListener('change', (event) => setDate(event.currentTarget.value));
$('add-reservation').addEventListener('click', () => openDialog(null));

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    saveView(state.view);
    applyView();
  });
}

function applyView() {
  $('timeline-view').hidden = state.view !== 'timeline';
  $('list-view').hidden = state.view !== 'list';
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
}

async function loadDay() {
  const { date } = state;
  try {
    const data = await call(`/api/admin/reservations?date=${encodeURIComponent(date)}`);
    if (date !== state.date) return; // 別の日に切り替わっていたら捨てる
    state.reservations = data.reservations;
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

function renderDayHeader() {
  const { date, today } = state;
  $('day-title').textContent = formatDate(date, { year: date.slice(0, 4) !== today.slice(0, 4) });
  $('day-picker').value = date;

  const relative = { [today]: '今日', [addDays(today, 1)]: '明日', [addDays(today, -1)]: '昨日' }[date];
  const tag = $('day-tag');
  tag.hidden = !relative;
  tag.textContent = relative ?? '';
  tag.className = `badge${relative === '今日' ? ' status-confirmed' : ''}`;

  const closed = closedReasonFor(date);
  const banner = $('day-banner');
  banner.hidden = !closed;
  banner.textContent = closed ? `${closed}のため、この日はWeb予約を受け付けていません。` : '';
}

function renderDay() {
  renderDayHeader();
  renderStats();
  renderTimeline();
  renderList();
}

function renderStats() {
  const all = state.reservations;
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

function renderTimeline() {
  const s = state.settings;
  const active = state.reservations.filter((r) => OCCUPYING.has(r.status));
  const open = toMinutes(s.openTime);
  const close = toMinutes(s.closeTime);

  // 営業時間を1時間単位で表示。営業時間外の予約があれば広げる
  let start = Math.floor(open / 60) * 60;
  let end = Math.ceil(close / 60) * 60;
  for (const r of active) {
    start = Math.min(start, Math.floor(toMinutes(r.time) / 60) * 60);
    end = Math.max(end, Math.ceil(toMinutes(r.endTime) / 60) * 60);
  }
  const total = end - start;
  const percent = (minutes) => ((minutes - start) / total) * 100;

  const grid = h('div', { class: 'tl-grid' });
  grid.style.setProperty('--hours', String(total / 60));

  const hourLabels = [];
  for (let m = start; m < end; m += 60) {
    const label = h('span', {}, `${m / 60}:00`);
    label.style.left = `${percent(m)}%`;
    hourLabels.push(label);
  }
  grid.append(h('div', { class: 'tl-head' }, h('div', { class: 'tl-label' }, 'テーブル'), h('div', { class: 'tl-hours' }, hourLabels)));

  const tables = state.tables.filter((t) => t.active || active.some((r) => r.tableId === t.id));
  for (const table of tables) {
    const track = h('div', { class: 'tl-track', title: `${table.name}に予約を追加` });
    track.addEventListener('click', (event) => {
      if (event.target !== track) return;
      const rect = track.getBoundingClientRect();
      const step = s.slotMinutes;
      const raw = start + ((event.clientX - rect.left) / rect.width) * total;
      const snapped = Math.min(Math.max(Math.floor(raw / step) * step, start), end - step);
      openDialog(null, { tableId: table.id, time: fromMinutes(snapped) });
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
      const block = h(
        'button',
        {
          type: 'button',
          class: `tl-block status-${r.status}`,
          title: `${r.time}〜${r.endTime}　${r.name}様　${r.partySize}名${r.note ? `\n${r.note}` : ''}`,
          onclick: () => openDialog(r),
        },
        h('strong', {}, `${r.name} 様`),
        h('span', {}, `${r.time}〜 ${r.partySize}名${r.note ? ' ・メモあり' : ''}`),
      );
      const left = percent(toMinutes(r.time));
      const width = percent(toMinutes(r.endTime)) - left;
      block.style.left = `calc(${left}% + 2px)`;
      block.style.width = `calc(${width}% - 4px)`;
      track.append(block);
    }

    grid.append(
      h(
        'div',
        { class: 'tl-row' },
        h('div', { class: `tl-label${table.active ? '' : ' inactive'}` }, h('strong', {}, table.name), h('small', {}, `${table.seats}席`)),
        track,
      ),
    );
  }

  if (state.date === state.today) {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (minutes >= start && minutes <= end) {
      const line = h('div', { class: 'tl-now', 'aria-hidden': 'true' });
      line.style.setProperty('--pos', String((minutes - start) / total));
      grid.append(line);
    }
  }

  $('timeline').replaceChildren(grid);

  const hidden = state.reservations.length - active.length;
  $('timeline-note').textContent = [
    tables.length
      ? '空いている所をタップすると、そのテーブルと時間で予約を追加できます。'
      : 'テーブルがありません。「設定」から追加してください。',
    hidden ? `キャンセル・無断キャンセル ${hidden}件はリスト表示で確認できます。` : '',
  ].join(' ');
}

function reservationItem(r, { showDate = false } = {}) {
  const item = h(
    'article',
    {
      class: `res-item${OCCUPYING.has(r.status) ? '' : ' is-off'}`,
      tabindex: '0',
      'aria-label': `${r.date} ${r.time} ${r.name}様 ${r.partySize}名 ${STATUS_LABELS[r.status]}`,
      onclick: () => openDialog(r),
      onkeydown: (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDialog(r);
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
        h('span', {}, r.tableName ?? '—'),
        r.phone ? h('a', { href: telHref(r.phone), onclick: (event) => event.stopPropagation() }, r.phone) : null,
        h('span', {}, `No.${r.code}`),
      ),
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
  return item;
}

function renderList() {
  const items = state.reservations.map((r) => reservationItem(r));
  $('list-view').replaceChildren(
    ...(items.length ? items : [h('p', { class: 'empty card' }, 'この日の予約はまだありません')]),
  );
}

async function quickStatus(r, status) {
  try {
    await call(`/api/admin/reservations/${r.id}`, { method: 'PATCH', body: { status } });
    toast(`${r.name}様を「${STATUS_LABELS[status]}」にしました`);
    refreshCurrent();
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

// =========================================================
// 予約の追加・編集ダイアログ
// =========================================================

const dialog = $('res-dialog');
const resForm = $('res-form');
const FIELDS = ['date', 'time', 'endTime', 'partySize', 'name', 'phone', 'email', 'note', 'status', 'source'];
let previousStart = null;

function suggestTime() {
  const s = state.settings;
  const open = toMinutes(s.openTime);
  if (state.date !== state.today) return s.openTime;
  const now = new Date();
  const next = Math.ceil((now.getHours() * 60 + now.getMinutes()) / s.slotMinutes) * s.slotMinutes;
  return fromMinutes(Math.min(Math.max(next, open), 23 * 60));
}

function formatCreated(iso) {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function openDialog(reservation, defaults = {}) {
  state.editing = reservation;
  const s = state.settings;
  const values = reservation
    ? { ...reservation }
    : {
        date: state.tab === 'book' ? state.date : state.today,
        time: defaults.time ?? suggestTime(),
        partySize: 2,
        tableId: defaults.tableId ?? '',
        status: 'confirmed',
        source: 'phone',
      };
  values.endTime ??= fromMinutes(Math.min(toMinutes(values.time) + s.stayMinutes, LATEST_END));

  $('res-dialog-title').textContent = reservation ? '予約の詳細' : '予約を追加';
  $('res-meta').replaceChildren(
    ...(reservation
      ? [
          '予約番号 ',
          h('span', { class: 'code' }, reservation.code),
          ` ・ ${SOURCE_LABELS[reservation.source]}受付 ${formatCreated(reservation.createdAt)}`,
        ]
      : ['テーブルを「自動」にすると、空いている席を選びます']),
  );

  resForm.elements.tableId.replaceChildren(
    h('option', { value: '' }, '自動で選ぶ'),
    ...state.tables
      .filter((t) => t.active || t.id === values.tableId)
      .map((t) => h('option', { value: t.id }, `${t.name}（${t.seats}席）${t.active ? '' : '・休止中'}`)),
  );
  for (const key of FIELDS) resForm.elements[key].value = values[key] ?? '';
  resForm.elements.tableId.value = values.tableId ?? '';
  previousStart = values.time;

  $('res-delete').hidden = !reservation;
  $('res-error').textContent = '';
  dialog.showModal();
}

// 開始時刻を動かしたら、利用時間の長さを保ったまま終了時刻も動かす
resForm.elements.time.addEventListener('input', () => {
  const { time, endTime } = resForm.elements;
  if (previousStart && time.value && endTime.value) {
    const duration = toMinutes(endTime.value) - toMinutes(previousStart);
    if (duration > 0) endTime.value = fromMinutes(Math.min(toMinutes(time.value) + duration, LATEST_END));
  }
  if (time.value) previousStart = time.value;
});

for (const button of dialog.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => dialog.close());
}
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close(); // 背景をタップしたら閉じる
});

resForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = resForm.elements;
  const body = {
    date: f.date.value,
    time: f.time.value,
    endTime: f.endTime.value,
    partySize: Number(f.partySize.value),
    tableId: f.tableId.value === '' ? 'auto' : Number(f.tableId.value),
    name: f.name.value,
    phone: f.phone.value,
    email: f.email.value,
    note: f.note.value,
    status: f.status.value,
    source: f.source.value,
  };
  if (!body.name.trim()) {
    $('res-error').textContent = 'お名前を入力してください';
    return;
  }
  const save = $('res-save');
  save.disabled = true;
  try {
    const editing = state.editing;
    const { reservation } = editing
      ? await call(`/api/admin/reservations/${editing.id}`, { method: 'PATCH', body })
      : await call('/api/admin/reservations', { method: 'POST', body });
    dialog.close();
    toast(editing ? '予約を保存しました' : `予約を追加しました（${reservation.tableName}）`);
    if (state.tab === 'book' && reservation.date !== state.date) {
      state.date = reservation.date;
      renderDayHeader();
    }
    refreshCurrent();
  } catch (err) {
    $('res-error').textContent = err.message;
  } finally {
    save.disabled = false;
  }
});

$('res-delete').addEventListener('click', async () => {
  const r = state.editing;
  if (!r) return;
  const message =
    `${r.name}様の予約（${formatShortDate(r.date)} ${r.time}〜）を削除しますか？\n` +
    '記録を残したいときは、削除せずに状態を「キャンセル」にしてください。';
  if (!confirm(message)) return;
  try {
    await call(`/api/admin/reservations/${r.id}`, { method: 'DELETE' });
    dialog.close();
    toast('予約を削除しました');
    refreshCurrent();
  } catch (err) {
    $('res-error').textContent = err.message;
  }
});

// =========================================================
// 検索
// =========================================================

let searchTimer;
let searchSeq = 0;

$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});

async function runSearch() {
  const q = $('search-input').value.trim();
  const box = $('search-results');
  const seq = ++searchSeq;
  if (!q) {
    box.replaceChildren(h('p', { class: 'empty' }, 'お名前・電話番号の一部・予約番号を入力してください'));
    return;
  }
  try {
    const { reservations } = await call(`/api/admin/reservations?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    box.replaceChildren(
      ...(reservations.length
        ? reservations.map((r) => reservationItem(r, { showDate: true }))
        : [h('p', { class: 'empty' }, '見つかりませんでした')]),
    );
  } catch (err) {
    if (seq === searchSeq) box.replaceChildren(h('p', { class: 'empty' }, err.message));
  }
}

// =========================================================
// 設定
// =========================================================

const SETTING_FIELDS = [
  'storeName',
  'storePhone',
  'openTime',
  'closeTime',
  'slotMinutes',
  'stayMinutes',
  'maxPartySize',
  'bookingDaysAhead',
  'minNoticeMinutes',
];
const NUMBER_FIELDS = new Set(['slotMinutes', 'stayMinutes', 'maxPartySize', 'bookingDaysAhead', 'minNoticeMinutes']);

function renderSettings() {
  const s = state.settings;
  const form = $('settings-form');
  for (const key of SETTING_FIELDS) form.elements[key].value = s[key];
  $('settings-error').textContent = '';
  // 月曜はじまりで並べる
  $('weekday-picks').replaceChildren(
    ...[1, 2, 3, 4, 5, 6, 0].map((d) =>
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', name: 'closedWeekdays', value: d, checked: s.closedWeekdays.includes(d) }),
        `${WEEKDAYS[d]}曜`,
      ),
    ),
  );
  $('add-closure-form').elements.date.min = state.today;
  renderTables();
  renderClosures();
}

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $('settings-error').textContent = '';
  const body = {};
  for (const key of SETTING_FIELDS) {
    const { value } = form.elements[key];
    body[key] = NUMBER_FIELDS.has(key) ? Number(value) : value;
  }
  body.closedWeekdays = [...form.querySelectorAll('input[name="closedWeekdays"]:checked')].map((i) => Number(i.value));
  try {
    const { settings } = await call('/api/admin/settings', { method: 'PUT', body });
    state.settings = settings;
    for (const el of document.querySelectorAll('[data-store-name]')) el.textContent = settings.storeName;
    toast('設定を保存しました');
  } catch (err) {
    $('settings-error').textContent = err.message;
  }
});

function renderTables() {
  $('table-rows').replaceChildren(
    ...state.tables.map((t) => {
      const name = h('input', { value: t.name, maxlength: 30, 'aria-label': 'テーブル名' });
      const seats = h('input', { type: 'number', min: 1, max: 50, value: t.seats, 'aria-label': `${t.name}の席数` });
      const active = h('input', { type: 'checkbox', checked: t.active });
      const save = async (patch) => {
        try {
          const { table } = await call(`/api/admin/tables/${t.id}`, { method: 'PATCH', body: patch });
          Object.assign(t, table);
          toast(`${table.name}を保存しました`);
        } catch (err) {
          toast(err.message, { error: true });
          renderTables();
        }
      };
      name.addEventListener('change', () => save({ name: name.value }));
      seats.addEventListener('change', () => save({ seats: Number(seats.value) }));
      active.addEventListener('change', () => save({ active: active.checked }));
      const remove = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!confirm(`${t.name}を削除しますか？`)) return;
            try {
              await call(`/api/admin/tables/${t.id}`, { method: 'DELETE' });
              state.tables = state.tables.filter((x) => x.id !== t.id);
              renderTables();
              toast('テーブルを削除しました');
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        },
        '削除',
      );
      return h('div', { class: 'table-row' }, name, seats, h('label', { class: 'check' }, active, '使う'), remove);
    }),
  );
}

$('add-table-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const { table } = await call('/api/admin/tables', {
      method: 'POST',
      body: { name: form.elements.name.value, seats: Number(form.elements.seats.value) },
    });
    state.tables.push(table);
    renderTables();
    form.reset();
    toast(`${table.name}を追加しました`);
  } catch (err) {
    toast(err.message, { error: true });
  }
});

function renderClosures() {
  const items = state.closures.map((c) =>
    h(
      'div',
      { class: 'closure-item' },
      h('strong', {}, formatDate(c.date, { year: true })),
      h('span', {}, c.reason),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            try {
              await call(`/api/admin/closures/${c.date}`, { method: 'DELETE' });
              state.closures = state.closures.filter((x) => x.date !== c.date);
              renderClosures();
              toast('臨時休業日を取り消しました');
            } catch (err) {
              toast(err.message, { error: true });
            }
          },
        },
        '取消',
      ),
    ),
  );
  $('closure-list').replaceChildren(...(items.length ? items : [h('p', { class: 'hint' }, '予定している臨時休業日はありません')]));
}

$('add-closure-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const { closure } = await call('/api/admin/closures', {
      method: 'POST',
      body: { date: form.elements.date.value, reason: form.elements.reason.value },
    });
    state.closures = [...state.closures.filter((c) => c.date !== closure.date), closure].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    renderClosures();
    form.reset();
    toast(`${formatDate(closure.date)}を臨時休業日にしました`);
  } catch (err) {
    toast(err.message, { error: true });
  }
});

// =========================================================
// 自動更新（Web予約が入ったら1分以内に反映）
// =========================================================

let pollTimer;

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (state.tab === 'book' && !dialog.open && document.visibilityState === 'visible') loadDay();
  }, 60_000);
}

function stopPolling() {
  clearInterval(pollTimer);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app-view').hidden && state.tab === 'book' && !dialog.open) loadDay();
});

// =========================================================
// 起動
// =========================================================

async function start() {
  try {
    const { loggedIn } = await api('/api/admin/session');
    if (loggedIn) await enterApp();
    else showLogin();
  } catch (err) {
    showLogin();
    $('login-error').textContent = err.message;
  }
}

start();
