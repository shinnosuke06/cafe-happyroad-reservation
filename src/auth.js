// スタッフのログイン。パスワードは PBKDF2（＋サーバーだけが知る「ペッパー」）でハッシュにして保存し、
// ログイン状態はデータベースに持つ。Node でも Cloudflare でも動く Web Crypto を使う。
import { AppError } from './validate.js';
import { randomBytes, randomHex, toHex } from './random.js';

const COOKIE_NAME = 'hr_session';
const SESSION_MS = 12 * 60 * 60 * 1000; // 12時間でログアウト
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000; // 5回まちがえたら15分ロック
const ITERATIONS = 20_000; // Cloudflare 無料プランの計算時間（1回10ミリ秒）に収まる回数
export const MIN_PASSWORD_LENGTH = 10;

const encoder = new TextEncoder();
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** ペッパーがあれば、先に HMAC をかける（データベースだけが漏れても解けないように） */
async function prepare(password, pepper) {
  const bytes = encoder.encode(String(password ?? ''));
  if (!pepper) return bytes;
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
}

async function derive(password, salt, iterations, pepper) {
  const key = await crypto.subtle.importKey('raw', await prepare(password, pepper), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password, pepper = '') {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, ITERATIONS, pepper);
  return ['pbkdf2-sha256', ITERATIONS, toBase64(salt), toBase64(hash)].join('$');
}

export async function verifyPassword(password, stored, pepper = '') {
  const [kind, iterations, saltB64, hashB64] = String(stored ?? '').split('$');
  if (kind !== 'pbkdf2-sha256') return false;
  const actual = await derive(password, fromBase64(saltB64), Number(iterations), pepper);
  return sameBytes(actual, fromBase64(hashB64));
}

export function checkPasswordStrength(password) {
  const s = String(password ?? '');
  if (s.length < MIN_PASSWORD_LENGTH) throw new AppError(`パスワードは${MIN_PASSWORD_LENGTH}文字以上にしてください`);
  if (s.length > 200) throw new AppError('パスワードが長すぎます');
  if (/^(.)\1+$/.test(s) || /^(0123456789|1234567890|abcdefghij)/i.test(s)) {
    throw new AppError('かんたんすぎるパスワードは使えません');
  }
}

async function sha256Hex(value) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function createAuth(db, { now = () => Date.now(), isHttps = () => false, clientIp = () => '', pepper = '' } = {}) {
  async function hasPassword() {
    return Boolean(await db.get("SELECT 1 AS found FROM secrets WHERE key = 'adminPasswordHash'"));
  }

  async function setPassword(password) {
    await db.run(
      "INSERT INTO secrets (key, value) VALUES ('adminPasswordHash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [await hashPassword(password, pepper)],
    );
  }

  function cookie(request, value, maxAgeSeconds) {
    const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (isHttps(request)) parts.push('Secure');
    return parts.join('; ');
  }

  async function startSession(request) {
    await db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
    const token = randomHex(32);
    await db.run('INSERT INTO sessions (token_hash, expires_at, created_at, ip) VALUES (?, ?, ?, ?)', [
      await sha256Hex(token),
      now() + SESSION_MS,
      now(),
      clientIp(request),
    ]);
    return cookie(request, token, SESSION_MS / 1000);
  }

  async function login(request, password) {
    const key = `login-fail:${clientIp(request) || 'unknown'}`;
    const failures = await db.get('SELECT window_start, count FROM rate_limits WHERE key = ?', [key]);
    const recent = failures && failures.window_start > now() - LOCK_MS;
    if (recent && failures.count >= MAX_FAILURES) {
      throw new AppError('ログインの失敗が続いたため、15分ほど待ってからお試しください', 429);
    }
    const stored = (await db.get("SELECT value FROM secrets WHERE key = 'adminPasswordHash'"))?.value;
    if (!stored || !(await verifyPassword(password, stored, pepper))) {
      await db.run(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END`,
        [key, now(), now() - LOCK_MS, now() - LOCK_MS],
      );
      throw new AppError('パスワードが違います', 401, { audit: 'ログイン失敗' });
    }
    await db.run('DELETE FROM rate_limits WHERE key = ?', [key]);
    return startSession(request);
  }

  async function isLoggedIn(request) {
    const token = readCookie(request, COOKIE_NAME);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    const row = await db.get('SELECT expires_at FROM sessions WHERE token_hash = ?', [await sha256Hex(token)]);
    return Boolean(row && row.expires_at >= now());
  }

  async function logout(request) {
    const token = readCookie(request, COOKIE_NAME);
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [await sha256Hex(token)]);
    return cookie(request, '', 0);
  }

  /** パスワードを変える。ほかの端末のログインはすべて切れる */
  async function changePassword(request, current, next) {
    const stored = (await db.get("SELECT value FROM secrets WHERE key = 'adminPasswordHash'"))?.value;
    if (!(await verifyPassword(current, stored, pepper))) throw new AppError('いまのパスワードが違います', 400);
    checkPasswordStrength(next);
    if (current === next) throw new AppError('新しいパスワードは、いまと違うものにしてください');
    await setPassword(next);
    await db.run('DELETE FROM sessions');
    return startSession(request);
  }

  return { hasPassword, setPassword, login, isLoggedIn, logout, changePassword };
}
