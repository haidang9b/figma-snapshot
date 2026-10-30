import { chromium } from 'playwright';
import { log } from './log.js';

const VIEWPORT = { width: 1680, height: 1050 };
const LOGIN_URL = 'https://www.figma.com/login';

// A persistent profile keeps the Figma login between runs, so you only log in once.
export async function launchBrowser(config) {
  let context;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      channel: config.browserChannel,
      headless: config.headless,
      viewport: VIEWPORT,
      acceptDownloads: true,
    });
  } catch (err) {
    if (/ProcessSingleton|user data directory is already in use|lock/i.test(err.message)) {
      throw new Error(`The browser profile at ${config.profileDir} is in use. Close other runs of this tool and try again.`);
    }
    throw err;
  }
  context.setDefaultTimeout(30_000);
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// Opens a Figma file and waits until the editor canvas has loaded. If Figma asks
// you to log in, waits (in the visible browser window) for you to do so.
export async function openFigmaFile(page, url, config) {
  log.info(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  const loaded = await waitForEditor(page, config.file.fileKey, 45_000);
  if (loaded) {
    log.info('Editor loaded, waiting for the document to finish loading...');
    await waitForNetworkQuiet(page, { quietMs: 2500, maxMs: 60_000 });
  }
  // Files shared by link also open for logged-out visitors, but without the
  // properties sidebar or any way to export.
  const loggedOut = loaded && (await isLoggedOut(page));
  if (!loaded || loggedOut) {
    if (config.headless) {
      throw new Error(
        'Not logged in to Figma (or the editor did not load). Run once with HEADLESS=false to log in, and check that this account can open the file.',
      );
    }
    if (loggedOut) {
      log.warn('Figma opened the file without a login (it is shared by link), but logged-out visitors cannot export.');
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    }
    log.warn(
      `Log in to Figma in the browser window; the export continues by itself. ` +
        `Waiting up to ${Math.round(config.loginTimeoutMs / 60000)} min...`,
    );
    await waitForLogin(page, url, config);
  }
  await page.waitForTimeout(config.settleMs);
  const title = await page.title();
  log.info(`Ready: ${title.replace(/\s+[–-]\s+Figma$/, '')}`);
}

async function waitForEditor(page, fileKey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('The browser window was closed.');
    if (await isEditorReady(page, fileKey)) return true;
    await openInBrowserIfOffered(page);
    await page.waitForTimeout(1000);
  }
  return false;
}

async function waitForLogin(page, fileUrl, config) {
  const { fileKey } = config.file;
  const deadline = Date.now() + config.loginTimeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('The browser window was closed before the file loaded.');
    if ((await isEditorReady(page, fileKey)) && !(await isLoggedOut(page))) {
      log.info('Editor loaded, waiting for the document to finish loading...');
      // The sign-up banner for logged-out visitors appears a moment after the canvas.
      await waitForNetworkQuiet(page, { quietMs: 2500, maxMs: 60_000 });
      if (!(await isLoggedOut(page))) return;
    }

    // After logging in, Figma usually lands on the file browser rather than the file.
    const current = new URL(page.url());
    const onFigmaHome =
      /(^|\.)figma\.com$/i.test(current.hostname) && (current.pathname === '/' || current.pathname.startsWith('/files'));
    if (onFigmaHome) {
      log.info('Logged in, reopening the file...');
      await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
    }
    await openInBrowserIfOffered(page);
    await page.waitForTimeout(2000);
  }
  throw new Error(
    'Timed out waiting for the Figma file to load. Check that you are logged in and that this account has access to the file.',
  );
}

// The editor is ready when we are on the file and its large WebGL canvas is on screen.
async function isEditorReady(page, fileKey) {
  if (!page.url().includes(fileKey)) return false;
  return page
    .evaluate(() =>
      [...document.querySelectorAll('canvas')].some((c) => c.clientWidth > 400 && c.clientHeight > 300),
    )
    .catch(() => false);
}

// Logged-out visitors get "Sign up to comment, edit, inspect and more." with
// Sign up / Log in buttons; a logged-in editor has neither.
async function isLoggedOut(page) {
  for (const button of await page.getByRole('button', { name: /^(sign up|log in)$/i }).all()) {
    if (await button.isVisible().catch(() => false)) return true;
  }
  return false;
}

// Accounts set to "open links in the desktop app" get an interstitial page.
async function openInBrowserIfOffered(page) {
  const link = page.getByRole('link', { name: /open (it )?(here|in (the |your )?browser)/i });
  const button = page.getByRole('button', { name: /open (it )?(here|in (the |your )?browser)/i });
  for (const candidate of [link, button]) {
    if (await candidate.first().isVisible().catch(() => false)) {
      log.info('Figma offered to open the desktop app; staying in the browser.');
      await candidate.first().click().catch(() => {});
      return;
    }
  }
}

// Figma streams the document and images after the canvas appears. Wait until the
// network has been idle for `quietMs`, or give up after `maxMs` (Figma keeps a few
// background connections open, so a perfectly idle network may never happen).
export async function waitForNetworkQuiet(page, { quietMs = 2000, maxMs = 30_000 } = {}) {
  let last = Date.now();
  const bump = () => {
    last = Date.now();
  };
  const events = ['request', 'requestfinished', 'requestfailed'];
  events.forEach((e) => page.on(e, bump));
  const start = Date.now();
  try {
    while (Date.now() - last < quietMs && Date.now() - start < maxMs) {
      await page.waitForTimeout(250);
    }
  } finally {
    events.forEach((e) => page.off(e, bump));
  }
}
