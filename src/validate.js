// 入力チェックの道具。おかしな入力は AppError（日本語のメッセージ付き）にする。
import { isValidDate, isValidTime } from './time.js';

export class AppError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function text(value, { field, max, required = false, multiline = false }) {
  let s = value == null ? '' : String(value);
  // 制御文字を取り除く（改行は複数行の項目だけ残す）
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '') : s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s.trim();
  if (required && !s) throw new AppError(`${field}を入力してください`);
  if (s.length > max) throw new AppError(`${field}は${max}文字以内で入力してください`);
  return s;
}

export function integer(value, { field, min, max }) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(`${field}は${min}〜${max}の数字で入力してください`);
  }
  return n;
}

export function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function date(value, field = '日付') {
  if (!isValidDate(value)) throw new AppError(`${field}の形式が正しくありません`);
  return value;
}

export function optionalDate(value, field) {
  if (value == null || value === '') return null;
  return date(value, field);
}

export function time(value, field = '時刻') {
  if (!isValidTime(value)) throw new AppError(`${field}の形式が正しくありません`);
  return value;
}

/** 全角の数字・英字・ハイフンを半角にそろえる */
export function normalizeWidth(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[‐‑‒–—―ー−]/g, '-');
}

export function digitsOnly(value) {
  return normalizeWidth(value).replace(/\D/g, '');
}

export function phone(value, { required }) {
  const s = text(normalizeWidth(value), { field: '電話番号', max: 20, required });
  if (!s) return '';
  if (!/^[0-9+\-() ]+$/.test(s) || !/^\d{10,15}$/.test(digitsOnly(s))) {
    throw new AppError('電話番号の形式が正しくありません（例：090-1234-5678）');
  }
  return s;
}

export function email(value) {
  const s = text(normalizeWidth(value), { field: 'メールアドレス', max: 254 });
  if (s && !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(s)) {
    throw new AppError('メールアドレスの形式が正しくありません');
  }
  return s;
}

export function weekdays(value, field = '曜日') {
  if (!Array.isArray(value) || !value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new AppError(`${field}の指定が正しくありません`);
  }
  return [...new Set(value)].sort((a, b) => a - b);
}

export function url(value, field) {
  const s = text(value, { field, max: 300 });
  if (!s) return '';
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new AppError(`${field}は https:// から始まるURLを入力してください`);
  }
  if (parsed.protocol !== 'https:') throw new AppError(`${field}は https:// から始まるURLを入力してください`);
  return parsed.href;
}
