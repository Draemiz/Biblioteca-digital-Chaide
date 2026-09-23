import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../store/useStore';
import PdfViewer from '../components/preview/PdfViewer';
import type { DocumentDef } from '../lib/mockData';
import { isFirebaseSite } from '../lib/runtimeConfig';

export default function ViewerPage() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const requestedPage = Number.parseInt(searchParams.get('page') || '1', 10);
  const initialPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const initialSearch = searchParams.get('search') || '';
  const { documents, fetchDocuments, isLoadingDocs, hasLoadedDocs } = useStore();
  const [directDocument, setDirectDocument] = useState<DocumentDef | null>(null);
  const [directDocumentResolved, setDirectDocumentResolved] = useState(!isFirebaseSite);
  const doc = useMemo(
    () => documents.find((document) => document.id === id) || directDocument,
    [documents, id, directDocument],
  );
  const [firebasePdfUrl, setFirebasePdfUrl] = useState('');
  const [firebasePdfError, setFirebasePdfError] = useState('');
  const [firebasePdfProgress, setFirebasePdfProgress] = useState(0);

  const handlePageChange = useCallback((page: number) => {
    const value = String(Math.max(1, Math.trunc(page)));
    setSearchParams((current) => {
      if (current.get('page') === value) return current;
      const next = new URLSearchParams(current);
      next.set('page', value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    if (!hasLoadedDocs && !isLoadingDocs) {
      fetchDocuments();
    }
  }, [fetchDocuments, hasLoadedDocs, isLoadingDocs]);

  useEffect(() => {
    if (!isFirebaseSite || !id) return;
    let active = true;
    setDirectDocument(null);
    setDirectDocumentResolved(false);
    import('../lib/firebaseCatalog')
      .then(({ fetchFirebaseDocument }) => fetchFirebaseDocument(id))
      .then((value) => {
        if (active) setDirectDocument(value);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setDirectDocumentResolved(true);
      });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    const sourceUrl = doc?.fileUrl || '';
    if (!sourceUrl.startsWith('firestore-pdf://')) {
      setFirebasePdfUrl('');
      setFirebasePdfError('');
      setFirebasePdfProgress(0);
      return;
    }

    let active = true;
    let objectUrl = '';
    const source = sourceUrl.slice('firestore-pdf://'.length);
    const separator = source.indexOf('?');
    const firebaseId = separator >= 0 ? source.slice(0, separator) : source;
    const version = separator >= 0
      ? new URLSearchParams(source.slice(separator + 1)).get('version') || undefined
      : undefined;
    setFirebasePdfUrl('');
    setFirebasePdfError('');
    setFirebasePdfProgress(0);
    import('../lib/firebaseCatalog')
      .then(async ({ loadPdfFromFirestore, loadPublicDrivePdf }) => {
        let primaryError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await loadPdfFromFirestore(
              firebaseId,
              (progress) => {
                if (active) setFirebasePdfProgress(progress);
              },
              version,
            );
          } catch (error) {
            primaryError = error;
            if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 800));
          }
        }
        if (doc?.externalUrl) {
          if (active) setFirebasePdfProgress(90);
          try {
            return await loadPublicDrivePdf(doc.externalUrl);
          } catch (backupError) {
            const primaryMessage = primaryError instanceof Error ? primaryError.message : 'Firestore no respondió.';
            const backupMessage = backupError instanceof Error ? backupError.message : 'Drive no respondió.';
            throw new Error(`${primaryMessage} El respaldo automático también falló: ${backupMessage}`);
          }
        }
        throw primaryError;
      })
      .then((url) => {
        objectUrl = url;
        if (active) setFirebasePdfUrl(url);
      })
      .catch((error) => {
        if (active) setFirebasePdfError(error instanceof Error ? error.message : 'No se pudo cargar el PDF.');
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [doc?.externalUrl, doc?.fileUrl]);

  if (!doc && ((!hasLoadedDocs || isLoadingDocs) || !directDocumentResolved)) {
    return (
      <div className="fixed inset-0 bg-[#0B0F19] flex items-center justify-center text-white flex-col gap-4">
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-400">Iniciando visor...</p>
      </div>
    );
  }

  if (!doc) {
     return (
        <div className="fixed inset-0 bg-[#0B0F19] flex items-center justify-center text-white flex-col gap-4 p-4 text-center">
          <div className="text-red-500 text-4xl mb-2">×</div>
          <h2 className="text-xl font-bold">Catálogo no encontrado</h2>
          <p className="text-gray-400 max-w-xs">El documento solicitado no existe o ha sido eliminado.</p>
          <button onClick={() => navigate('/')} className="mt-4 px-6 py-2 bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            Volver a la biblioteca
          </button>
        </div>
     );
  }

  if (doc.fileUrl?.startsWith('firestore-pdf://') && !firebasePdfUrl && !firebasePdfError) {
    return (
      <div className="fixed inset-0 bg-[#0B0F19] flex items-center justify-center text-white flex-col gap-4">
        <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-300">Preparando el catálogo para el visor…</p>
        <div className="h-1.5 w-56 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-300"
            style={{ width: `${firebasePdfProgress}%` }}
          />
        </div>
        <p className="text-xs tabular-nums text-gray-500">{firebasePdfProgress}%</p>
      </div>
    );
  }

  if (firebasePdfError) {
    return (
      <div className="fixed inset-0 bg-[#0B0F19] flex items-center justify-center text-white flex-col gap-4 p-6 text-center">
        <h2 className="text-xl font-bold">No se pudo abrir el catálogo</h2>
        <p className="text-gray-400 max-w-md">{firebasePdfError}</p>
        <button onClick={() => navigate('/')} className="px-6 py-2 bg-blue-600 rounded-lg">Volver</button>
      </div>
    );
  }

  const urlToUse = firebasePdfUrl || (doc ? ((typeof doc.fileUrl === 'string' && doc.fileUrl.trim().startsWith('<')) || (typeof doc.fileUrl === 'string' && doc.fileUrl.includes('<script'))
      ? doc.fileUrl 
      : (doc.fileUrl ? doc.fileUrl : doc.externalUrl)) : '');

  const downloadUrl = firebasePdfUrl || ((doc && typeof doc.fileUrl === 'string' && !doc.fileUrl.trim().startsWith('<'))
      ? doc.fileUrl
      : (doc && typeof doc.externalUrl === 'string' && doc.externalUrl.startsWith('http') ? doc.externalUrl : undefined));

  return (
    <div className="min-h-screen bg-[#f5f5f2] selection:bg-blue-500 selection:text-white">
       <PdfViewer 
          documentId={doc.id}
          url={urlToUse || ''} 
          title={doc.title} 
          onClose={() => navigate('/')} 
          downloadUrl={downloadUrl}
          initialPage={initialPage}
          initialSearch={initialSearch}
          onPageChange={handlePageChange}
       />
    </div>
  );
}
