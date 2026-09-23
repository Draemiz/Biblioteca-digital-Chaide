import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sodium from 'libsodium-wrappers';

const token = String(process.env.GITHUB_TOKEN || '').trim();
if (!token) throw new Error('Configura GITHUB_TOKEN para guardar el secreto cifrado.');

const owner = 'tapia10710';
const repository = 'chaide-digital-library';
const secretName = 'FIRESTORE_BACKUP_ENCRYPTION_KEY';
const keyPath = path.resolve('backups/private/firestore-backup-encryption.key');
await mkdir(path.dirname(keyPath), { recursive: true });
let secret = (await readFile(keyPath, 'utf8').catch(() => '')).trim();
if (!secret) {
  secret = randomBytes(48).toString('base64url');
  await writeFile(keyPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
}

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'chaide-backup-configurator',
};
const publicKeyResponse = await fetch(
  `https://api.github.com/repos/${owner}/${repository}/actions/secrets/public-key`,
  { headers },
);
if (!publicKeyResponse.ok) {
  throw new Error(`GitHub public key: ${publicKeyResponse.status} ${await publicKeyResponse.text()}`);
}
const publicKey = await publicKeyResponse.json();
await sodium.ready;
const encrypted = sodium.crypto_box_seal(
  sodium.from_string(secret),
  sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL),
);
const encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
const saveResponse = await fetch(
  `https://api.github.com/repos/${owner}/${repository}/actions/secrets/${secretName}`,
  {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encryptedValue, key_id: publicKey.key_id }),
  },
);
if (!saveResponse.ok) {
  throw new Error(`GitHub secret: ${saveResponse.status} ${await saveResponse.text()}`);
}
console.log(JSON.stringify({ repository: `${owner}/${repository}`, secretName, keyPath }));
