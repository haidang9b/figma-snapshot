// Figma links look like:
//   https://www.figma.com/design/<fileKey>/<File-Name>?node-id=51-567&p=f&t=...
//   https://www.figma.com/design/<fileKey>/branch/<branchKey>/<File-Name>
//   https://www.figma.com/proto/<fileKey>/<File-Name>?node-id=...
// The URL encodes node ids with "-" (51-567); the document uses ":" (51:567).

const EDITOR_PATH = /^\/(design|file|proto|board|slides|site|make)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?(?:\/([^/?#]+))?/;

export function parseFigmaUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error(`FIGMA_URL is not a valid URL: ${raw}`);
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) {
    throw new Error(`FIGMA_URL must be a figma.com link, got: ${url.hostname}`);
  }

  const match = url.pathname.match(EDITOR_PATH);
  if (!match) {
    throw new Error('FIGMA_URL must point to a design file, e.g. https://www.figma.com/design/<fileKey>/<name>?node-id=1-2');
  }
  const [, type, fileKey, branchKey, nameSegment] = match;

  if (!['design', 'file', 'proto'].includes(type)) {
    throw new Error(`Only Figma Design files are supported (got a "${type}" link).`);
  }
  // Prototype links have no export UI; open the same file in the editor instead.
  if (type === 'proto') {
    url.pathname = url.pathname.replace(/^\/proto\//, '/design/');
  }

  const nodeParam = url.searchParams.get('node-id');
  return {
    url: url.toString(),
    fileKey: branchKey || fileKey,
    nodeId: nodeParam ? toNodeId(nodeParam) : null,
    slug: sanitizeSegment(nameSegment ? safeDecode(nameSegment) : '') || fileKey,
  };
}

export function toNodeId(value) {
  return String(value).trim().replaceAll('-', ':');
}

export function urlForNode(fileUrl, nodeId) {
  const url = new URL(fileUrl);
  url.searchParams.set('node-id', toNodeId(nodeId).replaceAll(':', '-'));
  return url.toString();
}

export function currentNodeParam(pageUrl) {
  try {
    return new URL(pageUrl).searchParams.get('node-id');
  } catch {
    return null;
  }
}

// Make a string safe to use as a single file or folder name on Windows, macOS and Linux.
export function sanitizeSegment(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
