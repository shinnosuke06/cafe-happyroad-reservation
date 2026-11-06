// 設定：営業時間・予約の受付・テーブル・休業日・お知らせの送信状況・セキュリティ
import { h, icon, toast, formatDate, WEEKDAYS } from './common.js';
import { $, state, call, registerPanel, field, loadSettings, showTab } from './admin-core.js';

const NUMBER_FIELDS = ['slotMinutes', 'stayMinutes', 'maxPartySize', 'maxGuestsPerSlot', 'bookingDaysAhead', 'minNoticeMinutes'];
const TEXT_FIELDS = ['storeName', 'storePhone', 'storeAddress', 'lineFriendUrl', 'openTime', 'closeTime'];

function settingsForm() {
  const s = state.settings;
  const error = h('p', { class: 'form-error', role: 'alert' });
  const input = (name, attrs = {}) => h('input', { name, value: s[name], ...attrs });
  const form = h(
    'form',
    { class: 'card fields', novalidate: true },
    h('h2', {}, '営業時間と予約の受付'),
    h('div', { class: 'grid-2 stack-sm' }, field('店名', input('storeName', { maxlength: 50 })), field('お店の電話番号', input('storePhone', { type: 'tel', maxlength: 20 }))),
    field('住所', input('storeAddress', { maxlength: 100, placeholder: '予約ページの「お店の情報」に出ます' })),
    h('div', { class: 'grid-2' }, field('開店', input('openTime', { type: 'time' })), field('閉店', input('closeTime', { type: 'time' }))),
    h(
      'div',
      { class: 'grid-2' },
      field(
        '予約の間隔',
        h('select', { name: 'slotMinutes' }, [10, 15, 20, 30, 60].map((m) => h('option', { value: m, selected: s.slotMinutes === m }, m === 60 ? '1時間ごと' : `${m}分ごと`))),
      ),
      field('1組の利用時間（分）', input('stayMinutes', { type: 'number', min: 15, max: 600, step: 5 })),
    ),
    h(
      'div',
      { class: 'grid-2' },
      field('Web予約の最大人数（1組）', input('maxPartySize', { type: 'number', min: 1, max: 50 })),
      field('同じ時間の最大人数（0＝制限なし）', input('maxGuestsPerSlot', { type: 'number', min: 0, max: 500 })),
    ),
    h(
      'div',
      { class: 'grid-2' },
      field('何日先まで受け付けるか', input('bookingDaysAhead', { type: 'number', min: 0, max: 365 })),
      field('当日は来店の何分前まで', input('minNoticeMinutes', { type: 'number', min: 0, max: 2880, step: 5 })),
    ),
    h(
      'fieldset',
      { class: 'plain' },
      h('legend', {}, '定休日'),
      h(
        'div',
        { class: 'weekday-picks' },
        [1, 2, 3, 4, 5, 6, 0].map((d) =>
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'closedWeekdays', value: d, checked: s.closedWeekdays.includes(d) }), `${WEEKDAYS[d]}曜`),
        ),
      ),
    ),
    field('LINE公式アカウントの友だち追加URL', input('lineFriendUrl', { type: 'url', maxlength: 300, placeholder: 'https://lin.ee/…' }), h('em', { class: 'opt' }, 'なくても可')),
    error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, '設定を保存')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const body = {};
    for (const key of TEXT_FIELDS) body[key] = form.elements[key].value;
    for (const key of NUMBER_FIELDS) body[key] = Number(form.elements[key].value);
    body.closedWeekdays = [...form.querySelectorAll('input[name="closedWeekdays"]:checked')].map((i) => Number(i.value));
    try {
      await call('/api/admin/settings', { method: 'PUT', body });
      await loadSettings();
      toast('設定を保存しました');
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return form;
}

function tablesCard() {
  const rows = h('div', { class: 'table-rows' });
  const draw = () => {
    rows.replaceChildren(
      h('div', { class: 'table-row table-head' }, h('span', {}, 'テーブル名'), h('span', {}, '席の種類'), h('span', {}, '席数'), h('span', {}, ''), h('span', {}, '')),
      ...state.tables.map((t) => {
        const save = async (patch) => {
          try {
            const { table } = await call(`/api/admin/tables/${t.id}`, { method: 'PATCH', body: patch });
            Object.assign(t, table);
            toast(`${table.name}を保存しました`);
          } catch (err) {
            toast(err.message, { error: true });
            draw();
          }
        };
        const name = h('input', { value: t.name, maxlength: 30, 'aria-label': 'テーブル名', onchange: (e) => save({ name: e.currentTarget.value }) });
        const area = h('input', { value: t.area, maxlength: 20, list: 'area-list', 'aria-label': `${t.name}の席の種類`, onchange: (e) => save({ area: e.currentTarget.value }) });
        const seats = h('input', { type: 'number', min: 1, max: 50, value: t.seats, 'aria-label': `${t.name}の席数`, onchange: (e) => save({ seats: Number(e.currentTarget.value) }) });
        const active = h('input', { type: 'checkbox', checked: t.active, onchange: (e) => save({ active: e.currentTarget.checked }) });
        return h(
          'div',
          { class: 'table-row' },
          name,
          area,
          seats,
          h('label', { class: 'check' }, active, '使う'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-danger',
              onclick: async () => {
                if (!confirm(`${t.name}を削除しますか？`)) return;
                try {
                  await call(`/api/admin/tables/${t.id}`, { method: 'DELETE' });
                  state.tables = state.tables.filter((x) => x.id !== t.id);
                  draw();
                  toast('テーブルを削除しました');
                } catch (err) {
                  toast(err.message, { error: true });
                }
              },
            },
            '削除',
          ),
        );
      }),
    );
  };
  draw();
  const areas = [...new Set(state.tables.map((t) => t.area).filter(Boolean))];
  const add = h(
    'form',
    { class: 'inline-form table', novalidate: true },
    field('テーブル名', h('input', { name: 'name', maxlength: 30, placeholder: '例：カウンター1' })),
    field('席の種類', h('input', { name: 'area', maxlength: 20, list: 'area-list', placeholder: '例：カウンター' })),
    field('席数', h('input', { name: 'seats', type: 'number', min: 1, max: 50, value: 2 })),
    h('button', { type: 'submit', class: 'btn' }, '追加'),
  );
  add.addEventListener('submit', async (event) => {
    event.preventDefault();
    const e = add.elements;
    try {
      const { table } = await call('/api/admin/tables', { method: 'POST', body: { name: e.name.value, area: e.area.value, seats: Number(e.seats.value) } });
      state.tables.push(table);
      draw();
      add.reset();
      toast(`${table.name}を追加しました`);
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'テーブル（席）'),
    h('p', { class: 'card-sub' }, 'Web予約は、人数に合う一番小さい空きテーブルに入ります。「席の種類」はお客様が席の希望として選べます。変更はその場で保存されます。'),
    h('datalist', { id: 'area-list' }, areas.map((a) => h('option', { value: a }))),
    rows,
    add,
  );
}

function closuresCard() {
  const list = h('div', { class: 'closure-list' });
  const notice = h('div');
  const draw = () => {
    list.replaceChildren(
      ...(state.closures.length
        ? state.closures.map((c) =>
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
                      draw();
                      toast('臨時休業日を取り消しました');
                    } catch (err) {
                      toast(err.message, { error: true });
                    }
                  },
                },
                '取消',
              ),
            ),
          )
        : [h('p', { class: 'hint' }, '予定している臨時休業日はありません')]),
    );
  };
  draw();
  const add = h(
    'form',
    { class: 'inline-form closure', novalidate: true },
    field('日付', h('input', { name: 'date', type: 'date', min: state.today })),
    field('理由', h('input', { name: 'reason', maxlength: 50, placeholder: '例：設備点検' }), h('em', { class: 'opt' }, 'なくても可')),
    h('button', { type: 'submit', class: 'btn' }, '追加'),
  );
  add.addEventListener('submit', async (event) => {
    event.preventDefault();
    const e = add.elements;
    if (!e.date.value) {
      toast('日付を選んでください', { error: true });
      return;
    }
    try {
      const { closure, customerIds } = await call('/api/admin/closures', { method: 'POST', body: { date: e.date.value, reason: e.reason.value } });
      state.closures = [...state.closures.filter((c) => c.date !== closure.date), { date: closure.date, reason: closure.reason }].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      draw();
      add.reset();
      toast(`${formatDate(closure.date)}を臨時休業日にしました`);
      const title = `${formatDate(closure.date)}は臨時休業いたします`;
      const body = `いつも${state.settings.storeName}をご利用いただき、ありがとうございます。\n${formatDate(closure.date)}は${closure.reason ? `${closure.reason}のため、` : ''}臨時休業いたします。ご迷惑をおかけしますが、よろしくお願いいたします。`;
      notice.replaceChildren(
        h(
          'div',
          { class: closure.reservations ? 'banner danger' : 'banner' },
          h('p', {}, closure.reservations ? `この日には予約が ${closure.reservations}件 入っています。お客様にご連絡ください。` : 'お客様にお知らせしますか？'),
          h(
            'div',
            { class: 'form-actions' },
            customerIds.length
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-primary',
                    onclick: () => {
                      state.selectedCustomers = new Map(customerIds.map((id) => [id, '']));
                      showTab('messages', { target: 'selected', prefill: { subject: title, body: `${body}\nご予約をいただいていた方には、お手数ですが日をあらためてご予約をお願いいたします。`, publish: false } });
                    },
                  },
                  `予約のある${customerIds.length}人に知らせる`,
                )
              : null,
            h(
              'button',
              { type: 'button', class: 'btn', onclick: () => showTab('messages', { target: 'all', prefill: { subject: title, body, publish: true, endsOn: closure.date } }) },
              'みなさんに知らせる',
            ),
          ),
        ),
      );
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  return h('section', { class: 'card' }, h('h2', {}, '臨時休業日'), h('p', { class: 'card-sub' }, 'この日はWeb予約を受け付けません。予約ページの「お店の情報」にも出ます。'), list, add, notice);
}

function notifyCard() {
  const { notify } = state;
  const row = (label, ok, hint) =>
    h('div', { class: 'closure-item' }, h('strong', {}, label), h('span', {}, ok ? '設定済み' : hint), h('span', { class: `badge ${ok ? 'status-arrived' : ''}` }, ok ? '使える' : '未設定'));
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, icon('send'), 'お知らせの送信'),
    h(
      'div',
      { class: 'closure-list' },
      row('メール', notify.email, 'サーバーに SMTP の設定が必要です'),
      row('LINE', notify.line, 'LINE公式アカウントの設定が必要です'),
      notify.line ? row('LINEの受け付け', notify.lineWebhook, 'チャネルシークレットの設定が必要です') : null,
      notify.email ? row('メールの配信停止リンク', notify.unsubscribeLink, 'PUBLIC_URL の設定が必要です') : null,
    ),
    notify.line ? h('p', { class: 'hint' }, `LINE Developers の Webhook URL：${location.origin}/api/line/webhook`) : null,
    h('p', { class: 'hint' }, '設定のしかたは README の「お知らせの送信設定」をご覧ください。'),
  );
}

function securityCard() {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h(
    'form',
    { class: 'fields', novalidate: true },
    field('いまのパスワード', h('input', { name: 'current', type: 'password', autocomplete: 'current-password' })),
    field('新しいパスワード（10文字以上）', h('input', { name: 'next', type: 'password', autocomplete: 'new-password', minlength: 10 })),
    field('新しいパスワード（もう一度）', h('input', { name: 'again', type: 'password', autocomplete: 'new-password' })),
    error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'パスワードを変える')),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const e = form.elements;
    if (e.next.value !== e.again.value) {
      error.textContent = '新しいパスワードが2回とも同じになっていません';
      return;
    }
    try {
      await call('/api/admin/password', { method: 'POST', body: { current: e.current.value, next: e.next.value } });
      form.reset();
      toast('パスワードを変えました。ほかの端末はログアウトしました');
      loadAudit();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'パスワードとセキュリティ'),
    h('p', { class: 'card-sub' }, 'パスワードを変えると、ほかのスマホやパソコンはログアウトします。12時間たつと自動でログアウトします。'),
    form,
  );
}

function auditCard() {
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '操作の記録'),
    h('p', { class: 'card-sub' }, 'ログインや予約の変更などを記録しています（新しい順・200件まで）。'),
    h('div', { class: 'audit-wrap' }, h('table', { class: 'audit' }, h('thead', {}, h('tr', {}, h('th', {}, '日時'), h('th', {}, '内容'), h('th', {}, 'くわしく'))), h('tbody', { id: 'audit-body' }))),
    h(
      'div',
      { class: 'form-actions search-box' },
      h('a', { class: 'btn', href: '/api/admin/backup', download: '' }, 'データのバックアップを保存'),
    ),
    h('p', { class: 'hint' }, 'バックアップには予約・お客様・メニュー・設定が入っています。お客様の個人情報が入っているので、大切に保管してください。'),
  );
}

async function loadAudit() {
  try {
    const { entries } = await call('/api/admin/audit');
    $('audit-body').replaceChildren(
      ...entries.map((e) =>
        h(
          'tr',
          {},
          h('td', {}, new Date(e.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
          h('td', {}, e.action),
          h('td', {}, e.detail),
        ),
      ),
    );
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

async function render() {
  try {
    await loadSettings();
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
    return;
  }
  $('panel-settings').replaceChildren(
    h('div', { class: 'day-toolbar' }, h('div', { class: 'day-heading' }, h('h2', {}, '設定'))),
    h(
      'div',
      { class: 'admin-grid' },
      settingsForm(),
      h('div', { class: 'list-rows' }, closuresCard(), tablesCard()),
      notifyCard(),
      securityCard(),
      auditCard(),
    ),
  );
  loadAudit();
}

registerPanel('settings', { label: '設定', iconName: 'gear', show: render });
