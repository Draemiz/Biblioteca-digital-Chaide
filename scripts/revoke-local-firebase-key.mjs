import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const keyPath = path.resolve('backups/private/firebase-github-service-account.json');
const credentials = JSON.parse(await readFile(keyPath, 'utf8'));
if (!credentials.client_email || !credentials.private_key_id || !credentials.project_id) {
  throw new Error('La clave local no contiene los identificadores necesarios.');
}

const accessToken = await getFirebaseCliAccessToken();
const keyName = `projects/${credentials.project_id}/serviceAccounts/${encodeURIComponent(credentials.client_email)}/keys/${credentials.private_key_id}`;
const response = await fetch(`https://iam.googleapis.com/v1/${keyName}`, {
  method: 'DELETE',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'x-goog-user-project': credentials.project_id,
  },
});
if (!response.ok && response.status !== 404) {
  throw new Error(`IAM respondió ${response.status}: ${await response.text()}`);
}
await unlink(keyPath).catch(() => undefined);
console.log(JSON.stringify({ revoked: true, localFileDeleted: true, serviceAccount: credentials.client_email }));
