import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFigmaUrl, toNodeId } from './figma-url.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCOPES = ['auto', 'selection', 'page', 'file'];
const ASSET_TYPES = ['frames', 'marked', 'images'];
const FORMATS = ['png', 'jpg', 'svg', 'pdf'];

export class ConfigError extends Error {}

export function loadConfig() {
  const envFile = path.join(ROOT, '.env');
  // Values already set in the shell win over .env.
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;

  if (!env.FIGMA_URL) {
    throw new ConfigError('FIGMA_URL is not set. Copy .env.example to .env and paste your Figma link into it.');
  }
  let file;
  try {
    file = parseFigmaUrl(env.FIGMA_URL);
  } catch (err) {
    throw new ConfigError(err.message);
  }

  const extraNodeIds = list(env.FIGMA_NODE_IDS).map(toNodeId);
  const nodeIds = [...new Set([file.nodeId, ...extraNodeIds].filter(Boolean))];

  let scope = oneOf('SCOPE', (env.SCOPE || 'auto').toLowerCase(), SCOPES);
  if (scope === 'auto') scope = nodeIds.length ? 'selection' : 'file';
  if (scope === 'selection' && !nodeIds.length) {
    throw new ConfigError('SCOPE=selection needs a node-id in FIGMA_URL or ids in FIGMA_NODE_IDS.');
  }

  const formats = [...new Set(list(env.FORMATS || 'png').map((f) => f.toLowerCase().replace('jpeg', 'jpg')))];
  formats.forEach((f) => oneOf('FORMATS', f, FORMATS));

  const assets = [...new Set(list(env.ASSETS || ASSET_TYPES.join(',')).map((a) => a.toLowerCase()))];
  assets.forEach((a) => oneOf('ASSETS', a, ASSET_TYPES));

  return {
    file,
    nodeIds,
    scope,
    assets,
    formats,
    scale: number('SCALE', env.SCALE || '2', 0.01, 4),
    outputDir: path.resolve(ROOT, env.OUTPUT_DIR || 'output'),
    profileDir: path.resolve(ROOT, env.PROFILE_DIR || '.figma-profile'),
    browserChannel: env.BROWSER_CHANNEL || undefined,
    headless: bool('HEADLESS', env.HEADLESS, false),
    loginTimeoutMs: number('LOGIN_TIMEOUT_SEC', env.LOGIN_TIMEOUT_SEC || '300', 10, 3600) * 1000,
    exportTimeoutMs: number('EXPORT_TIMEOUT_SEC', env.EXPORT_TIMEOUT_SEC || '300', 10, 3600) * 1000,
    settleMs: number('SETTLE_SEC', env.SETTLE_SEC || '3', 0, 120) * 1000,
    debug: bool('DEBUG', env.DEBUG, false),
  };
}

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} has invalid value "${value}". Allowed: ${allowed.join(', ')}`);
  }
  return value;
}

function number(name, value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}, got "${value}"`);
  }
  return n;
}

function bool(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new ConfigError(`${name} must be true or false, got "${value}"`);
}
