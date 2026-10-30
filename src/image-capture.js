import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

// Image fills (photos, illustrations) are downloaded by the Figma editor as
// the original uploaded files. Recording those responses gives the source
// images at full resolution, independent of the export scale.

const MIN_BYTES = 2048;
const MIN_DIMENSION = 32;
const STOP_TIMEOUT_MS = 15_000;
// Figma's own interface images: icons, avatars, fonts, emoji, thumbnails.
const IGNORE_URL = /static\.figma\.com|\/(avatars?|profile|favicon|fonts?|emoji|icons?)\b|gravatar|googleusercontent/i;
// Responses that are certainly not images; streaming ones may never finish.
const IGNORE_TYPE = /^(text\/|application\/(json|(x-)?javascript|wasm|xml))|event-stream|multipart/i;

export function startImageCapture(context, outDir) {
  const saved = new Map();
  const pending = new Set();

  const onResponse = (response) => {
    const job = handle(response).catch((err) => log.debug(`image capture skipped ${response.url()}: ${err.message}`));
    pending.add(job);
    job.finally(() => pending.delete(job));
  };

  async function handle(response) {
    const url = response.url();
    if (!/^https?:/.test(url) || IGNORE_URL.test(url) || response.status() !== 200) return;
    if (!['image', 'fetch', 'xhr', 'other'].includes(response.request().resourceType())) return;
    if (IGNORE_TYPE.test(response.headers()['content-type'] || '')) return;
    const body = await response.body();
    if (body.length < MIN_BYTES) return;
    const info = sniffImage(body);
    if (!info || Math.max(info.width, info.height) < MIN_DIMENSION) return;

    const hash = crypto.createHash('sha1').update(body).digest('hex');
    if (saved.has(hash)) return;
    const file = path.join(outDir, `${hash.slice(0, 16)}_${info.width}x${info.height}.${info.ext}`);
    saved.set(hash, { file, url: url.split('?')[0], bytes: body.length, ...info });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, body);
    log.debug(`Captured image ${path.basename(file)}`);
  }

  context.on('response', onResponse);
  return {
    count: () => saved.size,
    async stop() {
      context.off('response', onResponse);
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref()),
      ]);
      return [...saved.values()];
    },
  };
}

// Identifies PNG/JPEG/GIF/WebP data and reads its pixel size from the header.
export function sniffImage(buf) {
  if (buf.length < 30) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
  if (buf.toString('ascii', 0, 4) === 'GIF8') {
    return { ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { ext: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    // SOF0–SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}
