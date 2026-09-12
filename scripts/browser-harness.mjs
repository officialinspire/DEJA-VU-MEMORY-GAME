// Shared plumbing for the browser regression suite: locating a Chromium build,
// serving dist/ the way GitHub Pages does, and a minimal assertion runner.
import { createReadStream, existsSync, promises as fs, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distDirectory = path.join(rootDirectory, 'dist');

// The hosted build lives under /<repo>/ on GitHub Pages. Serving the tests from
// a subpath keeps relative paths, the manifest scope and the service-worker
// scope honest; a root mount would hide a whole class of path bug.
export const SUBPATH = '/DEJA-VU-MEMORY-GAME/';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

/**
 * Serves dist/ under SUBPATH on an ephemeral port, with the byte-range support
 * a real host provides, so the worker's own range handling is what is measured.
 */
export async function startServer() {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (!pathname.startsWith(SUBPATH)) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('outside site root');
      return;
    }
    let relative = pathname.slice(SUBPATH.length) || 'index.html';
    if (relative.endsWith('/')) relative += 'index.html';
    const filePath = path.resolve(distDirectory, relative);
    if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${path.sep}`)) {
      response.writeHead(400).end('bad request');
      return;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('not a file');
      const headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Content-Type': CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      };
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        response.writeHead(206, {
          ...headers,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        });
        createReadStream(filePath, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
      createReadStream(filePath).pipe(response);
    } catch (_) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    // 127.0.0.1 is a secure context, which service workers require.
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}${SUBPATH}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Playwright ships a pinned browser revision, but CI images and dev machines
 * often carry a different one. Accept any Chromium we can actually find rather
 * than failing on a revision mismatch.
 */
export function resolveChromium(chromium) {
  const candidates = [];
  if (process.env.DEJA_VU_CHROMIUM) candidates.push(process.env.DEJA_VU_CHROMIUM);
  try {
    candidates.push(chromium.executablePath());
  } catch (_) {
    // No bundled build recorded; fall through to the search below.
  }
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (browsersPath && existsSync(browsersPath)) {
    for (const entry of readdirSync(browsersPath)) {
      if (!entry.startsWith('chromium-')) continue;
      candidates.push(
        path.join(browsersPath, entry, 'chrome-linux', 'chrome'),
        path.join(browsersPath, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(browsersPath, entry, 'chrome-win', 'chrome.exe'),
      );
    }
  }
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  candidates.push(
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

export function missingBrowserMessage() {
  return [
    'No Chromium build found for the browser regression suite.',
    '',
    'Install one with:   npx playwright install chromium',
    'Or point at an existing binary:   DEJA_VU_CHROMIUM=/path/to/chrome npm run test:browser',
    '',
    'These tests cover rendered layout and offline behavior, so they are not',
    'optional cover for a release. Set DEJA_VU_SKIP_BROWSER_TESTS=1 only to run',
    'the source-level checks alone, knowing the rendered checks did not run.',
  ].join('\n');
}

/** Minimal runner: keeps the suite dependency-light and the output readable. */
export function createRunner() {
  const failures = [];
  let checks = 0;
  let currentGroup = '';

  return {
    group(name) {
      currentGroup = name;
    },
    /** Runs one assertion, recording rather than throwing so a run reports everything. */
    check(name, fn) {
      checks += 1;
      try {
        fn();
      } catch (error) {
        failures.push({ group: currentGroup, name, message: error.message });
      }
    },
    get failures() {
      return failures;
    },
    report(label) {
      if (!failures.length) {
        console.log(`${label}: PASS (${checks} assertions)`);
        return true;
      }
      console.error(`${label}: FAIL (${failures.length} of ${checks} assertions)`);
      for (const failure of failures) {
        console.error(`  ✗ [${failure.group}] ${failure.name}`);
        for (const line of failure.message.split('\n')) console.error(`      ${line}`);
      }
      return false;
    },
  };
}
