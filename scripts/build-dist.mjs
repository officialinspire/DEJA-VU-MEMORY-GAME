import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
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

function localReferences(html) {
  const references = new Set();
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attributePattern.exec(html))) {
    const value = match[1].trim();
    if (!value || value.startsWith('#') || /^(?:[a-z]+:|\/\/)/i.test(value)) continue;
    references.add(value.split(/[?#]/, 1)[0]);
  }
  return [...references];
}

async function verifyIndexReferences() {
  const indexPath = path.join(distDirectory, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const missing = [];

  for (const reference of localReferences(html)) {
    const decodedReference = decodeURIComponent(reference);
    const resolvedPath = path.resolve(distDirectory, decodedReference);
    const relativePath = path.relative(distDirectory, resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      missing.push(`${reference} (outside dist)`);
      continue;
    }

    try {
      if (!(await stat(resolvedPath)).isFile()) missing.push(reference);
    } catch (error) {
      if (error?.code === 'ENOENT') missing.push(reference);
      else throw error;
    }
  }

  if (missing.length) throw new Error(`Missing local index.html references: ${missing.join(', ')}`);
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
  await verifyIndexReferences();
  console.log(`${checkOnly ? 'Verified' : 'Built and verified'} dist (${sourceFiles.length} files).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
