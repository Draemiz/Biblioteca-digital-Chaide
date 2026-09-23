import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const projectId = 'biblioteca-catalogos-chaide';
const email = 'catalogoschaide+chaide2026@gmail.com';
const displayName = 'Chaide2026';
const password = process.env.FIREBASE_ADMIN_PASSWORD;

if (!password) throw new Error('Falta FIREBASE_ADMIN_PASSWORD.');
if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');

const accessToken = await getFirebaseCliAccessToken();
const adminHeaders = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'x-goog-user-project': projectId,
};

const configResponse = await fetch(
  `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired`,
  {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({
      signIn: {
        email: {
          enabled: true,
          passwordRequired: true,
        },
      },
    }),
  },
);
if (!configResponse.ok) {
  throw new Error(`No se pudo habilitar Email/Password: ${await configResponse.text()}`);
}

const lookup = await fetch(
  `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
  {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email: [email] }),
  },
);
const lookupData = await lookup.json().catch(() => ({}));
if (!lookup.ok && lookup.status !== 404) {
  throw new Error(lookupData?.error?.message || `Lookup respondió ${lookup.status}.`);
}

const existing = lookupData.users?.[0];
if (existing?.localId) {
  const update = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        localId: existing.localId,
        email,
        password,
        displayName,
        emailVerified: true,
      }),
    },
  );
  if (!update.ok) throw new Error(`No se pudo actualizar el administrador: ${await update.text()}`);
} else {
  const create = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`,
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        email,
        password,
        displayName,
        emailVerified: true,
        targetProjectId: projectId,
      }),
    },
  );
  if (!create.ok) throw new Error(`No se pudo crear el administrador: ${await create.text()}`);
}

const signIn = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  },
);
const signInData = await signIn.json().catch(() => ({}));
if (!signIn.ok || !signInData.idToken) {
  throw new Error(signInData?.error?.message || 'La verificación de acceso falló.');
}

const smokeDocument =
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/documents/__auth-smoke`;
const smokeHeaders = {
  Authorization: `Bearer ${signInData.idToken}`,
  'Content-Type': 'application/json',
};
const smokeWrite = await fetch(smokeDocument, {
  method: 'PATCH',
  headers: smokeHeaders,
  body: JSON.stringify({
    fields: {
      title: { stringValue: 'Verificación temporal de autenticación' },
      status: { stringValue: 'processing' },
      isActive: { booleanValue: false },
    },
  }),
});
if (!smokeWrite.ok) {
  throw new Error(`El acceso no pudo escribir en Firestore: ${await smokeWrite.text()}`);
}
const smokeDelete = await fetch(smokeDocument, {
  method: 'DELETE',
  headers: smokeHeaders,
});
if (!smokeDelete.ok) {
  throw new Error(`No se pudo limpiar la verificación temporal: ${await smokeDelete.text()}`);
}

console.log('Administrador Firebase configurado; acceso y permisos verificados.');
