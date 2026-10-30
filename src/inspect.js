import path from 'node:path';
import { launchBrowser, openFigmaFile } from './browser.js';
import { ConfigError, loadConfig } from './config.js';
import { FigmaUI } from './figma-ui.js';
import { log } from './log.js';

// Opens FIGMA_URL, walks through the export UI without downloading anything and
// saves screenshots + UI dumps of each state into output/_inspect. Use it to
// check (or fix) the locators in src/figma-ui.js against your Figma.

async function main() {
  const config = loadConfig();
  log.setVerbose(true);
  const dir = path.join(config.outputDir, '_inspect');
  const { context, page } = await launchBrowser(config);
  const ui = new FigmaUI(page, dir);
  const saved = async (label) => log.info(`Saved ${await ui.dump(label)}.*`);

  try {
    await openFigmaFile(page, config.file.url, config);
    await saved('1-loaded');
    await ui.expandUi();
    let selected = await ui.selectedLayers();
    if (!selected?.length) {
      await ui.selectAll();
      selected = await ui.selectedLayers();
      await saved('2-selected-all');
    }
    log.info(selected === null ? 'MISS layers panel (selection unknown)' : `OK   selected: ${selected.join(', ')}`);

    try {
      await ui.ensureExportSection();
      log.info('OK   Export section (+ button) found');
      await ui.addExportSetting();
      try {
        log.info(`${(await ui.formatControls()).length ? 'OK  ' : 'MISS'} format dropdown`);
        log.info(`${(await ui.scaleInputs()).length ? 'OK  ' : 'MISS'} scale field`);
        const button = await ui.exportButton().catch(() => null);
        log.info(button ? `OK   export button: "${(await button.innerText()).trim()}"` : 'MISS export button');
        await saved('3-export-row-added');
      } finally {
        await ui.undo(1);
      }
    } catch (err) {
      log.warn(`MISS ${err.message}`);
      await saved('3-export-section-missing');
    }

    const dialog = await ui.openExportDialog();
    log.info(dialog ? 'OK   File > Export... dialog opened' : 'MISS File > Export... dialog');
    await saved('4-export-dialog');
    await ui.closeDialogs();
  } finally {
    await context.close().catch(() => {});
  }
  log.info(`Inspection files are in ${dir}`);
}

main().catch((err) => {
  log.error(err instanceof ConfigError ? err.message : (err.stack ?? err));
  process.exitCode = 1;
});
