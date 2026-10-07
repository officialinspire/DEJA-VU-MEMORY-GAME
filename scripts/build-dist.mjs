import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, '..');
const distDirectory = path.join(rootDirectory, 'dist');
const checkOnly = process.argv.includes('--check');

const ROOT_FILES = new Set([
  '.nojekyll',
  'index.html',
  'manifest.webmanifest',
]);
const ROOT_EXTENSIONS = new Set(['.css', '.js', '.mp3', '.mp4', '.png']);
const ICON_EXTENSIONS = new Set(['.png']);

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function assertSafeDistPath() {
  if (path.basename(distDirectory) !== 'dist' || path.dirname(distDirectory) !== rootDirectory) {
    throw new Error(`Refusing to rebuild unexpected directory: ${distDirectory}`);
  }
}

async function collectSourceFiles() {
  const rootEntries = await readdir(rootDirectory, { withFileTypes: true });
  const files = rootEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => ROOT_FILES.has(name) || ROOT_EXTENSIONS.has(path.extname(name).toLowerCase()));

  const iconsDirectory = path.join(rootDirectory, 'icons');
  const iconEntries = await readdir(iconsDirectory, { withFileTypes: true });
  for (const entry of iconEntries) {
    if (entry.isFile() && ICON_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.join('icons', entry.name));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function collectFiles(directory, relativeDirectory = '') {
  let entries;
  try {
    entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(directory, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function digest(filePath) {
  const contents = await readFile(filePath);
  return createHash('sha256').update(contents).digest('hex');
}

async function verifyParity(sourceFiles) {
  const distFiles = await collectFiles(distDirectory);
  const expected = new Set(sourceFiles.map(toPosix));
  const actual = new Set(distFiles.map(toPosix));
  const missing = [...expected].filter((file) => !actual.has(file));
  const unexpected = [...actual].filter((file) => !expected.has(file));
  const changed = [];

  for (const relativePath of sourceFiles) {
    if (!actual.has(toPosix(relativePath))) continue;
    const sourceHash = await digest(path.join(rootDirectory, relativePath));
    const distHash = await digest(path.join(distDirectory, relativePath));
    if (sourceHash !== distHash) changed.push(toPosix(relativePath));
  }

  if (missing.length || unexpected.length || changed.length) {
    const details = [
      missing.length ? `Missing from dist: ${missing.join(', ')}` : '',
      unexpected.length ? `Unexpected in dist: ${unexpected.join(', ')}` : '',
      changed.length ? `Different from source: ${changed.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(`dist parity check failed.\n${details}`);
  }
}

// Every hosted file is read the way a browser would read it on GitHub Pages:
// references are resolved against the referring file's URL under the site's
// project subpath, so a root-absolute path, a `../` that escapes the subpath,
// a case mismatch (Pages is case-sensitive even when a dev machine is not) or
// a bad percent-encoding fails the build rather than the deploy.
const FALLBACK_SITE_ROOT = 'https://pages.invalid/site/';
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.webmanifest']);
const NOT_PRECACHED = new Set([
  // The worker script is fetched by the browser, never served from its own cache.
  'sw.js',
]);

function stripComments(source, { lineComments = true } = {}) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Only whole-line // comments: a mid-line // may sit inside a string or URL.
  return lineComments ? withoutBlocks.replace(/^\s*\/\/.*$/gm, '') : withoutBlocks;
}

function htmlReferences(source) {
  const references = [];
  const html = source.replace(/<!--[\s\S]*?-->/g, '');
  for (const [, tag, attributes] of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] || '';
    for (const [, name, , value] of attributes.matchAll(/\b(src|href|poster|content)\s*=\s*(["'])(.*?)\2/gi)) {
      const attribute = name.toLowerCase();
      // <meta content> is only a URL for the absolute social-preview values.
      if (attribute === 'content' && !/^https?:\/\//i.test(value)) continue;
      references.push({
        value,
        where: `<${tag.toLowerCase()} ${attribute}>`,
        // Crawler-facing URLs: they must exist, but play never requests them.
        social: attribute === 'content' || /\bcanonical\b/i.test(rel),
      });
    }
  }
  return references;
}

function cssReferences(source) {
  const css = stripComments(source, { lineComments: false });
  const references = [];
  for (const [, , quoted, bare] of css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)"']*?))\s*\)/g)) {
    const value = quoted ?? bare;
    references.push({ value, where: 'url()', unquotedSpace: quoted === undefined && /\s/.test(value) });
  }
  for (const [, , value] of css.matchAll(/@import\s+(["'])(.*?)\1/g)) references.push({ value, where: '@import' });
  return references;
}

function jsReferences(source) {
  const js = stripComments(source);
  const references = [];
  const seen = new Set();
  const add = (value, where) => {
    if (seen.has(value)) return;
    seen.add(value);
    references.push({ value, where });
  };
  for (const [, , value] of js.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g)) add(value, 'import');
  for (const [, , value] of js.matchAll(/\bimport\s*\(?\s*(['"])([^'"]+)\1/g)) add(value, 'import');
  // Relative path literals: new URL('./x', import.meta.url), Image src,
  // register('./sw.js'), the worker's precache list.
  for (const [, , value] of js.matchAll(/(['"`])(\.{1,2}\/[^'"`\n]*)\1/g)) {
    if (!value.includes('${')) add(value, 'string');
  }
  return references;
}

function manifestReferences(source) {
  const manifest = JSON.parse(source);
  const references = [];
  for (const key of ['start_url', 'scope']) {
    if (manifest[key]) references.push({ value: manifest[key], where: key, directory: true });
  }
  for (const group of ['icons', 'screenshots']) {
    for (const entry of manifest[group] || []) references.push({ value: entry.src, where: group });
  }
  for (const shortcut of manifest.shortcuts || []) {
    if (shortcut.url) references.push({ value: shortcut.url, where: 'shortcuts', directory: true });
    for (const icon of shortcut.icons || []) references.push({ value: icon.src, where: 'shortcuts icons' });
  }
  return references;
}

const listingCache = new Map();
async function listing(directory) {
  if (!listingCache.has(directory)) {
    listingCache.set(directory, await readdir(directory, { withFileTypes: true }).catch(() => []));
  }
  return listingCache.get(directory);
}

// Exact-case lookup, segment by segment, whatever the local filesystem does.
async function findExactly(relativePath) {
  let directory = distDirectory;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    const entries = await listing(directory);
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) {
      const nearMiss = entries.find((candidate) => candidate.name.toLowerCase() === segment.toLowerCase());
      return { found: false, nearMiss: nearMiss && [...segments.slice(0, index), nearMiss.name].join('/') };
    }
    const last = index === segments.length - 1;
    if (last ? !entry.isFile() : !entry.isDirectory()) return { found: false };
    directory = path.join(directory, segment);
  }
  return { found: true };
}

async function siteRoot() {
  const html = await readFile(path.join(distDirectory, 'index.html'), 'utf8');
  const canonical = /<link\b[^>]*\brel=["']canonical["'][^>]*>/i.exec(html)?.[0];
  const href = canonical && /\bhref=["']([^"']+)["']/i.exec(canonical)?.[1];
  return href && href.endsWith('/') ? href : FALLBACK_SITE_ROOT;
}

function resolveReference(reference, fromFile, root) {
  const value = reference.value.trim();
  if (!value || value.startsWith('#') || /^(?:data|blob|mailto|tel|javascript):/i.test(value)) return { skip: true };
  if (reference.unquotedSpace) return { error: 'unquoted url() containing a space; quote it' };
  let url;
  try {
    url = new URL(value, new URL(fromFile, root));
  } catch (_) {
    return { error: 'is not a valid URL' };
  }
  const rootUrl = new URL(root);
  if (url.origin !== rootUrl.origin) return { skip: true };
  if (!url.pathname.startsWith(rootUrl.pathname)) {
    return { error: `resolves to ${url.pathname}, outside ${rootUrl.pathname}; use a path relative to the file` };
  }
  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice(rootUrl.pathname.length));
  } catch (_) {
    return { error: 'has a malformed percent-encoding' };
  }
  if (/%[0-9a-f]{2}/i.test(relative)) return { error: `is percent-encoded twice (decodes to "${relative}")` };
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  return { path: relative };
}

function precacheEntries(swSource) {
  const body = /const APP_SHELL = \[([\s\S]*?)\];/.exec(swSource)?.[1];
  if (!body) throw new Error('sw.js has no APP_SHELL list to check');
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

async function verifyAssetReferences() {
  const root = await siteRoot();
  const files = (await collectFiles(distDirectory)).map(toPosix);
  const problems = [];
  const referenced = new Set(['index.html', '.nojekyll']);
  const runtime = new Map();
  let count = 0;

  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const source = await readFile(path.join(distDirectory, file), 'utf8');
    let references;
    if (extension === '.html') references = htmlReferences(source);
    else if (extension === '.css') references = cssReferences(source);
    else if (extension === '.js') references = jsReferences(source);
    else references = manifestReferences(source);

    for (const reference of references) {
      const resolved = resolveReference(reference, file, root);
      if (resolved.skip) continue;
      count += 1;
      const label = `${file} ${reference.where} "${reference.value}"`;
      if (resolved.error) {
        problems.push(`${label} ${resolved.error}`);
        continue;
      }
      const target = reference.directory ? 'index.html' : resolved.path;
      const lookup = await findExactly(reference.directory ? target : resolved.path);
      if (!lookup.found) {
        problems.push(lookup.nearMiss
          ? `${label} differs in case from ${lookup.nearMiss}; GitHub Pages is case-sensitive`
          : `${label} does not exist in dist/`);
        continue;
      }
      referenced.add(target);
      if (!reference.social && file !== 'sw.js') {
        if (!runtime.has(target)) runtime.set(target, label);
      }
    }
  }

  // The offline promise: everything the running app requests is precached.
  const swSource = await readFile(path.join(distDirectory, 'sw.js'), 'utf8');
  const shell = new Set(precacheEntries(swSource)
    .map((entry) => resolveReference({ value: entry }, 'sw.js', root).path)
    .filter(Boolean));
  for (const [target, label] of runtime) {
    if (!shell.has(target) && !NOT_PRECACHED.has(target)) {
      problems.push(`${label} is requested at runtime but missing from the sw.js APP_SHELL precache`);
    }
  }

  if (problems.length) throw new Error(`Asset reference check failed:\n  ${problems.join('\n  ')}`);
  const unreferenced = files.filter((file) => !referenced.has(file));
  return { count, files: files.length, precached: shell.size, unreferenced };
}

async function rebuild(sourceFiles) {
  assertSafeDistPath();
  await rm(distDirectory, { recursive: true, force: true });
  await mkdir(distDirectory, { recursive: true });

  for (const relativePath of sourceFiles) {
    const destination = path.join(distDirectory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(rootDirectory, relativePath), destination);
  }
}

async function main() {
  const sourceFiles = await collectSourceFiles();
  if (!checkOnly) await rebuild(sourceFiles);
  await verifyParity(sourceFiles);
  const assets = await verifyAssetReferences();
  console.log(`${checkOnly ? 'Verified' : 'Built and verified'} dist (${sourceFiles.length} files).`);
  console.log(`Asset references: ${assets.count} resolved exactly under the Pages subpath; `
    + `every runtime asset is in the ${assets.precached}-entry precache.`);
  if (assets.unreferenced.length) {
    console.log(`Hosted but never referenced: ${assets.unreferenced.join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
