import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { sendMailBatch, buildMessage, parseAddress, verifyLineSignature, createNotifier } from '../src/notify.js';
import { connectNodeSocket } from '../src/adapters/node-socket.js';

/** テスト用の小さなメールサーバー。受け取った内容を記録する */
function fakeSmtpServer({ rejectRecipient } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = {};
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(current);
            current = {};
            socket.write('250 queued\r\n');
          } else {
            current.data = (current.data ?? '') + line + '\r\n';
          }
          continue;
        }
        if (line.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH PLAIN ')) {
          current.auth = Buffer.from(line.slice(11), 'base64').toString('utf8');
          socket.write('235 ok\r\n');
        } else if (line.startsWith('MAIL FROM:')) {
          current.from = line;
          socket.write('250 ok\r\n');
        } else if (line.startsWith('RCPT TO:')) {
          if (rejectRecipient && line.includes(rejectRecipient)) socket.write('550 no such user\r\n');
          else {
            current.to = line;
            socket.write('250 ok\r\n');
          }
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (line === 'RSET') {
          current = {};
          socket.write('250 ok\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('500 ?\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

test('メールの本文と件名は UTF-8 で、ヘッダーに改行を入れられない', () => {
  const msg = buildMessage({
    from: 'cafe ハッピーロード <shop@example.com>',
    to: 'guest@example.com\r\nBcc: evil@example.com',
    subject: 'お知らせ\r\nBcc: evil@example.com',
    text: '本日は\n臨時休業です',
  });
  const headers = msg.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/m.test(headers));
  assert.match(headers, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(headers, /^From: =\?UTF-8\?B\?.+\?= <shop@example\.com>$/m);
  const body = Buffer.from(msg.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(body, '本日は\r\n臨時休業です');
  assert.deepEqual(parseAddress('shop@example.com'), { name: '', address: 'shop@example.com' });
});

test('SMTP でまとめて送り、届かない宛先だけ失敗になる', async () => {
  const { server, received, port } = await fakeSmtpServer({ rejectRecipient: 'nobody@' });
  const results = await sendMailBatch(
    { host: '127.0.0.1', port, secure: 'none', user: 'shop', pass: 'secret', from: 'お店 <shop@example.com>' },
    [
      { to: 'a@example.com', subject: '件名A', text: '本文A' },
      { to: 'nobody@example.com', subject: '件名B', text: '本文B' },
      { to: 'c@example.com', subject: '件名C', text: '本文C' },
    ],
    connectNodeSocket,
  );
  server.close();
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.match(results[1].error, /550/);
  assert.equal(received.length, 2);
  assert.equal(received[0].auth, '\0shop\0secret');
  assert.equal(received[0].from, 'MAIL FROM:<shop@example.com>');
  assert.equal(received[1].to, 'RCPT TO:<c@example.com>');
});

test('メールサーバーにつながらないときは全部失敗として返す', async () => {
  const results = await sendMailBatch(
    { host: '127.0.0.1', port: 1, secure: 'none', from: 'a@example.com' },
    [{ to: 'x@example.com', subject: 's', text: 't' }],
    connectNodeSocket,
  );
  assert.equal(results[0].ok, false);
});

test('LINE の署名を確かめる', async () => {
  const body = new TextEncoder().encode('{"events":[]}');
  const good = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(await verifyLineSignature(body, good, 'secret'), true);
  assert.equal(await verifyLineSignature(body, good, 'other'), false);
  assert.equal(await verifyLineSignature(body, undefined, 'secret'), false);
});

test('LINE は 500人ずつまとめて送る', async () => {
  const calls = [];
  const notifier = createNotifier(
    { LINE_CHANNEL_ACCESS_TOKEN: 'token' },
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
        return new Response('{}', { status: 200 });
      },
    },
  );
  const ids = Array.from({ length: 1200 }, (_, i) => `U${String(i).padStart(32, '0')}`);
  const results = await notifier.sendLine(ids, 'お知らせ');
  assert.equal(results.length, 1200);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(calls.map((c) => c.body.to.length), [500, 500, 200]);
  assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/multicast');
  assert.equal(calls[0].auth, 'Bearer token');
  assert.deepEqual(createNotifier({}).status(), { email: false, line: false, lineWebhook: false });
  // メールはソケットのつなぎ方を渡したときだけ使える
  assert.equal(createNotifier({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@example.com' }).status().email, false);
  assert.equal(createNotifier({ SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'a@example.com' }, { connectSocket: connectNodeSocket }).status().email, true);
});
