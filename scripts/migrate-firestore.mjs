import fs from 'node:fs';
import path from 'node:path';
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const projectId = 'biblioteca-catalogos-chaide';
const databaseId = '(default)';
const root = process.cwd();
const accessToken = await getFirebaseCliAccessToken();

const source = JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));

function clean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

const documents = (source.documents || [])
  .filter((item) => !item.isDeleted && item.status === 'ready')
  .map(({ searchIndex, ...item }) => clean({
    ...item,
    isActive: item.isActive !== false,
    visibility: item.visibility || 'public',
  }));
const categories = (source.categories || [])
  .filter((item) => item.active !== false)
  .map((item) => clean({ ...item, active: true }));

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(firestoreValue) } };
  }
  if (typeof value === 'object') {
    return { mapValue: { fields: firestoreFields(value) } };
  }
  throw new Error(`Tipo Firestore no soportado: ${typeof value}`);
}

function firestoreFields(value) {
  return Object.fromEntries(
    Object.entries(clean(value)).map(([key, item]) => [key, firestoreValue(item)]),
  );
}

function write(collectionName, id, value) {
  return {
    update: {
      name: `projects/${projectId}/databases/${databaseId}/documents/${collectionName}/${id}`,
      fields: firestoreFields(value),
    },
  };
}

const writes = [
  ...documents.map((item) => write('documents', item.id, item)),
  ...categories.map((item) => write('categories', item.id, item)),
];
if (source.promotionalBanner) {
  writes.push(write('settings', 'promotional-banner', clean(source.promotionalBanner)));
}

const response = await fetch(
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents:commit`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': projectId,
    },
    body: JSON.stringify({ writes }),
  },
);
if (!response.ok) {
  const error = await response.json().catch(() => null);
  throw new Error(error?.error?.message || `Firestore respondió ${response.status}.`);
}
console.log(`Migración terminada: ${documents.length} documentos y ${categories.length} categorías.`);
