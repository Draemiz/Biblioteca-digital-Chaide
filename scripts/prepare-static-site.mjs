import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'public');
const staticDataDir = path.join(publicDir, 'static-data');
const publicStorageDir = path.join(publicDir, 'storage');
const publicCmapsDir = path.join(publicDir, 'cmaps');
const sourceStorageDir = path.join(root, 'data', 'uploads');
const sourceSearchIndexDir = path.join(root, 'data', 'search-index');
const sourceCmapsDir = path.join(root, 'node_modules', 'pdfjs-dist', 'cmaps');
const dbPath = path.join(root, 'data', 'db.json');

function resetDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, destination, { recursive: true });
}

function writeJson(fileName, value) {
  fs.writeFileSync(
    path.join(staticDataDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const documents = (db.documents || [])
  .filter((document) => !document.isDeleted && document.status === 'ready')
  .map(({ searchIndex, ...document }) => document);
const categories = (db.categories || []).filter((category) => category.active !== false);

resetDirectory(staticDataDir);
resetDirectory(publicStorageDir);
resetDirectory(publicCmapsDir);

copyDirectory(sourceStorageDir, publicStorageDir);
copyDirectory(sourceSearchIndexDir, path.join(staticDataDir, 'search-index'));
copyDirectory(sourceCmapsDir, publicCmapsDir);

writeJson('documents.json', documents);
writeJson('categories.json', categories);
writeJson('promotional-banner.json', db.promotionalBanner || null);

console.log(`Static site prepared with ${documents.length} documents and ${categories.length} categories.`);
