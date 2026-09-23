import { compareCategoryOrder } from '../lib/catalogCategories';
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import PDFCard from '../components/library/PDFCard';
import {
  documentMatchesCatalogCategory,
  getCatalogSectionHref,
  getDocumentSearchText,
  normalizeCatalogText,
} from '../lib/catalogCategories';
import { useStore } from '../store/useStore';
import { canFeature, savedDocumentOrder } from '../lib/documentOrder';

export default function AllCatalogsPage() {
  const { documents, categories, isLoadingDocs, hasLoadedDocs } = useStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredDocuments = useMemo(() => {
    const search = normalizeCatalogText(searchTerm.trim());
    const published = savedDocumentOrder(documents).filter(canFeature);
    if (!search) return published;

    return published.filter((doc) => getDocumentSearchText(doc).includes(search));
  }, [documents, searchTerm]);

  const catalogSections = useMemo(() => {
    return [...categories]
      .filter((category) => category.active !== false)
      .sort(compareCategoryOrder)
      .map((category) => {

        return {
          ...category,
          label: category.name,
          docs: filteredDocuments.filter((doc) => documentMatchesCatalogCategory(doc, category)),
        };
      });
  }, [categories, filteredDocuments]);

  useEffect(() => {
    if (!location.hash) return;

    const targetId = decodeURIComponent(location.hash.slice(1));
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, catalogSections]);

  return (
    <div className="all-catalogs-page bg-[#f5f5f2] min-h-screen pt-12 px-6 lg:px-12">
      <h1 className="text-4xl font-sans font-medium text-gray-900 tracking-tight mb-2">Catálogos</h1>
      <p className="text-gray-600 mb-8">Explora los catálogos organizados por categoría.</p>

      <div className="all-catalogs-tools mb-10 flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative max-w-md w-full">
          <Search className="absolute left-3 top-3 text-gray-400" size={20} />
          <input
            type="text"
            placeholder="Buscar catálogos..."
            className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-full focus:outline-none focus:ring-2 focus:ring-black"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <nav className="flex flex-wrap gap-2" aria-label="Categorías de catálogos">
          {catalogSections.map((category) => (
            <a
              key={category.slug}
              href={getCatalogSectionHref(category.slug)}
              onClick={(event) => {
                event.preventDefault();
                navigate(getCatalogSectionHref(category.slug));
              }}
              className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-black/25 hover:text-black"
            >
              {category.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="space-y-12">
        {catalogSections.map((section) => (
          <section
            key={section.slug}
            id={section.slug}
            className="scroll-mt-32"
            aria-labelledby={`${section.slug}-title`}
          >
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-gray-400">
                  Categoría
                </p>
                <h2 id={`${section.slug}-title`} className="text-2xl font-medium text-gray-900">
                  {section.label}
                </h2>
              </div>
              <span className="text-sm text-gray-500">
                {isLoadingDocs || !hasLoadedDocs
                  ? 'Cargando…'
                  : `${section.docs.length} catálogo${section.docs.length === 1 ? '' : 's'}`}
              </span>
            </div>

            <div className="all-catalogs-section-panel bg-white p-6 md:p-8 rounded-3xl shadow-sm border border-gray-100">
              {isLoadingDocs || !hasLoadedDocs ? (
                <div className="flex items-center justify-center gap-3 py-12 text-gray-500" role="status">
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
                  <span>Cargando catálogos…</span>
                </div>
              ) : section.docs.length > 0 ? (
                <div className="all-catalogs-section-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                  {section.docs.map((doc) => (
                    <PDFCard key={doc.id} doc={doc} />
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-12">
                  No hay catálogos disponibles en esta categoría por el momento.
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

