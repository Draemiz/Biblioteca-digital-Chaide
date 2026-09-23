import fs from 'node:fs/promises';
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const dbPath = new URL('../data/db.json', import.meta.url);
const db = JSON.parse(await fs.readFile(dbPath, 'utf8'));
const stopWords = new Set(['catalogo', 'catalogos', 'de', 'del', 'la', 'las', 'los', 'y', 'chaide']);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function subjectFromTitle(title) {
  const subject = String(title || '')
    .replace(/^cat[aá]logo(?:\s+t[eé]cnico)?\s*(?:de\s+)?/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return subject || String(title || 'productos Chaide').trim();
}

function buildDescription(document) {
  const subject = subjectFromTitle(document.title);
  return `Catálogo digital de ${subject} de Chaide. Consulta productos, características, materiales, medidas y opciones disponibles.`;
}

function buildTags(document) {
  const words = normalize(`${document.title} ${document.category || ''}`)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !stopWords.has(word) && !/^20\d{2}$/.test(word));
  return Array.from(new Set([...(document.tags || []), ...words])).slice(0, 12);
}

const updates = [];
for (const document of db.documents || []) {
  const changes = {};
  if (!String(document.description || '').trim()) {
    document.description = buildDescription(document);
    changes.description = document.description;
  }
  if (!Array.isArray(document.tags) || document.tags.length === 0) {
    document.tags = buildTags(document);
    changes.tags = document.tags;
  }
  if (Object.keys(changes).length > 0) {
    document.metadataVersion = 'validated-v1';
    changes.metadataVersion = document.metadataVersion;
    updates.push({ id: document.id, title: document.title, changes });
  }
}

await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');

if (process.argv.includes('--firestore') && updates.length > 0) {
  const projectId = 'biblioteca-catalogos-chaide';
  const database = '(default)';
  const token = await getFirebaseCliAccessToken();
  const stringValue = (value) => ({ stringValue: String(value) });

  for (let start = 0; start < updates.length; start += 20) {
    const group = updates.slice(start, start + 20);
    const writes = group.map(({ id, changes }) => ({
      update: {
        name: `projects/${projectId}/databases/${database}/documents/documents/${id}`,
        fields: {
          description: stringValue(changes.description),
          tags: {
            arrayValue: {
              values: changes.tags.map(stringValue),
            },
          },
          metadataVersion: stringValue(changes.metadataVersion),
        },
      },
      updateMask: {
        fieldPaths: ['description', 'tags', 'metadataVersion'],
      },
    }));

    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${database}/documents:commit`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': projectId,
        },
        body: JSON.stringify({ writes }),
      },
    );
    if (!response.ok) throw new Error(`Firestore ${response.status}: ${await response.text()}`);
  }
}

console.log(JSON.stringify({
  updated: updates.length,
  firestore: process.argv.includes('--firestore'),
  documents: updates.map(({ id, title }) => ({ id, title })),
}, null, 2));
