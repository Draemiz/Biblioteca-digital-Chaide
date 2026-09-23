import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { getCategoryIconComponent } from '../lib/categoryIconRegistry';
import { compareCategoryOrder } from '../lib/catalogCategories';

export default function CategoriesPage() {
  const navigate = useNavigate();
  const { categories } = useStore();

  return (
    <main className="min-h-screen pt-24 pb-20 px-4 md:px-8 bg-[#f5f5f2]" style={{ color: '#111', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Segoe UI", sans-serif' }}>
      <div className="max-w-[1500px] mx-auto">
        <button
          className="flex items-center gap-2 text-[#111]/70 hover:text-[#111] transition-colors mb-12 font-medium bg-transparent border-0 cursor-pointer"
          onClick={() => navigate("/")}
        >
          ← Volver al menú principal
        </button>

        <header className="mb-14">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-4" style={{ letterSpacing: '-0.055em' }}>Categorías</h1>
          <p className="text-lg md:text-xl" style={{ color: 'rgba(0, 0, 0, 0.62)' }}>Explora los catálogos por tipo de producto.</p>
        </header>

        <section className="category-catalog-grid">
          {categories.filter((category) => category.active !== false).sort(compareCategoryOrder).map((category) => {
            const Icon = getCategoryIconComponent(category.icon);
            
            return (
              <button
                key={category.id}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', background: 'rgba(255, 255, 255, 0.6)', 
                  padding: '40px 24px', borderRadius: '18px', border: '1px solid rgba(0, 0, 0, 0.05)',
                  boxShadow: '0 8px 24px rgba(0,0,0,0.02)', cursor: 'pointer', transition: 'transform 200ms ease, box-shadow 200ms ease', textAlign: 'center'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-4px)';
                  e.currentTarget.style.boxShadow = '0 12px 32px rgba(0,0,0,0.06)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'none';
                  e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.02)';
                }}
                onClick={() => navigate(`/categoria/${category.slug}`)}
              >
                <div style={{ width: '64px', height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', borderRadius: '14px', boxShadow: '0 4px 12px rgba(0,0,0,0.04)', color: '#111' }}>
                  {category.imageUrl ? (
                    <img src={category.imageUrl} alt={category.name} className="w-full h-full object-cover" style={{ borderRadius: '14px' }} />
                  ) : (
                    <Icon className="w-8 h-8" strokeWidth={1.5} />
                  )}
                </div>

                <h2 style={{ fontSize: '18px', fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>{category.name}</h2>

                {category.description && (
                  <p style={{ fontSize: '14px', color: 'rgba(0,0,0,0.5)', margin: 0 }}>{category.description}</p>
                )}
              </button>
            );
          })}
        </section>
      </div>
    </main>
  );
}
