import {
  Bytes,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import type { DocumentDef } from './mockData';
import { buildCatalogSearchTokens } from './catalogSearchTokens';
import { del as deleteCachedValue, get as getCachedValue, set as setCachedValue } from 'idb-keyval';

export const FIREBASE_ADMIN_EMAIL =
  (import.meta.env.VITE_FIREBASE_ADMIN_EMAIL || 'catalogoschaide+chaide2026@gmail.com')
    .trim()
    .toLowerCase();
export const FIREBASE_ADMIN_USERNAME =
  (import.meta.env.VITE_FIREBASE_ADMIN_USERNAME || 'Chaide2026').trim();

type CategoryLike = {
  parentId?: string | null;
  id: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  imageUrl?: string;
  order?: number;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type BannerLike = {
  imageUrl: string;
  mobileImageUrl?: string;
  mobileIsActive?: boolean;
  altText: string;
  targetUrl?: string;
  isActive: boolean;
  updatedAt?: string;
};

function withoutUndefined<T extends object>(value: T): T {
  const sanitize = (fieldValue: unknown): unknown => {
    if (fieldValue === undefined) return undefined;
    if (Array.isArray(fieldValue)) {
      return fieldValue
        .map(sanitize)
        .filter((item) => item !== undefined);
    }
    if (
      fieldValue !== null &&
      typeof fieldValue === 'object' &&
      Object.getPrototypeOf(fieldValue) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(fieldValue)
          .map(([key, item]) => [key, sanitize(item)] as const)
          .filter(([, item]) => item !== undefined),
      );
    }
    return fieldValue;
  };
  return sanitize(value) as T;
}

function normalizeSnapshot<T>(
  snapshot: { id: string; data: () => Record<string, unknown> },
): T & { id: string } {
  const value = snapshot.data();
  return {
    ...value,
    id: snapshot.id,
    createdAt: (value.createdAt as { toDate?: () => Date })?.toDate?.().toISOString?.() || value.createdAt,
    updatedAt: (value.updatedAt as { toDate?: () => Date })?.toDate?.().toISOString?.() || value.updatedAt,
  } as unknown as T & { id: string };
}

export function isFirebaseAdminEmail(email?: string | null) {
  return Boolean(email && email.trim().toLowerCase() === FIREBASE_ADMIN_EMAIL);
}

async function recordAdminAudit(action: string, targetId: string, details: Record<string, unknown> = {}) {
  const user = auth.currentUser;
  if (!user || !isFirebaseAdminEmail(user.email)) return;
  try {
    await setDoc(doc(db, 'auditLogs', crypto.randomUUID()), withoutUndefined({
      action,
      targetId,
      details,
      actorUid: user.uid,
      actorEmail: user.email,
      createdAt: serverTimestamp(),
    }));
  } catch (error) {
    console.warn('[Audit] No se pudo registrar la acción administrativa.', error);
  }
}

export async function fetchFirebaseDocuments(isAdmin = false): Promise<DocumentDef[]> {
  const source = isAdmin
    ? collection(db, 'documents')
    : query(
      collection(db, 'documents'),
      where('status', '==', 'ready'),
      where('isActive', '==', true),
      where('visibility', '==', 'public'),
    );
  const snapshot = await getDocs(source);
  return snapshot.docs
    .map((item) => normalizeSnapshot<DocumentDef>(item))
    .filter((item) => isAdmin || (
      item.status === 'ready' &&
      item.isActive !== false &&
      item.visibility !== 'private'
    ));
}

/**
 * Keeps the catalogue list current in already-open browser tabs. Deletions are
 * hidden by the public query as soon as their visibility/status changes, while
 * replacements arrive with a new searchIndexVersion that invalidates old
 * assistant and search caches.
 */
export async function subscribeFirebaseDocuments(
  isAdmin: boolean,
  onDocuments: (documents: DocumentDef[]) => void,
  onError?: (error: Error) => void,
) {
  await auth.authStateReady();
  const canReadAdmin = isAdmin && isFirebaseAdminEmail(auth.currentUser?.email);
  const source = canReadAdmin
    ? collection(db, 'documents')
    : query(
      collection(db, 'documents'),
      where('status', '==', 'ready'),
      where('isActive', '==', true),
      where('visibility', '==', 'public'),
    );

  return onSnapshot(source, (snapshot) => {
    const documents = snapshot.docs
      .map((item) => normalizeSnapshot<DocumentDef>(item))
      .filter((item) => canReadAdmin || (
        item.status === 'ready' &&
        item.isActive !== false &&
        item.visibility !== 'private'
      ));
    onDocuments(documents);
  }, (error) => onError?.(error));
}

export async function fetchFirebaseDocument(
  id: string,
  isAdmin = false,
): Promise<DocumentDef | null> {
  const snapshot = await getDoc(doc(db, 'documents', id));
  if (!snapshot.exists()) return null;
  const item = normalizeSnapshot<DocumentDef>(snapshot);
  if (!isAdmin && (
    item.status !== 'ready' ||
    item.isActive === false ||
    item.visibility === 'private'
  )) return null;
  return item;
}

export async function saveFirebaseDocument(id: string, value: Partial<DocumentDef>) {
  const target = doc(db, 'documents', id);
  const currentSnapshot = await getDoc(target);
  const exists = currentSnapshot.exists();
  const current = currentSnapshot.data() || {};
  const currentPubliclySearchable =
    exists &&
    current.status === 'ready' &&
    current.isActive !== false &&
    current.visibility !== 'private';
  const publiclySearchable =
    (value.status ?? current.status) === 'ready' &&
    (value.isActive ?? current.isActive) !== false &&
    (value.visibility ?? current.visibility) !== 'private';
  const searchVersionChanged = Boolean(
    value.searchIndexVersion && value.searchIndexVersion !== current.searchIndexVersion,
  );
  const searchVisibilityChanged = currentPubliclySearchable !== publiclySearchable;
  const needsSearchPromotion = publiclySearchable &&
    (!exists || searchVisibilityChanged || searchVersionChanged);

  // Hide search pages before making a catalogue private. Publishing works in
  // the opposite order: metadata first, pages second, so draft text is never
  // exposed before the catalogue itself is public.
  const hidesPreviouslyPublicSearch = exists && searchVisibilityChanged && !publiclySearchable;
  if (hidesPreviouslyPublicSearch) {
    await syncGlobalSearchVisibility(id, false);
  }
  try {
    await setDoc(target, withoutUndefined({
      ...value,
      id,
      updatedAt: serverTimestamp(),
      ...(exists ? {} : { createdAt: serverTimestamp() }),
      ...(needsSearchPromotion ? { searchVisibilityStatus: 'pending' } : {}),
      ...(searchVisibilityChanged && !publiclySearchable
        ? { searchVisibilityStatus: deleteField() }
        : {}),
    }), { merge: true });
  } catch (error) {
    if (hidesPreviouslyPublicSearch) {
      try {
        await syncGlobalSearchVisibility(id, true);
      } catch {
        await setDoc(doc(db, 'maintenanceTasks', `search-visibility-${id}`), {
          type: 'search-visibility',
          documentId: id,
          isPublic: true,
          status: 'pending',
          updatedAt: serverTimestamp(),
        }).catch(() => undefined);
      }
    }
    throw error;
  }
  await recordAdminAudit(exists ? 'document.update' : 'document.create', id, {
    fields: Object.keys(value),
  });
  if (needsSearchPromotion) {
    try {
      await syncGlobalSearchVisibility(id, true);
      await setDoc(target, {
        searchVisibilityStatus: deleteField(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      await deleteDoc(doc(db, 'maintenanceTasks', `search-visibility-${id}`)).catch(() => undefined);
    } catch (error) {
      // The document and PDF are already valid. Keep them published, leave the
      // search pages private, and persist a safe retry instead of making the
      // publication rollback a version that is already referenced.
      await setDoc(doc(db, 'maintenanceTasks', `search-visibility-${id}`), {
        type: 'search-visibility',
        documentId: id,
        isPublic: true,
        status: 'pending',
        updatedAt: serverTimestamp(),
      }).catch(() => undefined);
      console.warn('[Search] La visibilidad del índice se reintentará durante el mantenimiento.', error);
    }
  }
}

async function syncGlobalSearchVisibility(id: string, publiclySearchable: boolean) {
  const snapshot = await getDocs(query(
    collection(db, 'catalogSearchPages'),
    where('catalogId', '==', id),
  ));
  for (let start = 0; start < snapshot.docs.length; start += 10) {
    await Promise.all(snapshot.docs.slice(start, start + 10).map((page) =>
      setDoc(page.ref, { isPublic: publiclySearchable }, { merge: true })));
  }
}

export async function deleteFirebaseDocument(id: string) {
  const documentSnapshot = await getDoc(doc(db, 'documents', id));
  if (documentSnapshot.exists()) {
    // Hide the catalogue first. If a later cleanup step is interrupted, no
    // partially deleted PDF or draft metadata remains visible to visitors.
    await setDoc(doc(db, 'documents', id), {
      visibility: 'private',
      isActive: false,
      status: 'processing',
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await syncGlobalSearchVisibility(id, false);
  }

  const chunks = await getDocs(collection(db, 'pdfFiles', id, 'chunks'));
  const versions = await getDocs(collection(db, 'pdfFiles', id, 'versions'));
  const searchPages = await getDocs(collection(db, 'pdfSearchIndexes', id, 'pages'));
  const globalSearchPages = await getDocs(query(
    collection(db, 'catalogSearchPages'),
    where('catalogId', '==', id),
  ));
  await deleteDocumentRefsInGroups(chunks.docs.map((item) => item.ref));
  await deleteDocumentRefsInGroups(versions.docs.map((item) => item.ref));
  await deleteDocumentRefsInGroups(searchPages.docs.map((item) => item.ref));
  await deleteDocumentRefsInGroups(globalSearchPages.docs.map((item) => item.ref));
  await deleteDoc(doc(db, 'pdfFiles', id)).catch(() => undefined);
  await deleteDoc(doc(db, 'pdfSearchIndexes', id)).catch(() => undefined);

  await deleteDoc(doc(db, 'documents', id));
  await recordAdminAudit('document.delete', id);
}

async function deleteDocumentRefsInGroups(refs: Array<{ path: string }>) {
  for (let start = 0; start < refs.length; start += 10) {
    await Promise.all(refs.slice(start, start + 10).map((reference) =>
      deleteDoc(doc(db, reference.path))));
  }
}

export async function runFirebaseMaintenance() {
  const summary = {
    searchVisibilityPending: 0,
    catalogCleanupsCompleted: 0,
    orphanManifestsDeleted: 0,
  };

  const tasks = await getDocs(collection(db, 'maintenanceTasks'));
  for (const task of tasks.docs) {
    const data = task.data();
    if (data.type === 'search-visibility') {
      try {
        const documentId = String(data.documentId || '');
        const target = doc(db, 'documents', documentId);
        const targetSnapshot = await getDoc(target);
        if (targetSnapshot.exists()) {
          await syncGlobalSearchVisibility(documentId, data.isPublic === true);
          await setDoc(target, {
            searchVisibilityStatus: deleteField(),
            updatedAt: serverTimestamp(),
          }, { merge: true });
        }
        await deleteDoc(task.ref);
        summary.catalogCleanupsCompleted += 1;
      } catch {
        summary.searchVisibilityPending += 1;
      }
      continue;
    }
  }

  const documents = await getDocs(collection(db, 'documents'));
  for (const item of documents.docs) {
    const data = item.data();
    if (data.searchVisibilityStatus === 'pending') {
      try {
        await syncGlobalSearchVisibility(item.id, true);
        await setDoc(item.ref, {
          searchVisibilityStatus: deleteField(),
          updatedAt: serverTimestamp(),
        }, { merge: true });
        await deleteDoc(doc(db, 'maintenanceTasks', `search-visibility-${item.id}`)).catch(() => undefined);
        summary.catalogCleanupsCompleted += 1;
      } catch {
        // Keep the pending marker for the next safe maintenance attempt.
      }
    }
    if (data.maintenanceStatus !== 'cleanup-pending') continue;
    const storageVersion = String(data.storageVersion || '');
    const searchVersion = String(data.searchIndexVersion || '');
    const results = await Promise.allSettled([
      storageVersion ? finalizePdfVersion(item.id, storageVersion) : Promise.resolve(),
      searchVersion ? cleanupPdfSearchIndex(item.id, searchVersion) : Promise.resolve(),
    ]);
    if (results.every((result) => result.status === 'fulfilled')) {
      await setDoc(item.ref, {
        maintenanceStatus: deleteField(),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      summary.catalogCleanupsCompleted += 1;
    }
  }

  const documentIds = new Set(documents.docs.map((item) => item.id));
  const [pdfManifests, searchManifests, globalSearchPages] = await Promise.all([
    getDocs(collection(db, 'pdfFiles')),
    getDocs(collection(db, 'pdfSearchIndexes')),
    getDocs(collection(db, 'catalogSearchPages')),
  ]);
  for (const manifest of pdfManifests.docs) {
    if (documentIds.has(manifest.id)) continue;
    const [orphanChunks, orphanVersions] = await Promise.all([
      getDocs(collection(db, 'pdfFiles', manifest.id, 'chunks')),
      getDocs(collection(db, 'pdfFiles', manifest.id, 'versions')),
    ]);
    await deleteDocumentRefsInGroups(orphanChunks.docs.map((item) => item.ref));
    await deleteDocumentRefsInGroups(orphanVersions.docs.map((item) => item.ref));
    await deleteDoc(manifest.ref);
    summary.orphanManifestsDeleted += 1;
  }
  for (const manifest of searchManifests.docs) {
    if (documentIds.has(manifest.id)) continue;
    const orphanPages = await getDocs(collection(db, 'pdfSearchIndexes', manifest.id, 'pages'));
    await deleteDocumentRefsInGroups(orphanPages.docs.map((item) => item.ref));
    await deleteDoc(manifest.ref);
    summary.orphanManifestsDeleted += 1;
  }
  const orphanGlobalPages = globalSearchPages.docs.filter(
    (page) => !documentIds.has(String(page.data().catalogId || '')),
  );
  await deleteDocumentRefsInGroups(orphanGlobalPages.map((page) => page.ref));
  summary.orphanManifestsDeleted += orphanGlobalPages.length;

  if (Object.values(summary).some((value) => value > 0)) {
    await recordAdminAudit('maintenance.run', 'firebase', summary);
  }
  return summary;
}

export async function fetchFirebaseCategories(isAdmin = false): Promise<CategoryLike[]> {
  const snapshot = await getDocs(collection(db, 'categories'));
  return snapshot.docs
    .map((item) => normalizeSnapshot<CategoryLike>(item))
    .filter((item) => isAdmin || item.active !== false)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
}

export async function saveFirebaseCategory(id: string, value: Partial<CategoryLike>) {
  const target = doc(db, 'categories', id);
  const previous = await getDoc(target);
  const exists = previous.exists();
  await setDoc(target, withoutUndefined({
    ...value,
    id,
    active: value.active !== false,
    updatedAt: serverTimestamp(),
    ...(exists ? {} : { createdAt: serverTimestamp() }),
  }), { merge: true });
  await recordAdminAudit(exists ? 'category.update' : 'category.create', id);
}

export async function deleteFirebaseCategory(id: string) {
  await deleteDoc(doc(db, 'categories', id));
  await recordAdminAudit('category.delete', id);
}

export async function fetchFirebaseBanner(): Promise<BannerLike | null> {
  const snapshot = await getDoc(doc(db, 'settings', 'promotional-banner'));
  return snapshot.exists() ? (snapshot.data() as BannerLike) : null;
}

export async function saveFirebaseBanner(value: BannerLike) {
  const target = doc(db, 'settings', 'promotional-banner');
  await setDoc(target, {
    ...withoutUndefined(value),
    updatedAt: serverTimestamp(),
  }, { merge: true });
  await recordAdminAudit('banner.update', 'promotional-banner');
}

export type FirebasePdfUploadResult = {
  url: string;
  version: string;
  chunkCount: number;
};

const PDF_CHUNK_BYTES = 700 * 1024;
const PDF_CACHE_INDEX_KEY = 'chaide_firestore_pdf_cache_v1';

async function cacheFirestorePdf(key: string, bytes: Uint8Array) {
  try {
    const index = (await getCachedValue<Array<{ key: string; usedAt: number }>>(PDF_CACHE_INDEX_KEY)) || [];
    const next = index.filter((entry) => entry.key !== key);
    next.push({ key, usedAt: Date.now() });
    while (next.length > 2) {
      const oldest = next.shift();
      if (oldest) await deleteCachedValue(oldest.key);
    }
    await setCachedValue(key, bytes);
    await setCachedValue(PDF_CACHE_INDEX_KEY, next);
  } catch {
    // IndexedDB can be unavailable in private browsing. The viewer still works
    // with its in-memory object URL in that case.
  }
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export type FirebasePdfSearchPage = {
  pageNumber: number;
  text: string;
};

export type FirebaseGlobalSearchPage = FirebasePdfSearchPage & {
  catalogId: string;
  version: string;
};

export async function uploadPdfSearchIndex(
  id: string,
  pages: FirebasePdfSearchPage[],
  version: string,
  onProgress?: (progress: number) => void,
) {
  try {
    for (let start = 0; start < pages.length; start += 10) {
      const group = pages.slice(start, start + 10);
      await Promise.all(group.flatMap((page) => {
        const pageSuffix = String(page.pageNumber).padStart(5, '0');
        const pageData = {
          catalogId: id,
          version,
          pageNumber: page.pageNumber,
          text: page.text,
          tokens: buildCatalogSearchTokens(page.text),
          // Publication metadata is committed only after both the PDF and its
          // index exist. saveFirebaseDocument promotes these pages afterwards.
          isPublic: false,
        };
        return [
          setDoc(
            doc(db, 'pdfSearchIndexes', id, 'pages', `${version}-${pageSuffix}`),
            {
              version,
              pageNumber: page.pageNumber,
              text: page.text,
            },
          ),
          setDoc(doc(db, 'catalogSearchPages', `${id}__${version}__${pageSuffix}`), pageData),
        ];
      }));
      onProgress?.(Math.round((Math.min(start + group.length, pages.length) / Math.max(pages.length, 1)) * 100));
    }

    await setDoc(doc(db, 'pdfSearchIndexes', id), {
      version,
      pageCount: pages.length,
      hasText: pages.some((page) => page.text.trim().length > 0),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    return version;
  } catch (error) {
    await discardPdfSearchIndexVersion(id, version).catch(() => undefined);
    throw error;
  }
}

/** One indexed query replaces loading every catalogue index in a fresh browser. */
export async function searchFirebaseCatalogPages(
  queryTokens: string[],
  maximumResults = 750,
): Promise<FirebaseGlobalSearchPage[]> {
  const tokens = Array.from(new Set(queryTokens.flatMap(buildCatalogSearchTokens))).slice(0, 10);
  if (!tokens.length) return [];
  const [metadata, snapshot] = await Promise.all([
    getDoc(doc(db, 'catalogSearchMeta', 'current')),
    getDocs(query(
      collection(db, 'catalogSearchPages'),
      where('tokens', 'array-contains-any', tokens),
      where('isPublic', '==', true),
      limit(Math.max(1, Math.min(maximumResults, 750))),
    )),
  ]);
  if (!metadata.exists() || metadata.data().ready !== true) {
    throw new Error('El índice global todavía no está preparado.');
  }
  return snapshot.docs.map((item) => {
    const value = item.data();
    return {
      catalogId: String(value.catalogId || ''),
      version: String(value.version || ''),
      pageNumber: Number(value.pageNumber || 0),
      text: String(value.text || ''),
    };
  }).filter((page) => page.catalogId && page.pageNumber > 0);
}

export async function fetchFirebasePdfSearchIndex(
  id: string,
  requestedVersion?: string,
  expectedPageCount?: number,
): Promise<FirebasePdfSearchPage[]> {
  const manifest = await getDoc(doc(db, 'pdfSearchIndexes', id));
  if (!manifest.exists()) return [];
  const version = requestedVersion || String(manifest.data().version || '');
  if (!version) return [];

  const snapshot = await getDocs(query(
    collection(db, 'pdfSearchIndexes', id, 'pages'),
    where('version', '==', version),
  ));
  const pages = snapshot.docs
    .map((item) => item.data() as FirebasePdfSearchPage & { version?: string })
    .filter((item) => item.version === version)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map(({ pageNumber, text }) => ({ pageNumber, text: String(text || '') }));

  const expected = expectedPageCount || Number(manifest.data().pageCount || 0);
  return pages.length === expected ? pages : [];
}

export async function cleanupPdfSearchIndex(id: string, keepVersion: string) {
  const [snapshot, globalSnapshot] = await Promise.all([
    getDocs(collection(db, 'pdfSearchIndexes', id, 'pages')),
    getDocs(query(collection(db, 'catalogSearchPages'), where('catalogId', '==', id))),
  ]);
  await deleteDocumentRefsInGroups(
    [...snapshot.docs, ...globalSnapshot.docs]
      .filter((item) => item.data().version !== keepVersion)
      .map((item) => item.ref),
  );
}

export async function discardPdfSearchIndexVersion(id: string, version: string) {
  const [snapshot, globalSnapshot] = await Promise.all([
    getDocs(collection(db, 'pdfSearchIndexes', id, 'pages')),
    getDocs(query(collection(db, 'catalogSearchPages'), where('catalogId', '==', id))),
  ]);
  await deleteDocumentRefsInGroups(
    [...snapshot.docs, ...globalSnapshot.docs]
      .filter((item) => item.data().version === version)
      .map((item) => item.ref),
  );
}

export async function uploadPdfToFirestore(
  id: string,
  file: File,
  onProgress?: (progress: number) => void,
): Promise<FirebasePdfUploadResult> {
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Solo se permiten archivos PDF.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const chunkCount = Math.ceil(bytes.length / PDF_CHUNK_BYTES);
  const version = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

  try {
    // Upload several independent Firestore chunks together. Eight concurrent
    // writes reduces round trips without creating an excessive request burst.
    for (let start = 0; start < chunkCount; start += 8) {
      const group = Array.from(
        { length: Math.min(8, chunkCount - start) },
        (_, offset) => start + offset,
      );
      await Promise.all(group.map((index) => {
        const from = index * PDF_CHUNK_BYTES;
        const to = Math.min(from + PDF_CHUNK_BYTES, bytes.length);
        return setDoc(doc(db, 'pdfFiles', id, 'chunks', `${version}-${String(index).padStart(5, '0')}`), {
          index,
          version,
          data: Bytes.fromUint8Array(bytes.slice(from, to)),
        });
      }));
      onProgress?.(Math.round((Math.min(start + group.length, chunkCount) / chunkCount) * 100));
    }

    await setDoc(doc(db, 'pdfFiles', id, 'versions', version), {
      fileName: file.name,
      mimeType: 'application/pdf',
      size: file.size,
      chunkCount,
      version,
      sha256,
      updatedAt: serverTimestamp(),
    });
    return {
      url: `firestore-pdf://${id}?version=${encodeURIComponent(version)}`,
      version,
      chunkCount,
    };
  } catch (error) {
    await discardPdfVersion(id, version).catch(() => undefined);
    throw error;
  }
}

export async function finalizePdfVersion(id: string, version: string) {
  const versionRef = doc(db, 'pdfFiles', id, 'versions', version);
  const versionSnapshot = await getDoc(versionRef);
  if (!versionSnapshot.exists()) throw new Error('La versión preparada del PDF no existe.');

  await setDoc(doc(db, 'pdfFiles', id), {
    ...versionSnapshot.data(),
    version,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  const [chunks, versions] = await Promise.all([
    getDocs(collection(db, 'pdfFiles', id, 'chunks')),
    getDocs(collection(db, 'pdfFiles', id, 'versions')),
  ]);
  await Promise.all([
    ...chunks.docs
      .filter((item) => item.data().version !== version)
      .map((item) => deleteDoc(item.ref)),
    ...versions.docs
      .filter((item) => item.id !== version)
      .map((item) => deleteDoc(item.ref)),
  ]);
}

export async function discardPdfVersion(id: string, version: string) {
  const chunks = await getDocs(collection(db, 'pdfFiles', id, 'chunks'));
  await Promise.all(
    chunks.docs
      .filter((item) => item.data().version === version)
      .map((item) => deleteDoc(item.ref)),
  );
  await deleteDoc(doc(db, 'pdfFiles', id, 'versions', version)).catch(() => undefined);
}

export async function loadPdfFromFirestore(
  id: string,
  onProgress?: (progress: number) => void,
  requestedVersion?: string,
): Promise<string> {
  onProgress?.(5);
  const manifest = requestedVersion
    ? await getDoc(doc(db, 'pdfFiles', id, 'versions', requestedVersion))
    : await getDoc(doc(db, 'pdfFiles', id));
  if (!manifest.exists()) throw new Error('El PDF no está disponible.');
  onProgress?.(15);
  const version = requestedVersion || String(manifest.data().version || '');
  const cacheKey = `chaide_firestore_pdf_${id}_${version || 'current'}`;
  try {
    const cached = await getCachedValue<Uint8Array>(cacheKey);
    const expectedBytes = Number(manifest.data().size || 0);
    if (cached?.byteLength && (!expectedBytes || cached.byteLength === expectedBytes)) {
      const signature = new TextDecoder('ascii').decode(cached.slice(0, 5));
      if (signature === '%PDF-') {
        onProgress?.(100);
        return URL.createObjectURL(new Blob([cached], { type: 'application/pdf' }));
      }
    }
  } catch {
    // Continue with Firestore when browser storage is unavailable or corrupt.
  }
  const snapshot = version
    ? await getDocs(query(
      collection(db, 'pdfFiles', id, 'chunks'),
      where('version', '==', version),
    ))
    : await getDocs(collection(db, 'pdfFiles', id, 'chunks'));
  onProgress?.(85);
  const ordered = snapshot.docs
    .map((item) => item.data() as { index: number; version?: string; data: Bytes })
    .filter((item) => !version || item.version === version)
    .sort((a, b) => a.index - b.index);
  const expected = Number(manifest.data().chunkCount || 0);
  const hasContiguousChunks = ordered.every((item, index) => item.index === index);
  if (!ordered.length || ordered.length !== expected || !hasContiguousChunks) {
    throw new Error('El PDF está incompleto. Vuelve a publicarlo desde el administrador.');
  }
  const parts = ordered.map((item) => item.data.toUint8Array());
  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  const expectedBytes = Number(manifest.data().size || 0);
  const signature = new TextDecoder('ascii').decode(parts[0]?.slice(0, 5));
  if ((expectedBytes > 0 && totalBytes !== expectedBytes) || signature !== '%PDF-') {
    throw new Error('El PDF guardado no superó la verificación de integridad. Repáralo desde el administrador.');
  }
  const complete = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const part of parts) {
    complete.set(part, cursor);
    cursor += part.byteLength;
  }
  const expectedHash = String(manifest.data().sha256 || '');
  if (expectedHash && await sha256Hex(complete) !== expectedHash) {
    throw new Error('El PDF no coincide con su firma de integridad. Se intentará usar el respaldo de Drive.');
  }
  await cacheFirestorePdf(cacheKey, complete);
  const blob = new Blob([complete], { type: 'application/pdf' });
  onProgress?.(100);
  return URL.createObjectURL(blob);
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 45_000,
) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function loadPublicDrivePdf(downloadUrl: string): Promise<string> {
  if (!/^https:\/\/(drive|docs)\.google\.com\//i.test(downloadUrl)) {
    throw new Error('El enlace de respaldo no pertenece a Google Drive.');
  }
  const response = await fetchWithTimeout(
    downloadUrl,
    { cache: 'no-store', redirect: 'follow' },
    60_000,
  );
  if (!response.ok) throw new Error(`Drive respondió ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 5));
  if (signature !== '%PDF-') throw new Error('Drive no devolvió un PDF válido.');
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}
