// 乱数（Node でも Cloudflare でも使える Web Crypto を使う）

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteLength) {
  return toHex(randomBytes(byteLength));
}

/** 0 以上 n 未満の整数（かたよりなし） */
export function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}
