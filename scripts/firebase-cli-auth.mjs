import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function findFirebaseTools() {
  if (process.env.FIREBASE_TOOLS_PATH) return process.env.FIREBASE_TOOLS_PATH;

  try {
    return path.dirname(require.resolve('firebase-tools/package.json'));
  } catch {
    // Firebase CLI is commonly installed in npm's temporary npx cache.
  }

  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
    process.env.HOME && path.join(process.env.HOME, '.npm', '_npx'),
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const directory of fs.readdirSync(root)) {
      const candidate = path.join(root, directory, 'node_modules', 'firebase-tools');
      if (fs.existsSync(candidate)) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates[0]) {
    throw new Error('No se encontró Firebase CLI. Ejecuta primero: npx firebase-tools login');
  }
  return candidates[0];
}

export async function getFirebaseCliAccessToken() {
  // GitHub Actions authenticates through Application Default Credentials.
  // Prefer that short-lived token in CI; keep Firebase CLI login as the local
  // developer fallback.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_GHA_CREDS_PATH) {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (token?.token) return token.token;
    throw new Error('Las credenciales de Google no entregaron un token válido.');
  }

  const toolsPath = findFirebaseTools();
  const configstore = require(path.join(toolsPath, 'lib', 'configstore.js')).configstore;
  const firebaseAuth = require(path.join(toolsPath, 'lib', 'auth.js'));
  const refreshToken = configstore.get('tokens')?.refresh_token;
  if (!refreshToken) throw new Error('Inicia sesión con Firebase CLI antes de continuar.');
  const token = await firebaseAuth.getAccessToken(refreshToken, []);
  const accessToken = token.access_token || token.accessToken;
  if (!accessToken) throw new Error('Firebase CLI no entregó un token válido.');
  return accessToken;
}
