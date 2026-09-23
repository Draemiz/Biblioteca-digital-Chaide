import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import fs from 'fs';
import path from 'path';

const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
let config: any = {};
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export const adminApp = !getApps().length
  ? initializeApp({
      credential: applicationDefault(),
      projectId: config.projectId,
      storageBucket: config.storageBucket
    })
  : getApps()[0];

export const db = config.firestoreDatabaseId ? getFirestore(adminApp, config.firestoreDatabaseId) : getFirestore(adminApp);
export const storage = getStorage(adminApp);
export const bucket = storage.bucket(config.storageBucket);
