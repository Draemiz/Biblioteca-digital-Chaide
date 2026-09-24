import type { DocumentDef } from './mockData';

export const catalogCategories = [
  { label: 'Catálogo de Productos', slug: 'catalogo-de-productos', description: 'Catálogos de productos Chaide.', icon: 'Layers', order: 10, keywords: ['productos'] },
  { label: 'Catálogo de Distribuidores', slug: 'catalogo-de-distribuidores', description: 'Material para distribuidores.', icon: 'Waves', order: 20, keywords: ['distribuidores'] },
  { label: 'Fichas de Productos e Innovaciones', slug: 'fichas-de-productos-e-innovaciones', description: 'Fichas técnicas y novedades de productos.', icon: 'Cloud', order: 30, keywords: ['fichas'] },
  { label: 'Crédito', slug: 'credito', description: 'Información y documentos de crédito.', icon: 'Layout', order: 40, keywords: ['credito'] },
  { label: 'Catálogos y Fichas Tempur', slug: 'catalogos-y-fichas-tempur', description: 'Catálogos y fichas de Tempur.', icon: 'Bed', order: 50, keywords: ['tempur'] },
] as const;

export type CatalogCategory = (typeof catalogCategories)[number];
export function compareCategoryOrder(a: { slug: string; order?: number; displayOrder?: number }, b: { slug: string; order?: number; displayOrder?: number }) {
  if (a.displayOrder !== undefined || b.displayOrder !== undefined) {
    const difference = (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER);
    if (difference) return difference;
  }
  const base = (slug: string) => catalogCategories.some((category) => category.slug === slug);
  return Number(base(b.slug)) - Number(base(a.slug)) || (a.order ?? 999) - (b.order ?? 999);
}
export type CatalogCategorySlug = CatalogCategory['slug'];

export function normalizeCatalogText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function getCatalogSectionHref(slug: string) {
  return `/catalogos#${slug}`;
}

export function getDocumentSearchText(doc: DocumentDef) {
  return normalizeCatalogText([
    doc.title,
    doc.description,
    doc.category,
    ...(doc.tags || []),
    ...((doc.indexItems || []).map((item: any) => item?.title || '')),
  ].filter(Boolean).join(' '));
}

export function documentMatchesCatalogCategory(doc: DocumentDef, category: { label?: string; name?: string; slug: string }) {
  const assigned = normalizeCatalogText(doc.category || '').trim();
  return Boolean(assigned) && [category.name, category.label, category.slug]
    .some((value) => value && normalizeCatalogText(value).trim() === assigned);
}
