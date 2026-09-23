import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
const root = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents`;
const accessToken = await getFirebaseCliAccessToken();
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'x-goog-user-project': projectId,
};

async function listCollection(collectionPath) {
  const documents = [];
  let pageToken = '';
  do {
    const url = new URL(`${root}/${collectionPath}`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${collectionPath}: ${response.status} ${await response.text()}`);
    const payload = await response.json();
    documents.push(...(payload.documents || []));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);
  return documents;
}

const collections = {};
// Audit logs intentionally stay out of portable backups because the project
// repository is public and those records contain administrator identifiers.
for (const name of ['documents', 'categories', 'settings', 'pdfFiles', 'pdfSearchIndexes', 'maintenanceTasks']) {
  collections[name] = await listCollection(name);
}

const subcollections = { pdfVersions: {}, searchPages: {} };
for (const manifest of collections.pdfFiles) {
  const id = manifest.name.split('/').pop();
  subcollections.pdfVersions[id] = await listCollection(`pdfFiles/${encodeURIComponent(id)}/versions`);
}
// Historical imports can contain search page subcollections without a
// materialized parent manifest. Walk every catalogue id so those indexes are
// still included in a recoverable backup.
const searchIndexIds = new Set([
  ...collections.documents.map((document) => document.name.split('/').pop()),
  ...collections.pdfSearchIndexes.map((manifest) => manifest.name.split('/').pop()),
]);
for (const id of searchIndexIds) {
  subcollections.searchPages[id] = await listCollection(`pdfSearchIndexes/${encodeURIComponent(id)}/pages`);
}

const backup = {
  format: 'chaide-firestore-backup-v1',
  generatedAt: new Date().toISOString(),
  projectId,
  databaseId,
  note: 'Los bytes PDF se almacenan por separado en Backblaze B2.',
  collections,
  subcollections,
};

// Raw backups can contain private drafts and storage identifiers. Keep them in
// the gitignored private directory; CI uploads only an encrypted copy.
const outputDir = path.resolve(process.env.FIRESTORE_BACKUP_DIR || 'backups/private');
await mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, 'firestore-latest.json');
await writeFile(output, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  documents: collections.documents.length,
  categories: collections.categories.length,
  settings: collections.settings.length,
  maintenanceTasks: collections.maintenanceTasks.length,
  searchPages: Object.values(subcollections.searchPages).reduce((sum, pages) => sum + pages.length, 0),
}));
