// 管理画面の入り口：ログインとタブの切り替え
import { api, h, icon } from './common.js';
import { $, state, loadSettings, panelList, showTab, onUnauthorized, anyDialogOpen } from './admin-core.js';
import { refresh as refreshBook } from './admin-book.js';
import './admin-menu.js';
import './admin-people.js';
import './admin-settings.js';

function showLogin() {
  stopPolling();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('login-form').elements.password.focus();
}
onUnauthorized(showLogin);

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

function buildTabs() {
  $('tabs').replaceChildren(
    ...panelList().map(([name, panel]) =>
      h(
        'button',
        { type: 'button', role: 'tab', dataset: { tab: name }, 'aria-selected': String(name === state.tab), onclick: () => showTab(name) },
        icon(panel.iconName),
        panel.label,
      ),
    ),
  );
}

async function enterApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  await loadSettings();
  buildTabs();
  showTab(state.tab);
  startPolling();
}

// Web予約が入ったら1分以内に台帳へ反映する
let pollTimer;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (state.tab === 'book' && !anyDialogOpen() && document.visibilityState === 'visible') refreshBook();
  }, 60_000);
}
function stopPolling() {
  clearInterval(pollTimer);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('app-view').hidden && state.tab === 'book' && !anyDialogOpen()) refreshBook();
});

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
