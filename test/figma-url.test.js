import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFigmaUrl, sanitizeSegment, urlForNode } from '../src/figma-url.js';

test('parses a design link with node-id and tracking params', () => {
  const file = parseFigmaUrl(
    'https://www.figma.com/design/AbCdEf1234567890GhIjKl/Sample-Design-Kit--Community-?node-id=12-345&p=f&t=aBcDeFgHiJkLmNoP-0',
  );
  assert.equal(file.fileKey, 'AbCdEf1234567890GhIjKl');
  assert.equal(file.nodeId, '12:345');
  assert.equal(file.slug, 'Sample-Design-Kit--Community-');
});

test('keeps the readable file name as the output folder', () => {
  const file = parseFigmaUrl(
    'https://www.figma.com/design/ZyXwVu0987654321TsRqPo/-Team--Sample-Project--Copy-?node-id=1234-5678&p=f',
  );
  assert.equal(file.fileKey, 'ZyXwVu0987654321TsRqPo');
  assert.equal(file.nodeId, '1234:5678');
  assert.equal(file.slug, '-Team--Sample-Project--Copy-');
});

test('only node-id is converted; the share token (which contains "-") is kept as is', () => {
  const link =
    'https://www.figma.com/design/ZyXwVu0987654321TsRqPo/-Team--Sample-Project--Copy-?node-id=1234-5678&t=qRsTuVwXyZaBcDeF-1';
  const file = parseFigmaUrl(link);
  assert.equal(file.fileKey, 'ZyXwVu0987654321TsRqPo');
  assert.equal(file.nodeId, '1234:5678');
  assert.equal(file.slug, '-Team--Sample-Project--Copy-');
  assert.equal(file.url, link);
  assert.equal(urlForNode(file.url, file.nodeId), link);
  assert.equal(new URL(urlForNode(file.url, '12:34')).searchParams.get('t'), 'qRsTuVwXyZaBcDeF-1');
});

test('file links without a node-id or name', () => {
  const file = parseFigmaUrl('https://figma.com/file/abc123');
  assert.equal(file.nodeId, null);
  assert.equal(file.slug, 'abc123');
});

test('branch links use the branch key', () => {
  const file = parseFigmaUrl('https://www.figma.com/design/MAIN123/branch/BR456/My-File?node-id=1-2');
  assert.equal(file.fileKey, 'BR456');
});

test('prototype links open in the editor', () => {
  const file = parseFigmaUrl('https://www.figma.com/proto/abc123/Flow?node-id=3-4&starting-point-node-id=3%3A4');
  assert.match(file.url, /^https:\/\/www\.figma\.com\/design\/abc123\/Flow\?/);
  assert.equal(file.nodeId, '3:4');
});

test('rejects non-Figma and FigJam links', () => {
  assert.throws(() => parseFigmaUrl('https://example.com/design/abc'), /figma\.com/);
  assert.throws(() => parseFigmaUrl('https://www.figma.com/board/abc/Board'), /Only Figma Design/);
  assert.throws(() => parseFigmaUrl('not a url'), /not a valid URL/);
});

test('urlForNode replaces the node-id and keeps other params', () => {
  const url = urlForNode('https://www.figma.com/design/abc/File?node-id=1-2&p=f', '1234:5678');
  assert.equal(url, 'https://www.figma.com/design/abc/File?node-id=1234-5678&p=f');
});

test('sanitizeSegment strips characters Windows rejects', () => {
  assert.equal(sanitizeSegment('a:b/c*d?.png'), 'a_b_c_d_.png');
  assert.equal(sanitizeSegment('..'), '');
});
