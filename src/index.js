import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, openFigmaFile } from './browser.js';
import { ConfigError, loadConfig } from './config.js';
import { exportMarked, exportSelection } from './exporters.js';
import { FigmaUI } from './figma-ui.js';
import { currentNodeParam, sanitizeSegment, urlForNode } from './figma-url.js';
import { startImageCapture } from './image-capture.js';
import { log } from './log.js';

const MAX_PAGES = 200;

async function main() {
  const config = loadConfig();
  log.setVerbose(config.debug);
  // Each linked node (or page) of a file gets its own folder.
  const fileDir = path.join(config.outputDir, config.file.slug);
  const outDir =
    config.scope === 'selection' && config.nodeIds.length === 1
      ? path.join(fileDir, config.nodeIds[0].replaceAll(':', '-'))
      : fileDir;
  log.info(
    `Scope: ${config.scope} | assets: ${config.assets.join(', ')} | formats: ${config.formats.join(', ')} @ ${config.scale}x`,
  );
  log.info(`Output: ${outDir}`);

  const { context, page } = await launchBrowser(config);
  const ui = new FigmaUI(page, path.join(outDir, '_debug'));
  const report = new RunReport(config, outDir, ui);
  const capture = config.assets.includes('images') ? startImageCapture(context, path.join(outDir, 'images')) : null;

  try {
    if (config.scope === 'selection') await exportNodes(config, ui, report, outDir);
    else await exportPages(config, ui, report, outDir);
  } finally {
    if (capture) report.images = await capture.stop();
    report.write();
    await context.close().catch(() => {});
  }
  report.printSummary();
  return report.failures.length ? 1 : 0;
}

// SCOPE=selection: open each node link; Figma selects and zooms to that node.
async function exportNodes(config, ui, report, outDir) {
  for (const [index, nodeId] of config.nodeIds.entries()) {
    await openFigmaFile(ui.page, urlForNode(config.file.url, nodeId), config);
    await selectLinkedNode(ui, nodeId);
    // Zooming to the selection makes Figma load its images at full detail.
    if (config.assets.includes('images')) await ui.zoomTo('selection');

    if (config.assets.includes('frames')) {
      // With several nodes, give each its own folder so same-named layers don't collide.
      const framesDir =
        config.nodeIds.length > 1 ? path.join(outDir, 'frames', nodeId.replaceAll(':', '-')) : path.join(outDir, 'frames');
      await report.step(`Export node ${nodeId}`, 'frames', () =>
        exportSelection(ui, {
          formats: config.formats,
          scale: config.scale,
          outDir: framesDir,
          timeoutMs: config.exportTimeoutMs,
        }),
      );
    }
    if (config.assets.includes('marked') && index === 0) {
      await report.step('Export layers marked for export on this page', 'marked', () =>
        exportMarked(ui, { outDir: path.join(outDir, 'marked'), timeoutMs: config.exportTimeoutMs }),
      );
    }
  }
}

// A layer link opens with that layer selected. A page link (the URL in the
// address bar while a page is open) selects nothing; then export each
// top-level layer of that page as its own file.
async function selectLinkedNode(ui, nodeId) {
  await ui.expandUi();
  let selected = await ui.selectedLayers();
  if (selected?.length === 0) {
    log.info(`node-id ${nodeId} is a page: exporting each of its top-level layers as a separate file.`);
    await ui.selectAll();
    selected = await ui.selectedLayers();
  }
  if (selected === null) log.warn('The layers panel is not visible, so the selection cannot be confirmed.');
  else log.info(`Selected ${selected.length} layer(s): ${selected.join(', ') || '(none)'}`);
}

// SCOPE=page / SCOPE=file: export all top-level layers of the page(s).
async function exportPages(config, ui, report, outDir) {
  await openFigmaFile(ui.page, config.file.url, config);

  if (config.scope === 'file') {
    for (let i = 0; i < MAX_PAGES && (await ui.switchPage('previous')); i++);
  }

  const seen = new Set();
  for (let index = 0; index < MAX_PAGES; index++) {
    const pageId = currentNodeParam(ui.page.url()) ?? `page-${index + 1}`;
    if (seen.has(pageId)) break;
    seen.add(pageId);
    const pageDir = `${String(index + 1).padStart(2, '0')}_${sanitizeSegment(pageId.replaceAll(':', '-'))}`;
    log.info(`Page ${index + 1} (node-id ${pageId})`);

    if (config.assets.includes('images')) await ui.zoomTo('fit');
    if (config.assets.includes('frames')) {
      await report.step(`Export top-level layers on page ${index + 1}`, 'frames', async () => {
        await ui.selectAll();
        if ((await ui.selectedLayers())?.length === 0) {
          log.info('  The page is empty.');
          return [];
        }
        return exportSelection(ui, {
          formats: config.formats,
          scale: config.scale,
          outDir: path.join(outDir, 'frames', pageDir),
          timeoutMs: config.exportTimeoutMs,
        });
      });
    }
    if (config.assets.includes('marked')) {
      await report.step(`Export layers marked for export on page ${index + 1}`, 'marked', () =>
        exportMarked(ui, { outDir: path.join(outDir, 'marked', pageDir), timeoutMs: config.exportTimeoutMs }),
      );
    }

    if (config.scope !== 'file') break;
    if (!(await ui.switchPage('next'))) {
      if (index === 0) {
        log.warn(
          'Only one page was exported: Figma did not switch pages on Page Down. ' +
            'If the file has more pages, run once per page with that page open in FIGMA_URL and SCOPE=page.',
        );
      }
      break;
    }
  }
}

class RunReport {
  constructor(config, outDir, ui) {
    this.config = config;
    this.outDir = outDir;
    this.ui = ui;
    this.startedAt = new Date().toISOString();
    this.files = { frames: [], marked: [] };
    this.images = [];
    this.failures = [];
  }

  // Runs one export step. A failed step is recorded with a screenshot and UI
  // dump, and the run continues with the next step.
  async step(name, kind, fn) {
    log.info(`${name}...`);
    try {
      const files = await fn();
      this.files[kind].push(...files.map((f) => this.relative(f)));
      log.info(`  Saved ${files.length} file(s)`);
    } catch (err) {
      if (this.ui.page.isClosed()) throw err;
      const debug = await this.ui.dump(sanitizeSegment(name).replace(/\s+/g, '-')).catch(() => null);
      this.failures.push({ step: name, error: err.message, debug: debug && this.relative(debug) });
      log.error(`${name} failed: ${err.message.split('\n')[0]}`);
      if (debug) log.error(`  Screenshot and UI dump saved as ${debug}.*`);
    }
  }

  relative(file) {
    return path.relative(this.outDir, file).split(path.sep).join('/');
  }

  write() {
    fs.mkdirSync(this.outDir, { recursive: true });
    const manifest = {
      source: this.config.file.url,
      fileKey: this.config.file.fileKey,
      scope: this.config.scope,
      assets: this.config.assets,
      formats: this.config.formats,
      scale: this.config.scale,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      files: {
        ...this.files,
        images: this.images.map(({ file, ...rest }) => ({ file: this.relative(file), ...rest })),
      },
      failures: this.failures,
    };
    fs.writeFileSync(path.join(this.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  printSummary() {
    const counts = [
      ['frames', this.files.frames.length],
      ['marked', this.files.marked.length],
      ['images', this.images.length],
    ].filter(([kind]) => this.config.assets.includes(kind));
    log.info(`Done: ${counts.map(([k, n]) => `${n} ${k}`).join(', ')} -> ${this.outDir}`);
    if (this.failures.length) {
      log.warn(`${this.failures.length} step(s) failed. See manifest.json and the _debug folder; README.md explains how to fix it.`);
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log.error(err instanceof ConfigError ? err.message : (err.stack ?? err));
    process.exitCode = 1;
  });
