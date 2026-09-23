import { readFile } from 'node:fs/promises';
import path from 'node:path';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

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
const workspaceRoot = path.resolve(import.meta.dirname, '..');

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return Array.from(new Set(normalize(value).split(' ').filter(Boolean))).slice(0, 8_000);
}

function fieldString(document, name) {
  return String(document.fields?.[name]?.stringValue || '');
}

function fieldNumber(document, name) {
  return Number(document.fields?.[name]?.integerValue || document.fields?.[name]?.doubleValue || 0);
}

function fieldBoolean(document, name, fallback = false) {
  return document.fields?.[name]?.booleanValue ?? fallback;
}

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

// Searches fall back to the per-catalogue indexes while a rebuild is running.
// A failed migration therefore cannot advertise a partial global corpus.
await commit([{
  update: {
    name: `${databaseRoot}/documents/catalogSearchMeta/current`,
    fields: {
      ready: { booleanValue: false },
      schemaVersion: { integerValue: '1' },
      generatedAt: { timestampValue: new Date().toISOString() },
    },
  },
}]);

const existing = await listCollection('catalogSearchPages').catch(() => []);
for (let start = 0; start < existing.length; start += 100) {
  await commit(existing.slice(start, start + 100).map((document) => ({ delete: document.name })));
}

const documents = await listCollection('documents');
let indexedCatalogs = 0;
let indexedPages = 0;
for (let start = 0; start < documents.length; start += 8) {
  const catalogPages = await Promise.all(documents.slice(start, start + 8).map(async (catalog) => {
    const id = catalog.name.split('/').pop();
    if (!id) return [];
    const liveVersion = fieldString(catalog, 'searchIndexVersion');
    const fileUrl = fieldString(catalog, 'fileUrl');
    const isPublic =
      fieldString(catalog, 'status') === 'ready' &&
      fieldBoolean(catalog, 'isActive', true) &&
      fieldString(catalog, 'visibility') !== 'private';
    if (liveVersion && !fileUrl.startsWith('/storage/')) {
      const pages = await listCollection(`pdfSearchIndexes/${encodeURIComponent(id)}/pages`);
      const currentPages = pages.filter((page) => fieldString(page, 'version') === liveVersion).map((page) => ({
        catalogId: id,
        version: liveVersion,
        pageNumber: fieldNumber(page, 'pageNumber'),
        text: fieldString(page, 'text'),
        isPublic,
      })).filter((page) => page.pageNumber > 0);
      if (currentPages.length) return currentPages;
    }

    // The original Hosting catalogues keep their validated indexes in the
    // repository. Include them in the same global collection so no historical
    // result disappears when the fast path is enabled.
    try {
      const raw = await readFile(path.join(workspaceRoot, 'data', 'search-index', `${id}.json`), 'utf8');
      const staticIndex = JSON.parse(raw);
      return (Array.isArray(staticIndex.pages) ? staticIndex.pages : []).map((page) => ({
        catalogId: id,
        version: 'static',
        pageNumber: Number(page.pageNumber || page.page || 0),
        text: String(page.text || ''),
        isPublic,
      })).filter((page) => page.pageNumber > 0);
    } catch {
      return [];
    }
  }));

  for (const pages of catalogPages) {
    if (pages.length) indexedCatalogs += 1;
    for (let pageStart = 0; pageStart < pages.length; pageStart += 20) {
      const group = pages.slice(pageStart, pageStart + 20);
      await commit(group.map((page) => {
        const suffix = String(page.pageNumber).padStart(5, '0');
        return {
          update: {
            name: `${databaseRoot}/documents/catalogSearchPages/${page.catalogId}__${page.version}__${suffix}`,
            fields: {
              catalogId: { stringValue: page.catalogId },
              version: { stringValue: page.version },
              pageNumber: { integerValue: String(page.pageNumber) },
              text: { stringValue: page.text },
              tokens: {
                arrayValue: { values: tokens(page.text).map((token) => ({ stringValue: token })) },
              },
              isPublic: { booleanValue: page.isPublic },
            },
          },
        };
      }));
      indexedPages += group.length;
    }
  }
  console.log(`Índice global: ${Math.min(start + 8, documents.length)}/${documents.length} catálogos revisados.`);
}

await commit([{
  update: {
    name: `${databaseRoot}/documents/catalogSearchMeta/current`,
    fields: {
      ready: { booleanValue: true },
      schemaVersion: { integerValue: '1' },
      catalogCount: { integerValue: String(indexedCatalogs) },
      pageCount: { integerValue: String(indexedPages) },
      generatedAt: { timestampValue: new Date().toISOString() },
    },
  },
}]);

console.log(JSON.stringify({ indexedCatalogs, indexedPages, removedStalePages: existing.length }));
