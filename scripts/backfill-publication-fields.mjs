import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const { projectId, firestoreDatabaseId = '(default)' } = firebaseConfig;
const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(firestoreDatabaseId)}/documents`;
const accessToken = await getFirebaseCliAccessToken();
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `${response.status} ${response.statusText}`);
  return body;
}

let pageToken = '';
let inspected = 0;
let updated = 0;
do {
  const query = new URLSearchParams({ pageSize: '100' });
  if (pageToken) query.set('pageToken', pageToken);
  const page = await request(`${base}/documents?${query}`);
  for (const document of page.documents || []) {
    inspected += 1;
    const fields = document.fields || {};
    const patchFields = {};
    const visibility = String(fields.visibility?.stringValue || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (!visibility || visibility === 'publico') patchFields.visibility = { stringValue: 'public' };
    if (visibility === 'privado') patchFields.visibility = { stringValue: 'private' };
    if (!fields.isActive) patchFields.isActive = { booleanValue: true };
    const names = Object.keys(patchFields);
    if (!names.length) continue;
    const masks = names.map((name) => `updateMask.fieldPaths=${encodeURIComponent(name)}`).join('&');
    await request(`https://firestore.googleapis.com/v1/${document.name}?${masks}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: patchFields }),
    });
    updated += 1;
  }
  pageToken = page.nextPageToken || '';
} while (pageToken);

console.log(JSON.stringify({ inspected, updated, defaults: { visibility: 'public', isActive: true } }));
