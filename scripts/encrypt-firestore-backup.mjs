import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const keyPath = path.resolve('backups/private/firestore-backup-encryption.key');
const encryptionSecret = process.env.FIRESTORE_BACKUP_ENCRYPTION_KEY ||
  (await readFile(keyPath, 'utf8').catch(() => '')).trim();
if (!encryptionSecret) throw new Error('No existe la clave privada de cifrado del respaldo.');

const inputPath = path.resolve(
  process.env.FIRESTORE_BACKUP_FILE || 'backups/private/firestore-latest.json',
);
const outputDir = path.resolve(process.env.FIRESTORE_ENCRYPTED_BACKUP_DIR || 'backups/private/encrypted');
const plaintext = await readFile(inputPath);
const key = createHash('sha256').update(encryptionSecret, 'utf8').digest();
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();
const header = Buffer.from('CHAIDE-FIRESTORE-BACKUP-V1\0', 'ascii');
const payload = Buffer.concat([header, iv, tag, ciphertext]);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = path.join(outputDir, `firestore-${stamp}.json.enc`);

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, payload, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, encryptedBytes: payload.length }));
