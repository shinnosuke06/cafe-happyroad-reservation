import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from './store.js';

const COOKIE_NAME = 'hr_session';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12時間
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000; // 5回まちがえたら15分ロック

function digest(value) {
  return createHash('sha256').update(String(value ?? '')).digest();
}

function readCookie(req, name) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

/** スタッフ用ログイン（パスワード1つ・セッションはメモリに保持） */
export function createAuth({ password, now = () => Date.now() }) {
  const expected = digest(password);
  const sessions = new Map();
  const failures = new Map();

  function login(req, given) {
    const key = req.socket.remoteAddress ?? 'unknown';
    let entry = failures.get(key);
    if (entry && entry.lockedUntil > now()) {
      throw new AppError('ログインの失敗が続いたため、15分ほど待ってからお試しください', 429);
    }
    if (!timingSafeEqual(digest(given), expected)) {
      // ロックが明けたら数え直す
      if (!entry || entry.lockedUntil) entry = { count: 0, lockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= MAX_FAILURES) entry.lockedUntil = now() + LOCK_MS;
      failures.set(key, entry);
      throw new AppError('パスワードが違います', 401);
    }
    failures.delete(key);

    for (const [token, expires] of sessions) if (expires < now()) sessions.delete(token);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now() + SESSION_MS);
    return sessionCookie(req, token, SESSION_MS / 1000);
  }

  function isLoggedIn(req) {
    const token = readCookie(req, COOKIE_NAME);
    const expires = token ? sessions.get(token) : undefined;
    if (!expires) return false;
    if (expires < now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function logout(req) {
    const token = readCookie(req, COOKIE_NAME);
    if (token) sessions.delete(token);
    return sessionCookie(req, '', 0);
  }

  function sessionCookie(req, value, maxAge) {
    const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
    if (isHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }

  return { login, logout, isLoggedIn };
}
