# Figma asset downloader

Give it a Figma link and it opens the file in a real browser (Playwright), then
exports the design with Figma's own exporter:

- **frames** — the linked frame/node (or every top-level frame of every page) as PNG/JPG/SVG/PDF, up to 4x
- **marked** — every layer the designer gave export settings (File > Export…)
- **images** — the original raster images (photos, illustrations) used in the design, at full resolution

No Figma MCP, no API token. This matters because Figma's REST API allows View and
Collab seats only about **6 file/image requests per month**; the browser has no
such limit.

## Setup

Requires Node.js 20.12 or newer.

```bash
npm install
npx playwright install chromium   # only needed once per machine
cp .env.example .env              # then paste your link into FIGMA_URL
```

## Run

```bash
npm start
```

The first run opens a browser window on Figma's login page. Log in there, and the
export continues on its own. The session is saved in `.figma-profile/`, so later
runs skip the login.

Any env var can also be set on the command line, for example
`FIGMA_URL="https://www.figma.com/design/..." SCALE=4 npm start` (bash) or
`$env:SCALE=4; npm start` (PowerShell).

### Which link to use

| Link | What gets exported |
| --- | --- |
| Right-click a frame > **Copy link to selection** | That frame/node |
| The browser address bar while a page is open (its `node-id` is the page) | Each top-level frame on that page, as separate files |
| The file link with no `node-id` | Each top-level frame on all pages |
| Any link with `SCOPE=page` | Each top-level frame on the page the link opens |

The tool tells a page link from a layer link by checking what Figma selects
when it opens the link.

To export several frames in one run, add their ids:
`FIGMA_NODE_IDS=1234-5678,1234-9012`.

## Output

A link with a `node-id` gets its own folder, `output/<File-Name>/<node-id>/`, so
exporting several pages or frames of one file keeps them apart. A link without one
uses `output/<File-Name>/`.

```
output/<File-Name>/[<node-id>/]
  frames/          linked node/page, or frames/<NN_page-id>/ per page
  marked/          designer-defined exports, using the designer's scales and formats
  images/          <hash>_<width>x<height>.png|jpg|webp|gif original image fills
  manifest.json    every saved file, the settings used and any failed step
  _debug/          screenshots + UI dumps, only when a step failed
```

Layer names containing `/` become sub-folders, which is the same as Figma's own export.

## Settings (`.env`)

| Variable | Default | |
| --- | --- | --- |
| `FIGMA_URL` | required | Figma design link |
| `ASSETS` | `frames,marked,images` | Any combination |
| `FORMATS` | `png` | `png`, `jpg`, `svg`, `pdf`; e.g. `png,svg` exports both |
| `SCALE` | `2` | Bitmap scale, `0.01`–`4`. SVG/PDF are vector and ignore it |
| `SCOPE` | `auto` | `selection` if the link has a node-id, otherwise `file`. Also `page` |
| `FIGMA_NODE_IDS` | | Extra node ids for `selection` |
| `OUTPUT_DIR` | `output` | |
| `BROWSER_CHANNEL` | Playwright Chromium | `chrome` or `msedge` to use an installed browser |
| `HEADLESS` | `false` | Keep `false` for the first (login) run |
| `PROFILE_DIR` | `.figma-profile` | Saved login. Delete it to log out |
| `LOGIN_TIMEOUT_SEC` | `300` | How long to wait for you to log in |
| `EXPORT_TIMEOUT_SEC` | `300` | How long one export download may take |
| `SETTLE_SEC` | `3` | Extra wait after the file loads; raise for huge files |
| `DEBUG` | `false` | Verbose logging |

## How it works

1. Opens the link in a persistent Chromium profile and waits for Figma's canvas
   (and for you to log in, the first time).
2. **frames**: the link's node is already selected by Figma. With no node-id, it
   selects all layers (Ctrl/Cmd+A) on each page, moving through pages with
   Page Up/Page Down. It then adds an export row in the right sidebar, sets the
   format and scale, clicks **Export**, and saves the download. Multi-layer zips
   are unpacked.
3. **marked**: opens File > Export… (Ctrl/Cmd+Shift+E) and exports everything listed there.
4. **images**: records every image the editor downloads and keeps the originals,
   de-duplicated by content.

Figma renders exports in the browser, so the files are identical to exporting by hand.

## Things to know

- **Permissions.** It can only export what your account may export. If the owner
  turned off "Viewers can copy, share and export", the export steps fail.
- **Files you can edit.** To export, the tool adds an export row to the selection,
  then removes it again with undo when the export finishes. The undo history of a
  freshly opened file only contains these changes, so nothing else is reverted.
  If a run is killed mid-export, the frame may keep an extra export setting,
  which is harmless and can be removed by hand.
- **Login with Google.** Google may refuse to sign in inside an automated browser.
  Use email + password, or try `BROWSER_CHANNEL=chrome`.
- **Headless.** Figma may refuse to serve the editor to headless browsers. The
  default is a visible window.
- **Figma UI changes.** Figma has no public API for this in the browser. The tool
  drives the interface, so a Figma redesign can break a step. Every UI locator is
  in `src/figma-ui.js`. See below.

## When a step fails

The run continues with the other steps. It writes a screenshot, the page's
accessibility tree (`*.aria.yml`) and a list of export-related elements
(`*.elements.json`) to `output/<File-Name>/_debug/`.

To check the Figma UI without exporting anything:

```bash
npm run inspect
```

This walks through the export controls, prints `OK`/`MISS` for each one, and
saves the same dumps to `output/_inspect/`. Use them to adjust the locators at the
top of `src/figma-ui.js`.

## Tests

```bash
npm test
```

Covers link parsing, image header detection and safe zip extraction.
