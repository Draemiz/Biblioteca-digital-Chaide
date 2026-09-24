import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { ArrowLeft } from 'lucide-react';
import PDFCard from '../components/library/PDFCard';
import { documentMatchesCatalogCategory, compareCategoryOrder } from '../lib/catalogCategories';
import { categoryBranch } from '../lib/categoryHierarchy';
import { canFeature, savedDocumentOrder } from '../lib/documentOrder';

export default function CategoryPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { categories, documents, isLoadingDocs, hasLoadedDocs } = useStore();

  const category = categories.find(c => c.slug === slug && c.active !== false);
  const branch = category ? categoryBranch(categories, category.id) : [];
  const children = categories.filter(c => c.parentId === category?.id && c.active !== false).sort(compareCategoryOrder);
  const parent = categories.find(c => c.id === category?.parentId);
  const catalogos = savedDocumentOrder(documents).filter(doc =>
    canFeature(doc) && branch.some(item => documentMatchesCatalogCategory(doc, item))
  );

  if (!category) return <div className="text-[#111] p-8 font-medium">Categoría no encontrada</div>;

  return (
    <main className="min-h-screen bg-[#f5f5f2] pt-24 pb-20 px-4 md:px-8" style={{ color: '#111', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Segoe UI", sans-serif' }}>
      <div className="max-w-[1500px] mx-auto">
        <button 
          onClick={() => navigate(parent ? `/categoria/${parent.slug}` : '/catalogos')}
          className="flex items-center gap-2 text-[#111]/70 hover:text-[#111] transition-colors mb-12 font-medium"
        >
          <ArrowLeft className="w-5 h-5" />
          {parent ? `Volver a ${parent.name}` : 'Volver a categorías'}
        </button>

        <header className="mb-14">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-4" style={{ letterSpacing: '-0.055em' }}>{category.name}</h1>
          <p className="text-lg md:text-xl" style={{ color: 'rgba(0, 0, 0, 0.62)' }}>{category.description}</p>
        </header>
        {children.length > 0 && <nav aria-label="Subcategorías" className="mb-8 flex flex-wrap gap-3">
          {children.map(child => <button key={child.id} onClick={() => navigate(`/categoria/${child.slug}`)}
            className="rounded-full border border-black/15 bg-white px-5 py-2 text-sm">{child.name}</button>)}
        </nav>}

        {isLoadingDocs || !hasLoadedDocs ? (
          <div className="flex items-center justify-center gap-3 py-24 text-black/50" role="status">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-black/15 border-t-black/60" />
            <span>Cargando catálogos…</span>
          </div>
        ) : catalogos.length > 0 ? (
          <div className="category-catalog-grid">
            {catalogos.map(catalog => (
              <PDFCard key={catalog.id} doc={catalog} />
            ))}
          </div>
        ) : (
          <div className="text-center py-24 bg-white/50 rounded-2xl border border-black/5">
            <p style={{ color: 'rgba(0, 0, 0, 0.52)' }}>Todavía no hay catálogos en esta categoría.</p>
          </div>
        )}
      </div>
    </main>
  );
}
