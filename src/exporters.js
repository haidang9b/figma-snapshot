import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { sanitizeSegment } from './figma-url.js';
import { UiStepError } from './figma-ui.js';
import { log } from './log.js';

// Exports whatever is currently selected through the right sidebar's Export
// section: one export row per requested format, at the requested scale.
// Figma renders the export in the browser and triggers a normal download.
export async function exportSelection(ui, { formats, scale, outDir, timeoutMs }) {
  // With nothing selected, Figma's Export section exports the whole page as one image.
  if ((await ui.selectedLayers())?.length === 0) {
    throw new UiStepError('Nothing is selected, so there is nothing to export.');
  }
  let edits = 0;
  try {
    await ui.ensureExportSection();
    for (const format of formats) {
      await ui.addExportSetting();
      edits++;
      if (await ui.setFormat(format)) edits++;
      // Figma exports SVG and PDF as vectors at 1x; scale only applies to bitmaps.
      if ((format === 'png' || format === 'jpg') && (await ui.setScale(scale))) edits++;
    }
    const button = await ui.exportButton();
    log.info(`  Clicking "${(await button.innerText()).trim()}" (${formats.join(', ')} @ ${scale}x)`);
    const download = await waitForDownload(ui.page, () => button.click(), timeoutMs);
    return await saveDownload(download, outDir);
  } finally {
    await ui.undo(edits);
  }
}

// Exports every layer on the current page that the designer gave export
// settings, via File > Export… (Ctrl/Cmd+Shift+E). Never modifies the file.
export async function exportMarked(ui, { outDir, timeoutMs }) {
  const dialog = await ui.openExportDialog();
  if (!dialog) throw new UiStepError('The File > Export… dialog did not open (Ctrl/Cmd+Shift+E).');
  try {
    const button = await ui.exportDialogButton(dialog);
    if (!button || !(await button.isEnabled())) {
      log.info('  No layers on this page have export settings.');
      return [];
    }
    log.info(`  Clicking "${(await button.innerText()).trim()}" in the export dialog`);
    const download = await waitForDownload(ui.page, () => button.click(), timeoutMs);
    return await saveDownload(download, outDir);
  } finally {
    await ui.closeDialogs();
  }
}

async function waitForDownload(page, trigger, timeoutMs) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: timeoutMs }), trigger()]);
  return download;
}

// Saves a download; zips (multi-layer exports) are unpacked into outDir.
async function saveDownload(download, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const name = sanitizeSegment(download.suggestedFilename()) || 'export';
  if (!name.toLowerCase().endsWith('.zip')) {
    const target = path.join(outDir, name);
    await download.saveAs(target);
    return [target];
  }
  const zipPath = path.join(outDir, `.${Date.now()}-${name}`);
  await download.saveAs(zipPath);
  try {
    return extractZip(zipPath, outDir);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }
}

export function extractZip(zipPath, destDir) {
  const written = [];
  const used = new Set();
  for (const entry of new AdmZip(zipPath).getEntries()) {
    if (entry.isDirectory) continue;
    // Figma turns "/" in layer names into folders; keep that, but never let an
    // entry escape destDir.
    const parts = entry.entryName.split(/[\\/]+/).map(sanitizeSegment).filter(Boolean);
    if (!parts.length) continue;
    let target = path.join(destDir, ...parts);
    if (!path.resolve(target).startsWith(path.resolve(destDir) + path.sep)) continue;
    target = uniquePath(target, used);
    used.add(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
    written.push(target);
  }
  return written;
}

// Two layers with the same name produce the same file name; keep both.
function uniquePath(target, used) {
  if (!used.has(target)) return target;
  const { dir, name, ext } = path.parse(target);
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${name} (${n})${ext}`);
    if (!used.has(candidate)) return candidate;
  }
}
