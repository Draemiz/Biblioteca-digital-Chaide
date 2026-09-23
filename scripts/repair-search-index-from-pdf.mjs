import { readFile } from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const [documentId, pdfPath] = process.argv.slice(2);
if (!documentId || !pdfPath) {
  throw new Error('Uso: node scripts/repair-search-index-from-pdf.mjs <documentId> <archivo.pdf>');
}

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
const databaseRoot = `projects/${projectId}/databases/${databaseId}`;
const root = `https://firestore.googleapis.com/v1/${databaseRoot}/documents`;
const commitUrl = `https://firestore.googleapis.com/v1/${databaseRoot}/documents:commit`;
const accessToken = await getFirebaseCliAccessToken();
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
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

async function commit(writes) {
  if (!writes.length) return;
  const response = await fetch(commitUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ writes }),
  });
  if (!response.ok) throw new Error(`Commit: ${response.status} ${await response.text()}`);
}

const bytes = new Uint8Array(await readFile(pdfPath));
if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
  throw new Error('El archivo no es un PDF válido.');
}
const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
const pages = [];
try {
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200_000);
    pages.push({ pageNumber, text });
    if (pageNumber % 20 === 0) console.log(`Extracción: ${pageNumber}/${pdf.numPages} páginas.`);
  }
} finally {
  await pdf.destroy();
}

const version = `repair-${Date.now().toString(36)}`;
const previousPages = await listCollection(`pdfSearchIndexes/${encodeURIComponent(documentId)}/pages`);
for (let start = 0; start < previousPages.length; start += 100) {
  await commit(previousPages.slice(start, start + 100).map((page) => ({ delete: page.name })));
}
for (let start = 0; start < pages.length; start += 20) {
  await commit(pages.slice(start, start + 20).map((page) => ({
    update: {
      name: `${databaseRoot}/documents/pdfSearchIndexes/${documentId}/pages/${version}-${String(page.pageNumber).padStart(5, '0')}`,
      fields: {
        version: { stringValue: version },
        pageNumber: { integerValue: String(page.pageNumber) },
        text: { stringValue: page.text },
      },
    },
  })));
}
const searchablePages = pages.filter((page) => page.text.length > 0).length;
await commit([
  {
    update: {
      name: `${databaseRoot}/documents/pdfSearchIndexes/${documentId}`,
      fields: {
        version: { stringValue: version },
        pageCount: { integerValue: String(pages.length) },
        hasText: { booleanValue: searchablePages > 0 },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    },
  },
  {
    update: {
      name: `${databaseRoot}/documents/documents/${documentId}`,
      fields: {
        searchIndexVersion: { stringValue: version },
        searchIndexStatus: { stringValue: searchablePages > 0 ? 'ready' : 'no-text' },
        pageCount: { integerValue: String(pages.length) },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    },
    updateMask: {
      fieldPaths: ['searchIndexVersion', 'searchIndexStatus', 'pageCount', 'updatedAt'],
    },
  },
]);
console.log(JSON.stringify({ documentId, version, pages: pages.length, searchablePages }));
