import React from 'react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PDFCard from './PDFCard';
import { DocumentDef } from '../../lib/mockData';

interface SectionProps {
  title: string;
  docs: DocumentDef[];
  viewAllLink?: string;
  className?: string;
  isLoading?: boolean;
}

export default function CatalogSection({ title, docs, viewAllLink, className, isLoading = false }: SectionProps) {
  const navigate = useNavigate();

  return (
    <section className={`catalog-section px-6 lg:px-12 py-8 ${className || ''}`}>
      <div className="catalog-section-header flex items-center justify-between mb-6">
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-gray-900">{title}</h2>
        {viewAllLink && (
          <a 
            href={viewAllLink} 
            className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-black transition-colors" 
            onClick={(e) => { e.preventDefault(); navigate(viewAllLink); }}
          >
            <span>Ver todo</span>
            <ArrowRight size={20} />
          </a>
        )}
      </div>

      <div className="catalog-section-panel bg-white p-6 md:p-8 rounded-3xl shadow-sm border border-gray-100">
        {isLoading ? (
          <div className="flex items-center justify-center gap-3 py-12 text-gray-500" role="status">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-700" />
            <span>Cargando catálogos…</span>
          </div>
        ) : docs.length > 0 ? (
          <div className="catalog-section-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {docs.map((doc) => (
              <div key={doc.id} className="pdf-card-wrapper transition-transform hover:scale-[1.02]">
                <PDFCard doc={doc} />
              </div>
            ))}
          </div>
        ) : (
          <p className="catalog-section-empty text-gray-500 text-center py-12">No hay contenido disponible por el momento.</p>
        )}
      </div>
    </section>
  );
}
