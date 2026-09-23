import { deleteApp, initializeApp } from 'firebase/app';
import { Bytes, collection, doc, getDoc, getDocs, getFirestore } from 'firebase/firestore';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { getFirebaseCliAccessToken } from './firebase-cli-auth.mjs';

const accessToken = await getFirebaseCliAccessToken();
const pdfBytes = new Uint8Array(
  await (await fetch('https://pdfobject.com/pdf/sample-3pp.pdf')).arrayBuffer(),
);

const databaseRoot =
  'projects/biblioteca-catalogos-chaide/databases/(default)';
const documentRoot = `${databaseRoot}/documents`;
const apiRoot = 'https://firestore.googleapis.com';
const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'x-goog-user-project': 'biblioteca-catalogos-chaide',
};
const catalogName = `${documentRoot}/documents/__viewer-smoke`;
const manifestName = `${documentRoot}/pdfFiles/__viewer-smoke`;
const chunkName = `${manifestName}/chunks/smoke-00000`;
const searchManifestName = `${documentRoot}/pdfSearchIndexes/__viewer-smoke`;
const searchPageName = `${searchManifestName}/pages/smoke-00001`;
const writes = [
  {
    update: {
      name: catalogName,
      fields: {
        id: { stringValue: '__viewer-smoke' },
        title: { stringValue: 'Prueba temporal del visor' },
        status: { stringValue: 'ready' },
        visibility: { stringValue: 'public' },
        isActive: { booleanValue: true },
      },
    },
  },
  {
    update: {
      name: manifestName,
      fields: {
        fileName: { stringValue: 'smoke.pdf' },
        mimeType: { stringValue: 'application/pdf' },
        size: { integerValue: String(pdfBytes.length) },
        chunkCount: { integerValue: '1' },
        version: { stringValue: 'smoke' },
      },
    },
  },
  {
    update: {
      name: searchManifestName,
      fields: {
        version: { stringValue: 'smoke' },
        pageCount: { integerValue: '1' },
        hasText: { booleanValue: true },
      },
    },
  },
  {
    update: {
      name: searchPageName,
      fields: {
        version: { stringValue: 'smoke' },
        pageNumber: { integerValue: '1' },
        text: { stringValue: 'colchón chaide prueba de búsqueda' },
      },
    },
  },
  {
    update: {
      name: chunkName,
      fields: {
        index: { integerValue: '0' },
        version: { stringValue: 'smoke' },
        data: { bytesValue: Buffer.from(pdfBytes).toString('base64') },
      },
    },
  },
];

const commit = await fetch(`${apiRoot}/v1/${databaseRoot}/documents:commit`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ writes }),
});
if (!commit.ok) throw new Error(`Firestore commit ${commit.status}: ${await commit.text()}`);

try {
  const app = initializeApp(firebaseConfig, 'viewer-smoke');
  const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  const [manifest, chunks, searchManifest, searchPages] = await Promise.all([
    getDoc(doc(db, 'pdfFiles', '__viewer-smoke')),
    getDocs(collection(db, 'pdfFiles', '__viewer-smoke', 'chunks')),
    getDoc(doc(db, 'pdfSearchIndexes', '__viewer-smoke')),
    getDocs(collection(db, 'pdfSearchIndexes', '__viewer-smoke', 'pages')),
  ]);
  const parts = chunks.docs
    .map((item) => item.data())
    .sort((a, b) => a.index - b.index)
    .map((item) => item.data instanceof Bytes ? item.data.toUint8Array() : new Uint8Array());
  const reconstructed = new Blob(parts, { type: 'application/pdf' });
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(await reconstructed.arrayBuffer()),
    disableWorker: true,
  }).promise;
  const result = {
    manifest: manifest.exists(),
    chunks: chunks.size,
    pages: pdf.numPages,
    searchIndex: searchManifest.exists() && searchPages.size === 1,
    integratedViewer:
      manifest.exists() &&
      chunks.size === 1 &&
      pdf.numPages === 3 &&
      searchManifest.exists() &&
      searchPages.size === 1,
  };
  await pdf.destroy();
  await deleteApp(app);

  const privateUpdate = await fetch(
    `${apiRoot}/v1/${catalogName}?updateMask.fieldPaths=visibility`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields: { visibility: { stringValue: 'private' } } }),
    },
  );
  if (!privateUpdate.ok) throw new Error(`No se pudo probar el borrador privado: ${await privateUpdate.text()}`);
  const anonymousPrivateRead = await fetch(`${apiRoot}/v1/${manifestName}`);
  result.privateDraftProtected = anonymousPrivateRead.status === 403;
  result.integratedViewer = result.integratedViewer && result.privateDraftProtected;
  console.log(JSON.stringify(result));
  if (!result.integratedViewer) process.exitCode = 1;
} finally {
  for (const name of [searchPageName, searchManifestName, chunkName, manifestName, catalogName]) {
    await fetch(`${apiRoot}/v1/${name}`, { method: 'DELETE', headers });
  }
}
