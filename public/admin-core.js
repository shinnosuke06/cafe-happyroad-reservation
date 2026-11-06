// 管理画面で共通に使う状態と道具
import { api, h, icon } from './common.js';

export const $ = (id) => document.getElementById(id);

export const state = {
  tab: 'book',
  today: null,
  settings: null,
  tables: [],
  areas: [],
  closures: [],
  notify: { email: false, line: false, lineWebhook: false, unsubscribeLink: false },
  menu: [],
  selectedCustomers: new Map(), // id → name（お知らせを送る相手）
};

let unauthorized = () => {};
export function onUnauthorized(fn) {
  unauthorized = fn;
}

/** 管理APIを呼ぶ。ログインが切れていたらログイン画面に戻す */
export async function call(path, options) {
  try {
    return await api(path, options);
  } catch (err) {
    if (err.status === 401) unauthorized();
    throw err;
  }
}

export async function loadSettings() {
  const data = await call('/api/admin/settings');
  Object.assign(state, {
    settings: data.settings,
    tables: data.tables,
    areas: data.areas,
    closures: data.closures,
    today: data.today,
    notify: data.notify,
  });
  for (const el of document.querySelectorAll('[data-store-name]')) el.textContent = data.settings.storeName;
  return data;
}

export async function loadMenu() {
  state.menu = (await call('/api/admin/menu')).items;
  return state.menu;
}

// ---- タブの切り替え（各画面が登録する） ----
const panels = new Map();
export function registerPanel(name, { label, iconName, show }) {
  panels.set(name, { label, iconName, show });
}
export function panelList() {
  return [...panels.entries()];
}
export function showTab(name, options = {}) {
  state.tab = name;
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  window.scrollTo(0, 0);
  return panels.get(name)?.show(options);
}

export function anyDialogOpen() {
  return Boolean(document.querySelector('dialog[open]'));
}

/** その場で作るダイアログ。閉じたら消える */
export function modal({ title, meta = null, body, actions, onSubmit, wide = false }) {
  const dialog = h('dialog', { 'aria-label': title, class: wide ? 'wide' : '' });
  const form = h(
    'form',
    { novalidate: true },
    h(
      'div',
      { class: 'dialog-head' },
      h('div', {}, h('h2', {}, title), meta ? h('div', { class: 'dialog-meta' }, meta) : null),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': '閉じる', onclick: () => dialog.close() }, '×'),
    ),
    h('div', { class: 'dialog-body' }, body),
    h('div', { class: 'dialog-foot' }, actions),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit?.(form);
  });
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close(); // 背景を押したら閉じる
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, form, close: () => dialog.close() };
}

export function closeButton(label = '閉じる') {
  return h(
    'button',
    { type: 'button', class: 'btn', onclick: (event) => event.currentTarget.closest('dialog').close() },
    label,
  );
}

export function field(label, input, extra = null) {
  return h('label', { class: 'field' }, h('span', {}, label, extra), input);
}

export function sectionTitle(text, iconName) {
  return h('h2', {}, iconName ? icon(iconName) : null, text);
}
