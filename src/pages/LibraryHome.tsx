import React, { useMemo } from 'react';
import EditorialHero from '../components/library/EditorialHero';
import PromotionalBanner from '../components/library/PromotionalBanner';
import { useStore } from '../store/useStore';
import { homeDocument } from '../lib/documentOrder';

export default function LibraryHome() {
  const { documents, isLoadingDocs, hasLoadedDocs, documentsSyncStatus, fetchDocuments, fetchCategories, fetchPromotionalBanner } = useStore();

  const featured = useMemo(() => homeDocument(documents), [documents]);
  return (
    <div className="library-home bg-[#f5f5f2]" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Segoe UI", sans-serif' }}>
      {featured && <EditorialHero doc={featured} />}
      {!featured && (
        <section className="min-h-[55vh] flex flex-col items-center justify-center gap-4 px-6 text-center" aria-live="polite">
          <h1 className="text-3xl font-semibold text-[#111]">Biblioteca Digital Chaide</h1>
          <p className="text-gray-600">
            {isLoadingDocs || (!hasLoadedDocs && documentsSyncStatus !== 'error')
              ? 'Cargando los catálogos de la biblioteca…'
              : documentsSyncStatus === 'error'
                ? 'No se pudieron cargar los catálogos. Vuelve a intentarlo.'
                : 'No hay catálogos publicados disponibles en este momento.'}
          </p>
          <button type="button" disabled={isLoadingDocs}
            onClick={() => { void fetchDocuments(false); void fetchCategories(false); void fetchPromotionalBanner(); }}
            className="rounded-full bg-[#005baa] px-6 py-3 font-semibold text-white disabled:opacity-50">
            {isLoadingDocs ? 'Cargando…' : 'Volver a cargar la biblioteca'}
          </button>
        </section>
      )}
      
      <div className="library-home-sections relative z-20">
        <PromotionalBanner />
      </div>
    </div>
  );
}
