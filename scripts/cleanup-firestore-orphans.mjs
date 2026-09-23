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

async function deletePath(documentPath) {
  const response = await fetch(`${root}/${documentPath}`, { method: 'DELETE', headers });
  if (!response.ok && response.status !== 404) {
    throw new Error(`${documentPath}: ${response.status} ${await response.text()}`);
  }
}

const documents = await listCollection('documents');
const documentIds = new Set(documents.map((item) => item.name.split('/').pop()));
let pdfManifestsDeleted = 0;
let searchManifestsDeleted = 0;
let childDocumentsDeleted = 0;

for (const manifest of await listCollection('pdfFiles')) {
  const id = manifest.name.split('/').pop();
  if (documentIds.has(id)) continue;
  for (const childCollection of ['chunks', 'versions']) {
    for (const child of await listCollection(`pdfFiles/${encodeURIComponent(id)}/${childCollection}`)) {
      await deletePath(child.name.split('/documents/')[1]);
      childDocumentsDeleted += 1;
    }
  }
  await deletePath(`pdfFiles/${encodeURIComponent(id)}`);
  pdfManifestsDeleted += 1;
}

for (const manifest of await listCollection('pdfSearchIndexes')) {
  const id = manifest.name.split('/').pop();
  if (documentIds.has(id)) continue;
  for (const child of await listCollection(`pdfSearchIndexes/${encodeURIComponent(id)}/pages`)) {
    await deletePath(child.name.split('/documents/')[1]);
    childDocumentsDeleted += 1;
  }
  await deletePath(`pdfSearchIndexes/${encodeURIComponent(id)}`);
  searchManifestsDeleted += 1;
}

console.log(JSON.stringify({
  documents: documentIds.size,
  pdfManifestsDeleted,
  searchManifestsDeleted,
  childDocumentsDeleted,
}));
