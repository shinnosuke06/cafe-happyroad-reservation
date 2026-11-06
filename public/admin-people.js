// お客様の一覧と、お知らせ（メール・LINE・予約ページへの掲載）
import { h, icon, toast, formatDate, formatShortDate, STATUS_LABELS } from './common.js';
import { $, state, call, registerPanel, modal, closeButton, field, showTab } from './admin-core.js';

// =========================================================
// お客様
// =========================================================

let customerTimer;
let customerSeq = 0;
let customersBuilt = false;

function buildCustomers() {
  $('panel-customers').replaceChildren(
    h('div', { class: 'day-toolbar' }, h('div', { class: 'day-heading' }, h('h2', {}, 'お客様'))),
    h('p', { class: 'hint search-box' }, '予約のときの電話番号ごとにまとめています。チェックを付けると、その方々にお知らせを送れます。'),
    h('input', {
      type: 'search',
      id: 'customer-search',
      class: 'search-box',
      maxlength: 50,
      placeholder: 'お名前・電話番号・メールで探す',
      'aria-label': 'お客様を探す',
      oninput: () => {
        clearTimeout(customerTimer);
        customerTimer = setTimeout(loadCustomers, 250);
      },
    }),
    h('div', { class: 'select-bar', id: 'select-bar' }),
    h('div', { class: 'list-rows', id: 'customer-list' }),
  );
}

function renderSelectBar() {
  const n = state.selectedCustomers.size;
  $('select-bar').replaceChildren(
    h('span', { class: 'count' }, n ? `${n}人を選んでいます` : 'だれも選んでいません'),
    h('button', { type: 'button', class: 'btn btn-primary', disabled: n === 0, onclick: () => showTab('messages', { target: 'selected' }) }, icon('send'), '選んだ方にお知らせを送る'),
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        disabled: n === 0,
        onclick: () => {
          state.selectedCustomers.clear();
          loadCustomers();
        },
      },
      '選択を外す',
    ),
  );
}

async function loadCustomers() {
  const q = $('customer-search').value.trim();
  const seq = ++customerSeq;
  try {
    const { customers } = await call(`/api/admin/customers?q=${encodeURIComponent(q)}`);
    if (seq !== customerSeq) return;
    renderSelectBar();
    $('customer-list').replaceChildren(
      ...(customers.length
        ? customers.map(customerRow)
        : [h('p', { class: 'empty card' }, q ? '見つかりませんでした' : 'まだお客様の記録がありません。予約が入ると、ここに出てきます。')]),
    );
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

function contactTags(c) {
  return h(
    'span',
    { class: 'contact-tags' },
    h('span', { class: c.notifyEmail ? 'on' : '' }, c.notifyEmail ? 'メールでお知らせ可' : c.email ? 'メールあり' : 'メールなし'),
    h('span', { class: c.notifyLine ? 'on' : '' }, c.lineLinked ? (c.notifyLine ? 'LINEでお知らせ可' : 'LINE登録あり') : 'LINEなし'),
  );
}

function customerRow(c) {
  const box = h('input', {
    type: 'checkbox',
    checked: state.selectedCustomers.has(c.id),
    'aria-label': `${c.name}様を選ぶ`,
    onchange: () => {
      if (box.checked) state.selectedCustomers.set(c.id, c.name);
      else state.selectedCustomers.delete(c.id);
      renderSelectBar();
    },
  });
  return h(
    'article',
    { class: 'customer-row' },
    h('label', { class: 'check' }, box),
    h(
      'div',
      {},
      h('h3', {}, `${c.name} 様`),
      contactTags(c),
      h(
        'div',
        { class: 'meta' },
        c.phone ? h('span', {}, c.phone) : null,
        c.email ? h('span', {}, c.email) : null,
        h('span', {}, `予約 ${c.reservationCount}回`),
        c.nextDate ? h('span', {}, `次回 ${formatShortDate(c.nextDate)}`) : null,
        c.lastDate ? h('span', {}, `前回 ${formatShortDate(c.lastDate)}`) : null,
      ),
    ),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openCustomer(c.id) }, '詳しく'),
  );
}

async function openCustomer(id) {
  let data;
  try {
    data = await call(`/api/admin/customers/${id}`);
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }
  const { customer: c, reservations } = data;
  const error = h('p', { class: 'form-error', role: 'alert' });
  const { close } = modal({
    title: `${c.name} 様`,
    meta: c.phone,
    body: [
      field('お名前', h('input', { name: 'name', maxlength: 50, value: c.name })),
      field('メールアドレス', h('input', { name: 'email', type: 'email', maxlength: 254, value: c.email })),
      h('label', { class: 'check big-check' }, h('input', { type: 'checkbox', name: 'notifyEmail', checked: c.notifyEmail }), 'お知らせをメールで送ってよい（ご本人の希望がある場合のみ）'),
      h(
        'label',
        { class: 'check big-check' },
        h('input', { type: 'checkbox', name: 'notifyLine', checked: c.notifyLine, disabled: !c.lineLinked }),
        c.lineLinked ? 'お知らせをLINEで送ってよい' : 'LINEは未登録（お客様がLINEで予約番号を送ると登録されます）',
      ),
      field('お店用のメモ（お客様には見えません）', h('textarea', { name: 'memo', maxlength: 500 }, c.memo)),
      h(
        'details',
        { class: 'more', open: true },
        h('summary', {}, `予約の記録（${reservations.length}件）`),
        h(
          'ul',
          { class: 'plain list-rows' },
          reservations.map((r) =>
            h(
              'li',
              { class: 'history-item' },
              h('strong', {}, `${formatDate(r.date, { year: true })} ${r.time}〜`),
              `　${r.partySize}名　`,
              h('span', { class: `badge status-${r.status}` }, STATUS_LABELS[r.status]),
              r.items.length ? h('div', { class: 'meta' }, r.items.map((i) => `${i.name}×${i.quantity}`).join('、')) : null,
            ),
          ),
        ),
      ),
      error,
    ],
    actions: [
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-danger spacer',
          onclick: async () => {
            if (!confirm(`${c.name}様の連絡先を削除しますか？\n（予約の記録は残ります。お知らせは届かなくなります）`)) return;
            try {
              await call(`/api/admin/customers/${c.id}`, { method: 'DELETE' });
              state.selectedCustomers.delete(c.id);
              close();
              toast('連絡先を削除しました');
              loadCustomers();
            } catch (err) {
              error.textContent = err.message;
            }
          },
        },
        '削除',
      ),
      closeButton(),
      h('button', { type: 'submit', class: 'btn btn-primary' }, '保存'),
    ],
    onSubmit: async (form) => {
      const e = form.elements;
      try {
        await call(`/api/admin/customers/${c.id}`, {
          method: 'PATCH',
          body: { name: e.name.value, email: e.email.value, notifyEmail: e.notifyEmail.checked, notifyLine: e.notifyLine.checked, memo: e.memo.value },
        });
        close();
        toast('保存しました');
        loadCustomers();
      } catch (err) {
        error.textContent = err.message;
      }
    },
  });
}

registerPanel('customers', {
  label: 'お客様',
  iconName: 'users',
  show: () => {
    if (!customersBuilt) {
      buildCustomers();
      customersBuilt = true;
    }
    loadCustomers();
  },
});

// =========================================================
// お知らせ
// =========================================================

function channelLabel(name, ready) {
  return `${name}${ready ? '' : '（送信設定がまだです）'}`;
}

async function renderMessages(options = {}) {
  const panel = $('panel-messages');
  const { notify } = state;
  const selectedCount = state.selectedCustomers.size;
  const target = options.target ?? (selectedCount ? 'selected' : 'all');
  const prefill = options.prefill ?? {};
  const error = h('p', { class: 'form-error', role: 'alert' });
  const result = h('div', { 'aria-live': 'polite' });
  const send = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, icon('send'), '送る・載せる');

  const form = h(
    'form',
    { class: 'card compose', novalidate: true },
    h('h2', {}, icon('send'), 'お知らせを作る'),
    !notify.email && !notify.line
      ? h('p', { class: 'setup-note' }, 'メール・LINEの送信設定がまだです。今は「予約ページに載せる」だけ使えます。設定のしかたは README の「お知らせの送信設定」をご覧ください。')
      : null,
    h(
      'fieldset',
      { class: 'plain' },
      h('legend', {}, 'だれに送りますか'),
      h(
        'div',
        { class: 'radio-cards' },
        h(
          'label',
          {},
          h('input', { type: 'radio', name: 'target', value: 'all', checked: target === 'all' }),
          h('span', {}, h('strong', {}, 'お知らせを希望している方 全員'), h('small', {}, '臨時休業や新メニューのお知らせに')),
        ),
        h(
          'label',
          {},
          h('input', { type: 'radio', name: 'target', value: 'selected', checked: target === 'selected', disabled: selectedCount === 0 }),
          h(
            'span',
            {},
            h('strong', {}, `選んだ方だけ（${selectedCount}人）`),
            h('small', {}, selectedCount ? '予約の変更のご連絡などに。「お客様」の画面で選びます' : '「お客様」の画面でチェックを付けると選べます'),
          ),
        ),
      ),
    ),
    h(
      'fieldset',
      { class: 'plain' },
      h('legend', {}, 'どうやって知らせますか'),
      h(
        'div',
        { class: 'radio-cards' },
        h('label', {}, h('input', { type: 'checkbox', name: 'email', checked: notify.email, disabled: !notify.email }), h('span', {}, h('strong', {}, channelLabel('メールで送る', notify.email)))),
        h('label', {}, h('input', { type: 'checkbox', name: 'line', checked: notify.line, disabled: !notify.line }), h('span', {}, h('strong', {}, channelLabel('LINEで送る', notify.line)))),
        h(
          'label',
          {},
          h('input', { type: 'checkbox', name: 'publish', checked: prefill.publish ?? true }),
          h('span', {}, h('strong', {}, '予約ページの「お知らせ」に載せる'), h('small', {}, '下の「掲載をやめる日」まで表示します')),
        ),
      ),
    ),
    field('件名', h('input', { name: 'subject', maxlength: 60, value: prefill.subject ?? '', placeholder: '例：臨時休業のお知らせ' }), h('em', { class: 'req' }, '必須')),
    field('本文', h('textarea', { name: 'body', maxlength: 2000, placeholder: '例：12月31日（木）は、設備点検のため臨時休業いたします。' }, prefill.body ?? ''), h('em', { class: 'req' }, '必須')),
    field('掲載をやめる日（予約ページに載せるとき）', h('input', { name: 'endsOn', type: 'date', value: prefill.endsOn ?? '' }), h('em', { class: 'opt' }, 'なくても可')),
    error,
    send,
    result,
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const e = form.elements;
    const channels = ['email', 'line'].filter((c) => e[c].checked && !e[c].disabled);
    const subject = e.subject.value.trim();
    const body = e.body.value.trim();
    const targetValue = form.querySelector('input[name="target"]:checked')?.value ?? 'all';
    if (!subject || !body) {
      error.textContent = '件名と本文を入力してください';
      return;
    }
    if (channels.length === 0 && !e.publish.checked) {
      error.textContent = '「メール」「LINE」「予約ページに載せる」のどれかを選んでください';
      return;
    }
    const who = targetValue === 'selected' ? `選んだ${state.selectedCustomers.size}人` : 'お知らせを希望している方全員';
    const how = [...channels.map((c) => (c === 'email' ? 'メール' : 'LINE')), e.publish.checked ? '予約ページ' : null].filter(Boolean).join('・');
    if (!confirm(`「${subject}」を\n${channels.length ? `${who}に` : ''}${how}でお知らせします。よろしいですか？`)) return;

    send.disabled = true;
    const lines = [];
    try {
      if (e.publish.checked) {
        await call('/api/admin/announcements', { method: 'POST', body: { title: subject, body, startsOn: state.today, endsOn: e.endsOn.value || null } });
        lines.push('予約ページに載せました。');
      }
      if (channels.length) {
        const res = await call('/api/admin/messages', {
          method: 'POST',
          body: { subject, body, channels, target: targetValue, customerIds: [...state.selectedCustomers.keys()] },
        });
        const { email, line } = res.summary;
        if (channels.includes('email')) lines.push(`メール：${email.sent}件 送りました${email.failed ? `（${email.failed}件 送れませんでした）` : ''}`);
        if (channels.includes('line')) lines.push(`LINE：${line.sent}件 送りました${line.failed ? `（${line.failed}件 送れませんでした）` : ''}`);
        for (const f of res.failures) lines.push(`・${f.name ?? '（削除済み）'}様（${f.channel === 'email' ? 'メール' : 'LINE'}）：${f.error}`);
      }
      toast('お知らせしました');
      form.reset();
      result.replaceChildren(h('div', { class: 'banner' }, lines.map((l) => h('div', {}, l))));
      loadHistory();
    } catch (err) {
      error.textContent = [err.message, ...lines].join(' ');
      if (lines.length) loadHistory();
    } finally {
      send.disabled = false;
    }
  });

  panel.replaceChildren(
    h('div', { class: 'day-toolbar' }, h('div', { class: 'day-heading' }, h('h2', {}, 'お知らせ'))),
    h(
      'div',
      { class: 'admin-grid' },
      form,
      h(
        'div',
        { class: 'list-rows' },
        h('section', { class: 'card' }, h('h2', {}, icon('bell'), '予約ページに載せているお知らせ'), h('div', { class: 'announce-list', id: 'announce-list' })),
        h('section', { class: 'card' }, h('h2', {}, '送ったお知らせ'), h('div', { class: 'history', id: 'message-history' })),
      ),
    ),
  );
  loadHistory();
}

async function loadHistory() {
  try {
    const [{ announcements }, { messages }] = await Promise.all([call('/api/admin/announcements'), call('/api/admin/messages')]);
    const today = state.today;
    $('announce-list').replaceChildren(
      ...(announcements.length
        ? announcements.map((a) => {
            const label = a.endsOn && a.endsOn < today ? '掲載終了' : a.startsOn && a.startsOn > today ? '掲載予定' : '掲載中';
            return h(
              'div',
              { class: 'announce-item' },
              h('strong', {}, a.title),
              h('span', {}, `${label}${a.endsOn ? `（${formatShortDate(a.endsOn)}まで）` : ''}`),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-danger',
                  onclick: async () => {
                    if (!confirm(`「${a.title}」を予約ページから外しますか？`)) return;
                    await call(`/api/admin/announcements/${a.id}`, { method: 'DELETE' });
                    toast('お知らせを外しました');
                    loadHistory();
                  },
                },
                '外す',
              ),
            );
          })
        : [h('p', { class: 'hint' }, '載せているお知らせはありません')]),
    );
    $('message-history').replaceChildren(
      ...(messages.length
        ? messages.map((m) =>
            h(
              'div',
              { class: 'history-item' },
              h('strong', {}, m.subject),
              h(
                'div',
                { class: 'meta' },
                `${new Date(m.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　`,
                `${m.target === 'all' ? '希望者全員' : '選んだ方'}・${m.channels.map((c) => (c === 'email' ? 'メール' : 'LINE')).join('/')}　`,
                `${m.sentCount}件 送信${m.failedCount ? `・${m.failedCount}件 失敗` : ''}`,
              ),
            ),
          )
        : [h('p', { class: 'hint' }, 'まだ送ったことはありません')]),
    );
  } catch (err) {
    if (err.status !== 401) toast(err.message, { error: true });
  }
}

registerPanel('messages', {
  label: 'お知らせ',
  iconName: 'bell',
  show: (options) => renderMessages(options),
});
