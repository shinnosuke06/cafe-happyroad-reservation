// お知らせの送信（メールは SMTP、LINE は Messaging API）。追加のライブラリは使わない。
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TIMEOUT_MS = 20_000;

// =========================================================
// メール（SMTP）
// =========================================================

class SmtpConnection {
  constructor(socket) {
    this.lines = [];
    this.waiters = [];
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('メールサーバーの応答がありません')));
    this.onData = (chunk) => {
      this.buffer += chunk;
      this.flush();
    };
    this.onError = (err) => this.fail(err);
    this.onClose = () => this.fail(new Error('メールサーバーとの接続が切れました'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    this.socket.setTimeout(0);
    return this.socket;
  }

  fail(err) {
    for (const w of this.waiters.splice(0)) w.reject(err);
    this.closed = err;
  }

  flush() {
    let index;
    while (this.waiters.length > 0 && (index = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      // "250-..." は続きあり、"250 ..." で1つの応答が終わる
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') };
        this.lines = [];
        this.waiters.shift().resolve(reply);
      }
    }
  }

  read() {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.flush();
    });
  }

  async expect(codes) {
    const reply = await this.read();
    if (!codes.includes(reply.code)) throw new Error(`メールサーバーのエラー: ${reply.text.slice(0, 200)}`);
    return reply;
  }

  async command(line, codes) {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes);
  }
}

function encodeWord(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
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
  to = oneLine(to);
  subject = oneLine(subject);
  const sender = parseAddress(oneLine(from));
  const domain = sender.address.split('@')[1] || 'localhost';
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${sender.name ? `${encodeWord(sender.name)} ` : ''}<${sender.address}>`,
    `To: <${to}>`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

async function openSmtp(config) {
  const { host, port, secure } = config;
  const socket =
    secure === 'ssl' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('メールサーバーに接続できません')));
  await once(socket, secure === 'ssl' ? 'secureConnect' : 'connect');
  const conn = new SmtpConnection(socket);
  await conn.expect([220]);
  const helo = `EHLO ${config.heloName || 'localhost'}`;
  await conn.command(helo, [250]);
  if (secure === 'starttls') {
    await conn.command('STARTTLS', [220]);
    const plain = conn.detach();
    const secured = tls.connect({ socket: plain, servername: host });
    await once(secured, 'secureConnect');
    conn.attach(secured);
    await conn.command(helo, [250]);
  }
  if (config.user) {
    const token = Buffer.from(`\0${config.user}\0${config.pass ?? ''}`, 'utf8').toString('base64');
    await conn.command(`AUTH PLAIN ${token}`, [235]);
  }
  return conn;
}

/** まとめて送る。1通ずつ結果（ok / error）を返す */
export async function sendMailBatch(config, messages) {
  const results = messages.map(() => ({ ok: false, error: '' }));
  let conn;
  try {
    conn = await openSmtp(config);
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
      conn.socket.write(`${buildMessage({ ...message, from: config.from })}\r\n.\r\n`);
      await conn.expect([250]);
      results[i].ok = true;
    } catch (err) {
      results[i].error = err.message;
      if (conn.closed) {
        for (const r of results.slice(i + 1)) r.error = err.message;
        return results;
      }
      await conn.command('RSET', [250]).catch(() => {});
    }
  }
  await conn.command('QUIT', [221]).catch(() => {});
  conn.socket.end();
  return results;
}

// =========================================================
// LINE（Messaging API）
// =========================================================

export function verifyLineSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
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

export function createNotifier(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const port = Number(env.SMTP_PORT) || 465;
  const smtp = env.SMTP_HOST
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
      return {
        email: Boolean(smtp && smtp.from),
        line: Boolean(line),
        lineWebhook: Boolean(line && line.secret),
      };
    },

    /** messages: [{ to, subject, text }] */
    async sendEmails(messages) {
      if (!smtp || !smtp.from) return messages.map(() => ({ ok: false, error: 'メールの送信設定がありません' }));
      return sendMailBatch(smtp, messages);
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

    verifyLineSignature(rawBody, signature) {
      return verifyLineSignature(rawBody, signature, line?.secret);
    },
  };
}
