// Node.js でメールサーバーにつなぐソケット（SSL・STARTTLS・平文）
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';

function wrap(socket, host) {
  const queue = [];
  const waiters = [];
  let ended = false;
  const deliver = (chunk) => (waiters.length ? waiters.shift()(chunk) : queue.push(chunk));
  const finish = () => {
    ended = true;
    while (waiters.length) waiters.shift()(null);
  };
  const handlers = { data: deliver, end: finish, close: finish, error: finish };
  for (const [event, fn] of Object.entries(handlers)) socket.on(event, fn);

  return {
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    write(text) {
      return new Promise((resolve, reject) => socket.write(text, (err) => (err ? reject(err) : resolve())));
    },
    async startTls() {
      for (const [event, fn] of Object.entries(handlers)) socket.off(event, fn);
      const secured = tls.connect({ socket, servername: host });
      await once(secured, 'secureConnect');
      return wrap(secured, host);
    },
    async close() {
      socket.end();
    },
  };
}

export async function connectNodeSocket({ host, port, secure }) {
  const socket = secure === 'ssl' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  socket.on('error', () => {}); // エラーは読み取り側で「切れた」として扱う
  await once(socket, secure === 'ssl' ? 'secureConnect' : 'connect');
  return wrap(socket, host);
}
