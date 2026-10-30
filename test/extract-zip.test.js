import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { extractZip } from '../src/exporters.js';

test('extracts Figma zips safely, keeping folders and duplicate names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-zip-'));
  const out = path.join(dir, 'out');
  const zipPath = path.join(dir, 'export.zip');

  const zip = new AdmZip();
  zip.addFile('Icons/Arrow.svg', Buffer.from('<svg/>'));
  zip.addFile('Home:Screen.png', Buffer.from('a'));
  zip.addFile('Home_Screen.png', Buffer.from('b'));
  zip.addFile('../../escape.png', Buffer.from('c'));
  zip.writeZip(zipPath);

  const files = extractZip(zipPath, out).map((f) => path.relative(out, f).split(path.sep).join('/'));
  assert.deepEqual(files.sort(), ['Home_Screen (2).png', 'Home_Screen.png', 'Icons/Arrow.svg', 'escape.png']);
  assert.equal(fs.existsSync(path.join(dir, 'escape.png')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
