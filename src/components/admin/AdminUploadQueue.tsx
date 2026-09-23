import React, { useRef, useState, DragEvent, useEffect, useMemo } from 'react';
import { Upload, X, FileText, CheckCircle2, AlertCircle, Search } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { cn } from '../../lib/utils';
import { fuzzyTextMatch, normalizeSearchText } from '../../lib/fuzzyTextSearch';

interface PendingFile {
  id: string;
  file?: File;
  url?: string;
  docId?: string;
  replaceTargetId?: string; // ID of the document to be replaced
  type: 'upload' | 'url' | 'embed';
  title: string;
  publicationType: '' | 'catalog' | 'technical-sheet';
  size?: number;
  category: string;
  visibility: string;
  status: 'pending' | 'uploading' | 'paused' | 'uploaded' | 'processing' | 'internal_ready' | 'publishing' | 'published' | 'indexing' | 'error' | 'cancelled';
  progress?: number;
  errorMessage?: string;
  xhr?: XMLHttpRequest;
  finalPdfUrl?: string;
  downloadUrl?: string;
  previewUrl?: string;
  previewFailed?: boolean;
  recoveredDraft?: boolean;
  uploadPhase?: 'sending' | 'preparing' | 'finalizing' | 'verifying';
  advancing?: boolean;
  uploadId?: string;
  duplicateTargetId?: string;
  duplicateChecked?: boolean;
  pageCount?: number;
}

function UploadProgressBar({ status, progress }: { status: PendingFile['status']; progress?: number }) {
  const steps = [
    { key: "uploaded", label: "Subido" },
    { key: "internal", label: "Sistema" },
    { key: "published", label: "Web" },
    { key: "indexing", label: "Índice" },
  ];

  const getStepState = (status: PendingFile['status'], index: number) => {
    if (status === "error") return "error";
    
    if (status === "uploading") {
      return index === 0 ? "processing" : "pending";
    }

    if (status === "pending") {
      return "pending";
    }

    if (status === "uploaded") {
      if (index === 0) return "complete";
      return "pending";
    }

    if (status === "processing") {
      if (index === 0) return "complete";
      if (index === 1) return "processing";
      return "pending";
    }

    if (status === "internal_ready") {
      if (index <= 1) return "complete";
      return "pending";
    }

    if (status === "publishing") {
      if (index <= 1) return "complete";
      if (index === 2) return "processing";
      return "pending";
    }

    if (status === "indexing") {
      if (index <= 2) return "complete";
      return "processing";
    }

    if (status === "published") {
      return "complete";
    }

    return "pending";
  };

  const getLineProgress = (status: PendingFile['status']) => {
    switch (status) {
      case 'uploaded': return '0%';
      case 'processing': return '25%';
      case 'internal_ready': return '50%';
      case 'publishing': return '60%';
      case 'indexing': return '80%';
      case 'published': return '100%';
      default: return '0%';
    }
  };

  const activeStep = status === 'uploading' || status === 'uploaded'
    ? 0
    : status === 'processing'
      ? 1
      : status === 'publishing'
        ? 2
        : status === 'indexing'
          ? 3
          : -1;

  return (
    <div className="mt-6 mb-2">
      <div className="upload-progress">
        <div className="upload-progress-line">
          <div 
            className="upload-progress-line-fill" 
            style={{ width: getLineProgress(status) }}
          />
        </div>
        {steps.map((step, idx) => {
          const state = getStepState(status, idx);
          return (
            <div key={step.key} className={cn(
              "upload-progress-step",
              state === 'complete' && "is-complete",
              state === 'processing' && "is-processing",
              state === 'pending' && "is-pending",
              state === 'error' && "is-error"
            )}>
              <div className="upload-progress-dot">
                {state === 'complete' && <CheckCircle2 className="w-4 h-4" />}
                {state === 'processing' && <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
                {state === 'error' && <AlertCircle className="w-4 h-4" />}
                {state === 'pending' && <div className="w-2 h-2 bg-gray-400 rounded-full" />}
              </div>
              <span className="upload-progress-label">
                {step.label}
                {activeStep === idx && progress !== undefined && (
                  <small className="upload-progress-percent" aria-live="polite">{progress}%</small>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AdminUploadQueue({ initialReplaceDocId }: { initialReplaceDocId?: string }) {
  const { fetchDocuments, categories, documents } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<PendingFile[]>([]);
  const [successNotices, setSuccessNotices] = useState<Array<{ id: string; message: string }>>([]);
  const completedTimersRef = useRef<Map<string, number>>(new Map());
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => () => {
    completedTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    completedTimersRef.current.clear();
  }, []);

  useEffect(() => {
    for (const item of queue) {
      if (item.status !== 'published' || completedTimersRef.current.has(item.id)) continue;
      const libraryId = item.replaceTargetId || item.docId;
      if (!libraryId || !documents.some((document) => document.id === libraryId && document.status === 'ready')) continue;

      setSuccessNotices((current) => [...current, {
        id: item.id,
        message: item.visibility === 'private' ? 'Archivo guardado como borrador' : 'Archivo cargado exitosamente',
      }]);
      const timer = window.setTimeout(() => {
        setQueue((current) => current.filter((entry) => entry.id !== item.id));
        setSuccessNotices((current) => current.filter((notice) => notice.id !== item.id));
        completedTimersRef.current.delete(item.id);
      }, 5000);
      completedTimersRef.current.set(item.id, timer);
    }
  }, [queue, documents]);
  
  // Custom states for replacement mode
  const [mode, setMode] = useState<'new' | 'replace'>('new');
  const [replaceTargetId, setReplaceTargetId] = useState<string>('');
  const [replaceSearchTerm, setReplaceSearchTerm] = useState('');
  const replaceMatches = useMemo(() => documents.filter((document) => (
    document.status === 'ready' && fuzzyTextMatch(replaceSearchTerm, document.title, document.category)
  )), [documents, replaceSearchTerm]);

  useEffect(() => {
    if (initialReplaceDocId) {
        setMode('replace');
        setReplaceSearchTerm('');
        setReplaceTargetId(initialReplaceDocId);
        // Scroll to the upload manager
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [initialReplaceDocId]);

  useEffect(() => {
    const recoverableDocuments = documents.filter((document) => (
      document.sourceType === 'upload' &&
      document.status === 'processing' &&
      Boolean(document.fileUrl)
    ));
    if (!recoverableDocuments.length) return;

    setQueue((current) => {
      const next = [...current];
      const knownDocumentIds = new Set(next.map((item) => item.docId).filter(Boolean));
      for (const document of recoverableDocuments) {
        if (knownDocumentIds.has(document.id)) continue;
        const recovered: PendingFile = {
          id: `recovered-${document.id}`,
          docId: document.id,
          type: 'upload',
          title: document.title,
          publicationType: document.publicationType || '',
          category: document.category === 'Sin categoría' ? '' : document.category,
          visibility: document.visibility || 'public',
          status: 'uploaded',
          progress: undefined,
          finalPdfUrl: document.fileUrl,
          downloadUrl: document.fileUrl,
          previewUrl: document.coverUrl?.startsWith('/storage/covers/') ? document.coverUrl : undefined,
          pageCount: document.pageCount > 1 ? document.pageCount : undefined,
          size: document.fileSize,
          recoveredDraft: true,
          advancing: false,
        };
        const matchingUploadIndex = next.findIndex((item) => (
          !item.docId &&
          item.status === 'uploading' &&
          normalizeSearchText(item.title) === normalizeSearchText(document.title) &&
          item.category === document.category
        ));
        if (matchingUploadIndex >= 0) {
          next[matchingUploadIndex] = {
            ...next[matchingUploadIndex],
            ...recovered,
            id: next[matchingUploadIndex].id,
            previewUrl: next[matchingUploadIndex].previewUrl || recovered.previewUrl,
          };
        } else {
          next.push(recovered);
        }
        knownDocumentIds.add(document.id);
      }
      return next;
    });
  }, [documents]);

  useEffect(() => {
    const awaitingServerConfirmation = queue.some((item) => (
      item.status === 'uploading' && (item.uploadPhase === 'preparing' || item.uploadPhase === 'finalizing' || item.uploadPhase === 'verifying')
    ));
    if (!awaitingServerConfirmation) return;

    void fetchDocuments(true);
    const timer = window.setInterval(() => {
      void fetchDocuments(true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [fetchDocuments, queue]);

  const hUploadClick = () => {
    if (mode === 'replace' && !replaceTargetId) {
        alert("Por favor, selecciona primero el documento que deseas reemplazar.");
        return;
    }
    fileInputRef.current?.click();
  };

  const selectedTargetDoc = documents.find(d => d.id === replaceTargetId);

  const generateLocalPreview = async (id: string, file: File) => {
    try {
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      const objectUrl = URL.createObjectURL(file);
      try {
        const pdf = await pdfjsLib.getDocument(objectUrl).promise;
        const page = await pdf.getPage(1);
        const initialViewport = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(1.5, 360 / initialViewport.width) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No se pudo preparar la vista previa.');
        await page.render({ canvasContext: context, viewport }).promise;
        const previewUrl = canvas.toDataURL('image/jpeg', 0.82);
        setQueue((current) => current.map((item) => item.id === id
          ? { ...item, previewUrl, previewFailed: false, pageCount: pdf.numPages }
          : item));
        await pdf.destroy();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (error) {
      console.warn('No se pudo generar la vista previa local del PDF.', error);
      setQueue((current) => current.map((item) => item.id === id
        ? { ...item, previewFailed: true }
        : item));
    }
  };

  const handleFiles = (files: FileList | File[]) => {
    const arrFiles = Array.from(files);
    const newFiles = arrFiles.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    
    if (arrFiles.length > 0 && newFiles.length === 0) {
      alert("Por favor, selecciona únicamente archivos en formato PDF.");
      return;
    }

    if (mode === 'replace' && newFiles.length > 1) {
        alert("En el modo de reemplazo, solo puedes subir un archivo a la vez.");
        return;
    }

    const validFiles: File[] = [];
    
    // Check file sizes before accepting. Uploads are sent in 1 MB chunks, so
    // large catalogs are supported; we only cap to avoid accidental huge files.
    const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
    newFiles.forEach(f => {
      if (f.size > MAX_UPLOAD_BYTES) {
         alert(`El archivo ${f.name} supera el límite de 500 MB.`);
         return;
      }
      validFiles.push(f);
    });

    const newPending: PendingFile[] = validFiles.map(f => ({
      id: Math.random().toString(36).substring(7),
      file: f,
      type: 'upload',
      title: mode === 'replace' && selectedTargetDoc ? selectedTargetDoc.title : f.name.replace(/\.pdf$/i, ''),
      publicationType: mode === 'replace'
        ? selectedTargetDoc?.publicationType || 'catalog'
        : '',
      replaceTargetId: mode === 'replace' ? replaceTargetId : undefined,
      size: f.size,
      category: mode === 'replace' && selectedTargetDoc ? selectedTargetDoc.category : '',
      visibility: mode === 'replace' && selectedTargetDoc ? selectedTargetDoc.visibility || 'public' : 'public',
      status: 'pending',
      progress: 0
    }));
    
    setQueue(prev => [...prev, ...newPending]);
    newPending.forEach((item) => {
      if (item.file) void generateLocalPreview(item.id, item.file);
    });
    
    // Reset replace state after adding to queue to avoid confusion if adding more later
    if (mode === 'replace') {
        setReplaceTargetId('');
        setMode('new');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
    e.target.value = '';
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  const removeFromQueue = async (id: string) => {
    const item = queue.find((entry) => entry.id === id);
    const completedTimer = completedTimersRef.current.get(id);
    if (completedTimer !== undefined) {
      window.clearTimeout(completedTimer);
      completedTimersRef.current.delete(id);
      setSuccessNotices((current) => current.filter((notice) => notice.id !== id));
    }
    if (item?.docId && item.status !== 'published') {
      const response = await fetch(`/api/documents/${item.docId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!response.ok && response.status !== 404) {
        const result = await response.json().catch(() => ({}));
        alert(result.error || 'No se pudo retirar el archivo incompleto.');
        return;
      }
      await fetchDocuments(true);
    }
    if (!item?.docId) await cleanupUploadSession(item?.uploadId);
    setQueue(prev => prev.filter(item => item.id !== id));
  };
  
  const updateItemDetails = (id: string, field: string, value: any) => {
    setQueue(prev => prev.map(item => item.id === id
      ? { ...item, [field]: value, errorMessage: undefined }
      : item));
  };

  const cancelUpload = (id: string) => {
    const item = queue.find(i => i.id === id);
    if (item && item.xhr) {
      item.xhr.abort();
    }
    void cleanupUploadSession(item?.uploadId);
    setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'cancelled', progress: 0 } : i));
  };

  const pauseUpload = (id: string) => {
    const item = queue.find(i => i.id === id);
    if (item && item.xhr) {
      item.xhr.abort();
    }
    void cleanupUploadSession(item?.uploadId);
    setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'paused' } : i));
  };

  const metadataIsComplete = (item: PendingFile) => Boolean(
    item.title.trim() && item.publicationType && item.category.trim(),
  );

  const findDuplicateTarget = (item: PendingFile) => {
    if (item.replaceTargetId || item.duplicateChecked || item.duplicateTargetId) return undefined;
    const normalizedTitle = normalizeSearchText(item.title);
    if (!normalizedTitle) return undefined;
    return documents.find((document) => (
      document.id !== item.docId &&
      document.status === 'ready' &&
      normalizeSearchText(document.title) === normalizedTitle
    ));
  };

  const cleanupUploadSession = async (uploadId?: string) => {
    if (!uploadId) return;
    const response = await fetch(`/api/documents/upload-session/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => null);
    if (response?.ok) {
      const result = await response.json().catch(() => ({}));
      if (result.committed) await fetchDocuments(true);
    }
  };

  const beginStageProgress = (id: string, status: PendingFile['status']) => {
    setQueue((current) => current.map((item) => item.id === id
      ? { ...item, status, progress: 0 }
      : item));

    const timer = window.setInterval(() => {
      setQueue((current) => current.map((item) => {
        if (item.id !== id || item.status !== status) return item;
        const currentProgress = item.progress ?? 0;
        if (currentProgress >= 92) return item;
        const increment = currentProgress < 45 ? 4 : currentProgress < 75 ? 2 : 1;
        return { ...item, progress: Math.min(92, currentProgress + increment) };
      }));
    }, 320);

    return () => window.clearInterval(timer);
  };

  const showStageComplete = async (id: string, status: PendingFile['status']) => {
    setQueue((current) => current.map((item) => item.id === id && item.status === status
      ? { ...item, progress: 100 }
      : item));
    await new Promise((resolve) => window.setTimeout(resolve, 650));
  };

  const waitForCommittedDocument = async (documentId: string, signal?: AbortSignal) => {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new DOMException('Carga cancelada', 'AbortError');
      await new Promise((resolve) => window.setTimeout(resolve, 1400));
      if (signal?.aborted) throw new DOMException('Carga cancelada', 'AbortError');
      try {
        const response = await fetch(`/api/documents/${documentId}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (response.ok) return await response.json();
        if (response.status !== 404) throw new Error(`Verificación ${response.status}`);
      } catch {
        // A brief network interruption must not discard an upload that the
        // server may already be finalizing in Backblaze.
      }
    }
    throw new Error('La confirmación de Backblaze tardó demasiado. Recarga la página para recuperar la carga.');
  };

  const startUpload = async (id: string) => {
    const item = queue.find(i => i.id === id);
    if (!item || !item.file) return;
    if (!metadataIsComplete(item)) {
      setQueue((current) => current.map((entry) => entry.id === id
        ? { ...entry, errorMessage: 'Completa el nombre, el tipo de publicación y la categoría antes de subir.' }
        : entry));
      return;
    }
    const duplicateTarget = findDuplicateTarget(item);
    if (duplicateTarget) {
      setQueue((current) => current.map((entry) => entry.id === id
        ? { ...entry, duplicateTargetId: duplicateTarget.id }
        : entry));
      return;
    }

    let activeUploadId = '';
    setQueue(prev => prev.map(i => i.id === id ? {
      ...i,
      status: 'uploading',
      progress: 0,
      uploadPhase: 'sending',
    } : i));

    try {
      const CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB chunks for better iframe stability
      const totalChunks = Math.ceil(item.file.size / CHUNK_SIZE);
      const uploadId = `upload-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      activeUploadId = uploadId;
      setQueue((current) => current.map((entry) => entry.id === id
        ? { ...entry, uploadId }
        : entry));

      const controller = new AbortController();
      setQueue(prev => prev.map(i => i.id === id ? { ...i, xhr: { abort: () => controller.abort() } as any } : i));

      let lastResult: any = null;

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, item.file.size);
        const chunk = item.file.slice(start, end);

        const formData = new FormData();
        formData.append('chunk', chunk, item.file.name);
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', String(chunkIndex));
        formData.append('totalChunks', String(totalChunks));
        formData.append('fileName', item.file.name);

        if (chunkIndex === totalChunks - 1) {
          formData.append('documentsInfo', JSON.stringify([{
            title: item.title,
            category: item.category,
            visibility: item.visibility,
            publicationType: item.publicationType,
          }]));
        }

        const isFinalChunk = chunkIndex === totalChunks - 1;
        if (isFinalChunk) {
          setQueue((current) => current.map((entry) => entry.id === id
            ? { ...entry, progress: undefined, uploadPhase: 'preparing' }
            : entry));
        }

        const uploadRequest = fetch('/api/documents/upload-chunk', {
          method: 'POST',
          body: formData,
          signal: controller.signal
        });

        let finalizationTimer: number | undefined;
        const verificationController = new AbortController();
        if (isFinalChunk) {
          let polling = false;
          const pollFinalization = async () => {
            if (polling || verificationController.signal.aborted) return;
            polling = true;
            try {
              const response = await fetch(`/api/documents/upload-session/${encodeURIComponent(uploadId)}/progress`, {
                credentials: 'include', cache: 'no-store', signal: verificationController.signal,
              });
              if (!response.ok) return;
              const result: { phase: string; loaded: number; total: number } = await response.json();
              setQueue((current) => current.map((entry) => {
                if (entry.id !== id || entry.status !== 'uploading') return entry;
                if (result.phase === 'uploading' && result.total > 0 && result.loaded < result.total) {
                  return { ...entry, uploadPhase: 'finalizing', progress: Math.min(99, Math.floor(result.loaded / result.total * 100)) };
                }
                if (result.phase === 'verifying' || result.phase === 'complete' ||
                    (result.phase === 'uploading' && result.total > 0 && result.loaded >= result.total)) {
                  return { ...entry, uploadPhase: 'verifying', progress: undefined };
                }
                return { ...entry, uploadPhase: 'preparing', progress: undefined };
              }));
            } catch {
              // The upload response and document check remain the source of truth.
            } finally {
              polling = false;
            }
          };
          void pollFinalization();
          finalizationTimer = window.setInterval(() => void pollFinalization(), 850);
        }

        let completion: { response: Response; document?: never } | { document: any; response?: never };
        try {
          completion = isFinalChunk
            ? await Promise.race([
                uploadRequest
                  .then((response) => ({ response }))
                  .catch(() => new Promise<never>(() => undefined)),
                waitForCommittedDocument(uploadId, verificationController.signal).then((document) => ({ document })),
              ])
            : { response: await uploadRequest };
        } finally {
          if (finalizationTimer !== undefined) window.clearInterval(finalizationTimer);
          verificationController.abort();
        }

        if ('document' in completion) {
          lastResult = [completion.document];
          setQueue((current) => current.map((entry) => entry.id === id
            ? { ...entry, progress: 100, uploadPhase: undefined }
            : entry));
          break;
        }

        const response = completion.response;

        if (!response.ok) {
          const text = await response.text();
          if (text.includes('Cookie check') || text.includes('<!doctype html>')) {
            throw new Error("Sesión del editor expirada o bloqueada. Por favor, abre la app en una NUEVA PESTAÑA externa para subir archivos grandes.");
          }
          if (response.status === 413) {
            throw new Error("Fragmento rechazado por tamaño. El límite del proxy fue excedido.");
          }
          throw new Error(`Error del servidor (${response.status})`);
        }

        const data = await response.json();
        lastResult = data;
        
        const percent = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        setQueue(prev => prev.map(i => i.id === id ? {
          ...i,
          progress: isFinalChunk ? 100 : Math.min(percent, 98),
          uploadPhase: isFinalChunk ? undefined : i.uploadPhase,
        } : i));
      }

      const doc = lastResult[0];
      if (!doc || !doc.id || !doc.fileUrl) {
        throw new Error("Respuesta de finalización no válida del servidor");
      }

      setQueue(prev => prev.map(i => i.id === id ? { 
        ...i, 
        status: 'uploaded',
        docId: doc.id,
        progress: 100,
        finalPdfUrl: doc.fileUrl,
        downloadUrl: doc.fileUrl
      } : i));

      window.setTimeout(() => {
        setQueue((current) => current.map((entry) => entry.id === id && entry.status === 'uploaded'
          ? { ...entry, progress: undefined }
          : entry));
      }, 900);

      // La siguiente etapa requiere confirmación manual para que el usuario
      // pueda revisar la portada y los datos antes de publicar.
    } catch (e: any) {
      if (e.name === 'AbortError') {
        setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'cancelled', progress: 0 } : i));
      } else {
        setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'error', errorMessage: e.message, progress: 0 } : i));
      }
      await cleanupUploadSession(activeUploadId);
      console.error("Upload error:", e);
    }
  };

  // Stage 2: System Processing (Metadata & Cover)
  const processDocument = async (id: string) => {
    const item = queue.find(i => i.id === id);
    if (!item || !item.docId) return;

    const stopProgress = beginStageProgress(id, 'processing');

    try {
      let pageCount = 0;
      let coverFile: File | null = null;
      const pdfjsLib = await import('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      
      // Use local file for processing if available to avoid re-downloading large files
      let pdfData: any;
      let objectUrl: string | null = null;
      if (item.file) {
        // Use an object URL instead of arrayBuffer for efficiency and to avoid memory spikes
        objectUrl = URL.createObjectURL(item.file);
        pdfData = objectUrl;
      } else {
        // Fallback to URL if file is not in memory (e.g. from a past session or URL import)
        const res = await fetch(`/api/documents/${item.docId}`, { credentials: 'include' });
        if (!res.ok) throw new Error("No se pudo obtener la información del documento");
        const doc = await res.json();
        pdfData = doc.fileUrl;
      }

      const isVeryLarge = item.size && item.size > 150 * 1024 * 1024; // 150MB limit for local rendering
      
      const loadingTask = pdfjsLib.getDocument(pdfData);
      
      const pdfDoc = await loadingTask.promise;
      pageCount = pdfDoc.numPages;
      
      // Render cover only if not extremely large to prevent browser hang
      if (!isVeryLarge) {
        try {
          const page = await pdfDoc.getPage(1);
          const viewport = page.getViewport({ scale: 2.0 }); // Maximum resolution for identifying catalogs
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext('2d');
          if (context) {
            await page.render({ canvasContext: context, viewport }).promise;
            const previewUrl = canvas.toDataURL('image/jpeg', 0.9);
            const coverBlob = await new Promise<Blob | null>((resolve) => {
              canvas.toBlob(resolve, 'image/jpeg', 0.9);
            });
            if (coverBlob) {
              coverFile = new File([coverBlob], `${item.docId}-cover.jpg`, { type: 'image/jpeg' });
            }
            setQueue((current) => current.map((entry) => entry.id === id
              ? { ...entry, previewUrl, pageCount }
              : entry));
          }
        } catch (renderError) {
          console.error("Error rendering cover:", renderError);
          // Don't fail the whole process if only cover fails
        }
      }

      // Cleanup PDF.js
      await pdfDoc.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);

      const updateForm = new FormData();
      updateForm.append('title', item.title.trim());
      updateForm.append('category', item.category);
      updateForm.append('publicationType', item.publicationType);
      updateForm.append('visibility', item.visibility);
      updateForm.append('pageCount', String(pageCount));
      if (coverFile) updateForm.append('cover', coverFile);

      const updateResponse = await fetch(`/api/documents/${item.docId}`, {
        method: 'PUT',
        credentials: 'include',
        body: updateForm,
      });
      if (!updateResponse.ok) {
        const result = await updateResponse.json().catch(() => ({}));
        throw new Error(result.error || 'No se pudieron guardar la portada y los datos del documento.');
      }

      stopProgress();
      await showStageComplete(id, 'processing');
      setQueue(prev => prev.map(i => i.id === id && i.status === 'processing'
        ? { ...i, status: 'internal_ready', progress: undefined, advancing: false }
        : i));
    } catch (e: any) {
      stopProgress();
      console.error("Processing error:", e);
      setQueue(prev => prev.map(i => i.id === id ? {
        ...i,
        status: 'error',
        errorMessage: e.message,
        advancing: false,
      } : i));
    }
  };

  const createIndexForDocument = async (id: string, docId: string, pdfUrl: string) => {
    const stopProgress = beginStageProgress(id, 'indexing');
    try {
        const { buildIndexDirectly } = await import('../../lib/pdfIndexerService');
        const indexItems = await buildIndexDirectly(pdfUrl);
        const indexResponse = await fetch(`/api/documents/${docId}/index`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ indexItems })
        });
        if (!indexResponse.ok) {
          throw new Error('El servidor no confirmó la creación del índice.');
        }
        stopProgress();
        await showStageComplete(id, 'indexing');
        await fetchDocuments(true);
        setQueue(prev => prev.map(i => i.id === id && i.status === 'indexing'
          ? { ...i, status: 'published', progress: undefined, advancing: false }
          : i));
    } catch (e: any) {
        stopProgress();
        console.error("Indexing error:", e);
        setQueue(prev => prev.map(i => i.id === id ? {
          ...i,
          status: 'error',
          errorMessage: "No se pudo crear el índice: " + e.message,
          advancing: false,
        } : i));
    }
  };

  // Stage 3: Publish / Replace logic
  const publishDocument = async (id: string) => {
    const item = queue.find(i => i.id === id);
    if (!item || !item.docId || !item.finalPdfUrl) return;
    if (!metadataIsComplete(item)) {
      setQueue((current) => current.map((entry) => entry.id === id
        ? { ...entry, errorMessage: 'Completa el nombre, el tipo de publicación y la categoría antes de publicar.' }
        : entry));
      return;
    }

    const stopProgress = beginStageProgress(id, 'publishing');

    try {
      if (item.replaceTargetId) {
        const swapRes = await fetch(`/api/documents/${item.replaceTargetId}/swap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ newDocId: item.docId })
        });
        if (!swapRes.ok) {
            const err = await swapRes.json().catch(() => ({}));
            throw new Error(err.error || "Error al realizar el reemplazo seguro.");
        }
      }

      const publishedDocumentId = item.replaceTargetId || item.docId;
      const publishResponse = await fetch(`/api/documents/${publishedDocumentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: item.title.trim(),
          category: item.category,
          publicationType: item.publicationType,
          visibility: item.visibility,
          status: 'ready',
        }),
      });
      if (!publishResponse.ok) {
        const result = await publishResponse.json().catch(() => ({}));
        throw new Error(result.error || 'No se pudieron guardar los datos de publicación.');
      }

      stopProgress();
      await showStageComplete(id, 'publishing');
      await createIndexForDocument(id, publishedDocumentId, item.finalPdfUrl);
    } catch (e: any) {
      stopProgress();
      setQueue(prev => prev.map(i => i.id === id ? {
        ...i,
        status: 'error',
        errorMessage: e.message,
        advancing: false,
      } : i));
    }
  };

  useEffect(() => {
    const uploadedItem = queue.find((item) => (
      item.status === 'uploaded' &&
      item.docId &&
      item.finalPdfUrl &&
      !item.advancing &&
      metadataIsComplete(item)
    ));
    if (uploadedItem) {
      if (uploadedItem.duplicateTargetId) return;
      const duplicateTarget = findDuplicateTarget(uploadedItem);
      if (duplicateTarget) {
        setQueue((current) => current.map((item) => item.id === uploadedItem.id
          ? { ...item, duplicateTargetId: duplicateTarget.id }
          : item));
        return;
      }
      setQueue((current) => current.map((item) => item.id === uploadedItem.id
        ? { ...item, advancing: true }
        : item));
      void processDocument(uploadedItem.id);
      return;
    }

    const systemReadyItem = queue.find((item) => (
      item.status === 'internal_ready' &&
      !item.advancing &&
      metadataIsComplete(item)
    ));
    if (systemReadyItem) {
      setQueue((current) => current.map((item) => item.id === systemReadyItem.id
        ? { ...item, advancing: true }
        : item));
      void publishDocument(systemReadyItem.id);
    }
  }, [queue]);

  const confirmDuplicateReplacement = (itemId: string, targetId: string) => {
    setQueue((current) => current.map((item) => item.id === itemId
      ? {
          ...item,
          replaceTargetId: targetId,
          duplicateTargetId: undefined,
          duplicateChecked: true,
          advancing: false,
          errorMessage: undefined,
        }
      : item));
  };

  const handleUploadAll = async () => {
    const pending = queue.filter(i => (
      i.status === 'pending' && metadataIsComplete(i) && !i.duplicateTargetId
    ));
    for (const item of pending) {
      await startUpload(item.id);
    }
  };

  const isAnyUploading = queue.some(i => ['uploading', 'processing', 'publishing', 'indexing'].includes(i.status));
  const hasReadyPendingFiles = queue.some(i => (
    i.status === 'pending' && metadataIsComplete(i) && !i.duplicateTargetId
  ));
  
  return (
    <div className="bg-[#111827] border border-white/10 rounded-2xl p-6 mb-8 text-white">
      <style dangerouslySetInnerHTML={{ __html: `
        .upload-progress {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          position: relative;
        }

        .upload-progress-line {
          position: absolute;
          top: 13px;
          left: calc(100% / 8);
          right: calc(100% / 8);
          height: 2px;
          background: rgba(255, 255, 255, 0.1);
          z-index: 0;
        }

        .upload-progress-line-fill {
          height: 100%;
          background: #2563eb;
          transition: width 0.5s ease-out;
        }

        .upload-progress-step {
          position: relative;
          z-index: 1;
          display: grid;
          justify-items: center;
          gap: 6px;
          text-align: center;
        }

        .upload-progress-dot {
          width: 28px;
          height: 28px;
          border-radius: 999px;
          background: #1f2937;
          border: 2px solid #374151;
          display: grid;
          place-items: center;
          transition: all 0.3s ease;
          color: #9ca3af;
        }

        .upload-progress-step.is-complete .upload-progress-dot {
          background: #2563eb;
          border-color: #2563eb;
          color: #fff;
        }

        .upload-progress-step.is-processing .upload-progress-dot {
          background: #1e3a8a;
          border-color: #3b82f6;
          color: #fff;
          animation: glue-pulse 1.2s infinite;
        }

        .upload-progress-step.is-error .upload-progress-dot {
          background: #7f1d1d;
          border-color: #ef4444;
          color: #fff;
        }

        .upload-progress-label {
          font-size: 11px;
          font-weight: 700;
          color: rgba(255, 255, 255, 0.4);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .upload-progress-percent {
          display: inline-flex;
          margin-left: 6px;
          padding: 1px 5px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.18);
          color: #93c5fd;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0;
          font-variant-numeric: tabular-nums;
        }

        .upload-progress-step.is-complete .upload-progress-label,
        .upload-progress-step.is-processing .upload-progress-label {
          color: #fff;
        }

        @keyframes glue-pulse {
          0% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.4); }
          70% { box-shadow: 0 0 0 10px rgba(37, 99, 235, 0); }
          100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); }
        }
      `}} />

      {successNotices.length > 0 && (
        <div className="fixed bottom-5 left-4 right-4 z-[100] space-y-2 sm:left-auto sm:right-6 sm:w-80" role="status" aria-live="polite">
          {successNotices.map((notice) => (
            <div key={notice.id} className="flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-[#0d2924] px-4 py-3 text-sm font-semibold text-emerald-100 shadow-2xl">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {notice.message}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-6 mb-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Gestor de Carga Estructurada</h2>
        </div>

        {/* Mode Selector */}
        <div className="flex bg-white/5 p-1 rounded-xl w-fit border border-white/10">
          <button 
            onClick={() => setMode('new')}
            className={cn(
              "px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2",
              mode === 'new' ? "bg-white text-black shadow-lg" : "text-gray-400 hover:text-white"
            )}
          >
            Nueva publicación
          </button>
          <button 
            onClick={() => setMode('replace')}
            className={cn(
              "px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2",
              mode === 'replace' ? "bg-white text-black shadow-lg" : "text-gray-400 hover:text-white"
            )}
          >
            Reemplazar existente
          </button>
        </div>

        {mode === 'replace' && (
          <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
             <div className="flex flex-col gap-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                  Selecciona el documento que deseas reemplazar
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                  <input
                    type="search"
                    value={replaceSearchTerm}
                    onChange={(event) => {
                      setReplaceSearchTerm(event.target.value);
                      if (event.target.value) setReplaceTargetId('');
                    }}
                    placeholder="Buscar por nombre o categoría…"
                    aria-label="Buscar documento para reemplazar"
                    autoComplete="off"
                    className="w-full rounded-xl border border-white/10 bg-[#0B0F19] py-3 pl-10 pr-4 text-sm text-white outline-none placeholder:text-gray-500 focus:border-blue-500"
                  />
                </div>
                <select 
                  value={replaceTargetId}
                  onChange={(e) => {
                    setReplaceTargetId(e.target.value);
                    if (e.target.value) setReplaceSearchTerm('');
                  }}
                  aria-label="Seleccionar documento para reemplazar"
                  className="bg-[#0B0F19] border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 appearance-none cursor-pointer"
                >
                  <option value="">-- Seleccionar documento --</option>
                  {replaceMatches.map(doc => (
                    <option key={doc.id} value={doc.id}>
                      {doc.title} ({doc.category})
                    </option>
                  ))}
                </select>
                {replaceSearchTerm && (
                  <p className="text-xs text-gray-400" role="status">
                    {replaceMatches.length === 0
                      ? 'No se encontraron documentos. Prueba con otra palabra.'
                      : `${replaceMatches.length} ${replaceMatches.length === 1 ? 'documento encontrado' : 'documentos encontrados'}`}
                  </p>
                )}
             </div>

             {selectedTargetDoc && (
                <div className="bg-white/5 border border-white/10 rounded-2xl p-4 flex gap-4">
                   <img 
                    src={selectedTargetDoc.coverUrl} 
                    alt="" 
                    className="w-16 h-24 object-cover rounded-lg border border-white/10 shadow-sm"
                   />
                   <div className="flex flex-col justify-center">
                      <h4 className="font-bold text-white leading-tight">{selectedTargetDoc.title}</h4>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-[10px] text-gray-400 font-medium uppercase tracking-tighter">
                         <div className="flex items-center gap-1">
                            <span className="text-gray-500">Páginas:</span> {selectedTargetDoc.pageCount}
                         </div>
                         <div className="flex items-center gap-1">
                            <span className="text-gray-500">Categoría:</span> {selectedTargetDoc.category}
                         </div>
                         <div className="flex items-center gap-1">
                            <span className="text-gray-500">Estado:</span> <span className="text-emerald-400">Publicado</span>
                         </div>
                          <div className="flex items-center gap-1">
                            <span className="text-gray-500">Fuente:</span> {selectedTargetDoc.sourceType || 'upload'}
                         </div>
                      </div>
                   </div>
                </div>
             )}
          </div>
        )}
      </div>
      
      <div 
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
            "border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center transition-colors cursor-pointer mb-6",
            isDragging ? 'border-blue-500 bg-blue-500/10' : 'border-white/10 hover:border-white/30 truncate bg-white/[0.01]',
            mode === 'replace' && !replaceTargetId && 'opacity-50 cursor-not-allowed grayscale pointer-events-none'
        )}
        onClick={hUploadClick}
      >
        <Upload className="w-10 h-10 text-gray-500 mb-3" />
        <p className="text-gray-300 font-medium">
            {mode === 'replace' ? 'Sube el PDF de reemplazo' : 'Arrastra tus PDFs aquí'}
        </p>
        <p className="text-gray-500 text-sm mt-1">
            {mode === 'replace' 
                ? 'El archivo cargado sustituirá al documento seleccionado de forma segura' 
                : 'Selecciona varios archivos con Ctrl o Shift, o arrástralos juntos aquí.'}
        </p>
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); hUploadClick(); }}
          disabled={mode === 'replace' && !replaceTargetId}
          className="mt-4 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
        >
          {mode === 'replace' ? 'Seleccionar PDF de reemplazo' : 'Seleccionar varios PDFs'}
        </button>
        {mode === 'new' && <p className="mt-3 text-xs text-gray-400">Después, completa los datos de cada archivo y pulsa «Cargar todos los PDFs». Máximo 500 MB por archivo.</p>}
        <input 
          type="file" 
          accept="application/pdf"
          multiple={mode === 'new'}
          ref={fileInputRef} 
          className="hidden" 
          onChange={handleFileChange}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      {queue.length > 0 && (
        <div className="space-y-4">
          <div className="border-b border-white/10 pb-2">
            <h3 className="font-semibold text-sm text-gray-400 uppercase tracking-widest">Cola de Gestión ({queue.length})</h3>
          </div>

          {/* Keep native wheel/touch scrolling inside the queue instead of the page's Lenis handler. */}
          <div data-lenis-prevent role="region" aria-label="Archivos en cola de gestión" tabIndex={0}
            className="grid gap-4 max-h-[500px] overflow-y-auto overscroll-contain pr-2 custom-scrollbar">
            {queue.map(item => (
              <div key={item.id} className="bg-[#0B0F19] border border-white/10 rounded-2xl p-5 flex flex-col gap-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-white/5 rounded-xl flex items-center justify-center border border-white/10 shrink-0">
                      <FileText className="w-6 h-6 text-blue-400" />
                    </div>
                    <div>
                      <h4 className="font-bold text-gray-100 truncate max-w-[200px]">{item.title}</h4>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] font-black uppercase bg-white/10 px-2 py-0.5 rounded text-gray-400 tracking-tighter">
                          {item.category || 'Categoría pendiente'}
                        </span>
                        {item.publicationType && (
                          <span className="text-[10px] font-black uppercase bg-blue-500/10 px-2 py-0.5 rounded text-blue-300 tracking-tighter">
                            {item.publicationType === 'technical-sheet' ? 'Ficha técnica' : 'Catálogo'}
                          </span>
                        )}
                        <span className="text-xs text-gray-500">
                          {item.size ? (item.size / (1024*1024)).toFixed(1) + ' MB' : '0 MB'}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  {['pending', 'uploaded', 'error', 'cancelled', 'paused', 'published'].includes(item.status) && (
                    <button 
                      onClick={() => void removeFromQueue(item.id)} 
                      className="group flex items-center justify-center w-8 h-8 rounded-lg bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-all"
                      title="Quitar de la lista"
                    >
                      <X className="w-5 h-5 group-hover:scale-110 transition-transform" />
                    </button>
                  )}
                </div>

                <div className="grid gap-5 rounded-xl border border-white/10 bg-white/[0.025] p-4 md:grid-cols-[150px_minmax(0,1fr)]">
                  <div>
                    <span className="mb-2 block text-[10px] font-black uppercase tracking-wider text-gray-400">
                      Vista previa
                    </span>
                    <div className="mx-auto aspect-[3/4] w-full max-w-[150px] overflow-hidden rounded-lg border border-white/10 bg-[#111827]">
                      {item.previewUrl ? (
                        <img
                          src={item.previewUrl}
                          alt={`Vista previa de ${item.title || item.file?.name || 'documento'}`}
                          className="h-full w-full object-contain"
                        />
                      ) : item.recoveredDraft ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-blue-200">
                          <FileText className="h-6 w-6" />
                          Archivo recuperado. Continúa con “Sistema” para generar la portada.
                        </div>
                      ) : item.previewFailed ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-amber-300">
                          <AlertCircle className="h-5 w-5" />
                          No se pudo generar la portada. El PDF aún puede procesarse.
                        </div>
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-gray-500">
                          <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
                          Preparando portada…
                        </div>
                      )}
                    </div>
                    {item.pageCount ? (
                      <p className="mt-2 text-center text-xs text-gray-500">{item.pageCount} páginas</p>
                    ) : null}
                  </div>

                  <div className="grid content-start gap-4 sm:grid-cols-2">
                    <label className="sm:col-span-2">
                      <span className="mb-1.5 block text-xs font-bold text-gray-300">
                        Nombre visible <span className="text-red-400">*</span>
                      </span>
                      <input
                        type="text"
                        value={item.title}
                        onChange={(event) => updateItemDetails(item.id, 'title', event.target.value)}
                        disabled={['uploading', 'processing', 'publishing', 'indexing', 'published'].includes(item.status)}
                        className="w-full rounded-lg border border-white/10 bg-[#0B0F19] px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-60"
                        placeholder="Nombre con el que aparecerá en la web"
                        required
                      />
                    </label>

                    <label>
                      <span className="mb-1.5 block text-xs font-bold text-gray-300">
                        Tipo de publicación <span className="text-red-400">*</span>
                      </span>
                      <select
                        value={item.publicationType}
                        onChange={(event) => updateItemDetails(item.id, 'publicationType', event.target.value)}
                        disabled={['uploading', 'processing', 'publishing', 'indexing', 'published'].includes(item.status)}
                        className="w-full rounded-lg border border-white/10 bg-[#0B0F19] px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-60"
                        required
                      >
                        <option value="">Selecciona el tipo</option>
                        <option value="catalog">Catálogo</option>
                        <option value="technical-sheet">Ficha técnica</option>
                      </select>
                    </label>

                    <label>
                      <span className="mb-1.5 block text-xs font-bold text-gray-300">
                        Categoría de la web <span className="text-red-400">*</span>
                      </span>
                      <select
                        value={item.category}
                        onChange={(event) => updateItemDetails(item.id, 'category', event.target.value)}
                        disabled={['uploading', 'processing', 'publishing', 'indexing', 'published'].includes(item.status)}
                        className="w-full rounded-lg border border-white/10 bg-[#0B0F19] px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-60"
                        required
                      >
                        <option value="">Selecciona una categoría</option>
                        {categories.filter((category) => category.active !== false).map((category) => (
                          <option key={category.id} value={category.name}>{category.name}</option>
                        ))}
                      </select>
                    </label>

                    <label className="sm:col-span-2">
                      <span className="mb-1.5 block text-xs font-bold text-gray-300">Visibilidad inicial</span>
                      <select
                        value={item.visibility}
                        onChange={(event) => updateItemDetails(item.id, 'visibility', event.target.value)}
                        disabled={['uploading', 'processing', 'publishing', 'indexing', 'published'].includes(item.status)}
                        className="w-full rounded-lg border border-white/10 bg-[#0B0F19] px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none disabled:opacity-60"
                      >
                        <option value="public">Publicar en la web</option>
                        <option value="private">Guardar como borrador privado</option>
                      </select>
                    </label>

                    {item.errorMessage && item.status === 'pending' && (
                      <p className="sm:col-span-2 text-xs font-medium text-red-300">{item.errorMessage}</p>
                    )}
                  </div>
                </div>

                {item.duplicateTargetId && (() => {
                  const duplicate = documents.find((document) => document.id === item.duplicateTargetId);
                  if (!duplicate) return null;
                  return (
                    <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4">
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-center gap-3">
                          <img
                            src={duplicate.coverUrl}
                            alt=""
                            className="h-16 w-12 shrink-0 rounded object-cover"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-amber-100">Ya existe una publicación con este nombre</p>
                            <p className="truncate text-xs text-amber-200/70">
                              {duplicate.title} · {duplicate.category}
                            </p>
                            <p className="mt-1 text-xs text-gray-400">
                              Decide si deseas reemplazarla o descartar esta carga.
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => confirmDuplicateReplacement(item.id, duplicate.id)}
                            className="rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-black hover:bg-amber-300"
                          >
                            Reemplazar existente
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeFromQueue(item.id)}
                            className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white hover:bg-white/10"
                          >
                            Omitir y eliminar
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <UploadProgressBar status={item.status} progress={item.progress} />

                {item.replaceTargetId && (
                    <div className="text-[10px] text-blue-400 font-black uppercase tracking-widest flex items-center gap-2 bg-blue-400/5 p-2 rounded-lg border border-blue-400/10">
                        <AlertCircle className="w-3 h-3" />
                        Este archivo reemplazará al documento: {documents.find(d => d.id === item.replaceTargetId)?.title}
                    </div>
                )}

                <div className="flex items-center justify-end mt-2 pt-4 border-t border-white/5 gap-3">
                  {item.status === 'pending' && (
                    <button 
                      onClick={() => startUpload(item.id)}
                      disabled={!metadataIsComplete(item) || Boolean(item.duplicateTargetId)}
                      className="bg-gray-800 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all"
                    >
                      {item.duplicateTargetId
                        ? 'Elige reemplazar u omitir'
                        : metadataIsComplete(item) ? 'Subir y preparar' : 'Completa los datos obligatorios'}
                    </button>
                  )}
                  {item.status === 'uploading' && (
                    <div className="flex flex-col items-end gap-2 w-full">
                      <div className="flex items-center justify-between w-full">
                        <div className="flex flex-col items-start">
                          <span className="text-blue-400 text-xs font-bold animate-pulse">
                            {item.uploadPhase === 'preparing'
                              ? 'Preparando el PDF para Backblaze…'
                              : item.uploadPhase === 'finalizing'
                              ? 'Guardando en Backblaze…'
                              : item.uploadPhase === 'verifying'
                                ? 'Confirmando el archivo…'
                              : 'Subiendo archivo…'}
                          </span>
                          {(item.uploadPhase === 'preparing' || item.uploadPhase === 'finalizing' || item.uploadPhase === 'verifying') && (
                            <span className="mt-1 text-[10px] font-medium text-gray-500">
                              {item.uploadPhase === 'preparing'
                                ? 'Terminando la recepción y validación en el servidor.'
                                : item.uploadPhase === 'verifying'
                                  ? 'Los datos se enviaron; esperando confirmación del servidor.'
                                  : 'El porcentaje corresponde a los datos enviados a Backblaze.'}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col items-end">
                          {item.progress !== undefined && <span className="text-blue-400 text-xs font-bold tabular-nums">{item.progress}%</span>}
                          {item.uploadPhase === 'sending' && <div className="flex items-center gap-2">
                             <button 
                               onClick={() => pauseUpload(item.id)}
                               className="text-[10px] text-yellow-500 hover:text-yellow-400 font-bold uppercase tracking-tighter"
                             >
                               Pausar
                             </button>
                             <button 
                               onClick={() => cancelUpload(item.id)}
                               className="text-[10px] text-red-500 hover:text-red-400 font-bold uppercase tracking-tighter"
                             >
                               Cancelar
                             </button>
                          </div>}
                        </div>
                      </div>
                      {item.progress !== undefined && <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${item.progress}%` }} />
                      </div>}
                    </div>
                  )}
                  {item.status === 'uploaded' && (
                    <div className="flex items-center gap-2">
                      {item.progress !== undefined && (
                        <span className="text-xs font-bold tabular-nums text-blue-300">{item.progress}%</span>
                      )}
                      <button 
                        onClick={() => processDocument(item.id)}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-bold shadow-lg shadow-blue-500/20"
                      >
                        Pasar al sistema interno
                      </button>
                    </div>
                  )}
                  {item.status === 'processing' && (
                    <span className="text-purple-400 text-xs font-bold flex items-center gap-2">
                       <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                       Procesando en sistema… <strong className="tabular-nums text-purple-200">{item.progress ?? 0}%</strong>
                    </span>
                  )}
                  {item.status === 'internal_ready' && (
                    <button 
                      onClick={() => publishDocument(item.id)}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-xs font-bold shadow-lg shadow-emerald-500/20"
                    >
                      {item.replaceTargetId ? 'Realizar reemplazo seguro' : 'Implementar en la web'}
                    </button>
                  )}
                  {item.status === 'publishing' && (
                    <span className="text-emerald-400 text-xs font-bold animate-pulse">
                        {item.replaceTargetId ? 'Actualizando documento y eliminando anterior…' : 'Publicando en plataforma…'}{' '}
                        <strong className="tabular-nums text-emerald-200">{item.progress ?? 0}%</strong>
                    </span>
                  )}
                  {item.status === 'indexing' && (
                    <span className="text-orange-400 text-xs font-bold flex items-center gap-2">
                       <div className="w-3 h-3 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
                       Creando índice del catálogo… <strong className="tabular-nums text-orange-200">{item.progress ?? 0}%</strong>
                    </span>
                  )}
                  {item.status === 'published' && (
                    <div className="flex items-center gap-3">
                      <span className="text-emerald-400 text-xs font-bold flex items-center gap-1" role="status" aria-live="polite">
                        <CheckCircle2 className="w-4 h-4" /> {item.visibility === 'private'
                          ? 'Guardado como borrador'
                          : 'Cargado exitosamente'}
                      </span>
                      <button 
                        onClick={() => window.open(`/viewer/${item.replaceTargetId || item.docId}`, '_blank')}
                        className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all border border-white/10"
                      >
                        Ver en plataforma
                      </button>
                    </div>
                  )}
                  {item.status === 'paused' && (
                    <div className="flex items-center gap-3">
                      <span className="text-yellow-500 text-xs font-bold uppercase">Pausado</span>
                      <button 
                        onClick={() => startUpload(item.id)}
                        className="bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-500 px-4 py-2 rounded-lg text-xs font-bold transition-all border border-yellow-500/30"
                      >
                        Reanudar
                      </button>
                    </div>
                  )}
                  {item.status === 'cancelled' && (
                    <div className="flex items-center gap-3">
                      <span className="text-gray-500 text-xs font-bold uppercase">Cancelado</span>
                      <button 
                        onClick={() => startUpload(item.id)}
                        className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all"
                      >
                        Reiniciar
                      </button>
                    </div>
                  )}
                  {item.status === 'error' && (
                    <div className="flex items-center gap-3">
                      <span className="text-red-400 text-xs font-bold">{item.errorMessage || "Error"}</span>
                      {item.errorMessage?.includes("No se pudo crear el índice") ? (
                        <button 
                            onClick={() => item.docId && item.finalPdfUrl && createIndexForDocument(item.id, item.docId, item.finalPdfUrl)}
                            className="bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 px-4 py-2 rounded-lg text-xs font-bold transition-all border border-orange-500/30"
                        >
                            Reintentar creación de índice
                        </button>
                      ) : (
                        <button 
                            onClick={() => startUpload(item.id)}
                            className="bg-red-500/20 hover:bg-red-500/30 text-red-400 px-4 py-2 rounded-lg text-xs font-bold transition-all border border-red-500/30"
                        >
                            Reintentar
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="pt-6 border-t border-white/10 flex items-center justify-between">
            <p className="text-xs text-gray-500 italic">Completa nombre, tipo y categoría. Nada se publica sin tu confirmación.</p>
            <button 
              onClick={handleUploadAll}
              disabled={isAnyUploading || !hasReadyPendingFiles}
              className="bg-white hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed text-black px-6 py-2 rounded-xl font-bold text-sm transition-all shadow-xl active:scale-95"
            >
              Cargar todos los PDFs
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
