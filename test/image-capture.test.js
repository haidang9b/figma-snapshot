import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sniffImage } from '../src/image-capture.js';

const pad = (buf) => Buffer.concat([buf, Buffer.alloc(64)]);

test('reads PNG size', () => {
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(sniffImage(png), { ext: 'png', width: 1200, height: 800 });
});

test('reads JPEG size from the SOF marker after other segments', () => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x07, 0x80, 0x03]); // 800 x 1920
  const jpeg = pad(Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]));
  assert.deepEqual(sniffImage(jpeg), { ext: 'jpg', width: 1920, height: 800 });
});

test('reads GIF size', () => {
  const gif = pad(Buffer.from('GIF89a'));
  gif.writeUInt16LE(640, 6);
  gif.writeUInt16LE(480, 8);
  assert.deepEqual(sniffImage(gif), { ext: 'gif', width: 640, height: 480 });
});

test('reads WebP VP8X size', () => {
  const webp = pad(Buffer.from('RIFF\0\0\0\0WEBPVP8X'));
  webp.writeUIntLE(2999, 24, 3);
  webp.writeUIntLE(1999, 27, 3);
  assert.deepEqual(sniffImage(webp), { ext: 'webp', width: 3000, height: 2000 });
});

test('ignores non-image data', () => {
  assert.equal(sniffImage(Buffer.from('{"json": true, "padding": "............"}')), null);
  assert.equal(sniffImage(Buffer.alloc(10)), null);
});
