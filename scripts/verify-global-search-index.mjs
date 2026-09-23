import { initializeApp, deleteApp } from 'firebase/app';
import { collection, getDocs, getFirestore, limit, query, where } from 'firebase/firestore';
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

const stringField = (document, name) => String(document.fields?.[name]?.stringValue || '');
const boolField = (document, name, fallback = false) =>
  document.fields?.[name]?.booleanValue ?? fallback;

async function readDocument(documentPath) {
  const response = await fetch(`${root}/${documentPath}`, { headers });
  if (!response.ok) throw new Error(`${documentPath}: ${response.status} ${await response.text()}`);
  return response.json();
}

const [documents, pages, metadata] = await Promise.all([
  listCollection('documents'),
  listCollection('catalogSearchPages'),
  readDocument('catalogSearchMeta/current'),
]);
const documentsById = new Map(documents.map((document) => [document.name.split('/').pop(), document]));
const pageCatalogIds = new Set(pages.map((page) => stringField(page, 'catalogId')).filter(Boolean));
const published = documents.filter((document) =>
  stringField(document, 'status') === 'ready' &&
  boolField(document, 'isActive', true) &&
  stringField(document, 'visibility') !== 'private');
const missing = published.filter((document) => {
  const id = document.name.split('/').pop();
  return stringField(document, 'searchIndexStatus') !== 'no-text' && !pageCatalogIds.has(id);
}).map((document) => ({
  id: document.name.split('/').pop(),
  title: stringField(document, 'title'),
  searchIndexStatus: stringField(document, 'searchIndexStatus'),
}));
if (missing.length) throw new Error(`Catálogos buscables ausentes: ${JSON.stringify(missing)}`);
const invalidPages = pages.filter((page) => {
  const catalog = documentsById.get(stringField(page, 'catalogId'));
  if (!catalog) return true;
  const isPublic =
    stringField(catalog, 'status') === 'ready' &&
    boolField(catalog, 'isActive', true) &&
    stringField(catalog, 'visibility') !== 'private';
  const expectedVersion = stringField(catalog, 'fileUrl').startsWith('/storage/')
    ? 'static'
    : stringField(catalog, 'searchIndexVersion');
  return boolField(page, 'isPublic') !== isPublic ||
    (expectedVersion && stringField(page, 'version') !== expectedVersion);
});
if (invalidPages.length) {
  throw new Error(`${invalidPages.length} páginas globales tienen versión o visibilidad incoherente.`);
}
if (
  !boolField(metadata, 'ready') ||
  Number(metadata.fields?.catalogCount?.integerValue || 0) !== pageCatalogIds.size ||
  Number(metadata.fields?.pageCount?.integerValue || 0) !== pages.length
) {
  throw new Error('El manifiesto del índice global no coincide con su contenido.');
}

const app = initializeApp(firebaseConfig, `verify-global-search-${Date.now()}`);
try {
  const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  const startedAt = performance.now();
  const result = await getDocs(query(
    collection(db, 'catalogSearchPages'),
    where('tokens', 'array-contains', 'ferrara'),
    where('isPublic', '==', true),
    limit(50),
  ));
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (result.empty) throw new Error('La consulta pública de prueba no encontró FERRARA.');
  console.log(JSON.stringify({
    publishedCatalogs: published.length,
    indexedCatalogs: pageCatalogIds.size,
    indexedPages: pages.length,
    sampleMatches: result.size,
    sampleQueryMs: elapsedMs,
  }));
} finally {
  await deleteApp(app);
}
