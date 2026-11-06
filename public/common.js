// お客様ページと管理画面で共通の小さな道具

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
export const STATUS_LABELS = {
  confirmed: '予約',
  arrived: '来店済',
  cancelled: 'キャンセル',
  no_show: '無断キャンセル',
};
export const SOURCE_LABELS = { web: 'Web', phone: '電話', walkin: '来店' };

/** 要素を作る。文字列は必ずテキストとして入れる（HTMLとして解釈しない） */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw Object.assign(new Error('通信できませんでした。電波の良い所でもう一度お試しください'), { status: 0 });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 本文なし */
  }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error ?? `エラーが起きました（${res.status}）`), { status: res.status });
  }
  return data;
}

function parts(date) {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d, w: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/** "2026-11-07" → "11月7日(土)" */
export function formatDate(date, { year = false } = {}) {
  const { y, m, d, w } = parts(date);
  return `${year ? `${y}年` : ''}${m}月${d}日(${WEEKDAYS[w]})`;
}

/** "2026-11-07" → "11/7(土)" */
export function formatShortDate(date) {
  const { m, d, w } = parts(date);
  return `${m}/${d}(${WEEKDAYS[w]})`;
}

export function weekdayOf(date) {
  return parts(date).w;
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function fromMinutes(total) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

let toastTimer;
export function toast(message, { error = false } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 5000 : 2600);
}
