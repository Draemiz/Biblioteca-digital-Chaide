import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Search, Edit, Trash2, RefreshCw, LogOut } from 'lucide-react';
import { useStore } from '../store/useStore';
import { useNavigate } from 'react-router-dom';
import { DocumentDef } from '../lib/mockData';
import AdminUploadQueue from '../components/admin/AdminUploadQueue';
import AdminLinkImport from '../components/admin/AdminLinkImport';
import AdminEditModal from '../components/admin/AdminEditModal';
import CategoryManager from '../components/admin/CategoryManager';
import PromotionalBannerManager from '../components/admin/PromotionalBannerManager';
import { isFirebaseSite } from '../lib/runtimeConfig';
import { motion, AnimatePresence } from 'motion/react';
import { ADMIN_BASE_PATH } from '../lib/adminRoutes';
import { fuzzyTextMatch } from '../lib/fuzzyTextSearch';
import { canFeature, savedDocumentOrder, uploadTime } from '../lib/documentOrder';

const DOCUMENTS_PER_PAGE = 25;

type StorageStatus = {
  provider: string;
  configured: boolean;
  connected: boolean;
  bucket?: string;
  region?: string;
};

function DeleteButton({ onDelete, docTitle }: { onDelete: () => void, docTitle: string }) {
  const [confirming, setConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirm = async () => {
    setIsDeleting(true);
    try {
      await onDelete();
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeleting(false);
      setConfirming(false);
    }
  };

  if (isDeleting) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 bg-red-500/10 rounded">
        <div className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin"></div>
        <span className="text-[10px] font-bold text-red-100 uppercase">Borrando...</span>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1 bg-red-600 rounded overflow-hidden p-0.5 shadow-lg border border-red-400">
        <button 
          onClick={handleConfirm}
          className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-white/10"
        >
          Borrar Sí
        </button>
        <div className="w-[1px] h-4 bg-white/20"></div>
        <button 
          onClick={() => setConfirming(false)}
          className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/70 hover:bg-white/10"
        >
          No
        </button>
      </div>
    );
  }

  return (
    <button 
      onClick={() => setConfirming(true)}
      title={`Eliminar ${docTitle}`}
      className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
    >
      <Trash2 className="w-4 h-4" />
    </button>
  );
}

export default function AdminDashboard() {
  const {
    documents,
    isLoadingDocs,
    hasLoadedDocs,
    documentsSyncStatus,
    categories,
    removeDocument,
    fetchDocuments,
    fetchCategories,
    fetchPromotionalBanner,
    role,
    logout,
  } = useStore();
  const [editingDoc, setEditingDoc] = useState<DocumentDef | null>(null);
  const [replaceDocId, setReplaceDocId] = useState<string | undefined>(undefined);
  const [searchTerm, setSearchTerm] = useState('');
  const [draftIds, setDraftIds] = useState<string[] | null>(null);
  const [featuredChoice, setFeaturedChoice] = useState<string | null | undefined>(undefined);
  const [presentationBusy, setPresentationBusy] = useState(false);
  const [presentationMessage, setPresentationMessage] = useState('');
  const orderedDocuments = useMemo(() => {
    const sorted = savedDocumentOrder(documents);
    if (!draftIds) return sorted;
    return sorted.sort((a, b) => {
      const index = (id: string) => { const i = draftIds.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
      return index(a.id) - index(b.id);
    });
  }, [documents, draftIds]);
  const chosenFeaturedId = featuredChoice === undefined ? documents.find((doc) => doc.isFeatured && canFeature(doc))?.id || null : featuredChoice;
  const previewPrincipal = orderedDocuments.find((doc) => doc.id === chosenFeaturedId && canFeature(doc)) || orderedDocuments.find(canFeature);
  const moveDocument = (id: string, delta: number) => {
    const ids = orderedDocuments.map((doc) => doc.id);
    const index = ids.indexOf(id);
    if (index + delta < 0 || index + delta >= ids.length) return;
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    setDraftIds(ids);
    setPresentationMessage('');
  };
  const savePresentation = async () => {
    setPresentationBusy(true);
    setPresentationMessage('');
    const ids = orderedDocuments.map((doc) => doc.id);
    try {
      if (isFirebaseSite) {
        const [{ writeBatch, doc }, { db }] = await Promise.all([import('firebase/firestore'), import('../lib/firebase')]);
        if (ids.length > 500) throw new Error('El máximo para guardar el orden es de 500 documentos.');
        const batch = writeBatch(db);
        ids.forEach((id, order) => batch.update(doc(db, 'documents', id), { order, isFeatured: id === chosenFeaturedId }));
        await batch.commit();
      } else {
        const response = await fetch('/api/documents/presentation', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, featuredId: chosenFeaturedId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'No se pudieron guardar los cambios.');
      }
      useStore.setState((state) => ({ documents: state.documents.map((doc) => ({ ...doc, order: ids.indexOf(doc.id), isFeatured: doc.id === chosenFeaturedId })) }));
      setDraftIds(null);
      setFeaturedChoice(undefined);
      setPresentationMessage('Orden y documento principal guardados.');
    } catch (error) {
      setPresentationMessage(error instanceof Error ? error.message : 'No se pudieron guardar los cambios.');
    } finally { setPresentationBusy(false); }
  };
  const [documentPage, setDocumentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkType, setBulkType] = useState('');
  const [bulkVisibility, setBulkVisibility] = useState('');
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');
  const selectPageRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [isCheckingStorage, setIsCheckingStorage] = useState(false);
  const [connectedNoticeUntil, setConnectedNoticeUntil] = useState(0);
  const didInitialLoadRef = useRef(false);

  const refreshStorageStatus = async () => {
    setIsCheckingStorage(true);
    try {
      const response = await fetch('/api/storage/status', { credentials: 'same-origin' });
      const status: StorageStatus = await response.json();
      setStorageStatus(status);
      setConnectedNoticeUntil(response.ok && status.connected ? Date.now() + 4000 : 0);
    } catch {
      setStorageStatus({ provider: 'backblaze-b2', configured: true, connected: false });
      setConnectedNoticeUntil(0);
    } finally {
      setIsCheckingStorage(false);
    }
  };

  useEffect(() => {
    if (!connectedNoticeUntil) return;
    const timer = window.setTimeout(() => setConnectedNoticeUntil(0), Math.max(0, connectedNoticeUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [connectedNoticeUntil]);

  const handleLogout = async () => {
    if (isFirebaseSite) {
      const [{ signOut }, { auth }] = await Promise.all([
        import('firebase/auth'),
        import('../lib/firebase'),
      ]);
      await signOut(auth).catch(() => undefined);
    } else {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      }).catch(() => undefined);
    }
    logout();
    navigate(ADMIN_BASE_PATH, { replace: true });
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        fetchDocuments(true),
        fetchCategories(true),
        fetchPromotionalBanner(),
        refreshStorageStatus(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (role !== 'admin') {
      navigate(ADMIN_BASE_PATH, { replace: true });
      return;
    }

    if (didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;

    void (async () => {
      await Promise.all([
        fetchDocuments(true),
        fetchCategories(true),
        fetchPromotionalBanner(),
        refreshStorageStatus(),
      ]);
    })();
  }, [fetchDocuments, fetchCategories, fetchPromotionalBanner, role, navigate]);

  const filteredDocuments = useMemo(
    () => orderedDocuments.filter((doc) => fuzzyTextMatch(searchTerm, doc.title, doc.description)),
    [orderedDocuments, searchTerm],
  );
  const documentPageCount = Math.max(1, Math.ceil(filteredDocuments.length / DOCUMENTS_PER_PAGE));
  const visibleDocuments = filteredDocuments.slice(
    (documentPage - 1) * DOCUMENTS_PER_PAGE,
    documentPage * DOCUMENTS_PER_PAGE,
  );
  const visibleIds = visibleDocuments.map((doc) => doc.id);
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;

  useEffect(() => {
    if (selectPageRef.current) {
      selectPageRef.current.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length;
    }
  }, [selectedVisibleCount, visibleIds.length]);

  useEffect(() => {
    const available = new Set(documents.map((doc) => doc.id));
    setSelectedIds((current) => {
      if ([...current].every((id) => available.has(id))) return current;
      return new Set([...current].filter((id) => available.has(id)));
    });
  }, [documents]);

  const toggleDocument = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmBulkDelete(false);
    setBulkMessage('');
  };

  const toggleVisibleDocuments = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (visibleIds.every((id) => next.has(id))) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
    setConfirmBulkDelete(false);
    setBulkMessage('');
  };

  const runBulkAction = async (action: 'edit' | 'delete') => {
    if (bulkBusy || selectedIds.size === 0) return;
    if (action === 'edit' && !bulkCategory && !bulkType && !bulkVisibility) return;
    if (action === 'delete' && !confirmBulkDelete) return;

    const ids = [...selectedIds];
    const failed: string[] = [];
    setBulkBusy(true);
    setBulkMessage('');
    try {
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        setBulkProgress(`${index + 1} de ${ids.length}`);
        try {
          let response: Response;
          if (action === 'delete') {
            response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
              method: 'DELETE', credentials: 'same-origin',
            });
          } else {
            const data = new FormData();
            if (bulkCategory) data.append('category', bulkCategory);
            if (bulkType) data.append('publicationType', bulkType);
            if (bulkVisibility) {
              data.append('visibility', bulkVisibility);
              data.append('isActive', String(bulkVisibility === 'public'));
            }
            response = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
              method: 'PUT', body: data, credentials: 'same-origin',
            });
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
          console.error(`No se pudo ${action === 'delete' ? 'eliminar' : 'modificar'} ${id}`, error);
          failed.push(id);
        }
      }
      await fetchDocuments(true);
      setSelectedIds(new Set(failed));
      const completed = ids.length - failed.length;
      setBulkMessage(
        `${completed} ${completed === 1 ? 'archivo' : 'archivos'} ${action === 'delete' ? 'eliminado' : 'modificado'}${completed === 1 ? '' : 's'} correctamente.` +
        (failed.length ? ` ${failed.length} ${failed.length === 1 ? 'falló y permanece seleccionado' : 'fallaron y permanecen seleccionados'} para reintentar.` : ''),
      );
      if (action === 'edit' && failed.length === 0) setBulkEditOpen(false);
    } finally {
      setBulkBusy(false);
      setBulkProgress('');
      setConfirmBulkDelete(false);
    }
  };

  useEffect(() => {
    setDocumentPage(1);
  }, [searchTerm]);

  useEffect(() => {
    setDocumentPage((current) => Math.min(current, documentPageCount));
  }, [documentPageCount]);

  const traducirSource = (source?: string, storageProvider?: string) => {
    if (storageProvider === 'backblaze-b2') return 'Backblaze B2';
    if (source === 'upload') return 'Local';
    if (source === 'url') return 'URL externa';
    if (source === 'embed') return 'Embed';
    return 'Local';
  };

  return (
    <main className="min-h-screen bg-[#070B13] text-white">
    <div className="p-6 lg:p-10 max-w-7xl mx-auto">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-blue-300/70">
            Gestión interna · Acceso restringido
          </p>
          <h1 className="text-3xl font-bold">Panel Administrador</h1>
          <p className="text-gray-400 mt-1">Gestiona la biblioteca digital, sube PDFs y ajusta configuraciones.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
          >
            <div className={isRefreshing ? "animate-spin" : ""}>
              <Search className="w-4 h-4 translate-x-[-1px] rotate-90" />
            </div>
            {isRefreshing ? 'Sincronizando...' : 'Refrescar Biblioteca'}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
            Cerrar sesión
          </button>
        </div>
      </div>

      {storageStatus?.connected && connectedNoticeUntil > 0 && (
        <div className="mb-5 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-100" role="status">
          Backblaze B2 conectado. Puedes subir catálogos.
        </div>
      )}
      {storageStatus && !storageStatus.connected && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100" role="alert">
          <span className="font-medium">
            {storageStatus.configured
              ? 'No se pudo conectar con Backblaze B2. Las subidas pueden fallar.'
              : 'Backblaze B2 no está configurado. Las subidas no están disponibles.'}
          </span>
          <button type="button" onClick={() => void refreshStorageStatus()} disabled={isCheckingStorage}
            className="rounded-lg border border-amber-300/40 px-3 py-1.5 font-semibold transition-colors hover:bg-amber-300/10 disabled:cursor-wait disabled:opacity-50">
            {isCheckingStorage ? 'Comprobando…' : 'Comprobar de nuevo'}
          </button>
        </div>
      )}

      {(!hasLoadedDocs || documentsSyncStatus === 'error') && (
        <div
          className={`mb-5 rounded-xl border px-4 py-3 text-sm ${
            documentsSyncStatus === 'error'
              ? 'border-red-400/25 bg-red-500/10 text-red-100'
              : 'border-blue-400/20 bg-blue-500/10 text-blue-100'
          }`}
          role="status"
        >
          {documentsSyncStatus === 'error'
            ? 'No se pudo actualizar la biblioteca. Usa “Refrescar Biblioteca” para volver a intentarlo.'
            : 'Sincronizando catálogos, categorías y configuración administrativa…'}
        </div>
      )}

      <AdminUploadQueue initialReplaceDocId={replaceDocId} />
      <AdminLinkImport />
      <PromotionalBannerManager />
      <CategoryManager />

      <div className="bg-[#111827] border border-white/10 rounded-2xl overflow-hidden mt-8">
        <div className="p-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-3 bg-[#161B22]">
          <h2 className="font-semibold flex items-center gap-2">
            <FileText className="w-5 h-5 text-gray-400" />
            Documentos en Biblioteca
          </h2>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input 
              type="text" 
              placeholder="Buscar título o palabra…"
              aria-label="Buscar documentos por título o descripción; admite palabras sin tilde y errores pequeños"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-[#0B0F19] border border-white/10 rounded-lg py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:border-blue-500 w-full lg:w-64"
            />
          </div>
        </div>

        <fieldset disabled={presentationBusy || bulkBusy || !hasLoadedDocs} className="border-b border-white/10 p-4 text-sm space-y-3 disabled:opacity-50">
          <div className="flex flex-wrap items-center gap-3">
            <label>Ordenar por{' '}
              <select defaultValue="" onChange={(event) => {
                const mode = event.target.value;
                const sorted = [...orderedDocuments].sort((a, b) => mode === 'category'
                  ? a.category.localeCompare(b.category, 'es') || a.title.localeCompare(b.title, 'es')
                  : mode === 'oldest' ? uploadTime(a) - uploadTime(b) : uploadTime(b) - uploadTime(a));
                setDraftIds(sorted.map((doc) => doc.id)); setDocumentPage(1); event.target.value = '';
              }} className="rounded-lg bg-[#0B0F19] border border-white/15 px-3 py-2">
                <option value="" disabled>Elegir orden…</option>
                <option value="newest">Subida: más recientes primero</option>
                <option value="oldest">Subida: más antiguos primero</option>
                <option value="category">Categoría (A–Z)</option>
              </select>
            </label>
            <button type="button" onClick={() => setFeaturedChoice(null)} aria-pressed={!chosenFeaturedId} className="rounded-lg border border-white/15 px-3 py-2">
              Usar el primero de la lista
            </button>
            <button type="button" onClick={() => void savePresentation()} disabled={draftIds === null && featuredChoice === undefined}
              className="rounded-lg bg-blue-600 px-3 py-2 font-semibold disabled:opacity-40">{presentationBusy ? 'Guardando…' : 'Guardar orden e inicio'}</button>
            {(draftIds !== null || featuredChoice !== undefined) && <button type="button" onClick={() => { setDraftIds(null); setFeaturedChoice(undefined); }}>Cancelar cambios</button>}
          </div>
          <p className="text-gray-400">Principal en inicio: <strong className="text-blue-200">{previewPrincipal?.title || 'Ningún documento publicado'}</strong>. {chosenFeaturedId ? 'Selección fija.' : 'Se usa el primer documento publicado; se omiten borradores y archivos en proceso.'}</p>
          {presentationMessage && <p role="status">{presentationMessage}</p>}
        </fieldset>

        {(selectedIds.size > 0 || bulkMessage) && (
          <div className="border-b border-white/10 bg-blue-500/5 p-4" aria-live="polite">
            {selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="mr-2 font-semibold text-blue-200">{selectedIds.size} seleccionado{selectedIds.size === 1 ? '' : 's'}</span>
                <button type="button" onClick={() => { setBulkEditOpen((open) => !open); setConfirmBulkDelete(false); }} disabled={bulkBusy}
                  className="rounded-lg border border-white/15 px-3 py-2 hover:bg-white/10 disabled:opacity-50">Modificar selección</button>
                {!confirmBulkDelete ? (
                  <button type="button" onClick={() => { setConfirmBulkDelete(true); setBulkEditOpen(false); }} disabled={bulkBusy}
                    className="rounded-lg border border-red-400/40 px-3 py-2 text-red-200 hover:bg-red-500/10 disabled:opacity-50">Eliminar selección</button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-red-100">
                    <span>¿Eliminar definitivamente {selectedIds.size} {selectedIds.size === 1 ? 'archivo' : 'archivos'} y sus archivos almacenados?</span>
                    <button type="button" onClick={() => void runBulkAction('delete')} disabled={bulkBusy}
                      className="rounded bg-red-600 px-3 py-1 font-semibold text-white disabled:opacity-50">Sí, eliminar</button>
                    <button type="button" onClick={() => setConfirmBulkDelete(false)} disabled={bulkBusy}
                      className="rounded px-2 py-1 hover:bg-white/10 disabled:opacity-50">Cancelar</button>
                  </div>
                )}
                <button type="button" onClick={() => { setSelectedIds(new Set()); setBulkEditOpen(false); setConfirmBulkDelete(false); }} disabled={bulkBusy}
                  className="px-2 py-2 text-gray-400 hover:text-white disabled:opacity-50">Limpiar selección</button>
                {bulkBusy && <span role="status" className="text-blue-200">Procesando {bulkProgress}…</span>}
              </div>
            )}
            {bulkEditOpen && selectedIds.size > 0 && (
              <div className="mt-3 grid gap-3 rounded-xl border border-white/10 bg-[#0B0F19] p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <label className="grid gap-1 text-gray-300">Categoría
                  <select value={bulkCategory} onChange={(event) => setBulkCategory(event.target.value)} disabled={bulkBusy}
                    className="min-w-0 rounded-lg border border-white/15 bg-[#111827] px-3 py-2 text-white">
                    <option value="">Sin cambios</option>
                    {categories.filter((category) => category.active !== false).map((category) => (
                      <option key={category.id} value={category.name}>{category.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-gray-300">Tipo
                  <select value={bulkType} onChange={(event) => setBulkType(event.target.value)} disabled={bulkBusy}
                    className="min-w-0 rounded-lg border border-white/15 bg-[#111827] px-3 py-2 text-white">
                    <option value="">Sin cambios</option>
                    <option value="catalog">Catálogo</option>
                    <option value="technical-sheet">Ficha técnica</option>
                  </select>
                </label>
                <label className="grid gap-1 text-gray-300">Visibilidad
                  <select value={bulkVisibility} onChange={(event) => setBulkVisibility(event.target.value)} disabled={bulkBusy}
                    className="min-w-0 rounded-lg border border-white/15 bg-[#111827] px-3 py-2 text-white">
                    <option value="">Sin cambios</option>
                    <option value="public">Publicar en la web</option>
                    <option value="private">Guardar como borrador privado</option>
                  </select>
                </label>
                <div className="flex items-end">
                  <button type="button" onClick={() => void runBulkAction('edit')}
                    disabled={bulkBusy || (!bulkCategory && !bulkType && !bulkVisibility)}
                    className="w-full rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
                    Aplicar cambios
                  </button>
                </div>
                <p className="sm:col-span-2 lg:col-span-4 text-xs text-gray-400">Solo se modificarán los campos elegidos. El nombre, la portada y el PDF se editan por archivo.</p>
              </div>
            )}
            {bulkMessage && <p role="status" className="mt-2 text-sm text-blue-100">{bulkMessage}</p>}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-gray-300">
            <thead className="text-xs text-gray-500 uppercase bg-[#0B0F19]">
              <tr>
                <th scope="col" className="px-4 py-4">
                  <input ref={selectPageRef} type="checkbox" checked={visibleIds.length > 0 && selectedVisibleCount === visibleIds.length}
                    onChange={toggleVisibleDocuments} disabled={bulkBusy || visibleIds.length === 0}
                    aria-label="Seleccionar todos los documentos de esta página"
                    title="Seleccionar todos los documentos de esta página"
                    className="h-4 w-4 accent-blue-500" />
                </th>
                <th className="px-6 py-4 font-medium">Documento</th>
                <th className="px-6 py-4 font-medium">Fuente</th>
                <th className="px-6 py-4 font-medium">Páginas</th>
                <th className="px-6 py-4 font-medium">Estado</th>
                <th className="px-6 py-4 text-right font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              <AnimatePresence mode="popLayout">
                {!hasLoadedDocs && (
                  <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <td colSpan={6} className="px-6 py-10 text-center text-gray-400">
                      {isLoadingDocs ? 'Cargando documentos de la biblioteca…' : 'Preparando la biblioteca…'}
                    </td>
                  </motion.tr>
                )}
                {hasLoadedDocs && filteredDocuments.length === 0 && (
                  <motion.tr initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <td colSpan={6} className="px-6 py-10 text-center text-gray-400">
                      {searchTerm ? 'No hay documentos que coincidan con la búsqueda.' : 'No hay documentos registrados.'}
                    </td>
                  </motion.tr>
                )}
                {visibleDocuments.map((doc) => (
                  <motion.tr 
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, x: -20 }}
                    key={doc.id} 
                    className="hover:bg-white/[0.02] transition-colors"
                  >
                  <td className="px-4 py-4">
                    <input type="checkbox" checked={selectedIds.has(doc.id)} onChange={() => toggleDocument(doc.id)}
                      disabled={bulkBusy} aria-label={`Seleccionar ${doc.title}`}
                      className="h-4 w-4 accent-blue-500" />
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <img src={doc.coverUrl} alt={doc.title} className="w-10 h-14 object-cover rounded shadow-sm" />
                      <div>
                        <div className="font-medium text-white">{doc.title}</div>
                        <div className="mt-1 text-xs text-gray-400">#{orderedDocuments.findIndex((item) => item.id === doc.id) + 1} · {doc.category}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button type="button" aria-label={`Subir ${doc.title}`} disabled={presentationBusy || bulkBusy || orderedDocuments[0]?.id === doc.id} onClick={() => moveDocument(doc.id, -1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-30">↑</button>
                          <button type="button" aria-label={`Bajar ${doc.title}`} disabled={presentationBusy || bulkBusy || orderedDocuments.at(-1)?.id === doc.id} onClick={() => moveDocument(doc.id, 1)} className="rounded border border-white/15 px-2 py-1 disabled:opacity-30">↓</button>
                          <button type="button" disabled={presentationBusy || bulkBusy || !canFeature(doc)} aria-pressed={chosenFeaturedId === doc.id} onClick={() => setFeaturedChoice(doc.id)}
                            className={`rounded border px-2 py-1 text-xs disabled:opacity-30 ${previewPrincipal?.id === doc.id ? 'border-blue-400 text-blue-200' : 'border-white/15 text-gray-400'}`}>
                            {previewPrincipal?.id === doc.id ? '★ Principal en inicio' : 'Elegir como principal'}
                          </button>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5 truncate max-w-xs">{doc.description}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="bg-white/10 px-2 py-1 rounded-md text-xs">{traducirSource(doc.sourceType, doc.storageProvider)}</span>
                  </td>
                  <td className="px-6 py-4">{doc.pageCount}</td>
                  <td className="px-6 py-4">
                    <span className={`flex items-center gap-1.5 text-xs font-medium ${doc.visibility === 'private' || doc.isActive === false ? 'text-amber-400' : doc.status === 'ready' ? 'text-emerald-400' : 'text-blue-400'}`}>
                      <span className={`w-2 h-2 rounded-full ${doc.visibility === 'private' || doc.isActive === false ? 'bg-amber-400' : doc.status === 'ready' ? 'bg-emerald-400' : 'bg-blue-400'} ${doc.status === 'ready' ? '' : 'animate-pulse'}`}></span>
                      {doc.visibility === 'private' || doc.isActive === false
                        ? 'Borrador privado'
                        : doc.status === 'ready' ? 'Publicado' : 'Procesando / No publicado'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                       <button 
                         onClick={() => {
                           setReplaceDocId(undefined);
                           window.setTimeout(() => {
                             setReplaceDocId(doc.id);
                             window.requestAnimationFrame(() => {
                               document
                                 .getElementById('admin-pdf-operation-panel')
                                 ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                             });
                           }, 10);
                         }}
                         title={`Reemplazar PDF de ${doc.title}`}
                         aria-label={`Reemplazar PDF de ${doc.title}`}
                         className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 rounded transition-colors"
                       >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                       <button 
                         onClick={() => setEditingDoc(doc)}
                         title={`Editar ${doc.title}`}
                         aria-label={`Editar ${doc.title}`}
                         className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded"
                       >
                        <Edit className="w-4 h-4" />
                      </button>
                      <DeleteButton 
                        onDelete={() => removeDocument(doc.id)} 
                        docTitle={doc.title}
                      />
                    </div>
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>
      {hasLoadedDocs && filteredDocuments.length > DOCUMENTS_PER_PAGE && (
        <nav
          className="flex flex-col gap-3 border-t border-white/10 bg-[#0B0F19] px-4 py-3 text-xs text-gray-400 sm:flex-row sm:items-center sm:justify-between"
          aria-label="Paginación de documentos administrativos"
        >
          <span>
            Mostrando {(documentPage - 1) * DOCUMENTS_PER_PAGE + 1}–{Math.min(documentPage * DOCUMENTS_PER_PAGE, filteredDocuments.length)} de {filteredDocuments.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDocumentPage((current) => Math.max(1, current - 1))}
              disabled={documentPage === 1}
              className="rounded-lg border border-white/10 px-3 py-1.5 font-semibold text-gray-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Anterior
            </button>
            <span className="min-w-16 text-center font-semibold tabular-nums text-gray-300">
              {documentPage} / {documentPageCount}
            </span>
            <button
              type="button"
              onClick={() => setDocumentPage((current) => Math.min(documentPageCount, current + 1))}
              disabled={documentPage === documentPageCount}
              className="rounded-lg border border-white/10 px-3 py-1.5 font-semibold text-gray-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </nav>
      )}
      </div>

      {editingDoc && (
        <AdminEditModal 
          document={editingDoc} 
          onClose={() => setEditingDoc(null)} 
        />
      )}
    </div>
    </main>
  );
}
