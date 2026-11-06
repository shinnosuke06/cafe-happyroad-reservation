// メニュー写真の保存。中身を確かめて、JPEG・PNG・WebP だけを受け付ける。
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const NAME_PATTERN = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

export const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** ファイルの先頭のバイトから画像の種類を判定する（拡張子や Content-Type は信用しない） */
export function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function isUploadName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

export async function saveImage(dir, buf) {
  const ext = detectImage(buf);
  if (!ext) return null;
  await mkdir(dir, { recursive: true });
  const name = `${randomBytes(16).toString('hex')}.${ext}`;
  await writeFile(join(dir, name), buf, { flag: 'wx' });
  return name;
}

export async function removeImage(dir, name) {
  if (!isUploadName(name)) return;
  try {
    await unlink(join(dir, name));
  } catch {
    /* もう無ければ何もしない */
  }
}
