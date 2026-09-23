import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  Bytes,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };

const [documentId, outputPath] = process.argv.slice(2);
if (!documentId || !outputPath) {
  throw new Error('Uso: node scripts/download-firestore-document.mjs <documentId> <salida.pdf>');
}

const app = initializeApp(firebaseConfig, `download-firestore-${Date.now()}`);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

try {
  const documentSnapshot = await getDoc(doc(db, 'documents', documentId));
  if (!documentSnapshot.exists()) throw new Error('El catálogo no existe.');
  const documentData = documentSnapshot.data();
  const version = String(documentData.storageVersion || '');
  if (!version) throw new Error('El catálogo no tiene una versión del visor registrada.');

  const manifestSnapshot = await getDoc(doc(db, 'pdfFiles', documentId, 'versions', version));
  if (!manifestSnapshot.exists()) throw new Error('No existe el manifiesto de la versión publicada.');
  const manifest = manifestSnapshot.data();
  const chunkSnapshot = await getDocs(query(
    collection(db, 'pdfFiles', documentId, 'chunks'),
    where('version', '==', version),
  ));
  const chunks = chunkSnapshot.docs
    .map((item) => item.data())
    .sort((left, right) => Number(left.index) - Number(right.index));
  const expectedChunks = Number(manifest.chunkCount || 0);
  if (!chunks.length || chunks.length !== expectedChunks) {
    throw new Error(`La versión está incompleta (${chunks.length}/${expectedChunks} bloques).`);
  }
  chunks.forEach((chunk, index) => {
    if (Number(chunk.index) !== index || !(chunk.data instanceof Bytes)) {
      throw new Error(`El bloque ${index} no es válido.`);
    }
  });

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data.toUint8Array())));
  const expectedBytes = Number(manifest.size || 0);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || (expectedBytes && bytes.length !== expectedBytes)) {
    throw new Error('El PDF publicado no superó la verificación de integridad.');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  console.log(JSON.stringify({
    documentId,
    version,
    bytes: bytes.length,
    chunkCount: chunks.length,
    viewerOptimization: documentData.viewerOptimization || null,
    outputPath,
  }));
} finally {
  await deleteApp(app);
}
