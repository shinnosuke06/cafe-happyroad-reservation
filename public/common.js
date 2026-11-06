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
    throw Object.assign(new Error(data?.error ?? `エラーが起きました（${res.status}）`), {
      status: res.status,
      code: data?.code,
    });
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

/** 1200 → "1,200円" */
export function formatPrice(yen) {
  return `${Number(yen).toLocaleString('ja-JP')}円`;
}

/** [0, 6] → "土日限定" のように、出している曜日を短く表す（毎日なら空） */
export function weekdaysLabel(days) {
  if (!days || days.length === 0 || days.length === 7) return '';
  const set = new Set(days);
  if (set.size === 2 && set.has(0) && set.has(6)) return '土日限定';
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return '平日限定';
  return `${[1, 2, 3, 4, 5, 6, 0].filter((d) => set.has(d)).map((d) => WEEKDAYS[d]).join('・')}曜限定`;
}

export function telHref(phone) {
  return `tel:${String(phone).replace(/[^\d+]/g, '')}`;
}

// 決まった形のアイコン（利用者の入力は入らない）
const ICONS = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  menu: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-2.5 5-2.5 8h2.5v10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cup: '<path d="M4 9h12v4a6 6 0 0 1-12 0z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3c-.8 1.2.8 2 0 3.2M12 3c-.8 1.2.8 2 0 3.2"/><path d="M4 21h12"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  line: '<path d="M12 4C7 4 3 7.2 3 11.2c0 3.6 3.2 6.6 7.5 7.1.3.1.7.2.8.5.1.2 0 .6 0 .9l-.1.8c0 .2-.2.9.8.5s5.4-3.2 7.4-5.4c1.4-1.5 2.1-3 2.1-4.6C21 7.2 17 4 12 4z"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3"/><path d="M20 4v14h-7"/>',
  send: '<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>',
};

export function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}
