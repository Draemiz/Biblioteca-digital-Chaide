import { createDecipheriv, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const inputArgument = process.argv[2];
if (!inputArgument) throw new Error('Uso: npm run backup:decrypt -- ruta/al/respaldo.json.enc');
const keyPath = path.resolve('backups/private/firestore-backup-encryption.key');
const encryptionSecret = process.env.FIRESTORE_BACKUP_ENCRYPTION_KEY ||
  (await readFile(keyPath, 'utf8').catch(() => '')).trim();
if (!encryptionSecret) throw new Error('No existe la clave privada de descifrado del respaldo.');

const header = Buffer.from('CHAIDE-FIRESTORE-BACKUP-V1\0', 'ascii');
const payload = await readFile(path.resolve(inputArgument));
if (!payload.subarray(0, header.length).equals(header)) {
  throw new Error('El archivo no es un respaldo cifrado compatible.');
}

let offset = header.length;
const iv = payload.subarray(offset, offset += 12);
const tag = payload.subarray(offset, offset += 16);
const ciphertext = payload.subarray(offset);
const key = createHash('sha256').update(encryptionSecret, 'utf8').digest();
const decipher = createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
const outputDir = path.resolve('backups/private/restored');
const outputPath = path.join(outputDir, 'firestore-restored.json');

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, plaintext, { mode: 0o600 });
console.log(JSON.stringify({ outputPath, restoredBytes: plaintext.length }));
