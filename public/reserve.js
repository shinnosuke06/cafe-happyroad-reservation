// お客様向け予約ページ。1画面に1つの質問だけを出して、順番に進む。
import {
  api,
  h,
  icon,
  formatDate,
  formatPrice,
  weekdaysLabel,
  telHref,
  weekdayOf,
  WEEKDAYS,
  STATUS_LABELS,
} from './common.js';

const main = document.getElementById('main');
const STEP_NAMES = ['人数', '日にち', '時間', 'メニュー', 'お名前など', '確認'];

const state = {
  info: null,
  calendarMonth: null,
  menu: null, // メニュー一覧（メニュー画面用）
  done: null, // 予約が終わったときの内容
  booking: newBooking(),
};

function newBooking() {
  return {
    partySize: null,
    date: null,
    area: '',
    time: null,
    items: new Map(), // menuItemId → { item, quantity }
    name: '',
    phone: '',
    email: '',
    notifyEmail: false,
    note: '',
  };
}

// =========================================================
// 小さな部品
// =========================================================

function setView(...children) {
  main.replaceChildren(...children.flat().filter(Boolean));
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function phoneBox(message = 'お電話でもご予約・ご相談いただけます') {
  const { storePhone } = state.info;
  if (!storePhone) return null;
  return h(
    'section',
    { class: 'call-box' },
    h('p', {}, message),
    h('a', { class: 'btn btn-call btn-block', href: telHref(storePhone) }, icon('phone'), `${storePhone} に電話する`),
  );
}

function announcementList() {
  const list = state.info.announcements ?? [];
  if (list.length === 0) return null;
  return h(
    'section',
    { class: 'notices', 'aria-label': 'お知らせ' },
    list.map((a) =>
      h(
        'article',
        { class: 'notice' },
        h('h2', {}, icon('bell'), a.title),
        a.body ? h('p', {}, a.body) : null,
      ),
    ),
  );
}

function backLink(href, label = '戻る') {
  return h('a', { class: 'back-link', href }, icon('back'), label);
}

function progress(step) {
  return h(
    'div',
    { class: 'progress' },
    h('p', { class: 'progress-text' }, `ステップ ${step} / ${STEP_NAMES.length}`, h('span', {}, `　${STEP_NAMES[step - 1]}`)),
    h(
      'ol',
      { class: 'progress-bar', 'aria-hidden': 'true' },
      STEP_NAMES.map((_, i) => h('li', { class: i < step ? 'on' : '' })),
    ),
  );
}

function errorBox() {
  return h('p', { class: 'form-error', role: 'alert' });
}

function menuPhoto(item, className = 'menu-photo') {
  return item.photoUrl
    ? h('img', { class: className, src: item.photoUrl, alt: item.name, loading: 'lazy' })
    : h('div', { class: `${className} no-photo`, 'aria-hidden': 'true' }, icon('cup'));
}

function bookingItems() {
  return [...state.booking.items.values()].filter((x) => x.quantity > 0);
}

// =========================================================
// トップ
// =========================================================

function renderHome() {
  const bigLink = (href, title, sub, iconName, primary = false) =>
    h(
      'a',
      { class: `big-link${primary ? ' primary' : ''}`, href },
      icon(iconName, 'big-link-icon'),
      h('span', {}, h('strong', {}, title), h('small', {}, sub)),
      icon('next', 'big-link-arrow'),
    );
  setView(
    announcementList(),
    h('section', { class: 'hero' }, h('h1', {}, 'ようこそ'), h('p', {}, 'ご用件を選んでください。')),
    h(
      'nav',
      { class: 'home-menu', 'aria-label': 'ご用件' },
      bigLink('#/reserve/1', '予約する', '空いている日と時間を見て予約できます', 'calendar', true),
      bigLink('#/menu', 'メニューを見る', '写真つき。曜日ごとのメニューもわかります', 'menu'),
      bigLink('#/lookup', '予約の確認・キャンセル', '予約番号と電話番号で確かめられます', 'search'),
      bigLink('#/info', 'お店の情報・お休みの日', '営業時間や臨時のお休みがわかります', 'info'),
    ),
    phoneBox(),
  );
}

// =========================================================
// 予約（6つのステップ）
// =========================================================

async function renderReserve(step) {
  const b = state.booking;
  const reachable = !b.partySize ? 1 : !b.date ? 2 : !b.time ? 3 : 6;
  if (step > reachable) {
    location.replace(`#/reserve/${reachable}`);
    return;
  }
  const back = backLink(step === 1 ? '#/' : `#/reserve/${step - 1}`, step === 1 ? 'トップに戻る' : '前に戻る');
  const steps = { 1: stepParty, 2: stepDate, 3: stepTime, 4: stepMenu, 5: stepContact, 6: stepConfirm };
  setView(back, progress(step), h('p', { class: 'loading' }, '読み込んでいます…'));
  const body = await steps[step]();
  if (location.hash !== `#/reserve/${step}`) return; // 待っている間に別の画面へ移った
  setView(back, progress(step), body);
}

// ---- 1. 人数 ----
function stepParty() {
  const b = state.booking;
  const { maxPartySize } = state.info;
  return [
    h('h1', { class: 'question' }, '何名様ですか？'),
    h(
      'div',
      { class: 'choice-grid' },
      Array.from({ length: maxPartySize }, (_, i) => i + 1).map((n) =>
        h(
          'button',
          {
            type: 'button',
            class: 'choice',
            'aria-pressed': String(b.partySize === n),
            onclick: () => {
              if (b.partySize !== n) b.time = null;
              b.partySize = n;
              go('#/reserve/2');
            },
          },
          h('strong', {}, n),
          '名',
        ),
      ),
    ),
    h('p', { class: 'note' }, `${maxPartySize + 1}名様以上のときは、お電話でご相談ください。`),
    phoneBox('大人数のご予約・ご相談はこちら'),
  ];
}

// ---- 2. 日にち（カレンダー） ----
const MARKS = {
  open: { mark: '◯', label: '空きあり' },
  few: { mark: '△', label: '残りわずか' },
  full: { mark: '×', label: '満席' },
  closed: { mark: '休', label: 'お休み' },
  phone: { mark: '☎', label: 'お電話で' },
  past: { mark: '', label: '' },
  outside: { mark: '', label: '受付前' },
};

async function stepDate() {
  const b = state.booking;
  const month = state.calendarMonth ?? (b.date ?? state.info.today).slice(0, 7);
  const box = h('div', { class: 'calendar-box' });
  await drawCalendar(box, month);
  return [
    h('h1', { class: 'question' }, 'いつ来られますか？'),
    h('p', { class: 'lead' }, `${b.partySize}名様で予約できる日に「◯」や「△」が付いています。日にちを押してください。`),
    box,
    h(
      'ul',
      { class: 'legend' },
      ['open', 'few', 'full', 'closed'].map((s) => h('li', {}, h('span', { class: `mark ${s}` }, MARKS[s].mark), MARKS[s].label)),
    ),
    phoneBox('ご希望の日が埋まっているときは、お電話でご相談ください'),
  ];
}

function monthShift(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

async function drawCalendar(box, month) {
  const b = state.booking;
  const { today, lastBookableDate } = state.info;
  state.calendarMonth = month;
  let data;
  try {
    data = await api(`/api/calendar?month=${month}&party=${b.partySize}`);
  } catch (err) {
    box.replaceChildren(h('p', { class: 'form-error' }, err.message));
    return;
  }
  const [y, m] = month.split('-').map(Number);
  const prev = monthShift(month, -1);
  const next = monthShift(month, 1);
  const canPrev = prev >= today.slice(0, 7);
  const canNext = next <= lastBookableDate.slice(0, 7);
  const lead = weekdayOf(`${month}-01`);

  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(h('span', { class: 'cal-cell blank', 'aria-hidden': 'true' }));
  for (const day of data.days) {
    const info = MARKS[day.status];
    const selectable = day.status === 'open' || day.status === 'few';
    const d = Number(day.date.slice(8));
    const w = weekdayOf(day.date);
    cells.push(
      h(
        'button',
        {
          type: 'button',
          class: `cal-cell ${day.status}${w === 0 ? ' sun' : ''}${w === 6 ? ' sat' : ''}${day.date === today ? ' today' : ''}`,
          disabled: !selectable,
          'aria-pressed': String(day.date === b.date),
          'aria-label': `${formatDate(day.date)} ${day.reason ?? info.label}`,
          title: day.reason ?? info.label,
          onclick: () => {
            if (b.date !== day.date) b.time = null;
            b.date = day.date;
            go('#/reserve/3');
          },
        },
        h('span', { class: 'cal-day' }, d),
        h('span', { class: 'cal-mark', 'aria-hidden': 'true' }, info.mark),
      ),
    );
  }

  box.replaceChildren(
    h(
      'div',
      { class: 'cal-head' },
      h(
        'button',
        { type: 'button', class: 'btn cal-nav', disabled: !canPrev, onclick: () => drawCalendar(box, prev) },
        icon('back'),
        '前の月',
      ),
      h('h2', {}, `${y}年${m}月`),
      h(
        'button',
        { type: 'button', class: 'btn cal-nav', disabled: !canNext, onclick: () => drawCalendar(box, next) },
        '次の月',
        icon('next'),
      ),
    ),
    h(
      'div',
      { class: 'cal-grid', role: 'group', 'aria-label': `${y}年${m}月` },
      WEEKDAYS.map((w, i) => h('span', { class: `cal-week${i === 0 ? ' sun' : ''}${i === 6 ? ' sat' : ''}`, 'aria-hidden': 'true' }, w)),
      cells,
    ),
  );
}

// ---- 3. 時間と席の希望 ----
async function stepTime() {
  const b = state.booking;
  const { areas } = state.info;
  const slotsBox = h('div', { class: 'slots-box' });

  const seatChooser =
    areas.length > 1
      ? h(
          'fieldset',
          { class: 'seat-choice' },
          h('legend', {}, '席のご希望（どちらでもよければ「おまかせ」）'),
          h(
            'div',
            { class: 'chips' },
            [{ name: '', maxSeats: 99 }, ...areas].map((a) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'chip',
                  disabled: a.maxSeats < b.partySize,
                  'aria-pressed': String(b.area === a.name),
                  onclick: async (event) => {
                    b.area = a.name;
                    b.time = null;
                    for (const chip of event.currentTarget.parentElement.children) {
                      chip.setAttribute('aria-pressed', String(chip === event.currentTarget));
                    }
                    await drawSlots(slotsBox);
                  },
                },
                a.name || 'おまかせ',
              ),
            ),
          ),
        )
      : null;

  await drawSlots(slotsBox);
  return [
    h('h1', { class: 'question' }, '何時に来られますか？'),
    h('p', { class: 'lead' }, `${formatDate(b.date)}・${b.partySize}名様。ご利用は${state.info.stayMinutes}分までです。`),
    seatChooser,
    slotsBox,
  ];
}

async function drawSlots(box) {
  const b = state.booking;
  box.replaceChildren(h('p', { class: 'loading' }, '空き状況を確認しています…'));
  let data;
  try {
    data = await api(
      `/api/availability?date=${b.date}&party=${b.partySize}&area=${encodeURIComponent(b.area)}`,
    );
  } catch (err) {
    box.replaceChildren(h('p', { class: 'form-error' }, err.message));
    return;
  }
  const open = data.slots.filter((s) => s.available);
  const retry = h('div', { class: 'stack-buttons' }, h('a', { class: 'btn btn-block', href: '#/reserve/2' }, icon('calendar'), '日にちを選び直す'));
  if (!data.open || open.length === 0) {
    box.replaceChildren(
      h(
        'div',
        { class: 'empty-box' },
        h('p', {}, data.reason ?? (b.area ? `この日は「${b.area}」の席に空きがありません。` : 'この日は空きがありません。')),
        b.area
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-block',
                onclick: () => {
                  b.area = '';
                  route();
                },
              },
              '席を「おまかせ」にして探す',
            )
          : null,
        retry,
        phoneBox('お電話でご相談いただけることもあります'),
      ),
    );
    return;
  }
  box.replaceChildren(
    h(
      'div',
      { class: 'slot-grid', role: 'group', 'aria-label': '来店時間' },
      data.slots.map((s) =>
        h(
          'button',
          {
            type: 'button',
            class: 'slot',
            disabled: !s.available,
            'aria-pressed': String(s.time === b.time),
            'aria-label': `${s.time} ${s.available ? '空きあり' : '空きなし'}`,
            onclick: () => {
              b.time = s.time;
              go('#/reserve/4');
            },
          },
          h('strong', {}, s.time),
          h('small', { 'aria-hidden': 'true' }, s.available ? '◯ 空きあり' : '× 満席'),
        ),
      ),
    ),
    h('p', { class: 'note' }, '「×」の時間は満席です。'),
  );
}

// ---- 4. メニュー（任意） ----
async function stepMenu() {
  const b = state.booking;
  let items = [];
  try {
    items = (await api(`/api/menu?date=${b.date}`)).items.filter((i) => i.preorder);
  } catch (err) {
    return [h('p', { class: 'form-error' }, err.message)];
  }
  // 日にちを変えて選べなくなったメニューは外す
  for (const id of [...b.items.keys()]) if (!items.some((i) => i.id === id)) b.items.delete(id);

  const next = h('a', { class: 'btn btn-primary btn-block', href: '#/reserve/5' }, '次へ進む', icon('next'));
  if (items.length === 0) {
    return [
      h('h1', { class: 'question' }, 'メニュー'),
      h('p', { class: 'lead' }, 'この日は、先に選んでおけるメニューはありません。ご来店後にお選びください。'),
      next,
    ];
  }

  const total = h('p', { class: 'menu-total', 'aria-live': 'polite' });
  const updateTotal = () => {
    const chosen = bookingItems();
    const sum = chosen.reduce((n, x) => n + x.item.price * x.quantity, 0);
    total.textContent = chosen.length ? `選んだメニュー：${chosen.length}品　合計 ${formatPrice(sum)}` : 'まだ選んでいません';
  };

  const cards = items.map((item) => {
    const qty = h('output', { class: 'qty', 'aria-live': 'polite' }, b.items.get(item.id)?.quantity ?? 0);
    const change = (delta) => {
      const current = b.items.get(item.id)?.quantity ?? 0;
      const quantity = Math.max(0, Math.min(20, current + delta));
      if (quantity === 0) b.items.delete(item.id);
      else b.items.set(item.id, { item, quantity });
      qty.textContent = quantity;
      card.classList.toggle('chosen', quantity > 0);
      updateTotal();
    };
    const card = h(
      'article',
      { class: `menu-card pick${b.items.has(item.id) ? ' chosen' : ''}` },
      menuPhoto(item),
      h(
        'div',
        { class: 'menu-body' },
        h('h3', {}, item.name),
        h('p', { class: 'price' }, formatPrice(item.price)),
        item.description ? h('p', { class: 'desc' }, item.description) : null,
        h(
          'div',
          { class: 'stepper' },
          h('button', { type: 'button', class: 'btn step-btn', 'aria-label': `${item.name}を1つ減らす`, onclick: () => change(-1) }, '－'),
          qty,
          h('button', { type: 'button', class: 'btn step-btn', 'aria-label': `${item.name}を1つ増やす`, onclick: () => change(1) }, '＋'),
        ),
      ),
    );
    return card;
  });
  updateTotal();

  return [
    h('h1', { class: 'question' }, '先にメニューを選びますか？'),
    h('p', { class: 'lead' }, '選んでおくと、ご来店後すぐにお出しできます。選ばなくても予約できます。'),
    h('div', { class: 'menu-list' }, cards),
    total,
    h(
      'div',
      { class: 'stack-buttons' },
      next,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-block',
          onclick: () => {
            b.items.clear();
            go('#/reserve/5');
          },
        },
        'メニューは選ばずに進む',
      ),
    ),
  ];
}

// ---- 5. お名前・電話番号 ----
function stepContact() {
  const b = state.booking;
  const error = errorBox();
  const field = (label, input, mark) =>
    h('label', { class: 'field' }, h('span', {}, label, mark), input);
  const required = h('em', { class: 'req' }, '必須');
  const optional = () => h('em', { class: 'opt' }, 'なくても可');

  const form = h(
    'form',
    {
      class: 'card form-card',
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        const f = event.currentTarget.elements;
        const name = f.name.value.trim();
        const phone = f.phone.value.normalize('NFKC').replace(/[‐‑‒–—―ー−]/g, '-').trim();
        const email = f.email.value.normalize('NFKC').trim();
        if (!name) return showError(error, 'お名前を入力してください', f.name);
        if (phone.normalize('NFKC').replace(/\D/g, '').length < 10) {
          return showError(error, '電話番号を入力してください（例：090-1234-5678）', f.phone);
        }
        if (f.notifyEmail.checked && !email) {
          return showError(error, 'お知らせをメールで受け取るには、メールアドレスを入力してください', f.email);
        }
        Object.assign(b, {
          name,
          phone,
          email,
          notifyEmail: f.notifyEmail.checked,
          note: f.note.value.trim(),
          website: f.website.value,
        });
        go('#/reserve/6');
        return undefined;
      },
    },
    field('お名前', h('input', { name: 'name', autocomplete: 'name', maxlength: 50, value: b.name, placeholder: '例：山田 花子' }), required),
    field(
      '電話番号',
      h('input', { name: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', maxlength: 20, value: b.phone, placeholder: '例：090-1234-5678' }),
      required.cloneNode(true),
    ),
    field(
      'メールアドレス',
      h('input', { name: 'email', type: 'email', autocomplete: 'email', maxlength: 254, value: b.email, placeholder: '例：hanako@example.com' }),
      optional(),
    ),
    h(
      'label',
      { class: 'check big-check' },
      h('input', { type: 'checkbox', name: 'notifyEmail', checked: b.notifyEmail }),
      h('span', {}, 'お休みやお知らせを、メールで受け取る'),
    ),
    field('ご要望', h('textarea', { name: 'note', maxlength: 500, placeholder: '例：足が不自由なので入口に近い席だと助かります' }, b.note), optional()),
    // 機械による送信を見分けるための、人には見えない入力欄
    h(
      'div',
      { class: 'hp', 'aria-hidden': 'true' },
      h('label', {}, 'ウェブサイト', h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' })),
    ),
    error,
    h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, '確認へ進む', icon('next')),
  );
  return [h('h1', { class: 'question' }, 'お名前と電話番号を教えてください'), form];
}

function showError(box, message, focus) {
  box.textContent = message;
  focus?.focus();
}

// ---- 6. 確認 ----
function stepConfirm() {
  const b = state.booking;
  const items = bookingItems();
  const error = errorBox();
  const row = (label, value, editStep) =>
    h(
      'div',
      { class: 'confirm-row' },
      h('dt', {}, label),
      h('dd', {}, value, editStep ? h('a', { class: 'edit-link', href: `#/reserve/${editStep}` }, '変更') : null),
    );
  const submit = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary btn-block btn-xl',
      onclick: async () => {
        error.textContent = '';
        submit.disabled = true;
        submit.textContent = '送信しています…';
        try {
          const { reservation } = await api('/api/reservations', {
            method: 'POST',
            body: {
              date: b.date,
              time: b.time,
              partySize: b.partySize,
              seatRequest: b.area,
              items: items.map((x) => ({ menuItemId: x.item.id, quantity: x.quantity })),
              name: b.name,
              phone: b.phone,
              email: b.email,
              notifyEmail: b.notifyEmail,
              note: b.note,
              website: b.website ?? '',
            },
          });
          state.done = { reservation, email: b.email };
          state.booking = newBooking();
          state.calendarMonth = null;
          location.replace('#/done');
        } catch (err) {
          error.replaceChildren(
            err.message,
            err.status === 409 ? h('a', { class: 'btn btn-block', href: '#/reserve/3' }, '時間を選び直す') : '',
          );
          submit.disabled = false;
          submit.textContent = 'この内容で予約する';
        }
      },
    },
    'この内容で予約する',
  );

  return [
    h('h1', { class: 'question' }, 'この内容でよろしいですか？'),
    h(
      'dl',
      { class: 'confirm card' },
      row('日にち', formatDate(b.date, { year: true }), 2),
      row('時間', `${b.time}〜（${state.info.stayMinutes}分まで）`, 3),
      row('人数', `${b.partySize}名様`, 1),
      row('席の希望', b.area || 'おまかせ', 3),
      row(
        'メニュー',
        items.length
          ? h('ul', { class: 'plain' }, items.map((x) => h('li', {}, `${x.item.name} × ${x.quantity}`)))
          : 'ご来店後に選ぶ',
        4,
      ),
      row('お名前', `${b.name} 様`, 5),
      row('電話番号', b.phone, 5),
      b.email ? row('メール', `${b.email}${b.notifyEmail ? '（お知らせを受け取る）' : ''}`, 5) : null,
      b.note ? row('ご要望', b.note, 5) : null,
    ),
    error,
    submit,
  ];
}

// ---- 予約完了 ----
function renderDone() {
  if (!state.done) {
    location.replace('#/');
    return;
  }
  const { reservation: r, email } = state.done;
  const { lineFriendUrl, emailEnabled } = state.info;
  setView(
    h(
      'section',
      { class: 'card done' },
      h('div', { class: 'done-icon' }, icon('check')),
      h('h1', {}, 'ご予約を承りました'),
      h('p', { class: 'lead' }, 'ご来店をお待ちしております。'),
      h('div', { class: 'code-box' }, h('div', { class: 'label' }, '予約番号'), h('div', { class: 'code' }, r.code)),
      h(
        'dl',
        { class: 'details' },
        [
          ['日にち', formatDate(r.date, { year: true })],
          ['時間', `${r.time}〜`],
          ['人数', `${r.partySize}名様`],
          ['お名前', `${r.name} 様`],
        ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
      ),
      h('p', { class: 'note' }, '予約番号は、確認やキャンセルのときに使います。画面を写真に撮るなどして控えてください。'),
      email && emailEnabled ? h('p', { class: 'note' }, `${email} に確認のメールをお送りしました。`) : null,
    ),
    lineFriendUrl
      ? h(
          'section',
          { class: 'card line-box' },
          h('h2', {}, icon('line'), 'LINEでお知らせを受け取れます'),
          h('p', {}, '友だち追加をして、上の予約番号をトークに送ってください。お休みなどのお知らせが届きます。'),
          h('a', { class: 'btn btn-line btn-block', href: lineFriendUrl, target: '_blank', rel: 'noopener' }, 'LINEで友だち追加'),
        )
      : null,
    h('a', { class: 'btn btn-block', href: '#/' }, 'トップに戻る'),
  );
}

// =========================================================
// メニュー
// =========================================================

async function renderMenu() {
  setView(backLink('#/', 'トップに戻る'), h('h1', { class: 'page-title' }, 'メニュー'), h('p', { class: 'loading' }, '読み込んでいます…'));
  if (!state.menu) {
    try {
      state.menu = (await api('/api/menu')).items;
    } catch (err) {
      setView(backLink('#/', 'トップに戻る'), h('p', { class: 'form-error' }, err.message));
      return;
    }
  }
  const todayW = weekdayOf(state.info.today);
  const list = h('div');
  const tabs = h(
    'div',
    { class: 'chips day-tabs', role: 'group', 'aria-label': '曜日' },
    [1, 2, 3, 4, 5, 6, 0].map((w) =>
      h(
        'button',
        {
          type: 'button',
          class: `chip${w === 0 ? ' sun' : ''}${w === 6 ? ' sat' : ''}`,
          'aria-pressed': String(w === todayW),
          onclick: (event) => {
            for (const c of tabs.children) c.setAttribute('aria-pressed', String(c === event.currentTarget));
            draw(w);
          },
        },
        `${WEEKDAYS[w]}${w === todayW ? '（今日）' : ''}`,
      ),
    ),
  );

  function draw(w) {
    const closed = state.info.closedWeekdays.includes(w);
    const items = state.menu.filter((i) => i.weekdays.length === 0 || i.weekdays.includes(w));
    const groups = new Map();
    for (const item of items) {
      const key = item.category || 'メニュー';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const parts = [
      closed ? h('p', { class: 'notice-inline' }, `${WEEKDAYS[w]}曜日は定休日です。`) : null,
      items.length === 0 ? h('p', { class: 'empty-box' }, 'この曜日のメニューは準備中です。') : null,
      ...[...groups].map(([category, entries]) =>
        h(
          'section',
          { class: 'menu-group' },
          h('h2', {}, category),
          h(
            'div',
            { class: 'menu-list' },
            entries.map((item) => {
              const limited = weekdaysLabel(item.weekdays);
              return h(
                'article',
                { class: 'menu-card' },
                menuPhoto(item),
                h(
                  'div',
                  { class: 'menu-body' },
                  h('h3', {}, item.name),
                  h('p', { class: 'price' }, formatPrice(item.price)),
                  item.description ? h('p', { class: 'desc' }, item.description) : null,
                  h(
                    'p',
                    { class: 'tags' },
                    limited ? h('span', { class: 'tag limited' }, limited) : null,
                    item.preorder ? h('span', { class: 'tag' }, '予約のときに注文できます') : null,
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    ];
    list.replaceChildren(...parts.filter(Boolean));
  }
  draw(todayW);
  setView(
    backLink('#/', 'トップに戻る'),
    h('h1', { class: 'page-title' }, 'メニュー'),
    h('p', { class: 'lead' }, '曜日を押すと、その日のメニューが出ます。'),
    tabs,
    list,
    h('a', { class: 'btn btn-primary btn-block', href: '#/reserve/1' }, icon('calendar'), '予約する'),
  );
}

// =========================================================
// 予約の確認・キャンセル
// =========================================================

function renderLookup() {
  const error = errorBox();
  const result = h('div');
  const form = h(
    'form',
    {
      class: 'card form-card',
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        result.replaceChildren();
        const f = event.currentTarget.elements;
        const credentials = { code: f.code.value, phone: f.phone.value };
        if (!credentials.code.trim() || !credentials.phone.trim()) {
          return showError(error, '予約番号と電話番号を入力してください', f.code);
        }
        try {
          const { reservation } = await api('/api/reservations/lookup', { method: 'POST', body: credentials });
          showReservation(result, reservation, credentials);
        } catch (err) {
          error.textContent = err.message;
        }
        return undefined;
      },
    },
    h(
      'label',
      { class: 'field' },
      h('span', {}, '予約番号（6文字）'),
      h('input', { name: 'code', maxlength: 10, autocomplete: 'off', autocapitalize: 'characters', placeholder: '例：AB3CD4', class: 'code-input' }),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', {}, '予約のときの電話番号'),
      h('input', { name: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', maxlength: 20 }),
    ),
    error,
    h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, icon('search'), '予約を確かめる'),
  );
  setView(
    backLink('#/', 'トップに戻る'),
    h('h1', { class: 'page-title' }, '予約の確認・キャンセル'),
    form,
    result,
    phoneBox('予約番号がわからないときは、お電話ください'),
  );
}

function showReservation(box, r, credentials) {
  const error = errorBox();
  const cancel =
    r.status === 'confirmed'
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger btn-block',
            onclick: async (event) => {
              const button = event.currentTarget;
              if (!confirm(`${formatDate(r.date)} ${r.time}〜 のご予約をキャンセルします。よろしいですか？`)) return;
              button.disabled = true;
              try {
                const { reservation } = await api('/api/reservations/cancel', { method: 'POST', body: credentials });
                showReservation(box, reservation, credentials);
              } catch (err) {
                error.textContent = err.message;
                button.disabled = false;
              }
            },
          },
          'この予約をキャンセルする',
        )
      : null;
  box.replaceChildren(
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'ご予約の内容'),
      h(
        'dl',
        { class: 'details wide' },
        [
          ['予約番号', r.code],
          ['日にち', formatDate(r.date, { year: true })],
          ['時間', `${r.time}〜`],
          ['人数', `${r.partySize}名様`],
          ['お名前', `${r.name} 様`],
          ['席の希望', r.seatRequest || 'おまかせ'],
          ['メニュー', r.items.length ? r.items.map((i) => `${i.name}×${i.quantity}`).join('、') : 'ご来店後に選ぶ'],
          ['状態', h('span', { class: `badge status-${r.status}` }, r.status === 'cancelled' ? 'キャンセル済み' : STATUS_LABELS[r.status])],
        ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
      ),
      error,
      cancel,
    ),
  );
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// =========================================================
// お店の情報
// =========================================================

function renderInfo() {
  const i = state.info;
  const rows = [
    ['営業時間', `${i.openTime}〜${i.closeTime}`],
    ['定休日', i.closedWeekdays.length ? i.closedWeekdays.map((d) => `${WEEKDAYS[d]}曜日`).join('・') : 'ありません'],
  ];
  if (i.storeAddress) rows.push(['住所', i.storeAddress]);
  if (i.storePhone) rows.push(['電話', h('a', { href: telHref(i.storePhone) }, i.storePhone)]);
  setView(
    backLink('#/', 'トップに戻る'),
    h('h1', { class: 'page-title' }, 'お店の情報'),
    announcementList(),
    h('section', { class: 'card' }, h('dl', { class: 'details wide' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, '臨時のお休み'),
      i.closures.length
        ? h(
            'ul',
            { class: 'closure-list-public' },
            i.closures.map((c) => h('li', {}, h('strong', {}, formatDate(c.date)), c.reason ? `　${c.reason}` : '')),
          )
        : h('p', {}, '予定している臨時のお休みはありません。'),
    ),
    i.lineFriendUrl
      ? h(
          'section',
          { class: 'card line-box' },
          h('h2', {}, icon('line'), 'LINEでお知らせ'),
          h('p', {}, '友だち追加をして予約番号を送ると、お休みなどのお知らせが届きます。'),
          h('a', { class: 'btn btn-line btn-block', href: i.lineFriendUrl, target: '_blank', rel: 'noopener' }, 'LINEで友だち追加'),
        )
      : null,
    phoneBox(),
  );
}

// =========================================================
// 画面の切り替え
// =========================================================

function route() {
  const [, page = '', sub = ''] = /^#\/([a-z]*)\/?(\d*)/.exec(location.hash) ?? [];
  window.scrollTo(0, 0);
  if (page === 'reserve') renderReserve(Number(sub) || 1);
  else if (page === 'menu') renderMenu();
  else if (page === 'lookup') renderLookup();
  else if (page === 'info') renderInfo();
  else if (page === 'done') renderDone();
  else renderHome();
  main.focus({ preventScroll: true });
}

function renderFooter() {
  const i = state.info;
  document.getElementById('footer').replaceChildren(
    h('strong', {}, i.storeName),
    h('p', {}, `営業時間 ${i.openTime}〜${i.closeTime}`, i.closedWeekdays.length ? `（${i.closedWeekdays.map((d) => WEEKDAYS[d]).join('・')}曜定休）` : ''),
    i.storePhone ? h('p', {}, '電話 ', h('a', { href: telHref(i.storePhone) }, i.storePhone)) : null,
  );
}

async function init() {
  try {
    state.info = await api('/api/info');
  } catch (err) {
    document.getElementById('loading').textContent = err.message;
    return;
  }
  const { info } = state;
  document.title = `ご予約 | ${info.storeName}`;
  for (const el of document.querySelectorAll('[data-store-name]')) el.textContent = info.storeName;
  const call = document.getElementById('header-call');
  if (info.storePhone) {
    call.href = telHref(info.storePhone);
    call.hidden = false;
    call.setAttribute('aria-label', `${info.storePhone} に電話する`);
  }
  renderFooter();
  window.addEventListener('hashchange', route);
  route();
}

init();
