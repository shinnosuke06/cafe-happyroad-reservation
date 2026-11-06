// メニューの管理（写真・値段・曜日・予約で選べるか）
import { h, icon, toast, formatPrice, weekdaysLabel, WEEKDAYS } from './common.js';
import { $, state, call, registerPanel, modal, closeButton, field, loadMenu } from './admin-core.js';

const MAX_SIDE = 1200; // 写真は長い辺を1200pxに縮めてから送る

/** 写真を縮めて JPEG にする（スマホの位置情報などもここで消える） */
async function shrinkPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadPhoto(file) {
  let blob;
  try {
    blob = await shrinkPhoto(file);
  } catch {
    throw new Error('この写真は読み込めませんでした。JPEG か PNG の写真を選んでください');
  }
  const res = await fetch('/api/admin/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? '写真を送れませんでした'), { status: res.status });
  return data;
}

function thumb(item) {
  return item.photoUrl
    ? h('img', { class: 'thumb', src: item.photoUrl, alt: '' })
    : h('div', { class: 'thumb no-photo', 'aria-hidden': 'true' }, icon('cup'));
}

function render() {
  const panel = $('panel-menu');
  const rows = state.menu.map((item, index) =>
    h(
      'article',
      { class: `menu-row${item.active ? '' : ' off'}` },
      thumb(item),
      h(
        'div',
        {},
        h('h3', {}, item.name),
        h(
          'div',
          { class: 'meta' },
          h('span', {}, formatPrice(item.price)),
          item.category ? h('span', {}, item.category) : null,
          h('span', {}, weekdaysLabel(item.weekdays) || '毎日'),
          h('span', {}, item.preorder ? '予約で選べる' : '予約では選べない'),
          item.active ? null : h('strong', {}, '非表示'),
        ),
      ),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': `${item.name}を上へ`, disabled: index === 0, onclick: () => move(item, 'up') }, '↑'),
        h('button', { type: 'button', class: 'btn btn-icon', 'aria-label': `${item.name}を下へ`, disabled: index === state.menu.length - 1, onclick: () => move(item, 'down') }, '↓'),
        h('button', { type: 'button', class: 'btn', onclick: () => openItem(item) }, '編集'),
      ),
    ),
  );
  panel.replaceChildren(
    h(
      'div',
      { class: 'day-toolbar' },
      h('div', { class: 'day-heading' }, h('h2', {}, 'メニュー')),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openItem(null) }, '＋ メニューを追加'),
    ),
    h('p', { class: 'hint search-box' }, '予約ページに写真つきで出ます。曜日を選ぶと、その曜日だけのメニューになります。「↑」「↓」で並び順を変えられます。'),
    h('div', { class: 'list-rows' }, rows.length ? rows : h('p', { class: 'empty card' }, 'まだメニューがありません。「＋ メニューを追加」から登録してください。')),
  );
}

async function move(item, direction) {
  try {
    state.menu = (await call(`/api/admin/menu/${item.id}/move`, { method: 'POST', body: { direction } })).items;
    render();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function openItem(item) {
  let photo = item?.photo ?? '';
  let photoUrl = item?.photoUrl ?? '';
  const preview = h('div', { class: 'preview' });
  const showPreview = () => {
    preview.replaceChildren(photoUrl ? h('img', { class: 'preview', src: photoUrl, alt: '写真' }) : icon('photo'));
    removePhoto.hidden = !photoUrl;
  };
  const error = h('p', { class: 'form-error', role: 'alert' });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', 'aria-label': '写真を選ぶ' });
  const removePhoto = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm',
      onclick: () => {
        photo = '';
        photoUrl = '';
        showPreview();
      },
    },
    '写真を外す',
  );
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    error.textContent = '';
    status.textContent = '写真を送っています…';
    try {
      const uploaded = await uploadPhoto(file);
      photo = uploaded.photo;
      photoUrl = uploaded.photoUrl;
      showPreview();
      status.textContent = '写真を付けました。「保存」を押すと決まります。';
    } catch (err) {
      status.textContent = '';
      error.textContent = err.message;
    } finally {
      fileInput.value = '';
    }
  });
  showPreview();

  const categories = [...new Set(state.menu.map((m) => m.category).filter(Boolean))];
  const days = new Set(item?.weekdays ?? []);
  const save = h('button', { type: 'submit', class: 'btn btn-primary' }, '保存');

  const { close } = modal({
    title: item ? 'メニューを編集' : 'メニューを追加',
    body: [
      h(
        'div',
        { class: 'photo-field' },
        preview,
        h(
          'div',
          { class: 'photo-actions' },
          h('label', { class: 'btn btn-sm file-button' }, icon('photo'), '写真を選ぶ', fileInput),
          removePhoto,
        ),
      ),
      status,
      field('メニュー名', h('input', { name: 'name', maxlength: 40, required: true, value: item?.name ?? '' }), h('em', { class: 'req' }, '必須')),
      h(
        'div',
        { class: 'grid-2' },
        field('値段（円）', h('input', { name: 'price', type: 'number', min: 0, max: 1000000, value: item?.price ?? 0 })),
        field('分類', h('input', { name: 'category', maxlength: 20, list: 'menu-categories', placeholder: '例：ドリンク', value: item?.category ?? '' })),
      ),
      h('datalist', { id: 'menu-categories' }, categories.map((c) => h('option', { value: c }))),
      field('説明', h('textarea', { name: 'description', maxlength: 300, placeholder: '例：自家製のチーズを使ったケーキです' }, item?.description ?? '')),
      h(
        'fieldset',
        { class: 'plain' },
        h('legend', {}, '出している曜日（選ばなければ毎日）'),
        h(
          'div',
          { class: 'weekday-picks' },
          [1, 2, 3, 4, 5, 6, 0].map((d) =>
            h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'weekdays', value: d, checked: days.has(d) }), `${WEEKDAYS[d]}曜`),
          ),
        ),
      ),
      h('label', { class: 'check big-check' }, h('input', { type: 'checkbox', name: 'preorder', checked: item ? item.preorder : true }), '予約のときにお客様が選べる'),
      h('label', { class: 'check big-check' }, h('input', { type: 'checkbox', name: 'active', checked: item ? item.active : true }), '予約ページに表示する'),
      error,
    ],
    actions: [
      item
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-danger spacer',
              onclick: async () => {
                if (!confirm(`「${item.name}」を削除しますか？\n（一時的に出さないだけなら「予約ページに表示する」のチェックを外してください）`)) return;
                try {
                  await call(`/api/admin/menu/${item.id}`, { method: 'DELETE' });
                  close();
                  toast('メニューを削除しました');
                  await loadMenu();
                  render();
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
    onSubmit: async (form) => {
      const e = form.elements;
      const body = {
        name: e.name.value,
        price: Number(e.price.value || 0),
        category: e.category.value,
        description: e.description.value,
        weekdays: [...form.querySelectorAll('input[name="weekdays"]:checked')].map((i) => Number(i.value)),
        preorder: e.preorder.checked,
        active: e.active.checked,
        photo,
      };
      if (!body.name.trim()) {
        error.textContent = 'メニュー名を入力してください';
        return;
      }
      save.disabled = true;
      try {
        if (item) await call(`/api/admin/menu/${item.id}`, { method: 'PATCH', body });
        else await call('/api/admin/menu', { method: 'POST', body });
        close();
        toast(`「${body.name}」を保存しました`);
        await loadMenu();
        render();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    },
  });
}

registerPanel('menu', {
  label: 'メニュー',
  iconName: 'menu',
  show: async () => {
    try {
      await loadMenu();
    } catch (err) {
      if (err.status !== 401) toast(err.message, { error: true });
      return;
    }
    render();
  },
});
