// スタッフのログイン。パスワードは scrypt でハッシュにして保存し、ログイン状態はデータベースに持つ。
import { randomBytes, createHash, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './validate.js';

const scryptAsync = promisify(scrypt);

const COOKIE_NAME = 'hr_session';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12時間でログアウト
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000; // 5回まちがえたら15分ロック
export const MIN_PASSWORD_LENGTH = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [kind, N, r, p, saltB64, hashB64] = String(stored ?? '').split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(String(password ?? ''), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function checkPasswordStrength(password) {
  const s = String(password ?? '');
  if (s.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(`パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください`);
  }
  if (s.length > 200) throw new AppError('パスワードが長すぎます');
  if (/^(.)\1+$/.test(s) || /^(0123456789|1234567890|abcdefghij)/i.test(s)) {
    throw new AppError('かんたんすぎるパスワードは使えません');
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readCookie(req, name) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function createAuth(db, { now = () => Date.now(), isHttps = () => false, clientIp = () => '' } = {}) {
  const failures = new Map();
  const sql = {
    getSecret: db.prepare('SELECT value FROM secrets WHERE key = ?'),
    setSecret: db.prepare(
      'INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, expires_at, created_at, ip) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    deleteAll: db.prepare('DELETE FROM sessions'),
  };

  function hasPassword() {
    return Boolean(sql.getSecret.get('adminPasswordHash'));
  }

  async function setPassword(password) {
    sql.setSecret.run('adminPasswordHash', await hashPassword(password));
  }

  function cookie(req, value, maxAgeSeconds) {
    const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (isHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }

  function startSession(req) {
    sql.deleteExpired.run(now());
    const token = randomBytes(32).toString('hex');
    sql.insertSession.run(sha256(token), now() + SESSION_MS, now(), clientIp(req));
    return cookie(req, token, SESSION_MS / 1000);
  }

  async function login(req, password) {
    const key = clientIp(req) || 'unknown';
    let entry = failures.get(key);
    if (entry && entry.lockedUntil > now()) {
      throw new AppError('ログインの失敗が続いたため、15分ほど待ってからお試しください', 429);
    }
    const stored = sql.getSecret.get('adminPasswordHash')?.value;
    if (!stored || !(await verifyPassword(password, stored))) {
      // ロックが明けたら数え直す
      if (!entry || entry.lockedUntil) entry = { count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= MAX_FAILURES) entry.lockedUntil = now() + LOCK_MS;
      failures.set(key, entry);
      if (failures.size > 5000) failures.clear();
      throw new AppError('パスワードが違います', 401, { audit: 'ログイン失敗' });
    }
    failures.delete(key);
    return startSession(req);
  }

  function isLoggedIn(req) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const row = sql.session.get(sha256(token));
    if (!row) return false;
    if (row.expires_at < now()) {
      sql.deleteSession.run(row.token_hash);
      return false;
    }
    return true;
  }

  function logout(req) {
    const token = readCookie(req, COOKIE_NAME);
    if (token) sql.deleteSession.run(sha256(token));
    return cookie(req, '', 0);
  }

  /** パスワードを変える。ほかの端末のログインはすべて切れる */
  async function changePassword(req, current, next) {
    const stored = sql.getSecret.get('adminPasswordHash')?.value;
    if (!(await verifyPassword(current, stored))) throw new AppError('いまのパスワードが違います', 400);
    checkPasswordStrength(next);
    if (current === next) throw new AppError('新しいパスワードは、いまと違うものにしてください');
    await setPassword(next);
    sql.deleteAll.run();
    return startSession(req);
  }

  return { hasPassword, setPassword, login, isLoggedIn, logout, changePassword };
}
