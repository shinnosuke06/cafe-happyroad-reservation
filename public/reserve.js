import { api, h, formatDate, weekdayOf, addDays, WEEKDAYS, STATUS_LABELS } from './common.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('reserve-form'),
  strip: $('date-strip'),
  date: $('date'),
  party: $('party'),
  partyHint: $('party-hint'),
  slots: $('slots'),
  slotMessage: $('slot-message'),
  summary: $('summary'),
  error: $('form-error'),
  submit: $('submit'),
  hero: $('hero'),
  done: $('done'),
  doneCode: $('done-code'),
  doneDetails: $('done-details'),
  bookAgain: $('book-again'),
  lookupForm: $('lookup-form'),
  lookupError: $('lookup-error'),
  lookupResult: $('lookup-result'),
  storeInfo: $('store-info'),
};

const state = { info: null, date: null, time: null, request: 0 };

function isClosed(date) {
  const { closedWeekdays, closedDates } = state.info;
  return closedWeekdays.includes(weekdayOf(date)) || closedDates.includes(date);
}

function partySize() {
  return Number(els.party.value);
}

// ---- 1. 日付と人数 ----

function renderDateStrip() {
  const { today, lastBookableDate } = state.info;
  const chips = [];
  for (let i = 0; i < 14; i += 1) {
    const date = addDays(today, i);
    if (date > lastBookableDate) break;
    const w = weekdayOf(date);
    const closed = isClosed(date);
    const [, m, d] = date.split('-').map(Number);
    const top = i === 0 ? '今日' : i === 1 ? '明日' : `${m}月`;
    chips.push(
      h(
        'button',
        {
          type: 'button',
          class: `date-chip${w === 6 ? ' sat' : ''}${w === 0 ? ' sun' : ''}`,
          dataset: { date },
          disabled: closed,
          'aria-pressed': String(date === state.date),
          'aria-label': `${formatDate(date)}${closed ? ' 休業日' : ''}`,
          onclick: () => selectDate(date),
        },
        h('small', {}, top),
        h('strong', {}, d),
        h('small', {}, closed ? '休' : WEEKDAYS[w]),
      ),
    );
  }
  els.strip.replaceChildren(...chips);
}

function selectDate(date) {
  state.date = date;
  els.date.value = date;
  for (const chip of els.strip.querySelectorAll('.date-chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.date === date));
  }
  loadSlots();
}

// ---- 2. 時間 ----

async function loadSlots() {
  const request = ++state.request;
  const { date } = state;
  updateSummary();
  if (!date) {
    els.slots.replaceChildren();
    els.slotMessage.textContent = '日付を選んでください。';
    return;
  }
  els.slotMessage.textContent = '空き状況を確認しています…';
  try {
    const data = await api(`/api/availability?date=${encodeURIComponent(date)}&party=${partySize()}`);
    if (request !== state.request) return; // 新しい選択が来ていたら捨てる
    renderSlots(data);
  } catch (err) {
    if (request !== state.request) return;
    els.slots.replaceChildren();
    els.slotMessage.textContent = err.message;
  }
}

function renderSlots(data) {
  if (!data.open) {
    state.time = null;
    els.slots.replaceChildren();
    els.slotMessage.textContent = `${formatDate(data.date)}：${data.reason}`;
    updateSummary();
    return;
  }
  if (!data.slots.some((s) => s.available && s.time === state.time)) state.time = null;
  const anyOpen = data.slots.some((s) => s.available);
  els.slotMessage.textContent = anyOpen
    ? `${formatDate(data.date)}・${data.partySize}名様の空き状況です（ご利用は${state.info.stayMinutes}分まで）。`
    : `${formatDate(data.date)}は空きがありません。別の日付をお選びください。`;

  els.slots.replaceChildren(
    ...data.slots.map((slot) =>
      h(
        'label',
        { class: 'slot' },
        h('input', {
          type: 'radio',
          name: 'time',
          value: slot.time,
          disabled: !slot.available,
          checked: slot.time === state.time,
          'aria-label': `${slot.time} ${slot.available ? '空きあり' : '空きなし'}`,
          onchange: () => {
            state.time = slot.time;
            els.error.textContent = '';
            updateSummary();
          },
        }),
        h('span', {}, slot.time, h('small', { 'aria-hidden': 'true' }, slot.available ? '◯' : '×')),
      ),
    ),
  );
  updateSummary();
}

function updateSummary() {
  const ready = state.date && state.time;
  els.summary.classList.toggle('pending', !ready);
  els.summary.textContent = ready
    ? `${formatDate(state.date)} ${state.time}〜　${partySize()}名様`
    : '時間を選んでください';
}

// ---- 3. 送信 ----

async function submitReservation(event) {
  event.preventDefault();
  els.error.textContent = '';
  const form = new FormData(els.form);
  const body = {
    date: state.date,
    time: state.time,
    partySize: partySize(),
    name: form.get('name'),
    phone: form.get('phone'),
    email: form.get('email'),
    note: form.get('note'),
  };
  const missing = !body.time
    ? '来店時間を選んでください'
    : !body.name.trim()
      ? 'お名前を入力してください'
      : !body.phone.trim()
        ? '電話番号を入力してください'
        : null;
  if (missing) {
    els.error.textContent = missing;
    return;
  }

  els.submit.disabled = true;
  els.submit.textContent = '送信しています…';
  try {
    const { reservation } = await api('/api/reservations', { method: 'POST', body });
    showDone(reservation);
  } catch (err) {
    els.error.textContent = err.message;
    if (err.status === 409) loadSlots(); // 満席になっていたら空き状況を更新
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = 'この内容で予約する';
  }
}

function detailRows(r) {
  return [
    ['日時', `${formatDate(r.date, { year: true })} ${r.time}〜`],
    ['人数', `${r.partySize}名様`],
    ['お名前', `${r.name} 様`],
  ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]);
}

function showDone(reservation) {
  els.form.hidden = true;
  els.hero.hidden = true;
  els.done.hidden = false;
  els.doneCode.textContent = reservation.code;
  els.doneDetails.replaceChildren(...detailRows(reservation));
  window.scrollTo({ top: 0 });
  els.done.focus();
}

function bookAgain() {
  els.form.reset();
  state.time = null;
  els.done.hidden = true;
  els.hero.hidden = false;
  els.form.hidden = false;
  selectDate(state.date);
  window.scrollTo({ top: 0 });
}

// ---- 予約の確認・キャンセル ----

function renderLookup(reservation, credentials) {
  const canCancel = reservation.status === 'confirmed';
  els.lookupResult.hidden = false;
  els.lookupResult.replaceChildren(
    h(
      'dl',
      { class: 'details' },
      h('dt', {}, '予約番号'),
      h('dd', {}, reservation.code),
      ...detailRows(reservation),
      h('dt', {}, '状態'),
      h('dd', {}, h('span', { class: `badge status-${reservation.status}` }, STATUS_LABELS[reservation.status])),
    ),
    canCancel
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger',
            onclick: async (event) => {
              const button = event.currentTarget;
              if (!confirm(`${formatDate(reservation.date)} ${reservation.time}〜 のご予約をキャンセルしますか？`)) return;
              button.disabled = true;
              try {
                const { reservation: updated } = await api('/api/reservations/cancel', {
                  method: 'POST',
                  body: credentials,
                });
                renderLookup(updated, credentials);
                loadSlots();
              } catch (err) {
                els.lookupError.textContent = err.message;
                button.disabled = false;
              }
            },
          },
          'この予約をキャンセルする',
        )
      : null,
  );
}

async function lookup(event) {
  event.preventDefault();
  els.lookupError.textContent = '';
  els.lookupResult.hidden = true;
  const form = new FormData(els.lookupForm);
  const credentials = { code: form.get('code'), phone: form.get('phone') };
  if (!credentials.code.trim() || !credentials.phone.trim()) {
    els.lookupError.textContent = '予約番号と電話番号を入力してください';
    return;
  }
  try {
    const { reservation } = await api('/api/reservations/lookup', { method: 'POST', body: credentials });
    renderLookup(reservation, credentials);
  } catch (err) {
    els.lookupError.textContent = err.message;
  }
}

// ---- お店の情報 ----

function renderStoreInfo() {
  const { storeName, storePhone, openTime, closeTime, closedWeekdays, maxPartySize } = state.info;
  const rows = [
    ['営業時間', `${openTime}〜${closeTime}`],
    ['定休日', closedWeekdays.length ? closedWeekdays.map((d) => `${WEEKDAYS[d]}曜`).join('・') : 'なし（臨時休業あり）'],
  ];
  if (storePhone) rows.push(['電話', h('a', { href: `tel:${storePhone.replace(/[^\d+]/g, '')}` }, storePhone)]);
  els.storeInfo.replaceChildren(
    h('strong', {}, storeName),
    h('dl', {}, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
  );

  els.partyHint.hidden = false;
  els.partyHint.textContent = `${maxPartySize + 1}名様以上のご予約は${storePhone ? `お電話（${storePhone}）` : 'お電話'}でお問い合わせください。`;
}

// ---- 起動 ----

async function init() {
  try {
    state.info = await api('/api/info');
  } catch (err) {
    els.slotMessage.textContent = err.message;
    return;
  }
  const { info } = state;
  document.title = `ご予約 | ${info.storeName}`;
  for (const el of document.querySelectorAll('[data-store-name]')) el.textContent = info.storeName;

  els.party.replaceChildren(
    ...Array.from({ length: info.maxPartySize }, (_, i) =>
      h('option', { value: i + 1, selected: i === 1 }, `${i + 1}名`),
    ),
  );
  els.date.min = info.today;
  els.date.max = info.lastBookableDate;
  renderStoreInfo();

  let first = info.today;
  for (let i = 0; i < 30 && isClosed(first) && first < info.lastBookableDate; i += 1) first = addDays(first, 1);
  state.date = first;
  renderDateStrip();
  selectDate(first);

  els.date.addEventListener('change', () => {
    if (els.date.value) selectDate(els.date.value);
  });
  els.party.addEventListener('change', loadSlots);
  els.form.addEventListener('submit', submitReservation);
  els.bookAgain.addEventListener('click', bookAgain);
  els.lookupForm.addEventListener('submit', lookup);
}

init();
