import fs from 'node:fs';
import path from 'node:path';
import { waitForNetworkQuiet } from './browser.js';
import { log } from './log.js';

// Every interaction with Figma's interface lives in this file. Figma ships UI
// changes often; if an export step breaks, run `npm run inspect` and adjust the
// locators below using the files it writes.

const SCALE_VALUE = /^\d+(\.\d+)?x$|^\d+(w|h)$/i; // "1x", "2.5x", "512w", "300h"
const FORMAT_LABEL = /^(PNG|JPG|SVG|PDF)$/;
const EXPORT_ACTION = /^Export(?!\s+settings)\s+\S/i; // "Export Frame 1", "Export 12 layers"

const KEYS = {
  selectAll: 'ControlOrMeta+KeyA',
  undo: 'ControlOrMeta+KeyZ',
  exportDialog: 'ControlOrMeta+Shift+KeyE',
  zoomToFit: 'Shift+Digit1',
  zoomToSelection: 'Shift+Digit2',
  previousPage: 'PageUp',
  nextPage: 'PageDown',
};

export class UiStepError extends Error {}

export class FigmaUI {
  constructor(page, debugDir) {
    this.page = page;
    this.debugDir = debugDir;
  }

  // ---- canvas shortcuts -------------------------------------------------

  // Keyboard shortcuts only reach the canvas when no text field has focus.
  async blur() {
    await this.page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
  }

  async shortcut(name) {
    await this.blur();
    await this.page.keyboard.press(KEYS[name]);
  }

  async selectAll() {
    await this.page.keyboard.press('Escape');
    await this.shortcut('selectAll');
    await this.page.waitForTimeout(500);
  }

  // Names of the selected layers, read from the layers panel, whose rows carry
  // aria-selected. Returns null when the layers panel is not on screen, since
  // then the selection cannot be read.
  async selectedLayers() {
    const rows = this.page.locator('[role=treegrid] [role=row]');
    if (!(await rows.count())) return null;
    return rows.evaluateAll((els) =>
      els
        .filter((row) => row.getAttribute('aria-selected') === 'true')
        .map((row) => row.getAttribute('aria-label') || row.innerText.trim()),
    );
  }

  async zoomTo(target) {
    await this.shortcut(target === 'selection' ? 'zoomToSelection' : 'zoomToFit');
    await waitForNetworkQuiet(this.page, { quietMs: 1500, maxMs: 20_000 });
  }

  // Figma switches pages with Page Up / Page Down and updates node-id in the URL.
  // Returns false when the URL did not change (first/last page reached).
  async switchPage(direction) {
    const before = this.page.url();
    await this.shortcut(direction === 'previous' ? 'previousPage' : 'nextPage');
    const changed = await this.page
      .waitForURL((url) => url.toString() !== before, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (changed) await waitForNetworkQuiet(this.page, { quietMs: 1500, maxMs: 30_000 });
    return changed;
  }

  // Revert our temporary export settings so files you can edit are left untouched.
  // A freshly opened file has an empty undo stack, so only our own edits are undone.
  async undo(times) {
    if (!times) return;
    await this.page.keyboard.press('Escape');
    await this.blur();
    for (let i = 0; i < times; i++) {
      await this.page.keyboard.press(KEYS.undo);
      await this.page.waitForTimeout(150);
    }
    log.debug(`Undid ${times} temporary export-setting change(s)`);
  }

  // ---- "Export" section of the right sidebar -----------------------------

  addExportButton() {
    return this.page
      .getByRole('button', { name: /add export/i })
      .or(this.page.locator('[aria-label*="export" i][aria-label*="add" i]'))
      .or(this.page.locator('[data-tooltip*="export" i][data-tooltip*="add" i]'));
  }

  // Figma can show a minimized interface without the right sidebar. Its
  // "Expand UI" toggle wraps the file-name button, so click the toggle's icon.
  async expandUi() {
    const toggle = await firstVisible(this.page.getByRole('button', { name: /^expand ui/i }));
    if (!toggle) return false;
    log.info('  Expanding the minimized Figma interface');
    const icon = await firstVisible(toggle.getByRole('img'));
    await (icon ?? toggle).click();
    await this.page.waitForTimeout(800);
    return true;
  }

  async ensureExportSection() {
    if (await firstVisible(this.addExportButton())) return;
    if ((await this.expandUi()) && (await firstVisible(this.addExportButton()))) return;
    // Editors may be on the Prototype tab; viewers may have separate tabs.
    for (const name of ['Design', 'Export', 'Properties']) {
      const tab = await firstVisible(this.page.getByRole('tab', { name, exact: true }));
      if (!tab) continue;
      await tab.click();
      await this.page.waitForTimeout(400);
      if (await firstVisible(this.addExportButton())) return;
    }
    throw new UiStepError(
      'Could not find the "Export" section (+ button) in the right sidebar. ' +
        'The file owner may have disabled exporting for viewers, or Figma changed its UI.',
    );
  }

  async addExportSetting() {
    const button = await firstVisible(this.addExportButton());
    if (!button) throw new UiStepError('The "add export settings" (+) button is not visible.');
    const rowsBefore = (await this.formatControls()).length;
    await button.click();
    await waitUntil(this.page, async () => (await this.formatControls()).length > rowsBefore, 5000);
  }

  // Format dropdowns show their current value ("PNG", "SVG", ...). The newest
  // export row is the last one in document order.
  async formatControls() {
    return visibleOnly(this.page.getByText(FORMAT_LABEL));
  }

  async setFormat(format) {
    const label = format.toUpperCase();
    const controls = await this.formatControls();
    const control = controls.at(-1);
    if (!control) throw new UiStepError('No export format dropdown found after adding an export row.');
    if ((await control.innerText()).trim() === label) return false;

    await control.click();
    const option = await waitForVisible(
      this.page
        .getByRole('option', { name: label, exact: true })
        .or(this.page.getByRole('menuitem', { name: label, exact: true }))
        .or(this.page.getByRole('menuitemradio', { name: label, exact: true }))
        .or(this.page.getByRole('menuitemcheckbox', { name: label, exact: true })),
      3000,
    );
    if (!option) {
      await this.page.keyboard.press('Escape');
      throw new UiStepError(`The format menu opened but has no "${label}" option.`);
    }
    await option.click();
    await this.page.waitForTimeout(300);
    return true;
  }

  async scaleInputs() {
    const inputs = this.page.locator('input');
    const indexes = await inputs.evaluateAll(
      (els, pattern) =>
        els
          .map((el, i) => ({ i, value: el.value, visible: !!(el.offsetWidth || el.offsetHeight) }))
          .filter((x) => x.visible && new RegExp(pattern, 'i').test(x.value.trim()))
          .map((x) => x.i),
      SCALE_VALUE.source,
    );
    return indexes.map((i) => inputs.nth(i));
  }

  async setScale(scale) {
    const input = (await this.scaleInputs()).at(-1);
    if (!input) throw new UiStepError('No export scale field (e.g. "1x") found.');
    const wanted = `${scale}x`;
    if ((await input.inputValue()).trim() === wanted) return false;
    await input.click();
    await input.fill(wanted);
    await input.press('Enter');
    await this.page.waitForTimeout(300);
    const actual = (await input.inputValue()).trim();
    if (actual !== wanted) log.warn(`Export scale field shows "${actual}" after typing "${wanted}".`);
    return true;
  }

  async exportButton() {
    const button = await firstVisible(
      this.page.getByRole('button').filter({ hasText: EXPORT_ACTION }),
      this.page.getByText(EXPORT_ACTION),
    );
    if (!button) throw new UiStepError('Could not find the "Export …" button in the right sidebar.');
    return button;
  }

  // ---- File > Export… dialog (layers the designer marked for export) -----

  async openExportDialog() {
    await this.shortcut('exportDialog');
    return waitForVisible(this.page.getByRole('dialog'), 5000);
  }

  async exportDialogButton(dialog) {
    return (
      (await firstVisible(dialog.getByRole('button').filter({ hasText: /^Export\b/i }))) ??
      (await firstVisible(dialog.getByText(/^Export\b/i)))
    );
  }

  async closeDialogs() {
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(300);
  }

  // ---- diagnostics -------------------------------------------------------

  // Saves a screenshot, the accessibility tree and a list of export-related
  // elements, so broken locators can be fixed without guessing.
  async dump(label) {
    fs.mkdirSync(this.debugDir, { recursive: true });
    const base = path.join(this.debugDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
    await this.page.screenshot({ path: `${base}.png` }).catch(() => {});
    const aria = await this.page
      .locator('body')
      .ariaSnapshot({ timeout: 15_000 })
      .catch((err) => `ariaSnapshot failed: ${err.message}`);
    fs.writeFileSync(`${base}.aria.yml`, aria);
    const elements = await describeExportElements(this.page).catch((err) => [{ error: err.message }]);
    fs.writeFileSync(`${base}.elements.json`, JSON.stringify(elements, null, 2));
    return base;
  }
}

function describeExportElements(page) {
  return page.evaluate(() => {
    const interesting = /export|png|jpe?g|svg|pdf|^\d+(\.\d+)?x$|^\d+[wh]$/i;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!(el.offsetWidth || el.offsetHeight)) continue;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ');
      const attrs = ['aria-label', 'title', 'data-tooltip', 'data-testid', 'placeholder']
        .map((a) => el.getAttribute(a))
        .filter(Boolean);
      const value = el.value ?? '';
      if (![own, value, ...attrs].some((s) => s && interesting.test(String(s).trim()))) continue;
      const r = el.getBoundingClientRect();
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        tooltip: el.getAttribute('data-tooltip'),
        testId: el.getAttribute('data-testid'),
        text: own.slice(0, 80),
        value: String(value).slice(0, 80),
        className: String(el.className).slice(0, 120),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      });
    }
    return out;
  });
}

// ---- small locator helpers ------------------------------------------------

async function visibleOnly(locator) {
  const all = await locator.all();
  const visible = [];
  for (const item of all) if (await item.isVisible().catch(() => false)) visible.push(item);
  return visible;
}

async function firstVisible(...locators) {
  for (const locator of locators) {
    const [first] = await visibleOnly(locator);
    if (first) return first;
  }
  return null;
}

async function waitForVisible(locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = await firstVisible(locator);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  return null;
}

async function waitUntil(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await page.waitForTimeout(200);
  }
  return false;
}
