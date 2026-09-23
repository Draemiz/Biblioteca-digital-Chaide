import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const projectId = firebaseConfig.projectId;
const accountId = 'github-actions-hosting';
const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
const outputDir = path.resolve('backups', 'private');
const outputPath = path.join(outputDir, 'firebase-github-service-account.json');
const requiredRoles = [
  'roles/firebasehosting.admin',
  'roles/firebaserules.admin',
  'roles/datastore.viewer',
  'roles/serviceusage.serviceUsageConsumer',
];

await mkdir(outputDir, { recursive: true });

let hasLocalKey = false;
try {
  const existing = JSON.parse(await readFile(outputPath, 'utf8'));
  hasLocalKey = existing?.client_email === email && Boolean(existing?.private_key);
} catch {
  // Create the key below when no valid local private copy exists.
}

const accessToken = await getFirebaseCliAccessToken();
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'x-goog-user-project': projectId,
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function ensureService(serviceName) {
  const project = await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`);
  const operation = await request(
    `https://serviceusage.googleapis.com/v1/projects/${project.projectNumber}/services/${serviceName}:enable`,
    { method: 'POST', body: '{}' },
  );
  if (operation.done || !operation.name || operation.name === 'DONE_OPERATION') return;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await request(`https://serviceusage.googleapis.com/v1/${operation.name}`);
    if (status.done) {
      if (status.error) throw new Error(status.error.message || `No se pudo habilitar ${serviceName}.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`La activación de ${serviceName} no terminó a tiempo.`);
}

await ensureService('iam.googleapis.com');

try {
  await request(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`, {
    method: 'POST',
    body: JSON.stringify({ accountId, serviceAccount: { displayName: 'GitHub Actions Firebase Hosting' } }),
  });
} catch (error) {
  if (error.status !== 409) throw error;
}

const policy = await request(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`,
  { method: 'POST', body: '{}' },
);
policy.bindings ||= [];
const member = `serviceAccount:${email}`;
for (const role of requiredRoles) {
  let binding = policy.bindings.find((item) => item.role === role && !item.condition);
  if (!binding) {
    binding = { role, members: [] };
    policy.bindings.push(binding);
  }
  binding.members ||= [];
  if (!binding.members.includes(member)) binding.members.push(member);
}

await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:setIamPolicy`, {
  method: 'POST',
  body: JSON.stringify({ policy }),
});

if (hasLocalKey) {
  console.log(JSON.stringify({ outputPath, email, reused: true, roles: requiredRoles }));
  process.exit(0);
}

if (process.env.CREATE_LOCAL_FIREBASE_KEY !== '1') {
  console.log(JSON.stringify({
    outputPath,
    email,
    reused: false,
    keyCreated: false,
    roles: requiredRoles,
    note: 'Permisos reconciliados. Usa CREATE_LOCAL_FIREBASE_KEY=1 solo para crear una clave inicial.',
  }));
  process.exit(0);
}

const key = await request(
  `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${encodeURIComponent(email)}/keys`,
  {
    method: 'POST',
    body: JSON.stringify({
      privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE',
      keyAlgorithm: 'KEY_ALG_RSA_2048',
    }),
  },
);
if (!key.privateKeyData) throw new Error('IAM no devolvió la clave privada de la cuenta de servicio.');
const credentials = Buffer.from(key.privateKeyData, 'base64').toString('utf8');
await writeFile(outputPath, `${credentials.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify({ outputPath, email, reused: false, roles: requiredRoles }));
