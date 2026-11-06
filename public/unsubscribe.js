import { api } from './common.js';

// 配信停止のしるしは URL の # の後ろにある（サーバーの記録に残らないように）
const token = location.hash.slice(1);
const button = document.getElementById('stop');
const message = document.getElementById('message');
const error = document.getElementById('error');

if (!/^[a-f0-9]{32}$/.test(token)) {
  message.textContent = 'リンクが正しくありません。お手数ですが、お店までご連絡ください。';
  button.hidden = true;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  error.textContent = '';
  try {
    const { name } = await api('/api/unsubscribe', { method: 'POST', body: { token } });
    message.textContent = `${name}様へのお知らせメールを止めました。これまでありがとうございました。`;
    button.hidden = true;
  } catch (err) {
    error.textContent = err.message;
    button.disabled = false;
  }
});
