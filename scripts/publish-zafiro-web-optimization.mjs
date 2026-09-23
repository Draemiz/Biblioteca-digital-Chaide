import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const documentId = 'upload-1779203272815-cyn7t';
const fileUrl = '/storage/pdfs/upload-1779203272815-cyn7t.pdf?v=20260721-web2&fastImageDecoder=1';
const fileSize = 3_646_618;
const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
const accessToken = await getFirebaseCliAccessToken();
const endpoint = new URL(
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/documents/${documentId}`,
);
for (const field of ['fileUrl', 'fileSize', 'linearized', 'updatedAt']) {
  endpoint.searchParams.append('updateMask.fieldPaths', field);
}

const response = await fetch(endpoint, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'x-goog-user-project': projectId,
  },
  body: JSON.stringify({
    fields: {
      fileUrl: { stringValue: fileUrl },
      fileSize: { integerValue: String(fileSize) },
      linearized: { booleanValue: false },
      updatedAt: { timestampValue: new Date().toISOString() },
    },
  }),
});

if (!response.ok) {
  throw new Error(`Firestore ${response.status}: ${await response.text()}`);
}

const payload = await response.json();
console.log(JSON.stringify({
  documentId,
  fileUrl: payload.fields?.fileUrl?.stringValue,
  fileSize: Number(payload.fields?.fileSize?.integerValue || 0),
  updatedAt: payload.fields?.updatedAt?.timestampValue,
}));
