// お知らせの送信（メールは SMTP、LINE は Messaging API）。追加のライブラリは使わない。
// メールサーバーへのつなぎ方（ソケット）は、Node 用と Cloudflare 用を外から渡す。
import { randomHex } from './random.js';

const TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function withTimeout(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

// =========================================================
// メール（SMTP）
// =========================================================

/** ソケットから SMTP の応答を1つずつ読む */
class SmtpConnection {
  constructor(transport) {
    this.use(transport);
  }

  use(transport) {
    this.transport = transport;
    this.buffer = '';
    this.decoder = new TextDecoder();
  }

  async read() {
    const lines = [];
    for (;;) {
      let index;
      while ((index = this.buffer.indexOf('\r\n')) === -1) {
        const chunk = await withTimeout(this.transport.read(), 'メールサーバーの応答がありません');
        if (chunk == null) throw Object.assign(new Error('メールサーバーとの接続が切れました'), { closed: true });
        this.buffer += this.decoder.decode(chunk, { stream: true });
      }
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      lines.push(line);
      // "250-..." は続きあり、"250 ..." で1つの応答が終わる
      if (/^\d{3}(?: |$)/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
    }
  }

  async expect(codes) {
    const reply = await this.read();
    if (!codes.includes(reply.code)) throw new Error(`メールサーバーのエラー: ${reply.text.slice(0, 200)}`);
    return reply;
  }

  async command(line, codes) {
    await this.transport.write(`${line}\r\n`);
    return this.expect(codes);
  }
}

function encodeWord(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${toBase64(encoder.encode(value))}?=`;
}

/** "お店の名前 <shop@example.com>" を名前とアドレスに分ける */
export function parseAddress(value) {
  const match = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value ?? '');
  if (match) return { name: match[1].replace(/^"|"$/g, ''), address: match[2] };
  return { name: '', address: String(value ?? '').trim() };
}

export function buildMessage({ from, to, subject, text, date = new Date() }) {
  // ヘッダーに改行が入らないようにする（ヘッダーの差し込みを防ぐ）
  const oneLine = (value) => String(value).replace(/[\r\n]+/g, ' ');
  const sender = parseAddress(oneLine(from));
  const domain = sender.address.split('@')[1] || 'localhost';
  const body = toBase64(encoder.encode(text.replace(/\r?\n/g, '\r\n'))).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${sender.name ? `${encodeWord(sender.name)} ` : ''}<${sender.address}>`,
    `To: <${oneLine(to)}>`,
    `Subject: ${encodeWord(oneLine(subject))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomHex(12)}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

async function openSmtp(config, connectSocket) {
  const transport = await withTimeout(
    connectSocket({ host: config.host, port: config.port, secure: config.secure }),
    'メールサーバーに接続できません',
  );
  const conn = new SmtpConnection(transport);
  await conn.expect([220]);
  const helo = `EHLO ${config.heloName || 'localhost'}`;
  await conn.command(helo, [250]);
  if (config.secure === 'starttls') {
    await conn.command('STARTTLS', [220]);
    conn.use(await conn.transport.startTls());
    await conn.command(helo, [250]);
  }
  if (config.user) {
    await conn.command(`AUTH PLAIN ${toBase64(encoder.encode(`\0${config.user}\0${config.pass ?? ''}`))}`, [235]);
  }
  return conn;
}

/** まとめて送る。1通ずつ結果（ok / error）を返す */
export async function sendMailBatch(config, messages, connectSocket) {
  const results = messages.map(() => ({ ok: false, error: '' }));
  let conn;
  try {
    conn = await openSmtp(config, connectSocket);
  } catch (err) {
    for (const r of results) r.error = err.message;
    return results;
  }
  const from = parseAddress(config.from).address;
  for (const [i, message] of messages.entries()) {
    try {
      await conn.command(`MAIL FROM:<${from}>`, [250]);
      await conn.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await conn.command('DATA', [354]);
      await conn.transport.write(`${buildMessage({ ...message, from: config.from })}\r\n.\r\n`);
      await conn.expect([250]);
      results[i].ok = true;
    } catch (err) {
      results[i].error = err.message;
      if (err.closed) {
        for (const r of results.slice(i + 1)) r.error = err.message;
        return results;
      }
      await conn.command('RSET', [250]).catch(() => {});
    }
  }
  await conn.command('QUIT', [221]).catch(() => {});
  await conn.transport.close();
  return results;
}

// =========================================================
// LINE（Messaging API）
// =========================================================

export async function verifyLineSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string') return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody)));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function linePost(fetchImpl, token, path, body) {
  const res = await fetchImpl(`https://api.line.me${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LINEの送信エラー（${res.status}）${detail.slice(0, 200)}`);
  }
}

// =========================================================
// まとめ
// =========================================================

export function createNotifier(env = {}, { fetchImpl = globalThis.fetch, connectSocket = null } = {}) {
  const port = Number(env.SMTP_PORT) || 465;
  const smtp =
    env.SMTP_HOST && connectSocket
      ? {
          host: env.SMTP_HOST,
          port,
          secure: env.SMTP_SECURE || (port === 465 ? 'ssl' : 'starttls'),
          user: env.SMTP_USER || '',
          pass: env.SMTP_PASS || '',
          from: env.MAIL_FROM || env.SMTP_USER || '',
          heloName: env.SMTP_HELO || 'localhost',
        }
      : null;
  const line = env.LINE_CHANNEL_ACCESS_TOKEN
    ? { token: env.LINE_CHANNEL_ACCESS_TOKEN, secret: env.LINE_CHANNEL_SECRET || '' }
    : null;

  return {
    status() {
      return { email: Boolean(smtp && smtp.from), line: Boolean(line), lineWebhook: Boolean(line && line.secret) };
    },

    /** messages: [{ to, subject, text }] */
    async sendEmails(messages) {
      if (!smtp || !smtp.from) return messages.map(() => ({ ok: false, error: 'メールの送信設定がありません' }));
      return sendMailBatch(smtp, messages, connectSocket);
    },

    /** 同じ文面を複数の LINE ユーザーへ（500人ずつ） */
    async sendLine(userIds, text) {
      if (!line) return userIds.map(() => ({ ok: false, error: 'LINEの送信設定がありません' }));
      const results = [];
      for (let i = 0; i < userIds.length; i += 500) {
        const chunk = userIds.slice(i, i + 500);
        try {
          await linePost(fetchImpl, line.token, '/v2/bot/message/multicast', {
            to: chunk,
            messages: [{ type: 'text', text: text.slice(0, 5000) }],
          });
          results.push(...chunk.map(() => ({ ok: true, error: '' })));
        } catch (err) {
          results.push(...chunk.map(() => ({ ok: false, error: err.message })));
        }
      }
      return results;
    },

    async replyLine(replyToken, text) {
      if (!line) return;
      await linePost(fetchImpl, line.token, '/v2/bot/message/reply', {
        replyToken,
        messages: [{ type: 'text', text: text.slice(0, 5000) }],
      });
    },

    async verifyLineSignature(rawBody, signature) {
      return verifyLineSignature(rawBody, signature, line?.secret);
    },
  };
}
